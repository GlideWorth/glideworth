/** Human-readable descriptions of individual plan patch ops ("Retirement moved from age 60 to 57"). */
import type { PatchOp, PlanChange } from "../schema/changes.js";
import type { ExpenseEvent, IncomeEvent } from "../schema/events.js";
import type { Flow } from "../schema/flows.js";
import type { Milestone, MilestoneCriterion } from "../schema/milestones.js";
import type { Plan } from "../schema/plan.js";
import type { ResidencyChange } from "../schema/residency.js";
import type { DrawdownEntry } from "../schema/strategies.js";
import type { DateRef, RateSpec } from "../schema/time.js";
import { countryName } from "../tax/crossborder/explain.js";
import {
  ASSUMPTION_LABELS,
  capitalise,
  type FormatContext,
  fmtAge,
  fmtAmount,
  fmtDateRef,
  fmtMonth,
  fmtRange,
  fmtRateSpec,
  fmtValue,
  humanKey,
} from "./format.js";
import { isPlainObject } from "./json.js";
import { parsePointer, type Segment } from "./pointer.js";

export interface DescribeInput {
  base: Plan;
  other: Plan;
  format: FormatContext;
}

type EntityType = PlanChange["entity"]["type"];

const ENTITY_ARRAYS: Record<string, { type: EntityType; noun: string }> = {
  milestones: { type: "milestone", noun: "milestone" },
  income: { type: "income", noun: "income" },
  expenses: { type: "expense", noun: "expense" },
  flows: { type: "flow", noun: "flow" },
  plannedAccounts: { type: "account", noun: "planned account" },
  plannedRealAssets: { type: "realAsset", noun: "planned asset" },
};

const SETTINGS_MAPS: Record<string, { type: EntityType; noun: string }> = {
  accountSettings: { type: "account", noun: "account" },
  realAssetSettings: { type: "realAsset", noun: "asset" },
  debtSettings: { type: "debt", noun: "debt" },
};

const STRATEGY_KEYS = new Set([
  "drawdown",
  "withdrawalStrategy",
  "flexSpending",
  "riskGuardrails",
  "taxStrategy",
  "leftover",
]);

function lookup(root: unknown, segs: Segment[]): unknown {
  let cur = root;
  for (const s of segs) {
    if (Array.isArray(cur)) {
      cur =
        s.kind === "id" ? cur.find((e) => isPlainObject(e) && e.id === s.id) : cur[Number(s.key)];
    } else if (isPlainObject(cur) && s.kind === "key") cur = cur[s.key];
    else return undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

function entityOf(
  segs: Segment[],
  input: DescribeInput,
  op: PatchOp,
): PlanChange["entity"] & { noun: string } {
  const top = segs[0]?.kind === "key" ? segs[0].key : "";
  const arr = ENTITY_ARRAYS[top];
  if (arr) {
    const s1 = segs[1];
    let el: unknown;
    if (s1?.kind === "id")
      el = lookup(input.other, segs.slice(0, 2)) ?? lookup(input.base, segs.slice(0, 2));
    else if (s1?.kind === "key" && s1.key === "-" && op.op === "add") el = op.value;
    else if (s1?.kind === "key")
      el = lookup(input.other, segs.slice(0, 2)) ?? lookup(input.base, segs.slice(0, 2));
    const o = isPlainObject(el) ? el : {};
    return {
      type: arr.type,
      noun: arr.noun,
      ...(typeof o.id === "string" ? { id: o.id } : {}),
      ...(typeof o.name === "string" ? { name: o.name } : {}),
    };
  }
  const map = SETTINGS_MAPS[top];
  if (map) {
    const id = segs[1]?.kind === "key" ? segs[1].key : undefined;
    const name = id ? input.format.entities?.[id] : undefined;
    return { type: map.type, noun: map.noun, ...(id ? { id } : {}), ...(name ? { name } : {}) };
  }
  if (top === "assumptions") return { type: "assumption", noun: "assumption" };
  if (top === "tax") return { type: "tax", noun: "tax setting" };
  if (top === "monteCarlo") return { type: "monteCarlo", noun: "chance-of-success setting" };
  if (STRATEGY_KEYS.has(top)) return { type: "strategy", noun: "strategy" };
  return { type: "plan", noun: "plan" };
}

function describeEntity(
  kind: "income" | "expense" | "flow" | "milestone" | "other",
  v: unknown,
  f: FormatContext,
): string {
  if (!isPlainObject(v)) return "";
  const name = typeof v.name === "string" ? v.name : "item";
  if (kind === "income" || kind === "expense") {
    const e = v as unknown as IncomeEvent | ExpenseEvent;
    if (!e.amount || !e.range) return name;
    const once = e.frequency === "once";
    return `${name} ${fmtAmount(e.amount, e.frequency, f)} ${fmtRange(e.range, once, f)}`;
  }
  if (kind === "milestone") {
    const m = v as unknown as Milestone;
    return `${name}${m.criteria?.length ? ` (${m.criteria.map((c) => fmtCriterion(c, f)).join(m.combinator === "any" ? " or " : " and ")})` : ""}`;
  }
  if (kind === "flow") {
    const fl = v as unknown as Flow;
    if (fl.kind === "contribution" && fl.method?.kind === "amount")
      return `${name} ${fmtAmount(fl.method.amount, fl.method.frequency, f)}`;
    return name;
  }
  return name;
}

export function fmtCriterion(c: MilestoneCriterion, f: FormatContext): string {
  switch (c.kind) {
    case "age": {
      const who = f.people?.[c.personId];
      return `${c.when === "before" ? "before " : "at "}${who ? `${who}'s ` : ""}age ${fmtAge(c.age, f)}`;
    }
    case "date":
      return `${c.when === "before" ? "before" : "in"} ${fmtMonth(c.date)}`;
    case "milestone":
      return `${c.when === "before" ? "before" : "at"} ${f.milestones?.[c.milestoneId] ?? c.milestoneId}`;
    case "metric":
      return `when ${humanKey(c.metric.kind)} ${c.comparator} ${
        c.threshold.kind === "amount"
          ? fmtValue(c.threshold.amount.value, "amount", f)
          : `${c.threshold.multiple}x ${c.threshold.of}`
      }`;
  }
}

function kindNoun(type: EntityType): "income" | "expense" | "flow" | "milestone" | "other" {
  return type === "income" || type === "expense" || type === "flow" || type === "milestone"
    ? type
    : "other";
}

function fieldKey(segs: Segment[]): string {
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]!;
    if (s.kind === "key" && !/^\d+$/.test(s.key) && s.key !== "-") return s.key;
  }
  return "";
}

