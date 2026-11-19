/**
 * United Kingdom: income tax (England/Wales/NI rates and Scottish rates), personal allowance
 * taper, savings starting rate + personal savings allowance, dividend allowance and rates,
 * separate property income rates (from 2027/28), capital gains tax, National Insurance (Class 1
 * employee, Class 4; none above State Pension age), pension relief (net pay / relief at source /
 * salary sacrifice), annual allowance with taper and MPAA (charge on the excess), lump sum
 * allowance on tax-free pension cash, marriage allowance, the Pension Tax Allowance (2027/28 to
 * 2029/30, announced), High Income Child Benefit Charge and student/postgraduate loan repayments.
 *
 * Independent taxation: everything is computed per person; 'joint' items split evenly.
 * Data: ../data/uk.ts (versioned per tax year). This file holds no figures.
 */
import { ScenarioError } from "../../errors.js";
import {
  alivePeople,
  type Band,
  birthYearOf,
  clamp0,
  collectIncome,
  finiteMarginal,
  indexFactor,
  LineSink,
  ownerShare,
  periodScale,
  pickYear,
  sliceTax,
  thresholdPolicy,
} from "../common.js";
import { UK_SIMPLIFICATIONS } from "../data/anglo.js";
import {
  UK_CASH_ISA_LIMIT_FROM,
  UK_STATE_PENSION_DEFERRAL,
  UK_TAX_YEARS,
  type UkTaxYear,
  ukNormalMinimumPensionAge,
  ukStatePensionAge,
} from "../data/uk.js";
import type {
  BracketFill,
  ContributionSubLimit,
  ContributionSubLimitQuery,
  PensionAccessQuery,
  StatePensionDeferralQuery,
  TaxContributionLimitQuery,
  TaxJurisdiction,
  TaxPerson,
  TaxYearInput,
  TaxYearOutput,
} from "../types.js";
import { defaultCharacterForIncomeType } from "./flat.js";

const ID = "uk";

export function isScottishTaxpayer(input: TaxYearInput): boolean {
  const o = input.config.uk?.scottishTaxpayer;
  if (o !== undefined) return o;
  const r = (input.location.region ?? "").toUpperCase();
  return r === "SCT" || r === "SCOTLAND" || r === "S" || r === "GB-SCT";
}

function lastFact(input: TaxYearInput, key: string): number | undefined {
  return input.history[input.history.length - 1]?.[key];
}

/** Threshold multipliers for the year (indexation policy x period proration). */
interface Factors {
  d: UkTaxYear;
  /** Income tax & NI thresholds (frozen to April 2031 under the legislated policy). */
  it: number;
  /** Scottish basic/intermediate starts (indexed annually by the Scottish Government). */
  scotLower: number;
  /** Scottish higher/advanced starts. */
  scotUpper: number;
  /** Fixed-in-statute amounts (LSA, CGT AEA, allowances not uprated): only move under 'indexed'. */
  fixed: number;
  /** Benefits (Child Benefit) uprated with prices. */
  benefit: number;
  /**
   * Pension Tax Allowance threshold: the 2027/28 figure, then indexed with prices as a stand-in for
   * the full new State Pension it follows (2028/29 and 2029/30 figures not yet published).
   */
  pta: number;
  studentLoan: Record<string, number>;
  scale: number;
  facts: Record<string, number>;
}

