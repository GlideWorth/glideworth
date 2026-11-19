/**
 * Germany: Einkommensteuer (§32a formula zones, Ehegattensplitting), Solidaritätszuschlag with its
 * Freigrenze and Milderungszone, optional Kirchensteuer, employee social contributions (pension,
 * health incl. average Zusatzbeitrag, long-term care with childless surcharge / child discounts,
 * unemployment) with contribution ceilings, Vorsorgeaufwendungen, Abgeltungsteuer + Soli on capital
 * income with the Sparer-Pauschbetrag and equity-fund Teilfreistellung, taxable share of statutory
 * pensions by first year of payment, bAV (§3 Nr. 63), Riester (§10a), Rürup (§10(3)) and the
 * Aktivrente (§3 Nr. 21: wages after the Regelaltersgrenze tax-free up to 24,000 EUR a year).
 * Data: ../data/de.ts. Known simplifications: DE_SIMPLIFICATIONS.
 */
import {
  alivePeople,
  birthYearOf,
  clamp0,
  collectIncome,
  formulaFill,
  indexFactor,
  LineSink,
  lastFact,
  periodScale,
  personDeductions,
  pickYear,
  statePensionOf,
  withdrawalsFrom,
} from "../common.js";
import {
  DE_DEFERRAL_UPLIFT_PER_MONTH,
  DE_SIMPLIFICATIONS,
  DE_YEARS,
  type DeYear,
  deBesteuerungsanteil,
  deRegelaltersgrenze,
} from "../data/de.js";
import type {
  BracketFill,
  PensionAccessQuery,
  TaxContributionLimitQuery,
  TaxPerson,
  TaxYearInput,
} from "../types.js";
import { type CountryResult, nationalJurisdiction, splitTax } from "./intl.js";

const ID = "de";
const DE_PENSIONS = new Set(["de-bav", "de-riester", "de-ruerup"]);

/** §32a(1) EStG tariff on zvE `x` with thresholds scaled by `f` (euro rounding omitted). */
export function deTariff(x: number, d: DeYear, f = 1): number {
  const t = d.tariff;
  const v = x / f;
  let tax: number;
  if (v <= t.grundfreibetrag) tax = 0;
  else if (v <= t.zone2End) {
    const y = (v - t.grundfreibetrag) / 10_000;
    tax = (t.zone2[0] * y + t.zone2[1]) * y;
  } else if (v <= t.zone3End) {
    const z = (v - t.zone2End) / 10_000;
    tax = (t.zone3[0] * z + t.zone3[1]) * z + t.zone3[2];
  } else if (v <= t.zone4End) tax = 0.42 * v - t.zone4Minus;
  else tax = 0.45 * v - t.zone5Minus;
  return tax * f;
}

/** Statutory marginal rate of the tariff at zvE `x`. */
export function deTariffRate(x: number, d: DeYear, f = 1): number {
  const t = d.tariff;
  const v = x / f;
  if (v <= t.grundfreibetrag) return 0;
  if (v <= t.zone2End)
    return (2 * t.zone2[0] * ((v - t.grundfreibetrag) / 10_000) + t.zone2[1]) / 10_000;
  if (v <= t.zone3End) return (2 * t.zone3[0] * ((v - t.zone2End) / 10_000) + t.zone3[1]) / 10_000;
  return v <= t.zone4End ? 0.42 : 0.45;
}

function zoneEdges(d: DeYear, f: number) {
  const t = d.tariff;
  return [
    { from: 0, label: "Grundfreibetrag" },
    { from: t.grundfreibetrag * f, label: "Zone 2 (14-24%)" },
    { from: t.zone2End * f, label: "Zone 3 (24-42%)" },
    { from: t.zone3End * f, label: "42%" },
    { from: t.zone4End * f, label: "45% (Reichensteuer)" },
  ];
}

interface PersonDe {
  id: string;
  zvE: number;
  /** Employment income after the Werbungskosten allowance (§49(1) Nr. 4 income for non-residents). */
  employment: number;
  capitalInterestDiv: number;
  capitalGains: number;
  social: { pension: number; unemployment: number; health: number; care: number };
  credits: number;
  pensionStart: number | undefined;
  gross: number;
}

/**
 * Months of `year` that qualify for the Aktivrente: work from the month after the person reaches the
 * Regelaltersgrenze (§3 Nr. 21 EStG). Without a birth month the birthday is taken as 1 July.
 */
