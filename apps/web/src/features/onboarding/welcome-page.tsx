/**
 * First-run landing: start from scratch, explore a sample household, or bring data across.
 * Also reachable later from the command palette ("Welcome & setup").
 */
import {
  createSampleDocument,
  createUaeSampleDocument,
  createUkSampleDocument,
} from "@glideworth/core/samples";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, FileUp, Loader2, Mountain, ShieldCheck, Sprout } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Wordmark } from "../../components/layout/logo";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { toast } from "../../components/ui/toaster";
import { isExplainedProblem } from "../../lib/api-problems";
import { useMode } from "../../lib/auth";
import { useWorkspace } from "../../lib/workspace";
import { usePrefs } from "../../stores/prefs";
import { clearHandoff, readHandoff } from "../cloud/handoff";
import { HandoffOffer } from "../cloud/handoff-notice";
import { persistWorkspace } from "../import/persist";

const SAMPLES = [
  {
    id: "uk",
    label: "Sam",
    detail: "UK · single · ISA, SIPP and workplace pension · retiring at 60",
    build: createUkSampleDocument,
  },
  {
    id: "us",
    label: "Avery & Jordan",
    detail: "US couple · 401(k), Roth and brokerage · home with a mortgage",
    build: createSampleDocument,
  },
  {
    id: "ae",
    label: "Noor & Ellis",
    detail: "UAE couple · dirhams, gratuity, DEWS, a UK pension · a plan that moves back to the UK",
    build: createUaeSampleDocument,
  },
] as const;

export function WelcomePage() {
  const { data: ws } = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const setPrefs = usePrefs((s) => s.set);
  const [busy, setBusy] = useState<string | null>(null);
  const cloud = useMode() === "cloud";
  const [handoff, setHandoff] = useState(() => (cloud ? readHandoff() : null));
  const hasData = ws?.source === "api";
  const offline = ws && ws.source === "sample" && !ws.firstRun;

  const loadSample = async (s: (typeof SAMPLES)[number]) => {
    if (
      hasData &&
      !(await confirmAction({
        title: `Replace your data with the ${s.label} sample?`,
        description:
          "Your current household, plans and history will be replaced. Download a backup first from Import & export if you might want them back.",
        confirmLabel: "Replace with sample",
      }))
    )
      return;
    setBusy(s.id);
    try {
      const out = await persistWorkspace(qc, s.build());
      setPrefs({ tour: "welcome" });
      toast({
        title: `Loaded the ${s.label} sample`,
        description:
          out.where === "server"
            ? "Every name and number is invented. Explore freely; replace it with your own data any time."
            : "The server is offline, so the sample lives in this browser only.",
        tone: "positive",
      });
      await navigate({ to: "/" });
    } catch (e) {
      // A read-only workspace or a used-up limit is already explained by the shell.
      if (!isExplainedProblem(e))
        toast({
          title: "Could not load the sample",
          description: e instanceof Error ? e.message : String(e),
          tone: "negative",
        });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative min-h-dvh overflow-hidden">
      <Contours />
      <div className="relative mx-auto flex w-full max-w-[1080px] flex-col px-4 pt-5 pb-12 sm:px-8">
        <header className="flex items-center justify-between">
          <Wordmark />
          {hasData ? (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/">
                Back to your dashboard <ArrowRight />
              </Link>
            </Button>
          ) : null}
        </header>

        <section className="max-w-[640px] pt-14 pb-10 sm:pt-20">
          <p className="eyebrow">Welcome</p>
          <h1
            className="display mt-2 text-[34px] leading-[1.08] font-semibold text-balance outline-none sm:text-[46px]"
            tabIndex={-1}
          >
            Plan the long road, one year at a time.
          </h1>
          <p className="mt-4 max-w-[560px] text-[15px] leading-relaxed text-ink-2 text-pretty">
            Glideworth models your money year by year: what you own today, what you will earn and
            spend, and how likely the plan is to hold up across a thousand different markets. Start
            whichever way suits you; you can change everything later.
          </p>
          {offline ? (
            <p className="mt-4 inline-flex rounded-md bg-ochre-soft px-3 py-2 text-[12.5px] text-ochre">
              The Glideworth server is not reachable, so whatever you set up now will live in this
              browser only.
            </p>
          ) : null}
        </section>

        {handoff ? (
          <HandoffOffer
            handoff={handoff}
            onDismiss={() => {
              clearHandoff();
              setHandoff(null);
            }}
          />
        ) : null}
        <div className="grid gap-4 md:grid-cols-3">
          <Choice
            icon={<Sprout className="size-5" />}
            title="Start from scratch"
            body="A two-minute guided setup: where you live, who is in the plan, a few balances, income, spending and when you would like to retire."
            footer={
              <Button variant="primary" className="w-full" asChild>
                <Link to="/welcome/setup">
                  Begin setup <ArrowRight />
                </Link>
              </Button>
            }
            accent
          />
          <Choice
            icon={<Mountain className="size-5" />}
            title="Explore a sample household"
            body="Fully worked examples with invented people and numbers. A good way to see what Glideworth can do before entering your own."
            footer={
              <div className="flex flex-col gap-2">
                {SAMPLES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    disabled={!!busy}
                    onClick={() => void loadSample(s)}
                    className="group flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-left transition-colors hover:border-accent/50 hover:bg-accent-soft/40 disabled:opacity-60"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-ink">{s.label}</div>
                      <div className="text-[11.5px] leading-snug text-ink-3">{s.detail}</div>
                    </div>
                    {busy === s.id ? (
                      <Loader2 className="size-4 animate-spin text-accent" />
                    ) : (
                      <ArrowRight className="size-4 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
                    )}
                  </button>
                ))}
              </div>
            }
          />
          <Choice
            icon={<FileUp className="size-5" />}
            title="Bring your data"
            body="Moving from ProjectionLab? Import its JSON export with a full report of what mapped. Or bring CSVs of balances, net-worth history or transactions."
            footer={
              <div className="flex flex-col gap-2">
                <Button className="w-full" asChild>
                  <Link to="/import" search={{ tab: "projectionlab" }}>
                    Import from ProjectionLab
                  </Link>
                </Button>
                <Button variant="ghost" className="w-full" asChild>
                  <Link to="/import" search={{ tab: "csv" }}>
                    Import CSV files
                  </Link>
                </Button>
              </div>
            }
          />
        </div>

        <footer className="mt-10 flex items-start gap-3 rounded-xl border border-border bg-surface/70 px-4 py-3.5 text-[12.5px] leading-relaxed text-ink-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          {cloud ? (
            <p>
              <span className="font-semibold text-ink">Your data stays yours.</span> Your plans are
              saved in your workspace, which only its members can open. Files you import are read in
              this browser, and simulations run here too. You can export or delete the workspace at
              any time in Settings.
            </p>
          ) : (
            <p>
              <span className="font-semibold text-ink">Your data stays yours.</span> Glideworth runs
              on your own machine or server. Files you import are read in this browser, and
              simulations run here too; nothing is sent to a third party, and there is no account to
              create.
            </p>
          )}
        </footer>
      </div>
    </div>
  );
}

