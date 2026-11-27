/**
 * Withdrawal-strategy and flexible-spending rules as PURE functions. Workstream (a) calls these from
 * the engine's `spending.strategy` phase; (d) owns the rule logic. All money is nominal unless a
 * field says otherwise; `priceIndex` converts the plan's real amounts (floors, ceilings, fixed
 * amounts) into this period's nominal money.
 */
import { pluralDuration } from "../insights/format.js";
import type { FlexSpending, WithdrawalStrategy } from "../schema/strategies.js";

export interface WithdrawalState {
  /** Years since the strategy started (0 = first year). */
  yearIndex: number;
  /** Investable portfolio at the start of this year (nominal). */
  portfolio: number;
  /** Portfolio when the strategy started (nominal, at that time). */
  initialPortfolio: number;
  /** Last year's withdrawal (nominal); null in the first year. */
  previousWithdrawal: number | null;
  /** Inflation over the previous year (decimal). */
  lastYearInflation: number;
  /** Portfolio return over the previous year (decimal), for Guyton-Klinger's withdrawal rule. */
  lastYearReturn?: number;
  /** Price index now relative to the plan reference month (converts real amounts to nominal). */
  priceIndex: number;
  /** Price index when the strategy started. */
  startPriceIndex: number;
  /** Years remaining in the plan including this one (>= 1). */
  remainingYears: number;
  /** Stock share of the portfolio (VPW). Defaults to 0.6. */
  stockShare?: number;
  /** Years since the last ratchet raise (ratcheting cooldown); null = never raised. */
  yearsSinceRaise?: number | null;
  /** Current ratcheted base withdrawal (nominal) for the ratcheting rule; null in the first year. */
  ratchetBase?: number | null;
}

export type WithdrawalAction =
  | "initial"
  | "inflation"
  | "hold"
  | "recalculate"
  | "cut"
  | "raise"
  | "floor"
  | "ceiling";

export interface WithdrawalDecision {
  /** Withdrawal (or spending target) for this year, nominal. */
  amount: number;
  action: WithdrawalAction;
  /** Current withdrawal rate (amount / portfolio). */
  rate: number | null;
  /** State to carry into next year for the stateful rules. */
  yearsSinceRaise: number | null;
  ratchetBase: number | null;
  explanation: string;
}

/** Expected real returns used for VPW's amortisation (Bogleheads-style long-run assumptions). */
export const VPW_REAL_RETURNS = { stocks: 0.05, bonds: 0.019 } as const;

/** Amortised payment: the level payment that exhausts `pv` over `n` years at rate `r`. */
export function amortisedPayment(pv: number, r: number, n: number): number {
  if (n <= 0) return pv;
  if (Math.abs(r) < 1e-12) return pv / n;
  return (pv * r) / (1 - (1 + r) ** -n);
}

