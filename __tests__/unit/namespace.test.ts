/**
 * Tests for namespace derivation and resolution logic.
 */

import { describe, it, expect } from "vitest";
import {
  deriveNamespace,
  resolveNamespace,
  applyNamespace,
  stripNamespace,
  rewriteTools,
  rewriteBuiltinTools,
} from "../../namespace.js";
import type { NamespaceConfig } from "../../namespace.js";

describe("deriveNamespace", () => {
  it("derives from npm: source paths", () => {
    expect(deriveNamespace("npm:@foo/pi-deploy")).toBe("deploy");
    expect(deriveNamespace("npm:pi-search")).toBe("search");
  });

  it("derives from git: source paths", () => {
    expect(deriveNamespace("git:github.com/user/pi-messenger")).toBe(
      "messenger",
    );
    expect(deriveNamespace("git:git@github.com:user/pi-tools")).toBe("tools");
  });

  it("derives from file paths with pi- prefix", () => {
    expect(
      deriveNamespace(
        "/home/user/.pi/agent/extensions/pi-deploy/index.ts",
      ),
    ).toBe("deploy");
  });

  it("falls back to parent directory name", () => {
    expect(deriveNamespace("/home/user/.pi/agent/extensions/myext/index.ts")).toBe(
      "myext",
    );
  });

  it("returns null for unresolvable paths", () => {
    expect(deriveNamespace("index.ts")).toBeNull();
  });
});

describe("resolveNamespace", () => {
  const tool = (source: string, path: string) => ({
    name: "test_tool",
    description: "A test tool",
    parameters: {},
    sourceInfo: {
      path,
      source,
      scope: "user" as const,
      origin: "top-level" as const,
    },
  });

  it("resolves builtinNamespace for built-in tools", () => {
    const config: NamespaceConfig = { builtinNamespace: "fs" };
    expect(resolveNamespace(tool("builtin", "<builtin:read>"), config)).toBe(
      "fs",
    );
  });

  it("resolves explicit namespace mapping with exact match", () => {
    const config: NamespaceConfig = {
      namespaces: {
        "/home/user/.pi/agent/extensions/deploy/index.ts": "deploy",
      },
    };
    expect(
      resolveNamespace(
        tool("local", "/home/user/.pi/agent/extensions/deploy/index.ts"),
        config,
      ),
    ).toBe("deploy");
  });

  it("resolves explicit namespace mapping with substring match", () => {
    const config: NamespaceConfig = {
      namespaces: {
        "deploy-extension": "deploy",
      },
    };
    expect(
      resolveNamespace(
        tool("local", "/some/path/deploy-extension/index.ts"),
        config,
      ),
    ).toBe("deploy");
  });

  it("falls back to autoNamespace", () => {
    const config: NamespaceConfig = { autoNamespace: true };
    expect(
      resolveNamespace(
        tool("local", "/home/user/.pi/agent/extensions/pi-messenger/index.ts"),
        config,
      ),
    ).toBe("messenger");
  });

  it("returns null when no namespace applies", () => {
    const config: NamespaceConfig = {};
    expect(resolveNamespace(tool("local", "/some/ext"), config)).toBeNull();
  });

  it("returns null for SDK tools", () => {
    const config: NamespaceConfig = { autoNamespace: true };
    expect(resolveNamespace(tool("sdk", "<sdk:custom>"), config)).toBeNull();
  });
});

describe("applyNamespace", () => {
  it("prefixes with colon separator", () => {
    expect(applyNamespace("deploy", "push")).toBe("deploy:push");
  });

  it("does not double-prefix", () => {
    expect(applyNamespace("deploy", "deploy:push")).toBe("deploy:push");
  });

  it("works for built-in tools", () => {
    expect(applyNamespace("fs", "read")).toBe("fs:read");
  });
});

describe("stripNamespace", () => {
  it("strips a known namespace prefix", () => {
    const nsMap = new Map<string, string>([["deploy", "push"]]);
    expect(stripNamespace("deploy:push", nsMap)).toBe("push");
  });

  it("returns original if prefix is unknown", () => {
    const nsMap = new Map<string, string>();
    expect(stripNamespace("unknown:tool", nsMap)).toBe("unknown:tool");
  });

  it("returns original if no colon present", () => {
    const nsMap = new Map<string, string>([["deploy", "push"]]);
    expect(stripNamespace("push", nsMap)).toBe("push");
  });
});

