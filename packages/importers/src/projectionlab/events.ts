/** Income and expense events. */
import { arr, num, type Obj, obj, pctClean, str } from "../util/read.js";
import {
  amountOf,
  appearanceOf,
  changeOf,
  clamp,
  currencyOf,
  frequencyOf,
  nameOf,
  ownerOf,
  recurrenceOf,
} from "./common.js";
import { approximated, invalid, type PlContext, resolveSource } from "./context.js";
import { resolveRange } from "./dates.js";

/** Source account id -> Glideworth account id (undefined + issue when it does not exist). */
export function accountRef(ctx: PlContext, sid: unknown, path: string): string | undefined {
  const resolved = resolveSource(ctx, "account", sid);
  if (resolved === undefined) {
    invalid(
      ctx,
      path,
      "references an account that is not in Current Finances or this plan; reference dropped",
    );
    return undefined;
  }
  return ctx.accountIds.get(resolved, "account");
}

function accountList(ctx: PlContext, v: unknown, path: string): string[] {
  const out: string[] = [];
  arr(v).forEach((x, i) => {
    const id = accountRef(ctx, x, `${path}[${i}]`);
    if (id) out.push(id);
  });
  return out;
}

const INCOME_TYPES = new Set([
  "salary",
  "hourly",
  "self-employment",
  "bonus",
  "rsu",
  "inheritance",
  "windfall",
  "social-security",
  "pension",
  "annuity",
  "state-pension",
  "ca-cpp",
  "ca-oas",
  "ca-gis",
  "other",
]);
const INCOME_ALIASES: Record<string, string> = {
  wages: "salary",
  wage: "salary",
  "self-employed": "self-employment",
  business: "self-employment",
  gift: "windfall",
  "one-time": "windfall",
  "defined-benefit": "pension",
  "uk-state-pension": "state-pension",
};

const TAX_CHARACTERS = new Set([
  "auto",
  "wage",
  "self-employment",
  "ordinary",
  "pension",
  "social-security",
  "qualified-dividend",
  "ordinary-dividend",
  "interest",
  "capital-gains-long",
  "capital-gains-short",
  "rental",
  "tax-free",
]);

function pensionOf(ctx: PlContext, src: Obj, path: string): Obj | undefined {
  if (src.hasPension !== true) return undefined;
  const contribType = src.pensionContributionType;
  const contribution = num(src.pensionContribution) ?? 0;
  const employeeContribution =
    contribType === "%" || contribType === undefined
      ? { kind: "percentOfPay", rate: pctClean(contribution) }
      : {
          kind: "amount",
          amount: amountOf(ctx, contribution, contribType, `${path}.pensionContributionType`),
        };
  const payoutType = str(src.pensionPayoutType) ?? "fap";
  let payout: Obj;
  if (payoutType === "fap" || payoutType === "final-pay" || payoutType === "final-salary") {
    payout = { kind: "percentOfFinalPay", rate: pctClean(src.pensionPayoutRate) ?? 0 };
  } else if (payoutType === "cap" || payoutType === "career-average" || payoutType === "career") {
    payout = { kind: "percentOfCareerAverage", rate: pctClean(src.pensionPayoutRate) ?? 0 };
  } else if (
    payoutType === "amount" ||
    payoutType === "fixed" ||
    payoutType === "$" ||
    payoutType === "today$"
  ) {
    payout = {
      kind: "amount",
      amount: { value: num(src.pensionPayoutAmount) ?? 0, basis: "real" },
    };
  } else {
    invalid(
      ctx,
      `${path}.pensionPayoutType`,
      `unknown pension payout type '${payoutType}'; read as % of final pay`,
    );
    payout = { kind: "percentOfFinalPay", rate: pctClean(src.pensionPayoutRate) ?? 0 };
  }
  const payouts = resolveRange(
    ctx,
    { start: src.pensionPayoutsStart, end: src.pensionPayoutsEnd, owner: src.owner },
    `${path}.pensionPayouts`,
  );
  return {
    employeeContribution,
    contributionsReduceTaxableIncome: src.contribsReduceTaxableIncome !== false,
    payouts,
    payout,
    payoutsTaxFree: src.pensionPayoutsAreTaxFree === true,
  };
}

