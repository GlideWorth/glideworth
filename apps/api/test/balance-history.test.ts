/** Balance-history import: REST (rows and text, dry run, apply, idempotency, errors) and the MCP pair. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { nowIso } from "../src/util.js";
import { type Harness, READ_KEY, setup } from "./helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- response bodies are probed freely
type Json = any;
let h: Harness;
beforeEach(() => {
  h = setup({ importRunner: "inline" });
});
afterEach(() => h.close());
const HH = "/api/v1/households/hh-sample";
const URL_ = `${HH}/snapshots/history`;
const TODAY = nowIso().slice(0, 10);

const post = async (body: unknown, key?: string) =>
  h.call(URL_, { method: "POST", body, ...(key ? { key } : {}) }) as Promise<{
    status: number;
    json: Json;
  }>;
const snapshots = async (): Promise<Json[]> =>
  ((await h.call(`${HH}/snapshots?limit=200`)).json as Json).items;

const ROWS = [
  { date: "2024-01-31", values: { "account:acc-cash": 1000, "debt:debt-car": 9000 } },
  { date: "2024-02-29", values: { "account:acc-cash": 1100, "debt:debt-car": null } },
];

describe("POST /snapshots/history", () => {
  it("previews without writing, then applies, and a repeat changes nothing", async () => {
    const before = await snapshots();
    const dry = await post({ rows: ROWS });
    expect(dry.status).toBe(200);
    expect(dry.json).toMatchObject({
      dryRun: true,
      applied: false,
      blocked: false,
      mode: "merge",
      range: { from: "2024-01-31", to: "2024-02-29" },
      counts: { added: 3, updated: 0, removed: 0, snapshotsCreated: 2 },
    });
    expect(dry.json.changes[0]).toMatchObject({
      date: "2024-01-31",
      key: "account:acc-cash",
      label: "High-yield savings",
      kind: "added",
    });
    expect(await snapshots()).toEqual(before);

    const applied = await post({ rows: ROWS, dryRun: false });
    expect(applied.json).toMatchObject({ applied: true, counts: { added: 3 } });
    const after = await snapshots();
    const jan = after.find((s) => s.date === "2024-01-31");
    expect(jan).toMatchObject({
      source: "import",
      assets: 1000,
      liabilities: 9000,
      netWorth: -8000,
      accounts: [{ accountId: "acc-cash", balance: 1000 }],
      debts: [{ debtId: "debt-car", balance: 9000 }],
    });

    const again = await post({ rows: ROWS, dryRun: false });
    expect(again.json.counts).toMatchObject({
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 3,
      snapshotsCreated: 0,
      snapshotsUpdated: 0,
    });
    expect(await snapshots()).toEqual(after);
  });

  it("replace clears what the import does not have; merge keeps it", async () => {
    await post({ rows: ROWS, dryRun: false });
    const rows = [
      { date: "2024-01-31", values: { "account:acc-cash": null } },
      { date: "2024-02-29", values: { "account:acc-cash": 1100 } },
    ];
    const merge = await post({ rows });
    expect(merge.json.counts).toMatchObject({ removed: 0, unchanged: 1 });
    const replace = await post({ rows, mode: "replace", dryRun: false });
    expect(replace.json.counts).toMatchObject({ removed: 1, snapshotsUpdated: 1 });
    const jan = (await snapshots()).find((s) => s.date === "2024-01-31");
    expect(jan.accounts).toEqual([]);
    expect(jan).toMatchObject({ assets: 0, liabilities: 9000, netWorth: -9000 });
  });

  it("reads text: matches columns, reports how, and flags cells by reference", async () => {
    const text = [
      "Date\tHigh-yield savings\tJoint brokerage balance\tMystery",
      "Jan 2024\t$1,000.00\t#N/A\t5",
      "Feb 2024\t1,100\t2,000\t6",
    ].join("\n");
    const blocked = await post({ text });
    expect(blocked.json.blocked).toBe(true);
    expect(blocked.json.parse).toMatchObject({
      layout: "rows",
      delimiter: "\t",
      columns: [
        { header: "High-yield savings", key: "account:acc-cash", confidence: 1 },
        { header: "Joint brokerage balance", key: "account:acc-brokerage" },
        { header: "Mystery", key: null },
      ],
      counts: { dates: 2, values: 3, errors: 1 },
    });
    expect(blocked.json.issues.map((i: Json) => i.code)).toEqual(
      expect.arrayContaining(["history.cells.invalid", "history.value.invalid"]),
    );
    expect(blocked.json.issues.find((i: Json) => i.code === "history.value.invalid").ref).toBe(
      "C2",
    );
    const fail = await post({ text, dryRun: false });
    expect(fail.status).toBe(422);
    expect(fail.json.error.code).toBe("IMPORT_FAILED");
    // Nothing from the file or the database comes back in the error beyond references and keys.
    expect(JSON.stringify(fail.json)).not.toMatch(/1,?000|1,?100|2,?000|#N\/A/);

    const ok = await post({ text, skipInvalid: true, dryRun: false });
    expect(ok.json).toMatchObject({ applied: true, counts: { added: 3 } });
    const jan = (await snapshots()).find((s) => s.date === "2024-01-31");
    expect(jan.accounts).toEqual([{ accountId: "acc-cash", balance: 1000 }]);
  });

  it("refuses to guess ambiguous dates and takes an explicit format", async () => {
    const text = "Date,High-yield savings\n01/02/2024,1\n01/03/2024,2\n01/04/2024,3\n";
    const r = await post({ text });
    expect(r.json.blocked).toBe(true);
    expect(r.json.parse).toMatchObject({ dateFormatAmbiguous: true, dateFormatSuggestion: "DMY" });
    expect(r.json.issues[0].code).toBe("history.date.ambiguous");
    const us = await post({ text, options: { dateFormat: "MDY" } });
    expect(us.json.range).toEqual({ from: "2024-01-02", to: "2024-01-04" });
  });

  it("updates current balances from today's values only when asked", async () => {
    const rows = [{ date: TODAY, values: { "account:acc-hsa": 4321 } }];
    await post({ rows, dryRun: false });
    const acc = async () =>
      ((await h.call(`${HH}/accounts/acc-hsa`)).json as Json).balance as number;
    expect(await acc()).not.toBe(4321);
    const r = await post({ rows, dryRun: false, updateCurrentBalances: true });
    expect(r.json.currentBalances).toEqual({ accounts: 1, realAssets: 0, debts: 0 });
    expect(await acc()).toBe(4321);
  });

  it("validates input and permissions", async () => {
    expect((await post({ rows: ROWS, text: "x" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(
      (await post({ rows: [{ date: "2024-01-31", values: { "account:__proto__": 1 } }] })).json
        .issues[0].code,
    ).toBe("history.key.unknown");
    expect(
      (await post({ rows: [{ date: "2024-01-31", values: { "savings:x": 1 } }] })).status,
    ).toBe(400);
    const neg = await post({
      rows: [{ date: "2024-01-31", values: { "debt:debt-car": -5 } }],
      dryRun: false,
    });
    expect(neg.status).toBe(422);
    expect(neg.json.error.details.issues[0]).toMatchObject({
      code: "history.value.negative",
      key: "debt:debt-car",
    });
    expect((await post({ rows: ROWS, today: "2001-01-01" })).status).toBe(400);
    expect((await post({ rows: ROWS }, READ_KEY)).status).toBe(403);
  });
});

describe("MCP balance-history tools", () => {
  async function client(canWrite: boolean) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      services: h.services,
      scopes: canWrite ? ["read", "simulate", "write"] : ["read", "simulate"],
      canWrite,
      actor: { kind: "mcp", label: "test" },
    });
    await server.connect(b);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(a);
    return c;
  }
  const callTool = async (c: Client, name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { isError: r.isError ?? false, json: JSON.parse(r.content[0]!.text) as Json };
  };

  it("previews, then applies, a pasted sheet", async () => {
    const c = await client(true);
    const text = "Date,High-yield savings,Car loan\n2024-01-31,1000,-9000\n";
    const p = await callTool(c, "preview_balance_history_import", { text });
    expect(p.isError).toBe(false);
    expect(p.json).toMatchObject({ applied: false, counts: { added: 2 } });
    expect(p.json.changes).toContainEqual(
      expect.objectContaining({ field: "Car loan", key: "debt:debt-car", after: 9000 }),
    );
    expect((await snapshots()).some((s) => s.date === "2024-01-31")).toBe(false);
    const a = await callTool(c, "apply_balance_history_import", { text });
    expect(a.json).toMatchObject({ applied: true, counts: { added: 2 } });
    expect((await snapshots()).some((s) => s.date === "2024-01-31")).toBe(true);
    const again = await callTool(c, "apply_balance_history_import", { text });
    expect(again.json.counts).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
    await c.close();
  });

  it("offers only the preview without write access", async () => {
    const c = await client(false);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("preview_balance_history_import");
    expect(names).not.toContain("apply_balance_history_import");
    await c.close();
  });
});
