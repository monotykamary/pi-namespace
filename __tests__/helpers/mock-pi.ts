/**
 * Mock ExtensionAPI for pi-namespace tests.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const noop = () => {};

export interface MockPi extends ExtensionAPI {
  _eventHandlers: Map<string, Array<(...args: any[]) => void>>;
  _registeredTools: string[];
  _registeredCommands: Array<{ name: string; config: any }>;
  _flags: Map<string, any>;
}

export function createMockPi(): MockPi {
  const eventHandlers = new Map<string, Array<(...args: any[]) => void>>();

  const mock: MockPi = {
    _eventHandlers: eventHandlers,
    _registeredTools: [],
    _registeredCommands: [],
    _flags: new Map(),

    on(event: string, handler: any) {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event)!.push(handler);
    },
    registerTool(tool: any): void {
      mock._registeredTools.push(tool.name);
    },
    registerCommand(name: string, config: any) {
      mock._registeredCommands.push({ name, config });
    },
    registerShortcut: noop as any,
    registerFlag: noop as any,
    getFlag: ((name: string) => mock._flags.get(name)) as any,
    registerMessageRenderer: noop as any,
    registerMarkdownTransformer: noop as any,
    registerEntryRenderer: noop as any,
    sendMessage: noop as any,
    sendUserMessage: noop as any,
    appendEntry: noop as any,
    setSessionName: noop as any,
    getSessionName: noop as any,
    setLabel: noop as any,
    exec: noop as any,
    setModel: noop as any,
    getThinkingLevel: noop as any,
    setThinkingLevel: noop as any,
    registerProvider: noop as any,
    unregisterProvider: noop as any,
    getAllTools: (() => []) as any,
    getActiveTools: (() => []) as any,
    setActiveTools: noop as any,
    getCommands: (() => []) as any,
    events: {} as any,
  } as MockPi;

  return mock;
}

function makeToolInfo(
  name: string,
  source: string = "local",
  path: string = "/some/extension",
) {
  return {
    name,
    description: `Tool ${name}`,
    parameters: {},
    promptGuidelines: undefined as string[] | undefined,
    sourceInfo: {
      path,
      source,
      scope: "user" as const,
      origin: "top-level" as const,
    },
  };
}
