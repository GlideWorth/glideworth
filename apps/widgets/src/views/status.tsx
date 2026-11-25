/** The states with no payload: waiting for a result, cancelled, or a tool error. */

function Mark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" className="mark">
      <path
        d="M3 21 C 9 21, 12 9, 25 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="25" cy="7" r="2.5" fill="currentColor" />
    </svg>
  );
}

export function EmptyState({ reason }: { reason: "waiting" | "cancelled" | "none" }) {
  const text =
    reason === "waiting"
      ? "Working on your plan…"
      : reason === "cancelled"
        ? "This request was cancelled."
        : "Nothing to show for this answer.";
  return (
    <main className="shell state" aria-live="polite" aria-busy={reason === "waiting" || undefined}>
      <Mark />
      <p className="headline">{text}</p>
      <footer className="shell-foot">
        <span>Estimates, not financial advice.</span>
      </footer>
    </main>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <main className="shell state" role="alert">
      <Mark />
      <p className="headline">Glideworth couldn’t show this.</p>
      <p className="muted">{message}</p>
      <footer className="shell-foot">
        <span>Estimates, not financial advice.</span>
      </footer>
    </main>
  );
}
