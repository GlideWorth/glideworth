/**
 * Renders docs/projectionlab-mapping.md from the coverage rules. The committed document is
 * generated from the synthetic fixture (whose key paths equal the real v4.6 export's), so it is
 * reproducible without private data: `pnpm --filter @glideworth/importers gen:mapping-doc`.
 */
import type { ImportCoverage } from "../types.js";

const esc = (s: string | undefined): string => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

const SECTION_TITLES: [string, string][] = [
  ["$.meta", "meta"],
  ["$.today.location", "today: location"],
  ["$.today.savingsAccounts", "today: savings accounts"],
  ["$.today.investmentAccounts", "today: investment accounts"],
  ["$.today.assets", "today: assets"],
  ["$.today.debts", "today: debts"],
  ["$.today", "today: household"],
  ["$.plans[].accounts", "plans: account events"],
  ["$.plans[].assets", "plans: asset events"],
  ["$.plans[].income", "plans: income events"],
  ["$.plans[].expenses", "plans: expense events"],
  ["$.plans[].priorities", "plans: priorities (flows)"],
  ["$.plans[].milestones", "plans: milestones"],
  ["$.plans[].computedMilestones", "plans: computed milestones"],
  ["$.plans[].withdrawalStrategy", "plans: withdrawal strategy"],
  ["$.plans[].montecarlo", "plans: Monte Carlo"],
  ["$.plans[].variables", "plans: variables"],
  ["$.plans[].meta", "plans: cached run state"],
  ["$.plans", "plans: other"],
  ["$.settings", "settings"],
  ["$.progress", "progress"],
];