export function deAktivrenteMonths(
  birthYear: number,
  birthMonth: number | undefined,
  year: number,
) {
  const reached =
    birthYear * 12 + ((birthMonth ?? 7) - 1) + Math.round(deRegelaltersgrenze(birthYear) * 12);
  return Math.min(12, Math.max(0, year * 12 + 12 - (reached + 1)));
}

function personDe(input: TaxYearInput, d: DeYear, fs: number, person: TaxPerson): PersonDe {
  const pid = person.id;
  const age = person.age;
  const birthYear = birthYearOf(person, input.year);
  const people = alivePeople(input);
  const b = collectIncome(input, ID, pid, people);
  const ded = personDeductions(input, pid, people);
  const S = d.social;
  const P = d.pensions;
  const equity = input.config.lawToggles["de.equityFunds"] ?? true;

  // ---- pension contributions
  const riester = ded.pretaxByType["de-riester"] ?? 0;
  const ruerup = ded.pretaxByType["de-ruerup"] ?? 0;
  const bav = ded.pretax - riester - ruerup;
  const bavTaxFree = Math.min(bav, P.bavTaxFreeShare * S.ceilingPension * fs);
  const bavSocialFree = Math.min(bav, P.bavSocialFreeShare * S.ceilingPension * fs);

  // ---- employment income (Aktivrente: §3 Nr. 21, one twelfth of 24,000 a qualifying month)
  const wage = b.wage;
  const aktivrente = Math.min(
    clamp0(wage - bavTaxFree),
    (d.aktivrente * fs * deAktivrenteMonths(birthYear, person.birthMonth, input.year)) / 12,
  );
  const taxWage = clamp0(wage - bavTaxFree - aktivrente);
  const employment = clamp0(taxWage - d.allowances.werbungskosten * fs);
  const svWage = clamp0(wage - bavSocialFree);

  // ---- pensions: statutory (Besteuerungsanteil), Rürup (same), bAV / Riester / other (full)
  const state = statePensionOf(input, pid, people);
  const otherPension = clamp0(b.pension + b.socialSecurity - state);
  const ruerupOut = withdrawalsFrom(input, pid, people, new Set(["de-ruerup"])).taxable;
  const bavOut = withdrawalsFrom(input, pid, people, new Set(["de-bav"])).taxable;
  const otherDeferred = clamp0(b.deferredWithdrawals - ruerupOut);
  const priorStart = lastFact(input, `de.pensionStart.${pid}`);
  const pensionStart = priorStart ?? (state + ruerupOut > 0 ? input.year : undefined);
  const share = pensionStart !== undefined ? deBesteuerungsanteil(pensionStart) : 1;
  const pensionGross = share * (state + ruerupOut) + otherPension + otherDeferred;
  const pensions = clamp0(
    pensionGross - Math.min(pensionGross, d.allowances.werbungskostenPensions * fs),
  );

  // ---- social contributions (employee shares; pensioners on pensions)
  const capP = S.ceilingPension * fs;
  const capH = S.ceilingHealth * fs;
  const kids25 = input.dependents.filter((x) => x.age < 25).length;
  // §55(3) SGB XI: no surcharge for parents (of children of any age), under 23 or born before 1940.
  const parent = kids25 > 0 || (input.config.lawToggles["de.parent"] ?? false);
  const childless = !parent && age >= 23 && birthYear >= 1940;
  const careEmployee =
    S.longTermCare / 2 +
    (childless ? S.longTermCareChildlessSurcharge : 0) -
    S.longTermCareChildDiscount * Math.min(4, Math.max(0, kids25 - 1));
  const careFull = careEmployee + S.longTermCare / 2;
  const healthHalf = (S.health + S.healthSupplementAverage) / 2;
  const rv = (S.pension / 2) * Math.min(svWage, capP);
  const av = (S.unemployment / 2) * Math.min(svWage, capP);
  const wageH = Math.min(svWage, capH);
  const stateH = Math.min(state, clamp0(capH - wageH));
  const versorgH = Math.min(otherPension + bavOut, clamp0(capH - wageH - stateH));
  const kvWage = healthHalf * wageH;
  const kv = kvWage + healthHalf * stateH + 2 * healthHalf * versorgH;
  const pv = careEmployee * wageH + careFull * (stateH + versorgH);

  // ---- Sonderausgaben
  const employerRv = rv;
  const altersvorsorge = clamp0(
    Math.min(rv + employerRv + ruerup, P.altersvorsorgeMax * fs) - employerRv,
  );
  const riesterDed = Math.min(riester, P.riesterMax * fs);
  const kvpv = kvWage * (1 - S.sickPayShare) + (kv - kvWage) + pv;
  const other = Math.max(ded.deductions, d.allowances.sonderausgaben * fs);

  const gde = employment + b.selfEmployment + pensions + b.rental + b.ordinary;
  const zvE = clamp0(gde - altersvorsorge - riesterDed - kvpv - other);

  const fundShare = equity ? 1 - d.capital.equityFundExemption : 1;
  return {
    id: pid,
    zvE,
    employment,
    capitalInterestDiv: b.interest + (b.qualifiedDividends + b.ordinaryDividends) * fundShare,
    capitalGains: (b.gainsLong + b.gainsShort) * fundShare,
    social: { pension: rv, unemployment: av, health: kv, care: pv },
    credits: ded.credits,
    pensionStart,
    gross:
      wage +
      b.selfEmployment +
      b.pension +
      b.socialSecurity +
      b.ordinary +
      b.rental +
      b.interest +
      b.qualifiedDividends +
      b.ordinaryDividends +
      b.gainsLong +
      b.gainsShort +
      b.deferredWithdrawals +
      b.deferredTaxFree,
  };
}

