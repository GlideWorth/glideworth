/**
 * What-if templates (market crash, job loss, retire earlier, survivor...) from @glideworth/core.
 *
 * A template turns a few parameters into a plan patch (`ScenarioTemplate.patch`). The API can show
 * what it would do (diff + before/after, nothing stored) or store it as a branch of the plan, which
 * leaves the parent untouched.
 */
import {
  type Actor,
  careerBreakScenario,
  childScenario,
  downsizingScenario,
  earlyRetirementScenario,
  inheritanceScenario,
  jobLossScenario,
  longTermCareScenario,
  marketCrashScenario,
  type Plan,
  type ScenarioTemplate,
  type SimulationInput,
  survivorScenario,
  WHAT_IF_TEMPLATES,
} from "@glideworth/core";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { outcomeOf } from "../views.js";
import type { ServiceCtx } from "./context.js";
import type { PlansService } from "./plans.js";
import type { SimulationService } from "./simulation.js";

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM");
const Id = z.string().min(1).max(64);

interface TemplateDef {
  params: z.ZodObject;
  run: (input: SimulationInput, p: never) => ScenarioTemplate;
}
const def = <S extends z.ZodObject>(
  params: S,
  run: (input: SimulationInput, p: z.infer<S>) => ScenarioTemplate,
) => ({ params, run }) as unknown as TemplateDef;

/** Parameter schemas and builders, keyed by the ids in core's `WHAT_IF_TEMPLATES`. */
export const TEMPLATES: Record<string, TemplateDef> = {
  "market-crash": def(
    z.object({
      year: z.number().int().describe("Calendar year the crash starts."),
      drop: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Fall in stock prices, 0..1 (default 0.3)."),
    }),
    (i, p) =>
      marketCrashScenario(i, { year: p.year, ...(p.drop !== undefined ? { drop: p.drop } : {}) }),
  ),
  "job-loss": def(
    z.object({
      incomeId: Id.describe("Income id from get_plan."),
      start: Month,
      months: z.number().int().min(1).max(600),
    }),
    (i, p) => jobLossScenario(i, p),
  ),
  "career-break": def(
    z.object({
      personId: Id.optional().describe("Default: the primary person."),
      start: Month,
      months: z.number().int().min(1).max(600),
      share: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Share of income kept, 0..1 (default 0)."),
    }),
    (i, p) =>
      careerBreakScenario(i, {
        start: p.start,
        months: p.months,
        ...(p.personId ? { personId: p.personId } : {}),
        ...(p.share !== undefined ? { share: p.share } : {}),
      }),
  ),
  "early-retirement": def(
    z.object({
      years: z.number().positive().max(40).describe("How many years earlier."),
      milestoneId: Id.optional().describe(
        "Retirement milestone id (default: the plan retirement milestone).",
      ),
    }),
    (i, p) =>
      earlyRetirementScenario(i, {
        years: p.years,
        ...(p.milestoneId ? { milestoneId: p.milestoneId } : {}),
      }),
  ),
  downsizing: def(
    z.object({
      month: Month,
      equityReleased: z.number().min(0).describe("Cash released, major currency units."),
      housingCut: z
        .number()
        .min(0)
        .optional()
        .describe("Yearly housing cost saved, major currency units."),
    }),
    (i, p) =>
      downsizingScenario(i, {
        month: p.month,
        equityReleased: p.equityReleased,
        ...(p.housingCut !== undefined ? { housingCut: p.housingCut } : {}),
      }),
  ),
  child: def(
    z.object({
      birthMonth: Month,
      annualCost: z.number().min(0),
      childcareAnnual: z.number().min(0).optional(),
    }),
    (i, p) =>
      childScenario(i, {
        birthMonth: p.birthMonth,
        annualCost: p.annualCost,
        ...(p.childcareAnnual !== undefined ? { childcareAnnual: p.childcareAnnual } : {}),
      }),
  ),
  inheritance: def(
    z.object({ month: Month, amount: z.number().min(0), taxable: z.boolean().optional() }),
    (i, p) =>
      inheritanceScenario(i, {
        month: p.month,
        amount: p.amount,
        ...(p.taxable !== undefined ? { taxable: p.taxable } : {}),
      }),
  ),
  "long-term-care": def(
    z.object({
      personId: Id.optional(),
      fromAge: z.number().min(30).max(120),
      annualCost: z.number().min(0),
      years: z.number().positive().max(40).optional(),
    }),
    (i, p) =>
      longTermCareScenario(i, {
        fromAge: p.fromAge,
        annualCost: p.annualCost,
        ...(p.personId ? { personId: p.personId } : {}),
        ...(p.years !== undefined ? { years: p.years } : {}),
      }),
  ),
  survivor: def(
    z.object({ personId: Id.describe("Who dies."), age: z.number().min(30).max(120) }),
    (i, p) => survivorScenario(i, p),
  ),
};

