/**
 * Core what-if templates (market crash, job loss, career break, retire earlier, downsize, child,
 * inheritance, long-term care) and survivor scenarios, each with sensible defaults derived from the
 * plan, built as plan patches by @glideworth/core. Failures are returned per template, never thrown, so one
 * template the plan cannot support never hides the others.
 */
import {
  applyPlanPatch,
  careerBreakScenario,
  childScenario,
  downsizingScenario,
  earlyRetirementScenario,
  FREQUENCY_PER_YEAR,
  formatMonth,
  inheritanceScenario,
  jobLossScenario,
  longTermCareScenario,
  marketCrashScenario,
  type ProjectionResult,
  parseMonth,
  type ScenarioTemplate,
  type SimulationInput,
  survivorScenarios,
} from "@glideworth/core";
import type { Variant } from "./plan-edits";

export interface BuiltTemplate {
  id: string;
  group: string;
  template: ScenarioTemplate | null;
  error?: string;
  fallbackTitle: string;
}

const round = (v: number, to: number) => Math.max(to, Math.round(v / to) * to);

function annualSpending(input: SimulationInput): number {
  return input.plan.expenses
    .filter((e) => e.enabled && e.spendingType !== "not-spending" && e.frequency !== "once")
    .reduce((s, e) => s + e.amount.value * FREQUENCY_PER_YEAR[e.frequency], 0);
}

export function buildTemplates(input: SimulationInput, base: ProjectionResult): BuiltTemplate[] {
  const start = parseMonth(
    input.plan.startingConditions.kind === "snapshot"
      ? input.plan.startingConditions.finances.asOf
      : input.finances.asOf,
  );
  const at = (months: number) => formatMonth(start + months);
  const spend = annualSpending(input) || 30_000;
  const first = base.periods[0]!;
  const retireIdx = Math.max(
    0,
    base.periods.findIndex((p) => p.year === base.summary.retirementYear),
  );
  const earner = input.plan.income.find(
    (i) => i.enabled && ["salary", "hourly", "self-employment"].includes(i.type),
  );
  const home = input.finances.realAssets.find((a) => a.behaviour.usage === "primary-residence");
  const netWorth = Math.max(0, first.totals.netWorth);
  const primary =
    input.household.people.find((p) => p.role === "primary") ?? input.household.people[0]!;
  const list: { id: string; group: string; title: string; make: () => ScenarioTemplate }[] = [
    {
      id: "market-crash",
      group: "Markets",
      title: "Market crash",
      make: () =>
        marketCrashScenario(input, {
          year: base.periods[Math.min(retireIdx + 1, base.periods.length - 1)]!.year,
          drop: 0.3,
        }),
    },
    {
      id: "job-loss",
      group: "Work",
      title: "Job loss",
      make: () => {
        if (!earner) throw new Error("This plan has no salary or self-employment income to pause.");
        return jobLossScenario(input, { incomeId: earner.id, start: at(12), months: 12 });
      },
    },
    {
      id: "career-break",
      group: "Work",
      title: "Career break",
      make: () =>
        careerBreakScenario(input, { personId: primary.id, start: at(24), months: 12, share: 0 }),
    },
    {
      id: "early-retirement",
      group: "Work",
      title: "Retire earlier",
      make: () => earlyRetirementScenario(input, { years: 3 }),
    },
    {
      id: "downsizing",
      group: "Life events",
      title: "Downsize your home",
      make: () => {
        if (!home) throw new Error("This plan has no primary residence to downsize.");
        return downsizingScenario(input, {
          month: at(Math.max(12, (retireIdx + 3) * 12)),
          equityReleased: round(
            Math.max(0, home.currentValue - (home.loan?.balance ?? 0)) * 0.3,
            1000,
          ),
          housingCut: 0.3,
        });
      },
    },
    {
      id: "child",
      group: "Life events",
      title: "Have a child",
      make: () =>
        childScenario(input, {
          birthMonth: at(18),
          annualCost: round(spend * 0.12, 500),
          childcareAnnual: round(spend * 0.2, 500),
        }),
    },
    {
      id: "inheritance",
      group: "Life events",
      title: "Receive an inheritance",
      make: () =>
        inheritanceScenario(input, { month: at(60), amount: round(netWorth * 0.1, 5000) }),
    },
    {
      id: "long-term-care",
      group: "Life events",
      title: "Long-term care",
      make: () =>
        longTermCareScenario(input, {
          personId: primary.id,
          fromAge: 82,
          annualCost: round(spend * 0.6, 1000),
          years: 5,
        }),
    },
  ];
  const out: BuiltTemplate[] = list.map((t) => {
    try {
      return { id: t.id, group: t.group, template: t.make(), fallbackTitle: t.title };
    } catch (e) {
      return {
        id: t.id,
        group: t.group,
        template: null,
        error: e instanceof Error ? e.message : String(e),
        fallbackTitle: t.title,
      };
    }
  });
  return out;
}

export function buildSurvivorTemplates(input: SimulationInput): BuiltTemplate[] {
  try {
    return survivorScenarios(input).map((t) => ({
      id: t.id,
      group: "Survivor",
      template: t,
      fallbackTitle: t.title,
    }));
  } catch (e) {
    return [
      {
        id: "survivor",
        group: "Survivor",
        template: null,
        error: e instanceof Error ? e.message : String(e),
        fallbackTitle: "Survivor scenarios",
      },
    ];
  }
}

/** A template as a previewable variant (plan with the patch applied). Throws when the patch is invalid. */
export function variantOf(input: SimulationInput, t: ScenarioTemplate): Variant {
  const plan = applyPlanPatch(input.plan, t.patch);
  return { plan, changes: [t.description, ...t.notes] };
}
