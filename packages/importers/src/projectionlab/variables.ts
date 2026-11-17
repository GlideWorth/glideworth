/** Plan `variables`: assumptions (returns, inflation, bonds, dividends) and tax configuration. */
import { hasTaxPreset } from "@glideworth/core";
import { table, arr, bool, num, type Obj, obj, pct, pctClean, str } from "../util/read.js";
import { scheduleFromSeries } from "./accounts.js";
import { clamp } from "./common.js";
import { approximated, infoNote, invalid, type PlContext, resolveSource } from "./context.js";

type SeriesKey = "inflation" | "stock" | "dividend" | "bondReturn" | "bondYield";

interface SeriesSpec {
  key: SeriesKey;
  /** Source variable holding the fixed value (a percentage). */
  value: string;
  custom: string;
  modifier: string;
  target: string;
  historical?: string;
}

const SERIES: SeriesSpec[] = [
  {
    key: "inflation",
    value: "inflation",
    custom: "inflationCustom",
    modifier: "inflationModifier",
    target: "inflation",
    historical: "us-inflation",
  },
  {
    key: "stock",
    value: "investmentReturn",
    custom: "investmentReturnCustom",
    modifier: "investmentReturnModifier",
    target: "stockReturn",
    historical: "us-stocks",
  },
  {
    key: "dividend",
    value: "dividendRate",
    custom: "dividendRateCustom",
    modifier: "dividendRateModifier",
    target: "dividendYield",
    historical: "us-dividends",
  },
  {
    key: "bondReturn",
    value: "bondInvestmentReturn",
    custom: "bondInvestmentReturnCustom",
    modifier: "bondInvestmentReturnModifier",
    target: "bondReturn",
    historical: "us-bonds",
  },
  {
    key: "bondYield",
    value: "bondDividendRate",
    custom: "bondDividendRateCustom",
    modifier: "bondDividendRateModifier",
    target: "bondYield",
  },
];

function rateSpec(
  ctx: PlContext,
  v: Obj,
  s: SeriesSpec,
  mode: string,
  path: string,
): Obj | undefined {
  const fixed = pctClean(v[s.value]);
  // Additive modifier on a historical / custom series (ignored by the source in fixed mode).
  const modifier = pctClean(v[s.modifier]) ?? 0;
  if (mode === "historical" && s.historical) {
    const startYear = num(v.startYear);
    const loopYear = num(v.loopYear);
    const spec: Obj = {
      kind: "historical",
      series: s.historical,
      startYear: clamp(Math.round(startYear ?? 1928), 1871, 2100),
    };
    if (loopYear !== undefined) spec.loopYear = clamp(Math.round(loopYear), 1871, 2100);
    if (modifier !== 0) spec.modifier = clamp(modifier, -1, 10);
    return spec;
  }
  if (mode === "custom") {
    const points = scheduleFromSeries(obj(v[s.custom]).data).map((p) =>
      modifier !== 0 ? { ...p, rate: clamp((p.rate as number) + modifier, -1, 10) } : p,
    );
    if (points.length > 0) return { kind: "schedule", interpolation: "linear", points };
    invalid(ctx, `${path}.${s.custom}`, "custom series is empty; using the fixed value");
  }
  return fixed === undefined ? undefined : { kind: "fixed", rate: fixed };
}

const YEAR_ALIGNMENT = new Set(["calendar", "fiscal", "rolling"]);

