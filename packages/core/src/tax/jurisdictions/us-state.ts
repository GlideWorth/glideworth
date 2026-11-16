/**
 * US state and local income tax, driven entirely by ../data/us-states.ts.
 * 'us-state' reads the state from the id parameter ('us-state:CA') or household location.region;
 * 'us-local' likewise from 'us-local:nyc' or location.locality.
 * Starting point: federal AGI from the us-federal level when present (state conformity).
 */
import { ScenarioError } from "../../errors.js";
import {
  alivePeople,
  bands,
  clamp0,
  collectIncome,
  indexFactor,
  LineSink,
  periodScale,
  rateAt,
  sliceTax,
  sumDeductions,
} from "../common.js";
import { US_LOCAL_SIMPLIFICATIONS, US_STATE_SIMPLIFICATIONS } from "../data/anglo.js";
import {
  type LocalRow,
  type StateRow,
  US_LOCAL_BY_CODE,
  US_LOCALS_2026,
  US_STATE_BY_CODE,
  US_STATES_2026,
} from "../data/us-states.js";
import type { BracketFill, TaxJurisdiction, TaxYearInput, TaxYearOutput } from "../types.js";

function fact(prior: TaxYearOutput[], key: string): number | undefined {
  for (let i = prior.length - 1; i >= 0; i--) {
    const v = prior[i]!.facts[key];
    if (v !== undefined) return v;
  }
  return undefined;
}

function isJoint(input: TaxYearInput): boolean {
  return (
    input.filingStatus === "married-joint" || input.filingStatus === "qualifying-surviving-spouse"
  );
}

function stateRow(input: TaxYearInput, code?: string): StateRow {
  const c = (code ?? input.location.region ?? "").toUpperCase();
  const row = US_STATE_BY_CODE[c];
  if (!row) throw new ScenarioError(`unknown US state '${c}' for us-state tax`, { region: c });
  return row;
}

function computeState(
  row: StateRow,
  input: TaxYearInput,
  prior: TaxYearOutput[],
  explain: boolean,
): TaxYearOutput {
  const id = `us-state:${row.code}`;
  const sink = new LineSink(id);
  const f = indexFactor(input, "us", undefined).factor;
  const scale = periodScale(input);
  const fs = f * scale;
  const joint = isJoint(input);
  const people = alivePeople(input);
  const b = collectIncome(input, id);

  if (row.sdiRate) sink.add("payroll", `${row.code} SDI`, row.sdiRate * b.wage, b.wage);

  if (row.kind === "capital-gains-only" && row.capitalGainsTax) {
    const g = clamp0(b.gainsLong - row.capitalGainsTax.deduction * fs);
    sink.add(
      "capital-gains",
      `${row.name} capital gains tax`,
      sliceTax(bands(row.capitalGainsTax.brackets, fs), 0, g).tax,
      g,
    );
  }
  if (row.kind !== "flat" && row.kind !== "brackets")
    return { lines: sink.lines, grossIncome: 0, taxableIncome: 0, marginalRate: 0, facts: {} };

  // ---- base: federal AGI (or an own estimate when the federal level is absent)
  const fedAgi = fact(prior, "agi");
  const fedTaxableSs = fact(prior, "us.taxableSocialSecurity");
  const preTax = sumDeductions(input, "pre-tax-contribution", { level: "state" });
  const ownAgi =
    b.wage +
    b.selfEmployment +
    b.pension +
    b.ordinary +
    b.interest +
    b.qualifiedDividends +
    b.ordinaryDividends +
    b.rental +
    b.gainsLong +
    b.gainsShort +
    b.deferredWithdrawals +
    0.85 * b.socialSecurity -
    preTax;
  const agi = fedAgi ?? ownAgi;
  const taxableSs = fedTaxableSs ?? 0.85 * b.socialSecurity;
  let base = agi;
  if (!row.taxesSocialSecurity) base -= taxableSs;
  if (row.capitalGains === "exempt") base -= b.gainsLong + b.gainsShort;
  // State-only deductions (not already in federal AGI).
  for (const d of input.deductions)
    if (
      d.kind === "deduction" &&
      !d.itemized &&
      d.levels.includes("state") &&
      !d.levels.includes("federal")
    )
      base -= d.amount;

  // ---- retirement income exclusions, per person by age
  let excluded = 0;
  if (row.retirementExclusion) {
    for (const p of people) {
      const pb = collectIncome(input, id, p.id, people);
      const eligibleIncome =
        pb.pension + (row.retirementExclusionAppliesTo === "pension" ? 0 : pb.deferredWithdrawals);
      let cap = 0;
      for (const r of row.retirementExclusion) if (p.age >= r.minAge) cap = Math.max(cap, r.amount);
      excluded += Math.min(eligibleIncome, Number.isFinite(cap) ? cap * scale : eligibleIncome);
    }
  }
  base -= excluded;

  // ---- deductions and exemptions
  const std = row.standardDeduction
    ? (joint ? row.standardDeduction.mfj : row.standardDeduction.single) * fs
    : 0;
  const deps = input.dependents.filter((d) => d.age < 19).length;
  const ex = row.exemption;
  const exAmount = ex ? ((joint ? ex.mfj : ex.single) + deps * ex.dependent) * fs : 0;
  const taxable = clamp0(base - std - (ex && !ex.credit ? exAmount : 0));
  const table = joint
    ? (row.mfj ?? row.single.map(([t, r]) => [t * (row.mfjFactor ?? 1), r] as [number, number]))
    : row.single;
  const bnds = bands(table, fs);
  const fill: BracketFill["bands"] | undefined = explain ? [] : undefined;
  const tax = sliceTax(bnds, 0, taxable, fill).tax;
  const exCredit = ex?.credit ? Math.min(exAmount, tax) : 0;
  const userCredits = Math.min(sumDeductions(input, "credit", { level: "state" }), tax - exCredit);

  sink.add("income", `${row.name} income tax`, tax, taxable);
  sink.add("credit", `${row.name} credits`, -(exCredit + userCredits));
  const out: TaxYearOutput = {
    lines: sink.lines,
    grossIncome: agi,
    taxableIncome: taxable,
    marginalRate: taxable > 0 ? rateAt(bnds, taxable) : 0,
    facts: { "us.stateTaxableIncome": taxable, "us.stateRetirementExclusion": excluded },
  };
  if (fill) out.brackets = [{ jurisdictionId: id, schedule: "ordinary", bands: fill }];
  return out;
}

