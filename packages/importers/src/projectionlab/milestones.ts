/** Milestones (+ computed account-target milestones). */
import { table, arr, num, type Obj, obj, str } from "../util/read.js";
import { appearanceOf, basisOf, nameOf } from "./common.js";
import { approximated, infoNote, invalid, type PlContext, resolveSource } from "./context.js";
import { shiftMonths, toMonth } from "./dates.js";

const COMPARATORS = new Set([">=", ">", "<=", "<", "="]);

const METRICS: Record<string, string> = table({
  netWorth: "netWorth",
  liquidNetWorth: "liquidNetWorth",
  portfolio: "portfolio",
  portfolioValue: "portfolio",
  cash: "cash",
  totalDebt: "totalDebt",
  debt: "totalDebt",
  passiveIncome: "passiveIncome",
  income: "income",
  spending: "spending",
  expenses: "expenses",
});

const BUILTIN: Record<string, { kind: string; who: "me" | "spouse" | undefined }> = table({
  retirement: { kind: "retirement", who: "me" },
  spouseRetirement: { kind: "retirement", who: "spouse" },
  lifeExpectancy: { kind: "life-expectancy", who: "me" },
  spouseLifeExpectancy: { kind: "life-expectancy", who: "spouse" },
  fi: { kind: "financial-independence", who: undefined },
});

function personFor(ctx: PlContext, who: "me" | "spouse" | undefined): string | undefined {
  if (who === "spouse") return ctx.partnerId;
  if (who === "me") return ctx.primaryId;
  return undefined;
}

function milestoneCriterion(
  ctx: PlContext,
  raw: unknown,
  path: string,
  who: "me" | "spouse" | undefined,
): Obj | undefined {
  const c = obj(raw);
  const scope = ctx.plan!;
  const type = str(c.type);
  const exclude = c.modifier === "exclude";
  switch (type) {
    case "milestone": {
      const id = str(c.value);
      if (!id || !scope.knownMilestones.has(id)) {
        invalid(
          ctx,
          `${path}.value`,
          "criterion references a milestone that is not defined in this plan; criterion dropped",
        );
        return undefined;
      }
      return {
        kind: "milestone",
        milestoneId: scope.milestoneIds.get(id, "milestone"),
        offsetMonths: exclude ? 1 : 0,
        when: "at",
      };
    }
    case "year":
    case "date": {
      const month = toMonth(c.value);
      if (!month) {
        invalid(ctx, `${path}.value`, "unparseable date; criterion dropped");
        return undefined;
      }
      return { kind: "date", date: exclude ? shiftMonths(month, 1) : month, when: "at" };
    }
    case "age": {
      const age = num(c.value);
      if (age === undefined) {
        invalid(ctx, `${path}.value`, "age criterion without a value; dropped");
        return undefined;
      }
      return { kind: "age", personId: personFor(ctx, who) ?? ctx.primaryId, age, when: "at" };
    }
    case "account": {
      const sid = resolveSource(ctx, "account", c.refId);
      if (!sid) {
        invalid(
          ctx,
          `${path}.refId`,
          "criterion references an account that is not in Current Finances or this plan; dropped",
        );
        return undefined;
      }
      return metricCriterion(ctx, c, path, {
        kind: "accountBalance",
        accountId: ctx.accountIds.get(sid, "account"),
      });
    }
    default: {
      const metric = type ? METRICS[type] : undefined;
      if (!metric) {
        invalid(ctx, `${path}.type`, `unknown milestone criterion type '${String(type)}'; dropped`);
        return undefined;
      }
      return metricCriterion(ctx, c, path, { kind: metric });
    }
  }
}

function metricCriterion(ctx: PlContext, c: Obj, path: string, metric: Obj): Obj {
  const operator = str(c.operator) ?? ">=";
  const comparator = COMPARATORS.has(operator) ? operator : ">=";
  if (!COMPARATORS.has(operator))
    invalid(ctx, `${path}.operator`, `unknown operator '${operator}'; using >=`);
  const value = num(c.value) ?? 0;
  const valueType = str(c.valueType);
  let threshold: Obj;
  if (valueType === "expenses" || valueType === "spending") {
    threshold = {
      kind: "multipleOf",
      multiple: Math.max(0, value),
      of: valueType,
      measurement: c.measurement === "avg" ? "average" : "current",
    };
    const years = num(c.range);
    if (c.measurement === "avg" && years !== undefined && years >= 1)
      threshold.averageYears = Math.min(120, Math.round(years));
    if (c.measurement === "avg")
      infoNote(
        ctx,
        `${path}.measurement`,
        `"average ${valueType}" is projected over the next ${threshold.averageYears ?? "remaining"} year(s) from each year, in today's money, and includes property running costs and mortgage/debt payments (carried forward at that year's level until the loan would be repaid), because they are part of the expenses total; ProjectionLab's averaging may differ, so the milestone can land a year or so apart`,
        "pl.milestone-average",
      );
  } else {
    threshold = {
      kind: "amount",
      amount: { value, basis: basisOf(ctx, valueType, `${path}.valueType`) },
    };
  }
  return { kind: "metric", metric, comparator, threshold };
}

