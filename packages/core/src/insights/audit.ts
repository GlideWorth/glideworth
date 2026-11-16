/**
 * Assumption audit: static checks on a plan (plus optional checks on its projection) that flag risky
 * or inconsistent inputs. Each finding has a code, severity, plain-English message and, where a
 * mechanical fix exists, a plan patch (`fix.patch`) the UI/API can preview and apply.
 *
 * Thresholds are deliberately conservative and documented next to each check. Statutory figures
 * (ISA/LISA allowances, pension annual allowance, full new State Pension, State Pension age, US
 * 401(k)/IRA limits) are looked up in the tax data tables (src/tax/data), never hard-coded here.
 */
import { parseMonth } from "../engine/dates.js";
import { type ProjectionResult, type SimulationInput, toBasis } from "../engine/types.js";
import { ACCOUNT_TYPE_INFO } from "../schema/account-types.js";
import type { AccountType } from "../schema/accounts.js";
import type { PatchOp } from "../schema/changes.js";
import type { ExpenseEvent } from "../schema/events.js";
import { FREQUENCY_PER_YEAR } from "../schema/primitives.js";
import type { DateRef } from "../schema/time.js";
import { US_LIMITS_2026 } from "../tax/data/us-federal.js";
import { pickYear, UK_TAX_YEARS, ukStatePensionAge } from "../tax/index.js";
import type { Finding } from "./contracts.js";
import { crossBorderFindings } from "./crossborder.js";
import { fmtMoney, fmtPercent } from "./format.js";

/** Statutory figures, looked up in the tax data tables (src/tax/data) for the current tax year. */
const UK_2026 = pickYear(UK_TAX_YEARS, 2026);
export const UK_ISA_ALLOWANCE = UK_2026.isa.overall;
export const UK_LISA_ALLOWANCE = UK_2026.isa.lisa;
export const UK_PENSION_ANNUAL_ALLOWANCE = UK_2026.pensions.annualAllowance;
export const UK_FULL_STATE_PENSION_WEEKLY = UK_2026.statePension.fullNewWeekly;
export const US_401K_DEFERRAL_LIMIT = US_LIMITS_2026.electiveDeferral;
export const US_IRA_LIMIT = US_LIMITS_2026.ira;

/** Statutory limits for the plan's first tax year (falls back to the latest data row). */
function ukYear(input: SimulationInput) {
  return pickYear(UK_TAX_YEARS, planYear(input));
}
function planYear(input: SimulationInput): number {
  const asOf =
    input.plan.startingConditions.kind === "snapshot"
      ? input.plan.startingConditions.finances.asOf
      : input.finances.asOf;
  return Number(asOf.slice(0, 4));
}
function spaFor(birthMonth: string): number {
  const [y, m] = birthMonth.split("-").map(Number) as [number, number];
  return ukStatePensionAge(y, m);
}

const UK_PENSIONS: AccountType[] = ["uk-sipp", "uk-workplace-pension", "uk-pension"];
const US_WORKPLACE: AccountType[] = [
  "401k",
  "roth-401k",
  "403b",
  "roth-403b",
  "457b",
  "roth-457b",
  "tsp",
  "roth-tsp",
  "solo-401k",
];
const US_IRA: AccountType[] = ["traditional-ira", "roth-ira"];

export interface AuditOptions {
  /** Projection of the same input; enables result-based checks (penalties, spending drops, cash drag). */
  result?: ProjectionResult;
}

type Sev = Finding["severity"];

function f(
  code: string,
  severity: Sev,
  title: string,
  message: string,
  extra: Partial<Pick<Finding, "refs" | "evidence" | "suggestion" | "fix" | "periodIndex">> = {},
): Finding {
  return {
    code,
    severity,
    title,
    message,
    periodIndex: extra.periodIndex ?? null,
    refs: extra.refs ?? [],
    evidence: extra.evidence ?? [],
    ...(extra.suggestion ? { suggestion: extra.suggestion } : {}),
    ...(extra.fix ? { fix: extra.fix } : {}),
  };
}

const annual = (e: { amount: { value: number }; frequency: keyof typeof FREQUENCY_PER_YEAR }) =>
  e.frequency === "once" ? 0 : e.amount.value * FREQUENCY_PER_YEAR[e.frequency];

function finances(input: SimulationInput) {
  const sc = input.plan.startingConditions;
  return sc.kind === "snapshot" ? sc.finances : input.finances;
}

