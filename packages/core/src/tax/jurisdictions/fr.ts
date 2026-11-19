/**
 * France: impôt sur le revenu (barème progressif, quotient familial with its cap, décote), employee
 * pension contributions and CSG/CRDS on salaries, CSG/CRDS/CASA on pensions (by income tier), prélèvements sociaux on
 * capital and property income, PFU (flat tax) with the option for the barème, PEA (after 5 years)
 * and assurance-vie (after 8 years) gains on withdrawal, PER contributions as deductions.
 * The foyer fiscal is the married couple (married-joint) or each person.
 * Data: ../data/fr.ts. Known simplifications: FR_SIMPLIFICATIONS.
 */
import {
  alivePeople,
  bands,
  clamp0,
  collectIncome,
  indexFactor,
  LineSink,
  periodScale,
  personDeductions,
  pickYear,
  sliceTax,
  withdrawalsFrom,
} from "../common.js";
import { FR_SIMPLIFICATIONS, FR_YEARS, type FrYear, frLegalRetirementAge } from "../data/fr.js";
import type { BracketFill, TaxContributionLimitQuery, TaxPerson, TaxYearInput } from "../types.js";
import { type CountryResult, nationalJurisdiction } from "./intl.js";

const ID = "fr";
const PEA = new Set(["fr-pea"]);
const AV = new Set(["fr-assurance-vie"]);

/** Employee pension contributions and CSG/CRDS on a gross salary `w` (PASS scaled by `f`). */
export function frPayroll(d: FrYear, w: number, f = 1) {
  const P = d.payroll;
  const pass = P.pass * f;
  const t1 = Math.min(w, pass);
  const t2 = clamp0(Math.min(w, 8 * pass) - pass);
  const pension =
    P.vieillessePlafonnee * t1 +
    P.vieillesseDeplafonnee * w +
    P.agircT1 * t1 +
    P.agircT2 * t2 +
    (w > pass ? P.cet * Math.min(w, 8 * pass) : 0);
  const csgBase =
    P.csgBaseShare * Math.min(w, P.csgBaseCapPass * pass) + clamp0(w - P.csgBaseCapPass * pass);
  return {
    pension,
    csg: P.csg * csgBase,
    crds: P.crds * csgBase,
    csgDeductible: P.csgDeductible * csgBase,
  };
}

/** Number of parts (quotient familial). */
export function frParts(couple: boolean, children: number, singleParent: boolean): number {
  const kids = Math.min(children, 2) * 0.5 + Math.max(0, children - 2);
  return (couple ? 2 : 1) + kids + (singleParent && children > 0 ? 0.5 : 0);
}

/** Impôt after quotient familial cap and décote, on revenu net imposable `r`. */
export function frImpot(
  d: FrYear,
  r: number,
  parts: number,
  couple: boolean,
  f = 1,
  singleParent = false,
): { brut: number; decote: number; marginal: number; fill: BracketFill["bands"] } {
  const b = bands(d.bareme, f);
  const baseParts = couple ? 2 : 1;
  const fill: BracketFill["bands"] = [];
  const q = sliceTax(b, 0, r / parts, fill);
  const withQf = parts * q.tax;
  const withoutQf = baseParts * sliceTax(b, 0, r / baseParts).tax;
  // The two half-parts of a single parent's first child share the higher cap (4,262 for 2025 income).
  const extra = parts - baseParts;
  const cap =
    d.quotient.capPerHalfPart * f * extra * 2 +
    (singleParent && extra >= 1
      ? (d.quotient.capSingleParentFirstChild - 2 * d.quotient.capPerHalfPart) * f
      : 0);
  const brut = Math.max(withQf, withoutQf - cap);
  const D = d.decote;
  const decote = Math.min(brut, clamp0((couple ? D.couple : D.single) * f - D.rate * brut));
  return {
    brut,
    decote,
    marginal: r > 0 ? q.marginal : 0,
    fill: fill.map((x) => ({
      ...x,
      from: x.from * parts,
      to: x.to * parts,
      amount: x.amount * parts,
      tax: x.tax * parts,
    })),
  };
}

