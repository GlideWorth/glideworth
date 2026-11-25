import { useEffect, useState } from "react";
import { Actions, Button, Notice, Shell } from "../components/ui";
import { messageOf, useWidget } from "../context";
import { bodyOf, payloadFrom } from "../routing";
import type { PendingView as PendingViewData } from "../types";

type Phase = "running" | "slow" | "failed";

export function PendingView({ data }: { data: PendingViewData }) {
  const { call, replace, timing } = useWidget();
  const [phase, setPhase] = useState<Phase>("running");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const of = data.of;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    let polls = 0;
    let errors = 0;

    const schedule = () => {
      if (Date.now() - startedAt >= timing.pollGiveUpMs) {
        setPhase("slow");
        return;
      }
      const backoff = timing.pollBackoffMs;
      const delay = backoff[Math.min(polls, backoff.length - 1)] ?? 0;
      polls += 1;
      timer = setTimeout(() => void tick(), delay);
    };

    const tick = async () => {
      try {
        const result = await call("get_job", { jobId: data.jobId, wait: timing.pollWaitSeconds });
        if (cancelled) return;
        errors = 0;
        const payload = payloadFrom(result);
        if (payload?.view === of) {
          replace(payload);
          return;
        }
        const body = bodyOf(result);
        if (body.status === "failed" || body.status === "cancelled") {
          setError(
            typeof body.error === "string"
              ? body.error
              : body.status === "cancelled"
                ? "The run was cancelled."
                : "The run didn't finish.",
          );
          setPhase("failed");
          return;
        }
        if (typeof body.progress === "number") setProgress(body.progress);
      } catch (err) {
        if (cancelled) return;
        errors += 1;
        if (errors >= 4) {
          setError(messageOf(err));
          setPhase("failed");
          return;
        }
      }
      schedule();
    };

    setPhase("running");
    setError(null);
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [attempt, call, data.jobId, of, replace, timing]);

  const pct = progress !== null ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : null;

  return (
    <Shell plan={data.plan} title={of === "answer" ? "Working it out" : "Will my money last?"}>
      <section className="pending" aria-live="polite">
        {phase === "running" ? (
          <>
            <div
              className="progress"
              role="progressbar"
              aria-label={of === "answer" ? "Working out the answer" : "Running market simulations"}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct ?? undefined}
            >
              <div
                className={pct === null ? "progress-bar is-indeterminate" : "progress-bar"}
                style={pct === null ? undefined : { width: `${Math.max(4, pct)}%` }}
              />
            </div>
            <p className="headline">
              {of === "answer"
                ? "Working out the answer…"
                : "Testing your plan against thousands of market paths…"}
            </p>
            <p className="muted small">
              This usually takes under a minute. The result appears here.
            </p>
          </>
        ) : null}
        {phase === "slow" ? (
          <>
            <p className="headline">This is taking longer than usual.</p>
            <Actions>
              <Button variant="primary" onClick={() => setAttempt((v) => v + 1)}>
                Check again
              </Button>
            </Actions>
          </>
        ) : null}
        {phase === "failed" ? (
          <>
            <Notice tone="bad">{error ?? "The run didn't finish."}</Notice>
            <Actions>
              <Button onClick={() => setAttempt((v) => v + 1)}>Try again</Button>
            </Actions>
          </>
        ) : null}
      </section>
    </Shell>
  );
}
