/** Debts: today.debts[] and the per-plan `debt` expense events that mirror them. */
import { DEBT_TYPES, DebtBehaviour } from "@glideworth/core";
import { arr, num, type Obj, obj, str } from "../util/read.js";
import { interestOf } from "./assets.js";
import { appearanceOf, basisOf, behaviourOverride, currencyOf, nameOf, ownerOf } from "./common.js";
import { approximated, invalid, type PlContext } from "./context.js";
import { resolveRef } from "./dates.js";

const DEBT_TYPE_SET = new Set<string>(DEBT_TYPES);
const DEBT_ALIASES: Record<string, string> = {
  mortgage: "other",
  student: "student-loan",
  "credit-card-debt": "credit-card",
  card: "credit-card",
  loan: "personal-loan",
  auto: "auto-loan",
  car: "auto-loan",
};

export interface MappedDebt {
  sourceId: string;
  debt: Obj;
  src: Obj;
}

/** DebtBehaviour (only keys the source specifies). */
export function debtBehaviour(ctx: PlContext, src: Obj, path: string): Obj {
  const b: Obj = {};
  const start = resolveRef(ctx, src.start, `${path}.start`, "start", src.owner);
  if (start.ref.kind !== "planStart") b.paymentsStart = start.ref;
  if (src.end !== undefined) {
    const end = resolveRef(ctx, src.end, `${path}.end`, "end", src.owner);
    if (end.ref.kind !== "never" && end.ref.kind !== "planEnd") b.paymentsEnd = end.ref;
  }
  const yc = obj(src.yearlyChange);
  const ycType = str(yc.type);
  if (ycType && ycType !== "none") {
    const rate = (num(yc.amount) ?? 0) / 100;
    const signed = ycType === "depreciate" || ycType === "decrease" ? -Math.abs(rate) : rate;
    if (signed !== 0) {
      const change: Obj = { rate: Math.max(-1, Math.min(10, signed)) };
      const limit = num(yc.limit);
      if (yc.limitEnabled === true && limit !== undefined && limit >= 0)
        change[signed < 0 ? "min" : "max"] = limit;
      b.balanceChange = change;
    }
  }
  if (src.hasForgiveness === true) {
    b.forgiveness = {
      at: resolveRef(ctx, src.forgiveAt, `${path}.forgiveAt`, "start", src.owner).ref,
      taxable: false,
    };
  }
  return b;
}

/** today.debts[] -> finances.debts. */
export function mapDebts(ctx: PlContext, today: Obj): MappedDebt[] {
  return arr(today.debts).map((raw, i) => {
    const path = `$.today.debts[${i}]`;
    const src = obj(raw);
    const sid = str(src.id);
    const id = ctx.debtIds.get(sid, `debt-${i + 1}`);
    if (sid) ctx.knownDebts.add(sid);
    const rawType = typeof src.type === "string" ? src.type : "";
    let type = DEBT_TYPE_SET.has(rawType) ? rawType : DEBT_ALIASES[rawType];
    if (!type) {
      invalid(ctx, `${path}.type`, `unknown debt type '${rawType}'; imported as 'other'`);
      type = "other";
    }
    if (src.frequency !== undefined && src.frequency !== "monthly") {
      approximated(
        ctx,
        `${path}.frequency`,
        `debt payment frequency '${String(src.frequency)}' is not monthly; payment amount is used per month`,
        "pl.debt-frequency",
      );
    }
    const debt: Obj = {
      id,
      name: nameOf(src, `Debt ${i + 1}`),
      type,
      owner: ownerOf(ctx, src.owner, `${path}.owner`),
      balance: Math.max(0, num(src.amount) ?? 0),
      interest: interestOf(ctx, src, path),
      monthlyPayment: {
        value: num(src.monthlyPayment) ?? 0,
        basis: basisOf(ctx, src.monthlyPaymentType, `${path}.monthlyPaymentType`),
      },
      behaviour: debtBehaviour(ctx, src, path),
    };
    const currency = currencyOf(ctx, src.currency, `${path}.currency`);
    if (currency) debt.currency = currency;
    const appearance = appearanceOf(src);
    if (appearance) debt.appearance = appearance;
    // `end` maps to behaviour.paymentsEnd (see debtBehaviour).
    return { sourceId: sid ?? id, debt, src };
  });
}

/**
 * `debt`-typed expense events -> Plan.debtSettings. Returns the settings and the set of
 * source debt ids the plan lists (for excludedIds).
 */
export function mapPlanDebtEvent(
  ctx: PlContext,
  src: Obj,
  path: string,
  debts: MappedDebt[],
): { debtId: string; patch: Obj } | undefined {
  const sid = str(src.debtId);
  const base = sid ? debts.find((d) => d.sourceId === sid) : undefined;
  if (!base) return undefined;
  const behaviour = debtBehaviour(ctx, src, path);
  const baseBehaviour = obj(base.debt.behaviour);
  const overridden = obj(obj(src._meta).overriddenFields).monthlyPayment === true;
  const payment = num(src.monthlyPayment);
  const basePayment = num(base.src.monthlyPayment);
  const merged: Obj = { ...behaviour };
  if (payment !== undefined && (overridden || payment !== basePayment)) {
    merged.monthlyPaymentOverride = {
      value: payment,
      basis: basisOf(ctx, src.monthlyPaymentType, `${path}.monthlyPaymentType`),
    };
  }
  const patch = behaviourOverride(DebtBehaviour, baseBehaviour, merged) ?? {};
  for (const [field, label] of [
    ["amount", "balance"],
    ["interestRate", "interest rate"],
    ["interestType", "interest type"],
    ["compounding", "compounding"],
  ] as const) {
    if (
      src[field] !== undefined &&
      base.src[field] !== undefined &&
      src[field] !== base.src[field]
    ) {
      approximated(
        ctx,
        `${path}.${field}`,
        `plan-level debt ${label} differs from Current Finances; the Current Finances value is used`,
        "pl.plan-debt-override",
      );
    }
  }
  return { debtId: base.debt.id as string, patch };
}
