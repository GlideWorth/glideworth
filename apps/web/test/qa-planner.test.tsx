/**
 * Regression tests for the planner QA pass (docs/launch/qa-planner.md).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { createApiClient } from "../src/lib/api";

// The server's answer for a plan that has never had a check-in (captured from a local server on a
// fresh database). `householdChanged` is null: there is nothing yet to compare the household with.
const NEVER_CHECKED_IN = {
  planId: "plan-main",
  planName: "Main plan",
  since: null,
  lastCheckIn: null,
  current: {
    id: "now",
    planId: "plan-main",
    planName: "Main plan",
    takenAt: "2026-11-16T19:01:37.451Z",
    trigger: "api",
    planVersion: 1,
    householdVersion: 1,
    successRate: null,
    fiYear: 2041,
    actualNetWorth: 794100,
    plannedNetWorth: 794100,
    netWorthVsPlan: { delta: 0, ratio: 0 },
    endNetWorthReal: 645897,
    depletionYear: null,
    milestones: [{ id: "ms-retire", name: "Retirement", status: "reached", month: "2041-03" }],
    findings: [],
    currency: "USD",
  },
  planVersionNow: 1,
  planVersionAtCheckIn: null,
  householdChanged: null,
  netWorth: null,
  edits: [
    {
      version: 1,
      createdAt: "2026-11-16T19:01:17.347Z",
      actor: { kind: "system", label: "ProjectionLab import" },
      message: "imported",
    },
  ],
  changes: [],
  notifications: [],
  note: "This plan has no check-in yet. Check in to record where you stand today and track changes from here.",
};

const jsonFetch = (body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

const client = createApiClient({ fetch: jsonFetch(NEVER_CHECKED_IN) });

vi.mock("../src/lib/workspace", async (orig) => ({
  ...(await orig<typeof import("../src/lib/workspace")>()),
  useWorkspace: () => ({ data: { source: "api" } }),
}));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: unknown }) => createElement("a", null, children as never),
}));
vi.mock("../src/lib/access", () => ({ useAccess: () => ({ canWrite: true, loading: false }) }));
vi.mock("../src/lib/api", async (orig) => {
  const real = await orig<typeof import("../src/lib/api")>();
  return {
    ...real,
    api: {
      ...real.api,
      changesSinceCheckin: (id: string) => client.changesSinceCheckin(id),
    },
  };
});

describe("check-in card on a plan that has never had a check-in", () => {
  it("the client accepts the server's answer (householdChanged is null)", async () => {
    await expect(client.changesSinceCheckin("plan-main")).resolves.toMatchObject({
      lastCheckIn: null,
      householdChanged: null,
    });
  });

  it("shows the first check-in prompt, not 'Could not load the last check-in.'", async () => {
    const { ChangesSinceCheckInCard } = await import("../src/features/checkins/checkins");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          TooltipProvider,
          null,
          createElement(ChangesSinceCheckInCard, { planId: "plan-main" }),
        ),
      ),
    );
    expect(await screen.findByText(/run the first one now/)).toBeTruthy();
    expect(screen.queryByText("Could not load the last check-in.")).toBeNull();
  });
});

describe("bank file over the 2 MB limit", () => {
  it("is refused when chosen, with a plain message, before any preview or upload", async () => {
    const { BankFileImport } = await import("../src/features/import/bank-import");
    const qc = new QueryClient();
    const { container } = render(
      createElement(QueryClientProvider, { client: qc }, createElement(BankFileImport)),
    );
    expect(screen.getByText(/Up to 2 MB/)).toBeTruthy();
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    const big = new File(["x".repeat(2_000_001)], "statement.ofx", { type: "application/x-ofx" });
    fireEvent.change(input, { target: { files: [big] } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Bank files can be up to 2 MB/);
    // Still on the chooser: the review workbench did not open.
    expect(screen.queryByText(/Found in the file/i)).toBeNull();
  });

  it("uses the same limit as the server", async () => {
    const { BANK_FILE_LIMIT } = await import("../src/features/import/bank-import");
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../../api/src/services/imports.ts"), "utf8");
    const m = /MAX_BANK_FILE_CHARS = ([\d_]+);/.exec(src);
    expect(Number(m![1]!.replaceAll("_", ""))).toBe(BANK_FILE_LIMIT.chars);
  });
});

describe("bank file review notes", () => {
  it("are in plain words: no request field names, no '(s)' plurals", async () => {
    const { importBankFileInto } = await import("@glideworth/importers");
    const { createUkSampleDocument } = await import("@glideworth/core/samples");
    const { bankIssueText } = await import("../src/features/import/bank-import");
    const ofx = [
      "OFXHEADER:100",
      "DATA:OFXSGML",
      "",
      "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>GBP",
      "<BANKACCTFROM><BANKID>1<ACCTID>99995678<ACCTTYPE>CHECKING</BANKACCTFROM>",
      "<BANKTRANLIST>",
      "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261003<TRNAMT>-84.20<FITID>2<NAME>Groceries</STMTTRN>",
      "</BANKTRANLIST><LEDGERBAL><BALAMT>5115.80<DTASOF>20261031</LEDGERBAL>",
      "</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
    ].join("\n");
    const doc = createUkSampleDocument();
    const o = importBankFileInto(
      doc,
      ofx,
      { balances: { createMissing: false }, transactionsToPlanId: doc.plans[0]!.id },
      { dryRun: true },
    );
    const texts = o.issues.map(bankIssueText);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      expect(t).not.toMatch(/accountMap|createMissing|dateFormat|\(s\)/);
    }
    const qif = importBankFileInto(
      doc,
      "!Type:Bank\nD10/03/2026\nT-84.20\nPGroceries\n^\n",
      {
        balances: false,
        transactionsToPlanId: doc.plans[0]!.id,
      },
      { dryRun: true },
    );
    expect(qif.issues.some((i) => i.code === "qif.date-order")).toBe(true);
    for (const t of qif.issues.map(bankIssueText)) expect(t).not.toMatch(/dateFormat|\(s\)/);
  });
});

describe("Select with grouped options", () => {
  it("renders (and opens) without crashing the page", async () => {
    // jsdom lacks the pointer-capture and scrolling methods Radix calls when a select opens.
    const proto = Element.prototype as unknown as Record<string, unknown>;
    proto.hasPointerCapture ??= () => false;
    proto.releasePointerCapture ??= () => {};
    proto.scrollIntoView ??= () => {};
    const { Select, groupRuns } = await import("../src/components/ui/select");
    const options = [
      { value: "a", label: "A", group: "Common layouts" },
      { value: "b", label: "B", group: "Common layouts" },
      { value: "c", label: "C", group: "App exports" },
      { value: "d", label: "D" },
    ];
    expect(groupRuns(options).map((r) => [r.group, r.options.length])).toEqual([
      ["Common layouts", 2],
      ["App exports", 1],
      [undefined, 1],
    ]);
    render(
      createElement(Select<string>, {
        value: "c",
        onValueChange: () => {},
        options,
        "aria-label": "Layout",
      }),
    );
    const trigger = screen.getByRole("combobox", { name: "Layout" });
    expect(trigger.textContent).toContain("C");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findByText("App exports")).toBeTruthy();
  });
});

describe("hourly wage in the plan editor", () => {
  it("shows the rate per hour and the same yearly figure the engine pays, whatever 'How often' holds", async () => {
    const { annual } = await import("../src/features/plan-editor/sections/events");
    const { amountUnit } = await import("../src/features/plan-editor/state/labels");
    const { buildSimulationInput, simulate } = await import("@glideworth/core");
    const { createUkSampleDocument } = await import("@glideworth/core/samples");
    const doc = createUkSampleDocument();
    const plan = doc.plans[0]!;
    const hourly = {
      id: "inc-hourly",
      name: "Weekend job",
      type: "hourly",
      owner: doc.household.people[0]!.id,
      enabled: true,
      amount: { value: 20, basis: "real" },
      frequency: "monthly", // ignored by the engine for hourly pay
      hoursPerWeek: 37.5,
      range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
    } as never;
    expect(amountUnit(hourly)).toBe("/hr");
    expect(annual(hourly)).toBe(20 * 37.5 * 52);
    // The engine's figure for a full year, with every other income switched off.
    const input = buildSimulationInput(
      {
        ...doc,
        plans: [
          {
            ...plan,
            income: [hourly],
            flows: [],
            assumptions: { ...plan.assumptions, inflation: { kind: "fixed", rate: 0 } },
          },
        ],
      } as never,
      plan.id,
      { trace: "off" },
    );
    const r = simulate(input);
    const full = r.periods.find((p) => p.months === 12)!;
    const paid = (full.totals as unknown as { income: number }).income;
    expect(paid).toBeCloseTo(annual(hourly)!, -2);
  });
});

describe("Taxes: income by tax rate", () => {
  it("shows nothing banded for a flat-rate plan instead of putting all income in the 0% row", async () => {
    const { bandView } = await import("../src/features/taxes/income-by-rate");
    const { buildSimulationInput, incomeByTaxRateForInput } = await import("@glideworth/core");
    const { createUkSampleDocument } = await import("@glideworth/core/samples");
    const doc = createUkSampleDocument();
    const plan = doc.plans[0]!;
    const banded = incomeByTaxRateForInput(buildSimulationInput(doc, plan.id, { trace: "off" }));
    expect(bandView(banded, "10")?.keep.length).toBeGreaterThan(1);
    const flatDoc = {
      ...doc,
      plans: [{ ...plan, tax: { ...plan.tax, mode: "flat" as const } }],
    };
    const flat = incomeByTaxRateForInput(buildSimulationInput(flatDoc, plan.id, { trace: "off" }));
    expect(flat.jurisdictionId).toBe("");
    expect(bandView(flat, "10")).toBeNull();
  });
});

describe("dashboard chance of success", () => {
  it("falls back to the last check-in on the same plan version, never a stale one", async () => {
    const { checkInChance } = await import("../src/features/dashboard/dashboard-view");
    expect(checkInChance({ planVersion: 3, successRate: 0.07 }, 3)).toBe(0.07);
    expect(checkInChance({ planVersion: 2, successRate: 0.07 }, 3)).toBeNull();
    expect(checkInChance(null, 3)).toBeNull();
    expect(checkInChance({ planVersion: 3, successRate: null }, 3)).toBeNull();
  });
});

describe("report chart legend", () => {
  it("reserves a row for every line the legend wraps to at the chart's width", async () => {
    const { legendTop } = await import("../src/features/results/projection-chart");
    const names = [
      "Day Job",
      "QA weekend job",
      "Rental Flat rent",
      "Partner Job",
      "Bonus Windfall",
      "Rental Flat sale",
      "Day Job pension",
      "State Pension",
      "Partner State Pension",
      "Gold Coins sale",
      "Portfolio withdrawals",
      "Housing",
      "Debt",
      "Living",
      "Travel",
      "Dependent support",
      "Other",
      "Taxes",
      "Net cash flow",
    ];
    // Half of the report's 960px column: the legend wraps to five lines, as it does on screen.
    const half = legendTop(names, 445);
    expect(half).toBeGreaterThanOrEqual(5 * 24);
    // Wider charts need less room, and one short row needs one row.
    expect(legendTop(names, 900)).toBeLessThan(half);
    expect(legendTop(["Cash", "Net worth"], 445)).toBeLessThanOrEqual(40);
    // The old estimate (one row per seven items) left the last rows over the plot.
    expect(30 + 18 * Math.floor(names.length / 7)).toBeLessThan(half);
  });
});