describe("rewriteTools", () => {
  function makeTool(name: string, source: string, path: string) {
    return {
      definition: {
        name,
        label: name,
        description: `Tool ${name}`,
        promptSnippet: `Use ${name} to do things`,
        promptGuidelines: [`Use ${name} when needed`],
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
      sourceInfo: {
        path,
        source,
        scope: "user" as const,
        origin: "top-level" as const,
      },
    };
  }

  it("rewrites extension tools with namespace prefix", () => {
    const config: NamespaceConfig = {
      namespaces: { "deploy-ext": "deploy" },
    };
    const tools = [
      makeTool("push", "local", "/some/deploy-ext/index.ts"),
      makeTool("status", "local", "/some/deploy-ext/index.ts"),
    ];

    const result = rewriteTools(tools, config);

    expect(result[0].definition.name).toBe("deploy:push");
    expect(result[1].definition.name).toBe("deploy:status");

    // promptSnippet is rewritten
    expect(result[0].definition.promptSnippet).toBe(
      "Use deploy:push to do things",
    );

    // promptGuidelines are rewritten
    expect(result[0].definition.promptGuidelines).toEqual([
      "Use deploy:push when needed",
    ]);
  });

  it("rewrites built-in tools when builtinNamespace is set", () => {
    const config: NamespaceConfig = { builtinNamespace: "fs" };
    const tools = [makeTool("read", "builtin", "<builtin:read>")];

    const result = rewriteTools(tools, config);
    expect(result[0].definition.name).toBe("fs:read");
  });

  it("does not rewrite built-in tools when builtinNamespace is not set", () => {
    const config: NamespaceConfig = {};
    const tools = [makeTool("read", "builtin", "<builtin:read>")];

    const result = rewriteTools(tools, config);
    expect(result[0].definition.name).toBe("read");
  });

  it("preserves execute function via delegation", () => {
    const config: NamespaceConfig = {
      namespaces: { "deploy-ext": "deploy" },
    };
    let called = false;
    const tools = [
      {
        definition: {
          name: "push",
          label: "push",
          description: "Push tool",
          execute: async () => {
            called = true;
            return { content: [{ type: "text", text: "ok" }] };
          },
        },
        sourceInfo: {
          path: "/some/deploy-ext/index.ts",
          source: "local",
          scope: "user" as const,
          origin: "top-level" as const,
        },
      },
    ];

    const result = rewriteTools(tools, config);

    // The definition should still have an execute function
    expect(typeof result[0].definition.execute).toBe("function");

    // And the delegated execute should call the original
    expect(result[0].definition.execute).toBe(tools[0].definition.execute);
  });

  it("leaves unmapped tools unchanged", () => {
    const config: NamespaceConfig = {
      namespaces: { "deploy-ext": "deploy" },
    };
    const tools = [
      makeTool("search", "local", "/some/other-ext/index.ts"),
    ];

    const result = rewriteTools(tools, config);
    expect(result[0].definition.name).toBe("search");
  });

  it("handles tools without promptSnippet or promptGuidelines", () => {
    const config: NamespaceConfig = {
      namespaces: { "deploy-ext": "deploy" },
    };
    const tools = [
      {
        definition: {
          name: "push",
          label: "push",
          description: "Push tool",
          execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
        sourceInfo: {
          path: "/some/deploy-ext/index.ts",
          source: "local",
          scope: "user" as const,
          origin: "top-level" as const,
        },
      },
    ];

    const result = rewriteTools(tools, config);
    expect(result[0].definition.name).toBe("deploy:push");
    // No promptSnippet or promptGuidelines to rewrite — should not throw
  });
});

describe("rewriteBuiltinTools", () => {
  function makeSession(builtinNames: string[] = ["read", "bash", "edit"]) {
    const definitions = new Map();
    const snippets = new Map();
    const guidelines = new Map();
    const registry = new Map();
    const activeNames = [...builtinNames];

    for (const name of builtinNames) {
      definitions.set(name, {
        definition: {
          name,
          label: name,
          description: `Built-in ${name}`,
          promptSnippet: `Use ${name} for file ops`,
          promptGuidelines: [`Always use ${name} carefully`],
          execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
        sourceInfo: {
          path: `<builtin:${name}>`,
          source: "builtin",
          scope: "temporary",
          origin: "top-level",
        },
      });

      snippets.set(name, `Use ${name} for file ops`);
      guidelines.set(name, [`Always use ${name} carefully`]);
      registry.set(name, {
        name,
        label: name,
        description: `Built-in ${name}`,
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      });
    }

    return {
      _toolDefinitions: definitions,
      _toolPromptSnippets: snippets,
      _toolPromptGuidelines: guidelines,
      _toolRegistry: registry,
      getActiveToolNames: () => [...activeNames],
      setActiveToolsByName: (names: string[]) => {
        activeNames.length = 0;
        activeNames.push(...names);
      },
    };
  }

  it("renames built-in tools in all session data structures", () => {
    const config: NamespaceConfig = { builtinNamespace: "fs" };
    const session = makeSession(["read", "bash"]);

    rewriteBuiltinTools(session, config);

    // _toolDefinitions
    expect(session._toolDefinitions.has("read")).toBe(false);
    expect(session._toolDefinitions.has("bash")).toBe(false);
    expect(session._toolDefinitions.get("fs:read").definition.name).toBe("fs:read");
    expect(session._toolDefinitions.get("fs:bash").definition.name).toBe("fs:bash");
    expect(session._toolDefinitions.get("fs:read").sourceInfo.source).toBe("builtin");

    // _toolPromptSnippets
    expect(session._toolPromptSnippets.has("read")).toBe(false);
    expect(session._toolPromptSnippets.get("fs:read")).toBe("Use fs:read for file ops");

    // _toolPromptGuidelines
    expect(session._toolPromptGuidelines.has("bash")).toBe(false);
    expect(session._toolPromptGuidelines.get("fs:bash")).toEqual([
      "Always use fs:bash carefully",
    ]);

    // _toolRegistry
    expect(session._toolRegistry.has("read")).toBe(false);
    expect(session._toolRegistry.get("fs:read").name).toBe("fs:read");

    // Active tool names were re-synced
    expect(session.getActiveToolNames()).toContain("fs:read");
    expect(session.getActiveToolNames()).toContain("fs:bash");
    expect(session.getActiveToolNames()).not.toContain("read");
  });

  it("does nothing when builtinNamespace is not set", () => {
    const config: NamespaceConfig = {};
    const session = makeSession(["read"]);

    rewriteBuiltinTools(session, config);

    expect(session._toolDefinitions.has("read")).toBe(true);
    expect(session._toolDefinitions.has("fs:read")).toBe(false);
  });

  it("skips extension overrides of built-in tools", () => {
    const config: NamespaceConfig = { builtinNamespace: "fs" };
    const session = makeSession(["read"]);

    // Simulate an extension override: replace the built-in entry with
    // an extension entry that has source !== "builtin".
    session._toolDefinitions.set("read", {
      definition: {
        name: "read",
        label: "Enhanced read",
        description: "Override from extension",
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
      sourceInfo: {
        path: "/extensions/pi-code-previews/index.ts",
        source: "local",
        scope: "user",
        origin: "top-level",
      },
    });

    rewriteBuiltinTools(session, config);

    // Override should NOT be renamed — it's not from source "builtin"
    expect(session._toolDefinitions.has("read")).toBe(true);
    expect(session._toolDefinitions.has("fs:read")).toBe(false);
  });

  it("rewrites promptSnippet and promptGuidelines to use namespaced name", () => {
    const config: NamespaceConfig = { builtinNamespace: "fs" };
    const session = makeSession(["read"]);

    rewriteBuiltinTools(session, config);

    const entry = session._toolDefinitions.get("fs:read");
    expect(entry.definition.promptSnippet).toBe("Use fs:read for file ops");
    expect(entry.definition.promptGuidelines).toEqual([
      "Always use fs:read carefully",
    ]);
  });

  it("preserves execute function on wrapped tools in registry", () => {
    const config: NamespaceConfig = { builtinNamespace: "fs" };
    const session = makeSession(["read"]);
    const originalExecute = session._toolRegistry.get("read").execute;

    rewriteBuiltinTools(session, config);

    const wrappedTool = session._toolRegistry.get("fs:read");
    expect(wrappedTool.execute).toBe(originalExecute);
  });

  it("is idempotent — calling twice does not double-prefix", () => {
    const config: NamespaceConfig = { builtinNamespace: "fs" };
    const session = makeSession(["read"]);

    rewriteBuiltinTools(session, config);
    rewriteBuiltinTools(session, config);

    // First call renames read → fs:read, second call finds no builtin entries
    expect(session._toolDefinitions.has("fs:read")).toBe(true);
    expect(session._toolDefinitions.has("fs:fs:read")).toBe(false);
  });

  it("handles tools without promptSnippet or promptGuidelines", () => {
    const config: NamespaceConfig = { builtinNamespace: "fs" };
    const session = makeSession(["read"]);

    // Remove optional fields
    const entry = session._toolDefinitions.get("read");
    delete entry.definition.promptSnippet;
    delete entry.definition.promptGuidelines;

    expect(() => rewriteBuiltinTools(session, config)).not.toThrow();
    expect(session._toolDefinitions.get("fs:read").definition.name).toBe(
      "fs:read",
    );
  });
});
