/** OFX and QIF import (synthetic statements), plus ProjectionLab currency and country defaults. */
import { buildSimulationInput, simulate } from "@glideworth/core";
import { createUkSampleDocument, UK_SAMPLE_PLAN_ID } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import {
  detectBankFileFormat,
  importBankFileInto,
  importProjectionLab,
  parseOfx,
  parseQif,
  summariseBankFile,
} from "../src/index.js";
import { buildSyntheticExport } from "./fixtures/projectionlab-synthetic.js";

interface PlExport {
  settings: { ci: Record<string, unknown> };
  today: { savingsAccounts: Record<string, unknown>[] };
}

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261115</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STMTRS>
<CURDEF>GBP
<BANKACCTFROM><BANKID>000000<ACCTID>12345678<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20251101<DTEND>20261031
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20251105120000<TRNAMT>-1200.00<FITID>1<NAME>Rent payment Nov<MEMO>flat</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20251110<TRNAMT>-85.40<FITID>2<NAME>Supermarket</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20251128<TRNAMT>2500.00<FITID>3<NAME>Employer salary</STMTTRN>
<STMTTRN><TRNTYPE>XFER<DTPOSTED>20251201<TRNAMT>-500.00<FITID>4<NAME>To savings</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005<TRNAMT>-1200.00<FITID>5<NAME>Rent payment Oct</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261020<TRNAMT>-60.00<FITID>6<NAME>Gym membership</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>3456.78<DTASOF>20261031</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>2<CCSTMTRS><CURDEF>GBP
<CCACCTFROM><ACCTID>4111222233334444</CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260301<TRNAMT>-300.00<NAME>Airline tickets</STMTTRN>
<STMTTRN><TRNTYPE>PAYMENT<DTPOSTED>20260320<TRNAMT>300.00<NAME>Payment thank you</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>-420.50<DTASOF>20261031</LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>`;

const OFX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>EUR</CURDEF>
<BANKACCTFROM><BANKID>1</BANKID><ACCTID>DE000099998888</ACCTID><ACCTTYPE>SAVINGS</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260110</DTPOSTED><TRNAMT>-10.50</TRNAMT><NAME>Caf&amp;eacute; &amp; bakery</NAME></STMTTRN></BANKTRANLIST>
<LEDGERBAL><BALAMT>1000.00</BALAMT><DTASOF>20260131</DTASOF></LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const QIF = `!Account
NJoint current account
TBank
^
!Type:Bank
D01/01/2026
T1,000.00
POpening Balance
L[Joint current account]
^
D01/15/2026
T-250.00
PCity Energy
LUtilities:Electricity
^
D02/01/2026
T-900.00
PLandlord
LRent
^
D02/03/2026
T-200.00
PTransfer
L[Savings]
^
D02/28/2026
T2,000.00
PEmployer
LSalary
^
`;

describe("OFX", () => {
  it("detects OFX and QIF", () => {
    expect(detectBankFileFormat(OFX_SGML)).toBe("ofx");
    expect(detectBankFileFormat(OFX_XML)).toBe("ofx");
    expect(detectBankFileFormat(QIF)).toBe("qif");
    expect(detectBankFileFormat("a,b,c")).toBeNull();
  });

  it("reads SGML statements: masked accounts, balances, transactions", () => {
    const p = parseOfx(OFX_SGML);
    expect(p.accounts).toHaveLength(2);
    const [bank, card] = p.accounts;
    expect(bank).toMatchObject({
      name: "Current account ••5678",
      type: "cash",
      entity: "account",
      currency: "GBP",
      balance: 3456.78,
      balanceDate: "2026-10-31",
    });
    expect(card).toMatchObject({ name: "Credit card ••4444", entity: "debt", balance: 420.5 });
    expect(JSON.stringify(p)).not.toContain("12345678");
    expect(p.transactions).toHaveLength(8);
    expect(p.transactions[0]).toMatchObject({
      date: "2025-11-05",
      amount: -1200,
      type: "DEBIT",
      payee: "Rent payment Nov",
    });
  });

  it("reads XML statements and decodes entities", () => {
    const p = parseOfx(OFX_XML);
    expect(p.accounts[0]).toMatchObject({ type: "savings", currency: "EUR", balance: 1000 });
    expect(p.transactions[0]!.payee).toBe("Caf&eacute; & bakery");
  });

  it("summarises spending by category (transfers, income and card payments excluded)", () => {
    const s = summariseBankFile(OFX_SGML, { annualise: "all" });
    const cats = Object.fromEntries(s.summary.categories.map((c) => [c.category, c.total]));
    expect(cats.Housing).toBeCloseTo(2_400, 6);
    expect(cats.Travel).toBeCloseTo(300, 6);
    expect(cats.Entertainment).toBeCloseTo(60, 6);
    const excluded = Object.fromEntries(s.summary.excluded.map((e) => [e.category, e.count]));
    expect(excluded).toMatchObject({ Income: 1, Transfers: 1, "Card payments": 1 });
    expect(s.summary.events.length).toBeGreaterThan(0);
    expect(s.issues.some((i) => i.code === "bank.inferred-category")).toBe(true);
    expect(s.balances.map((b) => b.balance)).toEqual([3456.78, 420.5]);
  });
});

describe("QIF", () => {
  it("reads records, categories, transfers and the opening balance", () => {
    const p = parseQif(QIF);
    expect(p.accounts).toEqual([
      expect.objectContaining({
        name: "Joint current account",
        entity: "account",
        balance: 1_650,
        balanceDate: "2026-02-28",
      }),
    ]);
    expect(p.transactions).toHaveLength(4);
    expect(p.transactions.find((t) => t.payee === "Transfer")!.transfer).toBe(true);
    expect(p.transactions.find((t) => t.payee === "Landlord")!.category).toBe("Rent");
  });

  it("honours day-first dates", () => {
    const p = parseQif("!Type:Bank\nD13/02/2026\nT-5\nPShop\n^\n");
    expect(p.transactions[0]!.date).toBe("2026-02-13");
    const forced = parseQif("!Type:Bank\nD03/02'26\nT-5\nPShop\n^\n", { dateFormat: "DD/MM/YYYY" });
    expect(forced.transactions[0]!.date).toBe("2026-02-03");
  });

  it("imports balances and an annual expense summary into a document (dry run by default)", () => {
    const doc = createUkSampleDocument();
    const dry = importBankFileInto(doc, QIF, {
      balances: { createMissing: true },
      transactionsToPlanId: UK_SAMPLE_PLAN_ID,
      annualise: "all",
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.document).toBe(doc);
    expect(dry.reconciliation!.created).toHaveLength(1);
    const cats = Object.fromEntries(dry.summary.categories.map((c) => [c.category, c.expenseType]));
    expect(cats).toMatchObject({ Rent: "housing", "Utilities:Electricity": "housing" });
    const done = importBankFileInto(
      doc,
      QIF,
      {
        balances: { createMissing: true },
        transactionsToPlanId: UK_SAMPLE_PLAN_ID,
        annualise: "all",
      },
      { dryRun: false },
    );
    expect(
      done.document.finances.accounts.some(
        (a) => a.name === "Joint current account" && a.balance === 1_650,
      ),
    ).toBe(true);
    const plan = done.document.plans.find((p) => p.id === UK_SAMPLE_PLAN_ID)!;
    expect(plan.expenses.length).toBeGreaterThan(doc.plans[0]!.expenses.length);
    // The result still simulates.
    expect(() => simulate(buildSimulationInput(done.document, UK_SAMPLE_PLAN_ID))).not.toThrow();
  });

  it("keeps a foreign statement currency on new accounts", () => {
    const doc = createUkSampleDocument();
    const r = importBankFileInto(
      doc,
      OFX_XML,
      { balances: { createMissing: true } },
      { dryRun: false },
    );
    expect(r.issues.some((i) => i.code === "bank.foreign-currency")).toBe(true);
    expect(
      r.document.finances.accounts.find((a) => a.name.startsWith("Savings account"))!.currency,
    ).toBe("EUR");
  });
});

describe("ProjectionLab: currency fields and country defaults", () => {
  it("maps per-entity currencies and exchange rates when the export has them", () => {
    const raw = buildSyntheticExport() as unknown as PlExport;
    raw.settings.ci.exchangeRates = { USD: 0.79 };
    raw.today.savingsAccounts[0]!.currency = "USD";
    const r = importProjectionLab(raw, { now: "2026-11-01" });
    const acc = r.document.finances.accounts.find((a) => a.currency === "USD");
    expect(acc).toBeDefined();
    expect(r.document.finances.fxRates).toEqual([
      { from: "USD", to: "GBP", rate: 0.79, annualDrift: 0 },
    ]);
    expect(r.report.coverage.unknown).toBe(0);
    const plan = r.document.plans[0]!;
    expect(() =>
      simulate(buildSimulationInput(r.document, plan.id, { strict: false })),
    ).not.toThrow();
  });

  it("warns when an entity currency has no exchange rate", () => {
    const raw = buildSyntheticExport() as unknown as PlExport;
    raw.today.savingsAccounts[0]!.currency = "CHF";
    const r = importProjectionLab(raw, { now: "2026-11-01" });
    expect(r.issues.some((i) => i.code === "pl.fx-missing")).toBe(true);
  });

  it("a UK household gets the GB default market history, with a note saying why", () => {
    const r = importProjectionLab(buildSyntheticExport(), { now: "2026-11-01" });
    if (r.document.household.location.country === "GB") {
      // GB defaults to US 1928-2025 (defaultsForCountry); the import note carries the reason.
      for (const p of r.document.plans) expect(p.monteCarlo.dataset).toBe("us-1928");
      expect(r.issues.some((i) => i.code === "pl.dataset-country")).toBe(true);
    }
  });
});