/** Static + (optional) result-based assumption audit. */
export function auditAssumptions(input: SimulationInput, opts: AuditOptions = {}): Finding[] {
  const out: Finding[] = [];
  const { plan, household } = input;
  const fin = finances(input);
  const cur = household.currency;
  const m = (v: number) => fmtMoney(v, { currency: cur, locale: household.locale });
  const a = plan.assumptions;
  const start = parseMonth(fin.asOf);
  const excluded = new Set(plan.excludedIds);
  const accounts = [
    ...fin.accounts.filter((x) => !x.archived && !excluded.has(x.id)),
    ...plan.plannedAccounts,
  ];
  const fixed = (spec: typeof a.inflation) => (spec.kind === "fixed" ? spec.rate : null);
  const infl = fixed(a.inflation);
  const enabledExpenses = plan.expenses.filter((e) => e.enabled);
  const essentialAnnual = enabledExpenses
    .filter((e) => e.spendingType === "essential" && e.range.start.kind === "planStart")
    .reduce((s, e) => s + annual(e), 0);

  // --- Returns above historical norms (real, total return incl. dividends/yield).
  const stock = fixed(a.stockReturn);
  const div = fixed(a.dividendYield) ?? 0;
  if (stock !== null && infl !== null) {
    const real = stock + div - infl;
    if (real > 0.07) {
      const target = infl + 0.05 - div;
      out.push(
        f(
          "RETURNS_HIGH",
          real > 0.09 ? "critical" : "warning",
          "Stock returns look optimistic",
          `Stocks are assumed to return ${fmtPercent(real)} a year above inflation (price growth ${fmtPercent(stock)} + dividends ${fmtPercent(div)} - inflation ${fmtPercent(infl)}). Long-run global equity returns have been roughly 5% above inflation; planning on more makes every result look better than it is.`,
          {
            evidence: [
              { source: "plan", path: "/assumptions/stockReturn", value: stock, realTotal: real },
            ],
            suggestion:
              "In this model, a lower return assumption is more cautious: about 5% above inflation is the level used for this check, and anything better is upside.",
            fix: {
              description: `Example change: set stock price growth to ${fmtPercent(target)} (5% real total return)`,
              patch: [
                {
                  op: "replace",
                  path: "/assumptions/stockReturn",
                  value: { kind: "fixed", rate: target },
                },
              ],
            },
          },
        ),
      );
    }
  }
  const bond = fixed(a.bondReturn);
  const bondYield = fixed(a.bondYield) ?? 0;
  const bondsHeld =
    a.bondAllocation.kind !== "none" &&
    (a.bondAllocation.share > 0 || a.bondAllocation.points.length > 0);
  if (bond !== null && infl !== null && bondsHeld && bond + bondYield - infl > 0.03) {
    const target = infl + 0.015 - bondYield;
    out.push(
      f(
        "BOND_RETURNS_HIGH",
        "warning",
        "Bond returns look optimistic",
        `Bonds are assumed to return ${fmtPercent(bond + bondYield - infl)} a year above inflation; about 1-2% is a more typical long-run figure.`,
        {
          evidence: [{ source: "plan", path: "/assumptions/bondReturn", value: bond }],
          fix: {
            description: `Example change: set bond price return to ${fmtPercent(target)}`,
            patch: [
              {
                op: "replace",
                path: "/assumptions/bondReturn",
                value: { kind: "fixed", rate: target },
              },
            ],
          },
        },
      ),
    );
  }
  const cash = fixed(a.cashReturn);
  if (cash !== null && infl !== null && cash - infl > 0.02)
    out.push(
      f(
        "CASH_RETURNS_HIGH",
        "warning",
        "Cash returns look optimistic",
        `Cash is assumed to earn ${fmtPercent(cash - infl)} above inflation every year; over long periods cash has roughly matched inflation.`,
        {
          evidence: [{ source: "plan", path: "/assumptions/cashReturn", value: cash }],
          fix: {
            description: `Example change: set cash return to ${fmtPercent(infl)}`,
            patch: [
              {
                op: "replace",
                path: "/assumptions/cashReturn",
                value: { kind: "fixed", rate: infl },
              },
            ],
          },
        },
      ),
    );

  // --- Inflation.
  if (infl !== null && infl < 0.02)
    out.push(
      f(
        "INFLATION_LOW",
        infl <= 0 ? "critical" : "warning",
        "Inflation looks too low",
        `Inflation is set to ${fmtPercent(infl)}, below the 2% target the Bank of England and the Federal Reserve aim for (and long-run averages nearer 3%). Low inflation flatters every plan that holds cash or has fixed incomes.`,
        {
          evidence: [{ source: "plan", path: "/assumptions/inflation", value: infl }],
          fix: {
            description: "Example change: set inflation to 2.5%",
            patch: [
              {
                op: "replace",
                path: "/assumptions/inflation",
                value: { kind: "fixed", rate: 0.025 },
              },
            ],
          },
        },
      ),
    );
  else if (infl !== null && infl > 0.06)
    out.push(
      f(
        "INFLATION_HIGH",
        "info",
        "Inflation is set high",
        `Inflation of ${fmtPercent(infl)} a year for the whole plan is well above long-run averages. That is fine as a stress test, but not as a central case.`,
        { evidence: [{ source: "plan", path: "/assumptions/inflation", value: infl }] },
      ),
    );

  // --- Life expectancy.
  const lifeMs = plan.milestones.filter((x) => x.kind === "life-expectancy" && x.enabled);
  for (const p of household.people) {
    const ms =
      lifeMs.find((x) => x.personId === p.id) ??
      lifeMs.find((x) => x.criteria.some((c) => c.kind === "age" && c.personId === p.id));
    if (!ms) {
      if (a.end.kind === "lastLifeExpectancy")
        out.push(
          f(
            "LIFE_EXPECTANCY_MISSING",
            "warning",
            `No life expectancy for ${p.name}`,
            `${p.name} has no life-expectancy milestone, so the plan runs for the maximum ${a.maxYears} years instead of to a planning age.`,
            {
              refs: [p.id],
              fix: {
                description: `Example change: add a life expectancy of 95 for ${p.name}`,
                patch: [
                  {
                    op: "add",
                    path: "/milestones/-",
                    value: {
                      id: `ms-le-${p.id}`.slice(0, 64),
                      name: `${p.name} life expectancy`,
                      kind: "life-expectancy",
                      personId: p.id,
                      builtIn: true,
                      criteria: [{ kind: "age", personId: p.id, age: 95, when: "at" }],
                    },
                  },
                ],
              },
            },
          ),
        );
      continue;
    }
    const c = ms.criteria.length === 1 ? ms.criteria[0] : undefined;
    if (c?.kind === "age" && c.age < 90) {
      out.push(
        f(
          "LIFE_EXPECTANCY_SHORT",
          c.age < 85 ? "warning" : "info",
          `Planning horizon for ${p.name} is short`,
          `The plan assumes ${p.name} lives to ${c.age}. Average life expectancy understates how long many people live: roughly 1 in 4 people now aged 65 reach 95. Planning to 95 avoids running out in your 90s.`,
          {
            refs: [ms.id, p.id],
            evidence: [
              { source: "plan", path: `/milestones/[id=${ms.id}]/criteria/0/age`, value: c.age },
            ],
            fix: {
              description: `Example change: run the plan to age 95 for ${p.name}`,
              patch: [
                { op: "replace", path: `/milestones/[id=${ms.id}]/criteria/0/age`, value: 95 },
              ],
            },
          },
        ),
      );
    }
  }

  // --- State Pension / Social Security.
  const country = household.location.country;
  const benefitTypes: Record<string, string[]> = {
    GB: ["state-pension"],
    US: ["social-security"],
    CA: ["ca-cpp", "ca-oas"],
  };
  const needed = benefitTypes[country];
  if (needed) {
    for (const p of household.people) {
      const has = plan.income.some(
        (i) => i.enabled && (i.owner === p.id || i.owner === "joint") && needed.includes(i.type),
      );
      if (has) continue;
      const label =
        country === "GB" ? "State Pension" : country === "US" ? "Social Security" : "CPP/OAS";
      const fix: Finding["fix"] =
        country === "GB"
          ? {
              description: `Example change: add a full new State Pension (${m(ukYear(input).statePension.fullNewWeekly * 52)} a year in today's money) for ${p.name} from age ${spaFor(p.birthMonth)}; the figure from a GOV.UK forecast would replace it`,
              patch: [
                {
                  op: "add",
                  path: "/income/-",
                  value: {
                    id: `inc-sp-${p.id}`.slice(0, 64),
                    type: "state-pension",
                    name: `${p.name} State Pension`,
                    owner: p.id,
                    country: "GB",
                    amount: { value: ukYear(input).statePension.fullNewWeekly, basis: "real" },
                    frequency: "weekly",
                    range: {
                      start: {
                        kind: "age",
                        personId: p.id,
                        age: spaFor(p.birthMonth),
                        offsetMonths: 0,
                      },
                      end: { kind: "planEnd", offsetMonths: 0 },
                    },
                  },
                },
              ],
            }
          : undefined;
      out.push(
        f(
          "STATE_PENSION_MISSING",
          "warning",
          `No ${label} for ${p.name}`,
          `${p.name} has no ${label} income. For most people this is a large, inflation-linked income in later life; leaving it out makes the plan look much worse than it is (or hides that you are relying on it).`,
          {
            refs: [p.id],
            ...(fix
              ? { fix }
              : {
                  suggestion: `${label} is not in this plan; an official benefit estimate gives the figure.`,
                }),
          },
        ),
      );
    }
  }

  // --- Healthcare / care costs late in life.
  const primary = household.people.find((p) => p.role === "primary")!;
  const isCare = (e: ExpenseEvent) =>
    e.type === "healthcare" || /care|health|medical|nursing/i.test(e.name);
  const runsLate = (end: DateRef) =>
    end.kind === "planEnd" ||
    end.kind === "never" ||
    (end.kind === "age" && end.age >= 80) ||
    (end.kind === "date" && parseMonth(end.date) >= parseMonth(primary.birthMonth) + 80 * 12);
  const lastAge = Math.max(
    ...lifeMs.flatMap((x) =>
      x.criteria.filter((c) => c.kind === "age").map((c) => (c as { age: number }).age),
    ),
    0,
  );
  if (
    (lastAge === 0 || lastAge >= 80) &&
    !enabledExpenses.some((e) => isCare(e) && runsLate(e.range.end))
  ) {
    const amount = Math.round(Math.max(5_000, 0.15 * essentialAnnual) / 100) * 100;
    const youngest = [...household.people].sort((x, y) =>
      x.birthMonth < y.birthMonth ? 1 : -1,
    )[0]!;
    out.push(
      f(
        "LATE_LIFE_CARE_MISSING",
        "warning",
        "No healthcare or care costs late in life",
        "Nothing in the plan pays for health or care costs in your 80s and 90s. These tend to rise faster than inflation and are a common reason late-life plans fail.",
        {
          suggestion:
            "A later-life care budget is not in this plan; one that grows faster than inflation would add that cost to the projection.",
          fix: {
            description: `Example change: add later-life care of ${m(amount)} a year from age 80, growing 2% above inflation`,
            patch: [
              {
                op: "add",
                path: "/expenses/-",
                value: {
                  id: "exp-later-life-care",
                  type: "healthcare",
                  name: "Later-life care",
                  owner: "joint",
                  amount: { value: amount, basis: "real" },
                  frequency: "yearly",
                  range: {
                    start: { kind: "age", personId: youngest.id, age: 80, offsetMonths: 0 },
                    end: { kind: "planEnd", offsetMonths: 0 },
                  },
                  change: { kind: "inflation", plus: 0.02 },
                  spendingType: "essential",
                },
              },
            ],
          },
        },
      ),
    );
  }

  // --- Housing double counting.
  const homes = fin.realAssets
    .filter((r) => !r.archived && !excluded.has(r.id))
    .map((r) => ({ r, b: { ...r.behaviour, ...(plan.realAssetSettings[r.id] ?? {}) } }));
  const housing = enabledExpenses.filter(
    (e) =>
      e.type === "housing" ||
      /mortgage|rent\b|council tax|property tax|home insurance/i.test(e.name),
  );
  for (const { r, b } of homes.filter((h) => h.b.usage === "primary-residence")) {
    const costs: string[] = [];
    if (r.loan && r.loan.balance > 0)
      costs.push(`mortgage payments of ${m(r.loan.monthlyPayment.value)} a month`);
    if (b.propertyTax && b.propertyTax.cost.kind !== "none") costs.push("property tax");
    if (b.maintenance.kind !== "none") costs.push("maintenance");
    if (b.insurance.kind !== "none") costs.push("insurance");
    if (costs.length === 0 || housing.length === 0) continue;
    for (const e of housing)
      out.push(
        f(
          "HOUSING_DOUBLE_COUNTED",
          "warning",
          "Housing costs may be counted twice",
          `${r.name} already generates ${costs.join(", ")}, and the expense "${e.name}" (${m(annual(e))} a year) looks like the same costs. Counting them twice makes the plan look far worse than it is.`,
          {
            refs: [r.id, e.id],
            evidence: [
              { source: "plan", asset: r.id, costs },
              { source: "plan", path: `/expenses/[id=${e.id}]`, annual: annual(e) },
            ],
            fix: {
              description: `Example change: disable the "${e.name}" expense`,
              patch: [{ op: "replace", path: `/expenses/[id=${e.id}]/enabled`, value: false }],
            },
          },
        ),
      );
  }

  // --- Essential expenses that stop at retirement.
  const retirement = plan.milestones.find((x) => x.kind === "retirement" && x.enabled);
  if (retirement) {
    const endsAtRet = enabledExpenses.filter(
      (e) =>
        e.spendingType !== "discretionary" &&
        (e.type === "living" || e.type === "housing") &&
        e.range.end.kind === "milestone" &&
        e.range.end.milestoneId === retirement.id,
    );
    const startsAfter = enabledExpenses.some(
      (e) =>
        (e.type === "living" || e.type === "housing" || e.type === "other") &&
        e.range.start.kind === "milestone" &&
        e.range.start.milestoneId === retirement.id,
    );
    if (endsAtRet.length > 0 && !startsAfter)
      for (const e of endsAtRet)
        out.push(
          f(
            "EXPENSES_END_AT_RETIREMENT",
            "warning",
            `"${e.name}" stops at retirement`,
            `"${e.name}" (${m(annual(e))} a year) ends at ${retirement.name} and nothing replaces it, so retirement looks almost free. Most people's spending falls only modestly when they stop work.`,
            {
              refs: [e.id, retirement.id],
              fix: {
                description: `Example change: keep "${e.name}" running to the end of the plan`,
                patch: [
                  {
                    op: "replace",
                    path: `/expenses/[id=${e.id}]/range/end`,
                    value: { kind: "planEnd", offsetMonths: 0 },
                  },
                ],
              },
            },
          ),
        );
  }

  // --- Emergency buffer.
  const cashBalance = accounts
    .filter((x) => ACCOUNT_TYPE_INFO[x.type].drawdown === "cash" && "balance" in x)
    .reduce((s, x) => s + x.balance, 0);
  if (essentialAnnual > 0 && cashBalance < (3 * essentialAnnual) / 12) {
    const target = Math.round((6 * essentialAnnual) / 12 / 100) * 100;
    const cashAcct = fin.accounts.find(
      (x) => !x.archived && ACCOUNT_TYPE_INFO[x.type].drawdown === "cash",
    );
    out.push(
      f(
        "EMERGENCY_BUFFER_LOW",
        cashBalance <= 0 ? "critical" : "warning",
        cashBalance <= 0 ? "No emergency fund" : "Emergency fund is thin",
        `You hold ${m(cashBalance)} in cash against essential spending of ${m(essentialAnnual / 12)} a month: ${(cashBalance / (essentialAnnual / 12)).toFixed(1)} months. Three to six months avoids selling investments at a bad time or borrowing.`,
        {
          evidence: [
            { source: "finances", cash: cashBalance, essentialMonthly: essentialAnnual / 12 },
          ],
          ...(cashAcct
            ? {
                fix: {
                  description: `Example change: build ${cashAcct.name} up to ${m(target)} (six months) first`,
                  patch: [
                    {
                      op: "add",
                      path: "/flows/0",
                      value: {
                        kind: "contribution",
                        id: "fl-emergency-fund",
                        name: "Emergency fund",
                        owner: cashAcct.owner,
                        accountId: cashAcct.id,
                        range: {
                          start: { kind: "planStart", offsetMonths: 0 },
                          end: { kind: "planEnd", offsetMonths: 0 },
                        },
                        strategy: { kind: "target", target: { value: target, basis: "real" } },
                        method: { kind: "max" },
                      },
                    },
                  ],
                },
              }
            : {
                suggestion:
                  "Three to six months of essential spending in an easy-access account is a typical size for a cash buffer.",
              }),
        },
      ),
    );
  }

  // --- Concentration.
  const investable = accounts.filter(
    (x) => ACCOUNT_TYPE_INFO[x.type].drawdown !== "cash" && "balance" in x,
  );
  const invTotal = investable.reduce((s, x) => s + x.balance, 0);
  const crypto = investable
    .filter((x) => ACCOUNT_TYPE_INFO[x.type].assetClass === "crypto")
    .reduce((s, x) => s + x.balance, 0);
  if (invTotal > 0 && crypto / invTotal > 0.2)
    out.push(
      f(
        "CONCENTRATION_CRYPTO",
        "warning",
        "Heavy crypto concentration",
        `${fmtPercent(crypto / invTotal)} of your investments are in crypto, an asset that has repeatedly fallen 70-80%. A bad year could derail the plan.`,
        { evidence: [{ source: "finances", crypto, investable: invTotal }] },
      ),
    );
  const property = homes.reduce((s, h) => s + h.r.currentValue, 0);
  const totalAssets = property + invTotal + cashBalance;
  if (totalAssets > 0 && property / totalAssets > 0.75)
    out.push(
      f(
        "CONCENTRATION_PROPERTY",
        "info",
        "Most of your wealth is property",
        `${fmtPercent(property / totalAssets)} of your assets are property, which cannot pay bills unless you sell or borrow against it.`,
        { evidence: [{ source: "finances", property, totalAssets }] },
      ),
    );

  // --- Contributions above legal allowances.
  const acctById = new Map(accounts.map((x) => [x.id, x]));
  type Bucket = {
    label: string;
    limit: number;
    flows: { id: string; annual: number; per: number; value: number }[];
  };
  const buckets = new Map<string, Bucket>();
  for (const fl of plan.flows) {
    if (
      fl.kind !== "contribution" ||
      !fl.enabled ||
      fl.method.kind !== "amount" ||
      fl.limit.kind !== "none"
    )
      continue;
    if (fl.range.start.kind !== "planStart") continue;
    const acct = acctById.get(fl.accountId);
    if (!acct) continue;
    const per = fl.method.frequency === "once" ? 1 : FREQUENCY_PER_YEAR[fl.method.frequency];
    const ann = fl.method.amount.value * per;
    const owner = acct.owner;
    const add = (key: string, label: string, limit: number) => {
      const b = buckets.get(key) ?? { label, limit, flows: [] };
      b.flows.push({
        id: fl.id,
        annual: ann,
        per,
        value: fl.method.kind === "amount" ? fl.method.amount.value : 0,
      });
      buckets.set(key, b);
    };
    if (acct.type === "uk-isa" || acct.type === "uk-lisa")
      add(`isa:${owner}`, "ISA allowance", ukYear(input).isa.overall);
    if (acct.type === "uk-lisa")
      add(`lisa:${owner}`, "Lifetime ISA allowance", ukYear(input).isa.lisa);
    if (UK_PENSIONS.includes(acct.type))
      add(`ukpension:${owner}`, "pension annual allowance", ukYear(input).pensions.annualAllowance);
    if (US_WORKPLACE.includes(acct.type))
      add(`401k:${owner}`, "401(k) employee deferral limit", US_401K_DEFERRAL_LIMIT);
    if (US_IRA.includes(acct.type)) add(`ira:${owner}`, "IRA contribution limit", US_IRA_LIMIT);
  }
  for (const [key, b] of buckets) {
    const total = b.flows.reduce((s, x) => s + x.annual, 0);
    if (total <= b.limit + 1e-6) continue;
    const scale = b.limit / total;
    out.push(
      f(
        "CONTRIBUTION_ABOVE_ALLOWANCE",
        "warning",
        `Contributions exceed the ${b.label}`,
        `Planned contributions of ${m(total)} a year exceed the ${b.label} of ${m(b.limit)}. The excess would be refused or taxed, so the plan overstates tax-free savings.`,
        {
          refs: b.flows.map((x) => x.id),
          evidence: [{ source: "plan", bucket: key, total, limit: b.limit }],
          fix: {
            description: `Example change: reduce contributions to the ${m(b.limit)} limit`,
            patch: b.flows.map((x) => ({
              op: "replace",
              path: `/flows/[id=${x.id}]/method/amount/value`,
              value: x.value * scale,
            })) as PatchOp[],
          },
        },
      ),
    );
  }

  // --- Suspicious amount / frequency (the "£20k a month read as £20k a year" class of mistakes).
  for (const e of enabledExpenses) {
    if (
      (e.type === "living" || e.type === "housing") &&
      e.frequency === "yearly" &&
      e.amount.value > 0 &&
      e.amount.value < 2_400
    )
      out.push(
        f(
          "FREQUENCY_SUSPICIOUS",
          "info",
          `Is "${e.name}" monthly?`,
          `"${e.name}" is ${m(e.amount.value)} a year, which is unusually low for ${e.type} costs. Did you mean ${m(e.amount.value)} a month?`,
          {
            refs: [e.id],
            fix: {
              description: "Example change: make it monthly",
              patch: [
                { op: "replace", path: `/expenses/[id=${e.id}]/frequency`, value: "monthly" },
              ],
            },
          },
        ),
      );
    if (e.frequency === "monthly" && e.amount.value > 25_000)
      out.push(
        f(
          "FREQUENCY_SUSPICIOUS",
          "info",
          `Is "${e.name}" yearly?`,
          `"${e.name}" is ${m(e.amount.value)} a month (${m(e.amount.value * 12)} a year). Did you mean a year?`,
          {
            refs: [e.id],
            fix: {
              description: "Example change: make it yearly",
              patch: [{ op: "replace", path: `/expenses/[id=${e.id}]/frequency`, value: "yearly" }],
            },
          },
        ),
      );
  }
  for (const i of plan.income.filter((x) => x.enabled))
    if (
      (i.type === "salary" || i.type === "self-employment") &&
      i.frequency === "monthly" &&
      i.amount.value > 50_000
    )
      out.push(
        f(
          "FREQUENCY_SUSPICIOUS",
          "info",
          `Is "${i.name}" yearly?`,
          `"${i.name}" is ${m(i.amount.value)} a month (${m(i.amount.value * 12)} a year). Did you mean a year?`,
          {
            refs: [i.id],
            fix: {
              description: "Example change: make it yearly",
              patch: [{ op: "replace", path: `/income/[id=${i.id}]/frequency`, value: "yearly" }],
            },
          },
        ),
      );

  // --- Real / nominal mix-ups.
  for (const e of [...enabledExpenses, ...plan.income.filter((x) => x.enabled)]) {
    const isExpense = plan.expenses.includes(e as ExpenseEvent);
    const base = isExpense ? "expenses" : "income";
    if (
      e.amount.basis === "nominal" &&
      e.range.start.kind === "date" &&
      parseMonth(e.range.start.date) - start >= 60
    )
      out.push(
        f(
          "NOMINAL_FUTURE_AMOUNT",
          "info",
          `"${e.name}" is in future money`,
          `"${e.name}" (${m(e.amount.value)}) starts in ${e.range.start.date} and is entered in future (nominal) money, so after inflation it is worth noticeably less in today's money. If you meant today's prices, switch it to today's money.`,
          {
            refs: [e.id],
            fix: {
              description: "Example change: treat the amount as today's money",
              patch: [{ op: "replace", path: `/${base}/[id=${e.id}]/amount/basis`, value: "real" }],
            },
          },
        ),
      );
    if (
      isExpense &&
      e.change.kind === "none" &&
      e.frequency !== "once" &&
      (e as ExpenseEvent).spendingType === "essential" &&
      (e.range.end.kind === "planEnd" || e.range.end.kind === "never")
    )
      out.push(
        f(
          "EXPENSE_NOT_INFLATING",
          "info",
          `"${e.name}" never rises with inflation`,
          `"${e.name}" stays fixed in cash terms for the whole plan, so in real terms it shrinks by about half over 25 years at 2.5% inflation. Essential costs usually rise with prices.`,
          {
            refs: [e.id],
            fix: {
              description: "Example change: grow it with inflation",
              patch: [
                {
                  op: "replace",
                  path: `/expenses/[id=${e.id}]/change`,
                  value: { kind: "inflation", plus: 0 },
                },
              ],
            },
          },
        ),
      );
  }

  // --- Surplus with nowhere to go.
  const earns = plan.income.some(
    (i) => i.enabled && ["salary", "hourly", "self-employment"].includes(i.type),
  );
  const contributes = plan.flows.some(
    (x) =>
      x.enabled &&
      x.kind === "contribution" &&
      ACCOUNT_TYPE_INFO[acctById.get(x.accountId)?.type ?? "cash"].drawdown !== "cash",
  );
  if (earns && !contributes && plan.leftover.kind === "save") {
    const target =
      accounts.find((x) => ACCOUNT_TYPE_INFO[x.type].drawdown === "tax-free") ??
      accounts.find((x) => ACCOUNT_TYPE_INFO[x.type].drawdown === "taxable");
    out.push(
      f(
        "NO_SAVINGS_FLOWS",
        "info",
        "Surplus piles up in cash",
        "You earn but have no flows into investment accounts, so any surplus stays in cash and barely keeps up with inflation.",
        {
          ...(target
            ? {
                fix: {
                  description: `Example change: add the surplus as a contribution to ${target.name}`,
                  patch: [
                    {
                      op: "add",
                      path: "/flows/-",
                      value: {
                        kind: "contribution",
                        id: "fl-invest-surplus",
                        name: "Invest the surplus",
                        owner: target.owner,
                        accountId: target.id,
                        range: {
                          start: { kind: "planStart", offsetMonths: 0 },
                          end: { kind: "planEnd", offsetMonths: 0 },
                        },
                        method: { kind: "percentOfRemaining", share: 1 },
                      },
                    },
                  ],
                },
              }
            : {}),
        },
      ),
    );
  }

  if (opts.result) out.push(...resultChecks(input, opts.result));
  out.push(...crossBorderFindings(input, opts.result));
  const rank: Record<Sev, number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((x, y) => rank[x.severity] - rank[y.severity]);
}

