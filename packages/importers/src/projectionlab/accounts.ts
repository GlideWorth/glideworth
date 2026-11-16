/** Accounts: today.savingsAccounts[] / investmentAccounts[] and per-plan account events. */
import { ACCOUNT_TYPES, AccountBehaviour } from "@glideworth/core";
import { arr, bool, num, type Obj, obj, pct, pctClean, str } from "../util/read.js";
import {
  appearanceOf,
  basisOf,
  behaviourOverride,
  clamp,
  currencyOf,
  nameOf,
  ownerOf,
} from "./common.js";
import { approximated, infoNote, invalid, type PlContext } from "./context.js";
import { resolveRef } from "./dates.js";

const TYPE_ALIASES: Record<string, string> = {
  checking: "cash",
  current: "cash",
  cd: "certificate",
  brokerage: "taxable",
  ira: "traditional-ira",
  "traditional-401k": "401k",
  isa: "uk-isa",
  lisa: "uk-lisa",
  sipp: "uk-sipp",
  gia: "uk-gia",
  "workplace-pension": "uk-workplace-pension",
  tfsa: "ca-tfsa",
  rrsp: "ca-rrsp",
  rrif: "ca-rrif",
  fhsa: "ca-fhsa",
  resp: "ca-resp",
  lira: "ca-lira",
  "ca-registered": "ca-non-registered",
  super: "au-super-accumulation",
};

const TYPE_SET = new Set<string>(ACCOUNT_TYPES);

export function accountTypeOf(ctx: PlContext, v: unknown, path: string): string {
  const s = typeof v === "string" ? v : "";
  if (TYPE_SET.has(s)) return s;
  const alias = TYPE_ALIASES[s];
  if (alias) return alias;
  invalid(ctx, `${path}.type`, `unknown account type '${s}'; imported as 'other'`);
  return "other";
}

function growthOf(ctx: PlContext, src: Obj, path: string): Obj | undefined {
  const type = str(src.investmentGrowthType);
  if (type === undefined) return undefined;
  switch (type) {
    case "plan":
      return { kind: "inherit" };
    case "none":
      return { kind: "none" };
    case "fixed": {
      const rate = pctClean(src.investmentGrowthRate);
      if (rate === undefined) {
        invalid(
          ctx,
          `${path}.investmentGrowthRate`,
          "fixed growth without a rate; inheriting the plan assumption",
        );
        return { kind: "inherit" };
      }
      return { kind: "fixed", rate };
    }
    default:
      invalid(
        ctx,
        `${path}.investmentGrowthType`,
        `unknown growth type '${type}'; inheriting the plan assumption`,
      );
      return { kind: "inherit" };
  }
}

/** Custom {x: years from plan start, y: %} series -> schedule points. */
export function scheduleFromSeries(data: unknown): { at: Obj; rate: number }[] {
  const points: { at: Obj; rate: number }[] = [];
  for (const p of arr(data)) {
    const x = num(obj(p).x);
    const y = pctClean(obj(p).y);
    if (x === undefined || y === undefined) continue;
    points.push({ at: { kind: "planStart", offsetMonths: Math.round(x * 12) }, rate: y });
  }
  points.sort((a, b) => (a.at.offsetMonths as number) - (b.at.offsetMonths as number));
  // Duplicate offsets are not meaningful for a step/linear series: keep the last.
  return points.filter(
    (p, i) => i === points.length - 1 || points[i + 1]!.at.offsetMonths !== p.at.offsetMonths,
  );
}

function dividendsOf(ctx: PlContext, src: Obj, path: string): Obj | undefined {
  const type = str(src.dividendType);
  if (type === undefined) return undefined;
  switch (type) {
    case "plan":
      return { yield: { kind: "inherit" } };
    case "none":
      return { yield: { kind: "none" } };
    case "fixed": {
      const rate = pctClean(src.dividendRate);
      return rate === undefined
        ? { yield: { kind: "inherit" } }
        : { yield: { kind: "fixed", rate } };
    }
    case "custom": {
      const points = scheduleFromSeries(obj(src.dividendRateCustom).data);
      if (points.length === 0) {
        invalid(
          ctx,
          `${path}.dividendRateCustom`,
          "custom dividend series is empty; inheriting the plan assumption",
        );
        return { yield: { kind: "inherit" } };
      }
      return { yield: { kind: "schedule", interpolation: "linear", points } };
    }
    default:
      invalid(
        ctx,
        `${path}.dividendType`,
        `unknown dividend type '${type}'; inheriting the plan assumption`,
      );
      return { yield: { kind: "inherit" } };
  }
}

