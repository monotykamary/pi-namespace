/**
 * pi-namespace — namespace tools and skills by extension.
 *
 * Patches ExtensionRunner.prototype.getAllRegisteredTools to rewrite tool
 * names with configurable namespace prefixes. This groups all tools from a
 * given extension under a shared prefix (e.g. "deploy:push", "deploy:status")
 * instead of a flat namespace where colliding names silently shadow each other.
 *
 * The patch rewrites tool definitions at the registry level, so namespaced
 * names flow through to the LLM schema, system prompt, setActiveTools(),
 * --tools, --exclude-tools, and the TUI. Original execute functions are
 * preserved via Object.create delegation.
 *
 * Configuration via ~/.pi/agent/namespace.json or <cwd>/.pi/namespace.json:
 *
 *   {
 *     "namespaces": {
 *       "my-deploy-extension": "deploy",
 *       "pi-code-previews": "preview"
 *     },
 *     "builtinNamespace": "fs"
 *   }
 *
 * The key in "namespaces" is matched against sourceInfo.path (the extension's
 * resolved path or package identifier). The value is the namespace prefix.
 * "builtinNamespace" optionally prefixes all built-in tools (read, bash, etc.).
 *
 * Skill namespacing rewrites the description blocks in the system prompt
 * via before_agent_start, since skills are formatted as opaque XML text
 * rather than registered definitions.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";

// --- Config ---

export interface NamespaceConfig {
  /** Map of extension sourceInfo.path (or substring) → namespace prefix */
  namespaces?: Record<string, string>;
  /** Optional namespace for built-in tools (read, bash, edit, write, grep, find, ls) */
  builtinNamespace?: string;
  /** Automatically derive namespace from extension directory/package name when no explicit mapping exists */
  autoNamespace?: boolean;
  /** Separator between namespace prefix and tool name. Default ":".
   *  Use "__" for providers that reject colons in tool names
   *  (e.g. Anthropic: ^[a-zA-Z0-9_-]{1,128}$). */
  separator?: string;
}

const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

function loadConfig(cwd: string): NamespaceConfig {
  const candidates = [
    join(cwd, CONFIG_DIR_NAME, "namespace.json"),
    join(getAgentDir(), "namespace.json"),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        // Malformed — skip
      }
    }
  }
  return {};
}

// --- Namespace derivation ---

/**
 * Derive a namespace prefix from an extension path.
 * E.g. "/home/user/.pi/agent/extensions/pi-deploy/index.ts" → "deploy"
 * E.g. "npm:@foo/pi-bar" → "bar"
 */
export function deriveNamespace(extPath: string): string | null {
  // Handle npm: and git: source paths
  if (extPath.startsWith("npm:")) {
    const parts = extPath.split("/");
    // npm:@scope/name → last part is the package name
    // npm:name → single segment, strip the npm: prefix
    const last = parts.length > 1
      ? parts[parts.length - 1]
      : parts[0].replace(/^npm:/, "");
    const name = last.replace(/^pi-/, "");
    return name || null;
  }

  if (extPath.startsWith("git:")) {
    // git:github.com/user/repo or git:git@github.com:user/repo
    const repo = extPath.split("/").pop() || extPath.split(":").pop() || "";
    const name = repo.replace(/^pi-/, "").replace(/\.git$/, "");
    return name || null;
  }

  // File path: look for a "pi-" prefixed directory name
  const segments = extPath.split("/");
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].startsWith("pi-")) {
      return segments[i].replace(/^pi-/, "");
    }
  }

  // Fall back to parent directory name of the entry file
  if (segments.length >= 2) {
    return segments[segments.length - 2];
  }

  return null;
}

/**
 * Find a matching namespace for a tool based on its sourceInfo.path and the config.
 */
export function resolveNamespace(
  tool: ToolInfo,
  config: NamespaceConfig,
): string | null {
  // Built-in tools
  if (tool.sourceInfo.source === "builtin" && config.builtinNamespace) {
    return config.builtinNamespace;
  }

  // SDK tools
  if (tool.sourceInfo.source === "sdk") {
    return null;
  }

  const extPath = tool.sourceInfo.path;

  // Explicit namespace mapping — check for exact match then substring match
  if (config.namespaces) {
    // Exact match first
    if (config.namespaces[extPath]) {
      return config.namespaces[extPath];
    }

    // Substring match: config key is contained in the extension path
    for (const [key, ns] of Object.entries(config.namespaces)) {
      if (extPath.includes(key)) {
        return ns;
      }
    }
  }

  // Auto-derive from path
  if (config.autoNamespace) {
    return deriveNamespace(extPath);
  }

  return null;
}

