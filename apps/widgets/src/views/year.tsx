import { Notice, Shell } from "../components/ui";
import { useFormatter } from "../context";
import type { Formatter } from "../format";
import type { YearView as YearViewData } from "../types";

/**
 * A horizontal waterfall: each step floats from the running total before it to the total after it. The scale
 * covers only the range the running total moves through, so a $60k step stays visible next to a $1.2M balance;
 * start and end are marked as points on that scale rather than bars from zero.
 */
function Waterfall({ data, fmt }: { data: YearViewData; fmt: Formatter }) {
  const points = [data.startNetWorth];
  for (const step of data.steps) points.push((points[points.length - 1] ?? 0) + step.amount);
  const all = [...points, data.endNetWorth];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = Math.max((hi - lo) * 0.06, 1);
  lo -= pad;
  hi += pad;
  const pos = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const summary = `Net worth from ${fmt.money(data.startNetWorth)} to ${fmt.money(data.endNetWorth)}: ${data.steps
    .map((s) => `${s.label} ${fmt.signedMoney(s.amount)}`)
    .join(", ")}.`;

  return (
    <div className="waterfall" role="img" aria-label={summary}>
      <div className="wf-row wf-total">
        <span className="wf-label">Start of year</span>
        <span className="wf-track">
          <span className="wf-point" style={{ left: `${pos(data.startNetWorth)}%` }} />
        </span>
        <span className="wf-amount num">{fmt.money(data.startNetWorth)}</span>
      </div>
      {data.steps.map((step, i) => {
        const from = points[i] ?? 0;
        const to = points[i + 1] ?? 0;
        // Inflation and other reconciling steps are bookkeeping, not money spent: shown muted.
        const tone = step.kind === "other" ? "neutral" : step.amount >= 0 ? "up" : "down";
        const left = pos(Math.min(from, to));
        const width = Math.max(0.8, Math.abs(pos(to) - pos(from)));
        return (
          <div className="wf-row" key={`${step.kind}|${step.label}|${step.amount}`}>
            <span className="wf-label">{step.label}</span>
            <span className="wf-track">
              <span
                className={`wf-bar is-${tone}`}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </span>
            <span
              className={`wf-amount num ${tone === "neutral" ? "muted" : tone === "up" ? "tone-good" : "tone-bad"}`}
            >
              {fmt.signedMoney(step.amount)}
            </span>
          </div>
        );
      })}
      <div className="wf-row wf-total">
        <span className="wf-label">End of year</span>
        <span className="wf-track">
          <span className="wf-point" style={{ left: `${pos(data.endNetWorth)}%` }} />
        </span>
        <span className="wf-amount num">{fmt.money(data.endNetWorth)}</span>
      </div>
    </div>
  );
}

export function YearView({ data }: { data: YearViewData }) {
  const fmt = useFormatter(data.plan);
  const change = data.endNetWorth - data.startNetWorth;
  return (
    <Shell
      plan={data.plan}
      title={`Where the money goes in ${data.year}`}
      subtitle={data.ages.length ? data.ages.join(" · ") : undefined}
    >
      <section className="hero compact">
        <p className={`big num ${change >= 0 ? "tone-good" : "tone-bad"}`}>
          {fmt.signedMoney(change)}
        </p>
        <p className="big-label">net worth change in {data.year}</p>
      </section>
      <p className="prose">{data.narrative}</p>
      {data.shortfall > 0 ? (
        <Notice tone="bad">
          Spending falls short by <strong className="num">{fmt.money(data.shortfall)}</strong> this
          year.
        </Notice>
      ) : null}
      <Waterfall data={data} fmt={fmt} />
      {data.steps.some((s) => /inflation/i.test(s.label)) ? (
        <p className="muted small">
          Today’s money: prices rise, so holdings are worth less in today’s terms.
        </p>
      ) : null}
      {data.withdrawals.length ? (
        <section>
          <h2 className="section-title">Withdrawals</h2>
          <ul className="kv">
            {data.withdrawals.map((w) => (
              <li key={w.account}>
                <span>{w.account}</span>
                <span className="num">{fmt.money(w.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Shell>
  );
}
