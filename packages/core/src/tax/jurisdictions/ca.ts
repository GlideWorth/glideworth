/**
 * Canada: federal + provincial/territorial income tax per person. 50% capital-gains inclusion,
 * eligible / non-eligible dividend gross-up and dividend tax credits, basic personal amount (with
 * the federal high-income reduction), age amount, pension income amount, Canada employment amount,
 * CPP/QPP (base, enhanced, CPP2; CPP stops at 70; base CPP 4.75% from 2027) and EI premiums, OAS
 * recovery tax, RRSP deductions, Quebec abatement, Ontario surtax (before the dividend tax credit)
 * and health premium, Manitoba's basic-amount phase-out, Yukon's federal-style basic amount,
 * Saskatchewan's senior supplementary amount, legislated provincial indexation pauses (Manitoba,
 * British Columbia 2027-2030), and pension-income splitting (optimised over federal + provincial
 * tax in 5% steps). Data: ../data/ca.ts.
 *
 * Not modelled: Quebec's separate return details (age/pension amounts, QPIP), AMT, provincial
 * low-income reductions, GIS clawback.
 */
import { ScenarioError } from "../../errors.js";
import {
  alivePeople,
  bands,
  clamp0,
  collectIncome,
  finiteMarginal,
  indexFactor,
  LineSink,
  ownerShare,
  periodScale,
  sliceTax,
} from "../common.js";
import { CA_FEDERAL_SIMPLIFICATIONS, CA_PROVINCE_SIMPLIFICATIONS } from "../data/anglo.js";
import {
  CA_2026,
  CA_PROVINCE_BY_CODE,
  type CaProvince,
  ONTARIO_2026,
  RRIF_FACTORS,
} from "../data/ca.js";
import type {
  RequiredDistributionQuery,
  TaxContributionLimitQuery,
  TaxJurisdiction,
  TaxPerson,
  TaxYearInput,
  TaxYearOutput,
} from "../types.js";
import { defaultCharacterForIncomeType } from "./flat.js";

const C = CA_2026;

interface Ctx {
  year: number;
  f: number;
  scale: number;
  fs: number;
  /** Provincial index factor x period scale (differs from `fs` during a legislated pause). */
  pfs: number;
  /** Index anchors for provincial pauses, kept in the provincial output's facts. */
  pFacts: Record<string, number>;
  quebec: boolean;
  prov: CaProvince | null;
  people: TaxPerson[];
}

function context(input: TaxYearInput, provCode?: string): Ctx {
  const f = indexFactor(input, "ca", undefined).factor;
  const scale = periodScale(input);
  const code = (provCode ?? input.location.region ?? "").toUpperCase();
  const prov = code ? (CA_PROVINCE_BY_CODE[code] ?? null) : null;
  if (code && !prov)
    throw new ScenarioError(`unknown Canadian province '${code}'`, { region: code });
  const pIdx = prov?.frozenThrough
    ? indexFactor(input, `ca.${prov.code}`, prov.frozenThrough)
    : { factor: f, facts: {} };
  return {
    year: input.year,
    f,
    scale,
    fs: f * scale,
    pfs: pIdx.factor * scale,
    pFacts: pIdx.facts,
    quebec: code === "QC",
    prov,
    people: alivePeople(input),
  };
}

/** Federal basic personal amount: the enhanced amount, reduced between the 29% and 33% brackets. */
function federalBpa(netIncome: number, fs: number): number {
  const F = C.federal;
  const lo = F.brackets[3]![0] * fs;
  const hi = F.brackets[4]![0] * fs;
  if (netIncome <= lo) return F.bpaMax * fs;
  if (netIncome >= hi) return F.bpaMin * fs;
  return F.bpaMax * fs - ((F.bpaMax - F.bpaMin) * fs * (netIncome - lo)) / (hi - lo);
}

/** Provincial basic personal amount for a person with this net income (line 23600). */
function provincialBpa(P: CaProvince, x: Ctx, netIncome: number): number {
  if (P.bpaFollowsFederal) return federalBpa(netIncome, x.fs);
  const base = P.bpaFrom && x.year >= P.bpaFrom.year ? P.bpaFrom.amount : P.bpa;
  const bpa = base * x.pfs;
  if (!P.bpaPhaseOut) return bpa;
  // Manitoba: reduced to nil between the two net incomes (TD1MB 2026; not indexed).
  const from = P.bpaPhaseOut[0] * x.scale;
  const to = P.bpaPhaseOut[1] * x.scale;
  if (netIncome <= from) return bpa;
  if (netIncome >= to) return 0;
  return bpa * (1 - (netIncome - from) / (to - from));
}