function resultChecks(input: SimulationInput, r: ProjectionResult): Finding[] {
  const out: Finding[] = [];
  const m = (v: number) =>
    fmtMoney(v, { currency: input.household.currency, locale: input.household.locale });
  const pens = r.warnings.filter((w) => w.code === "EARLY_WITHDRAWAL_PENALTY");
  if (pens.length > 0)
    out.push(
      f(
        "EARLY_WITHDRAWAL_PENALTY",
        "warning",
        "Penalised early withdrawals",
        `The plan draws on retirement accounts before their qualifying age in ${pens.length} year${pens.length === 1 ? "" : "s"}, paying penalties.`,
        {
          refs: [...new Set(pens.flatMap((w) => w.refs))],
          periodIndex: pens[0]!.periodIndex,
          evidence: pens.slice(0, 5).map((w) => ({ source: "warning", ...w })),
          suggestion:
            "Accessible accounts later in the drawdown order leave a gap before pensions pay; drawing them earlier, or bridging with savings, would close it.",
        },
      ),
    );
  const retIdx =
    r.milestones.find(
      (x) => input.plan.milestones.find((y) => y.id === x.milestoneId)?.kind === "retirement",
    )?.periodIndex ?? null;
  for (let i = 1; i < r.periods.length; i++) {
    const a = r.periods[i - 1]!;
    const b = r.periods[i]!;
    if (a.months < 12 || b.months < 12) continue;
    const sa = toBasis(a.totals.spending, a, "real", "flow");
    const sb = toBasis(b.totals.spending, b, "real", "flow");
    if (sa > 0 && sb < 0.7 * sa && (retIdx === null || Math.abs(i - retIdx) > 1)) {
      const ended = a.expenses.filter(
        (e) =>
          e.requested > 0 && !b.expenses.some((x) => x.sourceId === e.sourceId && x.requested > 0),
      );
      out.push(
        f(
          "SPENDING_DROP",
          "info",
          `Spending drops sharply in ${b.year}`,
          `Spending falls from ${m(sa)} to ${m(sb)} (today's money) in ${b.year}${ended.length ? `, when ${ended.map((e) => `"${e.label}"`).join(", ")} stop${ended.length === 1 ? "s" : ""}` : ""}. Check this is intended.`,
          {
            periodIndex: i,
            refs: ended.map((e) => e.sourceId),
            evidence: [
              { source: "period", periodIndex: i - 1, spending: a.totals.spending },
              { source: "period", periodIndex: i, spending: b.totals.spending },
            ],
          },
        ),
      );
      break;
    }
  }
  let run = 0;
  for (const p of r.periods) {
    const spend = p.totals.spending || p.totals.expenses;
    if (spend > 0 && p.totals.cash > 3 * spend && p.market.cash < p.market.inflation) run += 1;
    else run = 0;
    if (run >= 5) {
      out.push(
        f(
          "CASH_DRAG",
          "info",
          "Large cash balance losing value",
          `By ${p.year} cash has exceeded three years of spending for five years while earning less than inflation (${m(p.totals.cash / p.priceIndex)} in today's money).`,
          {
            periodIndex: p.index,
            evidence: [
              { source: "period", periodIndex: p.index, cash: p.totals.cash, spending: spend },
            ],
          },
        ),
      );
      break;
    }
  }
  const startIdx = retIdx ?? 0;
  const early = r.periods
    .slice(startIdx, startIdx + 5)
    .filter((p) => (p.totals.withdrawalRate ?? 0) > 0.05);
  if (early.length > 0) {
    const worst = early.reduce((x, y) =>
      (x.totals.withdrawalRate ?? 0) > (y.totals.withdrawalRate ?? 0) ? x : y,
    );
    out.push(
      f(
        "WITHDRAWAL_RATE_HIGH",
        "warning",
        "High early withdrawal rate",
        `In ${worst.year} the plan withdraws ${fmtPercent(worst.totals.withdrawalRate ?? 0)} of the portfolio. Rates above 4-5% early in retirement are vulnerable to a bad sequence of returns.`,
        {
          periodIndex: worst.index,
          evidence: [
            {
              source: "period",
              periodIndex: worst.index,
              withdrawalRate: worst.totals.withdrawalRate,
            },
          ],
        },
      ),
    );
  }
  return out;
}
