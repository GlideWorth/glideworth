# Glideworth status

Where Glideworth stands, how to run it, and what not to trust yet. Feature-by-feature detail is in
[PARITY.md](PARITY.md); design is in [ARCHITECTURE.md](ARCHITECTURE.md).

## What is built

| Area                                                                             | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain schema (`packages/core/src/schema`)                                       | Household, accounts, real assets, debts, income and expense events, flows, milestones, assumptions, tax settings, strategies, Monte Carlo settings; Zod, versioned, with migrations.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Engine (`packages/core/src/engine`)                                              | Annual deterministic projection with a full ledger, taxes, withdrawals, RMDs, Roth conversions, real assets and loans, survivor transfer, multi-currency.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tax plug-ins (`packages/core/src/tax`)                                           | UK, US (federal, payroll, 50 states and DC, some cities), Canada, Australia, Germany, Netherlands, France, Spain, Israel, Ireland, New Zealand, United Arab Emirates, flat and custom.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Cross-border (`tax/crossborder`, `engine/residency.ts`, `engine/crossborder.ts`) | Residency timeline per person (split years prorated), source-country taxation of non-residents (UK high fidelity, US citizenship-based taxation with FEIE/FTC, others basic), treaty table with credit relief (UK-UAE from the convention; UK-US/AU/CA/ES/FR and US-CA basic), foreign-wrapper recognition, departure tax (CA, AU) and arrival rebasing, UK temporary non-residence, UK State Pension frozen abroad, non-resident contribution bars, UK IHT long-term residence; audit checks, relocation what-if and stay-or-move comparison. Engine 0.4.0; single-country results byte-identical. |
| Stochastic (`packages/core/src/stochastic`)                                      | Monte Carlo (historical restart, sequential, block bootstrap, normal, lognormal, fat-tail), seeded, optional FX risk, failure analysis, milestone timing.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Solvers and insights                                                             | Spending solver, earliest retirement, required savings, safe withdrawal rate, guardrails, tax-strategy comparison, explain, audit, branches, diff and merge, survivor scenarios.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Importers (`packages/importers`)                                                 | ProjectionLab JSON (with a key-path coverage report), CSV (Monarch, YNAB, generic), OFX/QFX/QIF, Glideworth JSON; exports JSON, CSV, report.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| API (`apps/api`)                                                                 | Hono REST + OpenAPI 3.1 (265 operations self-hosted, 302 in cloud mode), SQLite, worker-thread jobs (time and heap limits), scoped keys, sessions, OAuth 2.1, webhooks, scheduler, backup CLI. Cloud mode (`GLIDEWORTH_MODE=cloud`) integrated: one database per workspace, `@glideworth/cloud` loaded by dynamic import only, isolation sweep over every operation (`test/cloud-isolation.test.ts`).                                                                                                                                                                                               |
| MCP                                                                              | 75 tools (54 read/compute, 21 write behind a switch), resources, prompts; stdio and HTTP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Web (`apps/web`)                                                                 | React app: onboarding, plan editor, results, chance of success, cash flow, taxes, estate, compare, insights, progress, import, reports, settings, PWA; cross-border: residency editor, person citizenship / past residence / state-pension records, item countries, tax by country and basis, "how this is taxed and why", stay or move.                                                                                                                                                                                                                                                            |

PARITY.md counts: 210 features checked, 171 implemented, 34 partial, 5 missing.

## How to run

- **Development**: `pnpm install`, `cp .env.example .env`, `pnpm dev` (API :8787, web :5173).
- **Production, one port**: `pnpm build`, `pnpm start` (web, `/api`, `/mcp`, `/docs` on :8787). First visit asks for a
  passphrase (12+ characters). Set `GLIDEWORTH_SETUP_TOKEN` if the port is reachable by others.
- **Docker**: `docker compose up -d --build`; data in the `cairn-data` volume; health check on `/health`.
- **Backups**: `pnpm backup`, `pnpm restore -- --from <file> --force` (stop the server first).

## Importing from ProjectionLab

