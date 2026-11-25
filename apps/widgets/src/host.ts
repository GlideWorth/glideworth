/**
 * A small MCP Apps client (the `ui/*` postMessage JSON-RPC protocol, spec 2026-01-26) with a `window.openai`
 * fallback for ChatGPT. The official `App` class pulls in the MCP SDK and zod, so the widget speaks the wire
 * protocol directly. Adapted from the owner's PropertyPixel widget.
 */
import type { ToolCall, ToolResult } from "./types";

const PROTOCOL_VERSION = "2026-01-26";
const APP_INFO = { name: "Glideworth", version: "1.0.0" };
const INIT_TIMEOUT_MS = 2500;
const REQUEST_TIMEOUT_MS = 120_000;

export type DisplayMode = "inline" | "fullscreen" | "pip";

/** The parts of the MCP Apps host context the widget reads. */
export interface HostContext {
  theme?: "light" | "dark";
  locale?: string;
  displayMode?: DisplayMode;
  availableDisplayModes?: string[];
  styles?: { variables?: Record<string, string | undefined> };
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
  containerDimensions?: { maxHeight?: number; height?: number };
  toolInfo?: { tool?: { name?: string } };
}

type HostCapabilities = Record<string, unknown>;

export interface OpenAiApi {
  toolInput?: Record<string, unknown> | null;
  toolOutput?: Record<string, unknown> | null;
  toolResponseMetadata?: Record<string, unknown> | null;
  theme?: "light" | "dark";
  locale?: string;
  displayMode?: DisplayMode;
  maxHeight?: number;
  safeArea?: { insets?: { top: number; right: number; bottom: number; left: number } };
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  sendFollowUpMessage?: (args: { prompt: string }) => Promise<void>;
  openExternal?: (args: { href: string }) => void;
  notifyIntrinsicHeight?: (height: number) => void;
  setWidgetState?: (state: Record<string, unknown>) => Promise<void> | void;
  requestDisplayMode?: (args: { mode: DisplayMode }) => Promise<{ mode?: DisplayMode }> | void;
}

declare global {
  interface Window {
    openai?: OpenAiApi;
  }
}

export interface HostState {
  ready: boolean;
  mode: "mcp" | "openai" | "none";
  context: HostContext;
  capabilities: HostCapabilities;
  toolName: string | null;
  toolInput: Record<string, unknown> | null;
  toolResult: ToolResult | null;
  cancelled: boolean;
}

export interface Host {
  getState(): HostState;
  subscribe(listener: () => void): () => void;
  callTool(call: ToolCall): Promise<ToolResult>;
  openLink(url: string): Promise<void>;
  sendMessage(text: string): Promise<boolean>;
  canSendMessage(): boolean;
  /** Tell the assistant what the user did in the widget (applied a change, saved a what-if). */
  updateModelContext(text: string): Promise<void>;
  canRequestDisplayMode(mode: DisplayMode): boolean;
  requestDisplayMode(mode: DisplayMode): Promise<void>;
}

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** ChatGPT's `callTool` has returned a few shapes over time. */
function normalizeOpenAiResult(raw: unknown): ToolResult {
  if (!isObj(raw)) return { structuredContent: {} };
  if ("structuredContent" in raw || "content" in raw || "isError" in raw || "_meta" in raw)
    return raw as ToolResult;
  if (typeof raw.result === "string") {
    try {
      const parsed: unknown = JSON.parse(raw.result);
      if (isObj(parsed)) return { structuredContent: parsed };
    } catch {
      return { content: [{ type: "text", text: raw.result }] };
    }
  }
  return { structuredContent: raw };
}

/** The window-like surface the host needs; tests pass a fake. */
export type HostWindow = Pick<
  Window,
  "parent" | "addEventListener" | "document" | "innerWidth" | "requestAnimationFrame" | "open"
> & { openai?: OpenAiApi };

