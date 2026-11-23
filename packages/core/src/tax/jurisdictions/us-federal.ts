/**
 * US federal income tax: brackets by filing status, standard (incl. 65+) vs itemised deduction,
 * OBBBA senior deduction, taxable Social Security (IRC §86), QBI (simplified), LTCG/qualified
 * dividend stacking (0/15/20), NIIT, AMT (no preference items beyond the standard deduction),
 * child tax credit, ACA premium tax credit with reconciliation, IRMAA (2-year MAGI look-back via
 * `history`), early-withdrawal penalty, RMDs and contribution limits. Data: ../data/us-federal.ts.
 */

import {
  accountCountry,
  alivePeople,
  type Band,
  bands,
  clamp0,
  collectIncome,
  finiteMarginal,
  householdDependents,
  LineSink,
  periodScale,
  pickYear,
  sliceTax,
  sumDeductions,
} from "../common.js";
import { US_FEDERAL_SIMPLIFICATIONS } from "../data/anglo.js";
import {
  UNIFORM_LIFETIME,
  US_ACA_YEARS,
  US_FEDERAL_SUNSET_2026,
  US_FEDERAL_YEARS,
  US_FIXED,
  US_IRMAA_2026,
  US_IRMAA_YEARS,
  US_LIMITS_YEARS,
  type UsAcaYear,
  type UsFederalYear,
  type UsIrmaaYear,
  usRmdStartAge,
} from "../data/us-federal.js";
import type {
  BracketFill,
  HomeSaleQuery,
  PensionAccessQuery,
  RequiredDistributionQuery,
  TaxContributionLimitQuery,
  TaxJurisdiction,
  TaxYearInput,
  TaxYearOutput,
} from "../types.js";
import { defaultCharacterForIncomeType } from "./flat.js";
import { usTable } from "./us-index.js";
import { usPayroll } from "./us-payroll.js";

const ID = "us-federal";

const toggle = (input: TaxYearInput, id: string, def: boolean) =>
  input.config.lawToggles[id] ?? def;

export function taxableSocialSecurity(
  benefits: number,
  otherIncome: number,
  status: TaxYearInput["filingStatus"],
  scale = 1,
): number {
  if (benefits <= 0) return 0;
  const S = US_FIXED.socialSecurity;
  const prov = otherIncome + 0.5 * benefits;
  const kind =
    status === "married-joint" ? "joint" : status === "married-separate" ? "separate" : "other";
  const b1 = S.base1[kind] * scale;
  const b2 = S.base2[kind] * scale;
  if (kind === "separate") return Math.min(0.85 * benefits, 0.85 * clamp0(prov));
  if (prov <= b1) return 0;
  if (prov <= b2) return Math.min(0.5 * benefits, 0.5 * (prov - b1));
  return Math.min(0.85 * benefits, 0.85 * (prov - b2) + Math.min(0.5 * benefits, 0.5 * (b2 - b1)));
}

function irmaaTable(status: TaxYearInput["filingStatus"], t: UsIrmaaYear) {
  if (status === "married-joint") return t.joint;
  if (status === "married-separate") return t.separate;
  return t.single;
}

/**
 * Monthly IRMAA surcharge (Part B above standard + Part D) for a MAGI. Tiers are cliffs.
 * `table` defaults to 2026; pass the year's table (US_IRMAA_YEARS) for other years.
 */
export function irmaaMonthly(
  magi: number,
  status: TaxYearInput["filingStatus"],
  factor = 1,
  table: UsIrmaaYear = US_IRMAA_2026,
): number {
  let s = 0;
  for (const [lo, b, d] of irmaaTable(status, table))
    if (magi > lo * factor) s = (b - table.standardPartB + d) * factor;
  return s;
}

/** IRMAA tier thresholds (MAGI upper bounds before each surcharge tier), indexed. */
export function irmaaThresholds(
  status: TaxYearInput["filingStatus"],
  factor = 1,
  table: UsIrmaaYear = US_IRMAA_2026,
): number[] {
  return irmaaTable(status, table).map(([lo]) => lo * factor);
}

