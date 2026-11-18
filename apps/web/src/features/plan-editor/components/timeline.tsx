/**
 * The plan timeline: years along the top, each person's age beneath, then milestones, income,
 * spending and saving as bars. Every item is a button that opens its editor. Bars are packed into
 * lanes so nothing overlaps; the retired period is shaded; "now" is marked.
 */
import type { Frequency, Plan } from "@glideworth/core";
import { ChevronDown, ChevronRight, Flag, UserRound } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { AppearanceDot, appearanceColor } from "../../../components/ui/appearance-picker";
import { cn } from "../../../lib/cn";
import { countryLabel } from "../../../lib/countries";
import { useFormat } from "../../../lib/workspace";
import { countryColor, hasMoves, residenceSegments } from "../../crossborder/model";
import { useEditorStore } from "../state/doc-store";
import { monthIndex } from "../state/finance-math";
import { amountUnit } from "../state/labels";
import { formatMonthIndex, resolveRef, type TimeContext } from "../state/resolve";

export type TimelineTarget = { kind: "income" | "expense" | "milestone" | "flow"; id: string };

interface Bar {
  id: string;
  name: string;
  start: number;
  end: number;
  open: boolean;
  once: boolean;
  enabled: boolean;
  color: string;
  label: string;
}

const LABEL_W = 108;
const ROW_H = 22;

function pack(bars: Bar[]): Bar[][] {
  const lanes: Bar[][] = [];
  for (const b of [...bars].sort((a, c) => a.start - c.start || c.end - a.end)) {
    const lane = lanes.find((l) => l[l.length - 1]!.end + 2 <= b.start);
    if (lane) lane.push(b);
    else lanes.push([b]);
  }
  return lanes;
}

