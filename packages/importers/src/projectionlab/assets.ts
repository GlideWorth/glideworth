/** Real assets (property, vehicles, valuables) with loans, rental and sale behaviour. */
import { REAL_ASSET_TYPES, RealAssetBehaviour } from "@glideworth/core";
import type { ImportIssue } from "../types.js";
import { table, arr, deepEqual, isObj, num, type Obj, obj, pctClean, str } from "../util/read.js";
import {
  appearanceOf,
  basisOf,
  behaviourOverride,
  changeOf,
  clamp,
  currencyOf,
  nameOf,
  ownerOf,
  recurrenceOf,
} from "./common.js";
import { approximated, infoNote, invalid, type PlContext } from "./context.js";
import { resolveRange, resolveRef } from "./dates.js";

const ASSET_TYPE_SET = new Set<string>(REAL_ASSET_TYPES);
const ASSET_ALIASES: Record<string, string> = table({
  "real-estate": "house",
  property: "house",
  home: "house",
  vehicle: "car",
  auto: "car",
  "commercial-real-estate": "commercial-property",
  "rental-property": "rental-property",
  metals: "precious-metals",
  gold: "precious-metals",
  art: "collectible",
  collectibles: "collectible",
  musical: "instrument",
  equipment: "machinery",
  other: "custom",
});

export function assetTypeOf(ctx: PlContext, src: Obj, path: string): string {
  const raw = typeof src.type === "string" ? src.type : "";
  let t: string;
  if (ASSET_TYPE_SET.has(raw)) t = raw;
  else if (ASSET_ALIASES[raw]) t = ASSET_ALIASES[raw]!;
  else {
    invalid(ctx, `${path}.type`, `unknown asset type '${raw}'; imported as 'custom'`);
    t = "custom";
  }
  if (t === "house" && src.generateIncome === true) t = "rental-property";
  return t;
}

function compoundingOf(ctx: PlContext, v: unknown, path: string): string {
  if (v === undefined || v === "monthly") return "monthly";
  if (v === "daily") return "daily";
  if (v === "annually" || v === "yearly" || v === "annual") return "annually";
  approximated(ctx, `${path}.compounding`, `compounding '${String(v)}' approximated as monthly`);
  return "monthly";
}

export function interestOf(ctx: PlContext, src: Obj, path: string): Obj {
  return {
    apr: pctClean(src.interestRate) ?? 0,
    method: src.interestType === "simple" ? "simple" : "compound",
    compounding: compoundingOf(ctx, src.compounding, path),
  };
}

type Per = "year" | "month";

/** A running cost expressed as % of value or as an amount. */
function costOf(ctx: PlContext, src: Obj, key: string, per: Per, path: string): Obj | undefined {
  const v = num(src[key]);
  if (v === undefined || v === 0) return undefined;
  const tag = src[`${key}Type`];
  if (tag === "%" || tag === undefined) return { kind: "percentOfValue", rate: pctClean(v) };
  const amount = { value: v, basis: basisOf(ctx, tag, `${path}.${key}Type`) };
  return { kind: per === "year" ? "amountPerYear" : "amountPerMonth", amount };
}

function propertyTaxOf(ctx: PlContext, src: Obj, path: string): Obj | undefined {
  const cost = costOf(ctx, src, "taxRate", "year", path);
  const at = str(src.assessedValueType);
  const specific = at !== undefined && at !== "market-value";
  if (!cost && !specific) return undefined;
  const out: Obj = { cost: cost ?? { kind: "none" } };
  if (specific) {
    out.assessedValue = { kind: "specific", amount: Math.max(0, num(src.assessedValue) ?? 0) };
    if (at !== "specific" && at !== "custom" && at !== "fixed")
      approximated(
        ctx,
        `${path}.assessedValueType`,
        `assessed value type '${at}' read as a specific amount`,
      );
  }
  const lt = str(src.assessedValueGrowthRateLimitType);
  const limit = pctClean(src.assessedValueGrowthRateLimit);
  if (lt === "capped" || lt === "limit" || lt === "cap")
    out.reassessment = { kind: "capped", maxGrowth: limit ?? 0 };
  else if (lt === "ratcheting" || lt === "ratchet")
    out.reassessment = { kind: "ratcheting", maxGrowth: limit ?? 0 };
  else if (lt === "default") out.reassessment = { kind: "default" };
  else if (lt !== undefined && lt !== "auto")
    invalid(
      ctx,
      `${path}.assessedValueGrowthRateLimitType`,
      `unknown reassessment type '${lt}'; defaulted to auto`,
    );
  return out;
}