function feesOf(ctx: PlContext, src: Obj, path: string): Obj | undefined {
  const fee = num(src.yearlyFee);
  if (fee === undefined) return undefined;
  if (fee === 0) return { kind: "none" };
  const type = src.yearlyFeeType;
  if (type === "%" || type === undefined) return { kind: "percentOfBalance", rate: pctClean(fee) };
  return {
    kind: "amount",
    amount: { value: fee, basis: basisOf(ctx, type, `${path}.yearlyFeeType`) },
  };
}

function withdrawalsOf(ctx: PlContext, src: Obj, path: string): Obj | undefined {
  const w = src.withdraw;
  if (w === undefined && src.withdrawAge === undefined) return undefined;
  if (w === false) return { kind: "never" };
  if (w === "EWAge") return { kind: "afterQualifiedAge" };
  const age = resolveRef(ctx, src.withdrawAge, `${path}.withdrawAge`, "start", src.owner);
  if (age.ref.kind === "planStart") return { kind: "always" };
  if (w === true || typeof w === "string") return { kind: "from", ref: age.ref };
  return { kind: "always" };
}

function liquidOf(ctx: PlContext, v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined;
  if (v === true) return "always";
  if (v === false) return "never";
  if (v === "when-allowed" || v === "when-withdrawable") return "whenWithdrawable";
  if (v === "EWAge") return "afterQualifiedAge";
  invalid(
    ctx,
    `${path}.liquid`,
    `unknown liquidity '${String(v)}'; defaulted to when-withdrawable`,
  );
  return "whenWithdrawable";
}

/** AccountBehaviour (only the keys the source specifies; Glideworth defaults fill the rest). */
export function accountBehaviour(ctx: PlContext, src: Obj, path: string): Obj {
  const b: Obj = {};
  const set = (k: string, v: unknown): void => {
    if (v !== undefined) b[k] = v;
  };
  set("growth", growthOf(ctx, src, path));
  const div = dividendsOf(ctx, src, path);
  if (div) b.dividends = div;
  set("fees", feesOf(ctx, src, path));
  set("withdrawals", withdrawalsOf(ctx, src, path));
  set("liquid", liquidOf(ctx, src.liquid, path));
  if (
    src.hasEWPenalty !== undefined ||
    src.EWAge !== undefined ||
    src.EWPenaltyRate !== undefined
  ) {
    b.earlyWithdrawal = {
      enabled: bool(src.hasEWPenalty) ?? false,
      qualifiedAge: clamp(num(src.EWAge) ?? 59.5, 0, 100),
      penaltyRate: clamp(pct(src.EWPenaltyRate) ?? 0.1, -1, 10),
    };
  }
  if (src.drawdownMethod !== undefined) {
    if (src.drawdownMethod === "pcls" || src.drawdownMethod === "ufpls")
      b.ukDrawdownMethod = src.drawdownMethod;
    else
      invalid(
        ctx,
        `${path}.drawdownMethod`,
        `unknown UK drawdown method '${String(src.drawdownMethod)}'`,
      );
  }
  const taxFree = pctClean(src.taxFreeWithdrawalPercentage);
  if (taxFree !== undefined) b.taxFreeWithdrawalShare = clamp(taxFree, 0, 1);
  if (src.monteCarloTreatment !== undefined) {
    if (src.monteCarloTreatment === "auto" || src.monteCarloTreatment === "fixed")
      b.monteCarlo = src.monteCarloTreatment;
    else
      invalid(
        ctx,
        `${path}.monteCarloTreatment`,
        `unknown treatment '${String(src.monteCarloTreatment)}'`,
      );
  }
  if (src.repurpose === true) b.isExcessCash = true;
  return b;
}

export interface MappedAccount {
  sourceId: string;
  account: Obj;
}

