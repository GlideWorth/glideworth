import { type ReactNode, useId, useState } from "react";
import { useWidget } from "../context";
import type { PlanRef } from "../types";

export function Button(props: {
  children: ReactNode;
  onClick(): void;
  variant?: "primary" | "secondary" | "quiet";
  disabled?: boolean;
  busy?: boolean;
}) {
  const variant = props.variant ?? "secondary";
  return (
    <button
      type="button"
      className={`btn btn-${variant}`}
      onClick={props.onClick}
      disabled={props.disabled || props.busy}
      aria-busy={props.busy || undefined}
    >
      {props.busy ? <span className="spinner" aria-hidden="true" /> : null}
      {props.children}
    </button>
  );
}

export type Tone = "neutral" | "good" | "bad";

export function Chip(props: { label: string; value: string; tone?: Tone; detail?: string }) {
  return (
    <div className={`chip tone-${props.tone ?? "neutral"}`}>
      <span className="chip-label">{props.label}</span>
      <span className="chip-value num">{props.value}</span>
      {props.detail ? <span className="chip-detail num">{props.detail}</span> : null}
    </div>
  );
}

export function Chips({ children }: { children: ReactNode }) {
  return <div className="chips">{children}</div>;
}

export function Actions({ children }: { children: ReactNode }) {
  return <div className="actions">{children}</div>;
}

export function Collapsible(props: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const id = useId();
  return (
    <div className="collapsible">
      <button
        type="button"
        className="collapsible-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{props.title}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="chevron">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open ? (
        <div id={id} className="collapsible-body">
          {props.children}
        </div>
      ) : null}
    </div>
  );
}

export function Notice(props: { tone?: "info" | "good" | "bad"; children: ReactNode }) {
  return (
    <div className={`notice notice-${props.tone ?? "info"}`} role="status">
      {props.children}
    </div>
  );
}

/** Before → after rows for a list of readable changes. */
export function ChangeList(props: {
  changes: readonly { label: string; before: string | null; after: string | null }[];
}) {
  return (
    <ul className="changes">
      {props.changes.map((c) => (
        <li key={`${c.label}|${c.before}|${c.after}`}>
          <span className="change-label">{c.label}</span>
          {c.before !== null || c.after !== null ? (
            <span className="change-values num">
              {c.before !== null ? <span className="before">{c.before}</span> : null}
              {c.before !== null && c.after !== null ? (
                <span className="arrow" aria-label="to">
                  →
                </span>
              ) : null}
              {c.after !== null ? <span className="after">{c.after}</span> : null}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function FullscreenToggle() {
  const { host, hostState } = useWidget();
  const isFull = hostState.context.displayMode === "fullscreen";
  const target = isFull ? "inline" : "fullscreen";
  if (!host.canRequestDisplayMode(target)) return null;
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={isFull ? "Exit full screen" : "Full screen"}
      title={isFull ? "Exit full screen" : "Full screen"}
      onClick={() => void host.requestDisplayMode(target).catch(() => {})}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        {isFull ? (
          <path
            d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        ) : (
          <path
            d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        )}
      </svg>
    </button>
  );
}

/** The frame of every view: plan, basis, title, Back, full screen, and the quiet footer. */
export function Shell(props: {
  plan: PlanRef;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { host, back, canGoBack } = useWidget();
  const { plan } = props;
  return (
    <main className="shell">
      <header className="shell-head">
        <div className="shell-top">
          {canGoBack ? (
            <button type="button" className="back" onClick={back}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M8.5 3 4.5 7l4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
              </svg>
              Back
            </button>
          ) : null}
          <p className="eyebrow">
            <span className="plan-name">{plan.planName}</span>
            <span aria-hidden="true"> · </span>
            <span>today’s money</span>
          </p>
          <FullscreenToggle />
        </div>
        <h1 className="title">{props.title}</h1>
        {props.subtitle ? <p className="subtitle">{props.subtitle}</p> : null}
      </header>
      {props.children}
      <footer className="shell-foot">
        <span>Estimates, not financial advice.</span>
        {plan.appUrl ? (
          <button
            type="button"
            className="link"
            onClick={() => void host.openLink(plan.appUrl as string).catch(() => {})}
          >
            Open in Glideworth
          </button>
        ) : null}
      </footer>
    </main>
  );
}