/** The living adults on the federal return: both spouses when filing jointly, else one person. */
export function returnFilers(input: TaxYearInput): TaxYearInput["people"] {
  const people = alivePeople(input);
  return input.filingStatus === "married-joint" ? people : people.slice(0, 1);
}

/**
 * ACA household size for the poverty line: the size set on the ACA expense when there is one,
 * otherwise the tax household (the living adults on the return plus the household's dependents this
 * year, the same list the child tax credit counts from).
 */
export function acaHouseholdSize(input: TaxYearInput): number {
  return input.aca?.householdSize ?? returnFilers(input).length + householdDependents(input).length;
}

export function federalPovertyLine(
  householdSize: number,
  factor = 1,
  table: UsAcaYear = US_ACA_YEARS[0]!,
): number {
  return (table.fpl.first + table.fpl.additional * Math.max(0, householdSize - 1)) * factor;
}

/**
 * Applicable percentage for a household income as a multiple of the poverty line, or null when no
 * credit is allowed (below 100% or above 400%; Form 8962 line 5 rounds down to a whole percentage).
 */
export function acaApplicablePercentage(
  fplMultiple: number,
  enhanced: boolean,
  aca: UsAcaYear = US_ACA_YEARS[0]!,
): number | null {
  const table = enhanced ? aca.enhanced : aca.applicable;
  if (fplMultiple < aca.floor) return null;
  if (!enhanced && Math.floor(fplMultiple * 100 + 1e-9) > aca.cliff * 100) return null;
  let row = table[0]!;
  let next: (typeof table)[number] | undefined;
  for (let i = 0; i < table.length; i++)
    if (fplMultiple >= table[i]![0]) {
      row = table[i]!;
      next = table[i + 1];
    }
  if (!next) return row[2];
  const t = (fplMultiple - row[0]) / (next[0] - row[0]);
  return row[1] + (row[2] - row[1]) * Math.min(1, Math.max(0, t));
}

interface FedCore {
  out: TaxYearOutput;
  total: number;
}

function yearData(input: TaxYearInput): { d: UsFederalYear; f: number } {
  const t = usTable(US_FEDERAL_YEARS, input);
  return toggle(input, "us.tcjaSunset", false)
    ? { d: US_FEDERAL_SUNSET_2026, f: usTable([US_FEDERAL_SUNSET_2026], input).factor }
    : { d: t.row, f: t.factor };
}