function sectionOf(path: string): string {
  for (const [prefix, title] of SECTION_TITLES) {
    if (path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`))
      return title;
  }
  return "root";
}

const NARRATIVE = `## Conventions

- **Percentages.** ProjectionLab stores rates as percentages (\`8\` = 8%). Glideworth rates are decimal
  fractions, so every rate, fee, share and percentage is divided by 100.
- **Amount basis.** An amount type of \`today$\` maps to \`basis: 'real'\`; \`$\` to \`'nominal'\`. A missing
  type is read as today's money, the source default. Percent-typed fields are read as percentages
  even when the source tags them \`today$\` (assets and debts do this).
- **Dates.** \`{type, value, modifier}\` references map as follows.
  - Keywords \`now\` and \`beforeCurrentYear\` become \`planStart\`, \`endOfPlan\` becomes \`planEnd\`, and
    \`never\` becomes \`never\`.
  - \`date\` and \`year\` values (\`YYYY-MM-DD\`, epoch milliseconds, or a bare year) become a month.
  - A \`milestone\` value becomes a milestone reference. A reference to a milestone the plan does not
    define is reported and treated as \`never\`.
  - For a range end, \`modifier: 'include'\` becomes \`endInclusive: true\` and \`'exclude'\` an exclusive end.
    A missing modifier is read as \`include\`.
  - For a range start, \`'exclude'\` on a date or milestone shifts the start by one month, because Glideworth
    starts are inclusive.
  - \`once\` events fire in their start month, so their range collapses to that month.
- **Owners.** \`me\` is the primary person (id \`me\`), \`spouse\` is the partner (id \`spouse\`) and \`joint\`
  stays \`joint\`.
- **Ids.** Source ids are kept when they already fit \`[A-Za-z0-9_-]{1,64}\`. Otherwise they are slugged,
  with a numeric suffix on collision.
- **Plan event ids.** In a ProjectionLab plan, \`accounts.events[]\`, \`assets.events[]\` and the \`debt\`
  expense events each have their own \`id\`, which differs from the Current Finances entity they
  override (\`accountId\`, \`assetId\`, \`debtId\`). Priorities, income routing, expense funding, computed
  milestones and the bond location order all reference the *event* id. The importer indexes these per
  plan and resolves both kinds of id.
- **Plan overrides.** A plan's per-account and per-asset events become \`accountSettings\` and
  \`realAssetSettings\`, but only when they differ from the entity's own behaviour, and only with the
  keys that differ (the behaviour patches are sparse: absent keys keep the entity's value).
- **Debt events.** \`debt\`-typed expense events mirror Current Finances debts. They become
  \`debtSettings\` (payment override, start, forgiveness), not expenses.
- **Defaults.** No plan is marked \`active\` in a typical export, so the first plan is marked as the
  main plan.
- **Secrets.** \`settings.plugins.apiKey\` is never read into the document or the report.

## Judgement calls (reported as \`approximated\` issues)

- **Moving country.** Glideworth does not model moving country: a Move milestone is kept as a marker
  (kind \`move\`) and its destination is ignored and reported (\`pl.relocation\`). The v4.6 export checked
  carries no relocation keys, so the shapes recognised are inferred: \`location\`, \`relocation\` (or
  \`relocation.location\`) and \`taxResidence\`, each with \`country\`.
  An account's \`country\` becomes \`Account.jurisdiction\`, the account's country for cross-border tax.

- **Withdraw / liquid values.** \`withdraw: true|false\` is always or never. \`'after'\` is \`from\`
  the account's \`withdrawAge\`. \`'EWAge'\` is \`afterQualifiedAge\`. \`liquid: true|false\` is always or
  never. \`'when-allowed'\` is \`whenWithdrawable\`. \`'EWAge'\` is \`afterQualifiedAge\`.
- **\`non-qualified-uk-pension\` in the drawdown order.** Glideworth handles early pension access with
  per-account early-withdrawal settings, not a drawdown category, so that entry is dropped.
  \`excess-cash\` expands to the accounts marked \`repurpose\`.
- **Rental management fee.** The source applies it to rental income and Glideworth to asset value.
- **Rental income given as an amount** is read as per year.
- **Priorities.**
  - \`contributionsAreFixed\` becomes \`mandatory\`.
  - \`mode: 'target'\` becomes a target strategy using \`amount\`.
  - A percentage priority without \`contribution\` reads the percentage from \`amount\`.
  - \`asset\` priorities become a pay-down of the asset's loan.
- **Monte Carlo.**
  - \`backtest-random-restart\` becomes \`historical-random-restart\`.
  - Per-series means and standard deviations are stored as the \`normal\` distributions.
  - \`useRandomSeed\` with \`randomSeed\` sets a fixed seed.
- **Outcome categories.** \`failure\` thresholds above 1 are read as percentages of plan length. Missing
  thresholds use Glideworth's default for the same category id, else 0.
- **Progress dates.** A timestamp is rounded to the nearest day, so local midnight in any timezone keeps its date.
  \`liabilities\` is \`debt + loans\`.
- **Tax.**
  - With \`estimateTaxes\` and a supported country the mode is \`estimate\`. Otherwise it is \`flat\`
    (rates), or \`custom\` (brackets and wealth tax) when the source uses them.
  - US-only law toggles are only written for US households.
- **Year alignment** comes from \`settings.plan.alignment\`.
- **Starting conditions.** Only \`default\` (live) is representable.
`;

export function renderMappingDoc(coverage: ImportCoverage, sourceVersion: string): string {
  const out: string[] = [];
  out.push("# ProjectionLab export to Glideworth mapping");
  out.push("");
  out.push(
    "Glideworth is not affiliated with, endorsed by or connected to ProjectionLab. The name is used only to say which export format this importer reads.",
  );
  out.push("");
  out.push(
    `Format observed: ProjectionLab export v${sourceVersion}. This document is generated by \`pnpm --filter @glideworth/importers gen:mapping-doc\` from the importer's coverage rules (\`src/projectionlab/coverage.ts\`) and a synthetic fixture whose key paths equal a real v4.6 export's. It contains structure and key names only, never values.`,
  );
  out.push("");
  out.push(
    "Every key path in an export is classified, and the importer reports every dropped, approximated or unsupported field in its import report. Nothing is lost silently.",
  );
  out.push("");
  out.push("| Status | Meaning |");
  out.push("| --- | --- |");
  out.push(
    "| mapped | carried into the Glideworth document (see the Judgement calls for approximations) |",
  );
  out.push(
    "| ignored | intentionally not carried over: UI state, derived values, redundant copies, secrets |",
  );
  out.push(
    "| unsupported | real planning content with no home in the Glideworth schema yet; the suggested field is the optional addition that would give it one |",
  );
  out.push(
    "| unknown | no rule matches (a newer export version); reported as an `unrecognised` issue |",
  );
  out.push("");
  out.push("## Coverage summary");
  out.push("");
  out.push("| Total key paths | Mapped | Ignored | Unsupported | Unknown |");
  out.push("| ---: | ---: | ---: | ---: | ---: |");
  out.push(
    `| ${coverage.total} | ${coverage.mapped} | ${coverage.ignored} | ${coverage.unsupported} | ${coverage.unknown} |`,
  );
  out.push("");

  // Per-section counts
  const bySection = new Map<
    string,
    { mapped: number; ignored: number; unsupported: number; unknown: number }
  >();
  for (const e of coverage.entries) {
    const s = sectionOf(e.path);
    const c = bySection.get(s) ?? { mapped: 0, ignored: 0, unsupported: 0, unknown: 0 };
    c[e.status] += 1;
    bySection.set(s, c);
  }
  out.push("| Section | Mapped | Ignored | Unsupported | Unknown |");
  out.push("| --- | ---: | ---: | ---: | ---: |");
  for (const [, title] of SECTION_TITLES) {
    const c = bySection.get(title);
    if (c) out.push(`| ${title} | ${c.mapped} | ${c.ignored} | ${c.unsupported} | ${c.unknown} |`);
  }
  out.push("");
  out.push(NARRATIVE);

  // Unsupported -> suggested fields
  const suggested = new Map<string, { note?: string; paths: string[] }>();
  for (const e of coverage.entries) {
    if (e.status !== "unsupported") continue;
    const k = e.target ?? "(none)";
    const g = suggested.get(k) ?? { note: e.note, paths: [] };
    g.paths.push(e.path);
    suggested.set(k, g);
  }
  out.push("## Unsupported fields and suggested schema additions");
  out.push("");
  out.push(
    "Each suggestion is an optional field (or a new optional union member); none is a breaking change.",
  );
  out.push("");
  out.push("| Suggested field | Why | Source key paths |");
  out.push("| --- | --- | --- |");
  for (const [field, g] of [...suggested].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(
      `| \`${esc(field)}\` | ${esc(g.note)} | ${g.paths.map((p) => `\`${esc(p)}\``).join("<br>")} |`,
    );
  }
  out.push("");

  out.push("## Key-path coverage table");
  out.push("");
  out.push(
    "Array indexes are collapsed to `[]`. Dynamic keys (chart names, outcome categories) are listed as they appear in the export.",
  );
  const grouped = new Map<string, typeof coverage.entries>();
  for (const e of coverage.entries) {
    const s = sectionOf(e.path);
    const list = grouped.get(s) ?? [];
    list.push(e);
    grouped.set(s, list);
  }
  for (const [, title] of SECTION_TITLES) {
    const list = grouped.get(title);
    if (!list) continue;
    out.push("");
    out.push(`### ${title}`);
    out.push("");
    out.push("| Key path | Status | Glideworth destination / suggested field | Note |");
    out.push("| --- | --- | --- | --- |");
    for (const e of list) {
      out.push(
        `| \`${esc(e.path)}\` | ${e.status} | ${e.target ? `\`${esc(e.target)}\`` : ""} | ${esc(e.note)} |`,
      );
    }
  }
  out.push("");
  return out.join("\n");
}