Export JSON from ProjectionLab, then use Import in the web app (review the report, then apply), or
`POST /api/v1/import` with `{"format":"projectionlab","dryRun":true,"data":<file>}` first. The report lists issues
by key path and never echoes values. Re-importing needs `"mode":"replace"`. Anything the report marks approximated
or unsupported must be checked by hand.

## Connecting an AI assistant (MCP)

Create a least-privilege key (`pnpm keys:create -- --name claude --scopes read`) and either
`claude mcp add --transport http glideworth http://localhost:8787/mcp --header "Authorization: Bearer <key>"`, or use
stdio after `pnpm build`: `node apps/api/dist/mcp/stdio.js` with `GLIDEWORTH_DB_PATH` set and
`GLIDEWORTH_MCP_ALLOW_WRITES=false`. Plan edits are proposals (change sets) you approve. See [MCP.md](MCP.md).

## Tests

`pnpm test` runs 1,399 tests in 94 files, all passing (one importer suite runs only when you have a ProjectionLab
export locally, and its 10 tests are skipped otherwise). `pnpm typecheck`, `pnpm lint` and `pnpm build` pass.

## Before you rely on the numbers

This is an estimator, not tax or investment advice. Treat every output as a model of your assumptions.

### Market data

| Data set                      | Coverage                | Licence                                                                                                    |
| ----------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `us-1928` (default, incl. UK) | 1928 to 2025            | Damodaran, free with attribution; BLS CPI (fetched from BLS) public domain                                 |
| `uk-1983`                     | 1983 to 2025 (43 years) | ONS and Bank of England (OGL v3.0), Fed H.10 (public domain); shares are US shares in sterling             |
| `us-1871-local` (optional)    | 1871 on, if downloaded  | Shiller, no licence: not bundled; self-hosters may download it for personal use (`fetch_shiller_local.py`) |

Withdrawn: `uk-1871` (Jordà-Schularick-Taylor, non-commercial) and the bundled `us-1871` (Shiller, no licence).
Old plans naming them are read as `uk-1983` / `us-1928` and show a `DATASET_REPLACED` notice. UK plans default to
`us-1928` because `uk-1983` is short and optimistic (`docs/design/uk-dataset-replacement.md`). Canada, Australia
and the euro area have no history of their own, so they test against US history. Datasets are not updated
automatically. Crypto has no history and is sampled from a distribution.

### Tax-year coverage

Later years carry the last known rates forward and index thresholds with inflation (or per the threshold policy);
that is wrong whenever the rules change. Someone must add new years each spring.

| Country                             | Years in the tables                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| UK                                  | 2025/26, 2026/27, announced 2027/28 and 2029/30                                                                            |
| US federal, payroll, states, cities | 2026 (OBBBA); a TCJA-sunset what-if is an **estimate** (2017 law x 1.33)                                                   |
| Canada                              | 2026                                                                                                                       |
| Australia                           | 2025-26, 2026-27, legislated 2027-28                                                                                       |
| Germany, Netherlands, Israel        | 2026                                                                                                                       |
| Ireland                             | 2026; from 2027 the 2026 tables with CGT at 31%                                                                            |
| New Zealand                         | 2026-27                                                                                                                    |
| France                              | 2026 finance law (taxes 2025 income), 2026 social rates                                                                    |
| Spain                               | **2025** IRPF scales, 2026 social security                                                                                 |
| United Arab Emirates                | 2026 (no personal tax; gratuity, DEWS, savings scheme, GPSSA Law 57 of 2023)                                               |
| Cross-border tables                 | UK non-resident rules 2026-27 (gov.uk); IHT long-term residence from 6 April 2025; voluntary NI 2026-27; US FEIE 2025-2026 |

Figures that could not be confirmed or are provisional:

- Israel: **not confirmed from an official source** (2026-11-16): brackets, credit point, capital-income rates, the
  surtax threshold and National Insurance rates. The Tax Authority and National Insurance Institute sites refused
  automated access, so the figures are as published by independent sources (PwC is no longer cited). The partial
  exemption for qualifying pension annuities could not be confirmed either, so pensions are taxed in full.