export function mapAssumptions(
  ctx: PlContext,
  raw: unknown,
  path: string,
  alignment: unknown,
): Obj {
  const v = obj(raw);
  const a: Obj = {};
  let mode = str(v.assumptionsMode) ?? "fixed";
  if (mode === "backtest" || mode === "historic") mode = "historical";
  if (mode !== "fixed" && mode !== "historical" && mode !== "custom") {
    invalid(ctx, `${path}.assumptionsMode`, `unknown assumptions mode '${mode}'; using fixed`);
    mode = "fixed";
  }
  for (const s of SERIES) {
    const spec = rateSpec(ctx, v, s, mode, path);
    if (spec) a[s.target] = spec;
  }
  const cola = pctClean(v.benefitColaModifier);
  if (cola !== undefined) a.benefitColaModifier = clamp(cola, -1, 10);
  if (bool(obj(obj(v.dividendSettings).reinvestment).enabled) !== undefined) {
    a.dividendReinvestment = {
      enabled: obj(obj(v.dividendSettings).reinvestment).enabled === true,
    };
  }

  // Bond allocation (glide path by age of the primary person)
  const bs = obj(v.bondSettings);
  if (Object.keys(bs).length > 0) {
    const points: Obj[] = [];
    for (const p of arr(bs.allocation)) {
      const x = num(obj(p).x);
      const y = pct(obj(p).y);
      if (x === undefined || y === undefined) continue;
      points.push({
        at: { kind: "age", personId: ctx.primaryId, age: clamp(x, 0, 130), offsetMonths: 0 },
        value: clamp(y, 0, 1),
      });
    }
    const type = str(bs.allocationType) ?? "none";
    const alloc: Obj = { points, interpolation: "linear", distribution: "even" };
    if (type === "none") alloc.kind = "none";
    else if (type === "fixed") {
      alloc.kind = "fixed";
      alloc.share = points[0] ? (points[0].value as number) : 0;
    } else {
      alloc.kind = "glidepath";
      if (type !== "glidepath" && type !== "glide-path" && type !== "glide") {
        approximated(
          ctx,
          `${path}.bondSettings.allocationType`,
          `bond allocation type '${type}' read as a glide path`,
          "pl.bond-allocation",
        );
      }
    }
    const loc = obj(bs.location);
    if (str(loc.type) !== undefined && loc.type !== "default") {
      const ids: string[] = [];
      for (const sid of arr(loc.accountOrder)) {
        const resolved = resolveSource(ctx, "account", sid);
        if (resolved) ids.push(ctx.accountIds.get(resolved, "account"));
      }
      alloc.locationPriority = ids;
    }
    a.bondAllocation = alloc;
  }

  // Year alignment comes from settings.plan.alignment.
  const al = obj(alignment);
  const alType = str(al.type);
  if (alType !== undefined) {
    if (!YEAR_ALIGNMENT.has(alType))
      invalid(
        ctx,
        "$.settings.plan.alignment.type",
        `unknown year alignment '${alType}'; using calendar`,
      );
    else if (alType === "fiscal") {
      const m = num(al.startMonth ?? al.month);
      if (m === undefined) {
        approximated(
          ctx,
          "$.settings.plan.alignment",
          "fiscal year alignment without a start month; April used (UK) or January otherwise",
          "pl.fiscal-month",
        );
      }
      a.yearAlignment = {
        kind: "fiscal",
        startMonth: Math.round(clamp(m ?? (ctx.country === "GB" ? 4 : 1), 1, 12)),
      };
    } else a.yearAlignment = { kind: alType };
  }
  return a;
}

// ---------------------------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------------------------

const FILING: Record<string, string> = table({
  single: "single",
  joint: "married-joint",
  "married-joint": "married-joint",
  separate: "married-separate",
  "married-separate": "married-separate",
  head: "head-of-household",
  "head-of-household": "head-of-household",
  "qualifying-surviving-spouse": "qualifying-surviving-spouse",
  widow: "qualifying-surviving-spouse",
});

function bracketTable(ctx: PlContext, raw: unknown, path: string): Obj | undefined {
  const rows: { from: number; rate: number }[] = [];
  let prevMax = 0;
  arr(raw).forEach((b, i) => {
    const o = obj(b);
    const from =
      num(o.from ?? o.start ?? o.min ?? o.threshold ?? o.floor ?? o.lower ?? o.income) ?? prevMax;
    const rate = pct(o.rate ?? o.percent ?? o.pct ?? o.tax);
    if (rate === undefined) {
      approximated(
        ctx,
        `${path}[${i}]`,
        "tax bracket without a recognisable rate; dropped",
        "pl.bracket-shape",
      );
      return;
    }
    rows.push({ from: Math.max(0, from), rate: clamp(rate, -1, 10) });
    prevMax = num(o.to ?? o.max ?? o.upTo ?? o.ceiling ?? o.upper) ?? prevMax;
  });
  if (rows.length === 0) return undefined;
  rows.sort((a, b) => a.from - b.from);
  if (rows[0]!.from > 0) rows.unshift({ from: 0, rate: 0 });
  return { brackets: rows, basis: "real" };
}

