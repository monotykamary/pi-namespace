<div align="center">

# 🏷️ pi-namespace

**Namespace tools and skills in [pi](https://github.com/earendil-works/pi-coding-agent)**

_Group tools by extension with configurable prefix rewriting — flat tool names become `deploy:push`, `fs:read`, `msg:send`._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## The Problem

Pi registers all tools in a flat namespace. When multiple extensions register tools, colliding names silently shadow each other — the first registration wins. There's no grouping to tell the LLM that `push`, `status`, and `rollback` all belong to the deploy extension.

```
Available tools
- read         ← built-in? extension? override?
- push         ← what does this do? where from?
- status       ← deploy status? git status? system status?
- search       ← brave? vector? code?
- deploy       ← the tool? or a namespace collision?
```

Skills are similarly flat — every skill appears in the system prompt without provenance or grouping.

---

## The Solution

**pi-namespace** patches `ExtensionRunner.prototype.getAllRegisteredTools` — the single chokepoint where pi's `AgentSession` pulls tool definitions before they're frozen into the LLM schema, system prompt, and TUI.

| Before | After |
|--------|-------|
| `push` | `deploy:push` |
| `status` | `deploy:status` |
| `search` | `msg:search` |
| `read` | `fs:read` (with `builtinNamespace`) |

Namespaced names flow through to **everything**: LLM tool schemas, system prompt snippets, `setActiveTools()`, `--tools`, `--exclude-tools`, and the TUI.

```
Available tools
- fs:read         ← built-in (namespaced)
- fs:bash         ← built-in (namespaced)
- fs:edit         ← built-in (namespaced)
- fs:write        ← built-in (namespaced)
- deploy:push     ← from pi-deploy
- deploy:status   ← from pi-deploy
- deploy:rollback  ← from pi-deploy
- msg:search      ← from pi-messenger
- msg:send        ← from pi-messenger
```

---

## Install

**With `pi install`** (recommended):

```bash
pi install https://github.com/monotykamary/pi-namespace
```

**Manual** — copy to global extensions:

```bash
cp namespace.ts ~/.pi/agent/extensions/
```

**Project-local**:

```bash
mkdir -p .pi/extensions
cp namespace.ts .pi/extensions/
```

**Quick test**:

```bash
pi -e ./namespace.ts
```

Reload with `/reload` after any install method.

---

## Configuration

Create `~/.pi/agent/namespace.json` (global) or `.pi/namespace.json` (project):

```json
{
  "namespaces": {
    "deploy-extension": "deploy",
    "pi-messenger": "msg",
    "pi-code-previews": "preview"
  },
  "builtinNamespace": "fs",
  "autoNamespace": false
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `namespaces` | `Record<string, string>` | `{}` | Map of extension `sourceInfo.path` (or substring) → namespace prefix |
| `builtinNamespace` | `string` | — | Optional prefix for built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) |
| `autoNamespace` | `boolean` | `false` | Auto-derive namespace from extension directory/package name |

### Namespace matching

The key in `namespaces` is matched against each tool's `sourceInfo.path`:

1. **Exact match** — key equals the full path
2. **Substring match** — key is contained within the path

```
"deploy-extension" matches:
  ✓ /home/user/.pi/agent/extensions/deploy-extension/index.ts
  ✓ /home/user/.npm-global/lib/node_modules/@foo/deploy-extension/dist/index.js
  ✗ /home/user/.pi/agent/extensions/my-deploy/index.ts
```

### Auto-namespace

When `autoNamespace` is `true`, tools from extensions without an explicit mapping get a namespace derived from:

| Source format | Example | Derived namespace |
|---|---|---|
| File path with `pi-` segment | `/home/user/.pi/agent/extensions/pi-messenger/index.ts` | `messenger` |
| `npm:` package | `npm:@foo/pi-deploy` | `deploy` |
| `git:` package | `git:github.com/user/pi-tools` | `tools` |
| No `pi-` prefix, falls back | `/home/user/.pi/agent/extensions/myext/index.ts` | `myext` |

---

## Commands

| Command | Description |
|---------|-------------|
| `/namespace` | Show namespaced tool count and config summary |
| `/namespace list` | Same as above |
| `/namespace config` | Show the full namespace config JSON |
| `/namespace map` | Show per-tool namespace mapping with source paths |

### Example output

```
/namespace map

  read → fs:read (<builtin:read>)
  bash → fs:bash (<builtin:bash>)
  edit → fs:edit (<builtin:edit>)
  write → fs:write (<builtin:write>)
  push → deploy:push (/home/user/.pi/agent/extensions/deploy-extension/index.ts)
  status → deploy:status (/home/user/.pi/agent/extensions/deploy-extension/index.ts)
  search (no namespace, local)
```

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  session_start                                              │
│                                                             │
│  Patch ExtensionRunner.prototype.getAllRegisteredTools      │
│  (once per process — all future calls go through the patch) │
│                                                             │
│  Build reverse namespace map: namespaced → original         │
│  (e.g. "deploy:push" → "push")                              │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  AgentSession._refreshToolRegistry()                        │
│                                                             │
│  Calls getAllRegisteredTools() ──→ PATCH INTERCEPTS ──→     │
│                                                             │
│  1. resolveNamespace(): find matching prefix from config    │
│  2. applyNamespace(): rewrite name "push" → "deploy:push"   │
│  3. Object.create(): delegate to original definition        │
│     → execute() inherited untouched                         │
│     → only name, promptSnippet, promptGuidelines overridden │
│                                                             │
│  Namespaced names flow into:                                │
│    _toolDefinitions → _toolRegistry → system prompt → TUI   │
│    setActiveTools(), --tools, --exclude-tools               │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  before_agent_start                                         │
│                                                             │
│  Rewrite <skill name="..."> attributes in system prompt     │
│  e.g. <skill name="brave-search"> → <skill name="web:brave- │
│  search">                                                   │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
               LLM calls "deploy:push"
               → matches namespaced tool in registry
               → original execute() runs via Object.create delegation
```

### Built-in tool override safety

If an extension overrides a built-in tool by name (like pi-code-previews overrides `read`), and that extension also has a namespace, pi-namespace **skips the rewrite** — namespacing it would break the override mechanism:

```
pi-code-previews registers tool { name: "read" }  (override)
  → namespace config maps pi-code-previews → "preview"
  → BUT "read" is a built-in override → SKIP
  → tool stays as "read", not "preview:read"

With explicit builtinNamespace: "fs":
  → built-in "read" → "fs:read"
  → override "read" from pi-code-previews → still "read" (override wins)
```

Only use `builtinNamespace` when you want to namespace all built-in tools explicitly. It intentionally does not affect extension overrides of those built-ins.

### Object.create delegation

The patch does **not** copy tool definitions. It creates a delegating object:

```ts
const namespacedDef = Object.create(tool.definition);
namespacedDef.name = "deploy:push";                    // override name
namespacedDef.promptSnippet = "Use deploy:push to..."; // override snippet
namespacedDef.promptGuidelines = ["Use deploy:push"];  // override guidelines
// execute(), parameters(), renderCall(), renderResult() — all inherited
```

This means the original `execute` function runs with zero wrapping overhead. No proxy, no shim — just prototype chain delegation.

---

## Known Limitations

| Limitation | Details |
|------------|---------|
| **Built-in type guards break** | `isToolCallEventType("bash", event)` won't match `fs:bash`. Use `stripNamespace()` to resolve back to `bash`. |
| **Tool override by name** | Registering `shell:bash` won't override built-in `bash` since the names differ. |
| **Fragile to pi internals** | A pi update could change `ExtensionRunner` API. The patch targets a single stable method. |
| **Skill namespacing is prompt-only** | Skills are XML text in the system prompt — we rewrite `<skill name>` attributes but can't intercept `/skill:ns:name` invocations. |

---

## Development

```bash
npm install            # install dev dependencies
npm test               # run tests (25 tests)
npm run typecheck      # TypeScript validation
npm run lint:dead      # dead code detection (knip)
npm run test:coverage  # tests with coverage
```

## Related Projects

| Project | Description |
|---------|-------------|
| [pi-tool-repair](https://github.com/monotykamary/pi-tool-repair) | Fix common LLM tool-call mistakes before tools execute |
| [pi-lazy-extensions](https://github.com/monotykamary/pi-lazy-extensions) | Lazy-load extensions on demand via ToolSearch-style proxy |
| [pi-startup-tracer](https://github.com/monotykamary/pi-startup-tracer) | Trace per-extension load and handler timing |
| [pi-toggle-skills](https://github.com/monotykamary/pi-toggle-skills) | Toggle skill visibility in the system prompt |
| [pi-trust-defer](https://github.com/monotykamary/pi-trust-defer) | Skip the startup trust prompt |

## License

MIT