function churchRate(input: TaxYearInput, d: DeYear): number {
  if (!(input.config.lawToggles["de.churchTax"] ?? false)) return 0;
  const r = (input.location.region ?? "").toUpperCase().replace(/^DE-/, "");
  return d.churchTax.reducedRegions.includes(r) ? d.churchTax.reducedRate : d.churchTax.rate;
}

function compute(input: TaxYearInput, explain: boolean): CountryResult {
  const d = pickYear(DE_YEARS, input.year);
  const idx = indexFactor(input, ID, undefined);
  const fs = idx.factor * periodScale(input);
  const people = alivePeople(input);
  const joint = input.filingStatus === "married-joint" && people.length === 2;
  const k = churchRate(input, d);
  const rs = people.map((p) => personDe(input, d, fs, p));
  const sink = new LineSink(ID);
  const facts: Record<string, number> = {
    ...idx.facts,
    "tax.year": input.year,
    "tax.priceIndex": input.priceIndex,
  };
  const fill: BracketFill[] = [];
  const multi = people.length > 1;

  // ---- assessments: one joint (splitting) or one per person
  const assessments = joint
    ? [
        {
          ids: rs.map((r) => r.id),
          zvE: rs[0]!.zvE + rs[1]!.zvE,
          sfx: "",
          freigrenze: d.soli.freigrenzeJoint,
        },
      ]
    : rs.map((r) => ({
        ids: [r.id],
        zvE: r.zvE,
        sfx: multi ? ` (${r.id})` : "",
        freigrenze: d.soli.freigrenzeSingle,
      }));
  for (const [ai, a] of assessments.entries()) {
    const half = joint ? a.zvE / 2 : a.zvE;
    const mult = joint ? 2 : 1;
    const credits = rs.filter((r) => a.ids.includes(r.id)).reduce((s, r) => s + r.credits, 0);
    // Non-residents (§50(1) sentence 2 EStG): the tariff applies to taxable income increased by
    // the Grundfreibetrag; for pay, only by the part of the Grundfreibetrag above the pay.
    const nonResidentAdd =
      !joint && input.nonResident?.personalAllowance[a.ids[0]!] === false
        ? clamp0(
            d.tariff.grundfreibetrag * fs - (rs.find((r) => r.id === a.ids[0])?.employment ?? 0),
          )
        : 0;
    const est = clamp0(mult * deTariff(half + nonResidentAdd, d, fs) - credits);
    const fg = a.freigrenze * fs;
    const soli = est <= fg ? 0 : Math.min(d.soli.rate * est, d.soli.milderungsRate * (est - fg));
    sink.add("income", `Einkommensteuer${joint ? " (Splitting)" : ""}${a.sfx}`, est, a.zvE);
    sink.add("other", `Solidaritätszuschlag${a.sfx}`, soli, est);
    sink.add("other", `Kirchensteuer${a.sfx}`, k * est, est);
    const rate = a.zvE > 0 ? deTariffRate(half, d, fs) : 0;
    for (const id of a.ids) facts[`tax.ordinaryBracketRate.${id}`] = rate;
    if (ai === 0) facts["tax.ordinaryBracketRate"] = rate;
    if (explain) {
      const bands = formulaFill((x) => deTariff(x, d, fs), zoneEdges(d, fs), half).map((bd) => ({
        ...bd,
        from: bd.from * mult,
        to: bd.to * mult,
        amount: bd.amount * mult,
        tax: bd.tax * mult,
      }));
      fill.push({
        jurisdictionId: ID,
        ...(joint ? {} : { personId: a.ids[0]! }),
        schedule: "einkommen",
        bands,
      });
    }
  }

  // ---- Abgeltungsteuer (+ Soli, + KiSt via the reduced-rate formula §32d(1) Satz 4)
  const spb = d.capital.sparerPauschbetrag * fs;
  const capitalGroups = joint ? [rs] : rs.map((r) => [r]);
  for (const g of capitalGroups) {
    const sfx = !joint && multi ? ` (${g[0]!.id})` : "";
    const id = g.reduce((s, r) => s + r.capitalInterestDiv, 0);
    const gains = g.reduce((s, r) => s + r.capitalGains, 0);
    const base = clamp0(id + gains - spb * g.length);
    // (e - 4q) / (4 + k): with no church tax this is the 25% rate.
    const abgelt = k > 0 ? (base * d.capital.rate * 4) / (4 + k) : d.capital.rate * base;
    const [onIncome, onGains] = splitTax(abgelt, [id, gains]);
    sink.add("dividends", `Abgeltungsteuer (Zinsen, Dividenden)${sfx}`, onIncome!, base);
    sink.add("capital-gains", `Abgeltungsteuer (Veräußerungsgewinne)${sfx}`, onGains!);
    sink.add("other", `Solidaritätszuschlag auf Abgeltungsteuer${sfx}`, d.soli.rate * abgelt);
    sink.add("other", `Kirchensteuer auf Abgeltungsteuer${sfx}`, k * abgelt);
  }

  // ---- social contributions
  let taxable = 0;
  let gross = 0;
  for (const r of rs) {
    const sfx = multi ? ` (${r.id})` : "";
    sink.add("payroll", `Rentenversicherung${sfx}`, r.social.pension);
    sink.add("payroll", `Arbeitslosenversicherung${sfx}`, r.social.unemployment);
    sink.add("payroll", `Krankenversicherung${sfx}`, r.social.health);
    sink.add("payroll", `Pflegeversicherung${sfx}`, r.social.care);
    facts[`de.zvE.${r.id}`] = r.zvE;
    if (r.pensionStart !== undefined) facts[`de.pensionStart.${r.id}`] = r.pensionStart;
    taxable += r.zvE;
    gross += r.gross;
  }
  const penalty = input.withdrawals.reduce(
    (s, w) => s + clamp0(w.taxableAmount) * w.penaltyRate,
    0,
  );
  sink.add("penalty", "Early withdrawal penalty", penalty);
  facts["de.zvE"] = taxable;
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
  const d = pickYear(DE_YEARS, q.year);
  const f = q.year > d.startYear ? q.priceIndex : 1;
  switch (q.accountType) {
    case "de-riester":
      return d.pensions.riesterMax * f;
    case "de-ruerup":
      return d.pensions.altersvorsorgeMax * f;
    case "de-bav":
      return d.pensions.bavTaxFreeShare * d.social.ceilingPension * f;
    default:
      return null;
  }
}