function factors(input: TaxYearInput): Factors {
  const d = pickYear(UK_TAX_YEARS, input.year);
  const facts: Record<string, number> = {};
  const take = (key: string, frozen: number | undefined) => {
    const r = indexFactor(input, key, frozen);
    Object.assign(facts, r.facts);
    return r.factor;
  };
  const it = take("uk", d.income.frozenThrough);
  const scotUpper = take("uk.scotUpper", d.income.scotlandUpperFrozenThrough);
  const pta = take("uk.pta", 2027);
  const policy = thresholdPolicy(input);
  const indexed = policy === "frozen" ? 1 : input.priceIndex;
  const fixed = policy === "indexed" ? input.priceIndex : 1;
  const studentLoan: Record<string, number> = {};
  for (const [plan, p] of Object.entries(d.studentLoans))
    studentLoan[plan] =
      p.frozenThrough !== undefined ? take(`uk.sl.${plan}`, p.frozenThrough) : indexed;
  return {
    d,
    it,
    scotLower: indexed,
    scotUpper,
    fixed,
    benefit: input.priceIndex,
    pta,
    studentLoan,
    scale: periodScale(input),
    facts,
  };
}

interface PersonResult {
  personId: string;
  netIncome: number;
  adjustedNetIncome: number;
  personalAllowance: number;
  totalTaxable: number;
  /** Highest rUK band reached by taxable income: 0 basic (or below), 1 higher, 2 additional. */
  band: 0 | 1 | 2;
  /** For Scots: highest Scottish band index reached on non-savings income. */
  scotBand: number;
  taxNonSavings: number;
  taxSavings: number;
  taxDividends: number;
  taxCgt: number;
  aaCharge: number;
  ni1: number;
  ni4: number;
  studentLoans: { plan: string; amount: number; cumulative: number }[];
  credits: number;
  /** Pension Tax Allowance: income tax reduction available (before capping at the tax due). */
  pta: number;
  penalties: number;
  rasGross: number;
  rasTopUp: number;
  lsaUsed: number;
  flexiblyAccessed: boolean;
  gross: number;
  /** Statutory rate of the band holding the last unit of non-savings income (0 within the PA). */
  bracketRate: number;
  fill: BracketFill[];
}

interface PersonOptions {
  paAdjust: number;
  explain: boolean;
}

