/** Withdrawal strategy, drawdown order, flexible spending and Monte Carlo settings. */
import { DEFAULT_OUTCOME_CATEGORIES } from "@glideworth/core";
import { arr, num, type Obj, obj, pct, pctClean, str } from "../util/read.js";
import type { MappedAccount } from "./accounts.js";
import { basisOf, clamp } from "./common.js";
import { approximated, infoNote, invalid, type PlContext } from "./context.js";
import { resolveRef } from "./dates.js";

const STRATEGY_KEYS = [
  "initial-%",
  "fixed-%",
  "fixed-amount",
  "1/N",
  "vpw",
  "kitces-ratchet",
  "clyatt-95%",
  "guyton-klinger",
];

function bound(ctx: PlContext, s: Obj, which: "min" | "max", path: string): Obj | undefined {
  if (s[`${which}Enabled`] !== true) return undefined;
  const v = num(s[which]);
  if (v === undefined) return undefined;
  const tag = s[`${which}Type`];
  if (tag === "%") {
    approximated(
      ctx,
      `${path}.${which}`,
      `${which === "min" ? "floor" : "ceiling"} expressed as a percentage has no Glideworth equivalent (bounds are amounts); dropped`,
      "pl.withdrawal-percent-bound",
    );
    return undefined;
  }
  return { value: v, basis: basisOf(ctx, tag, `${path}.${which}Type`) };
}

export function mapWithdrawalStrategy(ctx: PlContext, raw: unknown, path: string): Obj | undefined {
  if (!obj(raw) || Object.keys(obj(raw)).length === 0) return undefined;
  const ws = obj(raw);
  const key = str(ws.strategy);
  if (!key || !STRATEGY_KEYS.includes(key)) {
    invalid(
      ctx,
      `${path}.strategy`,
      `unknown withdrawal strategy '${String(key)}'; withdrawal strategy dropped`,
    );
    return undefined;
  }
  const s = obj(ws[key]);
  const spath = `${path}.${key}`;
  const amountPct = pctClean(s.amount) ?? 0;
  let rule: Obj;
  switch (key) {
    case "initial-%":
      rule = { kind: "initial-percent", rate: amountPct };
      break;
    case "fixed-%":
      rule = { kind: "fixed-percent", rate: amountPct };
      break;
    case "fixed-amount":
      rule = {
        kind: "fixed-amount",
        amount: {
          value: num(s.amount) ?? 0,
          basis: basisOf(ctx, s.amountType, `${spath}.amountType`),
        },
        inflationAdjust: s.adjust !== false,
      };
      break;
    case "1/N":
      rule = { kind: "one-over-n" };
      break;
    case "vpw":
      rule = { kind: "vpw" };
      break;
    case "kitces-ratchet":
      rule = {
        kind: "ratcheting",
        rate: amountPct,
        threshold: pctClean(s.threshold) ?? 0.5,
        raise: pctClean(s.ratchet) ?? 0.1,
        cooldownYears: Math.max(0, Math.round(num(s.cooldown) ?? 3)),
      };
      break;
    case "clyatt-95%":
      rule = {
        kind: "clyatt-95",
        rate: amountPct,
        minShareOfPrevious: clamp(pctClean(s.percentOfPrevious) ?? 0.95, 0, 1),
      };
      break;
    default:
      rule = {
        kind: "guyton-klinger",
        rate: amountPct,
        guardrail: pctClean(s.guardrail) ?? 0.2,
        adjustment: pctClean(s.adjustment) ?? 0.1,
      };
  }
  const inactive = STRATEGY_KEYS.filter((other) => other !== key && ws[other] !== undefined);
  if (inactive.length > 0) {
    infoNote(
      ctx,
      path,
      `parameters of ${inactive.length} non-selected strategies (${inactive.join(", ")}) are not carried over`,
      "pl.inactive-strategy",
    );
  }
  const bounds: Obj = {};
  const floor = bound(ctx, s, "min", spath);
  const ceiling = bound(ctx, s, "max", spath);
  if (floor) bounds.floor = floor;
  if (ceiling) bounds.ceiling = ceiling;
  const income = str(ws.income);
  const spendMode = str(ws.spendMode);
  const out: Obj = {
    enabled: ws.enabled === true,
    start: resolveRef(ctx, ws.start, `${path}.start`, "start").ref,
    rule,
    bounds,
    incomeHandling: income === "increase-spending" ? "increase-spending" : "reduce-withdrawals",
    treatAsSpending: spendMode !== undefined && spendMode !== "withdraw",
  };
  if (income !== undefined && income !== "increase-spending" && income !== "reduce-withdrawals") {
    approximated(
      ctx,
      `${path}.income`,
      `unknown income handling '${income}'; using reduce-withdrawals`,
      "pl.withdrawal-income",
    );
  }
  if (spendMode !== undefined && spendMode !== "withdraw" && spendMode !== "spend") {
    approximated(
      ctx,
      `${path}.spendMode`,
      `unknown spend mode '${spendMode}'; treated as desired spending`,
      "pl.withdrawal-spendmode",
    );
  }
  return out;
}