interface PersonCalc {
  netIncome: number;
  taxable: number;
  clawback: number;
  oas: number;
  eligiblePension: number;
  federal: number;
  quebecAbatement: number;
  provincial: number;
  ontarioSurtax: number;
  ontarioHealth: number;
  cpp: number;
  ei: number;
  gross: number;
}

function govBenefit(input: TaxYearInput, pid: string, people: TaxPerson[], type: string): number {
  let s = 0;
  for (const it of input.income)
    if (it.incomeType === type && it.amount > 0) s += it.amount * ownerShare(it.owner, pid, people);
  return s;
}

/** `splitIn` > 0: eligible pension income received from the spouse; < 0: transferred away. */
function personCalc(
  input: TaxYearInput,
  x: Ctx,
  person: TaxPerson,
  splitIn: number,
  withProvince: boolean,
): PersonCalc {
  const { fs } = x;
  const b = collectIncome(input, "ca-federal", person.id, x.people);
  const oas = govBenefit(input, person.id, x.people, "ca-oas");
  const cppBenefit = govBenefit(input, person.id, x.people, "ca-cpp");
  const rrsp = (() => {
    let s = 0;
    for (const d of input.deductions)
      if (
        (d.kind === "pre-tax-contribution" || d.kind === "deduction") &&
        !d.employer &&
        d.amount > 0
      )
        s += d.amount * ownerShare(d.owner, person.id, x.people);
    return s;
  })();
  const credits = (() => {
    let s = 0;
    for (const d of input.deductions)
      if (d.kind === "credit" && d.amount > 0)
        s += d.amount * ownerShare(d.owner, person.id, x.people);
    return s;
  })();

  // ---- CPP/QPP and EI (employee; self-employed pay both halves of CPP, no EI)
  const cp = C.cpp;
  const cppBaseRate = x.year >= 2027 ? cp.baseRateFrom2027 : cp.baseRate;
  // CPP contributions stop at 70; QPP has no such age in this model.
  const contributes = x.quebec || person.age < cp.maxAge;
  const rate = !contributes ? 0 : x.quebec ? cp.qppRate : cppBaseRate + cp.enhancedRate;
  const baseShare = rate > 0 ? (x.quebec ? cp.qppBaseRate : cppBaseRate) / rate : 0;
  const cpp2Rate = contributes ? cp.cpp2Rate : 0;
  const ympe = cp.ympe * fs;
  const yampe = cp.yampe * fs;
  const exempt = cp.basicExemption * x.scale;
  const pensionable = (e: number) => rate * clamp0(Math.min(e, ympe) - exempt);
  const cpp2 = (e: number) => cpp2Rate * clamp0(Math.min(e, yampe) - ympe);
  const wage = b.wage;
  const se = b.selfEmployment;
  const empCpp = pensionable(wage);
  const empCpp2 = cpp2(wage);
  // Self-employed: both halves on SE earnings above what wages already covered.
  const seCpp = se > 0 ? 2 * rate * clamp0(Math.min(wage + se, ympe) - Math.max(wage, exempt)) : 0;
  const seCpp2 =
    se > 0 ? 2 * cpp2Rate * clamp0(Math.min(wage + se, yampe) - Math.max(wage, ympe)) : 0;
  const cppTotal = empCpp + empCpp2 + seCpp + seCpp2;
  // Employee (and SE employee-half) base contributions earn a credit; enhanced portions, CPP2 and
  // the SE employer half are deductions.
  const cppCreditBase = (empCpp + seCpp / 2) * baseShare;
  const cppDeduction = (empCpp + seCpp / 2) * (1 - baseShare) + empCpp2 + seCpp / 2 + seCpp2;
  const ei = Math.min(wage, C.ei.maxInsurable * fs) * (x.quebec ? C.ei.quebecRate : C.ei.rate);

  // ---- income
  const eligGross = (b.caEligible + b.untaggedQualified) * (1 + C.dividends.grossUpEligible);
  const nonEligGross =
    (b.caNonEligible + b.untaggedOrdinary) * (1 + C.dividends.grossUpNonEligible);
  const foreignDiv = b.auFranked + b.auUnfranked;
  const gains = (b.gainsLong + b.gainsShort) * C.capitalGainsInclusion;
  const nonGovPension = clamp0(b.pension - oas - cppBenefit);
  const eligiblePension = nonGovPension + (person.age >= 65 ? b.deferredWithdrawals : 0);
  const netIncome = clamp0(
    wage +
      se +
      b.pension +
      b.socialSecurity +
      b.ordinary +
      b.interest +
      b.rental +
      eligGross +
      nonEligGross +
      foreignDiv +
      gains +
      b.deferredWithdrawals +
      splitIn -
      rrsp -
      cppDeduction,
  );
  const clawback = Math.min(
    oas,
    C.oas.clawbackRate * clamp0(netIncome - C.oas.clawbackThreshold * fs),
  );
  // Net income at line 23600 is after the OAS repayment deduction (line 23500); with no other
  // deductions it equals taxable income. The BPA and age amounts are tested against it.
  const taxable = clamp0(netIncome - clawback);
  const net23600 = taxable;
  const pensionForCredit = clamp0(eligiblePension + splitIn);

  // ---- federal
  const F = C.federal;
  const fb = bands(F.brackets, fs);
  const basic = sliceTax(fb, 0, taxable).tax;
  const bpa = federalBpa(net23600, fs);
  const age =
    person.age >= 65
      ? clamp0(F.ageAmount * fs - F.ageReductionRate * clamp0(net23600 - F.ageThreshold * fs))
      : 0;
  const pens = Math.min(pensionForCredit, F.pensionAmount * fs);
  const emp = Math.min(wage, F.canadaEmploymentAmount * fs);
  const nonRef =
    F.creditRate * (bpa + age + pens + emp + cppCreditBase + ei) + F.creditRate * credits;
  const dtc = eligGross * F.dtcEligible + nonEligGross * F.dtcNonEligible;
  const federal = clamp0(basic - nonRef - dtc);
  const quebecAbatement = x.quebec ? federal * F.quebecAbatement : 0;

  // ---- provincial
  let provincial = 0;
  let ontarioSurtax = 0;
  let ontarioHealth = 0;
  const P = x.prov;
  if (withProvince && P) {
    const pfs = x.pfs;
    const pb = bands(P.brackets, pfs);
    const pbasic = sliceTax(pb, 0, taxable).tax;
    const lowRate = P.brackets[0]![1];
    const pAge =
      person.age >= 65
        ? clamp0(P.ageAmount * pfs - 0.15 * clamp0(net23600 - P.ageThreshold * pfs))
        : 0;
    const pSenior = person.age >= 65 && P.seniorSupplement ? P.seniorSupplement * pfs : 0;
    const pPens = Math.min(pensionForCredit, P.pensionAmount * pfs);
    const pCredits =
      lowRate *
      (provincialBpa(P, x, net23600) +
        pAge +
        pSenior +
        pPens +
        (x.quebec ? 0 : cppCreditBase + ei));
    const pDtc = eligGross * P.dtcEligible + nonEligGross * P.dtcNonEligible;
    const afterCredits = clamp0(pbasic - pCredits);
    provincial = clamp0(afterCredits - pDtc);
    if (P.code === "ON") {
      // ON428 Part C: the surtax is worked on Ontario tax after non-refundable credits and before
      // the dividend tax credit (lines 62-71); any credit left over after basic tax reduces it.
      let surtax = 0;
      for (const [thr, r] of ONTARIO_2026.surtax) surtax += r * clamp0(afterCredits - thr * pfs);
      ontarioSurtax = clamp0(afterCredits + surtax - pDtc) - provincial;
      for (const [from, at, slope, cap] of ONTARIO_2026.healthPremium)
        if (taxable > from * x.scale)
          ontarioHealth = Math.min(cap, at + slope * (taxable - from * x.scale)) * x.scale;
    }
  }
  const gross =
    wage +
    se +
    b.pension +
    b.socialSecurity +
    b.ordinary +
    b.interest +
    b.rental +
    b.qualifiedDividends +
    b.ordinaryDividends +
    b.gainsLong +
    b.gainsShort +
    b.deferredWithdrawals +
    b.deferredTaxFree;
  return {
    netIncome,
    taxable,
    clawback,
    oas,
    eligiblePension,
    federal,
    quebecAbatement,
    provincial,
    ontarioSurtax,
    ontarioHealth,
    cpp: cppTotal,
    ei,
    gross,
  };
}

