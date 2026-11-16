/* oxlint-disable typescript/no-explicit-any -- tests probe arbitrary JSON responses */
/** FX rates (multi-currency), debt payoff comparison, strategy matrix, income by tax rate, 72(t) comparison. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { baseConverter, fxRateTo } from "../src/fx.js";
import { createMcpServer } from "../src/mcp/server.js";
import { type Harness, READ_KEY, setup } from "./helpers.js";

let h: Harness;
afterEach(() => h?.close());
const FX = "/api/v1/households/hh-sample/fx-rates";

describe("FX rates", () => {
  it("lists, upserts, replaces and deletes pairs; every change bumps the household version", async () => {
    h = setup();
    expect((await h.call(FX)).json).toEqual({ baseCurrency: "USD", items: [] });
    const v0 = h.services.households.get("hh-sample").version;
    const add = await h.call(FX, {
      method: "POST",
      body: { from: "GBP", to: "USD", rate: 1.27, annualDrift: -0.02 },
    });
    expect(add.status, add.text).toBe(200);
    expect(add.json.version).toBe(v0 + 1);
    expect(add.headers.get("etag")).toBe(`"${v0 + 1}"`);
    await h.call(FX, { method: "POST", body: { from: "GBP", to: "USD", rate: 1.3 } }); // upsert, not duplicate
    await h.call(FX, { method: "POST", body: { from: "EUR", to: "USD", rate: 1.08 } });
    const list = (await h.call(FX)).json.items;
    expect(list).toHaveLength(2);
    expect(list.find((r: any) => r.from === "GBP").rate).toBe(1.3);
    expect((await h.call(`${FX}/gbp-usd`, { method: "DELETE" })).status).toBe(204);
    expect((await h.call(`${FX}/GBP-USD`, { method: "DELETE" })).status).toBe(404);
    const rep = await h.call(FX, {
      method: "PUT",
      body: { items: [{ from: "CAD", to: "USD", rate: 0.73 }] },
    });
    expect(rep.json.items).toHaveLength(1);
    expect((await h.call(FX)).json.items[0].from).toBe("CAD");
    // it is part of the household document (exports, backups)
    expect((await h.call("/api/v1/households/hh-sample")).json.finances.fxRates[0].from).toBe(
      "CAD",
    );
  });

  it("the web editor’s save (current-finances) and the FX routes read and write the same table", async () => {
    h = setup();
    const CF = "/api/v1/households/hh-sample/current-finances";
    const rec = (await h.call("/api/v1/households/hh-sample")).json;
    // 1. The editor saves the whole document with a rate: the FX route lists exactly that.
    const put = await h.call(CF, {
      method: "PUT",
      headers: { "if-match": `"${rec.version}"` },
      body: {
        finances: {
          ...rec.finances,
          fxRates: [{ from: "GBP", to: "USD", rate: 1.25, annualDrift: 0 }],
        },
      },
    });
    expect(put.status, put.text).toBe(200);
    expect((await h.call(FX)).json.items).toEqual([
      { from: "GBP", to: "USD", rate: 1.25, annualDrift: 0 },
    ]);
    // 2. A script upserts the inverse direction: it replaces the pair, it does not add a second one.
    const up = await h.call(FX, { method: "POST", body: { from: "USD", to: "GBP", rate: 0.8 } });
    expect(up.json.version).toBe(put.json.version + 1);
    const after = (await h.call("/api/v1/households/hh-sample")).json;
    expect(after.finances.fxRates).toEqual([{ from: "USD", to: "GBP", rate: 0.8, annualDrift: 0 }]);
    // 3. The editor's next save with its stale version is a conflict (single writer, nothing lost).
    const stale = await h.call(CF, {
      method: "PUT",
      headers: { "if-match": `"${put.json.version}"` },
      body: { finances: rec.finances },
    });
    expect(stale.status).toBe(409);
    // 4. Both paths refuse the same invalid tables.
    const dup = [
      { from: "GBP", to: "USD", rate: 1.25 },
      { from: "USD", to: "GBP", rate: 0.8 },
    ];
    expect((await h.call(FX, { method: "PUT", body: { items: dup } })).status).toBe(400);
    const bad = await h.call(CF, {
      method: "PUT",
      body: { finances: { ...after.finances, fxRates: dup } },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.details.issues[0].path).toEqual(["finances", "fxRates", 1]);
    // 5. Deleting either direction removes the pair; an empty table is stored as absent.
    expect((await h.call(`${FX}/GBP-USD`, { method: "DELETE" })).status).toBe(204);
    expect((await h.call("/api/v1/households/hh-sample")).json.finances.fxRates).toBeUndefined();
    expect((await h.call(FX)).json.items).toEqual([]);
  });

  it("validates pairs, honours If-Match and the scopes", async () => {
    h = setup();
    expect(
      (await h.call(FX, { method: "POST", body: { from: "USD", to: "USD", rate: 1 } })).status,
    ).toBe(400);
    expect(
      (await h.call(FX, { method: "POST", body: { from: "GBP", to: "USD", rate: -1 } })).status,
    ).toBe(400);
    expect(
      (await h.call(FX, { method: "POST", body: { from: "gbp!", to: "USD", rate: 1 } })).status,
    ).toBe(400);
    expect(
      (
        await h.call(FX, {
          method: "PUT",
          body: {
            items: [
              { from: "GBP", to: "USD", rate: 1 },
              { from: "GBP", to: "USD", rate: 2 },
            ],
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.call(FX, {
          method: "POST",
          headers: { "if-match": '"999"' },
          body: { from: "GBP", to: "USD", rate: 1 },
        })
      ).status,
    ).toBe(409);
    expect((await h.call(FX, { key: READ_KEY })).status).toBe(200);
    expect(
      (
        await h.call(FX, {
          method: "POST",
          key: READ_KEY,
          body: { from: "GBP", to: "USD", rate: 1 },
        })
      ).status,
    ).toBe(403);
    expect((await h.call("/api/v1/households/nope/fx-rates")).status).toBe(404);
  });

  it("converts in either direction; net worth snapshots and check-ins use base-currency values", async () => {
    expect(fxRateTo([{ from: "GBP", to: "USD", rate: 1.25, annualDrift: 0 }], "GBP", "USD")).toBe(
      1.25,
    );
    expect(
      fxRateTo([{ from: "USD", to: "GBP", rate: 0.8, annualDrift: 0 }], "GBP", "USD"),
    ).toBeCloseTo(1.25);
    expect(fxRateTo([], "GBP", "USD")).toBeNull();
    const c = baseConverter({ fxRates: [] }, "USD");
    expect(c.convert(100, "GBP")).toBe(100);
    expect([...c.missing]).toEqual(["GBP"]);

    h = setup();
    const before = (
      await h.call("/api/v1/households/hh-sample/snapshots/record", { method: "POST", body: {} })
    ).json.netWorth as number;
    const acct = h.services.households.get("hh-sample").finances.accounts[0]!;
    await h.call(FX, { method: "POST", body: { from: "GBP", to: "USD", rate: 2 } });
    await h.call(`/api/v1/households/hh-sample/accounts/${acct.id}`, {
      method: "PATCH",
      body: { currency: "GBP" },
    });
    const after = (
      await h.call("/api/v1/households/hh-sample/snapshots/record", { method: "POST", body: {} })
    ).json.netWorth as number;
    expect(after).toBeCloseTo(before + acct.balance, 0); // the account counts double
  });
});

describe("analysis tools backed by core", () => {
  it("debt payoff: minimum vs avalanche vs snowball (real engine)", async () => {
    h = setup({ realEngine: true });
    const r = await h.call("/api/v1/plans/plan-main/insights/debt-payoff", {
      method: "POST",
      body: { extraPerMonth: 500 },
    });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.json.strategies.map((s: any) => s.id)).toEqual(["minimum", "avalanche", "snowball"]);
    expect(r.json.best).toMatch(/avalanche|snowball|minimum/);
    expect(
      (await h.call("/api/v1/plans/plan-main/insights/debt-payoff", { method: "POST", body: {} }))
        .status,
    ).toBe(422);
  });

  it("income by tax rate (real engine)", async () => {
    h = setup({ realEngine: true });
    const r = await h.call("/api/v1/plans/plan-main/insights/income-by-tax-rate", {
      method: "POST",
      body: {},
    });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.json.years.length).toBeGreaterThan(5);
    expect(r.json.columns.length).toBeGreaterThan(0);
    expect(r.json.cells).toHaveLength(r.json.years.length);
  });

  it("72(t) comparison from a balance, and from an account of a household", async () => {
    h = setup();
    const r = await h.call("/api/v1/insights/sepp-comparison", {
      method: "POST",
      body: { balance: 800000, startAge: 52 },
    });
    expect(r.status, r.text).toBe(200);
    expect(r.json.rows.map((x: any) => x.method)).toEqual([
      "rmd",
      "fixed-amortization",
      "fixed-annuitization",
    ]);
    expect(
      (
        await h.call("/api/v1/insights/sepp-comparison", {
          method: "POST",
          body: { balance: 800000 },
        })
      ).status,
    ).toBe(400);
    const acct = h.services.households
      .get("hh-sample")
      .finances.accounts.find((a) => a.type === "401k" || a.owner !== "joint");
    if (acct) {
      const d = await h.call("/api/v1/insights/sepp-comparison", {
        method: "POST",
        body: { householdId: "hh-sample", accountId: acct.id },
      });
      expect([200, 422]).toContain(d.status);
    }
    expect(
      (
        await h.call("/api/v1/insights/sepp-comparison", {
          method: "POST",
          key: READ_KEY,
          body: { balance: 1, startAge: 50 },
        })
      ).status,
    ).toBe(200);
  });

  it("strategy matrix is a job (real engine, no Monte Carlo column)", async () => {
    h = setup({ realEngine: true });
    const r = await h.call("/api/v1/plans/plan-main/insights/strategy-matrix?wait=60", {
      method: "POST",
      body: { successRate: false },
    });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const m = (await h.call(`/api/v1/jobs/${r.json.id}/result`)).json;
    expect(m.columns.map((c: any) => c.id)).toContain("lifetimeTaxesReal");
    expect(m.rows.length).toBeGreaterThan(1);
  }, 60_000);

  it("MCP exposes them: FX, debt payoff, income by tax rate, SEPP, strategy matrix", async () => {
    h = setup({ realEngine: true, mcpAllowWrites: true });
    const server = createMcpServer({
      services: h.services,
      scopes: ["read", "simulate", "write"],
      canWrite: true,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), c.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await c.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      return { isError: !!r.isError, json: JSON.parse(r.content[0]!.text) };
    };
    expect((await call("set_fx_rate", { from: "gbp", to: "usd", rate: 1.3 })).isError).toBe(false);
    expect((await call("list_fx_rates")).json.items[0]).toMatchObject({
      from: "GBP",
      to: "USD",
      rate: 1.3,
    });
    expect((await call("unset_fx_rate", { from: "GBP", to: "USD" })).isError).toBe(false);
    expect(
      (await call("compare_debt_payoff", { extraPerMonth: 400 })).json.strategies,
    ).toHaveLength(3);
    expect((await call("income_by_tax_rate", {})).json.years.length).toBeGreaterThan(1);
    expect(
      (await call("compare_sepp_methods", { balance: 500000, startAge: 50 })).json.rows,
    ).toHaveLength(3);
    const sm = await call("strategy_matrix", { successRate: false });
    expect(sm.isError).toBe(false);
    expect(sm.json.rows.length).toBeGreaterThan(1);
    await c.close();
  }, 90_000);
});

const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20260131<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>123456789<ACCTID>0011223344<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260101<DTEND>20260131
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105<TRNAMT>-52.30<FITID>1<NAME>GROCERY STORE</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260110<TRNAMT>-1200.00<FITID>2<NAME>RENT PAYMENT</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260115<TRNAMT>3000.00<FITID>3<NAME>PAYROLL</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>5432.10<DTASOF>20260131</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
`;
const QIF =
  "!Account\nNJoint Checking\nTBank\n^\n!Type:Bank\nD01/05/2026\nT-52.30\nPGrocery Store\n^\nD01/10/2026\nT-1200.00\nPRent\n^\n";

describe("OFX / QIF import", () => {
  const URL = "/api/v1/households/hh-sample/import/bank-file";

  it("previews by default and never exposes full account numbers", async () => {
    h = setup();
    const before = h.services.households.get("hh-sample").version;
    const r = await h.call(URL, { method: "POST", body: { text: OFX } });
    expect(r.status, r.text.slice(0, 400)).toBe(200);
    expect(r.json).toMatchObject({ format: "ofx", dryRun: true, applied: false });
    expect(r.json.accounts).toHaveLength(1);
    expect(r.text).not.toContain("0011223344");
    expect(h.services.households.get("hh-sample").version).toBe(before);
  });

  it("applies balances (creating the account) and expense events atomically", async () => {
    h = setup();
    const n = h.services.households.get("hh-sample").finances.accounts.length;
    const r = await h.call(URL, {
      method: "POST",
      body: { text: OFX, dryRun: false, planId: "plan-main", balances: { createMissing: true } },
    });
    expect(r.status, r.text.slice(0, 400)).toBe(200);
    expect(r.json.applied).toBe(true);
    expect(h.services.households.get("hh-sample").finances.accounts.length).toBe(n + 1);
    expect(h.services.plans.get("plan-main").version).toBeGreaterThan(1);
  });

  it("W4-1: applies a day-first QIF with the dates read day-first (DMY and DD/MM/YYYY), end to end", async () => {
    // 3 Feb and 4 Feb 2026 written day-first: ambiguous, so detection alone reads them month-first.
    const dayFirst =
      "!Account\nNHousehold Current\nTBank\n^\n!Type:Bank\nD03/02/2026\nT-40.00\nPGrocer\nLGroceries\n^\nD04/02/2026\nT-60.00\nPGrocer\nLGroceries\n^\n";
    for (const dateFormat of ["DMY", "DD/MM/YYYY"] as const) {
      h = setup();
      const before = h.services.plans.get("plan-main").expenses.length;
      const r = await h.call(URL, {
        method: "POST",
        body: {
          text: dayFirst,
          format: "qif",
          dateFormat,
          planId: "plan-main",
          balances: false,
          dryRun: false,
        },
      });
      expect(r.status, r.text.slice(0, 400)).toBe(200);
      expect(r.json.applied).toBe(true);
      expect(r.json.summary.range).toEqual({ from: "2026-02-03", to: "2026-02-04" });
      expect(h.services.plans.get("plan-main").expenses.length).toBe(before + 1);
      h.close();
    }
    h = setup();
    const auto = await h.call(URL, { method: "POST", body: { text: dayFirst, format: "qif" } });
    expect(auto.json.summary.range).toEqual({ from: "2026-03-02", to: "2026-04-02" });
    const mdy = await h.call(URL, {
      method: "POST",
      body: { text: dayFirst, format: "qif", dateFormat: "MDY" },
    });
    expect(mdy.json.summary.range).toEqual({ from: "2026-03-02", to: "2026-04-02" });
  });

  it("W4-1: annualise takes the importer modes (and the legacy boolean)", async () => {
    h = setup();
    const call = (annualise: unknown) =>
      h.call(URL, {
        method: "POST",
        body: { text: QIF, format: "qif", planId: "plan-main", annualise },
      });
    const last12 = await call("last-12-months");
    const all = await call("all");
    const legacyTrue = await call(true);
    const legacyFalse = await call(false);
    for (const r of [last12, all, legacyTrue, legacyFalse])
      expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(legacyTrue.json.summary.totalAnnual).toBe(all.json.summary.totalAnnual);
    expect(legacyFalse.json.summary.totalAnnual).toBe(last12.json.summary.totalAnnual);
    expect((await call("sometimes")).status).toBe(400);
  });

  it("reads QIF, refuses non-bank files and honours write scope", async () => {
    h = setup();
    const q = await h.call(URL, { method: "POST", body: { text: QIF, format: "qif" } });
    expect(q.status, q.text.slice(0, 300)).toBe(200);
    expect(q.json.format).toBe("qif");
    const bad = await h.call(URL, {
      method: "POST",
      body: { text: "a,b,c\n1,2,3", dryRun: false },
    });
    expect(bad.status).toBe(422);
    expect((await h.call(URL, { method: "POST", key: READ_KEY, body: { text: OFX } })).status).toBe(
      403,
    );
    expect(
      (
        await h.call("/api/v1/households/nope/import/bank-file", {
          method: "POST",
          body: { text: OFX },
        })
      ).status,
    ).toBe(404);
  });

  it("security review 4: accepts 2 MB of text and refuses more before parsing it", async () => {
    h = setup();
    const atLimit = QIF + "\n".repeat(2_000_000 - QIF.length);
    const ok = await h.call(URL, { method: "POST", body: { text: atLimit, format: "qif" } });
    expect(ok.status, ok.text.slice(0, 300)).toBe(200);
    const over = await h.call(URL, { method: "POST", body: { text: `${atLimit}\n` } });
    expect(over.status).toBe(400);
    expect(over.json.error.code).toBe("VALIDATION");
    expect(over.json.error.message).toContain("larger than the 2 MB limit");
    // A caller that skips the request schema is refused by the service itself.
    expect(() =>
      h.services.imports.importBankFile(
        "hh-sample",
        { text: `${atLimit}\n`, format: "auto", dryRun: true },
        { type: "user", id: "test" } as never,
      ),
    ).toThrow(expect.objectContaining({ status: 413, code: "PAYLOAD_TOO_LARGE" }));
    // The other imports keep the larger limit.
    const csv = await h.call("/api/v1/households/hh-sample/import/csv/analyze", {
      method: "POST",
      body: { text: `Account,Balance\n${"Savings,1\n".repeat(250_000)}`, kind: "account-balances" },
    });
    expect(csv.status, csv.text.slice(0, 300)).toBe(200);
  });

  it("security review 4: a crafted file at the size limit is answered, not a stack overflow", async () => {
    h = setup();
    // 285,000 opening tags nested in each other, then closing tags that match none of them.
    const nested = `<OFX>${"<A>".repeat(285_000)}${"</B>".repeat(285_000)}`;
    const unclosed = `<OFX>${"<A".repeat(999_000)}`;
    for (const text of [nested, unclosed]) {
      const r = await h.call(URL, { method: "POST", body: { text } });
      expect(r.status, r.text.slice(0, 300)).toBe(200);
      expect(r.json).toMatchObject({ format: "ofx", dryRun: true, accounts: [] });
    }
  });
});