const DRAWDOWN_CATEGORY: Record<string, string> = {
  "all-cash": "cash",
  cash: "cash",
  taxable: "taxable",
  crypto: "crypto",
  "uk-pension": "tax-deferred",
  "tax-deferred": "tax-deferred",
  "tax-free": "tax-free",
  roth: "tax-free",
  isa: "tax-free",
  "uk-isa": "tax-free",
  hsa: "hsa",
  education: "education",
  "529": "education",
  "real-estate": "real-assets",
  "real-assets": "real-assets",
  assets: "real-assets",
};

/** drawdownOrder[] -> DrawdownSettings.order (+ excess-cash accounts expanded in place). */
export function mapDrawdown(
  ctx: PlContext,
  raw: unknown,
  path: string,
  accounts: MappedAccount[],
): Obj | undefined {
  const list = arr(raw);
  if (list.length === 0) return undefined;
  const order: Obj[] = [];
  const seen = new Set<string>();
  list.forEach((x, i) => {
    const key = typeof x === "string" ? x : "";
    if (key === "excess-cash") {
      const ids = accounts
        .filter((a) => obj(a.account.behaviour).isExcessCash === true)
        .map((a) => a.account.id as string);
      for (const id of ids) order.push({ kind: "account", accountId: id });
      if (ids.length === 0)
        infoNote(
          ctx,
          `${path}[${i}]`,
          "'excess-cash' entry has no repurposed accounts to expand into; skipped",
          "pl.drawdown-excess-cash",
        );
      return;
    }
    if (key === "non-qualified-uk-pension") {
      approximated(
        ctx,
        `${path}[${i}]`,
        "'non-qualified-uk-pension' (pension drawn before the qualifying age) has no drawdown category in Glideworth; pensions use 'uk-pension' position and the per-account early-withdrawal settings",
        "pl.drawdown-non-qualified",
      );
      return;
    }
    const cat = DRAWDOWN_CATEGORY[key];
    if (!cat) {
      invalid(ctx, `${path}[${i}]`, `unknown drawdown entry '${key}'; skipped`);
      return;
    }
    if (seen.has(cat)) return;
    seen.add(cat);
    order.push({ kind: "category", category: cat });
  });
  return { order };
}

export function mapFlexSpending(ctx: PlContext, raw: unknown, path: string): Obj | undefined {
  if (raw === undefined) return undefined;
  const f = obj(raw);
  const out: Obj = { enabled: f.enabled === true };
  if (f.scope === "all" || f.scope === "discretionary") out.scope = f.scope;
  else if (f.scope !== undefined)
    invalid(ctx, `${path}.scope`, `unknown flex scope '${String(f.scope)}'`);
  out.interpolation = f.interpolation === "linear" ? "linear" : "step";
  const rules: Obj[] = [];
  arr(f.points).forEach((p, i) => {
    const x = pct(obj(p).x);
    const y = pct(obj(p).y);
    if (x === undefined || y === undefined) {
      approximated(
        ctx,
        `${path}.points[${i}]`,
        "flex-spending point has an unrecognised shape; dropped",
        "pl.flex-point",
      );
      return;
    }
    rules.push({ drawdown: clamp(x, 0, 1), cut: clamp(y, 0, 1) });
  });
  if (rules.length > 0) out.rules = rules;
  return out;
}

const SAMPLING: Record<string, string> = {
  "backtest-random-restart": "historical-random-restart",
  "backtest-sequential": "historical-sequential",
  backtest: "historical-sequential",
  sequential: "historical-sequential",
  "backtest-block": "block-bootstrap",
  block: "block-bootstrap",
  "block-bootstrap": "block-bootstrap",
  normal: "normal",
  "monte-carlo": "normal",
  random: "normal",
  gaussian: "normal",
};

const DIST_SERIES: [string, string][] = [
  ["investmentReturn", "stocks"],
  ["bondReturn", "bonds"],
  ["inflation", "inflation"],
  ["dividendRate", "dividends"],
  ["cryptoReturn", "crypto"],
];