function computeFederal(input: TaxYearInput, explain: boolean): FedCore {
  const { d, f } = yearData(input);
  const status = input.filingStatus;
  const scale = periodScale(input);
  const fs = f * scale;
  const people = alivePeople(input);
  const b = collectIncome(input, ID);
  const payroll = usPayroll(input);

  // ---- income
  const aboveLine = sumDeductions(input, "deduction", { level: "federal", itemized: false });
  const itemizedItems = sumDeductions(input, "deduction", { level: "federal", itemized: true });
  const userCredits = sumDeductions(input, "credit", { level: "federal" });
  const ordinaryIncome =
    b.wage +
    b.selfEmployment +
    b.pension +
    b.ordinary +
    b.interest +
    b.ordinaryDividends +
    b.rental +
    b.gainsShort +
    b.deferredWithdrawals;
  const prefIncome = b.qualifiedDividends + b.gainsLong;
  const preTaxClaimed = sumDeductions(input, "pre-tax-contribution", { level: "federal" });
  const ira = iraDeductionPhaseout(input, {
    agiExSsBeforeIra:
      ordinaryIncome +
      prefIncome -
      aboveLine -
      payroll.seDeduction -
      (preTaxClaimed - traditionalIraTotal(input)),
    socialSecurity: b.socialSecurity,
    scale,
  });
  const preTax = preTaxClaimed - ira.nondeductible;
  const agiExSs = ordinaryIncome + prefIncome - preTax - aboveLine - payroll.seDeduction;
  const taxableSs = taxableSocialSecurity(b.socialSecurity, agiExSs, status, scale);
  const agi = agiExSs + taxableSs;
  const magi = agi;
  const acaMagi = agi + (b.socialSecurity - taxableSs);

  // ---- deductions
  const married =
    status === "married-joint" ||
    status === "married-separate" ||
    status === "qualifying-surviving-spouse";
  const filers = returnFilers(input);
  const dependents = householdDependents(input);
  const n65 = filers.filter((p) => p.age >= 65).length;
  // Non-resident aliens (cross-border source tax) cannot claim the standard deduction
  // (Publication 519, chapter 5).
  const nonResidentAlien =
    !!input.nonResident &&
    filers.every((p) => input.nonResident!.personalAllowance[p.id] === false);
  const standard = nonResidentAlien
    ? 0
    : d.standardDeduction[status] * fs +
      n65 * (married ? d.additionalAged.married : d.additionalAged.unmarried) * fs;
  const itemizing = itemizedItems > standard;
  const deduction = Math.max(standard, itemizedItems);
  const exemptions =
    d.personalExemption * fs * (filers.length + dependents.filter((x) => x.age < 19).length);
  let senior = 0;
  if (
    d.seniorDeduction &&
    input.year <= d.seniorDeduction.lastYear &&
    !d.seniorDeduction.notAllowed.includes(status) &&
    toggle(input, "us.obbbaSeniorDeduction", true)
  ) {
    const S = d.seniorDeduction;
    const red = S.phaseoutRate * clamp0(magi - S.phaseoutStart[status] * scale);
    senior = n65 * clamp0(S.amount * scale - red);
  }
  const preQbi = clamp0(agi - deduction - exemptions - senior);
  // QBI: 20% of SE income (net of half SE tax), capped at 20% of taxable income less net capital
  // gain; phased out over the phase-in range above the threshold (treated as a service business).
  let qbi = 0;
  const qbiBase = clamp0(b.selfEmployment - payroll.seDeduction);
  if (qbiBase > 0 && toggle(input, "us.qbi", true)) {
    const thr = d.qbi.threshold[status] * fs;
    const range = d.qbi.phaseInRange[status] * fs;
    const phase = Math.max(0, Math.min(1, (preQbi - thr) / range));
    qbi = Math.min(0.2 * qbiBase * (1 - phase), 0.2 * clamp0(preQbi - prefIncome));
  }
  const taxable = clamp0(preQbi - qbi);
  const pref = Math.min(prefIncome, taxable);
  const ordTaxable = taxable - pref;

  // ---- regular tax
  const fill: BracketFill[] = [];
  const ordBands: Band[] = bands(d.brackets[status], fs);
  const of: BracketFill["bands"] | undefined = explain ? [] : undefined;
  const ord = sliceTax(ordBands, 0, ordTaxable, of);
  if (of) fill.push({ jurisdictionId: ID, schedule: "ordinary", bands: of });
  const cg = d.capitalGains[status];
  const prefBands: Band[] = [
    { from: 0, rate: 0, label: "0%" },
    { from: cg.zeroMax * fs, rate: 0.15, label: "15%" },
    { from: cg.fifteenMax * fs, rate: 0.2, label: "20%" },
  ];
  const pf: BracketFill["bands"] | undefined = explain ? [] : undefined;
  const prefTax = sliceTax(prefBands, ordTaxable, pref, pf).tax;
  if (pf) fill.push({ jurisdictionId: ID, schedule: "preferential", bands: pf });
  const regular = ord.tax + prefTax;

  // ---- AMT (standard deduction added back; no other preference items modelled)
  let amt = 0;
  let amtExemption = 0;
  if (toggle(input, "us.amt", true)) {
    const amti = taxable + (itemizing ? 0 : deduction) + exemptions + senior;
    const ex = clamp0(
      d.amt.exemption[status] * fs -
        d.amt.phaseoutRate * clamp0(amti - d.amt.phaseoutStart[status] * fs),
    );
    amtExemption = ex;
    const base = clamp0(amti - ex);
    const amtPref = Math.min(pref, base);
    const amtOrd = base - amtPref;
    const bp = d.amt.breakpoint28[status] * fs;
    const tmtOrd = 0.26 * Math.min(amtOrd, bp) + 0.28 * clamp0(amtOrd - bp);
    const tmt = tmtOrd + sliceTax(prefBands, amtOrd, amtPref).tax;
    amt = clamp0(tmt - regular);
  }

  // ---- NIIT (thresholds statutory, not indexed)
  const nii =
    b.interest + b.qualifiedDividends + b.ordinaryDividends + b.gainsLong + b.gainsShort + b.rental;
  const niit =
    US_FIXED.niit.rate * Math.min(nii, clamp0(magi - US_FIXED.niit.threshold[status] * scale));

  // ---- credits
  const beforeCredits = regular + amt;
  const kids = dependents.filter((x) => x.age < 17).length;
  let ctc = 0;
  let ctcRefundable = 0;
  if (kids > 0) {
    const C = d.childTaxCredit;
    const full = clamp0(
      kids * C.perChild * f * scale - 0.05 * clamp0(magi - C.phaseoutStart[status] * scale),
    );
    const nonRef = Math.min(full, beforeCredits);
    const earned = b.wage + b.selfEmployment;
    ctcRefundable = Math.min(
      full - nonRef,
      kids * C.refundable * fs,
      0.15 * clamp0(earned - 2_500 * scale),
    );
    ctc = nonRef + ctcRefundable;
  }
  const other = Math.min(userCredits, clamp0(beforeCredits - (ctc - ctcRefundable)));

  // ---- ACA premium tax credit
  let ptc = 0;
  let fplMultiple = 0;
  let acaSize = 0;
  let acaLine: { kind: "credit" | "aca-reconciliation"; amount: number } | null = null;
  if (input.aca && input.aca.benchmarkPremium > 0) {
    const aca = usTable(US_ACA_YEARS, input);
    acaSize = acaHouseholdSize(input);
    const fpl = federalPovertyLine(acaSize, aca.factor, aca.row);
    fplMultiple = acaMagi / scale / fpl;
    const pct = acaApplicablePercentage(
      fplMultiple,
      toggle(input, "us.acaEnhanced", false),
      aca.row,
    );
    ptc = pct === null ? 0 : clamp0(input.aca.benchmarkPremium - pct * acaMagi);
    acaLine =
      input.aca.advanceCredit !== undefined
        ? { kind: "aca-reconciliation", amount: input.aca.advanceCredit - ptc }
        : { kind: "credit", amount: -ptc };
  }

  // ---- IRMAA (Medicare premium surcharge, 2-year MAGI look-back)
  let irmaa = 0;
  const onMedicare = people.filter((p) => p.age >= 65).length;
  let lookbackMagi = magi;
  if (onMedicare > 0 && toggle(input, "us.irmaa", true)) {
    const h = input.history;
    lookbackMagi = h[h.length - 2]?.magi ?? h[h.length - 1]?.magi ?? magi;
    const t = usTable(US_IRMAA_YEARS, input);
    irmaa = onMedicare * irmaaMonthly(lookbackMagi, status, t.factor, t.row) * 12 * scale;
  }

  // ---- early-withdrawal penalty (US and generic accounts only)
  let penalty = 0;
  for (const w of input.withdrawals) {
    const c = accountCountry(w.accountType);
    if (w.penaltyRate > 0 && (c === "US" || c === undefined) && !w.isConversion)
      penalty += clamp0(w.taxableAmount) * w.penaltyRate;
  }

  // ---- lines
  const sink = new LineSink(ID);
  sink.add("income", "Federal income tax", ord.tax, ordTaxable);
  const prefDiv = prefIncome > 0 ? (prefTax * b.qualifiedDividends) / prefIncome : 0;
  sink.add("dividends", "Qualified dividends tax", prefDiv, b.qualifiedDividends);
  sink.add("capital-gains", "Long-term capital gains tax", prefTax - prefDiv, b.gainsLong);
  sink.add("amt", "Alternative minimum tax", amt);
  sink.add("niit", "Net investment income tax", niit, nii);
  sink.add("credit", "Child tax credit", -ctc);
  sink.add("credit", "Other credits", -other);
  if (acaLine)
    sink.add(
      acaLine.kind,
      acaLine.kind === "credit"
        ? "ACA premium tax credit"
        : "ACA premium tax credit reconciliation",
      acaLine.amount,
    );
  sink.add("irmaa", "Medicare IRMAA surcharge", irmaa, lookbackMagi);
  sink.add("penalty", "Early withdrawal penalty", penalty);

  const facts: Record<string, number> = {
    "tax.year": input.year,
    "tax.priceIndex": input.priceIndex,
    agi,
    magi,
    "us.acaMagi": acaMagi,
    "us.taxableIncome": taxable,
    "us.ordinaryTaxableIncome": ordTaxable,
    "us.preferentialIncome": pref,
    "us.taxableSocialSecurity": taxableSs,
    "us.deduction": deduction,
    "us.itemizing": itemizing ? 1 : 0,
    "us.seniorDeduction": senior,
    "us.qbiDeduction": qbi,
    "us.amtExemption": amtExemption,
    "us.seTaxDeduction": payroll.seDeduction,
    "us.ptc": ptc,
    // Income tax after credits (Form 1040 line 22 plus NIIT, less refundable child credit): the
    // base of the state deductions for federal income tax (Alabama, Missouri).
    "us.federalIncomeTax": clamp0(
      beforeCredits - (ctc - ctcRefundable) - other + niit - ctcRefundable,
    ),
    "tax.ordinaryBracketRate": ordTaxable > 0 ? ord.marginal : 0,
  };
  if (fplMultiple > 0) facts["us.fplMultiple"] = fplMultiple;
  if (acaSize > 0) {
    facts["us.acaHouseholdSize"] = acaSize;
    facts["us.acaHouseholdSizeAuto"] = input.aca?.householdSize === undefined ? 1 : 0;
  }
  if (irmaa > 0) facts["us.irmaaMagi"] = lookbackMagi;
  if (ira.nondeductible > 0) {
    facts["us.iraMagi"] = ira.magi;
    facts["us.iraNondeductible"] = ira.nondeductible;
    for (const [owner, v] of ira.byOwner) facts[`us.iraNondeductible.${owner}`] = v;
  }
  const gross = ordinaryIncome + prefIncome + b.socialSecurity + b.deferredTaxFree;
  const out: TaxYearOutput = {
    lines: sink.lines,
    grossIncome: gross,
    taxableIncome: taxable,
    marginalRate: 0,
    facts,
  };
  if (explain) out.brackets = fill;
  return { out, total: sink.total() };
}