/** Compute this year's withdrawal for a strategy. */
export function computeWithdrawal(
  strategy: Pick<WithdrawalStrategy, "rule" | "bounds">,
  s: WithdrawalState,
): WithdrawalDecision {
  const rule = strategy.rule;
  const first = s.yearIndex === 0 || s.previousWithdrawal === null;
  const inflated = (s.previousWithdrawal ?? 0) * (1 + s.lastYearInflation);
  let amount: number;
  let action: WithdrawalAction = first ? "initial" : "inflation";
  let yearsSinceRaise = s.yearsSinceRaise ?? null;
  let ratchetBase = s.ratchetBase ?? null;
  let why: string;

  switch (rule.kind) {
    case "fixed-amount": {
      const nominal =
        rule.amount.basis === "real" ? rule.amount.value * s.priceIndex : rule.amount.value;
      amount = rule.inflationAdjust
        ? nominal
        : rule.amount.basis === "real"
          ? rule.amount.value * s.startPriceIndex
          : rule.amount.value;
      action = first ? "initial" : rule.inflationAdjust ? "inflation" : "hold";
      why = rule.inflationAdjust
        ? "Fixed amount, rising with inflation."
        : "Fixed amount, not adjusted for inflation.";
      break;
    }
    case "initial-percent":
      amount = first ? rule.rate * s.initialPortfolio : inflated;
      why = first
        ? `First year: ${(rule.rate * 100).toFixed(2)}% of the starting portfolio.`
        : "Last year's withdrawal raised by inflation.";
      break;
    case "fixed-percent":
      amount = rule.rate * s.portfolio;
      action = "recalculate";
      why = `${(rule.rate * 100).toFixed(2)}% of this year's portfolio.`;
      break;
    case "one-over-n":
      amount = s.portfolio / Math.max(1, s.remainingYears);
      action = "recalculate";
      why = `Portfolio divided by the ${pluralDuration(Math.max(1, s.remainingYears), "year")} remaining.`;
      break;
    case "vpw": {
      const share = rule.stockShare ?? s.stockShare ?? 0.6;
      const r = share * VPW_REAL_RETURNS.stocks + (1 - share) * VPW_REAL_RETURNS.bonds;
      // The amortised payment is an end-of-year annuity, so in the final year it is portfolio x
      // (1 + r): more than the whole portfolio. VPW never withdraws more than 100% of the portfolio
      // (its final-year percentage is 100%), so cap it; earlier years are unaffected (payment < pv).
      amount = Math.min(
        s.portfolio,
        amortisedPayment(s.portfolio, r, Math.max(1, s.remainingYears)),
      );
      action = "recalculate";
      why = `Variable percentage withdrawal: amortise the portfolio over ${pluralDuration(Math.max(1, s.remainingYears), "year")} at ${(r * 100).toFixed(2)}% real.`;
      break;
    }
    case "ratcheting": {
      if (first || ratchetBase === null) {
        ratchetBase = rule.rate * s.initialPortfolio;
        yearsSinceRaise = null;
      } else {
        ratchetBase *= 1 + s.lastYearInflation;
      }
      const realGrowth = s.portfolio / s.priceIndex / (s.initialPortfolio / s.startPriceIndex) - 1;
      if (!first && yearsSinceRaise !== null) yearsSinceRaise += 1;
      const cooled = yearsSinceRaise === null || yearsSinceRaise >= rule.cooldownYears;
      if (!first && realGrowth >= rule.threshold && cooled) {
        ratchetBase *= 1 + rule.raise;
        yearsSinceRaise = 0;
        action = "raise";
        why = `Portfolio is ${(realGrowth * 100).toFixed(0)}% above its starting real value, so spending ratchets up ${(rule.raise * 100).toFixed(0)}%.`;
      } else {
        why = first
          ? `First year: ${(rule.rate * 100).toFixed(2)}% of the starting portfolio.`
          : "Inflation-adjusted; no ratchet this year.";
      }
      amount = ratchetBase;
      break;
    }
    case "clyatt-95": {
      const pct = rule.rate * s.portfolio;
      const minimum = (s.previousWithdrawal ?? 0) * rule.minShareOfPrevious;
      amount = first ? pct : Math.max(pct, minimum);
      action = first ? "initial" : pct >= minimum ? "recalculate" : "floor";
      why =
        action === "floor"
          ? `${(rule.rate * 100).toFixed(2)}% of the portfolio would fall below ${(rule.minShareOfPrevious * 100).toFixed(0)}% of last year, so the minimum applies.`
          : `${(rule.rate * 100).toFixed(2)}% of this year's portfolio.`;
      break;
    }
    case "guyton-klinger": {
      if (first) {
        amount = rule.rate * s.initialPortfolio;
        why = `First year: ${(rule.rate * 100).toFixed(2)}% of the starting portfolio.`;
        break;
      }
      const prev = s.previousWithdrawal!;
      const prevRate = s.portfolio > 0 ? prev / s.portfolio : Number.POSITIVE_INFINITY;
      // Withdrawal rule: skip the inflation raise after a losing year if the rate is above initial.
      const skipInflation = (s.lastYearReturn ?? 0) < 0 && prevRate > rule.rate;
      amount = skipInflation ? prev : inflated;
      action = skipInflation ? "hold" : "inflation";
      why = skipInflation
        ? "Losing year with a high withdrawal rate: no inflation raise."
        : "Inflation-adjusted.";
      const rate = s.portfolio > 0 ? amount / s.portfolio : Number.POSITIVE_INFINITY;
      const upper = rule.rate * (1 + rule.guardrail);
      const lower = rule.rate * (1 - rule.guardrail);
      // Capital preservation does not apply in the final 15 years (Guyton-Klinger 2006).
      if (rate > upper && s.remainingYears > 15) {
        amount *= 1 - rule.adjustment;
        action = "cut";
        why = `Withdrawal rate ${(rate * 100).toFixed(2)}% is above the upper guardrail ${(upper * 100).toFixed(2)}%: cut ${(rule.adjustment * 100).toFixed(0)}%.`;
      } else if (rate < lower) {
        amount *= 1 + rule.adjustment;
        action = "raise";
        why = `Withdrawal rate ${(rate * 100).toFixed(2)}% is below the lower guardrail ${(lower * 100).toFixed(2)}%: raise ${(rule.adjustment * 100).toFixed(0)}%.`;
      }
      break;
    }
  }

  const floor = strategy.bounds.floor;
  const ceiling = strategy.bounds.ceiling;
  const floorN = floor ? (floor.basis === "real" ? floor.value * s.priceIndex : floor.value) : null;
  const ceilN = ceiling
    ? ceiling.basis === "real"
      ? ceiling.value * s.priceIndex
      : ceiling.value
    : null;
  if (floorN !== null && amount < floorN) {
    amount = floorN;
    action = "floor";
    why += " Raised to the spending floor.";
  }
  if (ceilN !== null && amount > ceilN) {
    amount = ceilN;
    action = "ceiling";
    why += " Capped at the spending ceiling.";
  }
  amount = Math.max(0, amount);
  return {
    amount,
    action,
    rate: s.portfolio > 0 ? amount / s.portfolio : null,
    yearsSinceRaise,
    ratchetBase,
    explanation: why,
  };
}