function Choice({
  icon,
  title,
  body,
  footer,
  accent,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  footer: ReactNode;
  accent?: boolean;
}) {
  return (
    <section
      className={`flex flex-col gap-3 rounded-xl border bg-surface p-5 shadow-card ${accent ? "border-accent/40" : "border-border"}`}
    >
      <div
        className={`flex size-9 items-center justify-center rounded-lg ${accent ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2"}`}
      >
        {icon}
      </div>
      <h2 className="display text-[19px] leading-snug font-semibold">{title}</h2>
      <p className="flex-1 text-[13px] leading-relaxed text-ink-2">{body}</p>
      <div className="pt-1">{footer}</div>
    </section>
  );
}

/** Quiet topographic contours behind the hero. Decorative only. */
function Contours() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute -top-24 -right-40 h-[620px] w-[900px] text-border opacity-80"
      viewBox="0 0 900 620"
      fill="none"
    >
      {Array.from({ length: 9 }, (_, i) => {
        const r = 70 + i * 42;
        return (
          <path
            key={i}
            d={`M ${600 - r} 300 C ${600 - r} ${300 - r * 0.9}, ${600 + r * 1.1} ${300 - r * 0.8}, ${600 + r} 290 S ${600 - r * 0.3} ${300 + r * 0.95}, ${600 - r} 300 Z`}
            stroke="currentColor"
            strokeWidth={1}
          />
        );
      })}
      <circle cx="604" cy="282" r="6" fill="var(--ochre)" opacity="0.7" />
    </svg>
  );
}