/** Traditional IRA contributions this period that claim a federal deduction (not employer money). */
function traditionalIraItems(input: TaxYearInput) {
  return input.deductions.filter(
    (d) =>
      d.kind === "pre-tax-contribution" &&
      d.accountType === "traditional-ira" &&
      !d.employer &&
      d.amount > 0 &&
      d.levels.includes("federal"),
  );
}

function traditionalIraTotal(input: TaxYearInput): number {
  return traditionalIraItems(input).reduce((s, d) => s + d.amount, 0);
}

/**
 * IRC 219(g): the traditional IRA deduction limit of a person who, or whose spouse, is an active
 * participant in a workplace plan is reduced in proportion to MAGI above the applicable dollar
 * amount; the part of a contribution above the reduced limit is nondeductible (it stays in the
 * IRA as basis). 26 U.S.C. 219(g)(1)-(3), (7), (8), United States Code 2024 edition,
 * https://www.govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleA-chap1-subchapB-partVII-sec219.htm
 * (read 2026-11-23). Ranges: IR-2025-111 (2026) and IR-2026-136 (2027), in US_LIMITS_YEARS,
 * indexed after 2027 like the other US tables (us-index.ts).
 *
 * MAGI is AGI without the IRA deduction (219(g)(3)(A)), with taxable Social Security figured
 * before the IRA deduction, as in Pub. 590-A Appendix B, Worksheet 1
 * (https://www.irs.gov/publications/p590a, read 2026-11-23). The exclusions 219(g)(3)(A) adds
 * back (85(c), 135, 137, 221, 911) are not modelled by the engine, so none are added back.
 * Each spouse's deduction is figured separately (Pub. 590-A, "How To Figure Your Reduced IRA
 * Deduction").
 */