export function mapTax(
  ctx: PlContext,
  raw: unknown,
  path: string,
  planningMode: "individual" | "couple",
): Obj {
  const v = obj(raw);
  const tax: Obj = {};
  const incomeMode = str(v.incomeTaxMode) ?? "fixed";
  const capMode = str(v.capGainsMode) ?? "fixed";
  const divMode = str(v.dividendTaxMode) ?? "capGains";
  const wealthMode = str(v.wealthTaxMode) ?? "none";

  const capRate = pctClean(v.capGainsTaxRate);
  const flat: Obj = {};
  const ordinary = pctClean(v.effectiveIncomeTaxRate);
  if (ordinary !== undefined) flat.ordinary = ordinary;
  if (capRate !== undefined) flat.capitalGains = capRate;
  const divRate = divMode === "capGains" ? capRate : pctClean(v.dividendTaxRate);
  if (divRate !== undefined) flat.dividends = divRate;
  const local = pctClean(v.localIncomeTaxRate);
  if (local !== undefined) flat.local = local;
  const flatExtras: Obj = {};
  const incMod = pctClean(v.incomeTaxModifier) ?? 0;
  const cgMod = pctClean(v.capGainsModifier) ?? 0;
  if (incMod !== 0 || cgMod !== 0)
    flatExtras.modifier = { ordinary: clamp(incMod, -1, 10), capitalGains: clamp(cgMod, -1, 10) };
  const bondMode = str(v.bondDividendTaxMode);
  if (bondMode !== undefined && bondMode !== "income") {
    const bondRate = pctClean(v.bondDividendTaxRate);
    if (bondMode === "dividends" || bondMode === "dividend" || bondMode === "capGains")
      flatExtras.bondDividends = { treatment: "dividends" };
    else if (bondRate !== undefined)
      flatExtras.bondDividends = { treatment: "rate", rate: clamp(bondRate, -1, 10) };
    else
      approximated(
        ctx,
        `${path}.bondDividendTaxMode`,
        `bond dividend tax mode '${bondMode}' without a rate; taxed as income`,
        "pl.bond-dividends",
      );
  }
  if (Object.keys(flat).length === 3 || Object.keys(flat).length === 4)
    tax.flat = { ...flat, ...flatExtras };
  else if (Object.keys(flat).length > 0) {
    // FlatTaxRates needs ordinary, capitalGains and dividends together.
    tax.flat = { ordinary: 0.2, capitalGains: 0.15, dividends: 0.15, ...flat, ...flatExtras };
    infoNote(
      ctx,
      path,
      "some flat tax rates were missing from the export; Glideworth defaults were used for them",
      "pl.flat-defaults",
    );
  }

  const fttRate = pctClean(v.fttRate);
  const fttActive = (str(v.fttMode) ?? "none") !== "none" && fttRate !== undefined;
  const needsCustom =
    fttActive ||
    incomeMode !== "fixed" ||
    (capMode !== "fixed" && capMode !== "none") ||
    (divMode !== "capGains" && divMode !== "fixed") ||
    wealthMode !== "none";
  const wantsEstimate = v.estimateTaxes === true;
  if (wantsEstimate && hasTaxPreset(ctx.country)) tax.mode = "estimate";
  else if (needsCustom) tax.mode = "custom";
  else tax.mode = "flat";
  if (wantsEstimate && !hasTaxPreset(ctx.country)) {
    approximated(
      ctx,
      `${path}.estimateTaxes`,
      `tax estimation is on but the household country '${ctx.country}' has no Glideworth jurisdiction; ${tax.mode} mode used`,
      "pl.estimate-taxes",
    );
  }

  if (needsCustom || tax.mode === "custom") {
    const ord = bracketTable(
      ctx,
      obj(v.incomeTaxNational).brackets,
      `${path}.incomeTaxNational.brackets`,
    );
    const custom: Obj = {
      ordinary: ord ?? {
        brackets: [{ from: 0, rate: pctClean(v.effectiveIncomeTaxRate) ?? 0.2 }],
        basis: "real",
      },
    };
    if (!ord && needsCustom) {
      approximated(
        ctx,
        `${path}.incomeTaxNational`,
        "no income-tax brackets in the export; a single flat bracket at the effective rate is used",
        "pl.no-brackets",
      );
    }
    const cg = bracketTable(ctx, obj(v.capGains).brackets, `${path}.capGains.brackets`);
    if (cg) custom.capitalGains = cg;
    const dv = bracketTable(ctx, obj(v.dividendTax).brackets, `${path}.dividendTax.brackets`);
    if (dv) custom.dividends = dv;
    const offset = (x: unknown) => (str(x) === undefined || str(x) === "none" ? "none" : "income");
    if (cg && obj(v.capGains).offset !== undefined)
      custom.capitalGainsOffset = offset(obj(v.capGains).offset);
    if (dv && obj(v.dividendTax).offset !== undefined)
      custom.dividendOffset = offset(obj(v.dividendTax).offset);
    const allowance = num(obj(v.dividendTax).allowance);
    if (allowance !== undefined && allowance > 0) custom.dividendAllowance = allowance;
    const bd = bracketTable(
      ctx,
      obj(v.bondDividendTax).brackets,
      `${path}.bondDividendTax.brackets`,
    );
    if (bd) custom.bondDividends = bd;
    const extras = arr(v.incomeTaxExtra)
      .map((x, i) => {
        const o = obj(x);
        const table =
          bracketTable(ctx, o.brackets, `${path}.incomeTaxExtra[${i}].brackets`) ??
          (pctClean(o.rate) !== undefined
            ? { brackets: [{ from: 0, rate: clamp(pctClean(o.rate)!, -1, 10) }], basis: "real" }
            : undefined);
        if (!table) {
          invalid(
            ctx,
            `${path}.incomeTaxExtra[${i}]`,
            "additional income tax without brackets or a rate; dropped",
          );
          return undefined;
        }
        return {
          name: (str(o.name) ?? `Additional tax ${i + 1}`).slice(0, 80),
          table,
          base: "ordinary",
        };
      })
      .filter((x) => x !== undefined);
    if (extras.length > 0) custom.extraTaxes = extras;
    if (incomeMode === "fixed" && ordinary !== undefined) custom.flatEffectiveRate = ordinary;
    if (fttActive) {
      const event = str(v.fttTaxableEvent) ?? "buy-sell";
      const base =
        /sell|sale/.test(event) && /buy|purchase/.test(event)
          ? "both"
          : /sell|sale/.test(event)
            ? "sales"
            : /buy|purchase/.test(event)
              ? "purchases"
              : "both";
      if (
        base === "both" &&
        !/(sell|sale).*(buy|purchase)|(buy|purchase).*(sell|sale)/.test(event)
      ) {
        approximated(
          ctx,
          `${path}.fttTaxableEvent`,
          `unknown transaction-tax event '${event}'; applied to purchases and sales`,
          "pl.ftt-event",
        );
      }
      custom.financialTransactionTax = { rate: clamp(fttRate ?? 0, -1, 10), base };
    }
    const inclusion = pctClean(v.capGainsTaxablePercent);
    if (inclusion !== undefined) custom.capitalGainsInclusion = clamp(inclusion, 0, 1);
    if (v.capGainsTaxAsIncome === true) custom.capitalGainsAsOrdinary = true;
    const sd = num(obj(v.incomeTaxNational).standardDeduction);
    if (sd !== undefined && sd >= 0) custom.standardDeduction = sd;
    if (wealthMode !== "none") {
      const metricRaw = str(v.wealthTaxMetric);
      const metric =
        metricRaw === "liquidNetWorth" || metricRaw === "portfolio" ? metricRaw : "netWorth";
      const wt = obj(v.wealthTax);
      let table = bracketTable(ctx, wt.brackets, `${path}.wealthTax.brackets`);
      if (!table) {
        const rate = pctClean(v.wealthTaxRate) ?? 0;
        const threshold =
          Math.max(0, num(wt.allowance) ?? 0) + Math.max(0, num(wt.standardDeduction) ?? 0);
        table = {
          brackets:
            threshold > 0
              ? [
                  { from: 0, rate: 0 },
                  { from: threshold, rate },
                ]
              : [{ from: 0, rate }],
          basis: "real",
        };
      } else if ((num(wt.allowance) ?? 0) > 0 || (num(wt.standardDeduction) ?? 0) > 0) {
        approximated(
          ctx,
          `${path}.wealthTax`,
          "wealth-tax allowance/deduction is ignored when explicit brackets are present",
          "pl.wealth-allowance",
        );
      }
      if (wealthMode !== "fixed" && wealthMode !== "brackets" && wealthMode !== "custom") {
        approximated(
          ctx,
          `${path}.wealthTaxMode`,
          `wealth tax mode '${wealthMode}' read as a custom table`,
          "pl.wealth-mode",
        );
      }
      custom.wealthTax = { table, metric };
    }
    tax.custom = custom;
  }
  if (local !== undefined && local > 0 && tax.mode !== "flat") tax.localIncomeTaxRate = local;

  const filing = str(v.filingStatus);
  if (filing !== undefined) {
    const mapped = FILING[filing];
    if (mapped) tax.filingStatus = mapped;
    else invalid(ctx, `${path}.filingStatus`, `unknown filing status '${filing}'`);
  }
  if (tax.filingStatus === undefined)
    tax.filingStatus = planningMode === "couple" ? "married-joint" : "single";

  const toggles: Record<string, boolean> = {};
  const skipped: string[] = [];
  const lawToggle = (srcKey: string, id: string): void => {
    const b = bool(v[srcKey]);
    if (b === undefined) return;
    if (ctx.country === "US") toggles[id] = b;
    else skipped.push(srcKey);
  };
  lawToggle("tcjaReversion", "us.tcjaReversion");
  lawToggle("bbbSaltReversion", "us.bbbSaltReversion");
  lawToggle("bbbSeniorReversion", "us.bbbSeniorReversion");
  if (Object.keys(toggles).length > 0) tax.lawToggles = toggles;
  if (skipped.length > 0) {
    infoNote(
      ctx,
      path,
      `US-only law toggles (${skipped.join(", ")}) not imported: household country is '${ctx.country}'`,
      "pl.us-toggle",
    );
  }

  const w = obj(v.withholding);
  if (Object.keys(w).length > 0) {
    tax.withholding = {
      taxDeferred: clamp(pctClean(w.taxDeferred) ?? 0, -1, 10),
      taxable: clamp(pctClean(w.taxable) ?? 0, -1, 10),
      conversions: clamp(pctClean(w.conversions) ?? 0, -1, 10),
    };
  }

  const e = obj(v.estate);
  if (Object.keys(e).length > 0) {
    const est: Obj = {};
    const set = (k: string, src: unknown, hi = 10): void => {
      const n = pctClean(src);
      if (n !== undefined) est[k] = clamp(n, -1, hi);
    };
    set("liquidationCostRate", e.assetLiquidationFee);
    set("adminCostRate", e.adminRate);
    set("heirTaxDeferredRate", e.taxDeferredRate);
    set("heirCapitalGainsRate", e.taxableGainsRate);
    set("charitableShare", e.charityRate, 1);
    if (e.charityRate !== undefined && (est.charitableShare as number) < 0) est.charitableShare = 0;
    if (bool(e.stepUpBasis) !== undefined) est.stepUpBasis = e.stepUpBasis === true;
    tax.estate = est;
  }
  return tax;
}