function rentalOf(ctx: PlContext, src: Obj, path: string): Obj | undefined {
  if (src.generateIncome !== true) return undefined;
  const rate = num(src.incomeRate) ?? 0;
  const tag = src.incomeRateType;
  let income: Obj;
  if (tag === "%" || tag === undefined) income = { kind: "percentOfValue", rate: pctClean(rate) };
  else {
    income = {
      kind: "amountPerYear",
      amount: { value: rate, basis: basisOf(ctx, tag, `${path}.incomeRateType`) },
    };
    infoNote(
      ctx,
      `${path}.incomeRate`,
      "rental income amount interpreted as per year",
      "pl.rental-income-per-year",
    );
  }
  const mgmt = costOf(ctx, src, "managementRate", "year", path);
  if (mgmt && mgmt.kind === "percentOfValue") {
    approximated(
      ctx,
      `${path}.managementRate`,
      "management fee % is read by the source as a share of rental income; Glideworth applies it to asset value",
      "pl.management-fee",
    );
  }
  const taxSettings: Obj = {};
  if (src.selfEmployment !== undefined) taxSettings.selfEmployment = src.selfEmployment === true;
  if (src.estimateRentalDeductions !== undefined)
    taxSettings.estimateDeductions = src.estimateRentalDeductions === true;
  if (src.estimateQBI !== undefined) taxSettings.qbiDeduction = src.estimateQBI === true;
  const bv = num(src.initialBuildingValue);
  if (bv !== undefined && bv >= 0) taxSettings.buildingValue = bv;
  if (src.classification === "residential" || src.classification === "commercial")
    taxSettings.classification = src.classification;
  else if (src.classification !== undefined)
    invalid(
      ctx,
      `${path}.classification`,
      `unknown classification '${String(src.classification)}'`,
    );
  const rental: Obj = {
    enabled: true,
    income,
    rentedShare:
      src.percentRented === undefined ? 1 : clamp(pctClean(src.percentRented) ?? 1, 0, 1),
    management: mgmt ?? { kind: "none" },
    taxSettings,
  };
  if (src.isPassiveIncome !== undefined)
    rental.countsAsPassiveIncome = src.isPassiveIncome === true;
  if (typeof src.cancelRent === "boolean") rental.cancelOnSale = src.cancelRent;
  return rental;
}

/**
 * `yearlyChange.limit*` -> RealAssetBehaviour.appreciationLimit: a ceiling for appreciating assets,
 * a floor for depreciating ones. Money limits keep their basis; a '%' limit is a share of the
 * asset's initial value.
 */
function appreciationLimitOf(ctx: PlContext, src: Obj, path: string): Obj | undefined {
  const yc = obj(src.yearlyChange);
  if (yc.limitEnabled !== true) return undefined;
  const limit = num(yc.limit);
  if (limit === undefined || limit < 0) return undefined;
  const down = yc.type === "depreciate" || yc.type === "decrease";
  let value = limit;
  let basis: "real" | "nominal" = yc.limitType === "$" ? "nominal" : "real";
  if (yc.limitType === "%") {
    const initial = num(src.initialValue) ?? num(src.amount) ?? 0;
    value = (limit / 100) * initial;
    basis = basisOf(
      ctx,
      src.initialValueType ?? src.amountType,
      `${path}.yearlyChange.limitType`,
    ) as "real" | "nominal";
  }
  approximated(
    ctx,
    `${path}.yearlyChange.limit`,
    `growth limit read as a value ${down ? "floor" : "ceiling"} of ${Math.round(value)} (${basis} money)`,
    "pl.asset-limit",
  );
  return { [down ? "min" : "max"]: value, basis };
}

