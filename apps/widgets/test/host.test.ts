import { describe, expect, it, vi } from "vitest";
import { outcomeMonteCarlo, resultOf } from "../src/fixtures";
import { createHost, type HostWindow, type OpenAiApi } from "../src/host";
import { payloadFrom } from "../src/routing";
import { WIDGET_META_KEY } from "../src/types";

type Message = { jsonrpc: "2.0"; id?: number; method?: string; params?: Record<string, unknown> };

/** A window inside a host iframe: what the widget posts is recorded, and `deliver` plays the host. */
function framedWindow(openai?: OpenAiApi) {
  const target = new EventTarget();
  const posted: Message[] = [];
  const parent = { postMessage: (message: Message) => posted.push(message) };
  const win = {
    parent,
    addEventListener: target.addEventListener.bind(target),
    document,
    innerWidth: 360,
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    },
    open: vi.fn(),
    openai,
  } as unknown as HostWindow;
  const deliver = (data: unknown, source: unknown = parent) => {
    const event = new Event("message");
    Object.assign(event, { data, source });
    target.dispatchEvent(event);
  };
  const request = (method: string) => posted.find((m) => m.method === method && m.id !== undefined);
  return { win, posted, deliver, request, target };
}

async function initialised(capabilities: Record<string, unknown> = {}, hostContext = {}) {
  const frame = framedWindow();
  const host = createHost(frame.win);
  const init = frame.request("ui/initialize");
  frame.deliver({
    jsonrpc: "2.0",
    id: init?.id,
    result: { hostCapabilities: capabilities, hostContext },
  });
  await vi.waitFor(() => expect(host.getState().mode).toBe("mcp"));
  return { ...frame, host };
}

describe("MCP Apps protocol", () => {
  it("initialises with the 2026-01-26 protocol and confirms with initialized", async () => {
    const frame = framedWindow();
    const host = createHost(frame.win);
    const init = frame.request("ui/initialize");
    expect(init?.params).toMatchObject({
      protocolVersion: "2026-01-26",
      appInfo: { name: "Glideworth" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    });
    frame.deliver({
      jsonrpc: "2.0",
      id: init?.id,
      result: {
        hostCapabilities: { message: {} },
        hostContext: { theme: "dark", locale: "en-GB" },
      },
    });
    await vi.waitFor(() => expect(host.getState().ready).toBe(true));
    expect(host.getState()).toMatchObject({
      mode: "mcp",
      context: { theme: "dark", locale: "en-GB" },
    });
    expect(frame.posted.some((m) => m.method === "ui/notifications/initialized")).toBe(true);
    expect(host.canSendMessage()).toBe(true);
  });

  it("puts a tool-result notification into state, where the payload routes", async () => {
    const { host, deliver } = await initialised();
    const listener = vi.fn();
    host.subscribe(listener);
    deliver({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: resultOf(outcomeMonteCarlo),
    });
    expect(listener).toHaveBeenCalled();
    expect(payloadFrom(host.getState().toolResult)?.view).toBe("outcome");
    deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-cancelled", params: {} });
    expect(host.getState().cancelled).toBe(true);
  });

  it("ignores messages from anything but the parent", async () => {
    const { host, deliver } = await initialised();
    deliver(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: resultOf(outcomeMonteCarlo),
      },
      {},
    );
    expect(host.getState().toolResult).toBeNull();
  });

  it("round-trips tools/call", async () => {
    const { host, deliver, request } = await initialised();
    const pending = host.callTool({ name: "explain_year", arguments: { planId: "p", year: 2041 } });
    const sent = request("tools/call");
    expect(sent?.params).toEqual({ name: "explain_year", arguments: { planId: "p", year: 2041 } });
    deliver({ jsonrpc: "2.0", id: sent?.id, result: { content: [{ type: "text", text: "{}" }] } });
    await expect(pending).resolves.toEqual({ content: [{ type: "text", text: "{}" }] });
  });

  it("answers ping and refuses unknown requests", async () => {
    const { deliver, posted } = await initialised();
    deliver({ jsonrpc: "2.0", id: 99, method: "ping", params: {} });
    expect(posted).toContainEqual({ jsonrpc: "2.0", id: 99, result: {} });
    deliver({ jsonrpc: "2.0", id: 100, method: "tools/list", params: {} });
    expect(posted.find((m) => m.id === 100)).toMatchObject({ error: { code: -32601 } });
  });

  it("updates model context only when the host supports it", async () => {
    const without = await initialised();
    void without.host.updateModelContext("note");
    expect(without.request("ui/update-model-context")).toBeUndefined();

    const withIt = await initialised({ updateModelContext: {} });
    const done = withIt.host.updateModelContext("The user applied change set cs_1");
    const sent = withIt.request("ui/update-model-context");
    expect(sent?.params).toEqual({
      content: [{ type: "text", text: "The user applied change set cs_1" }],
    });
    withIt.deliver({ jsonrpc: "2.0", id: sent?.id, result: {} });
    await done;
  });

  it("requests display modes the host offers", async () => {
    const { host, request, deliver } = await initialised(
      {},
      { availableDisplayModes: ["inline", "fullscreen"] },
    );
    expect(host.canRequestDisplayMode("fullscreen")).toBe(true);
    expect(host.canRequestDisplayMode("pip")).toBe(false);
    const done = host.requestDisplayMode("fullscreen");
    const sent = request("ui/request-display-mode");
    expect(sent?.params).toEqual({ mode: "fullscreen" });
    deliver({ jsonrpc: "2.0", id: sent?.id, result: { mode: "fullscreen" } });
    await done;
    expect(host.getState().context.displayMode).toBe("fullscreen");
  });

  it("sends follow-up messages through ui/message", async () => {
    const { host, request, deliver } = await initialised({ message: {} });
    const sent = host.sendMessage("Why could my plan fail?");
    const message = request("ui/message");
    expect(message?.params).toEqual({
      role: "user",
      content: [{ type: "text", text: "Why could my plan fail?" }],
    });
    deliver({ jsonrpc: "2.0", id: message?.id, result: {} });
    await expect(sent).resolves.toBe(true);
  });
});

