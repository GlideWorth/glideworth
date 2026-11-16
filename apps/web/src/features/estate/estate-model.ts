/**
 * Estate / legacy numbers per year from core's estate functions (`estimateUkInheritanceTax`,
 * `estimateUsEstateTax`, `estimateNetLegacy`). Every figure is "if the last surviving person died at
 * the end of this year", in nominal money; callers convert with the period price index.
 */
import {
  ACCOUNT_TYPE_INFO,
  estimateNetLegacy,
  estimateUkInheritanceTax,
  estimateUsEstateTax,
  type GlideworthDocument,
  type PeriodResult,
  type Plan,
  type ProjectionResult,
  UK_TAX_YEARS,
} from "@glideworth/core";

export type EstateRegime = "uk" | "us" | "none";

export function estateRegime(doc: GlideworthDocument): EstateRegime {
  const c = doc.household.location.country;
  return c === "GB" ? "uk" : c === "US" ? "us" : "none";
}

export interface EstateYear {
  index: number;
  year: number;
  /** Assets less debts (what the legacy helper calls "legacy"). */
  estate: number;
  assets: number;
  debts: number;
  cash: number;
  taxFree: number;
  taxable: number;
  taxDeferred: number;
  realEstate: number;
  home: number;
  estateTax: number;
  /** Tax as a share of the estate. */
  taxRate: number;
  heirIncomeTax: number;
  embeddedGainsTax: number;
  liquidationCosts: number;
  adminCosts: number;
  netLegacy: number;
  toCharity: number;
  toHeirs: number;
  /** Country-specific detail lines for the selected-year breakdown. */
  detail: { label: string; value: number | string; note?: string }[];
  source?: string;
  /** Names the tax: "Inheritance Tax", "Federal estate tax", ... */
  taxName: string;
}

export interface EstateOptions {
  /** A couple: assume the first death passed everything to the partner, so unused allowances transfer. */
  transferAllowances: boolean;
}

function homeEquity(doc: GlideworthDocument, plan: Plan, p: PeriodResult): number {
  const homes = new Set<string>();
  for (const a of doc.finances.realAssets) {
    const usage = plan.realAssetSettings?.[a.id]?.usage ?? a.behaviour.usage;
    if (usage === "primary-residence") homes.add(a.id);
  }
  return p.realAssets
    .filter((r) => r.owned && homes.has(r.assetId))
    .reduce((s, r) => s + Math.max(0, r.equity), 0);
}

/** UK price index at the end of the legislated nil-rate-band freeze. */
function freezeEndIndex(result: ProjectionResult): number | undefined {
  const last = UK_TAX_YEARS[UK_TAX_YEARS.length - 1];
  const frozen = last?.iht.frozenThrough;
  if (frozen === undefined) return undefined;
  const per = [...result.periods].reverse().find((x) => x.year <= frozen);
  return per?.priceIndex;
}

