/**
 * Live projection for the plan being edited. Re-simulates the DRAFT in the Web Worker, debounced,
 * on every edit, and simulates the last SAVED version once per save to show deltas.
 * Runs non-strict so features still being built by other workstreams surface as warnings, not
 * failures.
 */

import {
  type GlideworthDocument,
  Plan,
  type ProjectionResult,
  SimulationOptions,
  type ValueBasis,
} from "@glideworth/core";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { total } from "../../../lib/money";
import { runSimulation, SimulationError } from "../../../workers/sim-client";
import { useEditorStore } from "../state/doc-store";

export interface PreviewState {
  planId: string | null;
  result: ProjectionResult | null;
  baseline: ProjectionResult | null;
  running: boolean;
  ms: number | null;
  error: string | null;
  invalid: boolean;
}

export const usePreview = create<PreviewState>(() => ({
  planId: null,
  result: null,
  baseline: null,
  running: false,
  ms: null,
  error: null,
  invalid: false,
}));

const DEBOUNCE_MS = 280;

function inputFor(doc: GlideworthDocument, plan: Plan) {
  return {
    household: doc.household,
    finances: doc.finances,
    // Branch bodies are materialised caches; simulate the body directly.
    plan: { ...plan, lineage: undefined },
    options: SimulationOptions.parse({ strict: false, trace: "off" }),
  };
}

function describeError(e: unknown): string {
  if (e instanceof SimulationError) {
    if (e.payload.feature)
      return `${e.payload.feature} is not modelled in this version of Glideworth yet.`;
    return e.payload.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function useLiveProjection(planId: string | undefined) {
  const plan = useEditorStore((s) => s.draft?.plans.find((p) => p.id === planId));
  const household = useEditorStore((s) => s.draft?.household);
  const finances = useEditorStore((s) => s.draft?.finances);
  const basePlan = useEditorStore((s) => s.base?.plans.find((p) => p.id === planId));
  const baseHousehold = useEditorStore((s) => s.base?.household);
  const baseFinances = useEditorStore((s) => s.base?.finances);
  const seq = useRef(0);

  useEffect(() => {
    if (usePreview.getState().planId !== planId)
      usePreview.setState({
        planId: planId ?? null,
        result: null,
        baseline: null,
        error: null,
        ms: null,
      });
  }, [planId]);

  useEffect(() => {
    if (!plan || !household || !finances) return;
    const id = ++seq.current;
    const parsed = Plan.safeParse(plan);
    if (!parsed.success) {
      usePreview.setState({ invalid: true, running: false });
      return;
    }
    usePreview.setState({ running: true, invalid: false });
    const t = setTimeout(() => {
      const doc = { household, finances } as GlideworthDocument;
      runSimulation(inputFor(doc, parsed.data))
        .then(({ result, ms }) => {
          if (id === seq.current) usePreview.setState({ result, ms, error: null, running: false });
        })
        .catch((e) => {
          if (id === seq.current) usePreview.setState({ error: describeError(e), running: false });
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [plan, household, finances]);

  useEffect(() => {
    if (!basePlan || !baseHousehold || !baseFinances) return;
    let live = true;
    runSimulation(
      inputFor(
        { household: baseHousehold, finances: baseFinances } as GlideworthDocument,
        basePlan,
      ),
    )
      .then(({ result }) => live && usePreview.setState({ baseline: result }))
      .catch(() => live && usePreview.setState({ baseline: null }));
    return () => {
      live = false;
    };
  }, [basePlan, baseHousehold, baseFinances]);
}

export interface KeyMetrics {
  atRetirement: { value: number; year: number } | null;
  final: { value: number; year: number } | null;
  firstShortfallYear: number | null;
  totalShortfall: number;
  retirementYear: number | null;
}

export function keyMetrics(
  r: ProjectionResult | null,
  plan: Plan | undefined,
  basis: ValueBasis,
): KeyMetrics | null {
  if (!r?.periods.length) return null;
  const retireIds = new Set(
    plan?.milestones.filter((m) => m.kind === "retirement").map((m) => m.id),
  );
  const ret = r.milestones.find(
    (m) => retireIds.has(m.milestoneId) && m.status === "reached" && m.periodIndex !== null,
  );
  const rp = ret ? r.periods[ret.periodIndex!] : undefined;
  const last = r.periods[r.periods.length - 1]!;
  const firstShort = r.periods.find((p) => p.totals.shortfall > 0.5);
  return {
    atRetirement: rp ? { value: total(rp, "netWorth", basis), year: rp.year } : null,
    final: { value: total(last, "netWorth", basis), year: last.year },
    firstShortfallYear: firstShort?.year ?? r.summary.firstShortfallYear ?? null,
    totalShortfall: r.periods.reduce((s, p) => s + total(p, "shortfall", basis), 0),
    retirementYear: rp?.year ?? null,
  };
}
