/**
 * Plan templates. Each builds a complete, valid Plan for THIS household (its people, accounts and
 * country), so a new plan simulates immediately and teaches by example. Amounts are editable
 * starting points, never anyone's real data.
 */
import {
  ACCOUNT_TYPE_INFO,
  type CurrentFinances,
  type Household,
  Plan,
  type PlanInput,
} from "@glideworth/core";
import { countryDefaultsFor, planSettingsFor } from "../../lib/countries";
import {
  builtInMilestones,
  type Ctx,
  newExpense,
  newFlow,
  newIncome,
  newMilestone,
} from "../plan-editor/state/defaults";

export interface PlanTemplate {
  id: string;
  name: string;
  description: string;
  build: (ctx: Ctx) => Partial<PlanInput>;
}

const primary = (h: Household) => h.people.find((p) => p.role === "primary") ?? h.people[0]!;
const partner = (h: Household) => h.people.find((p) => p.role === "partner");

/**
 * Country-native plan settings come from core (`planDefaultsForHousehold`): the country's real tax
 * rules wherever Glideworth has a preset ("estimate" mode: UK bands, allowance and NI; US federal +
 * payroll + state; Canada, Australia, Germany, the Netherlands, France, Spain, Israel, Ireland and
 * New Zealand), the tax-year alignment (UK from April, Australia from July), local inflation and the
 * historical market dataset (the country default; see core's defaultsForCountry). Flat rates are kept on the plan so
 * switching to "flat" starts from sensible numbers.
 */
const countrySettings = (h: Household): Partial<PlanInput> => planSettingsFor(h);

function savingsFlows(ctx: Ctx, plan: Plan) {
  const flows = [];
  const accounts = ctx.finances.accounts.filter((a) => !a.archived);
  const cash = accounts.find((a) => ACCOUNT_TYPE_INFO[a.type].category === "cash");
  const info = (t: (typeof accounts)[number]["type"]) => ACCOUNT_TYPE_INFO[t];
  const pension = accounts.find(
    (a) => info(a.type).category === "retirement" && info(a.type).taxTreatment === "tax-deferred",
  );
  const wrapper = accounts.find(
    (a) => info(a.type).taxTreatment === "tax-free" && info(a.type).category !== "cash",
  );
  const taxable = accounts.find(
    (a) => info(a.type).taxTreatment === "taxable" && info(a.type).category === "investment",
  );
  if (pension) {
    const f = newFlow("contribution", ctx, plan);
    if (f.kind === "contribution")
      flows.push({
        ...f,
        name: `Pension: ${pension.name}`,
        accountId: pension.id,
        owner: pension.owner,
        mandatory: true,
      });
  }
  if (cash) {
    const f = newFlow("contribution", ctx, plan);
    if (f.kind === "contribution")
      flows.push({
        ...f,
        name: "Emergency fund to 6 months",
        accountId: cash.id,
        owner: cash.owner,
        strategy: { kind: "target" as const, target: { value: 15_000, basis: "real" as const } },
        method: { kind: "max" as const },
        limit: { kind: "none" as const },
      });
  }
  if (wrapper) {
    const f = newFlow("contribution", ctx, plan);
    if (f.kind === "contribution")
      flows.push({
        ...f,
        name: `Max out ${wrapper.name}`,
        accountId: wrapper.id,
        owner: wrapper.owner,
        method: { kind: "max" as const },
        limit: { kind: "jurisdiction" as const },
      });
  }
  if (taxable) {
    const f = newFlow("contribution", ctx, plan);
    if (f.kind === "contribution")
      flows.push({
        ...f,
        name: "Invest the rest",
        accountId: taxable.id,
        owner: taxable.owner,
        method: { kind: "percentOfRemaining" as const, share: 1 },
        limit: { kind: "none" as const },
      });
  }
  return flows;
}

function stub(ctx: Ctx, retireAge?: number): Plan {
  return Plan.parse({
    id: "tmp",
    householdId: ctx.household.id,
    name: "tmp",
    milestones: builtInMilestones(ctx, retireAge),
    ...countrySettings(ctx.household),
  });
}

function statePension(ctx: Ctx, plan: Plan) {
  const type =
    countryDefaultsFor(ctx.household.location.country, ctx.household.location.region).statePension
      ?.incomeType ?? "state-pension";
  return ctx.household.people.map((p) => {
    const inc = newIncome(
      type,
      {
        ...ctx,
        // Present this person as the primary so the factory names and times it for them.
        household: { ...ctx.household, people: [{ ...p, role: "primary" as const }] },
      },
      plan,
    );
    return { ...inc, owner: p.id };
  });
}

