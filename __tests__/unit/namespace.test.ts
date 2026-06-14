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