function computePerson(
  input: TaxYearInput,
  F: Factors,
  person: TaxPerson,
  people: TaxPerson[],
  scot: boolean,
  opt: PersonOptions,
): PersonResult {
  const { d, scale } = F;
  const pid = person.id;
  const b = collectIncome(input, ID, pid, people);
  const fill: BracketFill[] = [];

  // ---- pension contributions and other deductions
  const defaultScheme = input.config.uk?.defaultPensionScheme;
  let netPay = 0;
  let rasNet = 0;
  let salSac = 0;
  let employer = 0;
  let otherDeductions = 0;
  let credits = 0;
  for (const it of input.deductions) {
    if (it.amount <= 0) continue;
    const share = ownerShare(it.owner, pid, people);
    if (share === 0) continue;
    const amt = it.amount * share;
    if (it.kind === "credit") credits += amt;
    else if (it.kind === "deduction") otherDeductions += amt;
    else if (it.employer) employer += amt;
    else {
      const scheme =
        it.pensionScheme ??
        defaultScheme ??
        (it.accountType === "uk-sipp" || it.accountType === "uk-pension"
          ? "relief-at-source"
          : "net-pay");
      if (
        it.accountType === "uk-isa" ||
        it.accountType === "uk-lisa" ||
        it.accountType === "uk-gia"
      )
        continue;
      if (scheme === "relief-at-source") rasNet += amt;
      else if (scheme === "salary-sacrifice") salSac += amt;
      else netPay += amt;
    }
  }
  const p = d.pensions;
  // Relief limited to 100% of relevant UK earnings (or the £3,600 basic amount).
  const relevantEarnings = clamp0(b.wage - salSac) + b.selfEmployment;
  const personalGross = netPay + rasNet / (1 - p.reliefAtSourceRate);
  const relievableCap = Math.max(relevantEarnings, p.basicAmount * scale * F.fixed);
  const k = personalGross > relievableCap && personalGross > 0 ? relievableCap / personalGross : 1;
  const netPayRelieved = netPay * k;
  const rasGross = (rasNet / (1 - p.reliefAtSourceRate)) * k;
  const rasTopUp = rasGross - rasNet * k;

  // ---- lump sum allowance on tax-free pension cash
  const lsa = p.lumpSumAllowance * F.fixed;
  const lsaPrior = lastFact(input, `uk.lsaUsed.${pid}`) ?? 0;
  const lsaAvailable = clamp0(lsa - lsaPrior);
  const taxFreeAllowed = Math.min(b.deferredTaxFree, lsaAvailable);
  const lsaExcess = b.deferredTaxFree - taxFreeAllowed;
  const flexiblyAccessed =
    (lastFact(input, `uk.flexiblyAccessed.${pid}`) ?? 0) > 0 || b.deferredWithdrawals > 0;

  // ---- income by schedule
  const property = b.rental;
  const employment = clamp0(b.wage - salSac);
  let nonSavings =
    employment +
    b.selfEmployment +
    b.pension +
    b.socialSecurity +
    b.ordinary +
    b.deferredWithdrawals +
    lsaExcess -
    netPayRelieved -
    otherDeductions;
  let propertyIncome = property;
  if (nonSavings < 0) {
    propertyIncome = clamp0(propertyIncome + nonSavings);
    nonSavings = 0;
  }
  const savings = b.interest;
  const dividends = b.qualifiedDividends + b.ordinaryDividends;
  const gains = b.gainsLong + b.gainsShort;
  const netIncome = nonSavings + propertyIncome + savings + dividends;
  const adjustedNetIncome = clamp0(netIncome - rasGross);
  const gross =
    b.wage +
    b.selfEmployment +
    b.pension +
    b.socialSecurity +
    b.ordinary +
    b.deferredWithdrawals +
    b.deferredTaxFree +
    property +
    savings +
    dividends +
    gains;

  // ---- personal allowance with taper
  const I = d.income;
  const it = F.it * scale;
  // Non-residents keep the personal allowance only when entitled (British/EEA citizens, treaties).
  const paEntitled = input.nonResident?.personalAllowance[pid] ?? true;
  const paFull = paEntitled ? I.personalAllowance * it : 0;
  const pa = clamp0(
    clamp0(paFull - clamp0(adjustedNetIncome - I.paTaperThreshold * it) / 2) + opt.paAdjust,
  );

  // PA is set against non-savings, then property, then savings, then dividends.
  let paLeft = pa;
  const take = (x: number) => {
    const used = Math.min(x, paLeft);
    paLeft -= used;
    return x - used;
  };
  const nsT = take(nonSavings);
  const propT = take(propertyIncome);
  const savT = take(savings);
  const divT = take(dividends);
  const totalTaxable = nsT + propT + savT + divT;

  // ---- rUK band edges (extended by relief-at-source gross contributions)
  const B = I.basicRateBand * it + rasGross;
  const H = I.higherRateLimit * it + rasGross;
  const ruk = (r: { basic: number; higher: number; additional: number }): Band[] => [
    { from: 0, rate: r.basic, label: "Basic" },
    { from: B, rate: r.higher, label: "Higher" },
    { from: H, rate: r.additional, label: "Additional" },
  ];

  // ---- non-savings income tax
  let nsBands: Band[];
  if (scot) {
    const s = I.scotland;
    nsBands = s.bands.map(([from, rate], i) => {
      // Starter/basic/intermediate starts are uprated annually; higher/advanced frozen for now;
      // top rate tied to the UK additional-rate limit. RAS contributions extend bands from the
      // intermediate rate up (starter/basic payers keep the 20% given at source).
      let f = 0;
      if (i === 1) f = from * F.scotLower * scale;
      else if (i === 2) f = from * F.scotLower * scale + rasGross;
      else if (i === 3 || i === 4) f = from * F.scotUpper * scale + rasGross;
      else if (i >= 5) f = from * it + rasGross;
      return { from: f, rate, label: s.labels[i] ?? "" };
    });
  } else nsBands = ruk(I.rates);
  const nsFill: BracketFill["bands"] | undefined = opt.explain ? [] : undefined;
  const propertySeparate = !!I.property && !(scot && !I.property.appliesInScotland);
  const ns = sliceTax(nsBands, 0, propertySeparate ? nsT : nsT + propT, nsFill);
  let taxNonSavings = ns.tax;
  let scotBand = 0;
  if (scot)
    for (let i = 0; i < nsBands.length; i++) if (nsT + propT > nsBands[i]!.from) scotBand = i;
  if (nsFill)
    fill.push({ jurisdictionId: ID, personId: pid, schedule: "non-savings", bands: nsFill });
  if (propertySeparate && I.property) {
    const pf: BracketFill["bands"] | undefined = opt.explain ? [] : undefined;
    taxNonSavings += sliceTax(ruk(I.property.rates), nsT, propT, pf).tax;
    if (pf) fill.push({ jurisdictionId: ID, personId: pid, schedule: "property", bands: pf });
  }

  // ---- savings: starting rate band, personal savings allowance, then savings rates
  const pos = nsT + propT;
  const band: 0 | 1 | 2 = totalTaxable > H ? 2 : totalTaxable > B ? 1 : 0;
  const S = I.savings;
  const srb = clamp0(S.startingRateLimit * it - pos);
  const psa =
    (band === 0
      ? S.personalSavingsAllowance.basic
      : band === 1
        ? S.personalSavingsAllowance.higher
        : 0) *
    F.fixed *
    scale;
  const savZero = Math.min(savT, srb + psa);
  const sf: BracketFill["bands"] | undefined = opt.explain ? [] : undefined;
  if (sf && savZero > 0)
    sf.push({
      label: "Starting rate / PSA",
      rate: 0,
      from: pos,
      to: pos + srb + psa,
      amount: savZero,
      tax: 0,
    });
  const taxSavings = sliceTax(ruk(S.rates), pos + savZero, savT - savZero, sf).tax;
  if (sf) fill.push({ jurisdictionId: ID, personId: pid, schedule: "savings", bands: sf });

  // ---- dividends: allowance (uses band) then dividend rates
  const pos2 = pos + savT;
  const da = I.dividends.allowance * F.fixed * scale;
  const divZero = Math.min(divT, da);
  const df: BracketFill["bands"] | undefined = opt.explain ? [] : undefined;
  if (df && divZero > 0)
    df.push({
      label: "Dividend allowance",
      rate: 0,
      from: pos2,
      to: pos2 + da,
      amount: divZero,
      tax: 0,
    });
  const taxDividends = sliceTax(ruk(I.dividends.rates), pos2 + divZero, divT - divZero, df).tax;
  if (df) fill.push({ jurisdictionId: ID, personId: pid, schedule: "dividends", bands: df });

  // ---- capital gains (UK-wide rates; uses the unused rUK basic band)
  const aea = d.cgt.annualExemptAmount * F.fixed * scale;
  const chargeable = clamp0(gains - aea);
  const basicLeft = clamp0(B - totalTaxable);
  const cgBands: Band[] = [
    { from: 0, rate: d.cgt.basicRate, label: "CGT basic" },
    { from: basicLeft, rate: d.cgt.higherRate, label: "CGT higher" },
  ];
  const cf: BracketFill["bands"] | undefined = opt.explain ? [] : undefined;
  const taxCgt = sliceTax(cgBands, 0, chargeable, cf).tax;
  if (cf) fill.push({ jurisdictionId: ID, personId: pid, schedule: "capital-gains", bands: cf });

  // ---- pension annual allowance (tapered; MPAA once flexibly accessed). Carry-forward not modelled.
  const pensionInput = netPayRelieved + rasGross + salSac + employer;
  let aaCharge = 0;
  if (pensionInput > 0) {
    const thresholdIncome = netIncome - rasGross + salSac;
    const adjustedIncome = netIncome + netPayRelieved + salSac + employer;
    let aa = p.annualAllowance * F.fixed;
    if (
      thresholdIncome > p.taperThresholdIncome * F.fixed &&
      adjustedIncome > p.taperAdjustedIncome * F.fixed
    )
      aa = Math.max(
        p.taperMinimum * F.fixed,
        aa - (adjustedIncome - p.taperAdjustedIncome * F.fixed) / 2,
      );
    if (flexiblyAccessed) aa = Math.min(aa, p.moneyPurchaseAnnualAllowance * F.fixed);
    const excess = clamp0(pensionInput - aa * scale);
    if (excess > 0) aaCharge = sliceTax(nsBands, totalTaxable, excess).tax;
  }

  const spa = ukStatePensionAge(birthYearOf(person, input.year), person.birthMonth);

  // ---- Pension Tax Allowance (2027/28 to 2029/30): over State Pension age, total income near the
  // full new State Pension. Worth up to the basic rate on (threshold - PA), withdrawn £1 per £3.
  let pta = 0;
  const PTA = I.pensionTaxAllowance;
  if (PTA && input.year <= PTA.lastYear && person.age >= spa) {
    const threshold = PTA.threshold * F.pta * scale;
    const max = I.rates.basic * clamp0(threshold - I.personalAllowance * it);
    pta = clamp0(max - clamp0(netIncome - threshold) * PTA.withdrawalPerPound);
  }

  // ---- National Insurance (none at or above State Pension age)
  let ni1 = 0;
  let ni4 = 0;
  if (person.age < spa) {
    const N = d.ni;
    const nf = F.it * scale;
    const cap = N.salarySacrificeNicCap;
    const nicFreeSacrifice = cap === undefined ? salSac : Math.min(salSac, cap * scale);
    const earnings = clamp0(b.wage - nicFreeSacrifice);
    ni1 =
      N.class1Main *
        clamp0(Math.min(earnings, N.upperEarningsLimit * nf) - N.primaryThreshold * nf) +
      N.class1Upper * clamp0(earnings - N.upperEarningsLimit * nf);
    const profits = b.selfEmployment;
    ni4 =
      N.class4Main *
        clamp0(Math.min(profits, N.upperProfitsLimit * nf) - N.lowerProfitsLimit * nf) +
      N.class4Upper * clamp0(profits - N.upperProfitsLimit * nf);
  }

  // ---- student and postgraduate loans (payroll deduction; balance-capped; interest ignored)
  const studentLoans: PersonResult["studentLoans"] = [];
  const plans = (input.config.uk?.studentLoans ?? []).filter((s) => s.personId === pid);
  if (plans.length > 0) {
    const slIncome = clamp0(b.wage - salSac) + b.selfEmployment;
    const active = plans.filter((s) => s.writeOffYear === undefined || input.year < s.writeOffYear);
    const remaining = (s: (typeof plans)[number]) => {
      const prior = lastFact(input, `uk.sl.${pid}.${s.plan}`) ?? 0;
      return {
        prior,
        left: s.balance === undefined ? Number.POSITIVE_INFINITY : clamp0(s.balance - prior),
      };
    };
    const ug = active.filter((s) => s.plan !== "postgraduate" && remaining(s).left > 0);
    if (ug.length > 0) {
      // One 9% deduction above the lowest applicable threshold, applied to plans in threshold order.
      const thr = (plan: string) =>
        d.studentLoans[plan as keyof UkTaxYear["studentLoans"]].threshold *
        (F.studentLoan[plan] ?? 1) *
        scale;
      const ordered = [...ug].sort((a, z) => thr(a.plan) - thr(z.plan));
      let due = d.studentLoans.plan1.rate * clamp0(slIncome - thr(ordered[0]!.plan));
      for (const s of ordered) {
        const r = remaining(s);
        const pay = Math.min(due, r.left);
        due -= pay;
        studentLoans.push({ plan: s.plan, amount: pay, cumulative: r.prior + pay });
      }
    }
    for (const s of active.filter((x) => x.plan === "postgraduate")) {
      const r = remaining(s);
      const pg = d.studentLoans.postgraduate;
      const pay = Math.min(
        r.left,
        pg.rate * clamp0(slIncome - pg.threshold * (F.studentLoan.postgraduate ?? 1) * scale),
      );
      studentLoans.push({ plan: s.plan, amount: pay, cumulative: r.prior + pay });
    }
  }

  return {
    personId: pid,
    netIncome,
    adjustedNetIncome,
    personalAllowance: pa,
    totalTaxable,
    band,
    scotBand,
    taxNonSavings,
    taxSavings,
    taxDividends,
    taxCgt,
    aaCharge,
    ni1,
    ni4,
    studentLoans,
    credits,
    pta,
    penalties: b.penalties,
    rasGross,
    rasTopUp,
    lsaUsed: lsaPrior + taxFreeAllowed,
    flexiblyAccessed,
    gross,
    bracketRate: nsT + (propertySeparate ? 0 : propT) > 0 ? ns.marginal : 0,
    fill,
  };
}

