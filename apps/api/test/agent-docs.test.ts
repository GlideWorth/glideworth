/**
 * The agent skill (skills/glideworth/SKILL.md) and the agent setup guide (docs/agents/SETUP.md) name MCP
 * tools. An agent that follows them calls those names, so every one must exist in the registry, and the
 * skill must cover the tools the server instructions point agents at.
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpServer, SERVER_INSTRUCTIONS } from "../src/mcp/server.js";
import { setup } from "./helpers.js";

const repo = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repo), "utf8");

/** `snake_case` words in backticks: how both documents write tool names. */
function backtickedSnakeCase(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(/`([a-z]+(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]!))];
}

let tools = new Set<string>();
let prompts = new Set<string>();

beforeAll(async () => {
  const h = setup();
  const server = createMcpServer({
    services: h.services,
    scopes: ["read", "simulate", "write"],
    canWrite: true,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent-docs", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  tools = new Set((await client.listTools()).tools.map((t) => t.name));
  prompts = new Set((await client.listPrompts()).prompts.map((p) => p.name));
  await client.close();
  h.close();
});

afterAll(() => {
  tools.clear();
  prompts.clear();
});

describe("agent skill and setup guide", () => {
  const skill = read("skills/glideworth/SKILL.md");
  const guide = read("docs/agents/SETUP.md");

  it.each([
    ["skills/glideworth/SKILL.md", skill],
    ["docs/agents/SETUP.md", guide],
  ])("%s names only tools and prompts the MCP server registers", (_name, text) => {
    const names = backtickedSnakeCase(text);
    expect(names.length).toBeGreaterThan(0);
    const unknown = names.filter((n) => !tools.has(n) && !prompts.has(n));
    expect(unknown).toEqual([]);
  });

  it("starts the skill at the same tool as the server instructions", () => {
    expect(SERVER_INSTRUCTIONS).toContain("START: get_plan_summary");
    expect(skill).toContain("Call `get_plan_summary` first");
  });

  it("covers every tool the server instructions name", () => {
    const named = [...SERVER_INSTRUCTIONS.matchAll(/\b[a-z]+(?:_[a-z0-9]+)+\b/g)]
      .map((m) => m[0])
      .filter((n) => tools.has(n));
    expect(named.length).toBeGreaterThan(10);
    const missing = [...new Set(named)].filter((n) => !skill.includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });

  it("has the frontmatter a skill loader expects", () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    expect(front).toMatch(/^name: glideworth$/m);
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it("verifies the guide with the start tool and keeps the passphrase with the human", () => {
    expect(guide).toContain("`get_plan_summary`");
    expect(guide).toMatch(/only the human chooses the passphrase/i);
  });
});