export function iraDeductionPhaseout(
  input: TaxYearInput,
  o: { agiExSsBeforeIra: number; socialSecurity: number; scale: number },
): { magi: number; nondeductible: number; byOwner: Map<string, number> } {
  const byOwner = new Map<string, number>();
  const items = traditionalIraItems(input);
  if (items.length === 0) return { magi: 0, nondeductible: 0, byOwner };
  const contributed = new Map<string, number>();
  for (const d of items) contributed.set(d.owner, (contributed.get(d.owner) ?? 0) + d.amount);
  const status = input.filingStatus;
  const magi =
    o.agiExSsBeforeIra +
    taxableSocialSecurity(o.socialSecurity, o.agiExSsBeforeIra, status, o.scale);
  const { row: L, factor: f } = usTable(US_LIMITS_YEARS, input);
  const R = US_FIXED.iraDeduction;
  const married = status === "married-joint" || status === "married-separate";
  const joint = status === "married-joint" || status === "qualifying-surviving-spouse";
  let nondeductible = 0;
  for (const [owner, amount] of contributed) {
    const person = input.people.find((p) => p.id === owner);
    if (!person) continue;
    const covered = !!person.activeParticipant;
    const spouseCovered =
      married && input.people.some((p) => p.id !== owner && p.alive && p.activeParticipant);
    if (!covered && !spouseCovered) continue;
    // Applicable dollar amount and phase-out range (219(g)(2)(A)(ii), (g)(3)(B), (g)(7)).
    let start: number;
    let range: number;
    if (status === "married-separate") {
      start = R.separateStart;
      range = R.range.other;
    } else if (!covered) {
      start = L.iraDeductionPhaseout.spouseNotCovered * f;
      range = R.range.spouseNotCovered;
    } else if (joint) {
      start = L.iraDeductionPhaseout.joint * f;
      range = R.range.joint;
    } else {
      start = L.iraDeductionPhaseout.other * f;
      range = R.range.other;
    }
    // In annual terms: the deductible amount with the 50+ catch-up (219(b)(5)), MAGI annualised.
    const dollarLimit = (L.ira + (person.age >= 50 ? L.iraCatchUp : 0)) * f;
    const excess = clamp0((o.scale > 0 ? magi / o.scale : magi) - start);
    let reduced = 0;
    if (excess < range) {
      const reduction = Math.floor((dollarLimit * excess) / range / R.rounding + 1e-9) * R.rounding;
      reduced = clamp0(dollarLimit - reduction);
      if (reduced > 0 && reduced < R.minimum) reduced = R.minimum;
    }
    const nd = clamp0(amount - reduced * o.scale);
    if (nd > 0) {
      byOwner.set(owner, nd);
      nondeductible += nd;
    }
  }
  return { magi, nondeductible, byOwner };
}

