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

// --- Config ---

export interface NamespaceConfig {
  /** Map of extension sourceInfo.path (or substring) → namespace prefix */
  namespaces?: Record<string, string>;
  /** Optional namespace for built-in tools (read, bash, edit, write, grep, find, ls) */
  builtinNamespace?: string;
  /** Automatically derive namespace from extension directory/package name when no explicit mapping exists */
  autoNamespace?: boolean;
}

const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

function loadConfig(cwd: string): NamespaceConfig {
  const candidates = [
    join(cwd, ".pi", "namespace.json"),
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

// Copied locally to avoid runtime dependency on getAgentDir at module scope.
// The extension factory passes cwd so this is only used for config loading.
function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir;
  return join(process.env.HOME || "~", ".pi", "agent");
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
export function applyNamespace(prefix: string, name: string): string {
  if (name.startsWith(`${prefix}:`)) {
    return name;
  }
  return `${prefix}:${name}`;
}

/**
 * Strip a known namespace prefix from a tool name.
 * "deploy:push" → "push"  (if we have the mapping)
 * Returns the original name if no known prefix matches.
 */
export function stripNamespace(
  namespacedName: string,
  nsMap: Map<string, string>,
): string {
  const colonIdx = namespacedName.indexOf(":");
  if (colonIdx === -1) return namespacedName;

  const prefix = namespacedName.slice(0, colonIdx);
  const original = namespacedName.slice(colonIdx + 1);

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
  // Try to resolve from the current extension's module graph
  try {
    const metaUrl = import.meta.url;
    const metaPath = metaUrl.replace("file://", "");
    // Walk up from this file to find pi-coding-agent/dist
    const segments = metaPath.split("/");
    for (let i = segments.length - 1; i >= 0; i--) {
      if (
        segments[i] === "pi-coding-agent" &&
        segments[i + 1] === "dist"
      ) {
        return segments.slice(0, i + 2).join("/");
      }
      if (
        segments[i] === "dist" &&
        segments[i - 1] === "pi-coding-agent"
      ) {
        return segments.slice(0, i + 1).join("/");
      }
    }
  } catch {
    // Can't resolve from import.meta
  }

  // Check common install locations
  const candidates = [
    join(
      process.env.HOME || "~",
      ".npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist",
    ),
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist",
  ];

  for (const d of candidates) {
    if (existsSync(join(d, "core/extensions/runner.js"))) {
      return d;
    }
  }

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
    originalRefresh.call(this, ...args);
    rewriteBuiltinTools(this, config);
  };

  sessionPatched = true;
  return true;
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
      const namespacedName = applyNamespace(ns, name);
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

    const namespacedName = applyNamespace(ns, tool.definition.name);

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
    result = result.replace(skillRegex, (_match, name) => {
      const namespacedName = applyNamespace(ns, name);
      return `<skill name="${namespacedName}"`;
    });

    // Also rewrite /skill:name references in descriptions
    const skillCmdRegex = new RegExp(
      `/skill:${escapeRegex(key)}([^\\s<"]*)`,
      "g",
    );
    result = result.replace(skillCmdRegex, (_match, suffix) => {
      const originalName = key + suffix;
      return `/skill:${applyNamespace(ns, originalName)}`;
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

  // Build the map after tools are registered
  pi.on("session_start", async (_event, _ctx) => {
    // Patch the runner if not already done
    const runnerSuccess = await patchExtensionRunner(config);
    if (!runnerSuccess) {
      // Couldn't patch — likely running in an environment where the
      // runner module isn't accessible (print mode, etc.)
    }

    // Patch the AgentSession if builtinNamespace is configured
    const sessionSuccess = await patchAgentSession(config);
    if (!sessionSuccess && config.builtinNamespace) {
      // Couldn't patch — built-in tools won't be namespaced
    }

    // Build the reverse namespace map from current tools
    const tools = pi.getAllTools();
    nsMap.clear();
    for (const tool of tools) {
      const ns = resolveNamespace(tool, config);
      if (ns) {
        const namespacedName = applyNamespace(ns, tool.name);
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
            const namespaced = applyNamespace(ns, t.name);
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
