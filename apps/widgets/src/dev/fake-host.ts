/** An in-memory Host for the dev preview and the tests: tool calls go to handlers you provide. */
import type { DisplayMode, Host, HostContext, HostState } from "../host";
import type { ToolCall, ToolResult } from "../types";

export type Handler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

export interface FakeHost extends Host {
  calls: ToolCall[];
  messages: string[];
  contextNotes: string[];
  links: string[];
  setResult(result: ToolResult | null, cancelled?: boolean): void;
  setContext(patch: HostContext): void;
}

export function createFakeHost(
  options: {
    handlers?: Record<string, Handler>;
    result?: ToolResult | null;
    cancelled?: boolean;
    context?: HostContext;
    canMessage?: boolean;
  } = {},
): FakeHost {
  const listeners = new Set<() => void>();
  let state: HostState = {
    ready: true,
    mode: "mcp",
    context: { theme: "light", locale: "en-US", displayMode: "inline", ...options.context },
    capabilities: { message: {}, openLinks: {}, updateModelContext: {} },
    toolName: null,
    toolInput: null,
    toolResult: options.result ?? null,
    cancelled: options.cancelled ?? false,
  };
  const set = (patch: Partial<HostState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const host: FakeHost = {
    calls: [],
    messages: [],
    contextNotes: [],
    links: [],
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async callTool(call) {
      host.calls.push(call);
      const handler = options.handlers?.[call.name];
      if (!handler)
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: { code: "NOT_FOUND", message: `no fake for ${call.name}` },
              }),
            },
          ],
        };
      return handler(call.arguments);
    },
    async openLink(url) {
      host.links.push(url);
    },
    canSendMessage: () => options.canMessage ?? true,
    async sendMessage(text) {
      host.messages.push(text);
      return true;
    },
    async updateModelContext(text) {
      host.contextNotes.push(text);
    },
    canRequestDisplayMode: (mode: DisplayMode) =>
      (state.context.availableDisplayModes ?? ["inline", "fullscreen"]).includes(mode),
    async requestDisplayMode(mode) {
      set({ context: { ...state.context, displayMode: mode } });
    },
    setResult(result, cancelled = false) {
      set({ toolResult: result, cancelled });
    },
    setContext(patch) {
      set({ context: { ...state.context, ...patch } });
    },
  };
  return host;
}
