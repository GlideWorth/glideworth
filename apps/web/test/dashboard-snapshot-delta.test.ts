import { Debt, type GlideworthDocument } from "@glideworth/core";
import { createSampleDocument, createUkSampleDocument } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import {
  currentNetWorth,
  snapshotNetWorthLikeToday,
} from "../src/features/dashboard/dashboard-view";

/** A snapshot recorded the old way: every balance added in at face value, including foreign currency. */
function faceValueSnapshot(doc: GlideworthDocument) {
  const accounts = doc.finances.accounts.map((a) => ({ accountId: a.id, balance: a.balance }));
  const realAssets = doc.finances.realAssets.map((r) => ({
    assetId: r.id,
    value: r.currentValue,
    loanBalance: r.loan?.balance ?? 0,
  }));
  const debts = doc.finances.debts.map((d) => ({ debtId: d.id, balance: d.balance }));
  const netWorth =
    accounts.reduce((s, a) => s + a.balance, 0) +
    realAssets.reduce((s, r) => s + r.value - r.loanBalance, 0) -
    debts.reduce((s, d) => s + d.balance, 0);
  return { netWorth, accounts, realAssets, debts };
}

function withUsdCash(doc: GlideworthDocument, balance = 12_000): GlideworthDocument {
  const cash = doc.finances.accounts[0]!;
  doc.finances.accounts.push({
    ...cash,
    id: "usd-cash",
    name: "Current account",
    balance,
    currency: "USD",
  });
  return doc;
}

describe("dashboard snapshot delta", () => {
  it("does not report an excluded foreign balance as a loss since the last snapshot", () => {
    const doc = withUsdCash(createUkSampleDocument());
    const snapshot = faceValueSnapshot(doc);
    const today = currentNetWorth(doc).netWorth;

    // The stored total still counts US$12,000 as £12,000. Today's total leaves it out.
    expect(snapshot.netWorth - today).toBe(12_000);
    expect(snapshotNetWorthLikeToday(doc, snapshot)).toBe(today);
    expect(today - snapshotNetWorthLikeToday(doc, snapshot)).toBe(0);
  });

  it("still reports a real change in accounts that count on both sides", () => {
    const doc = withUsdCash(createUkSampleDocument());
    const snapshot = faceValueSnapshot(doc);
    doc.finances.accounts.find((a) => a.id === "uk-cash")!.balance += 5_000;

    expect(currentNetWorth(doc).netWorth - snapshotNetWorthLikeToday(doc, snapshot)).toBe(5_000);
  });

  it("does not turn an excluded foreign debt into a gain", () => {
    const doc = withUsdCash(createUkSampleDocument());
    doc.finances.debts.push(
      Debt.parse({
        id: "usd-card",
        name: "USD card",
        type: "credit-card",
        owner: doc.household.people[0]!.id,
        balance: 3_000,
        currency: "USD",
        interest: { apr: 0.2 },
        monthlyPayment: { value: 50, basis: "nominal" },
      }),
    );
    const snapshot = faceValueSnapshot(doc);
    const today = currentNetWorth(doc).netWorth;

    // Stored total: +£12,000 cash and −£3,000 debt, both at face value. Today leaves both out.
    expect(snapshot.netWorth - today).toBe(9_000);
    expect(today - snapshotNetWorthLikeToday(doc, snapshot)).toBe(0);
  });

  it("converts a snapshot balance at today's rate, the same way as net worth today", () => {
    const doc = withUsdCash(createUkSampleDocument());
    doc.finances.fxRates = [{ from: "USD", to: "GBP", rate: 0.8, annualDrift: 0 }];
    const snapshot = faceValueSnapshot(doc);

    expect(snapshot.netWorth - currentNetWorth(doc).netWorth).toBeCloseTo(12_000 * 0.2);
    expect(snapshotNetWorthLikeToday(doc, snapshot)).toBeCloseTo(currentNetWorth(doc).netWorth);
  });

  it("keeps a snapshot that only recorded a total", () => {
    const doc = withUsdCash(createUkSampleDocument());
    const totalOnly = { netWorth: 111_900, accounts: [], realAssets: [], debts: [] };
    expect(snapshotNetWorthLikeToday(doc, totalOnly)).toBe(111_900);

    const sample = createSampleDocument();
    const latest = sample.progress.at(-1)!;
    expect(snapshotNetWorthLikeToday(sample, latest)).toBe(latest.netWorth);
  });
});
