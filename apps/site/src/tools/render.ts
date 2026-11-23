/**
 * Turns a calculator result (ViewModel) into HTML. Used at build time for the static page and in the
 * browser after each run, so the two always look the same. Every value is escaped.
 */
import { chartSvg, legendSwatch } from "./chart";
import { esc } from "./format";
import type { ChartSpec, Table, ViewModel } from "./types";

function tableHtml(t: Table, extraClass = ""): string {
  const head = t.columns
    // An empty corner cell is a plain <td>: a header cell with no text is announced as an unnamed header.
    .map((c, i) =>
      c === "" ? "<td></td>" : `<th scope="col"${i ? ' class="num"' : ""}>${esc(c)}</th>`,
    )
    .join("");
  const body = t.rows
    .map(
      (r) =>
        `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td class="num">${esc(c)}</td>`)).join("")}</tr>`,
    )
    .join("");
  return `<div class="tool-table-scroll"${extraClass ? ` data-kind="${esc(extraClass)}"` : ""} tabindex="0" role="region" aria-label="${esc(t.caption)}"><table class="tool-table"><caption>${esc(t.caption)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function legendHtml(c: ChartSpec): string {
  const items: string[] = [];
  for (const b of c.bands ?? [])
    items.push(`<li>${legendSwatch("band", "", b.tone, b.level)}${esc(b.label)}</li>`);
  for (const s of c.series)
    items.push(
      `<li>${legendSwatch(c.kind === "bar" ? "bar" : "line", s.style, s.tone)}${esc(s.label)}</li>`,
    );
  return items.length ? `<ul class="tool-legend">${items.join("")}</ul>` : "";
}

export function chartHtml(c: ChartSpec): string {
  return [
    `<figure class="tool-chart" data-chart="${esc(c.id)}">`,
    `<p class="tool-chart-title">${esc(c.title)}</p>`,
    chartSvg(c),
    legendHtml(c),
    `<figcaption id="${esc(c.id)}-summary">${esc(c.summary)}</figcaption>`,
    `<details class="tool-details"><summary>Show the numbers as a table</summary>${tableHtml(c.table)}</details>`,
    "</figure>",
  ].join("");
}

export function renderResults(vm: ViewModel): string {
  const out: string[] = [];
  out.push(`<p class="tool-headline">${esc(vm.headline)}</p>`);
  if (vm.warnings.length)
    out.push(
      `<ul class="tool-warnings">${vm.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`,
    );
  if (vm.figures.length)
    out.push(
      `<dl class="tool-figures">${vm.figures
        .map(
          (f) =>
            `<div><dt>${esc(f.label)}</dt><dd><span class="tool-figure-value">${esc(f.value)}</span>${f.detail ? `<span class="tool-figure-detail">${esc(f.detail)}</span>` : ""}</dd></div>`,
        )
        .join("")}</dl>`,
    );
  if (vm.table) out.push(tableHtml(vm.table, "summary"));
  if (vm.charts.length)
    out.push(
      `<div class="tool-charts${vm.smallMultiples ? " tool-charts-multi" : ""}">${vm.charts.map(chartHtml).join("")}</div>`,
    );
  for (const t of vm.extraTables ?? []) out.push(tableHtml(t, "summary"));
  if (vm.comparison) {
    const c = vm.comparison;
    out.push(
      `<div class="tool-compare"><p class="tool-compare-title">${esc(c.title)}</p>`,
      tableHtml({
        caption: c.title,
        columns: ["", "Formula", "Engine"],
        rows: c.rows.map((r) => [r.label, r.formula, r.engine]),
      }),
      `<p class="tool-compare-note">${esc(c.note)}</p></div>`,
    );
  }
  if (vm.method.length)
    out.push(
      `<div class="tool-method"><p class="tool-method-title">How this was calculated</p><ul>${vm.method.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>`,
    );
  return out.join("");
}
