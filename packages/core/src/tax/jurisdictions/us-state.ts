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
  ownerShare,
  periodScale,
  rateAt,
  sliceTax,
  sumDeductions,
} from "../common.js";
import { US_LOCAL_SIMPLIFICATIONS, US_STATE_SIMPLIFICATIONS } from "../data/anglo.js";
import {
  type ByJoint,
  type LocalRow,
  type StateAgiSteps,
  type StateIncomeTest,
  type StateRow,
  type StateSocialSecurityRule,
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

const IRA_TYPES = new Set(["traditional-ira", "sep-ira", "simple-ira", "inherited-ira"]);

/** A person's taxable withdrawals from IRAs (not workplace plans). */
function iraWithdrawals(
  input: TaxYearInput,
  personId: string,
  people: ReturnType<typeof alivePeople>,
): number {
  let s = 0;
  for (const w of input.withdrawals)
    if (w.treatment === "tax-deferred" && IRA_TYPES.has(w.accountType))
      s += clamp0(w.taxableAmount) * ownerShare(w.owner, personId, people);
  return s;
}

/** Share of a retirement exclusion kept at an annual federal AGI. */
function incomeTestShare(t: StateIncomeTest, agi: number, joint: boolean, k: number): number {
  let keep = 1;
  if (t.phaseOut) {
    const start = (joint ? t.phaseOut.start.mfj : t.phaseOut.start.single) * k;
    const width = (joint ? t.phaseOut.width.mfj : t.phaseOut.width.single) * k;
    keep = Math.min(keep, clamp0(1 - clamp0(agi - start) / width));
  }
  if (t.steps)
    for (const [above, share] of joint ? t.steps.mfj : t.steps.single)
      if (agi > above * k) keep = Math.min(keep, share);
  return keep;
}

/** Share from steps of [state AGI above, share]: the highest step exceeded, else 0. */
function agiStepShare(steps: StateAgiSteps, agi: number, joint: boolean): number {
  let share = 0;
  for (const [above, v] of joint ? steps.mfj : steps.single) if (agi > above) share = v;
  return share;
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

  let sdiRate = row.sdiRate ?? 0;
  for (const [from, rate] of row.sdiRateFrom ?? []) if (input.year >= from) sdiRate = rate;
  if (sdiRate) sink.add("payroll", `${row.code} SDI`, sdiRate * b.wage, b.wage);

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
  const agiAnnual = agi / scale;
  const taxableSs = fedTaxableSs ?? 0.85 * b.socialSecurity;
  const perPerson = people.map((p) => ({ p, b: collectIncome(input, id, p.id, people) }));
  // Share of each person's benefits in the federally taxable amount.
  const ssShare = (benefits: number) =>
    b.socialSecurity > 0 ? (taxableSs * benefits) / b.socialSecurity : 0;
  let base = agi;

  // ---- Social Security: exempt, or partly exempt by age and income
  let ssExempt = 0;
  if (!row.taxesSocialSecurity) ssExempt = taxableSs;
  else if (row.socialSecurity) ssExempt = socialSecurityExemption(row.socialSecurity);
  base -= ssExempt;
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

  function socialSecurityExemption(r: StateSocialSecurityRule): number {
    let eligible = 0;
    let always = 0;
    let benefits = 0;
    for (const { p, b: pb } of perPerson) {
      if (r.exemptFromAge !== undefined && p.age >= r.exemptFromAge)
        always += ssShare(pb.socialSecurity);
      else if (r.minAge === undefined || p.age >= r.minAge) {
        eligible += ssShare(pb.socialSecurity);
        benefits += pb.socialSecurity;
      }
    }
    if (!r.agiLimit) return always + eligible;
    const k = r.indexed ? f : 1;
    const limit = (joint ? r.agiLimit.mfj : r.agiLimit.single) * k;
    const over = agiAnnual - limit;
    let ex = 0;
    if (over <= 0) ex = eligible;
    else if (r.phaseOut) {
      const width = (joint ? r.phaseOut.width.mfj : r.phaseOut.width.single) * k;
      const lost = r.phaseOut.step
        ? Math.ceil(over / (r.phaseOut.step * k)) * r.phaseOut.step * k
        : over;
      ex = eligible * clamp0(1 - lost / width);
    } else if (r.reductionPerDollar !== undefined)
      ex = clamp0(eligible - r.reductionPerDollar * over * scale);
    else if (r.maxTaxableShare !== undefined) ex = clamp0(eligible - r.maxTaxableShare * benefits);
    return always + ex;
  }

  // ---- retirement income exclusions, per person by age
  let excluded = 0;
  const excludedBy = new Map<string, number>();
  // Pension income exempt in full at any age (Alabama's defined benefit plans).
  let pensionExempt = 0;
  if (row.pensionIncomeExempt) for (const { b: pb } of perPerson) pensionExempt += pb.pension;
  base -= pensionExempt;
  if (row.retirementExclusion) {
    const scope = row.retirementExclusionAppliesTo ?? "retirement";
    for (const { p, b: pb } of perPerson) {
      let eligibleIncome = row.pensionIncomeExempt ? 0 : pb.pension;
      if (scope === "retirement" || scope === "retirement-and-investment")
        eligibleIncome += pb.deferredWithdrawals;
      else if (scope === "employer")
        eligibleIncome += clamp0(pb.deferredWithdrawals - iraWithdrawals(input, p.id, people));
      if (scope === "retirement-and-investment")
        eligibleIncome +=
          pb.interest +
          pb.qualifiedDividends +
          pb.ordinaryDividends +
          pb.rental +
          (row.capitalGains === "exempt" ? 0 : pb.gainsLong + pb.gainsShort);
      let cap = 0;
      for (const r of row.retirementExclusion) if (p.age >= r.minAge) cap = Math.max(cap, r.amount);
      let amount = Number.isFinite(cap) ? cap * fs : Number.POSITIVE_INFINITY;
      const lessSs = row.retirementExclusionLessSocialSecurity;
      if (lessSs === true) amount = clamp0(amount - pb.socialSecurity);
      else if (lessSs === "exempt" && b.socialSecurity > 0)
        amount = clamp0(amount - (ssExempt * pb.socialSecurity) / b.socialSecurity);
      const x = Math.min(eligibleIncome, amount);
      excludedBy.set(p.id, x);
      excluded += x;
    }
    const perReturn = row.retirementExclusionPerReturn;
    if (perReturn && excluded > 0) {
      const cap = (joint ? perReturn.mfj : perReturn.single) * fs;
      if (excluded > cap) {
        for (const [k, v] of excludedBy) excludedBy.set(k, (v * cap) / excluded);
        excluded = cap;
      }
    }
    const test = row.retirementExclusionIncomeTest;
    if (test && excluded > 0) {
      const keep = incomeTestShare(test, agiAnnual, joint, test.indexed ? f : 1);
      for (const [k, v] of excludedBy) excludedBy.set(k, v * keep);
      excluded *= keep;
    }
  }
  base -= excluded;

  // ---- deduction for age against any income
  let ageDeduction = 0;
  const ad = row.ageDeduction;
  if (ad) {
    for (const { p, b: pb } of perPerson) {
      if (p.age < ad.minAge) continue;
      let x = ad.amount * fs;
      if (ad.lessRetirementExclusion) x -= excludedBy.get(p.id) ?? 0;
      if (ad.lessExemptSocialSecurity && b.socialSecurity > 0)
        x -= (ssExempt * pb.socialSecurity) / b.socialSecurity;
      ageDeduction += clamp0(x);
    }
    if (ad.agiReduction && ageDeduction > 0) {
      const thr = (joint ? ad.agiReduction.mfj : ad.agiReduction.single) * scale;
      ageDeduction = clamp0(ageDeduction - clamp0(agi - taxableSs - thr));
    }
  }
  base -= ageDeduction;
  // State AGI (annual) after the state's subtractions: the base of state income tests.
  const stateAgi = (base + ageDeduction) / scale;

  // ---- deduction for federal income tax (statutory amounts, not indexed)
  let federalTaxDeduction = 0;
  const ftd = row.federalTaxDeduction;
  const federalTax = fact(prior, "us.federalIncomeTax");
  if (ftd && federalTax !== undefined) {
    const share = ftd.share ? agiStepShare(ftd.share, stateAgi, joint) : 1;
    federalTaxDeduction = share * federalTax;
    if (ftd.cap)
      federalTaxDeduction = Math.min(
        federalTaxDeduction,
        (joint ? ftd.cap.mfj : ftd.cap.single) * scale,
      );
  }
  base -= federalTaxDeduction;

  // ---- deductions and exemptions
  const fedDeduction = fact(prior, "us.deduction");
  const usesFederal = row.federalDeduction !== undefined && fedDeduction !== undefined;
  let std = row.standardDeduction
    ? (joint ? row.standardDeduction.mfj : row.standardDeduction.single) * fs
    : 0;
  const po = row.standardDeductionPhaseOut;
  if (po && !usesFederal) {
    const pick = (x: ByJoint) => (joint ? x.mfj : x.single) * f;
    const start = pick(po.start);
    const share = clamp0(Math.min(1, (stateAgi - start) / (pick(po.end) - start)));
    std -= share * (std - pick(po.floor) * scale);
  }
  if (usesFederal) {
    std =
      fedDeduction! +
      (row.federalDeduction === "taxable-income" ? (fact(prior, "us.seniorDeduction") ?? 0) : 0);
    const lim = row.federalDeductionLimit;
    if (lim && agiAnnual > lim.agiAbove)
      std = Math.min(std, (joint ? lim.cap.mfj : lim.cap.single) * scale);
  }
  const filers = joint ? people : people.slice(0, 1);
  const ex = row.exemption;
  const exemptionLost =
    ex?.zeroAboveAgi !== undefined &&
    agiAnnual > (joint ? ex.zeroAboveAgi.mfj : ex.zeroAboveAgi.single);
  let agedDeduction = 0;
  let agedCredit = 0;
  for (const a of row.aged ?? []) {
    if (a.withExemption && exemptionLost) continue;
    const n = filers.filter((p) => p.age >= (a.minAge ?? 65)).length;
    const amount = n * (joint ? a.married : a.single) * fs;
    if (a.credit) agedCredit += amount;
    // The federal deduction already includes the federal 65+ amounts.
    else if (!usesFederal) agedDeduction += amount;
  }
  std += agedDeduction;
  let exAmount = 0;
  if (ex) {
    let deps = input.dependents.filter((d) => d.age < 19).length;
    if (ex.dependentsAfterFirstJointOnly) deps = joint ? Math.max(0, deps - 1) : 0;
    let filerAmt = joint ? ex.mfj : ex.single;
    let depAmt = ex.dependent;
    if (ex.byAgi) {
      const n = joint ? 2 : 1;
      let per = ex.single;
      for (const [above, amt] of ex.byAgi) if (agiAnnual > above * f) per = amt;
      filerAmt = per * n;
      depAmt = per;
    }
    exAmount = (filerAmt + deps * depAmt) * fs;
    if (ex.phaseOut)
      exAmount = clamp0(
        exAmount -
          ex.phaseOut.perDollar *
            clamp0(stateAgi - (joint ? ex.phaseOut.start.mfj : ex.phaseOut.start.single)) *
            scale,
      );
    if (exemptionLost) exAmount = 0;
  }
  const taxable = clamp0(base - std - (ex && !ex.credit ? exAmount : 0));
  const table = joint
    ? (row.mfj ?? row.single.map(([t, r]) => [t * (row.mfjFactor ?? 1), r] as [number, number]))
    : row.single;
  let bnds = bands(table, fs);
  const fill: BracketFill["bands"] | undefined = explain ? [] : undefined;
  const low = row.lowIncomeTable;
  let adjustment = 0;
  if (low && taxable <= low.maxIncome * fs) bnds = bands(low.brackets, fs);
  else if (low?.adjustment) {
    const { amount, to } = low.adjustment;
    adjustment =
      amount * fs * clamp0(Math.min(1, (to * fs - taxable) / ((to - low.maxIncome) * fs)));
  }
  let tax = clamp0(sliceTax(bnds, 0, taxable, fill).tax - adjustment);
  if (row.stepTax && taxable > row.stepTax.threshold * fs) tax += row.stepTax.amount * fs;
  const shareCredit = row.taxCreditShare
    ? agiStepShare(row.taxCreditShare, stateAgi, joint) * tax
    : 0;
  const credits = (ex?.credit ? exAmount : 0) + agedCredit + shareCredit;
  const exCredit = Math.min(credits, tax);
  const userCredits = Math.min(sumDeductions(input, "credit", { level: "state" }), tax - exCredit);

  sink.add("income", `${row.name} income tax`, tax, taxable);
  sink.add("credit", `${row.name} credits`, -(exCredit + userCredits));
  const out: TaxYearOutput = {
    lines: sink.lines,
    grossIncome: agi,
    taxableIncome: taxable,
    marginalRate: taxable > 0 ? rateAt(bnds, taxable) : 0,
    facts: {
      "us.stateTaxableIncome": taxable,
      "us.stateRetirementExclusion": excluded + pensionExempt,
      "us.stateFederalTaxDeduction": federalTaxDeduction,
      "us.stateSocialSecurityExempt": ssExempt,
      "us.stateAgeDeduction": ageDeduction,
    },
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
  let base =
    row.base === "state-taxable"
      ? stateTaxable
      : b.wage +
        b.selfEmployment +
        (row.base === "earned-and-investment"
          ? b.interest +
            b.qualifiedDividends +
            b.ordinaryDividends +
            b.gainsLong +
            b.gainsShort +
            b.rental
          : 0);
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
