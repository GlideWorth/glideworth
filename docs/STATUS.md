# Glideworth status

Where Glideworth stands, how to run it, and what not to trust yet. Feature-by-feature detail is in
[PARITY.md](PARITY.md); design is in [ARCHITECTURE.md](ARCHITECTURE.md).

## What is built

| Area                                                      | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain schema (`packages/core/src/schema`)                | Household, accounts, real assets, debts, income and expense events, flows, milestones, assumptions, tax settings, strategies, Monte Carlo settings; Zod, versioned, with migrations.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Engine (`packages/core/src/engine`)                       | Annual deterministic projection with a full ledger, taxes, withdrawals, RMDs, Roth conversions, real assets and loans, survivor transfer, multi-currency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Tax plug-ins (`packages/core/src/tax`)                    | UK, US (federal, payroll, 50 states and DC, some cities), Canada, Australia, Germany, Netherlands, France, Spain, Israel, Ireland, New Zealand, United Arab Emirates, flat and custom.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Cross-border (`tax/crossborder`, `engine/crossborder.ts`) | Fixed residence (the household's location, for the whole plan) with accounts, property, debts and income in other countries: source-country taxation of non-residents (UK high fidelity, US citizenship-based taxation with FEIE/FTC, others basic), treaty table with credit relief (UK-UAE article by article; UK-US/AU/CA/ES/FR and US-CA for pensions, social security, dividends, interest and gains, checked 2026-11-19; US saving clauses), foreign-wrapper recognition, non-resident contribution bars; audit checks, tax by country and basis, per-item explanation. Engine 0.6.0; single-country results byte-identical. |
| Stochastic (`packages/core/src/stochastic`)               | Monte Carlo (historical restart, sequential, block bootstrap, normal, lognormal, fat-tail), seeded, optional FX risk, failure analysis, milestone timing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Solvers and insights                                      | Spending solver, earliest retirement, required savings, safe withdrawal rate, guardrails, tax-strategy comparison, explain, audit, branches, diff and merge, survivor scenarios.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Importers (`packages/importers`)                          | ProjectionLab JSON (with a key-path coverage report), CSV (Monarch, YNAB, generic), balance history per account (pasted cells, CSV, TSV; merge or replace), Glideworth JSON; exports JSON, CSV, report.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| API (`apps/api`)                                          | Hono REST + OpenAPI 3.1 (251 operations self-hosted, 299 on the hosted service), SQLite, worker-thread jobs (time and heap limits), scoped keys, sessions, OAuth 2.1, webhooks, scheduler, backup CLI. Cloud mode (`GLIDEWORTH_MODE=cloud`) integrated: one database per workspace, `@glideworth/cloud` loaded by dynamic import only, isolation sweep over every operation (`test/cloud-isolation.test.ts`).                                                                                                                                                                                                                      |
| MCP                                                       | 67 tools (49 read/compute, 18 write behind a switch), resources, prompts; stdio and HTTP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Web (`apps/web`)                                          | React app: onboarding, plan editor, results, chance of success, cash flow, taxes, estate, compare, insights, progress, import, reports, settings, PWA; cross-border: citizenships and US green card per person, item countries, tax by country and basis, "how this is taxed and why".                                                                                                                                                                                                                                                                                                                                             |

PARITY.md counts: 216 features checked, 173 implemented, 35 partial, 5 missing, 3 removed.

### Added on 2026-11-23

- **Long-term-care expense type** (`long-term-care`). It works like a healthcare expense: it counts as qualified
  medical use for HSA withdrawals, and new events (editor default, the long-term-care what-if) grow at
  healthcare inflation. No tax deduction for care costs or long-term-care insurance premiums is modelled, the
  same as for healthcare. ProjectionLab imports do not map to it: the export format we have seen has no care
  type.
- **Bonus as a percentage of a salary** (`percentOfSalary` on a `bonus`). Each year the bonus is the given
  share of the linked salary's pay that year, after the salary's growth. A year without the salary pays no
  bonus. The bonus is taxed as before. A link to a missing or non-salary income stops the projection with a
  clear error.

### Removed on 2026-11-19 (no evidence of demand)

- **Moving country**: the residency timeline (`Plan.residency`), the `relocate` milestone effect (it also
  switched US state or Canadian province mid-plan), past residence and state-pension records on a person, the
  relocation what-if and the stay-or-move comparison, departure taxes and arrival rebasing, UK temporary
  non-residence, the UK State Pension freeze abroad, UK IHT long-term-residence scope, the State Pension gap /
  voluntary NI finding and split-year proration. The household now lives at its location for the whole plan;
  items in other countries are still taxed there (ARCHITECTURE.md §4.6). Stored data migrates on read (document
  schema version 2).
- **Debt payoff comparison** (minimum vs avalanche vs snowball). The avalanche / snowball allocation on a debt
  paydown flow remains.
- **72(t) method comparison**. 72(t) SEPP distributions on an account remain.
- **OFX / QFX / QIF bank-statement import**. CSV (including the bank-statement presets), ProjectionLab JSON and
  Glideworth JSON imports remain.
- In the web app, the Monte Carlo method picker moved under a collapsed "Advanced" disclosure; the default
  ("Historical, random start years") is stated in one line. API and MCP are unchanged.

## How to run

- **Development**: `pnpm install`, `cp .env.example .env`, `pnpm dev` (API :8787, web :5173).
- **Production, one port**: `pnpm build`, `pnpm start` (web, `/api`, `/mcp`, `/docs` on :8787). First visit asks for a
  passphrase (12+ characters). Set `GLIDEWORTH_SETUP_TOKEN` if the port is reachable by others.
- **Docker**: `docker compose up -d` (image `ghcr.io/glideworth/glideworth`); data in the `glideworth-data` volume; health check on `/health`.
- **Backups**: `pnpm backup`, `pnpm restore -- --from <file> --force` (stop the server first).

## Importing from ProjectionLab

Export JSON from ProjectionLab, then use Import in the web app (review the report, then apply), or
`POST /api/v1/import` with `{"format":"projectionlab","dryRun":true,"data":<file>}` first. The report lists issues
by key path and never echoes values. Re-importing needs `"mode":"replace"`. Anything the report marks approximated
or unsupported must be checked by hand.

## Importing balance history from a spreadsheet

Progress → Recorded values → **Import history** takes pasted cells or a CSV/TSV file of balances over time: a date
column and one column per account (or dates across the top, or one row per date and account). It reads the dates and
numbers, matches columns to accounts, assets, loans and debts by name, flags problem cells, and shows what Merge or
Replace would add, update and remove before anything is saved. **Export** writes the same layout back. Choices made,
and what to check by hand:

- **Dates are never guessed.** A column where every date fits both month-first and day-first (`03/04/2024`) blocks the
  import until you choose; the dialog shows how the first date reads each way. Month-only and year-only dates are dated
  on the last day of the period (or the first, by choice); a period that has not ended is dated today.
- **Blank is not zero.** A blank cell is no value: Merge ignores it, Replace clears a saved value there. `0` and an
  accounting dash (`-`) are zero balances.
- **Debts and loans are amounts owed**, stored as positive numbers. A column of negative numbers is read as positive;
  a single negative cell in a positive column is read as its size and flagged.
- **Totals move with the values.** Changing an account by N moves that date's assets and net worth by N (converted at
  today's FX rate for a foreign-currency item), so hand-entered totals keep whatever the accounts did not cover. Totals
  columns in the file (net worth, assets, liabilities) win for their date. A new date records only the accounts in the
  file: nothing is estimated for the others, and the preview says so.
- **Replace** clears, for each mapped column only, saved values the file does not have between its first and last
  date. Cells skipped because of errors are never cleared, and Replace refuses a file with unreadable dates.
- **Today's balances** change only when you tick "Also update current balances from today's row". An automatic daily
  snapshot that the import changes becomes an `import` snapshot, so the next balance update does not overwrite it.
- Over the API: `POST /api/v1/households/{id}/snapshots/history` (`dryRun` defaults to `true`; repeating an apply
  changes nothing). MCP: `preview_balance_history_import`, then `apply_balance_history_import`.

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

| Country                      | Years in the tables                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| UK                           | 2025/26, 2026/27; 2027/28 as announced at Budget 2025 and 2026; 2029/30                                           |
| US federal, payroll          | 2026 and 2027 (OBBBA; Rev. Proc. 2025-32 and 2026-35); a TCJA-sunset what-if is an **estimate** (2017 law x 1.33) |
| US states, cities            | 2026                                                                                                              |
| Canada                       | 2026; base CPP 4.75% from 2027 (Bill C-30)                                                                        |
| Australia                    | 2025-26, 2026-27, legislated 2027-28                                                                              |
| Germany, Netherlands, Israel | 2026                                                                                                              |
| Ireland                      | 2026; 2027 as announced in Budget 2027 (Finance (No. 2) Bill 2026)                                                |
| New Zealand                  | 2026-27; ACC earners' levy 2027-28                                                                                |
| France                       | 2026 finance law (taxes 2025 income), 2026 social rates                                                           |
| Spain                        | State IRPF scales 2025 and 2026 (law in force); regional scales **2025**, used for 2026; 2026 social security     |
| United Arab Emirates         | 2026 (no personal tax; gratuity, DEWS, savings scheme, GPSSA Law 57 of 2023)                                      |
| Cross-border tables          | UK non-resident rules 2026-27 (gov.uk); US FEIE 2025-2027; treaty texts and non-resident pages read 2026-11-19    |

Figures that could not be confirmed or are provisional:

- Israel (checked 2026-11-19): the 2026 tables also apply to 2027, because the Income Tax Ordinance's amounts are not
  indexed in 2025-2027 (s. 120B(e)). The brackets, credit point, surtax threshold, pension credit cap and National Insurance
  rates are now confirmed, from the Knesset Book of Laws (nos. 3511 and 3342), the Knesset Research and Information
  Center and the National Insurance Institute's rates page (read from its Internet Archive copy; gov.il and btl.gov.il
  still refuse automated access). **Not confirmed**: the 25% rates on capital gains, dividends and interest; the
  partial exemption for qualifying pension annuities (not applied, so pensions are taxed in full); how the Bituach
  Leumi old-age allowance is taxed (taxed as ordinary income); and how indexation resumes in 2028 after the 2025-2027
  freeze (Glideworth indexes from 2027 with the plan's threshold policy).
- US states: **not confirmed from an official source** (2026-11-19): Idaho's 2026 zero-rate band (indexed yearly and
  not yet published, so the 2025 amounts, $4,811 / $9,622, are used; Idaho's 5.3% rate, federal standard deduction
  and federal senior deduction were confirmed on 2026-11-22 from Idaho Code 63-3024, 63-3022 and 63-3004 and the 2025
  Form 40 instructions, read from Internet Archive copies as both official sites refuse automated access); Arizona's
  2.5% rate (confirmed only by a 2025 legislative fiscal note) and whether voters approved a 2.0% rate from 2027;
  whether Colorado adds back the federal senior deduction; and 2026 amounts not yet published, for which the 2025
  amounts are used: Louisiana's final standard deduction, Maine's pension deduction phase-out, Montana's senior
  subtraction, Ohio's exemptions, Rhode Island's retirement income limits, South Carolina's dependent exemption and
  Vermont's brackets. Each is named in that state's simplifications.