describe("ChatGPT globals fallback", () => {
  function openaiWindow(openai: OpenAiApi) {
    const target = new EventTarget();
    const win = {
      addEventListener: target.addEventListener.bind(target),
      document,
      innerWidth: 360,
      requestAnimationFrame: () => 0,
      open: vi.fn(),
      openai,
    } as unknown as HostWindow & { parent: unknown };
    (win as { parent: unknown }).parent = win;
    return { win, target };
  }

  it("reads the tool result from toolOutput and toolResponseMetadata", () => {
    const openai: OpenAiApi = {
      toolOutput: { ok: true },
      toolResponseMetadata: { [WIDGET_META_KEY]: outcomeMonteCarlo },
      theme: "dark",
      locale: "fr-FR",
    };
    const host = createHost(openaiWindow(openai).win);
    expect(host.getState().mode).toBe("openai");
    expect(payloadFrom(host.getState().toolResult)?.view).toBe("outcome");
    expect(host.getState().context).toMatchObject({ theme: "dark", locale: "fr-FR" });
  });

  it("picks up later globals from openai:set_globals", () => {
    const openai: OpenAiApi = {};
    const { win, target } = openaiWindow(openai);
    const host = createHost(win);
    expect(host.getState().toolResult).toBeNull();
    openai.toolResponseMetadata = { [WIDGET_META_KEY]: outcomeMonteCarlo };
    target.dispatchEvent(new Event("openai:set_globals"));
    expect(payloadFrom(host.getState().toolResult)?.view).toBe("outcome");
  });

  it("calls tools, sends messages, stores widget state and requests full screen through window.openai", async () => {
    const openai: OpenAiApi = {
      callTool: vi.fn(async () => ({ structuredContent: { ok: 1 } })),
      sendFollowUpMessage: vi.fn(async () => {}),
      setWidgetState: vi.fn(),
      requestDisplayMode: vi.fn(async () => ({ mode: "fullscreen" as const })),
      openExternal: vi.fn(),
    };
    const host = createHost(openaiWindow(openai).win);
    await expect(host.callTool({ name: "get_job", arguments: { jobId: "j" } })).resolves.toEqual({
      structuredContent: { ok: 1 },
    });
    expect(openai.callTool).toHaveBeenCalledWith("get_job", { jobId: "j" });
    expect(host.canSendMessage()).toBe(true);
    await host.sendMessage("hi");
    expect(openai.sendFollowUpMessage).toHaveBeenCalledWith({ prompt: "hi" });
    await host.updateModelContext("applied");
    expect(openai.setWidgetState).toHaveBeenCalledWith({ note: "applied" });
    expect(host.canRequestDisplayMode("fullscreen")).toBe(true);
    await host.requestDisplayMode("fullscreen");
    expect(openai.requestDisplayMode).toHaveBeenCalledWith({ mode: "fullscreen" });
    await host.openLink("https://app.example/plan");
    expect(openai.openExternal).toHaveBeenCalledWith({ href: "https://app.example/plan" });
  });

  it("offers no full screen or messages without a host", () => {
    const host = createHost(openaiWindow({}).win);
    expect(host.canRequestDisplayMode("fullscreen")).toBe(false);
    expect(host.canSendMessage()).toBe(false);
  });
});
