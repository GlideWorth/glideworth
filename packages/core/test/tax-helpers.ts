/** Builders for hand-worked tax test vectors (synthetic figures only). */
import { TaxConfig, type TaxConfigInput } from "../src/schema/tax.js";
import type {
  ResolvedTaxCharacter,
  TaxDeductionItem,
  TaxIncomeItem,
  TaxJurisdiction,
  TaxWithdrawalItem,
  TaxYearInput,
  TaxYearOutput,
} from "../src/tax/types.js";

export interface PersonSpec {
  id?: string;
  age?: number;
  birthYear?: number;
  alive?: boolean;
  activeParticipant?: boolean;
}

export function taxInput(opts: {
  year?: number;
  country?: string;
  region?: string;
  locality?: string;
  people?: PersonSpec[];
  dependents?: number[];
  income?: Partial<TaxIncomeItem>[];
  withdrawals?: Partial<TaxWithdrawalItem>[];
  deductions?: Partial<TaxDeductionItem>[];
  config?: TaxConfigInput;
  priceIndex?: number;
  months?: number;
  history?: Record<string, number>[];
  aca?: TaxYearInput["aca"];
  wealth?: TaxYearInput["wealth"];
  transactions?: TaxYearInput["transactions"];
}): TaxYearInput {
  const people = (opts.people ?? [{}]).map((p, i) => ({
    id: p.id ?? (i === 0 ? "p1" : "p2"),
    role: (i === 0 ? "primary" : "partner") as "primary" | "partner",
    age: p.age ?? 40,
    alive: p.alive ?? true,
    ...(p.birthYear !== undefined ? { birthYear: p.birthYear } : {}),
    ...(p.activeParticipant ? { activeParticipant: true } : {}),
  }));
  const config = TaxConfig.parse({ mode: "estimate", ...(opts.config ?? {}) });
  return {
    year: opts.year ?? 2026,
    periodIndex: 0,
    months: opts.months ?? 12,
    filingStatus: config.filingStatus,
    location: {
      country: opts.country ?? "GB",
      ...(opts.region ? { region: opts.region } : {}),
      ...(opts.locality ? { locality: opts.locality } : {}),
    },
    people,
    dependents: (opts.dependents ?? []).map((age, i) => ({ id: `d${i}`, age })),
    priceIndex: opts.priceIndex ?? 1,
    income: (opts.income ?? []).map((i, n) => ({
      sourceId: i.sourceId ?? `inc${n}`,
      owner: i.owner ?? people[0]!.id,
      character: i.character ?? ("wage" as ResolvedTaxCharacter),
      amount: i.amount ?? 0,
      exemptIn: i.exemptIn ?? [],
      ...(i.dividendTreatment ? { dividendTreatment: i.dividendTreatment } : {}),
      ...(i.frankedShare !== undefined ? { frankedShare: i.frankedShare } : {}),
      ...(i.incomeType ? { incomeType: i.incomeType } : {}),
    })),
    withdrawals: (opts.withdrawals ?? []).map((w, n) => ({
      accountId: w.accountId ?? `acc${n}`,
      accountType: w.accountType ?? "uk-sipp",
      treatment: w.treatment ?? "tax-deferred",
      owner: w.owner ?? people[0]!.id,
      amount: w.amount ?? 0,
      taxableAmount: w.taxableAmount ?? w.amount ?? 0,
      character: w.character ?? "ordinary",
      penaltyRate: w.penaltyRate ?? 0,
      ownerAge: w.ownerAge ?? people[0]!.age,
    })),
    deductions: (opts.deductions ?? []).map((d, n) => ({
      sourceId: d.sourceId ?? `ded${n}`,
      kind: d.kind ?? "pre-tax-contribution",
      amount: d.amount ?? 0,
      itemized: d.itemized ?? false,
      levels: d.levels ?? ["federal", "state", "local"],
      owner: d.owner ?? people[0]!.id,
      ...(d.accountType ? { accountType: d.accountType } : {}),
      ...(d.pensionScheme ? { pensionScheme: d.pensionScheme } : {}),
      ...(d.employer ? { employer: d.employer } : {}),
    })),
    config,
    history: opts.history ?? [],
    ...(opts.aca ? { aca: opts.aca } : {}),
    ...(opts.wealth ? { wealth: opts.wealth } : {}),
    ...(opts.transactions ? { transactions: opts.transactions } : {}),
  };
}

export function sumKind(out: TaxYearOutput, ...kinds: string[]): number {
  return out.lines.filter((l) => kinds.includes(l.kind)).reduce((s, l) => s + l.amount, 0);
}

export function sumLabel(out: TaxYearOutput, re: RegExp): number {
  return out.lines.filter((l) => re.test(l.label)).reduce((s, l) => s + l.amount, 0);
}

export function total(out: TaxYearOutput): number {
  return out.lines.reduce((s, l) => s + l.amount, 0);
}

/** Run a whole stack the way the engine does. */
export function runStack(stack: TaxJurisdiction[], input: TaxYearInput): TaxYearOutput[] {
  const outs: TaxYearOutput[] = [];
  for (const j of stack) outs.push(j.computeYear(input, outs));
  return outs;
}