function totalOnly(input: TaxYearInput): number {
  return computeFederal(input, false).total;
}

function computeYear(input: TaxYearInput, explain: boolean): TaxYearOutput {
  const { out } = computeFederal(input, explain);
  out.marginalRate = finiteMarginal(totalOnly, input, "ordinary");
  return out;
}

const DEFERRAL_401K = new Set([
  "401k",
  "roth-401k",
  "403b",
  "roth-403b",
  "457b",
  "roth-457b",
  "tsp",
  "roth-tsp",
  "solo-401k",
]);
const IRA = new Set(["traditional-ira", "roth-ira"]);
const RMD_TYPES = new Set([
  "traditional-ira",
  "sep-ira",
  "simple-ira",
  "401k",
  "403b",
  "457b",
  "401a",
  "solo-401k",
  "tsp",
  "generic-tax-deferred",
]);

export function usContributionLimit(q: TaxContributionLimitQuery): number | null {
  const L = pickYear(US_LIMITS_YEARS, q.year);
  // The query carries no history, so later years index from the plan start (may run ahead of
  // the IRS by the years between the plan start and the latest published year).
  const f = q.year > L.year ? q.priceIndex : 1;
  const age = q.ownerAge;
  if (DEFERRAL_401K.has(q.accountType)) {
    const catchUp = age >= 60 && age < 64 ? L.catchUp60to63 : age >= 50 ? L.catchUp50 : 0;
    return (L.electiveDeferral + catchUp) * f;
  }
  if (IRA.has(q.accountType))
    return Math.min((L.ira + (age >= 50 ? L.iraCatchUp : 0)) * f, q.earnedIncome);
  if (q.accountType === "simple-ira") {
    const catchUp = age >= 60 && age < 64 ? L.simpleCatchUp60to63 : age >= 50 ? L.simpleCatchUp : 0;
    return (L.simple + catchUp) * f;
  }
  if (q.accountType === "sep-ira") return Math.min(L.sepOrSoloTotal * f, 0.25 * q.earnedIncome);
  if (q.accountType === "hsa")
    return (
      ((q.coverage === "family" ? L.hsa.family : L.hsa.self) + (age >= 55 ? L.hsa.catchUp55 : 0)) *
      f
    );
  return null;
}

