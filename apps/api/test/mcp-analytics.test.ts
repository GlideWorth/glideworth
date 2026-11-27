/**
 * Cloud MCP analytics (`@glideworth/cloud` mcp-analytics.ts) on the real MCP HTTP handler: a tool call reaches
 * PostHog as `$mcp_tool_call` from the `glideworth` server, and no tool argument or result goes with it.
 */
import { gunzipSync } from "node:zlib";
import { createPostHogMcpAnalytics, MCP_CONTENT_PROPERTIES } from "@glideworth/cloud";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../src/auth.js";
import { handleMcpHttp } from "../src/mcp/http.js";
import { type Harness, setup } from "./helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- captured PostHog batches are untyped JSON
type Sent = Record<string, any>;

/** A fake PostHog: records each event of each batch posthog-node sends (gzip or plain JSON). */
function fakePostHog() {
  const events: Sent[] = [];
  const raw: string[] = [];
  const fetch = (async (
    _url: string,
    init: { body?: unknown; headers?: Record<string, string> },
  ) => {
    const b = init.body;
    const bytes =
      typeof b === "string"
        ? Buffer.from(b)
        : b instanceof Blob
          ? Buffer.from(await b.arrayBuffer())
          : Buffer.from(b as Uint8Array);
    const text =
      bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString() : bytes.toString();
    raw.push(text);
    events.push(...((JSON.parse(text) as { batch?: Sent[] }).batch ?? []));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { events, raw, fetch };
}

const principal: Principal = {
  keyId: "key-test",
  name: "test",
  scopes: ["read", "simulate"],
  via: "key",
  userId: "user-test",
  userName: "Test",
  role: "owner",
};

let h: Harness;
beforeAll(() => {
  h = setup({ realEngine: true });
});
afterAll(() => h.close());

describe("MCP analytics", () => {
  it("sends $mcp_tool_call for a read-only tool, without its arguments or result", async () => {
    const ph = fakePostHog();
    const analytics = createPostHogMcpAnalytics({
      token: "phc_testprojecttoken123",
      host: "https://us.i.posthog.com",
      release: "test-build",
      fetch: ph.fetch,
    });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (input, init) =>
        handleMcpHttp(new Request(input, init), {
          services: h.services,
          principal,
          allowWrites: false,
          instrument: (server) => analytics.instrument(server),
        }),
    });
    const client = new Client({ name: "analytics-test", version: "0.0.0" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    // The tool schemas clients see are unchanged: no injected `context`, `llm_model` or `conversation_id`.
    const props = Object.keys(
      (tools.find((t) => t.name === "get_plan")!.inputSchema.properties ?? {}) as object,
    );
    for (const injected of ["context", "llm_model", "conversation_id"])
      expect(props).not.toContain(injected);

    const res = (await client.callTool({
      name: "get_plan",
      arguments: { planId: "plan-main" },
    })) as {
      content: { text: string }[];
    };
    const resultText = res.content[0]!.text;
    // The result itself has no injected text block either.
    expect(res.content).toHaveLength(1);
    await client.close();
    await analytics.shutdown();

    const call = ph.events.find((e) => e.event === "$mcp_tool_call");
    expect(call).toBeDefined();
    expect(call!.properties).toMatchObject({
      $mcp_tool_name: "get_plan",
      $mcp_server_name: "glideworth",
      $mcp_server_build: "test-build",
      $lib: "posthog-node-mcp",
      $geoip_disable: true,
    });
    for (const key of MCP_CONTENT_PROPERTIES)
      for (const e of ph.events) expect(e.properties).not.toHaveProperty(key);
    // Neither the argument value nor any part of the plan reached PostHog.
    const everything = ph.raw.join("\n");
    expect(everything).not.toContain("plan-main");
    const plan = JSON.parse(resultText) as { name?: string };
    expect(resultText.length).toBeGreaterThan(100);
    if (plan.name) expect(everything).not.toContain(plan.name);
    expect(everything).not.toContain(resultText.slice(0, 60));
  });
});