/** RealAssetBehaviour from a source asset (today asset or plan asset event). */
export function assetBehaviour(ctx: PlContext, src: Obj, path: string): Obj {
  const b: Obj = {};
  b.usage = src.generateIncome === true ? "investment" : "personal";
  const { change } = changeOf(ctx, src.yearlyChange, `${path}.yearlyChange`, "asset");
  if (change) b.appreciation = change;
  const lim = appreciationLimitOf(ctx, src, path);
  if (lim) b.appreciationLimit = lim;
  const pt = propertyTaxOf(ctx, src, path);
  if (pt) b.propertyTax = pt;
  const maintenance = costOf(ctx, src, "maintenanceRate", "year", path);
  if (maintenance) b.maintenance = maintenance;
  const insurance = costOf(ctx, src, "insuranceRate", "year", path);
  if (insurance) b.insurance = insurance;
  const improvements = costOf(ctx, src, "improvementRate", "year", path);
  if (improvements) b.improvements = improvements;
  const hoa = costOf(ctx, src, "monthlyHOA", "month", path);
  if (hoa) b.hoa = hoa;
  const rental = rentalOf(ctx, src, path);
  if (rental) b.rental = rental;
  if (src.sellIfNeeded !== undefined) b.liquidateIfNeeded = src.sellIfNeeded === true;
  if (src.excludeLoanFromLNW !== undefined)
    b.excludeLoanFromLiquidNetWorth = src.excludeLoanFromLNW === true;
  const rec = recurrenceOf(ctx, src, path, "asset");
  if (rec) b.recurrence = rec;
  const end = resolveRef(ctx, src.end, `${path}.end`, "end", src.owner);
  if (end.pointLike) {
    b.sale = { at: end.ref, brokerFeeRate: pctClean(src.brokersFee) ?? 0.06 };
  } else if (num(src.brokersFee) !== undefined && num(src.brokersFee) !== 0) {
    infoNote(
      ctx,
      `${path}.brokersFee`,
      "broker's fee dropped: the asset is never sold, and Glideworth stores it on the sale",
      "pl.dropped-brokersFee",
    );
  }
  return b;
}

function loanOf(
  ctx: PlContext,
  src: Obj,
  path: string,
  assetId: string,
  balance: boolean,
): Obj | undefined {
  if (src.paymentMethod === "pay-in-full") {
    if ((num(src.balance) ?? 0) > 0)
      approximated(
        ctx,
        `${path}.balance`,
        "loan balance present on a 'pay-in-full' asset; no loan created",
      );
    return undefined;
  }
  const bal = num(src.balance) ?? 0;
  const payment = num(src.monthlyPayment) ?? 0;
  if (balance && bal <= 0) return undefined;
  const loan: Obj = {
    id: ctx.assetIds.fresh(`${assetId}-loan`),
    interest: interestOf(ctx, src, path),
    monthlyPayment: {
      value: payment,
      basis: basisOf(ctx, src.monthlyPaymentType, `${path}.monthlyPaymentType`),
    },
  };
  if (balance) loan.balance = bal;
  return loan;
}

export interface MappedAsset {
  sourceId: string;
  asset: Obj;
  src: Obj;
}