export function usRequiredDistribution(q: RequiredDistributionQuery): number {
  if (!RMD_TYPES.has(q.accountType) && q.rule !== "us-rmd") return 0;
  if (q.ownerAge < usRmdStartAge(q.ownerBirthYear)) return 0;
  const age = Math.min(120, Math.floor(q.ownerAge));
  const divisor = UNIFORM_LIFETIME[age] ?? UNIFORM_LIFETIME[72]!;
  return clamp0(q.priorYearEndBalance) / divisor;
}

const ACCESS_59 = new Set([
  ...DEFERRAL_401K,
  ...RMD_TYPES,
  "roth-ira",
  "401a",
  "generic-tax-deferred",
]);

function pensionAccessAge(q: PensionAccessQuery): number | null {
  if (q.accountType === "hsa") return US_FIXED.hsaPenaltyFreeAge;
  return ACCESS_59.has(q.accountType) ? US_FIXED.retirementAccessAge : null;
}

/** IRC §121: $250k ($500k joint) of main-home gain excluded when owned 2 of the last 5 years. */
export function usHomeSaleExclusion(q: HomeSaleQuery): number | null {
  if (q.monthsOwned !== null && q.monthsOwned < 24) return 0;
  const joint =
    q.filingStatus === "married-joint" || q.filingStatus === "qualifying-surviving-spouse";
  return joint ? US_FIXED.homeSaleExclusion.joint : US_FIXED.homeSaleExclusion.single;
}

export const usFederalJurisdiction: TaxJurisdiction = {
  id: ID,
  label: "US federal income tax",
  level: "national",
  country: "US",
  status: "implemented",
  owner: "b",
  computeYear: (input) => computeYear(input, false),
  explainYear: (input) => computeYear(input, true),
  contributionLimit: usContributionLimit,
  requiredDistribution: usRequiredDistribution,
  pensionAccessAge,
  homeSaleExclusion: usHomeSaleExclusion,
  defaultCharacter: defaultCharacterForIncomeType,
  lawToggles: [
    {
      id: "us.tcjaSunset",
      label: "TCJA sunset (pre-2018 rates; what-if, OBBBA made TCJA permanent)",
      default: false,
    },
    {
      id: "us.obbbaSeniorDeduction",
      label: "OBBBA $6,000 senior deduction (2025-2028)",
      default: true,
    },
    { id: "us.acaEnhanced", label: "Enhanced ACA subsidies (no 400% FPL cliff)", default: false },
    { id: "us.irmaa", label: "Model Medicare IRMAA surcharges", default: true },
    { id: "us.amt", label: "Alternative minimum tax", default: true },
    { id: "us.qbi", label: "Qualified business income deduction", default: true },
  ],
  sources: [
    ...US_FEDERAL_YEARS.flatMap((y) => y.sources.map((s) => ({ taxYear: String(y.year), ...s }))),
    ...US_IRMAA_YEARS.map((t) => ({ taxYear: String(t.year), url: t.source, note: "IRMAA tiers" })),
    ...US_ACA_YEARS.flatMap((t) => t.sources.map((s) => ({ taxYear: String(t.year), ...s }))),
    ...US_LIMITS_YEARS.flatMap((t) => t.sources.map((s) => ({ taxYear: String(t.year), ...s }))),
  ],
  simplifications: US_FEDERAL_SIMPLIFICATIONS,
};