const totalOf = (p: PersonCalc, prov: boolean) =>
  p.federal -
  p.quebecAbatement +
  p.clawback +
  (prov ? p.provincial + p.ontarioSurtax + p.ontarioHealth : 0);

function isCouple(input: TaxYearInput, x: Ctx): boolean {
  return x.people.length === 2 && input.filingStatus !== "single";
}

/** Choose the pension split (5% steps up to 50%) minimising federal + provincial tax. */
function chooseSplit(input: TaxYearInput, x: Ctx): number[] {
  const n = x.people.length;
  const none = new Array<number>(n).fill(0);
  if (!isCouple(input, x) || !(input.config.lawToggles["ca.pensionSplitting"] ?? true)) return none;
  const base = x.people.map((p) => personCalc(input, x, p, 0, true));
  let best = none;
  let bestTax = base.reduce((s, p) => s + totalOf(p, true), 0);
  for (const from of [0, 1]) {
    const to = 1 - from;
    const elig = base[from]!.eligiblePension;
    if (elig <= 0) continue;
    for (let k = 1; k <= 10; k++) {
      const amt = elig * 0.05 * k;
      const split = [0, 0];
      split[from] = -amt;
      split[to] = amt;
      const t = x.people.reduce(
        (s, p, i) => s + totalOf(personCalc(input, x, p, split[i]!, true), true),
        0,
      );
      if (t < bestTax - 1e-9) {
        bestTax = t;
        best = split;
      }
    }
  }
  return best;
}