export class ScenariosService {
  constructor(
    private readonly ctx: ServiceCtx,
    private readonly plans: PlansService,
    private readonly sim: SimulationService,
  ) {}

  /** The catalogue: id, title and the parameters each template takes (JSON Schema). */
  list() {
    return WHAT_IF_TEMPLATES.map((t) => ({
      ...t,
      paramsSchema: TEMPLATES[t.id]
        ? cleanSchema(z.toJSONSchema(TEMPLATES[t.id]!.params))
        : undefined,
    }));
  }

  /** Build the patch for a template against a stored plan. */
  instantiate(planId: string, templateId: string, params: unknown) {
    const t = TEMPLATES[templateId];
    if (!t)
      throw new ApiError(404, "NOT_FOUND", `unknown what-if template '${templateId}'`, {
        known: Object.keys(TEMPLATES),
      });
    const parsed = t.params.safeParse(params ?? {});
    if (!parsed.success)
      throw new ApiError(
        400,
        "VALIDATION",
        `invalid parameters for '${templateId}': ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".") || "(params)"}: ${i.message}`)
          .join("; ")}`,
        parsed.error.issues,
      );
    const { input, plan } = this.sim.inputFor(planId, { trace: "off" });
    return { plan, template: t.run(input, parsed.data as never) };
  }

  /** What the scenario would do to the plan, deterministically. Stores nothing. */
  preview(planId: string, templateId: string, params: unknown) {
    return this.previewWithResults(planId, templateId, params).out;
  }

  /** `preview`, plus the before/after projections its outcomes come from (the chat widgets chart them). */
  previewWithResults(planId: string, templateId: string, params: unknown) {
    const { template } = this.instantiate(planId, templateId, params);
    const out = this.sim.preview(planId, template.patch);
    const body = {
      planId,
      planVersion: out.plan.version,
      template: {
        id: template.id,
        title: template.title,
        description: template.description,
        notes: template.notes,
      },
      ops: template.patch,
      changes: out.diff.changes.map((c) => c.description),
      ...(out.preview ? { before: out.preview.before, after: out.preview.after } : {}),
    };
    return { out: body, results: out.results };
  }

  /** Store the scenario as a branch of the plan (the parent is untouched). */
  createBranch(
    planId: string,
    templateId: string,
    params: unknown,
    o: { name?: string | undefined; pinParentVersion?: boolean | undefined },
    actor: Actor,
  ): { branch: Plan; template: ScenarioTemplate } {
    const { template } = this.instantiate(planId, templateId, params);
    const branch = this.plans.createBranch(
      planId,
      {
        name: o.name ?? template.title,
        description: template.description,
        patch: template.patch,
        pinParentVersion: o.pinParentVersion ?? false,
      },
      actor,
    );
    return { branch, template };
  }

  /**
   * "What if one partner dies at 70 / 80 / 90?" for each partner. `evaluate` also runs each
   * scenario deterministically and reports before/after outcomes.
   */
  survivors(planId: string, o: { ages?: number[] | undefined; evaluate: boolean }) {
    const { input, plan } = this.sim.inputFor(planId, { trace: "off" });
    const scenarios = this.ctx.deps.survivorScenarios(input, o.ages ? { ages: o.ages } : {});
    const base = o.evaluate
      ? outcomeOf(this.sim.projection(planId, { trace: "off" }).result)
      : undefined;
    return {
      planId,
      planVersion: plan.version,
      scenarios: scenarios.map((s) => {
        const evaluated = o.evaluate ? this.sim.preview(planId, s.patch) : undefined;
        return {
          id: s.id,
          title: s.title,
          description: s.description,
          notes: s.notes,
          ops: s.patch,
          ...(evaluated?.preview ? { before: base, after: evaluated.preview.after } : {}),
        };
      }),
    };
  }
}

/** Drop the ±2^53 bounds zod adds to every integer: they are noise for an agent reading the schema. */
function cleanSchema<T>(schema: T): T {
  return JSON.parse(
    JSON.stringify(schema, (k, v) =>
      (k === "minimum" || k === "maximum") &&
      typeof v === "number" &&
      Math.abs(v) >= Number.MAX_SAFE_INTEGER
        ? undefined
        : v,
    ),
  );
}
