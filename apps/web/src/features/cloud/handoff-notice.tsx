/**
 * Where a calculator hand-off shows up: the welcome screen (a new account), the guided setup, and
 * the dashboard when the person is already signed in with a household.
 */
import { Link } from "@tanstack/react-router";
import { ArrowRight, Calculator } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { useSession } from "../../lib/auth";
import { useWorkspace } from "../../lib/workspace";
import {
  applyHandoff,
  clearHandoff,
  handoffHighlights,
  type Handoff,
  HANDOFF_TOOLS,
  parseHandoff,
  readHandoff,
  stashHandoff,
} from "./handoff";

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

/**
 * Dashboard, for someone who already has a household. The current plan stays as it is. "Start a new
 * plan" only opens guided setup, which asks before it replaces anything.
 */
export function SignedInHandoffOffer({
  handoff,
  canWrite,
  onDismiss,
}: {
  handoff: Handoff;
  canWrite: boolean;
  onDismiss: () => void;
}) {
  const highlights = handoffHighlights(handoff);
  const { skipped } = applyHandoff(handoff);
  const tool = HANDOFF_TOOLS[handoff.tool];
  return (
    <section
      aria-label="Calculator inputs"
      className="no-print flex flex-col gap-3 rounded-xl border border-accent/40 bg-accent-soft/50 px-4 py-3.5 sm:flex-row sm:items-center"
    >
      <Calculator className="size-5 shrink-0 text-accent" aria-hidden />
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink">
        <p>
          <span className="font-semibold">
            {highlights.length
              ? `These ${tool} inputs are ready.`
              : `The ${tool} inputs could not be applied.`}
          </span>{" "}
          Your current plan is unchanged.
        </p>
        {highlights.length ? (
          <p className="mt-1 text-ink-2">
            {highlights.join(", ")}.
            {canWrite
              ? " Start a new plan from them in guided setup. Nothing is replaced until you finish and confirm."
              : " They were not applied, and this workspace cannot be edited from here."}
            {skipped.length ? " Return, tax and saving from the calculator are not copied." : ""}
          </p>
        ) : (
          <p className="mt-1 text-ink-2">Nothing from that link was filled in.</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {canWrite && highlights.length ? (
          <Button variant="primary" size="sm" asChild>
            <Link to="/welcome/setup">
              Start a new plan <ArrowRight />
            </Link>
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Keep my current plan
        </Button>
      </div>
    </section>
  );
}

/** Reads a stored (or just-arrived) hand-off and shows it on the dashboard of an existing household. */
export function CalculatorHandoffBanner() {
  const session = useSession().data;
  const cloud = session?.kind === "authenticated" && session.cloud !== undefined;
  const { data: ws } = useWorkspace();
  const [handoff, setHandoff] = useState<Handoff | null>(() => (cloud ? readHandoff() : null));
  useEffect(() => {
    if (!cloud) return;
    // The sign-up redirect drops the query. If it is still here (a link opened while signed in, or
    // storage was blocked on the way), keep it now. Then drop it from the address bar, so declining
    // the offer is not undone by the next visit to the dashboard.
    const fromUrl = parseHandoff(window.location.search);
    if (fromUrl) {
      stashHandoff(fromUrl);
      const url = new URL(window.location.href);
      url.search = "";
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.hash}`);
    }
    setHandoff(readHandoff());
  }, [cloud]);
  if (session?.kind !== "authenticated" || !session.cloud || !handoff) return null;
  // A brand-new account is offered the same inputs on the welcome screen, not over an empty dashboard.
  if (!ws || ws.source !== "api" || ws.firstRun) return null;
  const level = session.cloud.workspace?.access?.level;
  const canWrite = session.user?.role !== "viewer" && (level === undefined || level === "full");
  return (
    <SignedInHandoffOffer
      handoff={handoff}
      canWrite={canWrite}
      onDismiss={() => {
        clearHandoff();
        setHandoff(null);
      }}
    />
  );
}