/** CSG / CRDS / CASA tier on pensions for a revenu fiscal de référence `rfr` and `parts`. */
export function frPensionTier(d: FrYear, rfr: number, parts: number, f = 1) {
  const tiers = d.pensionsSocial;
  let tier = tiers[0]!;
  for (const t of tiers) if (rfr > (t.rfrAbove + ((parts - 1) / 0.5) * t.perHalfPart) * f) tier = t;
  return tier;
}

interface Foyer {
  people: TaxPerson[];
  couple: boolean;
  dependents: number;
}

function foyers(input: TaxYearInput, people: TaxPerson[]): Foyer[] {
  const kids = input.dependents.filter((x) => x.age < 18).length;
  if (people.length === 2 && input.filingStatus === "married-joint")
    return [{ people, couple: true, dependents: kids }];
  return people.map((p, i) => ({ people: [p], couple: false, dependents: i === 0 ? kids : 0 }));
}

function compute(input: TaxYearInput, explain: boolean): CountryResult {
  const d = pickYear(FR_YEARS, input.year);
  const idx = indexFactor(input, ID, undefined);
  const fs = idx.factor * periodScale(input);
  const all = alivePeople(input);
  const sink = new LineSink(ID);
  const facts: Record<string, number> = {
    ...idx.facts,
    "tax.year": input.year,
    "tax.priceIndex": input.priceIndex,
  };
  const fill: BracketFill[] = [];
  const toggles = input.config.lawToggles;
  const bareme = toggles["fr.baremeOption"] ?? false;
  const pea5 = toggles["fr.peaHeld5Years"] ?? true;
  const av8 = toggles["fr.assuranceVieHeld8Years"] ?? true;
  const C = d.capital;
  let taxable = 0;
  let gross = 0;
  const fys = foyers(input, all);
  fys.forEach((fy, fi) => {
    const sfx = fys.length > 1 ? ` (${fy.people[0]!.id})` : "";
    let revenu = 0;
    const pensionsByPerson: number[] = [];
    let payPension = 0;
    let payCsg = 0;
    let capIncome = 0;
    let capDividends = 0;
    let capGains = 0;
    let rental = 0;
    let peaGains = 0;
    let avGains = 0;
    let credits = 0;
    for (const p of fy.people) {
      const b = collectIncome(input, ID, p.id, all);
      const ded = personDeductions(input, p.id, all);
      // salaries (gross) -> net imposable -> 10% professional expenses
      const pay = frPayroll(d, b.wage, fs);
      const net = clamp0(b.wage - pay.pension - pay.csgDeductible);
      const frais = Math.min(
        net,
        Math.min(d.fraisPro.max * fs, Math.max(d.fraisPro.min * fs, d.fraisPro.rate * net)),
      );
      const salaries = net - frais;
      // self-employment: CSG/CRDS on the profit, deductible part off the taxable profit
      const P = d.payroll;
      const seSocial = (P.csg + P.crds) * b.selfEmployment;
      const se = b.selfEmployment * (1 - P.csgDeductible);
      // pensions (incl. state pensions and PER / other deferred withdrawals)
      const pens = b.pension + b.socialSecurity + b.deferredWithdrawals;
      pensionsByPerson.push(pens);
      // PER: deductible within 10% of professional income (min 10% PASS, max 10% of 8 PASS)
      const perPass = d.per.passPriorYear * fs;
      const perCap = Math.max(
        d.per.rate * perPass,
        d.per.rate * Math.min(salaries + se, d.per.maxPass * perPass),
      );
      const perDed = Math.min(ded.pretax, perCap);
      revenu += salaries + se - perDed - ded.deductions;
      payPension += pay.pension;
      payCsg += pay.csg + pay.crds + seSocial;
      credits += ded.credits;
      // capital: wrappers first, the rest is ordinary capital income
      const pea = withdrawalsFrom(input, p.id, all, PEA).taxable;
      const av = withdrawalsFrom(input, p.id, all, AV).taxable;
      peaGains += pea;
      avGains += av;
      capIncome += b.interest;
      capDividends += b.qualifiedDividends + b.ordinaryDividends;
      capGains += clamp0(b.gainsLong - pea - av) + b.gainsShort;
      rental += b.rental;
      revenu += b.ordinary;
      gross +=
        b.wage +
        b.selfEmployment +
        pens +
        b.rental +
        b.ordinary +
        b.interest +
        b.qualifiedDividends +
        b.ordinaryDividends +
        b.gainsLong +
        b.gainsShort +
        b.deferredTaxFree;
    }
    const singleParent = !fy.couple && input.filingStatus === "head-of-household";
    const parts = frParts(fy.couple, fy.dependents, singleParent);
    // pensions net of deductible CSG, less the 10% allowance (min per pensioner, max per foyer)
    const pensionsTaxable = (csgDeductible: number) => {
      let net = 0;
      let minAllow = 0;
      for (const pens of pensionsByPerson) {
        const pNet = pens * (1 - csgDeductible);
        net += pNet;
        minAllow += pNet > 0 ? Math.min(pNet, d.pensionAllowance.minPerPerson * fs) : 0;
      }
      const allowance = Math.min(
        net,
        Math.min(
          d.pensionAllowance.maxPerHousehold * fs,
          Math.max(minAllow, d.pensionAllowance.rate * net),
        ),
      );
      return net - allowance;
    };
    // property income: micro-foncier allowance; 17.2% social; 6.8 points of CSG deductible
    const foncier =
      rental <= d.microFoncier.limit * fs ? rental * (1 - d.microFoncier.allowance) : rental;
    revenu += foncier * (1 - C.csgDeductible);
    // capital income under the barème option
    const capAll = capIncome + capDividends + capGains;
    if (bareme)
      revenu +=
        capIncome + capDividends * (1 - C.dividendAllowance) + capGains - C.csgDeductible * capAll;
    // CSG tier on pensions: the RFR (this year's income as a proxy) with the normal-rate deduction,
    // plus capital income under the PFU, which the RFR includes.
    const normal = d.pensionsSocial[d.pensionsSocial.length - 1]!;
    const rfr = clamp0(revenu + pensionsTaxable(normal.csgDeductible)) + (bareme ? 0 : capAll);
    const tier = frPensionTier(d, rfr, parts, fs);
    const pensGross = pensionsByPerson.reduce((s, x) => s + x, 0);
    const pensionsSocial = (tier.csg + tier.crds + tier.casa) * pensGross;
    revenu = clamp0(revenu + pensionsTaxable(tier.csgDeductible));
    const imp = frImpot(d, revenu, parts, fy.couple, fs, singleParent);
    if (explain)
      fill.push({
        jurisdictionId: ID,
        personId: fy.people[0]!.id,
        schedule: "barème",
        bands: imp.fill,
      });
    const irBareme = clamp0(imp.brut - imp.decote);
    const reducers = Math.min(credits, irBareme);
    sink.add("income", `Impôt sur le revenu (barème, ${parts} parts)${sfx}`, imp.brut, revenu);
    sink.add("credit", `Décote${sfx}`, -imp.decote);
    sink.add("credit", `Réductions / crédits d'impôt${sfx}`, -reducers);
    sink.add("payroll", `Cotisations retraite salariales${sfx}`, payPension);
    sink.add("payroll", `CSG / CRDS (revenus d'activité)${sfx}`, payCsg);
    sink.add(
      "other",
      `CSG / CRDS / CASA (pensions, ${tier.label})${sfx}`,
      pensionsSocial,
      pensGross,
    );
    // PFU on capital income (unless the barème option was taken)
    if (!bareme) {
      sink.add(
        "dividends",
        `PFU 12.8% (intérêts, dividendes)${sfx}`,
        C.pfuIncomeTax * (capIncome + capDividends),
      );
      sink.add("capital-gains", `PFU 12.8% (plus-values)${sfx}`, C.pfuIncomeTax * capGains);
    }
    sink.add("other", `Prélèvements sociaux (capital)${sfx}`, C.socialGeneral * capAll, capAll);
    sink.add(
      "other",
      `Prélèvements sociaux (revenus fonciers)${sfx}`,
      C.socialAssuranceVieAndProperty * rental,
    );
    // wrappers
    const avAllowance =
      (fy.couple ? d.assuranceVie.allowanceCouple : d.assuranceVie.allowanceSingle) * fs;
    const avTax = av8
      ? d.assuranceVie.rateAfter8 * clamp0(avGains - avAllowance)
      : C.pfuIncomeTax * avGains;
    sink.add(
      "capital-gains",
      `PEA${pea5 ? "" : " (before 5 years)"}${sfx}`,
      pea5 ? 0 : C.pfuIncomeTax * peaGains,
    );
    sink.add("capital-gains", `Assurance-vie${sfx}`, avTax, avGains);
    sink.add("other", `Prélèvements sociaux (PEA)${sfx}`, C.socialGeneral * peaGains);
    sink.add(
      "other",
      `Prélèvements sociaux (assurance-vie)${sfx}`,
      C.socialAssuranceVieAndProperty * avGains,
    );
    for (const p of fy.people) facts[`tax.ordinaryBracketRate.${p.id}`] = imp.marginal;
    if (fi === 0) facts["tax.ordinaryBracketRate"] = imp.marginal;
    facts[`fr.revenuImposable.${fy.people[0]!.id}`] = revenu;
    facts[`fr.parts.${fy.people[0]!.id}`] = parts;
    taxable += revenu;
  });
  const penalty = input.withdrawals.reduce(
    (s, w) => s + clamp0(w.taxableAmount) * w.penaltyRate,
    0,
  );
  sink.add("penalty", "Early withdrawal penalty", penalty);
  const out = {
    lines: sink.lines,
    grossIncome: gross,
    taxableIncome: taxable,
    marginalRate: 0,
    facts,
  };
  return { out: explain ? { ...out, brackets: fill } : out, total: sink.total() };
}