/**
 * Apply namespace prefix to a tool name.
 * "deploy" + "push" → "deploy:push"
 * Won't double-prefix: "deploy:push" + "deploy" → "deploy:push"
 */
export function applyNamespace(prefix: string, name: string, separator: string = ":"): string {
  const sep = separator;
  if (name.startsWith(`${prefix}${sep}`)) {
    return name;
  }
  return `${prefix}${sep}${name}`;
}

/**
 * Strip a known namespace prefix from a tool name.
 * "deploy:push" → "push"  (if we have the mapping)
 * Returns the original name if no known prefix matches.
 */
export function stripNamespace(
  namespacedName: string,
  nsMap: Map<string, string>,
  separator: string = ":",
): string {
  const sepIdx = namespacedName.indexOf(separator);
  if (sepIdx === -1) return namespacedName;

  const prefix = namespacedName.slice(0, sepIdx);
  const original = namespacedName.slice(sepIdx + separator.length);

  // Only strip if this prefix was one we added
  if (nsMap.has(prefix)) {
    return original;
  }

  return namespacedName;
}

// --- Prototype patch ---

type SourceScope = "user" | "project" | "temporary";
type SourceOrigin = "package" | "top-level";

interface RegisteredTool {
  definition: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    execute: (...args: unknown[]) => unknown;
    [key: string]: unknown;
  };
  sourceInfo: {
    path: string;
    source: string;
    scope: SourceScope;
    origin: SourceOrigin;
    baseDir?: string;
  };
}

let patched = false;
let sessionPatched = false;
let runnerModule: any = null;

async function findRunnerModule(): Promise<any> {
  if (runnerModule) return runnerModule;

  // Try importing from the pi coding agent dist
  try {
    const mod = await import("@earendil-works/pi-coding-agent");
    // The runner is not exported directly — we need to find it through the dist
  } catch {
    // Not available as import
  }

  // Find the runner from the installed package
  const piDist = findPiDist();
  if (!piDist) return null;

  try {
    runnerModule = await import(join(piDist, "core/extensions/runner.js"));
    return runnerModule;
  } catch {
    return null;
  }
}

function findPiDist(): string | undefined {
  // getPackageDir() resolves pi's own install root and honors PI_PACKAGE_DIR
  // (Nix/Guix). The runner and agent-session are internal modules not
  // re-exported from the public API, so import them directly from dist/.
  const piDist = join(getPackageDir(), "dist");
  if (existsSync(join(piDist, "core/extensions/runner.js"))) return piDist;
  return undefined;
}

async function patchExtensionRunner(config: NamespaceConfig): Promise<boolean> {
  if (patched) return true;

  const mod = await findRunnerModule();
  if (!mod || !mod.ExtensionRunner) {
    return false;
  }

  const Runner = mod.ExtensionRunner;
  const originalGetAllRegisteredTools = Runner.prototype.getAllRegisteredTools;

  if (typeof originalGetAllRegisteredTools !== "function") {
    return false;
  }

  Runner.prototype.getAllRegisteredTools = function (this: any): RegisteredTool[] {
    const tools: RegisteredTool[] = originalGetAllRegisteredTools.call(this);
    return rewriteTools(tools, config);
  };

  patched = true;
  return true;
}

// --- AgentSession patch ---
//
// Built-in tools bypass ExtensionRunner.getAllRegisteredTools() — they're
// stored in AgentSession._baseToolDefinitions and assembled separately in
// _refreshToolRegistry. To namespace built-ins, we patch
// AgentSession.prototype._refreshToolRegistry and post-process the resulting
// data structures after the original method runs.

let agentSessionModule: any = null;

async function findAgentSessionModule(): Promise<any> {
  if (agentSessionModule) return agentSessionModule;

  const piDist = findPiDist();
  if (!piDist) return null;

  try {
    agentSessionModule = await import(join(piDist, "core/agent-session.js"));
    return agentSessionModule;
  } catch {
    return null;
  }
}

