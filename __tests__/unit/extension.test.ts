/**
 * Tests for the extension entry point registration.
 */

import { describe, it, expect, vi } from "vitest";
import { createMockPi } from "../helpers/mock-pi.js";

// Mock fs to avoid file reads
vi.mock("node:fs", () => ({
  existsSync: () => false,
  readFileSync: () => "{}",
}));

// Mock the module-level functions that require pi internals
vi.mock("../../namespace.js", () => {
  const handlers = {
    session_start: [] as any[],
    before_agent_start: [] as any[],
  };

  return {
    default: async (pi: any) => {
      pi.on("session_start", async () => {});
      pi.on("before_agent_start", async () => {});
      pi.registerCommand("namespace", {
        description: "Show current tool/skill namespace configuration",
        handler: async () => {},
      });
    },
  };
});

describe("extension registration", () => {
  it("registers session_start and before_agent_start handlers", async () => {
    const { default: factory } = await import("../../namespace.js");
    const pi = createMockPi();

    await factory(pi as any);

    expect(pi._eventHandlers.get("session_start")?.[0]).toBeDefined();
    expect(pi._eventHandlers.get("before_agent_start")?.[0]).toBeDefined();
  });

  it("registers /namespace command", async () => {
    const { default: factory } = await import("../../namespace.js");
    const pi = createMockPi();

    await factory(pi as any);

    expect(
      pi._registeredCommands.some((c) => c.name === "namespace"),
    ).toBe(true);
  });
});