- US states: **not confirmed from an official source** (2026-11-16; the state site would not open): all figures for
  Idaho, Kansas, Louisiana, Michigan, New Hampshire, Ohio, Rhode Island and Wisconsin, and the Wilmington and Newark
  city rates; some figures for Arizona (rate), Georgia (retirement exclusion), Iowa (exemption credit), Kentucky
  (pension exclusion), Missouri (capital gains subtraction), Oklahoma (deduction, exemptions, retirement exclusion),
  South Carolina (dependent exemption, retirement deductions), Vermont (thresholds, deduction, exemption) and West
  Virginia (exemption, retirement exclusion). Each is named in that state's simplifications.
- Canada: Quebec's brackets and basic amount are **not confirmed from an official source** (Revenu Québec refused
  automated access, 2026-11-16); federal, other provincial, CPP/QPP, EI and OAS figures were confirmed from CRA.
- Australia: Medicare levy low-income thresholds are the 2024-25 values for every year; the 2.9% increase from 1 July
  2025 announced in the 2026-27 Budget is not applied and 2026-27 thresholds are not published.
- Netherlands: 2026 Box 3 deemed returns for savings and debts are provisional; the counter-evidence route is not
  applied.
- US TCJA-sunset variant: an estimate, not law.
- Ireland: CGT is 33% to 6 October 2026 and 31% from 7 October 2026 (Revenue); with no disposal dates, 2026 uses the
  average by days (32.53%) and 2027 onward 31%.
- Spain: 2025 scales are carried forward; only four regions have their own scales.
- No preset has been checked line by line against an official calculator for every case.
- UAE: the gratuity's daily wage (monthly basic / 30) is Glideworth's convention, and whether the two-year cap uses basic
  or total wage is not settled on the government portal (basic is used); the DEWS voluntary-savings cap and GPSSA
  eligibility ages could not be confirmed and are not modelled.
- Treaties other than UK-UAE are basic: the main allocation rules, not checked article by article (rows marked
  "not verified" use the credit method). The UK State Pension uprating list comes from a gov.uk page that may be
  dated.
- Cross-border tax is an estimate of the tax mechanics only: residence status is what you enter (no statutory
  residence test, no 183-day rules), split years are prorated by months, and treaty relief assumes it is claimed.