function pensionAccessAge(q: PensionAccessQuery): number | null {
  return DE_PENSIONS.has(q.accountType) ? pickYear(DE_YEARS, 2026).pensions.accessAge : null;
}

export const deJurisdiction = nationalJurisdiction({
  id: ID,
  label: "Germany (Einkommensteuer, Soli, Kirchensteuer, Sozialversicherung, Abgeltungsteuer)",
  country: "DE",
  compute,
  contributionLimit,
  pensionAccessAge,
  statePensionAge: (q) => deRegelaltersgrenze(q.birthYear),
  statePensionDeferralUplift: (q) => DE_DEFERRAL_UPLIFT_PER_MONTH * Math.max(0, q.monthsDeferred),
  // §23(1) Nr. 1 EStG: gains on a home used by the owner are not taxable.
  homeSaleExclusion: () => Number.POSITIVE_INFINITY,
  lawToggles: [
    { id: "de.churchTax", label: "Kirchensteuer (church member)", default: false },
    {
      id: "de.parent",
      label: "Has children, including grown-up ones (no childless long-term care surcharge)",
      default: false,
    },
    {
      id: "de.equityFunds",
      label: "Investments are equity funds (30% Teilfreistellung)",
      default: true,
    },
  ],
  sources: DE_YEARS.flatMap((y) => y.sources.map((s) => ({ taxYear: y.label, ...s }))),
  simplifications: DE_SIMPLIFICATIONS,
});
