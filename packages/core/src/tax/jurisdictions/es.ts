/**
 * Spain (territorio común): IRPF state + autonomous-community general scales (regional data-table
 * hook: ES_REGIONAL_SCALES), savings scale, mínimo personal y familiar (taxed at the scale and
 * subtracted), work-income expenses and reduction, employee social security with the maximum base,
 * pension-plan contributions within their limits, and the optional wealth tax (Impuesto sobre el
 * Patrimonio) with the solidarity tax on large fortunes on TaxYearInput.wealth. Parameterised:
 * 'es:MD', 'es:CT', 'es:AN', 'es:VC'; any other region uses a regional scale equal to the state one.
 * Data: ../data/es.ts. Known simplifications: ES_SIMPLIFICATIONS.
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
  personDeductions,
  pickYear,
  sliceTax,
} from "../common.js";
import {
  ES_REGION_ALIASES,
  ES_REGIONAL_SCALES,
  ES_SIMPLIFICATIONS,
  ES_YEARS,
  type EsRegion,
  type EsYear,
} from "../data/es.js";
import type {
  BracketFill,
  TaxContributionLimitQuery,
  TaxJurisdiction,
  TaxYearInput,
} from "../types.js";
import { type CountryResult, nationalJurisdiction } from "./intl.js";

export function esRegion(code: string | undefined): EsRegion {
  if (!code) return ES_REGIONAL_SCALES.DEFAULT!;
  const c = code.toUpperCase();
  const key = ES_REGION_ALIASES[c] ?? c;
  const r = ES_REGIONAL_SCALES[key];
  if (r) return r;
  if (/^[A-Z]{1,2}$/.test(key) || key.startsWith("ES-")) return ES_REGIONAL_SCALES.DEFAULT!;
  throw new ScenarioError(`unknown Spanish autonomous community '${code}'`, { region: code });
}

/**
 * Art. 20 LIRPF reduction. `net` is net work income after the art. 19.2 a)-e) expenses (social
 * security) but before the 2,000 other expenses (art. 20, last paragraph); 0 when other income exceeds
 * the limit. The caller caps it at the net income left after the other expenses.
 */
export function esWorkReduction(d: EsYear, net: number, otherIncome: number, f = 1): number {
  const W = d.work;
  if (net >= W.limit * f || otherIncome > W.otherIncomeLimit * f) return 0;
  for (const r of W.reduction)
    if (net <= r.upTo * f)
      return Math.min(net, clamp0(r.base * f - r.slope * clamp0(net - r.from * f)));
  return 0;
}

/** Personal and family minimum for one person (descendants shared between `parents`). */
export function esMinimum(
  d: EsYear,
  age: number,
  kidAges: number[],
  parents: number,
  f = 1,
): number {
  const M = d.minimums;
  // From 65 and 75 (AEAT Manual práctico de Renta 2025: "edad igual o superior a 65 años o a 75 años").
  let m = M.personal + (age >= 65 ? M.over65 : 0) + (age >= 75 ? M.over75 : 0);
  let kids = 0;
  kidAges.forEach((a, i) => {
    kids += (M.descendants[Math.min(i, M.descendants.length - 1)] ?? 0) + (a < 3 ? M.under3 : 0);
  });
  m += kids / Math.max(1, parents);
  return m * f;
}

/**
 * Scale tax on `base` less the scale tax on the part covered by the minimum, i.e. the scale tax on
 * the slice [minimum, base) (the minimum shows as a 0% band in the fill).
 */
function withMinimum(
  rows: [number, number][],
  f: number,
  base: number,
  minimum: number,
  fill?: BracketFill["bands"],
) {
  const m = Math.min(base, minimum);
  if (fill && m > 0)
    fill.push({
      label: "Mínimo personal y familiar",
      rate: 0,
      from: 0,
      to: minimum,
      amount: m,
      tax: 0,
    });
  const r = sliceTax(bands(rows, f), m, base - m, fill);
  return { tax: r.tax, marginal: r.marginal };
}