export function mapMonteCarlo(
  ctx: PlContext,
  raw: unknown,
  path: string,
  settingsMc: Obj,
  milestoneIds: Set<string>,
): Obj {
  const mc = obj(raw);
  const out: Obj = {};
  const sampling = str(mc.sampling);
  if (sampling !== undefined) {
    const method = SAMPLING[sampling];
    if (method) out.method = method;
    else
      invalid(
        ctx,
        `${path}.sampling`,
        `unknown sampling '${sampling}'; using historical-random-restart`,
      );
  }
  const trials = num(mc.trials);
  if (trials !== undefined) out.trials = clamp(Math.round(trials), 1, 10_000);
  const block = num(mc.blockSize);
  if (block !== undefined) out.blockLength = clamp(Math.round(block), 1, 30);
  const distributions: Obj = {};
  for (const [src, dst] of DIST_SERIES) {
    const mean = pctClean(mc[`${src}Mean`]);
    const sd = pctClean(mc[`${src}StdDev`]);
    if (mean === undefined || sd === undefined) continue;
    distributions[dst] = { mean: clamp(mean, -1, 10), stdDev: clamp(sd, 0, 2) };
  }
  if (Object.keys(distributions).length > 0) out.distributions = distributions;
  // Per-series source: 'backtest'/'historical' follows the sampling method, 'custom'/'normal' draws
  // from the series' distribution, 'fixed'/'none' keeps the plan assumption.
  const sources: Obj = {};
  for (const [src, dst] of DIST_SERIES) {
    const v = str(mc[src]);
    if (v === undefined) continue;
    const mode =
      v === "backtest" || v === "historical" || v === "historic"
        ? "method"
        : v === "custom" || v === "normal" || v === "distribution" || v === "random"
          ? "distribution"
          : v === "fixed" || v === "none" || v === "plan"
            ? "fixed"
            : undefined;
    if (mode === undefined) {
      invalid(ctx, `${path}.${src}`, `unknown sampling source '${v}'; follows the sampling method`);
      continue;
    }
    if (mode !== "method" || out.method === "normal")
      sources[dst] = mode === "method" ? "distribution" : mode;
  }
  if (Object.keys(sources).length > 0) out.sources = sources;
  const split = str(mc.splitPoint);
  if (split && milestoneIds.has(split))
    out.splitAtMilestoneId = ctx.plan!.milestoneIds.get(split, "milestone");
  else if (split)
    invalid(
      ctx,
      `${path}.splitPoint`,
      "split point milestone is not defined in this plan; dropped",
    );
  if (settingsMc.useRandomSeed === true) {
    const seed = num(settingsMc.randomSeed);
    if (seed !== undefined && Number.isInteger(seed) && seed >= 0 && seed <= 2 ** 32 - 1)
      out.seed = seed;
    else if (seed !== undefined)
      approximated(
        ctx,
        "$.settings.montecarlo.randomSeed",
        "random seed is not a 32-bit unsigned integer; a fresh seed is used per run",
        "pl.seed",
      );
  }
  return out;
}

const OUTCOME_ID: Record<string, string> = {
  failedEarly: "failed-early",
  failedMid: "failed-mid",
  failedLate: "failed-late",
  almostFailed: "almost-failed",
  comfortable: "comfortable",
  largeSurplus: "large-surplus",
};

/** settings.montecarlo.outcomeTypes -> UserSettings.outcomeCategories. */
export function mapOutcomeCategories(
  ctx: PlContext,
  raw: unknown,
  path: string,
): Obj[] | undefined {
  const types = obj(raw);
  const entries = Object.entries(types)
    .filter(([k]) => k !== "unknown")
    .map(([k, v]) => ({ k, v: obj(v) }))
    .sort((a, b) => (num(a.v.order) ?? 99) - (num(b.v.order) ?? 99));
  if (entries.length === 0) return undefined;
  const out: Obj[] = [];
  for (const { k, v } of entries) {
    const kind = str(v.type);
    if (kind !== "success" && kind !== "failure") {
      invalid(ctx, `${path}.${k}.type`, `unknown outcome type '${String(kind)}'; category dropped`);
      continue;
    }
    const id = OUTCOME_ID[k] ?? k.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60);
    let threshold = num(v.value);
    if (threshold === undefined) {
      const dflt = DEFAULT_OUTCOME_CATEGORIES.find((c) => c.id === id && c.kind === kind);
      threshold = dflt?.threshold ?? 0;
      approximated(
        ctx,
        `${path}.${k}`,
        `outcome category has no threshold; ${dflt ? "Glideworth's default" : "0"} used`,
        "pl.outcome-threshold",
      );
    } else if (kind === "failure" && threshold > 1) {
      threshold = threshold / 100;
      approximated(
        ctx,
        `${path}.${k}.value`,
        "failure threshold read as a percentage of plan length",
        "pl.outcome-threshold",
      );
    }
    const cat: Obj = {
      id,
      name: (str(v.name) ?? k).slice(0, 60),
      kind,
      threshold,
    };
    const color = str(v.color);
    if (color) cat.color = color.slice(0, 40);
    out.push(cat);
  }
  return out;
}