/** Register every milestone id of a plan before any event refers to one. */
export function registerMilestones(ctx: PlContext, plan: Obj): void {
  const scope = ctx.plan!;
  for (const m of [...arr(plan.milestones), ...arr(plan.computedMilestones)]) {
    const id = str(obj(m).id);
    if (id) {
      scope.knownMilestones.add(id);
      scope.milestoneIds.get(id, "milestone");
    }
  }
}

export function mapMilestones(ctx: PlContext, plan: Obj, basePath: string): Obj[] {
  const out: Obj[] = [];
  const scope = ctx.plan!;
  arr(plan.milestones).forEach((raw, i) => {
    const path = `${basePath}.milestones[${i}]`;
    const src = obj(raw);
    const sid = str(src.id);
    const builtin = sid ? BUILTIN[sid] : undefined;
    const criteria = arr(src.criteria)
      .map((c, j) => milestoneCriterion(ctx, c, `${path}.criteria[${j}]`, builtin?.who))
      .filter((c): c is Obj => c !== undefined);
    if (criteria.length === 0) {
      invalid(ctx, path, "milestone has no representable criteria; milestone dropped");
      return;
    }
    const m: Obj = {
      id: scope.milestoneIds.get(sid, `milestone-${i + 1}`),
      name: nameOf(src, builtin ? sid! : `Milestone ${i + 1}`),
      kind: builtin?.kind ?? "custom",
      combinator: "all",
      criteria,
      effects: [],
      builtIn: src.removable === false,
      enabled: true,
      showOnChart: true,
    };
    const person = personFor(ctx, builtin?.who);
    if (person && builtin) m.personId = person;
    const move = relocationOf(src);
    if (move) {
      const location = toLocation(ctx, move.raw, `${path}.${move.key}`);
      if (location) {
        m.effects = [{ kind: "relocate", location }];
        if (!builtin) m.kind = "move";
        approximated(
          ctx,
          `${path}.${move.key}`,
          "relocation read onto the residency timeline (a relocate effect from this milestone); the export checked had no relocation fields, so the key shape is inferred - check the move",
          "pl.relocation",
        );
      }
    }
    const appearance = appearanceOf(src);
    if (appearance) m.appearance = appearance;
    if (builtin?.who === "spouse" && !ctx.partnerId) {
      approximated(
        ctx,
        path,
        "spouse milestone in a household without a partner",
        "pl.spouse-milestone",
      );
    }
    out.push(m);
  });
  arr(plan.computedMilestones).forEach((raw, i) => {
    const path = `${basePath}.computedMilestones[${i}]`;
    const src = obj(raw);
    const criteria = arr(src.criteria)
      .map((c, j) => milestoneCriterion(ctx, c, `${path}.criteria[${j}]`, undefined))
      .filter((c): c is Obj => c !== undefined);
    if (criteria.length === 0) {
      invalid(ctx, path, "computed milestone has no representable criteria; dropped");
      return;
    }
    const hidden = src.hidden === true;
    const m: Obj = {
      id: scope.milestoneIds.get(str(src.id), `goal-milestone-${i + 1}`),
      name: nameOf(src, `Goal ${i + 1}`),
      kind: "custom",
      combinator: "all",
      criteria,
      effects: [],
      builtIn: false,
      enabled: true,
      showOnChart: src.showChartIcon !== false && !hidden,
    };
    const appearance = appearanceOf(src);
    if (appearance) m.appearance = appearance;
    out.push(m);
  });
  if (arr(plan.milestones).some((m) => obj(m).id === undefined)) {
    infoNote(
      ctx,
      `${basePath}.milestones`,
      "some milestones have no id; ids were generated",
      "pl.milestone-ids",
    );
  }
  return out;
}

/**
 * A Move milestone's destination, if the export carries one. ProjectionLab documents Move
 * milestones that switch the country / state / province taxes; the export checked has no such
 * keys, so the accepted shapes are inferred: `location`, `relocation` (or `relocation.location`)
 * and `taxResidence`, each an object with `country` and optional `state` / `province` / `region`
 * / `city` / `locality`.
 */
function relocationOf(src: Obj): { key: string; raw: Obj } | undefined {
  for (const key of ["location", "relocation", "taxResidence"]) {
    const v = obj(src[key]);
    if (str(v.country)) return { key, raw: v };
    const inner = obj(v.location);
    if (str(inner.country)) return { key: `${key}.location`, raw: inner };
  }
  return undefined;
}

function toLocation(ctx: PlContext, loc: Obj, path: string): Obj | undefined {
  const raw = str(loc.country);
  const country = raw === "UK" ? "GB" : raw && /^[A-Z]{2}$/.test(raw) ? raw : undefined;
  if (!country) {
    invalid(ctx, `${path}.country`, `unrecognised country '${String(raw)}'; relocation dropped`);
    return undefined;
  }
  const out: Obj = { country };
  const region = str(loc.region ?? loc.state ?? loc.province);
  if (region) out.region = region.slice(0, 10);
  const locality = str(loc.locality ?? loc.city);
  if (locality) out.locality = locality.slice(0, 40);
  return out;
}