export function Timeline({
  plan,
  tctx,
  onOpen,
  collapsed,
  onToggle,
}: {
  plan: Plan;
  tctx: TimeContext;
  onOpen: (t: TimelineTarget) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const f = useFormat();
  const wrap = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(800);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth - LABEL_W - 16));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const start = tctx.start;
  const end = Math.max(tctx.end, start + 12);
  const years = (end - start) / 12;
  const px = Math.max(16, avail / years);
  const width = Math.ceil(years * px);
  const x = (m: number) => ((Math.min(Math.max(m, start), end) - start) / 12) * px;

  const amountLabel = (e: { amount: { value: number }; type: string; frequency: Frequency }) =>
    `${f.money(e.amount.value, true)}${amountUnit(e)}`;

  const toBars = (
    items: (Plan["income"][number] | Plan["expenses"][number])[],
    base: number,
  ): Bar[] =>
    items.flatMap((e, i) => {
      const s = resolveRef(e.range.start, tctx);
      if (s === null) return [];
      const once = e.frequency === "once";
      const en = once ? s + 1 : resolveRef(e.range.end, tctx);
      return [
        {
          id: e.id,
          name: e.name,
          start: s,
          end: en === null ? end : en,
          open: en === null,
          once,
          enabled: e.enabled,
          color: appearanceColor(e.appearance?.color, base + i),
          label: amountLabel(e),
        },
      ];
    });

  const income = pack(toBars(plan.income, 0));
  const expenses = pack(toBars(plan.expenses, 3));
  const flows = pack(
    plan.flows.flatMap((fl, i) => {
      const s = resolveRef(fl.range.start, tctx);
      if (s === null) return [];
      const en = resolveRef(fl.range.end, tctx);
      return [
        {
          id: fl.id,
          name: fl.name,
          start: s,
          end: en ?? end,
          open: en === null,
          once: false,
          enabled: fl.enabled,
          color: `var(--chart-${(i % 4) + 2})`,
          label: `#${i + 1}`,
        },
      ];
    }),
  );
  const milestones = plan.milestones
    .filter((m) => m.enabled)
    .map((m, i) => ({ m, at: tctx.milestoneMonth[m.id] ?? null, i }))
    .filter(
      (x): x is { m: Plan["milestones"][number]; at: number; i: number } =>
        x.at !== null && x.at >= start && x.at <= end,
    )
    .sort((a, b) => a.at - b.at);
  // Alternate milestone labels over two rows when close together.
  const msRows: number[] = [];
  milestones.forEach((ms, k) => {
    const prev = milestones[k - 1];
    msRows.push(prev && x(ms.at) - x(prev.at) < 110 ? 1 - (msRows[k - 1] ?? 0) : 0);
  });

  // Residence per person, only when the plan moves someone (single-country plans look as before).
  const location = useEditorStore((s) => s.draft?.household.location);
  const moving = !!location && hasMoves(plan);
  const residence = moving
    ? residenceSegments(plan, { people: tctx.people, location }, { ...tctx, end })
    : [];
  const personRowH = moving ? 34 : 24;

  const retire = plan.milestones.find((m) => m.kind === "retirement" && m.enabled);
  const retireAt = retire ? tctx.milestoneMonth[retire.id] : null;

  const firstTickYear = Math.ceil(start / 12 / 5) * 5;
  const gridOffset = x(firstTickYear * 12) % (px * 5);
  const grid: CSSProperties = {
    width,
    backgroundImage: "linear-gradient(to right, var(--chart-grid) 1px, transparent 1px)",
    backgroundSize: `${px * 5}px 100%`,
    backgroundPosition: `${gridOffset}px 0`,
  };
  const ticks: number[] = [];
  for (let y = firstTickYear; y * 12 <= end; y += 5) ticks.push(y);

  const rowLabel = (content: ReactNode, h: number) => (
    <div
      className="sticky left-0 z-10 flex shrink-0 items-start bg-surface pt-1 pr-2 text-[11.5px] font-medium text-ink-2"
      style={{ width: LABEL_W, height: h }}
    >
      {content}
    </div>
  );

  const lane = (title: string, lanes: Bar[][], kind: TimelineTarget["kind"], empty: string) => {
    const h = Math.max(1, lanes.length) * (ROW_H + 4) + 6;
    return (
      <div className="flex border-t border-border/70">
        {rowLabel(
          <span>
            {title}
            <span className="ml-1 font-normal text-ink-3">{lanes.flat().length || ""}</span>
          </span>,
          h,
        )}
        <div className="relative" style={{ ...grid, height: h }}>
          {lanes.length === 0 ? (
            <div className="absolute top-1.5 left-2 text-[11px] text-ink-3">{empty}</div>
          ) : null}
          {lanes.map((l, li) =>
            l.map((b) => {
              const left = x(b.start);
              const w = Math.max(b.once ? 10 : 6, x(b.end) - left);
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onOpen({ kind, id: b.id })}
                  aria-label={`${b.name}: ${formatMonthIndex(b.start, f.locale)}${b.once ? "" : ` to ${b.open ? "never" : formatMonthIndex(b.end, f.locale)}`}, ${b.label}${b.enabled ? "" : " (off)"}`}
                  title={`${b.name} · ${b.label}\n${formatMonthIndex(b.start, f.locale)}${b.once ? "" : ` → ${b.open ? "…" : formatMonthIndex(b.end, f.locale)}`}`}
                  className={cn(
                    "group absolute flex items-center overflow-hidden rounded-[5px] px-1.5 text-left text-[11px] font-medium whitespace-nowrap transition-[filter,box-shadow] hover:brightness-95 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-focus",
                    !b.enabled && "opacity-45",
                    b.once && "justify-center rounded-full px-0",
                  )}
                  style={{
                    left,
                    width: w,
                    top: 4 + li * (ROW_H + 4),
                    height: ROW_H,
                    background: `color-mix(in oklab, ${b.color} ${b.enabled ? 22 : 10}%, var(--surface))`,
                    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${b.color} 55%, transparent)`,
                    borderLeftWidth: b.once ? 0 : 3,
                    borderLeftStyle: b.enabled ? "solid" : "dashed",
                    borderLeftColor: b.color,
                    color: "var(--ink)",
                  }}
                >
                  {b.once ? (
                    <span className="size-1.5 rounded-full" style={{ background: b.color }} />
                  ) : w > 60 ? (
                    <span className="truncate">{b.name}</span>
                  ) : null}
                  {!b.once && w > 150 ? (
                    <span className="num ml-1.5 truncate font-normal text-ink-2">{b.label}</span>
                  ) : null}
                  {b.open && !b.once ? (
                    <span aria-hidden className="ml-auto pl-1 text-ink-2">
                      ›
                    </span>
                  ) : null}
                </button>
              );
            }),
          )}
        </div>
      </div>
    );
  };

  return (
    <section
      aria-label="Plan timeline"
      className="rounded-[var(--radius-card)] border border-border bg-surface shadow-card"
    >
      <header className="flex items-center justify-between gap-3 px-4 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 text-[13.5px] font-semibold pointer-coarse:min-h-11"
        >
          {collapsed ? (
            <ChevronRight className="size-4 text-ink-3" />
          ) : (
            <ChevronDown className="size-4 text-ink-3" />
          )}
          Timeline
          <span className="num ml-1 text-[12px] font-normal text-ink-3">
            {Math.floor(start / 12)}–{Math.floor((end - 1) / 12)} · {Math.round(years)} years
          </span>
        </button>
        {!collapsed ? (
          <div className="hidden items-center gap-3 text-[11px] text-ink-3 sm:flex">
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-4 rounded-sm bg-accent/15 ring-1 ring-accent/30" /> Retired
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-3 w-px bg-ochre" /> Today
            </span>
            {moving ? (
              <span className="inline-flex items-center gap-1">
                <span
                  className="h-2 w-4 rounded-sm"
                  style={{ background: "color-mix(in oklab, var(--chart-1) 45%, transparent)" }}
                />{" "}
                Country of residence
              </span>
            ) : null}
            <span>Click anything to edit</span>
          </div>
        ) : null}
      </header>
      {collapsed ? null : (
        <div
          ref={wrap}
          className="relative overflow-x-auto overscroll-x-contain pb-2"
          style={{ scrollbarWidth: "thin" }}
        >
          <div className="relative" style={{ width: width + LABEL_W }}>
            {/* retired shading + today line span all rows */}
            {retireAt != null && retireAt < end ? (
              <div
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-0 bg-accent/[0.06]"
                style={{ left: LABEL_W + x(retireAt), width: width - x(retireAt) }}
              />
            ) : null}
            <div
              aria-hidden
              className="pointer-events-none absolute top-0 bottom-0 z-[5] w-px bg-ochre"
              style={{ left: LABEL_W + x(start) + 1 }}
            />

            {/* axis */}
            <div className="flex">
              {rowLabel(<span className="text-ink-3">Year</span>, 22)}
              <div className="relative" style={{ ...grid, height: 22 }}>
                {ticks.map((y) => (
                  <span
                    key={y}
                    className="num absolute top-1 -translate-x-1/2 text-[11px] text-ink-3"
                    style={{ left: x(y * 12) }}
                  >
                    {y}
                  </span>
                ))}
              </div>
            </div>

            {/* people */}
            {tctx.people.map((p, pi) => {
              const birth = monthIndex(p.birthMonth);
              const le = plan.milestones.find(
                (m) => m.kind === "life-expectancy" && m.personId === p.id,
              );
              const leAt = le ? tctx.milestoneMonth[le.id] : null;
              const ages: number[] = [];
              const a0 = Math.ceil((start - birth) / 12 / 5) * 5;
              for (let a = a0; birth + a * 12 <= end; a += 5) ages.push(a);
              return (
                <div key={p.id} className="flex border-t border-border/70">
                  {rowLabel(
                    <span className="flex min-w-0 items-center gap-1.5">
                      <AppearanceDot
                        appearance={p.appearance}
                        fallbackIndex={pi}
                        fallbackIcon={UserRound}
                        size={16}
                      />
                      <span className="truncate">{p.name}</span>
                    </span>,
                    personRowH,
                  )}
                  <div className="relative" style={{ ...grid, height: personRowH }}>
                    <div
                      className="absolute top-[11px] h-px bg-border-strong"
                      style={{ left: 0, width: leAt != null ? x(leAt) : width }}
                    />
                    {ages.map((a) => (
                      <span
                        key={a}
                        className="num absolute top-1 -translate-x-1/2 rounded bg-surface px-1 text-[10.5px] text-ink-2"
                        style={{ left: x(birth + a * 12) }}
                      >
                        {a}
                      </span>
                    ))}
                    {residence
                      .filter((r) => r.personId === p.id)
                      .map((r, ri) => (
                        <div
                          key={`${r.from}-${r.location.country}`}
                          className="absolute bottom-1 flex h-[9px] items-center overflow-visible"
                          title={`${p.name} lives in ${countryLabel(r.location.country)} from ${formatMonthIndex(r.from, f.locale)}`}
                          style={{
                            left: x(r.from),
                            width: Math.max(2, x(r.to) - x(r.from)),
                            background: `color-mix(in oklab, ${countryColor(r.location.country, location!.country)} 45%, transparent)`,
                            borderLeft:
                              ri > 0
                                ? `2px solid ${countryColor(r.location.country, location!.country)}`
                                : undefined,
                          }}
                        >
                          {x(r.to) - x(r.from) > 26 ? (
                            <span className="num pl-1 text-[9.5px] leading-none font-semibold text-ink">
                              {r.location.country}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    {leAt != null && leAt <= end ? (
                      <span
                        className="absolute top-1 -translate-x-full pr-1 text-[10.5px] text-ink-3"
                        style={{ left: x(leAt) }}
                      >
                        ✝︎
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}

            {/* milestones */}
            <div className="flex border-t border-border/70">
              {rowLabel(<span>Milestones</span>, 44)}
              <div className="relative" style={{ ...grid, height: 44 }}>
                {milestones.map(({ m, at, i }, k) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => onOpen({ kind: "milestone", id: m.id })}
                    aria-label={`${m.name}, ${formatMonthIndex(at, f.locale)}`}
                    className={cn(
                      "group absolute flex items-center gap-1 rounded focus-visible:ring-2 focus-visible:ring-focus",
                      x(at) > width - 150 && "flex-row-reverse",
                    )}
                    style={{
                      left: x(at),
                      top: 4 + msRows[k]! * 19,
                      transform:
                        x(at) > width - 150 ? "translateX(calc(-100% + 5px))" : "translateX(-5px)",
                    }}
                  >
                    <span
                      className="size-2.5 rotate-45 rounded-[2px] ring-2 ring-surface"
                      style={{ background: appearanceColor(m.appearance?.color, i + 2) }}
                    />
                    <span className="max-w-[140px] truncate rounded bg-surface/90 px-0.5 text-[11px] font-medium text-ink group-hover:text-accent">
                      {m.name}
                    </span>
                  </button>
                ))}
                {milestones.length === 0 ? (
                  <div className="absolute top-3 left-2 flex items-center gap-1 text-[11px] text-ink-3">
                    <Flag className="size-3" /> No milestones resolve in range
                  </div>
                ) : null}
              </div>
            </div>

            {lane("Income", income, "income", "No income yet")}
            {lane("Spending", expenses, "expense", "No expenses yet")}
            {lane("Saving", flows, "flow", "No flows yet")}
          </div>
        </div>
      )}
    </section>
  );
}