async function patchAgentSession(config: NamespaceConfig): Promise<boolean> {
  if (sessionPatched) return true;
  // No builtin namespace configured — nothing to patch on the session side.
  // The ExtensionRunner patch already handles extension tools.
  if (!config.builtinNamespace) return true;

  const mod = await findAgentSessionModule();
  if (!mod || !mod.AgentSession) return false;

  const Session = mod.AgentSession;
  const originalRefresh = Session.prototype._refreshToolRegistry;

  if (typeof originalRefresh !== "function") return false;

  Session.prototype._refreshToolRegistry = function (this: any, ...args: any[]) {
    // Expand _allowedToolNames / _excludedToolNames so that namespaced forms
    // (e.g. "fs:read") resolve to their originals ("read") for the
    // isAllowedTool filter, which runs against pre-rewrite names.
    // Both directions are added so the filter works at every stage.
    expandAllowExcludeSets(this, config);
    originalRefresh.call(this, ...args);
    rewriteBuiltinTools(this, config);
  };

  sessionPatched = true;
  return true;
}

/**
 * Expand _allowedToolNames and _excludedToolNames so that both the
 * namespaced form ("fs:read") and the original form ("read") are present.
 *
 * This lets --tools fs:read / --exclude-tools fs:read work correctly
 * even though the internal filter checks against pre-rewrite names.
 */
export function expandAllowExcludeSets(
  session: any,
  config: NamespaceConfig,
): void {
  if (!config.builtinNamespace) return;

  const ns = config.builtinNamespace;
  const sep = config.separator ?? ":";

  for (const builtinName of BUILTIN_TOOLS) {
    const namespacedName = applyNamespace(ns, builtinName, sep);

    if (session._allowedToolNames) {
      if (session._allowedToolNames.has(namespacedName)) {
        session._allowedToolNames.add(builtinName);
      } else if (session._allowedToolNames.has(builtinName)) {
        session._allowedToolNames.add(namespacedName);
      }
    }

    if (session._excludedToolNames) {
      if (session._excludedToolNames.has(namespacedName)) {
        session._excludedToolNames.add(builtinName);
      } else if (session._excludedToolNames.has(builtinName)) {
        session._excludedToolNames.add(namespacedName);
      }
    }
  }
}

/**
 * Post-process an AgentSession's internal data structures to namespace
 * built-in tools. Called after _refreshToolRegistry completes.
 *
 * Built-in tools are stored under their original names in _toolDefinitions,
 * _toolPromptSnippets, _toolPromptGuidelines, and _toolRegistry. We rename
 * the keys and update the wrapped tool names so the namespaced versions flow
 * through to the LLM schema, system prompt, and tool dispatch.
 *
 * Extension overrides of built-in tools are NOT renamed — those intentionally
 * replace the built-in by name, and renaming would break the override.
 */
export function rewriteBuiltinTools(session: any, config: NamespaceConfig): void {
  if (!config.builtinNamespace) return;

  const ns = config.builtinNamespace;
  const sep = config.separator ?? ":";
  const definitions: Map<string, any> = session._toolDefinitions;
  const snippets: Map<string, string> = session._toolPromptSnippets;
  const guidelinesMap: Map<string, string[]> = session._toolPromptGuidelines;
  const registry: Map<string, any> = session._toolRegistry;

  // Collect renames for built-in tools that haven't been overridden by extensions.
  // An extension override would replace the sourceInfo in _toolDefinitions,
  // so we only rename entries still marked as source === "builtin".
  const renames: Array<{ from: string; to: string }> = [];
  for (const [name, entry] of definitions) {
    if (entry.sourceInfo?.source === "builtin" && BUILTIN_TOOLS.has(name)) {
      const namespacedName = applyNamespace(ns, name, sep);
      if (namespacedName !== name) {
        renames.push({ from: name, to: namespacedName });
      }
    }
  }

  if (renames.length === 0) return;

  for (const { from, to } of renames) {
    // 1. Rewrite _toolDefinitions
    const entry = definitions.get(from);
    if (entry) {
      const namespacedDef = Object.create(entry.definition);
      namespacedDef.name = to;

      if (entry.definition.promptSnippet) {
        namespacedDef.promptSnippet = entry.definition.promptSnippet.replace(
          new RegExp(`\\b${escapeRegex(from)}\\b`, "g"),
          to,
        );
      }

      if (entry.definition.promptGuidelines?.length) {
        namespacedDef.promptGuidelines = entry.definition.promptGuidelines.map(
          (g: string) =>
            g.replace(new RegExp(`\\b${escapeRegex(from)}\\b`, "g"), to),
        );
      }

      definitions.delete(from);
      definitions.set(to, {
        definition: namespacedDef,
        sourceInfo: entry.sourceInfo,
      });
    }

    // 2. Rewrite _toolPromptSnippets
    const snippet = snippets.get(from);
    if (snippet) {
      snippets.delete(from);
      snippets.set(
        to,
        snippet.replace(
          new RegExp(`\\b${escapeRegex(from)}\\b`, "g"),
          to,
        ),
      );
    }

    // 3. Rewrite _toolPromptGuidelines
    const guideline = guidelinesMap.get(from);
    if (guideline) {
      guidelinesMap.delete(from);
      guidelinesMap.set(
        to,
        guideline.map((g: string) =>
          g.replace(new RegExp(`\\b${escapeRegex(from)}\\b`, "g"), to),
        ),
      );
    }

    // 4. Rewrite _toolRegistry
    const tool = registry.get(from);
    if (tool) {
      const namespacedTool = { ...tool, name: to };
      registry.delete(from);
      registry.set(to, namespacedTool);
    }
  }

  // 5. Re-sync active tool names with the renamed registry.
  // setActiveToolsByName validates against _toolRegistry, so it will only
  // activate tools that exist under their new namespaced keys.
  const activeNames: string[] = session.getActiveToolNames();
  const updatedNames = activeNames.map((name: string) => {
    const rename = renames.find((r) => r.from === name);
    return rename ? rename.to : name;
  });
  session.setActiveToolsByName(updatedNames);
}