function contributionLimit(q: TaxContributionLimitQuery): number | null {
  if (q.accountType !== "fr-per") return null;
  const d = pickYear(FR_YEARS, q.year);
  const f = q.year > 2026 ? q.priceIndex : 1;
  const pass = d.per.passPriorYear * f;
  return Math.max(d.per.rate * pass, d.per.rate * Math.min(q.earnedIncome, d.per.maxPass * pass));
}

export const frJurisdiction = nationalJurisdiction({
  id: ID,
  label: "France (impôt sur le revenu, CSG/CRDS, PFU, PEA, assurance-vie, PER)",
  country: "FR",
  compute,
  contributionLimit,
  // PER: available from the legal retirement age (LFSS 2026 table), or on retiring.
  pensionAccessAge: (q) =>
    q.accountType === "fr-per" ? frLegalRetirementAge(q.birthYear, q.birthMonth) : null,
  // Résidence principale: the gain is exempt.
  homeSaleExclusion: () => Number.POSITIVE_INFINITY,
  lawToggles: [
    {
      id: "fr.baremeOption",
      label: "Option for the barème on capital income (instead of the PFU)",
      default: false,
    },
    { id: "fr.peaHeld5Years", label: "PEA held at least 5 years", default: true },
    {
      id: "fr.assuranceVieHeld8Years",
      label: "Assurance-vie held at least 8 years",
      default: true,
    },
  ],
  sources: FR_YEARS.flatMap((y) => y.sources.map((s) => ({ taxYear: y.label, ...s }))),
  simplifications: FR_SIMPLIFICATIONS,
});