export function estateSeries(
  doc: GlideworthDocument,
  plan: Plan,
  result: ProjectionResult,
  opts: EstateOptions,
): EstateYear[] {
  const regime = estateRegime(doc);
  const accounts = new Map(doc.finances.accounts.map((a) => [a.id, a]));
  const planned = new Map((plan.plannedAccounts ?? []).map((a) => [a.id, a]));
  const settings = plan.tax.estate;
  const freeze = freezeEndIndex(result);
  return result.periods.map((p, index) => {
    let cash = 0;
    let taxFree = 0;
    let taxable = 0;
    let taxableBasis = 0;
    let taxDeferred = 0;
    let ukPensions = 0;
    for (const a of p.accounts) {
      const def = accounts.get(a.accountId) ?? planned.get(a.accountId);
      if (!def) {
        cash += a.closing;
        continue;
      }
      const info = ACCOUNT_TYPE_INFO[def.type];
      if (info.taxTreatment === "tax-deferred") {
        taxDeferred += a.closing;
        if (def.type.startsWith("uk-")) ukPensions += a.closing;
      } else if (info.taxTreatment === "tax-free") taxFree += a.closing;
      else if (info.taxTreatment === "taxable") {
        taxable += a.closing;
        taxableBasis += a.costBasis ?? a.closing;
      } else cash += a.closing;
    }
    const realEstate = p.totals.realAssets;
    const debts = p.totals.liabilities;
    const home = homeEquity(doc, plan, p);
    const estate = taxDeferred + taxable + taxFree + cash + realEstate - debts;
    let estateTax = 0;
    let taxName = "Estate tax";
    let source: string | undefined;
    const detail: EstateYear["detail"] = [];
    if (regime === "uk") {
      taxName = "Inheritance Tax";
      const r = estimateUkInheritanceTax({
        year: p.year,
        netEstate: Math.max(0, estate - ukPensions),
        homeToDescendants: home,
        pensions: ukPensions,
        priceIndex: p.priceIndex,
        charityShare: settings.charitableShare,
        ...(opts.transferAllowances ? { transferredNrbShare: 1, transferredRnrbShare: 1 } : {}),
        ...(freeze !== undefined ? { freezeEndPriceIndex: freeze } : {}),
      });
      estateTax = r.tax;
      source = r.source;
      detail.push(
        { label: "Estate counted for tax", value: r.grossEstate },
        { label: "Nil-rate band", value: r.nilRateBand },
        { label: "Residence nil-rate band", value: r.residenceNilRateBand },
        { label: "Left to charity", value: r.charity },
        { label: "Taxable estate", value: r.taxable },
        {
          label: "Rate",
          value: `${Math.round(r.rate * 100)}%`,
          note: r.rate < 0.4 ? "Reduced rate: at least 10% goes to charity" : undefined,
        },
      );
      if (r.pensionsIncluded > 0)
        detail.push({
          label: "Unused pensions included",
          value: r.pensionsIncluded,
          note: "Counted in the estate from April 2027",
        });
    } else if (regime === "us") {
      taxName = "Federal estate tax";
      const r = estimateUsEstateTax({
        year: p.year,
        grossEstate: Math.max(0, estate),
        toCharity: Math.max(0, estate) * settings.charitableShare,
        priceIndex: p.priceIndex,
        ...(opts.transferAllowances
          ? {
              dsue: estimateUsEstateTax({ year: p.year, grossEstate: 0, priceIndex: p.priceIndex })
                .exclusion,
            }
          : {}),
      });
      estateTax = r.tax;
      source = r.source;
      detail.push(
        { label: "Taxable estate", value: r.taxableEstate },
        { label: "Exclusion (incl. portability)", value: r.exclusion },
      );
    }
    const net = estimateNetLegacy({
      taxDeferred,
      taxable,
      taxableCostBasis: taxableBasis,
      taxFree,
      cash,
      realEstate,
      otherAssets: 0,
      debts,
      estateTax,
      settings,
    });
    return {
      index,
      year: p.year,
      estate: net.legacy,
      assets: net.legacy + debts,
      debts,
      cash,
      taxFree,
      taxable,
      taxDeferred,
      realEstate,
      home,
      estateTax,
      taxRate: net.legacy > 0 ? estateTax / net.legacy : 0,
      heirIncomeTax: net.heirIncomeTax,
      embeddedGainsTax: net.embeddedGainsTax,
      liquidationCosts: net.liquidationCosts,
      adminCosts: net.adminCosts,
      netLegacy: net.netLegacy,
      toCharity: net.toCharity,
      toHeirs: net.toHeirs,
      detail,
      taxName,
      ...(source ? { source } : {}),
    };
  });
}

export interface PassRow {
  stage: string;
  from: string;
  to: string;
  amount: number;
  tax: number;
  note: string;
}

/**
 * What passes to whom in a year. Single person: estate to heirs. Couple: each partner's share goes to
 * the other free of tax (spouse exemption / marital deduction), then the whole estate goes to heirs
 * at the second death, after tax, costs and any charity share.
 */
export function passesToWhom(
  doc: GlideworthDocument,
  result: ProjectionResult,
  y: EstateYear,
  regime: EstateRegime,
): PassRow[] {
  const p = result.periods[y.index]!;
  const people = doc.household.people;
  const rows: PassRow[] = [];
  const alive = people.filter((x) => p.alive[x.id] !== false);
  const byOwner = p.totals.netWorthByOwner ?? {};
  const joint = byOwner.joint ?? 0;
  if (people.length > 1 && alive.length === people.length) {
    for (const person of people) {
      const other = people.find((x) => x.id !== person.id)!;
      const share = (byOwner[person.id] ?? 0) + joint / 2;
      rows.push({
        stage: `If ${person.name} dies first`,
        from: person.name,
        to: other.name,
        amount: share,
        tax: 0,
        note:
          regime === "uk"
            ? "Spouse exemption: no Inheritance Tax; unused nil-rate bands transfer to the survivor."
            : regime === "us"
              ? "Unlimited marital deduction; the unused exclusion can be carried over (portability)."
              : "Assumed to pass to the surviving partner.",
      });
    }
  }
  const last = people.length > 1 ? "If both have died" : "Your estate";
  const who =
    people.length > 1 ? people.map((x) => x.name).join(" and ") : (people[0]?.name ?? "You");
  rows.push({
    stage: last,
    from: who,
    to: "Heirs",
    amount: y.toHeirs,
    tax: y.estateTax,
    note: `After ${y.taxName.toLowerCase()}, heirs' tax on pensions and gains, and selling and admin costs.`,
  });
  if (y.toCharity > 0)
    rows.push({
      stage: last,
      from: who,
      to: "Charity",
      amount: y.toCharity,
      tax: 0,
      note: "From the charitable share in the plan tax settings.",
    });
  return rows;
}