/**
 * Rewrite tool definitions with namespaced names.
 * Uses Object.create to delegate to the original definition so execute()
 * and all other properties are inherited — only name, promptSnippet,
 * and promptGuidelines are overridden.
 */
export function rewriteTools(
  tools: RegisteredTool[],
  config: NamespaceConfig,
): RegisteredTool[] {
  return tools.map((tool) => {
    const ns = resolveNamespace(
      {
        name: tool.definition.name,
        description: tool.definition.description,
        parameters: (tool.definition as any).parameters,
        promptGuidelines: tool.definition.promptGuidelines,
        sourceInfo: tool.sourceInfo,
      },
      config,
    );

    if (!ns) return tool;

    const sep = config.separator ?? ":";
    const namespacedName = applyNamespace(ns, tool.definition.name, sep);

    // Don't rewrite built-in tool overrides — those intentionally replace the
    // built-in by name. If the extension that provides the override has a
    // namespace, it would break the override mechanism.
    // We only namespace if the tool name differs from a built-in OR if the
    // user explicitly set builtinNamespace.
    if (BUILTIN_TOOLS.has(tool.definition.name) && !config.builtinNamespace) {
      // This is a built-in tool being listed — only namespace if builtinNamespace is set
      if (tool.sourceInfo.source === "builtin") return tool;
    }

    // Create a delegating object that overrides only the name-related fields
    const namespacedDef = Object.create(tool.definition) as typeof tool.definition;
    namespacedDef.name = namespacedName;

    // Rewrite prompt snippets and guidelines to use the namespaced name
    if (tool.definition.promptSnippet) {
      namespacedDef.promptSnippet = tool.definition.promptSnippet.replace(
        new RegExp(`\\b${escapeRegex(tool.definition.name)}\\b`, "g"),
        namespacedName,
      );
    }

    if (tool.definition.promptGuidelines?.length) {
      namespacedDef.promptGuidelines = tool.definition.promptGuidelines.map((g) =>
        g.replace(
          new RegExp(`\\b${escapeRegex(tool.definition.name)}\\b`, "g"),
          namespacedName,
        ),
      );
    }

    return {
      definition: namespacedDef,
      sourceInfo: tool.sourceInfo,
    };
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Skill namespacing ---

/**
 * Rewrite skill descriptions in the system prompt to include namespace prefixes.
 * Skills are formatted as XML blocks — we rewrite the <skill name="..."> attributes
 * and the description lines within the <available_skills> section.
 */
function rewriteSkillPrompt(systemPrompt: string, config: NamespaceConfig): string {
  // Skills appear as:
  //   <skill name="brave-search">
  //     description text
  //   </skill>
  // We rewrite the name attribute to include the namespace based on the skill's
  // baseDir matching against our config.
  //
  // Since we don't have direct access to skill sourceInfo from the system prompt
  // string, we match skill names against our namespace config keys. If a skill
  // name is listed directly in the config, we namespace it.
  if (!config.namespaces) return systemPrompt;

  let result = systemPrompt;
  for (const [key, ns] of Object.entries(config.namespaces)) {
    // Match skill name attributes and skill command references
    // <skill name="key"> or <skill name="key-suffix">
    const skillRegex = new RegExp(
      `<skill name="(${escapeRegex(key)}[^"]*)"`,
      "g",
    );
    const sep = config.separator ?? ":";
    result = result.replace(skillRegex, (_match, name) => {
      const namespacedName = applyNamespace(ns, name, sep);
      return `<skill name="${namespacedName}"`;
    });

    // Also rewrite /skill:name references in descriptions
    const skillCmdRegex = new RegExp(
      `/skill:${escapeRegex(key)}([^\\s<"]*)`,
      "g",
    );
    result = result.replace(skillCmdRegex, (_match, suffix) => {
      const originalName = key + suffix;
      return `/skill:${applyNamespace(ns, originalName, sep)}`;
    });
  }

  return result;
}

// --- Extension entry ---

export default async function namespaceExtension(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const config = loadConfig(cwd);

  // Track the namespace map for reverse lookups (namespaced → original)
  const nsMap = new Map<string, string>();

  // Apply prototype patches EAGERLY in the factory body (not in session_start).
  // The factory runs during _buildRuntime, before _refreshToolRegistry is
  // called for the first time. If we defer to session_start, the first
  // _refreshToolRegistry call will use the unpatched prototype.
  await patchExtensionRunner(config);
  await patchAgentSession(config);

  // Build the map after tools are registered
  pi.on("session_start", async (_event, _ctx) => {
    // Build the reverse namespace map from current tools
    const tools = pi.getAllTools();
    const sep = config.separator ?? ":";
    nsMap.clear();
    for (const tool of tools) {
      const ns = resolveNamespace(tool, config);
      if (ns) {
        const namespacedName = applyNamespace(ns, tool.name, sep);
        nsMap.set(namespacedName, tool.name);
      }
    }
  });

  // Rewrite skill names in the system prompt
  pi.on("before_agent_start", async (event) => {
    if (Object.keys(config.namespaces ?? {}).length === 0 && !config.builtinNamespace) {
      return;
    }

    const rewritten = rewriteSkillPrompt(event.systemPrompt, config);
    if (rewritten !== event.systemPrompt) {
      return { systemPrompt: rewritten };
    }
  });

  // Register a /namespace command to show current namespace config
  pi.registerCommand("namespace", {
    description: "Show current tool/skill namespace configuration",
    getArgumentCompletions(prefix: string) {
      const subcommands = ["list", "config", "map"];
      return subcommands
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      const subcommand = args?.trim();

      if (subcommand === "config") {
        ctx.ui.notify(
          `Namespace config:\n${JSON.stringify(config, null, 2)}`,
          "info",
        );
        return;
      }

      if (subcommand === "map") {
        const tools = pi.getAllTools();
        const lines = tools.map((t) => {
          const ns = resolveNamespace(t, config);
          if (ns) {
            const namespaced = applyNamespace(ns, t.name, config.separator ?? ":");
            return `  ${t.name} → ${namespaced} (${t.sourceInfo.path})`;
          }
          return `  ${t.name} (no namespace, ${t.sourceInfo.source})`;
        });
        ctx.ui.notify(`Tool namespace map:\n${lines.join("\n")}`, "info");
        return;
      }

      // Default: list
      const tools = pi.getAllTools();
      const namespaced = tools.filter((t) => resolveNamespace(t, config));
      const builtin = tools.filter(
        (t) => t.sourceInfo.source === "builtin",
      );

      const lines: string[] = [
        `Namespaced: ${namespaced.length}/${tools.length} tools`,
      ];
      if (config.builtinNamespace) {
        lines.push(`Built-in namespace: ${config.builtinNamespace}`);
      }
      if (config.separator && config.separator !== ":") {
        lines.push(`Separator: ${config.separator}`);
      }
      if (config.autoNamespace) {
        lines.push("Auto-namespace: enabled");
      }
      if (config.namespaces && Object.keys(config.namespaces).length > 0) {
        lines.push(
          `Explicit mappings: ${Object.keys(config.namespaces).length}`,
        );
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