function splitFromFacts(prior: TaxYearOutput[], x: Ctx): number[] {
  return x.people.map((p) => {
    for (let i = prior.length - 1; i >= 0; i--) {
      const v = prior[i]!.facts[`ca.pensionSplitIn.${p.id}`];
      if (v !== undefined) return v;
    }
    return 0;
  });
}

function computeFederal(input: TaxYearInput): { out: TaxYearOutput; total: number } {
  const x = context(input);
  const split = chooseSplit(input, x);
  const sink = new LineSink("ca-federal");
  const facts: Record<string, number> = {
    "tax.year": input.year,
    "tax.priceIndex": input.priceIndex,
  };
  let taxable = 0;
  let gross = 0;
  const multi = x.people.length > 1;
  x.people.forEach((p, i) => {
    const r = personCalc(input, x, p, split[i]!, false);
    const sfx = multi ? ` (${p.id})` : "";
    sink.add("income", `Federal income tax${sfx}`, r.federal, r.taxable);
    sink.add("credit", `Quebec abatement${sfx}`, -r.quebecAbatement);
    sink.add("other", `OAS recovery tax${sfx}`, r.clawback, r.oas);
    sink.add("payroll", `${x.quebec ? "QPP" : "CPP"} contributions${sfx}`, r.cpp);
    sink.add("payroll", `EI premiums${sfx}`, r.ei);
    facts[`ca.netIncome.${p.id}`] = r.netIncome;
    facts[`ca.taxableIncome.${p.id}`] = r.taxable;
    facts[`ca.pensionSplitIn.${p.id}`] = split[i]!;
    const fr = r.taxable > 0 ? sliceTax(bands(C.federal.brackets, x.fs), 0, r.taxable).marginal : 0;
    facts[`tax.ordinaryBracketRate.${p.id}`] = fr;
    if (i === 0) facts["tax.ordinaryBracketRate"] = fr;
    taxable += r.taxable;
    gross += r.gross;
  });
  const penalty = input.withdrawals.reduce(
    (s, w) => s + clamp0(w.taxableAmount) * w.penaltyRate,
    0,
  );
  sink.add("penalty", "Early withdrawal penalty", penalty);
  return {
    out: { lines: sink.lines, grossIncome: gross, taxableIncome: taxable, marginalRate: 0, facts },
    total: sink.total(),
  };
}