/** Shared event fields: id, name, owner, amount, frequency, range, change, recurrence. */
function eventBase(ctx: PlContext, src: Obj, path: string, id: string, fallbackName: string): Obj {
  const frequency = frequencyOf(ctx, src.frequency, `${path}.frequency`);
  const base: Obj = {
    id,
    name: nameOf(src, fallbackName),
    owner: ownerOf(ctx, src.owner, `${path}.owner`),
    amount: amountOf(ctx, src.amount, src.amountType, `${path}.amountType`),
    frequency,
    range: resolveRange(ctx, { start: src.start, end: src.end, frequency, owner: src.owner }, path),
  };
  const { change, changeLimit } = changeOf(ctx, src.yearlyChange, `${path}.yearlyChange`, "event");
  if (change) base.change = change;
  if (changeLimit) base.changeLimit = changeLimit;
  const rec = recurrenceOf(ctx, src, path, "event");
  if (rec) base.recurrence = rec;
  const appearance = appearanceOf(src);
  if (appearance) base.appearance = appearance;
  const currency = currencyOf(ctx, src.currency, `${path}.currency`);
  if (currency) base.currency = currency;
  return base;
}

export function mapIncomeEvent(ctx: PlContext, raw: unknown, path: string, index: number): Obj {
  const src = obj(raw);
  const scope = ctx.plan!;
  const id = scope.eventIds.get(str(src.id), `income-${index + 1}`);
  const rawType = typeof src.type === "string" ? src.type : "";
  let type = INCOME_TYPES.has(rawType) ? rawType : INCOME_ALIASES[rawType];
  if (!type) {
    invalid(ctx, `${path}.type`, `unknown income type '${rawType}'; imported as 'other'`);
    type = "other";
  }
  const ev = eventBase(ctx, src, path, id, `Income ${index + 1}`);
  ev.type = type;

  // Tax
  let character = str(src.taxCharacter) ?? "auto";
  if (!TAX_CHARACTERS.has(character)) {
    invalid(ctx, `${path}.taxCharacter`, `unknown tax character '${character}'; using auto`);
    character = "auto";
  }
  const exemptIn: string[] = [];
  if (src.taxExempt === true) {
    if (character === "auto") character = "tax-free";
    else
      approximated(
        ctx,
        `${path}.taxExempt`,
        `tax-exempt flag ignored because the tax character is '${character}'`,
      );
  } else if (Array.isArray(src.taxExempt)) {
    for (const x of src.taxExempt) if (typeof x === "string") exemptIn.push(x);
  }
  const mode = str(src.withholdingMode) ?? "auto";
  let withholding: Obj = { mode: "auto" };
  if (mode === "none") withholding = { mode: "none" };
  else if (mode === "fixed") {
    const rate = pctClean(src.withholdingRate ?? src.withholdingPercent);
    if (rate === undefined)
      invalid(ctx, `${path}.withholdingMode`, "fixed withholding without a rate; using 'auto'");
    else withholding = { mode: "fixed", rate };
  } else if (mode !== "auto")
    invalid(ctx, `${path}.withholdingMode`, `unknown withholding mode '${mode}'; using auto`);
  ev.tax = { character, withholding, exemptIn };

  // Routing
  const routes = accountList(ctx, src.routeToAccounts, `${path}.routeToAccounts`);
  if (routes.length > 0)
    ev.sendTo = {
      kind: "accounts",
      accountIds: routes,
      ...(src.preventOverflow === true ? { preventOverflow: true } : {}),
    };

  // Part-time
  if (src.goPartTime === true) {
    const share = pctClean(src.partTimeRate);
    if (share === undefined)
      invalid(ctx, `${path}.partTimeRate`, "part-time enabled without a rate; part-time dropped");
    else {
      const range = resolveRange(
        ctx,
        { start: src.partTimeStart, end: src.partTimeEnd, owner: src.owner },
        `${path}.partTime`,
      );
      ev.partTime = { range, share: clamp(share, 0, 1) };
    }
  }

  // Defined-benefit pension on salary
  const pension = pensionOf(ctx, src, path);
  if (pension) {
    if (type === "salary") ev.pension = pension;
    else
      approximated(
        ctx,
        `${path}.hasPension`,
        `defined-benefit pension on a '${type}' income cannot be represented; dropped`,
        "pl.pension-non-salary",
      );
  }
  if (type === "hourly") ev.hoursPerWeek = clamp(num(src.hoursPerWeek) ?? 40, 0, 168);
  if (type === "rsu") ev.vesting = [];
  return ev;
}

