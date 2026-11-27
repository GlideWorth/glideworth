import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf, useWidget } from "../context";
import type { Formatter } from "../format";
import { payloadFrom } from "../routing";
import type { OutcomeNumbers, WidgetPayload } from "../types";
import type { Guide } from "../components/chart";
import type { Tone } from "../components/ui";

/** One action at a time, with its error: guards against double taps while a call is in flight. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async (key: string, task: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(key);
    setError(null);
    try {
      await task();
    } catch (err) {
      if (mounted.current) setError(messageOf(err));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(null);
    }
  }, []);
  return { busy, error, setError, run };
}

/** Calls a tool that returns a view and opens it on top of the current one. */
export function useOpenView() {
  const { call, push } = useWidget();
  return useCallback(
    async (name: string, args: Record<string, unknown>, expect: WidgetPayload["view"]) => {
      const result = await call(name, args);
      const payload = payloadFrom(result);
      if (!payload || payload.view !== expect)
        throw new Error("Glideworth didn't send a view for that. Ask in the chat instead.");
      push(payload);
    },
    [call, push],
  );
}

export const clip = (text: string, max = 500) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export interface Delta {
  key: string;
  label: string;
  before: string;
  after: string;
  tone: Tone;
}

/** The outcome numbers that differ between two sides, most important first. */
export function outcomeDeltas(
  before: OutcomeNumbers,
  after: OutcomeNumbers,
  fmt: Formatter,
  retirementLabel = "Retirement",
): Delta[] {
  const out: Delta[] = [];
  if (
    before.successRate !== null &&
    after.successRate !== null &&
    Math.round(before.successRate * 100) !== Math.round(after.successRate * 100)
  )
    out.push({
      key: "success",
      label: "Chance of success",
      before: fmt.percent(before.successRate, 0),
      after: fmt.percent(after.successRate, 0),
      tone: after.successRate > before.successRate ? "good" : "bad",
    });
  if (before.depletionYear !== after.depletionYear) {
    const later =
      after.depletionYear === null ||
      (before.depletionYear !== null && after.depletionYear > before.depletionYear);
    out.push({
      key: "depletion",
      label: "Runs short",
      before: before.depletionYear === null ? "Never" : fmt.year(before.depletionYear),
      after: after.depletionYear === null ? "Never" : fmt.year(after.depletionYear),
      tone: later ? "good" : "bad",
    });
  } else if (before.success !== after.success) {
    out.push({
      key: "lasts",
      label: "Money lasts",
      before: before.success ? "Yes" : "No",
      after: after.success ? "Yes" : "No",
      tone: after.success ? "good" : "bad",
    });
  }
  if (Math.abs(after.endNetWorth - before.endNetWorth) >= 1000)
    out.push({
      key: "end",
      label: "End net worth",
      before: fmt.compact(before.endNetWorth),
      after: fmt.compact(after.endNetWorth),
      tone: after.endNetWorth > before.endNetWorth ? "good" : "bad",
    });
  if (before.retirementYear !== after.retirementYear)
    out.push({
      key: "retire",
      label: retirementLabel,
      before: before.retirementYear === null ? "—" : fmt.year(before.retirementYear),
      after: after.retirementYear === null ? "—" : fmt.year(after.retirementYear),
      // Later is worse for someone aiming to stop work early; earlier is better.
      tone:
        before.retirementYear === null || after.retirementYear === null
          ? "neutral"
          : after.retirementYear > before.retirementYear
            ? "bad"
            : "good",
    });
  return out;
}

interface Mark {
  year: number;
  label: string;
}

/**
 * Retirement gets a full labelled line on the chart; every other milestone is a small tick on the x axis,
 * named in the readout when its year is selected.
 */
export function splitMarkers(markers: readonly Mark[]): { guides: Guide[]; ticks: Mark[] } {
  const isRetire = (m: Mark) => /retire/i.test(m.label);
  const retire = markers.find(isRetire);
  return {
    guides: retire ? [{ year: retire.year, label: retire.label, tone: "neutral" }] : [],
    ticks: markers.filter((m) => m !== retire),
  };
}

export const markersAt = (markers: readonly Mark[], year: number | undefined) =>
  year === undefined ? [] : markers.filter((m) => m.year === year).map((m) => m.label);

/** One line when the what-if leaves the plan worse off, or null. */
export function worseWarning(
  before: OutcomeNumbers,
  after: OutcomeNumbers,
  fmt: Formatter,
  retirementLabel = "Retirement",
): string | null {
  if (after.depletionYear !== null && before.depletionYear === null)
    return `This change makes your plan run short in ${fmt.year(after.depletionYear)}.`;
  if (
    after.depletionYear !== null &&
    before.depletionYear !== null &&
    after.depletionYear < before.depletionYear
  )
    return `This change makes your plan run short sooner, in ${fmt.year(after.depletionYear)} instead of ${fmt.year(before.depletionYear)}.`;
  if (
    before.successRate !== null &&
    after.successRate !== null &&
    before.successRate - after.successRate >= 0.05 - 1e-9
  )
    return `This change lowers your chance of success from ${fmt.percent(before.successRate, 0)} to ${fmt.percent(after.successRate, 0)}.`;
  if (
    before.retirementYear !== null &&
    after.retirementYear !== null &&
    after.retirementYear > before.retirementYear
  )
    return `This change moves ${retirementLabel} later, from ${fmt.year(before.retirementYear)} to ${fmt.year(after.retirementYear)}.`;
  return null;
}
