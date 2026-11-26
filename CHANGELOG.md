# Changelog

Notable changes to Glideworth, newest first. Versions follow [Semantic Versioning](https://semver.org): the REST
API, the MCP tools and the stored document schema are the public surface. Each release is also a Docker image,
`ghcr.io/glideworth/glideworth:<version>`, and has a [GitHub release](https://github.com/GlideWorth/glideworth/releases)
listing every commit. Product news for people using the hosted service is on
[glideworth.com/changelog](https://glideworth.com/changelog/).

## Unreleased

- **Share links return before Monte Carlo finishes.** `POST /plans/{id}/share-links` takes `deferMonteCarlo`
  (default false) and its response has `monteCarlo: { status, jobId? }`. With it, the link is returned as soon
  as the snapshot is stored and the chance of success is added when the run finishes; the web app uses this and
  shows the run's progress. Refreshing a link that asked for the chance of success and never got it (a failed
  or cancelled run) now runs it again. MCP `create_share_link` still waits for the figure.
- **Why did my results change?** Each check-in now keeps what it was computed from. `GET
  /plans/{id}/result-change` and the read-only MCP tool `explain_result_change` show how far the chance of
  success, the financial-independence year and end-of-plan net worth moved since a check-in, split into
  Glideworth's side (engine, tax tables, market history), the passage of time, updated balances, household
  details and each plan edit, in a stated order. The dashboard's check-in card shows it. Check-ins taken before
  this release show the total only.
- **Draw from several accounts in the same year.** Two new, opt-in drawdown-order entries: `proportional` draws
  chosen accounts together in proportion to their balances, and `fillToCeiling` draws pre-tax accounts only while
  taxable income stays within a ceiling (a tax band rate from the tax tables, or an income), per person where
  income is taxed individually and lowest band first, then passes the rest to the next entry. Each withdrawal's
  ledger entry records the rule (`rule`). Existing plans give the same results. Document schema version 7 (no
  data change).
- **Interactive views in ChatGPT and Claude** (MCP Apps): Monte Carlo and projections, what-if and plan
  comparisons, solver answers, change-set reviews, one year's cash flow and tax over time render as interactive
  views. The view's data travels in the tool result's `_meta["glideworth/widget"]`; the text the model reads is
  unchanged. See "Interactive views" in [docs/MCP.md](docs/MCP.md).
- **MCP tool annotations corrected** for the ChatGPT and Claude directories: tools that overwrite or remove
  existing state (`apply_change_set`, `discard_change_set`, `cancel_job`, `update_account_balances`,
  `apply_csv_import`, `apply_balance_history_import`, `set_fx_rate`, `set_checkin_schedule`,
  `mark_notifications_read`) are now `destructiveHint: true`, so clients ask before running them;
  `list_share_links` is `readOnlyHint: true`; `create_share_link` is `openWorldHint: true` (it publishes a public
  URL). The 14 tools that start a calculation (`run_monte_carlo`, `run_historical_backtest`, `sensitivity`, the
  `solve_*` tools, `goal_seek`, `evaluate_guardrails`, `explain_difference`, `optimise_tax_strategy`,
  `strategy_matrix`, `plan_roth_conversions`) are `readOnlyHint: false` (idempotent, not destructive): each stores a job record. They change
  no plan or household data and stay out of the audit log. `what_changed_since_checkin` no longer takes
  `refresh`, which stored a check-in; use `run_checkin`. The server instructions now say results are estimates,
  not advice.
- **Claude Code plugin**: `/plugin marketplace add GlideWorth/glideworth`, then `/plugin install
  glideworth@glideworth`, adds the hosted MCP server and the Glideworth skill.
- **Tiered employer match** ([#9](https://github.com/GlideWorth/glideworth/issues/9)): a contribution's employer
  match is an ordered list of tiers (`employer.tiers: [{ matchRate, bandShareOfPay }]`), matched band by band from
  the first percent of pay up, so formulas such as 100% of the first 3% of pay and 50% of the next 2% are exact at
  every deferral rate. Match rates above 100% are allowed. **API change:** `employer.matchShare` and
  `employer.upToShareOfPay` are replaced by `tiers`; stored plans, exports and branch patches migrate on read to a
  single tier with the same result (document schema version 3).
- **Fixed employer contributions and the combined HSA limit**
  ([#8](https://github.com/GlideWorth/glideworth/issues/8)): an employer contribution can be a fixed amount per
  frequency (`employer.fixed`, in today's money or fixed dollars), with or without a match. In an HSA, employer
  money (fixed or matched) now counts toward the owner's annual limit, including the 55+ catch-up
  (IRC 223(b)(4)(B)), so an employee contributing "up to the limit" contributes the limit less the employer's
  money; before, a match was added on top of a full employee contribution. Employer money is never an employee
  deduction. Document schema version 4 (no data change: older builds refuse version 4 documents instead of
  dropping the fixed amount).

## 1.0.0 - 2026-11-20

The first release: a retirement and financial planner you can run on your own server or use hosted.

### What you can find out

- **When you can retire**, and how much you can spend each year without running out, for one person or a couple.
- **Your chance of success** over thousands of market paths (historical and random, seeded), with the years where
  plans fail and why.
- **What changes the answer:** spending, savings, retirement date, withdrawal order, Roth conversions and
  guardrails, compared side by side as branches of one plan.
- **Taxes year by year** for the United States (federal, payroll, all 50 states and DC, some cities), the United
  Kingdom, Canada, Australia, Germany, the Netherlands, France, Spain, Israel, Ireland, New Zealand and the United
  Arab Emirates, plus flat and custom rates. The tables were checked against official sources; each country lists
  what it leaves out and any figure that could not be confirmed ([docs/STATUS.md](docs/STATUS.md)).
- **Assets held abroad** while you live in one country: an account, property, debt or income in another country and
  currency is taxed there as a non-resident, with treaty relief at home.

### Ways in

- **Web app** with onboarding, a plan editor, results, cash flow, taxes, estate, comparisons, progress tracking and
  reports. Installable as a PWA.
- **AI assistants:** an MCP server for Claude, ChatGPT and other clients (stdio, HTTP and OAuth 2.1). Read-only by
  default; edits are proposals you approve ([docs/MCP.md](docs/MCP.md)).
- **REST API** described in OpenAPI 3.1, with scoped keys, webhooks and background jobs
  ([docs/API.md](docs/API.md)).
- **Imports:** ProjectionLab JSON (with a report of anything approximated), CSV from Monarch, YNAB, Mint, Copilot,
  Actual Budget, Monzo, Starling, UK bank statements and net-worth trackers, and Glideworth JSON. Exports to JSON, CSV and reports.

### Running it

- **One Docker image** for `linux/amd64` and `linux/arm64`: the web app, API and MCP server on one port, data in one
  SQLite file, passphrase sign-in, backup and restore commands ([docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)).
- Self-hosted builds are the whole product: no licence key and no telemetry.
- Licensed AGPL-3.0-only; the importers package is MIT ([LICENSING.md](LICENSING.md)). Market history and tax data
  sources and their terms are in [DATA-LICENSES.md](DATA-LICENSES.md).

### Not included

Removed before release because nobody had asked for them: modelling a move between countries mid-plan, the debt
payoff and 72(t) method comparisons, and OFX/QFX/QIF bank-file import. Plans saved by earlier development builds
migrate on read.
