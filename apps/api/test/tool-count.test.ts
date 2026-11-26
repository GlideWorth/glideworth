import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { setup } from "./helpers.js";

it("registers the documented number of tools (docs/MCP.md)", async () => {
  const h = setup();
  const count = async (scopes: ("read" | "simulate" | "write")[], canWrite: boolean) => {
    const server = createMcpServer({ services: h.services, scopes, canWrite });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), c.connect(b)]);
    const t = (await c.listTools()).tools;
    await c.close();
    return { total: t.length, readOnly: t.filter((x) => x.annotations?.readOnlyHint).length };
  };
  expect(await count(["read", "simulate", "write"], true)).toEqual({ total: 71, readOnly: 39 });
  expect((await count(["read", "simulate"], false)).total).toBe(52);
  h.close();
});