Tax sources, checked 2026-11-16 (the status of each country's sourcing; licences are in `DATA-LICENSES.md`):

| Country                                 | Sourcing status                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| US federal, payroll                     | ok (IRS, SSA)                                                                                                     |
| US states and cities                    | ok for 42 states, DC and 3 cities from each state's own publications; 8 states and 2 cities not confirmed (above) |
| Canada                                  | ok (CRA); Quebec brackets and basic amount not confirmed                                                          |
| Israel                                  | not confirmed (official sites unreachable)                                                                        |
| United Arab Emirates                    | ok (copied sentence reworded)                                                                                     |
| Australia                               | ok on facts (ATO cited; Medicare thresholds checked against the 2026-27 Budget paper)                             |
| Ireland                                 | ok on facts (Revenue; CGT change from 7 October 2026 modelled)                                                    |
| New Zealand                             | ok (IRD rates from 1 April 2025, no end date)                                                                     |
| UK, Germany, France, Spain, Netherlands | ok (unchanged in this pass)                                                                                       |

Each country's full list of simplifications is `TAX_SIMPLIFICATIONS`
(`packages/core/src/tax/data/simplifications.ts`) and is shown with the tax results. Highlights: US SALT cap and
itemised phase-outs not applied, AMT adds back only the standard deduction, no EITC or education credits; Canada no
AMT, GIS is an amount you enter; Australia no SAPTO, HELP or Medicare levy surcharge; UK no pension allowance
carry-forward, Class 1 and 4 NI only, one pair of CGT rates; everywhere gains are realised pro rata to basis, all
long-term, and losses are never realised.

### Calculation conventions

- **Annual steps.** The engine steps by year; monthly resolution is reserved and rejected. Events are prorated by
  month inside a year.
- **Mid-year cash-flow timing** by default (`cashFlowTiming`: start, mid, end): flows earn half a year's return.
- **Today's money.** Entered amounts carry a basis. Outputs are nominal with a price index, so any series can be
  shown in today's money; flows deflate by the start-of-period index, balances by the end-of-period index.
- **Partial first year.** The plan starts in the month balances are dated, so the first (and last) year may be
  short. It is labelled (for example 2026*) and can be shown annualised.
- Monte Carlo uses a fixed default seed so comparisons share random draws; results are cached per plan version.

### Not modelled

Monthly or daily resolution; randomised lifespan and care shocks in Monte Carlo; account aggregation (by design);
live sync with budgeting apps; server-side PDF; municipal/Treasury bond-income split; the US EITC and education
credits; means-tested benefits (UK Universal Credit, Pension Credit); loss harvesting and specific-lot selling;
end-to-end encrypted sync; per-person privacy within a household.

### Partial features (see PARITY.md)

US federal tax, Canada CPP/OAS/GIS, Germany, Netherlands, France, Spain, Israel, Ireland and New Zealand (basic
level); debt payoff strategies; datasets; drawdown-order editor graphs; Flex vs No-Flex table; tax optimizer depth;
strategy and income-by-rate heatmaps; table export (four tables, not any plot); reports (browser print only);
share links; re-run on plan change (on request, not on every edit); household collaboration (roles are
instance-wide); onboarding data-quality checks; scheduled re-runs (no e-mail; use webhooks); open test vectors
(no published validation report).

## Cross-border plans: what is exposed

Core (engine 0.4.0) plus API, MCP and web. API: `/plans/{id}/residency` (CRUD, checked against the household),
`/residency-timeline`, `/cross-border/items`, `insights/explain-taxation`, `insights/stay-or-move` (inline: two
deterministic runs), `tax-breakdown/by-country` (and country/basis in `tax-breakdown`),
`/households/{id}/people/{personId}/cross-border`, rule tables under `/cross-border/*`, the `relocation`
template with a parameter schema; the result cache keys on the engine version. MCP: `get_residency_timeline`,
`cross_border_rules`, `tax_by_country`, `explain_item_taxation`, `compare_stay_or_move`, `propose_move`,
`set_person_cross_border`. Web: see USER-GUIDE.md "Where to find it in the app". Core additions in this round:
`explainItemTaxation`, `crossBorderItems`, `taxByCountry`, `CROSS_BORDER_SIMPLIFICATIONS`,
`summariseStayOrMove`, `StatePensionRecord.voluntaryYears` (counted by `XB_STATE_PENSION_GAP`), readable plan
diffs for residency changes, country names (not codes) in explanations and person names (not ids) in
cross-border tax-line labels.

Known gaps for cross-border users: residence is what you enter (no statutory residence test); the bracket and
marginal-rate analytics on the Taxes page describe the household country's calculation only; stay-or-move is
deterministic (branch it for chance of success); planned real assets and plan-level account overrides have no
country field in the plan editor (set it on the item in Current finances); the gratuity is UAE-only; voluntary
contributions are not added as an expense automatically.

## What remains, in priority order

1. Tax depth and verification against official calculators: US SALT cap, itemised phase-outs, AMT items, EITC;
   GIS income test; AU SAPTO and HELP; each country's `TAX_SIMPLIFICATIONS`; yearly table updates.
2. Datasets: Canadian, Australian and euro-area history; UK after 2020 (and the non-commercial licence).
3. Direct integrations for balance sync (Lunch Money, YNAB, Monarch, Actual).
4. Optimizer depth and the Flex vs No-Flex comparison.
5. Randomised lifespan and care shocks inside Monte Carlo.
6. Monthly resolution.
7. Server-side PDF and a "results changed because" report after table updates.
8. Completeness score and data-quality nudges in onboarding.