/**
 * Flexible spending: share of flexed spending to CUT given the portfolio's drawdown from its
 * all-time high (0.25 = 25% below the peak). Step uses the deepest rule reached; linear
 * interpolates between (0, 0) and the rule points.
 */
export function flexSpendingCut(
  flex: Pick<FlexSpending, "rules" | "interpolation">,
  drawdownFromPeak: number,
): number {
  const rules = [...flex.rules].sort((a, b) => a.drawdown - b.drawdown);
  const dd = Math.max(0, drawdownFromPeak);
  if (rules.length === 0) return 0;
  if (flex.interpolation === "step") {
    let cut = 0;
    for (const r of rules) if (dd >= r.drawdown - 1e-12) cut = r.cut;
    return cut;
  }
  const pts = [{ drawdown: 0, cut: 0 }, ...rules];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (dd <= b.drawdown) {
      const w = b.drawdown - a.drawdown;
      return w <= 0 ? b.cut : a.cut + ((dd - a.drawdown) / w) * (b.cut - a.cut);
    }
  }
  return pts[pts.length - 1]!.cut;
}

/** Simulate a rule over a sequence of annual returns/inflation (for tests, previews and charts). */
export function withdrawalPath(
  strategy: Pick<WithdrawalStrategy, "rule" | "bounds">,
  opts: {
    portfolio: number;
    years: number;
    returns: number[];
    inflation: number[];
    stockShare?: number;
  },
): {
  year: number;
  portfolio: number;
  withdrawal: number;
  action: WithdrawalAction;
  rate: number | null;
}[] {
  const out: {
    year: number;
    portfolio: number;
    withdrawal: number;
    action: WithdrawalAction;
    rate: number | null;
  }[] = [];
  let p = opts.portfolio;
  let prev: number | null = null;
  let pi = 1;
  let yearsSinceRaise: number | null = null;
  let ratchetBase: number | null = null;
  for (let y = 0; y < opts.years; y++) {
    const d = computeWithdrawal(strategy, {
      yearIndex: y,
      portfolio: p,
      initialPortfolio: opts.portfolio,
      previousWithdrawal: prev,
      lastYearInflation: y === 0 ? 0 : (opts.inflation[y - 1] ?? 0),
      lastYearReturn: y === 0 ? 0 : (opts.returns[y - 1] ?? 0),
      priceIndex: pi,
      startPriceIndex: 1,
      remainingYears: opts.years - y,
      yearsSinceRaise,
      ratchetBase,
      ...(opts.stockShare !== undefined ? { stockShare: opts.stockShare } : {}),
    });
    const w = Math.min(d.amount, Math.max(0, p));
    out.push({ year: y, portfolio: p, withdrawal: w, action: d.action, rate: d.rate });
    p = (p - w) * (1 + (opts.returns[y] ?? 0));
    pi *= 1 + (opts.inflation[y] ?? 0);
    prev = d.amount;
    yearsSinceRaise = d.yearsSinceRaise;
    ratchetBase = d.ratchetBase;
  }
  return out;
}