export const PLAN_TEMPLATES: PlanTemplate[] = [
  {
    id: "blank",
    name: "Blank",
    description: "Retirement and life-expectancy milestones only. Add everything else yourself.",
    build: (ctx) => ({ milestones: builtInMilestones(ctx), ...countrySettings(ctx.household) }),
  },
  {
    id: "work-save-retire",
    name: "Work, save, retire",
    description:
      "Salary until retirement, everyday spending, state pension from pension age, and a savings waterfall into your accounts.",
    build: (ctx) => {
      const plan = stub(ctx);
      const salaries = ctx.household.people.map((p) => ({
        ...newIncome("salary", { ...ctx, household: { ...ctx.household, people: [p] } }, plan),
        owner: p.id,
      }));
      return {
        milestones: [...plan.milestones, newMilestone(ctx, "financial-independence")],
        income: [...salaries, ...statePension(ctx, plan)],
        expenses: [
          newExpense("living", ctx),
          newExpense("travel", ctx),
          newExpense("healthcare", ctx),
        ],
        flows: savingsFlows(ctx, plan),
        ...countrySettings(ctx.household),
      };
    },
  },
  {
    id: "retire-early",
    name: "Retire early",
    description:
      "Aggressive saving, retirement at 50 once investments reach 25× spending, bridging to pension access age.",
    build: (ctx) => {
      const plan = stub(ctx, 50);
      const fi = newMilestone(ctx, "financial-independence");
      return {
        milestones: [...plan.milestones, fi],
        income: [
          { ...newIncome("salary", ctx, plan), amount: { value: 60_000, basis: "real" as const } },
          ...statePension(ctx, plan),
        ],
        expenses: [
          { ...newExpense("living", ctx), amount: { value: 1_800, basis: "real" as const } },
          newExpense("travel", ctx),
        ],
        flows: savingsFlows(ctx, plan),
        leftover: { kind: "save" as const },
        ...countrySettings(ctx.household),
      };
    },
  },
  {
    id: "phased",
    name: "Phased retirement",
    description:
      "Drop to a four-day week at 55, then retire fully at 62. Shows part-time income and a gentler glide path.",
    build: (ctx) => {
      const plan = stub(ctx, 62);
      const me = primary(ctx.household);
      const salary = newIncome("salary", ctx, plan);
      return {
        milestones: plan.milestones,
        income: [
          {
            ...salary,
            partTime: {
              range: {
                start: { kind: "age" as const, personId: me.id, age: 55, offsetMonths: 0 },
                end: { kind: "milestone" as const, milestoneId: "ms-retire", offsetMonths: 0 },
                endInclusive: false,
              },
              share: 0.8,
            },
          },
          ...statePension(ctx, plan),
        ],
        expenses: [newExpense("living", ctx), newExpense("travel", ctx)],
        flows: savingsFlows(ctx, plan),
        assumptions: {
          ...(countrySettings(ctx.household).assumptions ?? {}),
          bondAllocation: {
            kind: "glidepath",
            share: 0,
            interpolation: "linear",
            distribution: "even",
            locationPriority: [],
            points: [
              { at: { kind: "planStart", offsetMonths: 0 }, value: 0.2 },
              { at: { kind: "milestone", milestoneId: "ms-retire", offsetMonths: 0 }, value: 0.5 },
            ],
          },
        },
        tax: countrySettings(ctx.household).tax,
      };
    },
  },
  {
    id: "staggered",
    name: "One of us retires first",
    description:
      "For couples: the primary retires first, the partner keeps working five more years.",
    build: (ctx) => {
      const plan = stub(ctx);
      const p2 = partner(ctx.household);
      const extra = p2
        ? [
            {
              ...newMilestone(ctx, "retirement"),
              id: "ms-retire-partner",
              name: `${p2.name} retires`,
              personId: p2.id,
              criteria: [
                {
                  kind: "milestone" as const,
                  milestoneId: "ms-retire",
                  offsetMonths: 60,
                  when: "at" as const,
                },
              ],
            },
          ]
        : [];
      const salaries = ctx.household.people.map((p) => {
        const inc = {
          ...newIncome("salary", { ...ctx, household: { ...ctx.household, people: [p] } }, plan),
          owner: p.id,
        };
        return p.role === "partner"
          ? {
              ...inc,
              range: {
                ...inc.range,
                end: {
                  kind: "milestone" as const,
                  milestoneId: "ms-retire-partner",
                  offsetMonths: 0,
                },
              },
            }
          : inc;
      });
      return {
        milestones: [...plan.milestones, ...extra],
        income: [...salaries, ...statePension(ctx, plan)],
        expenses: [newExpense("living", ctx), newExpense("travel", ctx)],
        flows: savingsFlows(ctx, plan),
        ...countrySettings(ctx.household),
      };
    },
  },
];

export function buildPlanFromTemplate(
  templateId: string,
  ctx: { household: Household; finances: CurrentFinances },
  meta: {
    id: string;
    name: string;
    description?: string;
    fixedDate?: boolean;
    appearance?: { color?: string; icon?: string };
  },
): Plan {
  const t = PLAN_TEMPLATES.find((x) => x.id === templateId) ?? PLAN_TEMPLATES[0]!;
  const body = t.build(ctx);
  return Plan.parse({
    ...body,
    id: meta.id,
    householdId: ctx.household.id,
    name: meta.name,
    description: meta.description ?? (t.id === "blank" ? undefined : t.description),
    appearance: meta.appearance,
    startingConditions: meta.fixedDate
      ? { kind: "snapshot", finances: ctx.finances }
      : { kind: "live" },
    version: 0,
  });
}