/**
 * Wealth tax and solidarity tax (ITSGF) for one person's net worth `perPerson`. The ITSGF is due on
 * the part of its own amount not covered by the wealth tax paid (Ley 38/2022 art. 3.Quince), so the
 * total is the larger of the two. In Madrid and Andalucía the regional 100% bonificación only removes
 * the wealth tax above the ITSGF while the ITSGF is in force.
 */
export function esWealthTax(d: EsYear, region: EsRegion, perPerson: number, f = 1) {
  const base = clamp0(perPerson - (region.wealthExempt ?? d.wealth.exempt) * f);
  const gross = sliceTax(bands(region.wealthScale ?? d.wealth.stateScale, f), 0, base).tax;
  const solidarityBase = clamp0(perPerson - d.solidarity.exempt * f);
  const solidarity = sliceTax(bands(d.solidarity.scale, f), 0, solidarityBase).tax;
  const wealthTax = region.wealthBonusDownToSolidarity ? Math.min(gross, solidarity) : gross;
  return {
    base,
    wealthTax,
    solidarityBase,
    solidarityTax: clamp0(solidarity - wealthTax),
  };
}

function compute(input: TaxYearInput, explain: boolean, code?: string): CountryResult {
  const id = code ? `es:${code}` : "es";
  const region = esRegion(code ?? input.location.region);
  const d = pickYear(ES_YEARS, input.year);
  const idx = indexFactor(input, "es", undefined);
  const scale = periodScale(input);
  const fs = idx.factor * scale;
  const people = alivePeople(input);
  const sink = new LineSink(id);
  const facts: Record<string, number> = {
    ...idx.facts,
    "tax.year": input.year,
    "tax.priceIndex": input.priceIndex,
  };
  const fill: BracketFill[] = [];
  const multi = people.length > 1;
  const kidAges = input.dependents.filter((x) => x.age < 25).map((x) => x.age);
  let taxable = 0;
  let gross = 0;
  people.forEach((p, i) => {
    const sfx = multi ? ` (${p.id})` : "";
    const b = collectIncome(input, id, p.id, people);
    const ded = personDeductions(input, p.id, people);
    // ---- work income (salary, pensions, plan withdrawals)
    const ss = d.social.employeeRate * Math.min(b.wage, d.social.maxBase * fs);
    const workGross = b.wage + b.pension + b.socialSecurity + b.deferredWithdrawals;
    const workNet0 = clamp0(workGross - ss);
    const workNet1 = clamp0(workNet0 - Math.min(workNet0, d.work.otherExpenses * fs));
    const otherGeneral = b.selfEmployment + b.rental + b.ordinary;
    const savings =
      b.interest + b.qualifiedDividends + b.ordinaryDividends + b.gainsLong + b.gainsShort;
    const reduction = Math.min(workNet1, esWorkReduction(d, workNet0, otherGeneral + savings, fs));
    const work = clamp0(workNet1 - reduction);
    // ---- pension plan contributions: personal limit and 30% of net work and activity income
    // (employer contributions are income in kind and deductible: they net out and are ignored)
    const PP = d.pensionPlan;
    const plan = Math.min(
      ded.pretax,
      PP.personalLimit * fs,
      PP.incomeShare * (workNet1 + b.selfEmployment),
    );
    const blg = clamp0(work + otherGeneral - plan - ded.deductions);
    const bla = savings;
    // ---- minimum: against the general base first, the rest against savings
    const minimum = esMinimum(d, p.age, kidAges, Math.min(2, people.length), fs);
    const minSavings = clamp0(minimum - blg);
    const stateFill: BracketFill["bands"] | undefined = explain ? [] : undefined;
    const regFill: BracketFill["bands"] | undefined = explain ? [] : undefined;
    const st = withMinimum(d.stateGeneral, fs, blg, minimum, stateFill);
    const rg = withMinimum(region.general, fs, blg, minimum, regFill);
    const sav = 2 * withMinimum(d.savingsHalf, fs, bla, minSavings).tax;
    const credits = Math.min(ded.credits, st.tax + rg.tax + sav);
    if (stateFill)
      fill.push({
        jurisdictionId: id,
        personId: p.id,
        schedule: "general (state)",
        bands: stateFill,
      });
    if (regFill)
      fill.push({
        jurisdictionId: id,
        personId: p.id,
        schedule: `general (${region.name})`,
        bands: regFill,
      });
    sink.add("income", `IRPF cuota estatal${sfx}`, st.tax, blg);
    sink.add("income", `IRPF cuota autonómica (${region.name})${sfx}`, rg.tax, blg);
    const [sInt, sGain] = [
      b.interest + b.qualifiedDividends + b.ordinaryDividends,
      b.gainsLong + b.gainsShort,
    ];
    sink.add(
      "dividends",
      `IRPF base del ahorro (rendimientos)${sfx}`,
      bla > 0 ? (sav * sInt) / bla : 0,
      bla,
    );
    sink.add(
      "capital-gains",
      `IRPF base del ahorro (ganancias)${sfx}`,
      bla > 0 ? (sav * sGain) / bla : 0,
    );
    sink.add("credit", `Deducciones${sfx}`, -credits);
    sink.add("payroll", `Seguridad Social (trabajador)${sfx}`, ss);
    const rate = blg > minimum ? st.marginal + rg.marginal : 0;
    facts[`tax.ordinaryBracketRate.${p.id}`] = rate;
    if (i === 0) facts["tax.ordinaryBracketRate"] = rate;
    facts[`es.baseGeneral.${p.id}`] = blg;
    facts[`es.baseAhorro.${p.id}`] = bla;
    taxable += blg + bla;
    gross += workGross + otherGeneral + savings + b.deferredTaxFree;
  });
  // ---- wealth tax and solidarity tax on large fortunes (optional)
  if ((input.config.lawToggles["es.wealthTax"] ?? false) && input.wealth) {
    const w = esWealthTax(d, region, input.wealth.netWorth / people.length, idx.factor);
    const n = people.length * scale;
    sink.add("wealth", "Impuesto sobre el Patrimonio", w.wealthTax * n, w.base * people.length);
    sink.add(
      "wealth",
      "Impuesto temporal de solidaridad de las grandes fortunas",
      w.solidarityTax * n,
      w.solidarityBase * people.length,
    );
  }
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
  if (q.accountType !== "es-plan-pensiones") return null;
  const d = pickYear(ES_YEARS, q.year);
  const f = q.year > 2026 ? q.priceIndex : 1;
  return Math.min(d.pensionPlan.personalLimit * f, d.pensionPlan.incomeShare * q.earnedIncome);
}

function makeEs(code?: string): TaxJurisdiction {
  const region = code ? esRegion(code) : undefined;
  return nationalJurisdiction({
    id: region ? `es:${region.code}` : "es",
    label: region
      ? `Spain (IRPF, ${region.name})`
      : "Spain (IRPF state + regional scale, social security, wealth tax)",
    country: "ES",
    compute: (input, explain) => compute(input, explain, region?.code),
    parameterize: (p) => makeEs(esRegion(p).code),
    contributionLimit,
    // Plans are paid out on retirement or after 10 years of seniority: no single access age.
    pensionAccessAge: () => null,
    lawToggles: [
      {
        id: "es.wealthTax",
        label: "Impuesto sobre el Patrimonio and solidarity tax on large fortunes",
        default: false,
      },
    ],
    sources: ES_YEARS.flatMap((y) => y.sources.map((s) => ({ taxYear: y.label, ...s }))),
    simplifications: ES_SIMPLIFICATIONS,
  });
}

export const esJurisdiction = makeEs();