- Canada (checked 2026-11-19): Quebec's three lower rates (14% / 19% / 24%) and Quebec's dividend tax credits are
  **not confirmed from an official source** (Revenu Québec refused automated access); Quebec's thresholds and basic
  amount are confirmed from Quebec's Ministère des Finances and the 25.75% top rate from the Manitoba Budget 2026.
  Manitoba's 2026 brackets: the T4127 and Manitoba Finance give 47,000 / 100,000 (used), CRA's current-year rates
  page shows 47,564 / 101,200 (**not resolved**). Newfoundland and Labrador's 15,000 basic amount from 2027 may be
  indexed for 2027 (not confirmed). Provincial dividend tax credits are CRA's 2025 rates (2026 worksheets not
  published). QPP's 2027 rate is not confirmed (the 2026 rate is kept). Federal, other provincial, CPP, EI, OAS,
  RRSP/TFSA and RRIF figures were confirmed from CRA.
- Netherlands (checked 2026-11-19 against the Belastingdienst): the 2026 Box 3 deemed returns for savings (1.28%) and
  debts (2.70%) are provisional; the counter-evidence route (Wet tegenbewijsregeling box 3) is not applied, so Box 3
  is always the deemed return. The Wet werkelijk rendement box 3 (actual return from 2028) passed the Tweede Kamer on
  12 February 2026 and was still before the Eerste Kamer, with novelle 37.053, on 2026-11-19: **not law, not
  applied**; the model assumes the deemed-return system continues. No 2027 figures are used (2026 indexed). AOW age
  is set to 2032 (67y3m); later cohorts are assumed to stay at 67y3m. The SVB page on AOW deductions confirms the Zvw
  contribution is withheld from the AOW; the Belastingdienst Zvw page names pensions and benefits but not the AOW by
  name.