export function createHost(win: HostWindow = window): Host {
  const listeners = new Set<() => void>();
  const pending = new Map<string | number, Pending>();
  let nextId = 1;
  const openai = win.openai ?? null;
  const inFrame = (win.parent as unknown) !== win;

  let state: HostState = {
    ready: false,
    mode: "none",
    context: {},
    capabilities: {},
    toolName: null,
    toolInput: null,
    toolResult: null,
    cancelled: false,
  };

  const setState = (patch: Partial<HostState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const post = (message: JsonRpcMessage) => win.parent.postMessage(message, "*");

  const request = (
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      post({ jsonrpc: "2.0", id, method, params });
    });

  const notify = (method: string, params: Record<string, unknown> = {}) =>
    post({ jsonrpc: "2.0", method, params });

  const respond = (id: string | number, result: unknown) => post({ jsonrpc: "2.0", id, result });

  const toolNameFrom = (context: HostContext) => context.toolInfo?.tool?.name ?? null;

  function handleNotification(method: string, params: Record<string, unknown>) {
    switch (method) {
      case "ui/notifications/tool-input":
        setState({ toolInput: isObj(params.arguments) ? params.arguments : {} });
        break;
      case "ui/notifications/tool-result":
        setState({ toolResult: params as ToolResult, cancelled: false });
        break;
      case "ui/notifications/tool-cancelled":
        setState({ cancelled: true });
        break;
      case "ui/notifications/host-context-changed": {
        const context = { ...state.context, ...(params as HostContext) };
        setState({ context, toolName: toolNameFrom(context) ?? state.toolName });
        break;
      }
    }
  }

  win.addEventListener("message", (event: MessageEvent) => {
    if (inFrame && event.source !== win.parent) return;
    const message = event.data as JsonRpcMessage;
    if (!isObj(message) || message.jsonrpc !== "2.0") return;

    if (message.method && message.id !== undefined) {
      // Host → app requests: ping and teardown need an answer; the widget exposes no tools.
      if (message.method === "ping" || message.method === "ui/resource-teardown") {
        respond(message.id, {});
      } else {
        post({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        });
      }
      return;
    }
    if (message.method) {
      handleNotification(message.method, isObj(message.params) ? message.params : {});
      return;
    }
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  });

  // ChatGPT exposes the tool call through globals too; use them until (or unless) the MCP bridge delivers it.
  const readOpenAiGlobals = () => {
    if (!openai) return;
    const patch: Partial<HostState> = {};
    if (isObj(openai.toolInput) && openai.toolInput !== state.toolInput)
      patch.toolInput = openai.toolInput;
    if (state.mode !== "mcp" && (isObj(openai.toolOutput) || isObj(openai.toolResponseMetadata))) {
      const next: ToolResult = {
        ...(isObj(openai.toolOutput) ? { structuredContent: openai.toolOutput } : {}),
        ...(isObj(openai.toolResponseMetadata) ? { _meta: openai.toolResponseMetadata } : {}),
      };
      const current = state.toolResult;
      if (
        !current ||
        current.structuredContent !== next.structuredContent ||
        current._meta !== next._meta
      )
        patch.toolResult = next;
    }
    if (state.mode !== "mcp") {
      const insets = openai.safeArea?.insets;
      patch.context = {
        ...state.context,
        ...(openai.theme ? { theme: openai.theme } : {}),
        ...(openai.locale ? { locale: openai.locale } : {}),
        ...(openai.displayMode ? { displayMode: openai.displayMode } : {}),
        ...(insets ? { safeAreaInsets: insets } : {}),
        ...(openai.maxHeight ? { containerDimensions: { maxHeight: openai.maxHeight } } : {}),
      };
    }
    if (Object.keys(patch).length) setState(patch);
  };
  if (openai) {
    readOpenAiGlobals();
    win.addEventListener("openai:set_globals", readOpenAiGlobals);
  }

  let lastHeight = -1;
  let lastWidth = -1;
  const reportSize = () => {
    const root = win.document.documentElement;
    const previous = root.style.height;
    root.style.height = "max-content";
    const height = Math.ceil(root.getBoundingClientRect().height);
    root.style.height = previous;
    const width = Math.ceil(win.innerWidth);
    if (height === lastHeight && width === lastWidth) return;
    lastHeight = height;
    lastWidth = width;
    if (state.mode === "mcp") notify("ui/notifications/size-changed", { width, height });
    openai?.notifyIntrinsicHeight?.(height);
  };
  let sizeQueued = false;
  const queueSize = () => {
    if (sizeQueued) return;
    sizeQueued = true;
    win.requestAnimationFrame(() => {
      sizeQueued = false;
      reportSize();
    });
  };
  const startSizeReporting = () => {
    queueSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(queueSize);
    observer.observe(win.document.documentElement);
    observer.observe(win.document.body);
  };

  if (inFrame) {
    const fallback = setTimeout(() => {
      if (state.mode === "mcp") return;
      setState({ ready: true, mode: openai ? "openai" : "none" });
      if (openai) startSizeReporting();
    }, INIT_TIMEOUT_MS);
    request("ui/initialize", {
      appInfo: APP_INFO,
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      protocolVersion: PROTOCOL_VERSION,
    })
      .then((raw) => {
        clearTimeout(fallback);
        const wasReporting = state.mode === "openai";
        const result = (isObj(raw) ? raw : {}) as {
          hostContext?: HostContext;
          hostCapabilities?: HostCapabilities;
        };
        const context = { ...state.context, ...result.hostContext };
        setState({
          ready: true,
          mode: "mcp",
          context,
          capabilities: result.hostCapabilities ?? {},
          toolName: toolNameFrom(context),
        });
        notify("ui/notifications/initialized");
        if (wasReporting) {
          lastHeight = -1;
          queueSize();
        } else startSizeReporting();
      })
      .catch(() => {
        clearTimeout(fallback);
        if (state.mode !== "none") return;
        setState({ ready: true, mode: openai ? "openai" : "none" });
        if (openai) startSizeReporting();
      });
  } else {
    setState({ ready: true, mode: openai ? "openai" : "none" });
  }

  const mcpDisplayModes = () => state.context.availableDisplayModes ?? [];

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async callTool(call) {
      if (state.mode === "mcp") {
        return (await request("tools/call", {
          name: call.name,
          arguments: call.arguments,
        })) as ToolResult;
      }
      if (openai?.callTool)
        return normalizeOpenAiResult(await openai.callTool(call.name, call.arguments));
      throw new Error("This chat can't run Glideworth actions from the view.");
    },
    async openLink(url) {
      if (state.mode === "mcp" && state.capabilities.openLinks) {
        const result = (await request("ui/open-link", { url })) as
          | { isError?: boolean }
          | undefined;
        if (!result?.isError) return;
      }
      if (openai?.openExternal) {
        openai.openExternal({ href: url });
        return;
      }
      win.open(url, "_blank", "noopener,noreferrer");
    },
    canSendMessage: () =>
      (state.mode === "mcp" && Boolean(state.capabilities.message)) ||
      Boolean(openai?.sendFollowUpMessage),
    async sendMessage(text) {
      if (state.mode === "mcp" && state.capabilities.message) {
        const result = (await request("ui/message", {
          role: "user",
          content: [{ type: "text", text }],
        })) as { isError?: boolean } | undefined;
        return !result?.isError;
      }
      if (openai?.sendFollowUpMessage) {
        await openai.sendFollowUpMessage({ prompt: text });
        return true;
      }
      return false;
    },
    async updateModelContext(text) {
      try {
        if (state.mode === "mcp") {
          if (state.capabilities.updateModelContext)
            await request("ui/update-model-context", { content: [{ type: "text", text }] });
          return;
        }
        await openai?.setWidgetState?.({ note: text });
      } catch {
        // Best effort: the action itself already succeeded.
      }
    },
    canRequestDisplayMode(mode) {
      if (state.mode === "mcp") return mcpDisplayModes().includes(mode);
      return Boolean(openai?.requestDisplayMode);
    },
    async requestDisplayMode(mode) {
      if (state.mode === "mcp") {
        const result = (await request("ui/request-display-mode", { mode })) as
          | { mode?: DisplayMode }
          | undefined;
        setState({ context: { ...state.context, displayMode: result?.mode ?? mode } });
        return;
      }
      const result = await openai?.requestDisplayMode?.({ mode });
      setState({ context: { ...state.context, displayMode: result?.mode ?? mode } });
    },
  };
}
