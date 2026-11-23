/**
 * Goal-seek controls that must not fight the keyboard. The trials field used to clamp on every
 * keystroke (`5` became `100`, then the next digit appended), so a typed value jumped upward.
 * The text stays as typed until blur or Solve, which is when it is clamped into range.
 */
import { Loader2 } from "lucide-react";
import { type Ref, useCallback, useImperativeHandle, useRef, useState } from "react";
import { Field, Input } from "../../components/ui/input";

export const GOAL_SEEK_TRIALS_MIN = 100;
export const GOAL_SEEK_TRIALS_MAX = 2_000;
export const GOAL_SEEK_TRIALS_DEFAULT = 300;
/** A full search is a few dozen evaluations, so this many trials per evaluation runs for minutes. */
export const GOAL_SEEK_SLOW_TRIALS = 1_000;

export type TrialsAdjustment = "min" | "max" | null;

export interface TrialsCommit {
  value: number;
  adjusted: TrialsAdjustment;
}

/**
 * Parse a typed trial count. Empty or non-numeric text keeps `fallback`, so clearing the field
 * does not jump to the minimum. Numbers outside 100–2,000 clamp, and `adjusted` says which way.
 */
export function commitGoalSeekTrials(text: string, fallback: number): TrialsCommit {
  const trimmed = text.trim();
  const fallbackValue = clampTrials(fallback);
  if (!/^\d+$/.test(trimmed)) return { value: fallbackValue, adjusted: null };
  const n = Number(trimmed);
  const value = clampTrials(n);
  if (n < GOAL_SEEK_TRIALS_MIN) return { value, adjusted: "min" };
  if (n > GOAL_SEEK_TRIALS_MAX) return { value, adjusted: "max" };
  return { value, adjusted: null };
}

function clampTrials(n: number): number {
  if (!Number.isFinite(n)) return GOAL_SEEK_TRIALS_DEFAULT;
  return Math.min(GOAL_SEEK_TRIALS_MAX, Math.max(GOAL_SEEK_TRIALS_MIN, Math.round(n)));
}

export function trialsHint(
  committed: number,
  draft: string,
  adjusted: TrialsAdjustment,
  format: (n: number) => string,
): string {
  const range = `Between ${format(GOAL_SEEK_TRIALS_MIN)} and ${format(GOAL_SEEK_TRIALS_MAX)}.`;
  if (adjusted === "min") return `Raised to ${format(GOAL_SEEK_TRIALS_MIN)}, the minimum. ${range}`;
  if (adjusted === "max")
    return `Lowered to ${format(GOAL_SEEK_TRIALS_MAX)}, the maximum. This many trials can take a few minutes.`;
  const typed = /^\d+$/.test(draft.trim()) ? Number(draft.trim()) : committed;
  if (typed >= GOAL_SEEK_SLOW_TRIALS) return `${range} This many trials can take a few minutes.`;
  return `${range} Every candidate uses the same random seed.`;
}

/**
 * What the search is doing right now. `evals` is how many candidates have finished; trial progress
 * belongs to the one in flight, so the label counts that one ahead of `evals`.
 */
export function goalSeekSearchLabel(
  evals: number,
  trialsDone: number,
  trialsTotal: number,
): string {
  const inFlight = trialsTotal > 0 && trialsDone < trialsTotal;
  if (evals === 0 && !inFlight) return "Starting the search…";
  if (inFlight) return `Searching… evaluation ${evals + 1}`;
  return `Searching… ${evals} ${evals === 1 ? "evaluation" : "evaluations"} so far`;
}

export interface GoalSeekTrialsHandle {
  /** Parse the field, clamp it, and return the count Solve should use. */
  commit(): number;
}

function formatCount(n: number): string {
  return n.toLocaleString();
}

export function GoalSeekTrialsField({
  ref,
  value,
  onCommit,
  format = formatCount,
  disabled = false,
}: {
  ref?: Ref<GoalSeekTrialsHandle>;
  value: number;
  onCommit: (value: number) => void;
  format?: (n: number) => string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const [adjusted, setAdjusted] = useState<TrialsAdjustment>(null);
  const textRef = useRef(text);
  const valueRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  textRef.current = text;
  valueRef.current = value;
  onCommitRef.current = onCommit;

  const apply = useCallback((raw: string) => {
    const next = commitGoalSeekTrials(raw, valueRef.current);
    const shown = String(next.value);
    textRef.current = shown;
    // Solve disables the field, which blurs it and commits the clamped text a second time.
    // That pass is in range, so keep the note from the pass that actually clamped.
    setAdjusted((prev) =>
      next.adjusted === null && shown === String(valueRef.current) ? prev : next.adjusted,
    );
    setText(shown);
    onCommitRef.current(next.value);
    return next.value;
  }, []);

  useImperativeHandle(ref, () => ({ commit: () => apply(textRef.current) }), [apply]);

  return (
    <Field label="Trials per evaluation" hint={trialsHint(value, text, adjusted, format)}>
      {(id, a11y) => (
        <Input
          id={id}
          {...a11y}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={text}
          onChange={(e) => {
            const next = e.target.value.replace(/\D/g, "");
            // Setting the value from a commit can emit a change for the same text. That is not an edit.
            if (next === textRef.current) return;
            textRef.current = next;
            setAdjusted(null);
            setText(next);
          }}
          onBlur={() => apply(textRef.current)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            apply(textRef.current);
          }}
        />
      )}
    </Field>
  );
}

export function GoalSeekSearchStatus({
  evals,
  trialsDone,
  trialsTotal,
  format = formatCount,
}: {
  evals: number;
  trialsDone: number;
  trialsTotal: number;
  format?: (n: number) => string;
}) {
  const label = goalSeekSearchLabel(evals, trialsDone, trialsTotal);
  const pct = trialsTotal > 0 ? Math.min(100, Math.round((trialsDone / trialsTotal) * 100)) : 0;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5" aria-busy="true">
      <span className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        <span aria-live="polite">{label}</span>
      </span>
      {trialsTotal > 0 ? (
        <>
          <div
            className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={trialsTotal}
            aria-valuenow={trialsDone}
            aria-label="Trials in this evaluation"
          >
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[12px] text-ink-3">
            {format(trialsDone)} of {format(trialsTotal)} trials in this evaluation
          </p>
        </>
      ) : null}
    </div>
  );
}