function frequencyPhrase(entity: unknown): Parameters<typeof fmtAmount>[1] {
  if (!isPlainObject(entity)) return undefined;
  if (typeof entity.frequency === "string")
    return entity.frequency as Parameters<typeof fmtAmount>[1];
  if (isPlainObject(entity.method) && typeof entity.method.frequency === "string")
    return entity.method.frequency as Parameters<typeof fmtAmount>[1];
  return undefined;
}

function drawdownLabel(e: DrawdownEntry, f: FormatContext): string {
  if (e.kind === "category") return e.category;
  if (e.kind === "account") return f.entities?.[e.accountId] ?? e.accountId;
  return f.entities?.[e.assetId] ?? e.assetId;
}

/** Turn one op into a PlanChange (null for ops with nothing to say, like `test`). */
export function describeChange(op: PatchOp, input: DescribeInput): PlanChange | null {
  if (op.op === "test") return null;
  const f = input.format;
  const segs = parsePointer(op.path);
  const entity = entityOf(segs, input, op);
  const { noun, ...entityOut } = entity;
  const label = entity.name ?? (entity.id ? (f.entities?.[entity.id] ?? entity.id) : undefined);
  const top = segs[0]?.kind === "key" ? segs[0].key : "";
  const before =
    op.op === "add" &&
    segs[segs.length - 1]?.kind === "key" &&
    (segs[segs.length - 1] as { key: string }).key === "-"
      ? undefined
      : lookup(input.base, segs);
  const after = op.op === "remove" ? undefined : op.op === "move" ? undefined : op.value;
  const isEntityLevel = !!ENTITY_ARRAYS[top] && segs.length === 2;
  const mk = (kind: PlanChange["kind"], description: string): PlanChange => ({
    path: op.path,
    kind,
    entity: entityOut,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
    description,
  });

  // --- whole entities
  if (isEntityLevel && op.op === "add")
    return mk("added", `Added ${noun}: ${describeEntity(kindNoun(entity.type), op.value, f)}`);
  if (isEntityLevel && op.op === "remove")
    return mk("removed", `Removed ${noun}: ${label ?? "item"}`);
  if (op.op === "move") {
    if (top === "flows" && segs.length === 2) {
      const pos = Number((segs[1] as { key: string }).key) + 1;
      return mk("moved", `${label ?? "Flow"} moved to priority ${pos}`);
    }
    return mk("moved", `${capitalise(noun)}${label ? ` ${label}` : ""} reordered`);
  }
  if (SETTINGS_MAPS[top] && segs.length === 2) {
    const name = label ?? "item";
    if (op.op === "add") return mk("added", `Plan overrides added for ${noun} ${name}`);
    if (op.op === "remove") return mk("removed", `Plan overrides removed for ${noun} ${name}`);
  }

  const key = fieldKey(segs);
  const kind: PlanChange["kind"] =
    op.op === "add" ? "added" : op.op === "remove" ? "removed" : "changed";
  const entityRoot = ENTITY_ARRAYS[top]
    ? (lookup(input.other, segs.slice(0, 2)) ?? lookup(input.base, segs.slice(0, 2)))
    : undefined;
  const who = label ? `${label}` : capitalise(noun);

  // --- milestones: "Retirement moved from age 60 to 57"
  if (top === "milestones" && segs[2]?.kind === "key" && segs[2].key === "criteria") {
    if (key === "age" && typeof before === "number" && typeof after === "number")
      return mk("changed", `${who} moved from age ${fmtAge(before, f)} to ${fmtAge(after, f)}`);
    if (key === "date" && typeof before === "string" && typeof after === "string")
      return mk("changed", `${who} moved from ${fmtMonth(before)} to ${fmtMonth(after)}`);
    const bm = lookup(input.base, segs.slice(0, 2)) as Milestone | undefined;
    const am = lookup(input.other, segs.slice(0, 2)) as Milestone | undefined;
    const crit = (m: Milestone | undefined) =>
      m?.criteria
        ? m.criteria.map((c) => fmtCriterion(c, f)).join(m.combinator === "any" ? " or " : " and ")
        : "?";
    return mk("changed", `${who} now happens ${crit(am)} (was ${crit(bm)})`);
  }

  // --- amounts on events and flows
  if (
    ENTITY_ARRAYS[top] &&
    key === "value" &&
    typeof after === "number" &&
    typeof before === "number"
  ) {
    const per = frequencyPhrase(entityRoot);
    const nowAmount = fmtAmount({ value: after, basis: "real" }, per, f);
    return mk(
      "changed",
      `${who} changed from ${fmtAmount({ value: before, basis: "real" }, undefined, f)} to ${nowAmount}`,
    );
  }
  if (ENTITY_ARRAYS[top] && key === "basis" && typeof after === "string")
    return mk(
      "changed",
      `${who} amount is now in ${after === "real" ? "today's money" : "future (nominal) money"}`,
    );
  if (ENTITY_ARRAYS[top] && key === "frequency" && typeof after === "string")
    return mk("changed", `${who} frequency changed from ${String(before)} to ${after}`);
  if (ENTITY_ARRAYS[top] && key === "enabled" && typeof after === "boolean")
    return mk("changed", `${who} ${after ? "enabled" : "disabled"}`);
  if (ENTITY_ARRAYS[top] && key === "name" && segs.length === 3)
    return mk("changed", `Renamed ${noun} "${String(before)}" to "${String(after)}"`);
  if (ENTITY_ARRAYS[top] && key === "spendingType")
    return mk("changed", `${who} is now ${String(after)} (was ${String(before)})`);
  if (ENTITY_ARRAYS[top] && segs.some((s) => s.kind === "key" && s.key === "range")) {
    const which = segs.some((s) => s.kind === "key" && s.key === "start")
      ? "start"
      : segs.some((s) => s.kind === "key" && s.key === "end")
        ? "end"
        : null;
    if (which) {
      const rangeSegs = segs.slice(
        0,
        segs.findIndex((s) => s.kind === "key" && s.key === which) + 1,
      );
      const b = lookup(input.base, rangeSegs) as DateRef | undefined;
      const a = lookup(input.other, rangeSegs) as DateRef | undefined;
      if (a && b) {
        const verb = which === "start" ? "starts" : "ends";
        if (isPlainObject(entityRoot) && entityRoot.frequency === "once" && which === "start")
          return mk(
            "changed",
            `${who} now happens in ${fmtDateRef(a, f)} (was ${fmtDateRef(b, f)})`,
          );
        return mk(
          "changed",
          `${who} now ${verb} ${a.kind === "age" || a.kind === "milestone" ? "at " : ""}${fmtDateRef(a, f)} (was ${fmtDateRef(b, f)})`,
        );
      }
    }
  }
  if (ENTITY_ARRAYS[top] && key === "change")
    return mk(
      "changed",
      `${who} growth changed from ${fmtValue(before, key, f)} to ${fmtValue(after, key, f)}`,
    );

  // --- assumptions
  if (top === "assumptions") {
    const ak = segs[1]?.kind === "key" ? segs[1].key : "";
    const nice = ASSUMPTION_LABELS[ak] ?? capitalise(humanKey(ak));
    const spec = (p: Plan) => lookup(p, segs.slice(0, 2));
    const b = spec(input.base);
    const a = spec(input.other);
    if (
      isPlainObject(a) &&
      isPlainObject(b) &&
      "kind" in a &&
      ["none", "fixed", "schedule", "historical"].includes(String(a.kind))
    )
      return mk(
        "changed",
        `${nice} assumption changed from ${fmtRateSpec(b as RateSpec, f)} to ${fmtRateSpec(a as RateSpec, f)}`,
      );
    if (ak === "bondAllocation" && key === "share")
      return mk(
        "changed",
        `Bond allocation changed from ${fmtValue(before, "share", f)} to ${fmtValue(after, "share", f)}`,
      );
    return mk(
      kind,
      `${nice}${segs.length > 2 ? ` ${humanKey(key)}` : ""} changed from ${fmtValue(before, key || ak, f)} to ${fmtValue(after, key || ak, f)}`,
    );
  }

  // --- drawdown order
  if (top === "drawdown" && segs[1]?.kind === "key" && segs[1].key === "order") {
    const order = (p: Plan) => p.drawdown.order.map((e) => drawdownLabel(e, f)).join(" → ");
    return mk(
      "changed",
      `Drawdown order changed to ${order(input.other)} (was ${order(input.base)})`,
    );
  }

  if (top === "name" && segs.length === 1)
    return mk("changed", `Plan renamed from "${String(before)}" to "${String(after)}"`);
  if (top === "description" || top === "notes")
    return mk(kind, `Plan ${top} ${kind === "removed" ? "removed" : "updated"}`);

  // --- residency: "Everyone moves to United Arab Emirates from Sep 2027"
  if (top === "residency") {
    const move = (v: unknown): string => {
      if (!isPlainObject(v)) return "a move";
      const r = v as unknown as ResidencyChange;
      const who = r.personId ? (f.people?.[r.personId] ?? r.personId) : "everyone";
      const where = `${countryName(r.location?.country ?? "?")}${r.location?.region ? ` (${r.location.region})` : ""}`;
      return `${capitalise(who)} moves to ${where} ${r.from?.kind === "date" ? "from " : "at "}${r.from ? fmtDateRef(r.from, f) : "?"}`;
    };
    if (segs.length === 1) {
      const list = (v: unknown) =>
        Array.isArray(v) && v.length ? v.map(move).join("; ") : "no moves";
      return mk(kind, `Where you live: ${list(after)} (was ${list(before)})`);
    }
    if (segs.length === 2 && op.op === "add") return mk("added", `Added move: ${move(op.value)}`);
    if (segs.length === 2 && op.op === "remove")
      return mk("removed", `Removed move: ${move(before)}`);
    const b = lookup(input.base, segs.slice(0, 2));
    const a = lookup(input.other, segs.slice(0, 2));
    return mk("changed", `Move changed: ${move(a)} (was ${move(b)})`);
  }

  // --- generic fallback
  const where = segs
    .slice(ENTITY_ARRAYS[top] || SETTINGS_MAPS[top] ? 2 : 0)
    .filter((s) => s.kind === "key" && !/^\d+$/.test(s.key))
    .map((s) => humanKey((s as { key: string }).key))
    .join(" ");
  const subject =
    ENTITY_ARRAYS[top] || SETTINGS_MAPS[top]
      ? `${who}${where ? ` ${where}` : ""}`
      : capitalise(where || noun);
  if (kind === "added") return mk(kind, `${subject} set to ${fmtValue(after, key, f)}`);
  if (kind === "removed") return mk(kind, `${subject} removed (was ${fmtValue(before, key, f)})`);
  return mk(
    kind,
    `${subject} changed from ${fmtValue(before, key, f)} to ${fmtValue(after, key, f)}`,
  );
}