/** today.assets[] -> finances.realAssets. */
export function mapAssets(ctx: PlContext, today: Obj): MappedAsset[] {
  return arr(today.assets).map((raw, i) => {
    const path = `$.today.assets[${i}]`;
    const src = obj(raw);
    const sid = str(src.id);
    const id = ctx.assetIds.get(sid, `asset-${i + 1}`);
    if (sid) ctx.knownAssets.add(sid);
    const asset: Obj = {
      id,
      name: nameOf(src, `Asset ${i + 1}`),
      type: assetTypeOf(ctx, src, path),
      owner: ownerOf(ctx, src.owner, `${path}.owner`),
      currentValue: Math.max(0, num(src.amount) ?? 0),
      behaviour: assetBehaviour(ctx, src, path),
    };
    const currency = currencyOf(ctx, src.currency, `${path}.currency`);
    if (currency) asset.currency = currency;
    const pp = num(src.initialValue);
    if (pp !== undefined && pp >= 0) asset.purchasePrice = pp;
    const loan = loanOf(ctx, src, path, id, true);
    if (loan) asset.loan = loan;
    const appearance = appearanceOf(src);
    if (appearance) asset.appearance = appearance;
    const start = resolveRef(ctx, src.start, `${path}.start`, "start", src.owner);
    if (start.ref.kind === "date" && start.ref.date <= ctx.asOf) {
      infoNote(
        ctx,
        `${path}.start`,
        "purchase date not stored (Glideworth assets have no owned-since date)",
        "pl.dropped-asset-start",
      );
    } else if (start.pointLike) {
      approximated(
        ctx,
        `${path}.start`,
        "asset start is in the future but the asset is in Current Finances; treated as already owned",
        "pl.asset-future-start",
      );
    }
    return { sourceId: sid ?? id, asset, src };
  });
}

/** Cost keys of RealAssetBehaviour and the source field that sets each. */
const COST_FIELDS: [string, string][] = [
  ["maintenance", "maintenanceRate"],
  ["insurance", "insuranceRate"],
  ["improvements", "improvementRate"],
  ["hoa", "monthlyHOA"],
];

/**
 * A plan-level asset copy that switches something OFF (a cost set to 0, rent turned off, the sale
 * removed) maps to an absent key, and an absent key in a sparse patch keeps the asset's own value.
 * Make those "off" states explicit so the plan patch really overrides Current Finances.
 */
function explicitPlanUnsets(behaviour: Obj, src: Obj, baseBehaviour: Obj): void {
  for (const [key, field] of COST_FIELDS) {
    if (behaviour[key] === undefined && src[field] !== undefined) behaviour[key] = { kind: "none" };
  }
  if (behaviour.propertyTax === undefined && src.taxRate !== undefined && baseBehaviour.propertyTax)
    behaviour.propertyTax = { cost: { kind: "none" } };
  if (behaviour.rental === undefined && src.generateIncome === false && isObj(baseBehaviour.rental))
    behaviour.rental = { ...baseBehaviour.rental, enabled: false };
  if (behaviour.sale === undefined && src.end !== undefined && isObj(baseBehaviour.sale))
    behaviour.sale = { ...baseBehaviour.sale, at: { kind: "never" } };
}

const OVERRIDE_FIELDS: [string, string][] = [
  ["amount", "value"],
  ["initialValue", "purchase price"],
  ["balance", "loan balance"],
  ["monthlyPayment", "loan payment"],
  ["interestRate", "loan interest rate"],
  ["interestType", "loan interest type"],
  ["compounding", "loan compounding"],
  ["paymentMethod", "payment method"],
];