function computeProvince(
  input: TaxYearInput,
  prior: TaxYearOutput[],
  code?: string,
): TaxYearOutput {
  const x = context(input, code);
  if (!x.prov) throw new ScenarioError("ca-province needs a province code (location.region)", {});
  const split = prior.length > 0 ? splitFromFacts(prior, x) : chooseSplit(input, x);
  const id = `ca-province:${x.prov.code}`;
  const sink = new LineSink(id);
  let taxable = 0;
  let marginal = 0;
  const multi = x.people.length > 1;
  x.people.forEach((p, i) => {
    const r = personCalc(input, x, p, split[i]!, true);
    const sfx = multi ? ` (${p.id})` : "";
    sink.add("income", `${x.prov!.name} income tax${sfx}`, r.provincial, r.taxable);
    sink.add("income", `Ontario surtax${sfx}`, r.ontarioSurtax);
    sink.add("other", `Ontario Health Premium${sfx}`, r.ontarioHealth);
    taxable += r.taxable;
    if (i === 0) {
      const pb = bands(x.prov!.brackets, x.pfs);
      for (const band of pb) if (r.taxable > band.from) marginal = band.rate;
    }
  });
  return {
    lines: sink.lines,
    grossIncome: 0,
    taxableIncome: taxable,
    marginalRate: marginal,
    facts: { ...x.pFacts },
  };
}

function caContributionLimit(q: TaxContributionLimitQuery): number | null {
  const L = C.limits;
  const f = q.year > C.year ? q.priceIndex : 1;
  if (q.accountType === "ca-rrsp")
    return q.ownerAge > 71 ? 0 : Math.min(L.rrspMax * f, L.rrspRate * q.earnedIncome);
  if (q.accountType === "ca-tfsa") return q.ownerAge >= 18 ? L.tfsa * f : 0;
  if (q.accountType === "ca-fhsa") return L.fhsa;
  return null;
}

/** RRIF minimum (also used for LIF/LIRA-converted accounts). */
export function caRrifMinimum(q: RequiredDistributionQuery): number {
  if (q.accountType !== "ca-rrif" && q.rule !== "ca-rrif" && q.rule !== "ca-rrif-minimum") return 0;
  const age = Math.floor(q.ownerAge);
  const factor =
    age < 71 ? 1 / Math.max(1, 90 - age) : age >= 95 ? 0.2 : (RRIF_FACTORS[age] ?? 0.2);
  return clamp0(q.priorYearEndBalance) * factor;
}

export const caFederalJurisdiction: TaxJurisdiction = {
  id: "ca-federal",
  label: "Canada federal (income tax, CPP/QPP, EI, OAS recovery)",
  level: "national",
  country: "CA",
  status: "implemented",
  owner: "b",
  computeYear(input) {
    const { out } = computeFederal(input);
    out.marginalRate = finiteMarginal((i) => computeFederal(i).total, input, "ordinary");
    return out;
  },
  contributionLimit: caContributionLimit,
  requiredDistribution: caRrifMinimum,
  // Principal residence exemption: the gain on a main home is exempt.
  homeSaleExclusion: () => Number.POSITIVE_INFINITY,
  defaultCharacter: defaultCharacterForIncomeType,
  lawToggles: [
    { id: "ca.pensionSplitting", label: "Optimise pension income splitting", default: true },
  ],
  sources: C.sources.map((s) => ({ taxYear: "2026", ...s })),
  simplifications: CA_FEDERAL_SIMPLIFICATIONS,
};

/** The general provincial list, plus the approximation noted for this province's row, if any. */
function provinceSimplifications(code?: string): readonly string[] {
  const row = code ? CA_PROVINCE_BY_CODE[code] : undefined;
  return row?.approx
    ? [...CA_PROVINCE_SIMPLIFICATIONS, `${row.name}: ${row.approx}.`]
    : CA_PROVINCE_SIMPLIFICATIONS;
}

function makeProvince(code?: string): TaxJurisdiction {
  return {
    id: code ? `ca-province:${code}` : "ca-province",
    label: code ? `Canada provincial (${code})` : "Canada provincial",
    level: "state",
    country: "CA",
    status: "implemented",
    owner: "b",
    computeYear: (input, prior) => computeProvince(input, prior, code),
    parameterize: (p) => makeProvince(p.toUpperCase()),
    sources: C.sources.map((s) => ({ taxYear: "2026", ...s })),
    simplifications: provinceSimplifications(code),
  };
}

export const caProvinceJurisdiction = makeProvince();