/** today.savingsAccounts[] + investmentAccounts[] -> finances.accounts. */
export function mapAccounts(ctx: PlContext, today: Obj): MappedAccount[] {
  const out: MappedAccount[] = [];
  const groups: [string, unknown[]][] = [
    ["savingsAccounts", arr(today.savingsAccounts)],
    ["investmentAccounts", arr(today.investmentAccounts)],
  ];
  for (const [group, list] of groups) {
    list.forEach((raw, i) => {
      const path = `$.today.${group}[${i}]`;
      const src = obj(raw);
      const sid = str(src.id);
      const id = ctx.accountIds.get(sid, `account-${out.length + 1}`);
      if (sid) ctx.knownAccounts.add(sid);
      const type = accountTypeOf(ctx, src.type, path);
      const account: Obj = {
        id,
        name: nameOf(src, `Account ${out.length + 1}`),
        type,
        owner: ownerOf(ctx, src.owner, `${path}.owner`),
        balance: num(src.balance) ?? 0,
        behaviour: accountBehaviour(ctx, src, path),
      };
      const cb = num(src.costBasis);
      if (cb !== undefined) {
        if (cb >= 0) account.costBasis = cb;
        else invalid(ctx, `${path}.costBasis`, "negative cost basis dropped");
      }
      const currency = currencyOf(ctx, src.currency, `${path}.currency`);
      if (currency) account.currency = currency;
      const country = str(src.country);
      if (country && /^[A-Z]{2}$/.test(country)) account.jurisdiction = country;
      else if (country)
        invalid(
          ctx,
          `${path}.country`,
          `account country '${country}' is not an ISO alpha-2 code; dropped`,
        );
      const notes = str(src.subtitle);
      if (notes) account.notes = notes.slice(0, 20000);
      const appearance = appearanceOf(src);
      if (appearance) account.appearance = appearance;
      out.push({ sourceId: sid ?? id, account });
    });
  }
  return out;
}

/**
 * Per-plan account events -> Plan.accountSettings patches (behaviour keys that differ from the
 * account's own behaviour), plus plannedAccounts for events that reference unknown accounts.
 */
export function mapPlanAccounts(
  ctx: PlContext,
  events: unknown[],
  basePath: string,
  accounts: MappedAccount[],
): { accountSettings: Record<string, Obj>; plannedAccounts: Obj[]; present: Set<string> } {
  const accountSettings: Record<string, Obj> = {};
  const plannedAccounts: Obj[] = [];
  const present = new Set<string>();
  const bySource = new Map(accounts.map((a) => [a.sourceId, a]));
  events.forEach((raw, i) => {
    const path = `${basePath}[${i}]`;
    const src = obj(raw);
    const sid = str(src.accountId) ?? str(src.id);
    const base = sid ? bySource.get(sid) : undefined;
    if (!base) {
      // Not in Current Finances: an account created inside the plan.
      const id = ctx.accountIds.get(sid, `planned-account-${plannedAccounts.length + 1}`);
      const bal = num(src.balance) ?? 0;
      if (bal !== 0)
        approximated(
          ctx,
          `${path}.balance`,
          "planned accounts open with a zero balance in Glideworth; balance dropped",
        );
      infoNote(
        ctx,
        path,
        "account exists only in this plan; imported as a planned account opening at plan start",
        "pl.planned-account",
      );
      plannedAccounts.push({
        id,
        name: nameOf(src, `Planned account ${plannedAccounts.length + 1}`),
        type: accountTypeOf(ctx, src.type, path),
        owner: ownerOf(ctx, src.owner, `${path}.owner`),
        balance: 0,
        behaviour: accountBehaviour(ctx, src, path),
        opensAt: { kind: "planStart", offsetMonths: 0 },
      });
      if (sid) present.add(sid);
      return;
    }
    present.add(base.sourceId);
    const id = base.account.id as string;
    const behaviour = accountBehaviour(ctx, src, path);
    const patch = behaviourOverride(AccountBehaviour, obj(base.account.behaviour), behaviour);
    if (patch) accountSettings[id] = patch;
    // Plan-level overrides of non-behaviour fields have no home.
    for (const f of ["balance", "costBasis"] as const) {
      const a = num(src[f]);
      const b = num(obj(base.account)[f === "balance" ? "balance" : "costBasis"]);
      if (a !== undefined && b !== undefined && a !== b) {
        approximated(
          ctx,
          `${path}.${f}`,
          `plan-level ${f} differs from Current Finances; the Current Finances value is used`,
          "pl.plan-balance-override",
        );
      }
    }
    if (
      src.owner !== undefined &&
      ownerOf({ ...ctx, issues: [] }, src.owner, path) !== base.account.owner
    ) {
      approximated(
        ctx,
        `${path}.owner`,
        "plan-level account owner differs from Current Finances; the Current Finances owner is used",
      );
    }
    if (
      str(src.type) !== undefined &&
      accountTypeOf({ ...ctx, issues: [] }, src.type, path) !== base.account.type
    ) {
      approximated(
        ctx,
        `${path}.type`,
        "plan-level account type differs from Current Finances; the Current Finances type is used",
      );
    }
  });
  return { accountSettings, plannedAccounts, present };
}
