/** The two places a calculator hand-off shows up after sign-up: the welcome screen and the guided setup. */
import { Link } from "@tanstack/react-router";
import { ArrowRight, Calculator } from "lucide-react";
import { Button } from "../../components/ui/button";
import { applyHandoff, type Handoff, HANDOFF_TOOLS } from "./handoff";

/** Welcome screen: "Start from your calculator inputs". */
export function HandoffOffer({ handoff, onDismiss }: { handoff: Handoff; onDismiss: () => void }) {
  return (
    <section
      aria-label="Your calculator inputs"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft/50 px-4 py-3.5"
    >
      <Calculator className="size-5 shrink-0 text-accent" aria-hidden />
      <p className="min-w-0 flex-1 text-[13px] text-ink">
        <span className="font-semibold">Start from your calculator inputs.</span> You used the{" "}
        {HANDOFF_TOOLS[handoff.tool]} before signing up; we can fill in your first plan from it.
      </p>
      <Button variant="primary" size="sm" asChild>
        <Link to="/welcome/setup">
          Start from them <ArrowRight />
        </Link>
      </Button>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        No thanks
      </Button>
    </section>
  );
}

/** Guided setup, first step: what was filled in, what was not, and a way back to a blank start. */
export function HandoffApplied({ handoff, onReset }: { handoff: Handoff; onReset: () => void }) {
  const { used, skipped } = applyHandoff(handoff);
  return (
    <div
      role="note"
      className="mb-4 rounded-xl border border-accent/40 bg-accent-soft/50 px-4 py-3 text-[12.5px] text-ink-2"
    >
      <p>
        <span className="font-semibold text-ink">
          Filled in from your {HANDOFF_TOOLS[handoff.tool]} inputs
        </span>
        {used.length ? `: ${used.join(", ")}.` : "."} Check every step and change anything that is
        not right.
        {skipped.length
          ? " Return, tax and saving inputs are not carried over; set those in the plan editor, where the planner has its own assumptions and country tax estimate."
          : ""}
      </p>
      <button
        type="button"
        onClick={onReset}
        className="mt-1.5 text-accent underline underline-offset-2"
      >
        Start from scratch instead
      </button>
    </div>
  );
}