- Germany (checked 2026-11-19 against gesetze-im-internet.de, the Bundesregierung, BMG and DRV, and the BMF
  Lohnsteuer interface): the Einkommensteuerreformgesetz 2027 (Grundfreibetrag €12,564 in 2027 and €12,900 in 2028,
  Arbeitnehmer-Pauschbetrag €1,430) is a cabinet draft of 2 September 2026, **not enacted and not applied** (2026
  indexed). The Altersvorsorgereformgesetz replaces Riester for new contracts from 2027; its §10a deduction maximum is
  **not confirmed**, so €2,100 is kept for every year. The Aktivrente (§3 Nr. 21 EStG, €24,000 a year) is confirmed in
  the statute; its Bundesgesetzblatt citation was not looked up. Health insurance contribution rates for 2027 are not
  published (the 2026 rates are used).
- France (checked 2026-11-19 against service-public.gouv.fr, BOFiP and Légifrance; impots.gouv.fr was down for
  maintenance): the projet de loi de finances pour 2027 (barème for 2026 income; a proposed €3,000 sub-cap on the 10%
  pension allowance) is **not enacted and not applied** (the 2025-income barème is indexed). The 2027 PASS of €48,900
  announced by service-public.gouv.fr is not applied (2026 indexed). AGIRC-ARRCO rates and the PER ceilings were
  **not re-read** in this pass (the AGIRC-ARRCO site's certificate failed); they are unchanged since 2019. The 18.6%
  social-contribution rate on PEA gains is the general rate from service-public F2329; the PEA pages do not state a
  rate. The CDHR (minimum 20% tax above €250,000 / €500,000) is extended by the 2026 finance law per secondary
  sources only; it is not modelled.
- US TCJA-sunset variant: an estimate, not law.
- Ireland (checked 2026-11-19): CGT is 33% to 6 October 2026 and 31% from 7 October 2026 (Revenue); with no disposal
  dates, 2026 uses the average by days (32.53%) and 2027 onward 31%. The 2027 table is Budget 2027 as announced
  (Department of Finance Tax Policy Changes book and summary, Parliamentary Budget Office paper; Finance (No. 2) Bill
  2026 not yet enacted). The married person's credit of €4,250 is not stated in words in an official source: it is
  implied by the Department of Finance's Table 3 (married, one income) figures, which only add up with it. Class A
  PRSI is 4.5% from 1 October 2027 (the agreed increases in the same book); any rise after that is **not confirmed**
  and not applied (later years use 4.5%). The State Pension (Contributory) is €299.30 a week in 2026 and €309.30 in
  2027 (Citizens Information); it is an income you enter. ARF imputed distribution rates and the standard fund
  threshold are not modelled. The exit-tax figures (38% in 2026, 35% announced for 2027) are cited but not modelled.
- UK (checked 2026-11-19): the 2027/28 savings and property rates of 24%, 44% and 49% and the Pension Tax Allowance
  are Budget 2026 announcements awaiting Finance Bill 2026-27 (Finance Act 2026 enacted 22%, 42% and 47%). The
  Pension Tax Allowance is fully withdrawn at about £13,317 by its published formula, while Annex A says £13,319
  (probably rounding; **not resolved**). The government will uprate it with the new State Pension, but the 2028/29
  and 2029/30 amounts are not published, so the 2027/28 threshold is indexed with prices. The 2027/28 State Pension
  (£250.70 a week) is the DWP's proposed rate. Scottish property income rates and Scottish thresholds for 2027/28 are
  not set yet (Scottish rates are kept on property income; higher and advanced thresholds are assumed frozen through
  2027/28). Student loan thresholds for 2027/28 are not published (Plan 2 is held, as announced; the others are
  indexed with prices). The salary sacrifice NI cap from April 2029 awaits secondary legislation. State Pension age
  follows the legislated timetable; the government's third review has not reported.
- Spain (checked 2026-11-19): the state IRPF scales, savings scale, minimums, work-income reduction and pension-plan
  limit are confirmed for 2025 and 2026 from the BOE consolidated text of the IRPF law; social security for 2026 from
  the Seguridad Social; the wealth tax and the solidarity tax on large fortunes from the AEAT 2025 manual and Ley
  38/2022. **Not confirmed**: the 2026 regional IRPF scales and 2026 regional wealth tax rules (the 2025 ones are used).
  Only five regions have their own scales (Galicia's 2025 scale checked 2026-11-22 against the AEAT 2025 manual and
  art. 4 of Decreto Legislativo 1/2011 in the BOE; Galicia's own wealth tax scale and 50% bonificación are not
  modelled); any other region is assumed to have a scale equal to the state scale.
- No preset has been checked line by line against an official calculator for every case.
- UAE (checked 2026-11-19): no personal income tax, so no rate is modelled; the gratuity, savings scheme, DEWS and
  GPSSA figures were confirmed on the government portal, the DIFC Employment Law and GPSSA. The gratuity's daily wage
  (monthly basic / 30) is Glideworth's convention, and whether the two-year cap uses basic or total wage is not settled
  on the government portal (basic is used); the DEWS voluntary-savings cap and GPSSA eligibility ages could not be
  confirmed and are not modelled.
- Assets abroad (checked 2026-11-19 against the treaty texts on gov.uk and canada.ca, HMRC DT4604/DT4610, IRS
  Publications 54, 514 and 519 and Rev. Procs. 2025-32 and 2026-35, Revenue.ie, the Agencia Tributaria, BOFiP and
  §50 EStG). Australia's foreign-resident rates, and that foreign residents get no LITO or Medicare levy, were read
  in the Income Tax Rates Act 1986 Schedule 7 Part II, ITAA 1997 s 61-110 and ITAA 1936 ss 251T and 251U on
  legislation.gov.au on 2026-11-22; the 50% CGT discount is still applied to a foreign resident's Australian property
  gains, so that tax is too low. **Not confirmed**: whether the US exempts
  the UK tax-free lump sum of a US resident under UK-US Art. 17(1)(b) (taxed in full here; no IRS guidance found);
  whether the UK applies the UK-US saving clause to its residents' US lump sums (not applied); which countries
  have a US social security agreement (ssa.gov refused access; foreign social security contributions are never
  credited against US tax here); the 7.5% French levy for EEA residents rests on BOFiP's reference to EU social
  security coordination (EEA states assumed included). The treaty pairs are checked for pensions, social security,
  dividends, interest and gains only, not every article or condition. Non-resident rules of the Netherlands,
  Israel and New Zealand are not checked (resident rates and allowances are used).
- Cross-border tax is an estimate of the tax mechanics only: residence is the household's location for the whole
  plan (no statutory residence test, no 183-day rules, no moves), and treaty relief assumes it is claimed.

Tax sources, checked 2026-11-16 and 2026-11-19 (the status of each country's sourcing; licences are in `DATA-LICENSES.md`):

| Country                           | Sourcing status                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| US federal, payroll               | ok (IRS, SSA, CMS; 2027 figures checked 2026-11-19)                                                               |
| US states and cities              | ok for 50 states, DC, 5 cities (2026-11-19; ID 11-22); not confirmed: ID 2026 zero band, 9 states' figures above  |
| Canada                            | ok (CRA, provinces; 2026-11-19); Quebec lower rates and Manitoba bracket conflict not confirmed (above)           |
| Israel                            | ok on brackets, credit point, surtax and NI (Knesset, NII; 2026-11-19); capital-income rates not confirmed        |
| United Arab Emirates              | ok (u.ae, FTA, DIFC, GPSSA; 2026-11-19)                                                                           |
| Australia                         | ok on facts (legislation, 2026-11-19; super caps from the ATO, 2026-11-22)                                        |
| Ireland                           | ok on facts for 2026 (Revenue); 2027 from Budget 2027 documents (2026-11-19); gaps above                          |
| New Zealand                       | ok (IRD, 2026-11-19: rates from 1 April 2025, ACC levy 2026-27 and 2027-28)                                       |
| UK                                | ok (gov.uk, legislation.gov.uk, Budget 2026; checked 2026-11-19); gaps above                                      |
| Germany                           | ok (statutes, Bundesregierung, BMG, DRV; BMF Lohnsteuer cross-check; 2026-11-19); gaps above                      |
| Netherlands                       | ok (Belastingdienst, SVB, Rijksoverheid, Eerste Kamer; 2026-11-19); Box 3 provisional, gaps above                 |
| France                            | ok (service-public.gouv.fr, BOFiP, Légifrance; 2026-11-19); gaps above                                            |
| Spain                             | ok (BOE, AEAT, Seguridad Social; 2026-11-19); 2026 regional scales not confirmed                                  |
| Assets abroad (`tax/crossborder`) | ok for the treaty pairs and the US, UK, Irish, Spanish, French and German rules checked on 2026-11-19; gaps above |

US traditional IRA deduction phase-out (IRC 219(g), checked 2026-11-23): the statute (26 U.S.C. 219(g), United
States Code 2024 edition on govinfo.gov), the 2026 ranges in IR-2025-111 and the 2027 ranges in IR-2026-136 on
irs.gov, and Publication 590-A for the qualifying-surviving-spouse and head-of-household ranges and the MAGI worksheet.
Not modelled: defined benefit pension coverage (a person is covered only when money goes into a defined contribution
workplace account in the year), married people filing separately who lived apart all year (the separate-return
range is used), the Roth IRA contribution phase-out, and Form 8606 aggregation of basis across all of an owner's
IRAs (basis is tracked per account).

Each country's full list of simplifications is `TAX_SIMPLIFICATIONS`
(`packages/core/src/tax/data/simplifications.ts`) and is shown with the tax results. Highlights: US SALT cap and
itemised phase-outs not applied, AMT adds back only the standard and senior deductions, no EITC or education credits; Canada no
AMT, GIS is an amount you enter; Australia no SAPTO, HELP, Medicare levy surcharge or Division 296 tax; UK no pension allowance
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
- **Dependents.** A dependent counts in a year when they are born by the year's end and younger than their own
  "independent at" age at its start (`engine/dependents.ts`). The US child tax credit, the automatic ACA household
  size (living adults on the return plus these dependents) and survivor filing status all read this one rule; no
  IRS qualifying-child test beyond each credit's own age limit is applied (engine 0.7.0). A stored ACA household
  size is a manual override (schema 6).

### Not modelled

Monthly or daily resolution; randomised lifespan and care shocks in Monte Carlo; account aggregation (by design);
live sync with budgeting apps; server-side PDF; municipal/Treasury bond-income split; the US EITC and education
credits; means-tested benefits (UK Universal Credit, Pension Credit); loss harvesting and specific-lot selling;
end-to-end encrypted sync; per-person privacy within a household.

### Partial features (see PARITY.md)

US federal tax, Canada CPP/OAS/GIS, Germany, Netherlands, France, Spain, Israel, Ireland and New Zealand (basic
level); debt payoff strategies (allocation only); datasets; drawdown-order editor graphs; Flex vs No-Flex table; tax optimizer depth;
strategy and income-by-rate heatmaps; table export (four tables, not any plot); reports (browser print only);
share links; re-run on plan change (on request, not on every edit); household collaboration (roles are
instance-wide); onboarding data-quality checks; scheduled re-runs (no e-mail; use webhooks); open test vectors
(no published validation report).

## Cross-border plans: what is exposed

Core plus API, MCP and web. API: `/plans/{id}/cross-border/items`, `insights/explain-taxation`,
`tax-breakdown/by-country` (and country/basis in `tax-breakdown`), rule tables under `/cross-border/*`; citizenships
and the US green card are fields of the person routes; the result cache keys on the engine version. MCP:
`cross_border_rules`, `tax_by_country`, `explain_item_taxation`, `list_fx_rates`, `set_fx_rate`, `unset_fx_rate`.
Web: see USER-GUIDE.md "Where to find it in the app". Core: `explainItemTaxation`, `crossBorderItems`,
`taxByCountry`, `CROSS_BORDER_SIMPLIFICATIONS`, country names (not codes) in explanations and person names (not ids)
in cross-border tax-line labels.

Known gaps for cross-border users: residence is the household's location for the whole plan (no statutory
residence test, no moves); the bracket and marginal-rate analytics on the Taxes page describe the household
country's calculation only; planned real assets and plan-level account overrides have no country field in the plan
editor (set it on the item in Current finances); the gratuity is UAE-only; the UK's 5-year pension relief after
leaving is not modelled (contributions to UK pensions stop while you live abroad).

## What remains, in priority order

1. Tax depth and verification against official calculators: US SALT cap, itemised phase-outs, AMT items, EITC;
   GIS income test; AU SAPTO and HELP; each country's `TAX_SIMPLIFICATIONS`; yearly table updates.
2. Datasets: Canadian, Australian and euro-area history; UK after 2020 (and the non-commercial licence).
3. Direct integrations for balance sync (Lunch Money, YNAB, Monarch, Actual).
4. Optimizer depth and the Flex vs No-Flex comparison.
5. Randomised lifespan and care shocks inside Monte Carlo.
6. Monthly resolution.
7. Server-side PDF. (The "results changed because" report is built: `explain_result_change`, the dashboard's
   check-in card; maximum spending and the earliest-retirement solver are not split yet.)
8. Completeness score and data-quality nudges in onboarding.