const EXPENSE_TYPES = new Set([
  "living",
  "housing",
  "healthcare",
  "education",
  "childcare",
  "dependent-support",
  "travel",
  "wedding",
  "charity",
  "transportation",
  "insurance",
  "entertainment",
  "personal",
  "pets",
  "tax-payment",
  "tax-deduction",
  "other",
]);
const EXPENSE_ALIASES: Record<string, string> = {
  "living-expenses": "living",
  "housing-expenses": "housing",
  rent: "housing",
  mortgage: "housing",
  medical: "healthcare",
  health: "healthcare",
  "health-care": "healthcare",
  "child-care": "childcare",
  kids: "childcare",
  tuition: "education",
  vacation: "travel",
  donation: "charity",
  giving: "charity",
  car: "transportation",
  transport: "transportation",
  taxes: "tax-payment",
  "one-time": "other",
};

const SPENDING_TYPES = new Set(["essential", "discretionary", "hybrid", "not-spending"]);

export function mapExpenseEvent(
  ctx: PlContext,
  raw: unknown,
  path: string,
  index: number,
  incomeIds: Map<string, string>,
): Obj {
  const src = obj(raw);
  const scope = ctx.plan!;
  const id = scope.eventIds.get(str(src.id), `expense-${index + 1}`);
  const rawType = typeof src.type === "string" ? src.type : "";
  let type = EXPENSE_TYPES.has(rawType) ? rawType : EXPENSE_ALIASES[rawType];
  const isOrphanDebt = rawType === "debt";
  if (isOrphanDebt) {
    type = "other";
    approximated(
      ctx,
      `${path}.type`,
      "'debt' expense whose debt is not in Current Finances; imported as an 'other' expense of its monthly payment",
      "pl.orphan-debt",
    );
  } else if (!type) {
    invalid(ctx, `${path}.type`, `unknown expense type '${rawType}'; imported as 'other'`);
    type = "other";
  }
  const effective = isOrphanDebt
    ? { ...src, amount: src.monthlyPayment ?? src.amount, frequency: "monthly" }
    : src;
  const ev = eventBase(ctx, effective, path, id, `Expense ${index + 1}`);
  ev.type = type;
  let spending = str(src.spendingType) ?? "essential";
  if (!SPENDING_TYPES.has(spending)) {
    invalid(ctx, `${path}.spendingType`, `unknown spending type '${spending}'; using essential`);
    spending = "essential";
  }
  ev.spendingType = spending;
  const funds = accountList(ctx, src.fundWithAccounts, `${path}.fundWithAccounts`);
  if (funds.length > 0) ev.payFrom = { kind: "accounts", accountIds: funds };
  const tax: Obj = {};
  if (src.taxDeductible !== undefined) tax.deductible = src.taxDeductible === true;
  if (src.itemized !== undefined) tax.itemized = src.itemized === true;
  const treat = str(src.taxTreatment);
  if (treat !== undefined) {
    if (treat === "tax-exempt" || treat === "taxable" || treat === "auto") tax.treatment = treat;
    else invalid(ctx, `${path}.taxTreatment`, `unknown tax treatment '${treat}'`);
  }
  const from = str(src.deductFromIncomeId);
  if (from) {
    const mapped = incomeIds.get(from);
    if (mapped) tax.payrollDeductionFromIncomeId = mapped;
    else
      invalid(
        ctx,
        `${path}.deductFromIncomeId`,
        "references an income event that is not in this plan; dropped",
      );
  }
  if (Object.keys(tax).length > 0) ev.tax = tax;
  if (type === "healthcare") ev.healthcare = { kind: "standard" };
  if (type === "tax-deduction") ev.creditOrDeduction = "deduction";
  return ev;
}
