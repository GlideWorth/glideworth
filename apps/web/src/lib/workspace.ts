/**
 * Data hooks. The workspace (a GlideworthDocument) is loaded from the API; if the API is unreachable
 * the app falls back to the bundled SYNTHETIC sample so the UI is always explorable.
 *
 * Part of the app shell, so it holds no runtime import of @glideworth/core, Zod or the API client: the
 * client (with its schemas), the sample and the engine are loaded on first use (bundle splitting).
 */
import type { GlideworthDocument, Plan } from "@glideworth/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAmountsHidden, useUi } from "../stores/ui";
import { runSimulation } from "../workers/sim-client";
import { ApiRequestError, loadApi } from "./api-lazy";
import { type SessionState, sessionAfterUnauthorized } from "./auth";
import { isDemo } from "./demo";
import {
  amountsHidden,
  type FormatOptions,
  formatMoney,
  formatNumber,
  formatPercent,
  formatSigned,
  maskAmountsInText,
} from "./format";

export interface Workspace {
  doc: GlideworthDocument;
  source: "api" | "sample";
  error?: string;
  /** The API is reachable but holds no household yet: a brand-new install (onboarding). */
  firstRun?: boolean;
  /** HTTP status of the failure that forced the sample fallback (401 = sign-in needed). */
  status?: number;
}

/**
 * The server could not be reached (network error, proxy 502/503/504, or a restart) after the app
 * had loaded real data. The query keeps showing that data instead of swapping in the sample.
 */
export class ServerUnreachableError extends Error {}

/** A failure worth retrying: no response at all, or a 5xx / 429 from the server or the proxy. */
export function isTransientFailure(e: unknown): boolean {
  if (e instanceof ApiRequestError) return e.status >= 500 || e.status === 429;
  return true;
}

const RECONNECT_MS = 5_000;

export function useWorkspace() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["workspace"],
    queryFn: async (): Promise<Workspace> => {
      // The public demo never asks the server: the sample household, with this browser's edits.
      if (isDemo())
        return {
          doc: (await import("../features/demo/demo-data")).loadDemoDocument(),
          source: "sample",
        };
      const sample = async () => (await import("@glideworth/core/samples")).createSampleDocument();
      try {
        const api = await loadApi();
        const { items } = await api.listHouseholds();
        const first = items[0];
        if (!first)
          return {
            doc: await sample(),
            source: "sample",
            error: "No household in the database yet.",
            firstRun: true,
          };
        return { doc: await api.getDocument(first.id), source: "api" };
      } catch (e) {
        // Once real data is on screen, a server blip (restart, flaky network) must never replace
        // the user's household with the bundled sample: keep the last good copy, mark the query
        // as failed and keep retrying until the server answers again.
        const prev = qc.getQueryData<Workspace>(["workspace"]);
        if (prev?.source === "api" && isTransientFailure(e))
          throw new ServerUnreachableError(e instanceof Error ? e.message : String(e));
        // The browser session ended (signed out elsewhere, expired): show the sign-in screen
        // rather than swapping in the sample household.
        const session = qc.getQueryData<SessionState>(["session"]);
        if (e instanceof ApiRequestError && e.status === 401 && session) {
          const next = sessionAfterUnauthorized(session);
          qc.setQueryData(["session"], next);
          // Hosted: fetch the rest of the signed-out state (bot-check key, Google sign-in) for the sign-in page.
          if (next.kind === "cloud-signed-out" && next !== session)
            void qc.invalidateQueries({ queryKey: ["session"] });
          if (prev?.source === "api") throw e;
        }
        return {
          doc: await sample(),
          source: "sample",
          error: e instanceof Error ? e.message : String(e),
          status: e instanceof ApiRequestError ? e.status : undefined,
        };
      }
    },
    staleTime: isDemo() ? Number.POSITIVE_INFINITY : 30_000,
    retry: (count, e) => e instanceof ServerUnreachableError && count < 2,
    // Reconnect on its own: poll while the server is unreachable (real data kept on screen) or
    // while we are showing the offline sample because the server was down at start-up.
    refetchInterval: (q) => {
      if (isDemo()) return false;
      const d = q.state.data;
      if (q.state.status === "error") return RECONNECT_MS;
      if (d?.source === "sample" && !d.firstRun && (d.status === undefined || d.status >= 500))
        return RECONNECT_MS;
      return false;
    },
  });
}

