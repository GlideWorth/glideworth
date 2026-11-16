/** Priorities (= Flows): contributions, extra debt/asset payments and transfers. */
import { num, type Obj, obj, pctClean, str } from "../util/read.js";
import { amountOf, appearanceOf, clamp, frequencyOf, nameOf, ownerOf } from "./common.js";
import { approximated, infoNote, invalid, type PlContext, resolveSource } from "./context.js";
import { resolveRange } from "./dates.js";
import { accountRef } from "./events.js";

function fraction(ctx: PlContext, v: unknown, path: string): number {
  const n = num(v) ?? 0;
  if (n > 100 || n < 0) invalid(ctx, path, "percentage outside 0-100; clamped");
  return clamp(pctClean(n) ?? 0, 0, 1);
}

interface MethodInput {
  kind: "contribution" | "debtPaydown" | "transfer";
}

/** desiredContribution + amounts -> a method object per flow kind. */
function methodOf(ctx: PlContext, src: Obj, path: string, flow: MethodInput["kind"]): Obj {
  const desired = str(src.desiredContribution) ?? (flow === "debtPaydown" ? "amount" : "max");
  const frequency = frequencyOf(ctx, src.frequency, `${path}.frequency`, "yearly");
  const isPay = flow === "debtPaydown";
  // The numeric amount lives in `extra` for pay-extra priorities and `amount`/`contribution` otherwise.
  const amountSrc = isPay
    ? (src.extra ?? src.amount ?? src.contribution)
    : (src.contribution ?? src.amount);
  const tag = isPay ? (src.extraType ?? src.amountType) : (src.contributionType ?? src.amountType);
  if (desired === "max") return flow === "transfer" ? { kind: "all" } : { kind: "max" };
  if (desired === "%-remaining" || desired === "percent") {
    const pctSource =
      flow === "transfer" || isPay
        ? (src.contribution ?? src.amount)
        : (src.contribution ?? src.amount);
    if (src.contribution === undefined && src.amount !== undefined) {
      approximated(
        ctx,
        `${path}.contribution`,
        "percentage taken from `amount` because `contribution` is absent",
        "pl.flow-percent-source",
      );
    }
    const share = fraction(ctx, pctSource, `${path}.contribution`);
    if (flow === "transfer") return { kind: "percentOfBalance", share };
    return { kind: "percentOfRemaining", share };
  }
  if (desired !== "amount")
    invalid(
      ctx,
      `${path}.desiredContribution`,
      `unknown contribution mode '${desired}'; read as a fixed amount`,
    );
  const amount = amountOf(
    ctx,
    amountSrc,
    tag,
    `${path}.${isPay ? "extraType" : "contributionType"}`,
  );
  return { kind: "amount", amount, frequency };
}

export function mapFlow(
  ctx: PlContext,
  raw: unknown,
  path: string,
  index: number,
): Obj | undefined {
  const src = obj(raw);
  const scope = ctx.plan!;
  const id = scope.eventIds.get(str(src.id), `flow-${index + 1}`);
  const type = str(src.type);
  const frequency = frequencyOf(ctx, src.frequency, `${path}.frequency`, "yearly");
  const base: Obj = {
    id,
    name: nameOf(src, `Priority ${index + 1}`),
    owner: ownerOf(ctx, src.owner, `${path}.owner`),
    range: resolveRange(ctx, { start: src.start, end: src.end, frequency, owner: src.owner }, path),
    mandatory: src.contributionsAreFixed === true,
  };
  const appearance = appearanceOf(src);
  if (appearance) base.appearance = appearance;

  switch (type) {
    case "savings":
    case "taxable":
    case "invest":
    case "contribution": {
      const accountId = accountRef(ctx, src.accountId, `${path}.accountId`);
      if (!accountId) return undefined;
      const flow: Obj = {
        ...base,
        kind: "contribution",
        accountId,
        method: methodOf(ctx, src, path, "contribution"),
      };
      if (str(src.mode) === "target") {
        flow.strategy = {
          kind: "target",
          target: amountOf(ctx, src.amount, src.amountType, `${path}.amountType`),
        };
      } else if (src.mode !== undefined) {
        invalid(ctx, `${path}.mode`, `unknown priority mode '${String(src.mode)}'`);
      }
      if (str(src.desiredContribution) === "max") flow.limit = { kind: "jurisdiction" };
      if (src.tapFund === true) {
        const rate = pctClean(src.tapRate);
        if (rate !== undefined && rate > 0) flow.tapFund = { rate: clamp(rate, 0, 1) };
      }
      if (src.taxTreatment !== undefined) {
        approximated(
          ctx,
          `${path}.taxTreatment`,
          "tax treatment on a contribution priority has no Glideworth equivalent; dropped",
          "pl.flow-taxTreatment",
        );
      }
      return flow;
    }
    case "debt":
    case "asset": {
      const sid = resolveSource(ctx, type, type === "debt" ? src.debtId : src.assetId);
      if (!sid) {
        invalid(
          ctx,
          `${path}.${type === "debt" ? "debtId" : "assetId"}`,
          `references ${type === "debt" ? "a debt" : "an asset"} that is not in Current Finances; priority dropped`,
        );
        return undefined;
      }
      const registry = type === "debt" ? ctx.debtIds : ctx.assetIds;
      const flow: Obj = {
        ...base,
        kind: "debtPaydown",
        targetId: registry.get(sid, type),
        method: methodOf(ctx, src, path, "debtPaydown"),
      };
      if (type === "asset")
        infoNote(
          ctx,
          path,
          "'asset' priority mapped to a pay-down of the asset's loan",
          "pl.asset-priority",
        );
      return flow;
    }
    case "transfer": {
      const from = accountRef(ctx, src.accountId, `${path}.accountId`);
      const dest = obj(src.destination);
      if (!from) return undefined;
      let to: Obj;
      if (dest.type === "account") {
        const toId = accountRef(ctx, dest.id, `${path}.destination.id`);
        if (!toId) return undefined;
        to = { kind: "account", accountId: toId };
      } else {
        to = { kind: "external", label: String(dest.type ?? "external").slice(0, 120) };
        approximated(
          ctx,
          `${path}.destination`,
          `transfer destination '${String(dest.type)}' is not an account; imported as an external transfer`,
          "pl.transfer-destination",
        );
      }
      const m = methodOf(ctx, src, path, "transfer");
      const flow: Obj = {
        ...base,
        kind: "transfer",
        fromAccountId: from,
        to,
        amount: m,
        taxHandling:
          str(src.taxTreatment) === "tax-exempt"
            ? "tax-exempt"
            : str(src.taxTreatment) === "taxable"
              ? "taxable"
              : "auto",
      };
      return flow;
    }
    default:
      invalid(ctx, `${path}.type`, `unknown priority type '${String(type)}'; priority dropped`);
      return undefined;
  }
}
