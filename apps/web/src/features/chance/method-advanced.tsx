/**
 * The Monte Carlo method choice, wherever its settings are edited: the method in use is stated in
 * one line, and the picker (with any method-specific fields) sits under a collapsed "Advanced"
 * disclosure. New plans use the schema default; stored plans keep their own method.
 */
import { MonteCarloSettings, SAMPLING_METHOD_LABEL, type SamplingMethod } from "@glideworth/core";
import type { ReactNode } from "react";

/** The method a new plan gets (the schema default). */
export const DEFAULT_SAMPLING_METHOD: SamplingMethod = MonteCarloSettings.shape.method.parse(
  undefined,
) as SamplingMethod;

/** Options for a method <Select>, the default first. */
export const SAMPLING_METHOD_OPTIONS = [
  DEFAULT_SAMPLING_METHOD,
  ...(Object.keys(SAMPLING_METHOD_LABEL) as SamplingMethod[]).filter(
    (m) => m !== DEFAULT_SAMPLING_METHOD,
  ),
].map((m) => ({
  value: m,
  label: SAMPLING_METHOD_LABEL[m],
  ...(m === DEFAULT_SAMPLING_METHOD ? { hint: "Default" } : {}),
}));

export function MethodAdvanced({
  method,
  children,
}: {
  method: SamplingMethod;
  /** The method picker and any fields only that method uses. */
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12.5px] text-ink-2">
        Market paths: <span className="font-medium text-ink">{SAMPLING_METHOD_LABEL[method]}</span>
        {method === DEFAULT_SAMPLING_METHOD ? " (default)" : null}
      </p>
      <details className="rounded-md border border-border bg-surface-2/50 px-3 py-2 text-[12.5px]">
        <summary className="cursor-pointer font-medium text-ink">Advanced</summary>
        <div className="mt-2 flex flex-col gap-3">{children}</div>
      </details>
    </div>
  );
}