function incomeTax(r: PersonResult): number {
  return r.taxNonSavings + r.taxSavings + r.taxDividends;
}

function isMarried(input: TaxYearInput): boolean {
  const s = input.config.filingStatus;
  return s === "married-joint" || s === "married-separate";
}

interface UkResult {
  out: TaxYearOutput;
  total: number;
}

function computeUk(input: TaxYearInput, explain: boolean): UkResult {
  const F = factors(input);
  const people = alivePeople(input);
  const scot = isScottishTaxpayer(input);
  const run = (person: TaxPerson, paAdjust = 0) =>
    computePerson(input, F, person, people, scot, { paAdjust, explain });
  const results = people.map((p) => run(p));

  // ---- marriage allowance: transfer 10% of PA when the transferor is a non-taxpayer and the
  // recipient pays no more than the basic (Scotland: intermediate) rate. Applied only if beneficial.
  let marriageAllowance: { from: number; to: number; relief: number } | null = null;
  const maToggle = input.config.lawToggles["uk.marriageAllowance"] ?? true;
  if (maToggle && isMarried(input) && results.length === 2) {
    const ma = F.d.income.marriageAllowance * F.it * F.scale;
    for (const [i, j] of [
      [0, 1],
      [1, 0],
    ] as const) {
      const t = results[i]!;
      const r = results[j]!;
      const recipientBasic = scot ? r.scotBand <= 2 && r.band === 0 : r.band === 0;
      if (t.netIncome <= t.personalAllowance && recipientBasic && r.totalTaxable > 0) {
        const t2 = run(people[i]!, -ma);
        const relief = Math.min(ma * F.d.income.rates.basic, incomeTax(r));
        const cost = incomeTax(t2) - incomeTax(t);
        if (relief - cost > 0 && (!marriageAllowance || relief - cost > marriageAllowance.relief)) {
          results[i] = t2;
          marriageAllowance = { from: i, to: j, relief };
        }
      }
    }
  }

  // ---- High Income Child Benefit Charge on the partner with the higher adjusted net income
  let hicbc = 0;
  let hicbcPerson: string | null = null;
  const kids = input.dependents.filter((d) => d.age >= 0 && d.age < 18).length;
  if (kids > 0 && input.config.uk?.childBenefitClaimed) {
    const cb = F.d.childBenefit;
    const benefit = (cb.eldestWeekly + cb.otherWeekly * (kids - 1)) * 52 * F.benefit * F.scale;
    const top = results.reduce((a, r) => (r.adjustedNetIncome > a.adjustedNetIncome ? r : a));
    const over = clamp0(top.adjustedNetIncome - cb.hicbcThreshold * F.it * F.scale);
    hicbc = Math.min(benefit, (benefit * over) / (cb.hicbcTaperWidth * F.it * F.scale));
    hicbcPerson = top.personId;
  }

  // ---- lines
  const sink = new LineSink(ID);
  const multi = results.length > 1;
  const facts: Record<string, number> = {
    ...F.facts,
    "tax.year": input.year,
    "tax.priceIndex": input.priceIndex,
  };
  let rasTopUp = 0;
  let taxable = 0;
  let gross = 0;
  const fill: BracketFill[] = [];
  results.forEach((r, i) => {
    const sfx = multi ? ` (${r.personId})` : "";
    let reducers = r.credits;
    if (marriageAllowance && marriageAllowance.to === i) reducers += marriageAllowance.relief;
    const it = incomeTax(r);
    const reduction = Math.min(reducers, it);
    const ptaUsed = Math.min(r.pta, it - reduction);
    sink.add(
      "income",
      `Income tax${scot ? " (Scottish rates)" : ""}${sfx}`,
      r.taxNonSavings,
      r.totalTaxable,
    );
    sink.add("income", `Income tax on savings${sfx}`, r.taxSavings);
    sink.add("dividends", `Dividend tax${sfx}`, r.taxDividends);
    if (reduction > 0)
      sink.add(
        "credit",
        `${marriageAllowance?.to === i ? "Marriage allowance / tax reducers" : "Tax reducers"}${sfx}`,
        -reduction,
      );
    if (ptaUsed > 0) sink.add("credit", `Pension Tax Allowance${sfx}`, -ptaUsed);
    sink.add("capital-gains", `Capital gains tax${sfx}`, r.taxCgt);
    sink.add("other", `Pension annual allowance charge${sfx}`, r.aaCharge);
    sink.add("payroll", `National Insurance (Class 1)${sfx}`, r.ni1);
    sink.add("self-employment", `National Insurance (Class 4)${sfx}`, r.ni4);
    for (const s of r.studentLoans)
      sink.add(
        "payroll",
        `${s.plan === "postgraduate" ? "Postgraduate loan" : `Student loan (${s.plan})`}${sfx}`,
        s.amount,
      );
    sink.add("penalty", `Early withdrawal charge${sfx}`, r.penalties);
    if (hicbcPerson === r.personId)
      sink.add("other", `High Income Child Benefit Charge${sfx}`, hicbc);
    facts[`uk.adjustedNetIncome.${r.personId}`] = r.adjustedNetIncome;
    facts[`uk.personalAllowance.${r.personId}`] = r.personalAllowance;
    facts[`uk.lsaUsed.${r.personId}`] = r.lsaUsed;
    facts[`uk.flexiblyAccessed.${r.personId}`] = r.flexiblyAccessed ? 1 : 0;
    facts[`tax.ordinaryBracketRate.${r.personId}`] = r.bracketRate;
    if (i === 0) facts["tax.ordinaryBracketRate"] = r.bracketRate;
    for (const s of r.studentLoans) facts[`uk.sl.${r.personId}.${s.plan}`] = s.cumulative;
    rasTopUp += r.rasTopUp;
    taxable += r.totalTaxable;
    gross += r.gross;
    fill.push(...r.fill);
  });
  facts["uk.reliefAtSourceTopUp"] = rasTopUp;
  facts["uk.taxableIncome"] = taxable;
  if (marriageAllowance) facts["uk.marriageAllowanceRelief"] = marriageAllowance.relief;
  if (hicbc > 0) facts["uk.hicbc"] = hicbc;
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

function totalOnly(input: TaxYearInput): number {
  return computeUk(input, false).total;
}

function computeYear(input: TaxYearInput, explain: boolean): TaxYearOutput {
  if (input.months <= 0)
    throw new ScenarioError("tax period has no months", { months: input.months });
  const { out } = computeUk(input, explain);
  out.marginalRate = finiteMarginal(totalOnly, input, "ordinary");
  return out;
}

function contributionLimit(q: TaxContributionLimitQuery): number | null {
  // ISA and pension limits are fixed in statute (not indexed).
  const d = pickYear(UK_TAX_YEARS, q.year);
  const f = 1;
  switch (q.accountType) {
    case "uk-isa":
      return d.isa.overall * f;
    case "uk-lisa":
      return q.ownerAge >= 18 && q.ownerAge < 50 ? d.isa.lisa * f : 0;
    case "uk-sipp":
    case "uk-workplace-pension":
    case "uk-pension":
      // Gross personal contributions relievable: 100% of earnings (min £3,600), capped by the AA
      // (the money purchase annual allowance once the owner has flexibly accessed a pension).
      return Math.min(
        (q.flexiblyAccessed
          ? d.pensions.moneyPurchaseAnnualAllowance
          : d.pensions.annualAllowance) * f,
        Math.max(q.earnedIncome, d.pensions.basicAmount * f),
      );
    default:
      return null;
  }
}

const UK_PENSIONS = new Set(["uk-sipp", "uk-workplace-pension", "uk-pension"]);

function pensionAccessAge(q: PensionAccessQuery): number | null {
  if (UK_PENSIONS.has(q.accountType)) return ukNormalMinimumPensionAge(q.birthYear, q.birthMonth);
  if (q.accountType === "uk-lisa") return 60;
  return null;
}

/**
 * Cash ISA sub-limit inside the overall ISA allowance, only when the plan sets one
 * (`tax.uk.cashIsaLimit` with an amount; default start April 2027, savers 65+ exempt). There is no
 * statutory cash limit: Budget 2026 dropped the £12,000 limit announced for April 2027.
 */
function contributionSubLimit(q: ContributionSubLimitQuery): ContributionSubLimit | null {
  if (q.accountType !== "uk-isa" || q.subtype !== "cash") return null;
  const cfg = q.config.uk?.cashIsaLimit;
  if (!cfg || cfg.enabled === false || cfg.amount === undefined) return null;
  if (q.ownerAge >= (cfg.exemptFromAge ?? 65)) return null;
  return { key: "uk-cash-isa", annual: cfg.amount, from: cfg.from ?? UK_CASH_ISA_LIMIT_FROM };
}

/** New State Pension deferral: +1% per 9 weeks deferred, at least 9 weeks. */
function statePensionDeferralUplift(q: StatePensionDeferralQuery): number {
  const weeks = (q.monthsDeferred * 52) / 12;
  return weeks >= UK_STATE_PENSION_DEFERRAL.minimumWeeks
    ? (weeks / 9) * UK_STATE_PENSION_DEFERRAL.upliftPer9Weeks
    : 0;
}

export const ukJurisdiction: TaxJurisdiction = {
  id: ID,
  label: "United Kingdom (income tax, NI, CGT, dividends, pensions, student loans)",
  level: "national",
  country: "GB",
  status: "implemented",
  owner: "b",
  computeYear: (input) => computeYear(input, false),
  explainYear: (input) => computeYear(input, true),
  contributionLimit,
  pensionAccessAge,
  statePensionAge: (q) => ukStatePensionAge(q.birthYear, q.birthMonth),
  statePensionDeferralUplift,
  contributionSubLimit,
  // Private residence relief: the gain on a main home is exempt.
  homeSaleExclusion: () => Number.POSITIVE_INFINITY,
  defaultCharacter: defaultCharacterForIncomeType,
  lawToggles: [
    {
      id: "uk.marriageAllowance",
      label: "Apply marriage allowance when beneficial",
      default: true,
    },
  ],
  sources: UK_TAX_YEARS.flatMap((y) => y.sources.map((s) => ({ taxYear: y.label, ...s }))),
  simplifications: UK_SIMPLIFICATIONS,
};