/** Plan asset events -> realAssetSettings patches and plannedRealAssets. */
export function mapPlanAssets(
  ctx: PlContext,
  events: unknown[],
  basePath: string,
  assets: MappedAsset[],
): { realAssetSettings: Record<string, Obj>; plannedRealAssets: Obj[]; present: Set<string> } {
  const realAssetSettings: Record<string, Obj> = {};
  const plannedRealAssets: Obj[] = [];
  const present = new Set<string>();
  const bySource = new Map(assets.map((a) => [a.sourceId, a]));
  events.forEach((raw, i) => {
    const path = `${basePath}[${i}]`;
    const src = obj(raw);
    const sid = str(src.assetId) ?? str(src.id);
    const base = sid ? bySource.get(sid) : undefined;
    if (!base) {
      const id = ctx.assetIds.get(sid, `planned-asset-${plannedRealAssets.length + 1}`);
      if (sid) present.add(sid);
      const range = resolveRange(
        ctx,
        { start: src.start, end: { type: "keyword", value: "never" }, owner: src.owner },
        path,
      );
      const behaviour = assetBehaviour(ctx, src, path);
      const price = {
        value: num(src.amount) ?? 0,
        basis: basisOf(ctx, src.amountType, `${path}.amountType`),
      };
      const purchase: Obj = { at: range.start, price };
      const mv = num(src.initialValue);
      if (mv !== undefined && mv !== price.value)
        purchase.marketValue = {
          value: mv,
          basis: basisOf(ctx, src.initialValueType, `${path}.initialValueType`),
        };
      const dp = num(src.downPayment);
      if (dp !== undefined && dp > 0)
        purchase.downPayment = {
          value: dp,
          basis: basisOf(ctx, src.downPaymentType, `${path}.downPaymentType`),
        };
      if (src.paymentMethod === "financed") {
        const loan = loanOf(ctx, src, path, id, false);
        if (loan) purchase.financing = loan;
      }
      plannedRealAssets.push({
        id,
        name: nameOf(src, `Planned asset ${plannedRealAssets.length + 1}`),
        type: assetTypeOf(ctx, src, path),
        owner: ownerOf(ctx, src.owner, `${path}.owner`),
        behaviour,
        purchase,
        ...(appearanceOf(src) ? { appearance: appearanceOf(src) } : {}),
      });
      return;
    }
    present.add(base.sourceId);
    const id = base.asset.id as string;
    // Plan-level copies repeat the asset's own approximations; only genuine problems are re-reported.
    const sink: ImportIssue[] = [];
    const behaviour = assetBehaviour({ ...ctx, issues: sink }, src, path);
    for (const i of sink) if (i.category === "invalid") ctx.issues.push(i);
    const baseBehaviour = obj(base.asset.behaviour);
    explicitPlanUnsets(behaviour, src, baseBehaviour);
    const patch = behaviourOverride(RealAssetBehaviour, baseBehaviour, behaviour);
    // A key the plan no longer sets but the asset does (e.g. a repeat removed) cannot be expressed
    // as a patch of present keys; report it.
    for (const k of ["sale", "rental", "recurrence"] as const) {
      if (baseBehaviour[k] !== undefined && behaviour[k] === undefined) {
        approximated(
          ctx,
          `${path}`,
          `plan removes '${k}' set on the asset; Glideworth plan patches cannot unset it`,
          "pl.plan-unset",
        );
      }
    }
    if (patch) realAssetSettings[id] = patch;
    for (const [field, label] of OVERRIDE_FIELDS) {
      const a = src[field];
      const b = base.src[field];
      if (a !== undefined && b !== undefined && a !== b) {
        approximated(
          ctx,
          `${path}.${field}`,
          `plan-level ${label} differs from Current Finances; the Current Finances value is used`,
          "pl.plan-asset-override",
        );
      }
    }
    const start = resolveRef(ctx, src.start, `${path}.start`, "start", src.owner);
    const baseStart = resolveRef(
      { ...ctx, issues: [] },
      base.src.start,
      `${path}.start`,
      "start",
      src.owner,
    );
    if (start.pointLike && !deepEqual(start.ref, baseStart.ref)) {
      approximated(
        ctx,
        `${path}.start`,
        "plan-level purchase date on an existing asset cannot be represented; asset is treated as already owned",
        "pl.plan-asset-start",
      );
    }
  });
  return { realAssetSettings, plannedRealAssets, present };
}