/**
 * The general state list, plus this state's noted approximation and any figures that could not be
 * confirmed from an official source.
 */
function stateSimplifications(code?: string): readonly string[] {
  const row = code ? US_STATE_BY_CODE[code] : undefined;
  if (!row) return US_STATE_SIMPLIFICATIONS;
  const extra: string[] = [];
  if (row.approx) extra.push(`${row.name}: ${row.approx}.`);
  if (row.unconfirmed)
    extra.push(`${row.name}: not confirmed from an official source: ${row.unconfirmed}.`);
  return extra.length > 0 ? [...US_STATE_SIMPLIFICATIONS, ...extra] : US_STATE_SIMPLIFICATIONS;
}

/** The state's own official sources; the unparameterised level lists every state's. */
function stateSources(code?: string): { taxYear: string; url: string; note?: string }[] {
  const rows = code ? [US_STATE_BY_CODE[code]].filter((r) => r !== undefined) : US_STATES_2026;
  return rows.flatMap((r) =>
    r.sources.map((s) => ({ taxYear: "2026", url: s.url, note: `${r.code}: ${s.note ?? ""}` })),
  );
}

function localSources(code?: string): { taxYear: string; url: string; note?: string }[] {
  const rows = code ? [US_LOCAL_BY_CODE[code]].filter((r) => r !== undefined) : US_LOCALS_2026;
  return rows.map((r) => ({ taxYear: "2026", url: r.source, note: `${r.name}: ${r.sourceNote}` }));
}

function localSimplifications(code?: string): readonly string[] {
  const row = code ? US_LOCAL_BY_CODE[code] : undefined;
  return row?.unconfirmed
    ? [
        ...US_LOCAL_SIMPLIFICATIONS,
        `${row.name}: not confirmed from an official source: ${row.unconfirmed}.`,
      ]
    : US_LOCAL_SIMPLIFICATIONS;
}

function makeState(code?: string): TaxJurisdiction {
  return {
    id: code ? `us-state:${code}` : "us-state",
    label: code ? `US state income tax (${code})` : "US state income tax (data-driven table)",
    level: "state",
    country: "US",
    status: "implemented",
    owner: "b",
    computeYear: (input, prior) => computeState(stateRow(input, code), input, prior, false),
    explainYear: (input, prior) => computeState(stateRow(input, code), input, prior, true),
    parameterize: (param) => makeState(param.toUpperCase()),
    sources: stateSources(code),
    simplifications: stateSimplifications(code),
  };
}

export const usStateJurisdiction = makeState();

// ------------------------------------------------------------------------------------- local

function computeLocal(input: TaxYearInput, prior: TaxYearOutput[], code?: string): TaxYearOutput {
  const c = (code ?? input.location.locality ?? "").toLowerCase();
  const row: LocalRow | undefined = US_LOCAL_BY_CODE[c];
  const id = `us-local:${c || "custom"}`;
  const sink = new LineSink(id);
  const scale = periodScale(input);
  const b = collectIncome(input, id);
  const stateTaxable = fact(prior, "us.stateTaxableIncome") ?? fact(prior, "us.taxableIncome") ?? 0;
  if (!row) {
    const rate = input.config.localIncomeTaxRate ?? 0;
    sink.add("local", "Local income tax", rate * stateTaxable, stateTaxable);
    return {
      lines: sink.lines,
      grossIncome: 0,
      taxableIncome: stateTaxable,
      marginalRate: rate,
      facts: {},
    };
  }
  let base = row.base === "state-taxable" ? stateTaxable : b.wage + b.selfEmployment;
  if (row.exemption) {
    const n = (isJoint(input) ? alivePeople(input).length : 1) + input.dependents.length;
    base = clamp0(base - row.exemption * n * scale);
  }
  const table = isJoint(input) && row.mfj ? row.mfj : row.single;
  // City brackets are not indexed (NYC thresholds are statutory).
  const bnds = bands(table, row.base === "state-taxable" ? scale : 1);
  const tax = sliceTax(bnds, 0, base).tax;
  sink.add("local", `${row.name} income tax`, tax, base);
  return {
    lines: sink.lines,
    grossIncome: 0,
    taxableIncome: base,
    marginalRate: base > 0 ? rateAt(bnds, base) : 0,
    facts: {},
  };
}

function makeLocal(code?: string): TaxJurisdiction {
  return {
    id: code ? `us-local:${code}` : "us-local",
    label: code ? `US local income tax (${code})` : "US local income tax",
    level: "local",
    country: "US",
    status: "implemented",
    owner: "b",
    computeYear: (input, prior) => computeLocal(input, prior, code),
    explainYear: (input, prior) => computeLocal(input, prior, code),
    parameterize: (param) => makeLocal(param.toLowerCase()),
    sources: localSources(code),
    simplifications: localSimplifications(code),
  };
}

export const usLocalJurisdiction = makeLocal();