/** True while real data is on screen but the server cannot be reached. */
export function useServerUnreachable(): boolean {
  const { data, isError, error } = useWorkspace();
  return data?.source === "api" && isError && error instanceof ServerUnreachableError;
}

/**
 * The API answered. A brand-new workspace (`firstRun`) has no household yet, so the app shows the
 * bundled sample: that is not an outage. Offline is only the sample fallback after a failed request.
 */
export function serverReachable(ws: Pick<Workspace, "source" | "firstRun"> | undefined): boolean {
  return ws?.source === "api" || ws?.firstRun === true;
}

/**
 * The household's locale once its document has loaded. Undefined while that load is still in
 * flight, so a screen does not format a date in the browser's locale and then correct it.
 */
export function useDocumentLocale(): string | undefined {
  const { data, isPending } = useWorkspace();
  if (isPending || !data) return undefined;
  return data.doc.settings?.locale ?? data.doc.household.locale ?? navigator.language;
}

export function useActivePlan(): {
  plan: Plan | undefined;
  plans: Plan[];
  workspace: Workspace | undefined;
} {
  const { data } = useWorkspace();
  const activeId = useUi((s) => s.activePlanId);
  const plans = data?.doc.plans ?? [];
  const defaultId = data?.doc.settings.defaultPlanId;
  const plan =
    plans.find((p) => p.id === activeId) ??
    plans.find((p) => p.id === defaultId) ??
    plans.find((p) => p.isMain) ??
    plans[0];
  return { plan, plans, workspace: data };
}

export function useProjection(planId: string | undefined) {
  const { data } = useWorkspace();
  const plan = data?.doc.plans.find((p) => p.id === planId);
  return useQuery({
    queryKey: ["projection", data?.source, planId, plan?.version, plan?.updatedAt],
    enabled: !!data && !!plan,
    queryFn: async () => {
      const { buildSimulationInput } = await import("@glideworth/core");
      return runSimulation(buildSimulationInput(data!.doc, planId!, { trace: "summary" }));
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** The person's display locale (Settings > Profile), falling back to the household's, then the browser's. */
export function useLocale(): string {
  const { data } = useWorkspace();
  return data?.doc.settings?.locale ?? data?.doc.household.locale ?? navigator.language;
}

export function useFormat() {
  const { data } = useWorkspace();
  const s = data?.doc.settings;
  const opts: FormatOptions = {
    locale: s?.locale ?? data?.doc.household.locale ?? navigator.language,
    currency: s?.displayCurrency ?? data?.doc.household.currency ?? "USD",
  };
  // A new formatter when amounts are hidden or shown, so memoised views re-render with the mask.
  const hidden = useAmountsHidden();
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- opts is derived from locale + currency only
  return useMemo(() => makeFormatter(opts, hidden), [opts.locale, opts.currency, hidden]);
}

/**
 * Formatting helpers bound to one locale and currency (see `useFormat`). Money masks itself while
 * amounts are hidden (lib/format); `hidden` only records which state this formatter was made in.
 */
export function makeFormatter(opts: FormatOptions, hidden = amountsHidden()) {
  return {
    ...opts,
    hidden,
    /** Prose that may carry money it did not format (insight sentences, diffs): masked when hidden. */
    text: (s: string) => maskAmountsInText(s),
    money: (v: number, compact = false) => formatMoney(v, { ...opts, compact }),
    percent: (v: number, d = 1) => formatPercent(v, opts.locale, d),
    /** An amount in another currency (original-currency figures of foreign holdings). */
    moneyIn: (v: number, currency: string, compact = false) =>
      formatMoney(v, { locale: opts.locale, currency, compact }),
    number: (v: number, d = 0) => formatNumber(v, opts.locale, d),
    /** "+£1,200" / "−£300", or "£0" for nothing. */
    signed: (v: number, compact = false) =>
      formatSigned(v, (a) => formatMoney(a, { ...opts, compact }), formatMoney(0, opts)),
  };
}
