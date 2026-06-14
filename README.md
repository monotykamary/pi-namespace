# pi-namespace

Namespace tools and skills in [pi](https://pi.dev) — group tools by extension with configurable prefix rewriting.

## Why

Pi registers all tools in a flat namespace. When multiple extensions register tools with colliding names, the first registration silently wins. There's no built-in grouping to tell the LLM that `push`, `status`, and `rollback` all belong to the deploy extension.

pi-namespace patches `ExtensionRunner.prototype.getAllRegisteredTools` so tool names are rewritten with namespace prefixes before they enter the LLM schema, system prompt, and TUI. The original `execute` functions are preserved via prototype delegation.

| Without namespace | With namespace |
|---|---|
| `push` | `deploy:push` |
| `status` | `deploy:status` |
| `read` | `fs:read` |

## Install

```bash
pi install git:github.com/monotykamary/pi-namespace
```

Or copy `namespace.ts` to `~/.pi/agent/extensions/`.

## Configuration

Create `~/.pi/agent/namespace.json` (global) or `.pi/namespace.json` (project):

```json
{
  "namespaces": {
    "my-deploy-extension": "deploy",
    "pi-code-previews": "preview"
  },
  "builtinNamespace": "fs",
  "autoNamespace": false
}
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `namespaces` | `Record<string, string>` | Map of extension sourceInfo.path (or substring) → namespace prefix |
| `builtinNamespace` | `string` | Optional prefix for built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) |
| `autoNamespace` | `boolean` | Auto-derive namespace from extension directory/package name |

### Namespace matching

The key in `namespaces` is matched against each tool's `sourceInfo.path`:

1. **Exact match** — if the key equals the full path
2. **Substring match** — if the key is contained within the path

This means `"deploy-extension"` would match `/home/user/.pi/agent/extensions/deploy-extension/index.ts`.

### Auto-namespace

When `autoNamespace` is `true`, tools from extensions without an explicit mapping get a namespace derived from:

1. The `pi-` prefixed directory name in the extension path (e.g. `pi-messenger` → `messenger`)
2. The npm package name with `pi-` stripped (e.g. `npm:@foo/pi-deploy` → `deploy`)
3. The parent directory name as fallback

## Commands

### `/namespace`

Show current namespace configuration.

| Subcommand | Description |
|---|---|
| `/namespace list` | Show namespaced tool count and config summary |
| `/namespace config` | Show the full namespace config JSON |
| `/namespace map` | Show per-tool namespace mapping with source paths |

## How it works

1. **On `session_start`**: patches `ExtensionRunner.prototype.getAllRegisteredTools` (once per process)
2. **The patch** intercepts the tool list, rewrites names with namespace prefixes using `Object.create` delegation (preserving `execute` functions)
3. **`before_agent_start`**: rewrites skill `<skill name="...">` attributes in the system prompt
4. **Namespaced names flow through** to the LLM schema, system prompt, `setActiveTools()`, `--tools`, `--exclude-tools`, and the TUI

### Reverse mapping

The extension maintains a reverse map (`namespaced → original`) via `stripNamespace()` for downstream consumers that need to resolve back to the canonical tool name.

## Known limitations

- **Built-in tool type guards break** — `isToolCallEventType("bash", event)` won't match `fs:bash`. Use `stripNamespace()` to resolve.
- **Tool override by name** — registering a tool called `shell:bash` won't override the built-in `bash` since the names differ.
- **Fragile to pi internals** — a pi update could change the `ExtensionRunner` API.
- **Skill namespacing is prompt-only** — skills are formatted as opaque XML text, so we rewrite the `<skill name>` attribute but can't intercept `/skill:ns:name` invocations.

## Development

```bash
npm install
npm test
npm run typecheck
```

## License

MIT
