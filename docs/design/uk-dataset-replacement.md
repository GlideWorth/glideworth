# Replacing the UK historical dataset (`uk-1871` → `uk-1983`)

Status: **wired 2026-11-16** (`uk-1871` removed, `uk-1983` registered, migration and notice in place, GB
default decided: see "Default for UK plans" and "What was implemented" below). Licence evidence for every
source: `DATA-LICENSES.md`.

## Decision

`uk-1871` is derived from the Jordà-Schularick-Taylor Macrohistory Database (CC BY-NC-SA 4.0). Its
site says "Commercial data providers are thus strictly forbidden to integrate all or parts of the
dataset into their services". It cannot ship in the paid service or in the AGPL repository. It is
replaced by **`uk-1983`**: UK inflation, cash and gilts from openly licensed official sources, with **US
equities converted to sterling** standing in for equities. No openly licensed UK equity history exists
to use instead.

| Series                | `uk-1983` source                                                                                                                            | Licence                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| inflation             | ONS CPI index D7BT, December to December, 1989 on; ONS RPI long-run index CDKO, 1983-1988                                                   | OGL v3.0                               |
| cash                  | Bank of England Official Bank Rate, annual average (IADB IUAABEDR)                                                                          | OGL v3.0                               |
| bondYield, bonds      | Bank of England 10-year nominal zero-coupon gilt yield (IADB IUDMNZC), last December value, priced as a 10-year par bond held one year      | OGL v3.0                               |
| stocks, dividendYield | S&P 500 price and dividends (Damodaran `histretSP.xls`, the `us-1928` source) × USD/GBP at the last December Federal Reserve H.10 noon rate | Damodaran free use; H.10 public domain |

Files (all new): `packages/core/src/stochastic/data/scripts/build_uk_open.py` (downloads and builds),
`packages/core/src/stochastic/data/uk-open.generated.ts` (`UK_1983_RAW: RawHistoricalData`, 1983-2025),
`packages/core/test/uk-open-dataset.test.ts`. Also `scripts/fetch_bls_cpi.py`, which fixes the separate
FRED problem in `us-1928` (see `DATA-LICENSES.md`).

**How solid the licence footing is.** Inflation, cash and gilts come from the ONS and the Bank of
England Database. Both are explicitly OGL v3.0, which allows commercial exploitation with an
attribution statement; this is as solid as UK data gets. The exchange rate is a US federal work
(public domain, citation requested). The equity series inherits `us-1928`'s footing: Damodaran
permits free use, but the values are S&P 500 index levels and dividends, and S&P Dow Jones Indices'
rights in those annual figures are unverified (the same residual risk the current default `us-1928`
already carries). One residual note: the Bank's gilt curves are fitted from Bloomberg and Tradeweb
price inputs. The Database series is not flagged as third-party, and the Bank's legal page puts
Database data under OGL.

## Why this and not something else

Investigated on 2026-11-16 (sources in `DATA-LICENSES.md`):

1. **No open UK equity total-return series exists.** FTSE All-Share (LSEG), MSCI UK, the Barclays
   Equity Gilt Study and Dimson-Marsh-Staunton are proprietary. JST is non-commercial.
2. **Bank of England "A millennium of macroeconomic data" is not a way round it.** It is a website
   resource, not the Database. The Bank's legal page limits website resources to "personal use or
   internal use within an individual organisation for non-commercial purposes" unless stated
   otherwise, and the spreadsheet states no licence (its only sheet-level text is a disclaimer that
   points to the website terms). Its share-price index switches to the **FTSE All-Share** from 1962,
   has **no dividends**, and stops in 2016. Its corporate bond yields are "BofA Merrill Lynch Global
   Research, used with permissions". So even with the Bank's permission, its equity series would be
   third-party data.
3. **Bank of England spot exchange rates** can be sourced from Bloomberg BFIX and LSEG, with an LSEG
   redistribution ban. The Fed's H.10 (public domain, daily since 1971) is used instead.
4. **The start year is set by the gilt series.** The Bank of England Database starts in 1963, and its
   10-year gilt yield (zero-coupon) only from January 1982, so 1983 is the first year with a priced
   gilt return. Bank Rate and the open FX series go back to 1975 and 1971, and RPI monthly to 1947.
   **OECD** long-term rates and exchange rates go back to 1960 and could take the dataset to 1961
   (with `cash: null` before 1975). That was not used, because oecd.org returned 403 for its licence
   pages, so its CC BY 4.0 status could not be confirmed. The Bank's yield-curve archive (from 1970) is
   a website resource with the same non-commercial default as (2).
5. **Why US equities in sterling and not a parametric UK equity default.** The engine already supports
   per-series sources (`MonteCarloSettings.sources.stocks = 'distribution'`), but those draws are
   independent normals (`applySources` in `stochastic/samplers.ts`). They would discard the year-by-year
   co-movement of equities with gilts, cash and UK inflation, which is the point of a historical run.
   A sterling investor holding US equities is a real portfolio: many UK investors hold global or US
   index trackers. The FX conversion also carries real currency risk. For example, in 2008 the S&P
   500's price return was −38.5% in dollars and −16.5% in sterling. The parametric route stays
   available to users who prefer it.

## What changes statistically

From a comparison script run on 2026-11-16 (`uk-1871` = `jst.generated.ts`, `uk-1983` =
`uk-open.generated.ts`). Cells are arithmetic mean / standard deviation / geometric mean of the annual
values. `equityTR` = stocks + dividendYield, `bondTR` = bonds + bondYield, and real = deflated by that
year's inflation.

Coverage: `uk-1871` 1871-2020 (150 years); `uk-1983` 1983-2025 (43 years).

| series        | uk-1871 full 1871-2020 | uk-1871 1983-2020     | uk-1983 1983-2020     | uk-1983 full 1983-2025 |
| ------------- | ---------------------- | --------------------- | --------------------- | ---------------------- |
| equityTR      | 10.0% / 19.3% / 8.5%   | 11.2% / 15.6% / 10.0% | 13.6% / 17.9% / 12.1% | 13.8% / 17.5% / 12.4%  |
| stocks        | 5.6% / 18.5% / 4.2%    | 7.2% / 15.0% / 6.1%   | 10.9% / 17.4% / 9.5%  | 11.3% / 17.0% / 9.9%   |
| dividendYield | 4.4% / 1.3% / 4.3%     | 3.9% / 1.0% / 3.9%    | 2.6% / 1.2% / 2.6%    | 2.5% / 1.1% / 2.5%     |
| bondTR        | 5.3% / 10.4% / 4.8%    | 8.5% / 8.0% / 8.2%    | 8.3% / 7.7% / 8.1%    | 6.9% / 8.9% / 6.5%     |
| bondYield     | 5.0% / 3.0% / 4.9%     | 6.1% / 3.1% / 6.0%    | 6.0% / 3.5% / 6.0%    | 5.7% / 3.6% / 5.6%     |
| cash          | 4.1% / 3.3% / 4.0%     | 5.1% / 4.1% / 5.0%    | 5.3% / 4.2% / 5.2%    | 5.1% / 4.1% / 5.0%     |
| inflation     | 3.2% / 5.5% / 3.0%     | 2.7% / 1.7% / 2.7%    | 2.8% / 1.9% / 2.8%    | 3.1% / 2.1% / 3.1%     |
| realEquity    | 6.8% / 17.6% / 5.3%    | 8.2% / 14.9% / 7.1%   | 10.4% / 17.2% / 9.0%  | 10.4% / 17.0% / 9.0%   |
| realBond      | 2.3% / 10.9% / 1.8%    | 5.6% / 7.4% / 5.3%    | 5.3% / 7.2% / 5.1%    | 3.7% / 8.9% / 3.3%     |
| realCash      | 1.1% / 4.8% / 1.0%     | 2.3% / 3.1% / 2.2%    | 2.4% / 3.1% / 2.4%    | 1.9% / 3.5% / 1.8%     |

Correlation with `uk-1871` over the shared years 1983-2020: equity total return 0.77, stocks 0.76,
dividend yield 0.84, gilt total return 0.96, bond yield 0.98, cash 1.00, inflation 0.93, real equity
0.75, real gilts 0.96, real cash 0.97.

Worst equity years over 1983-2020: `uk-1871` 2008 −29.8%, 2002 −22.3%, 2001 −13.2%, 1990 −9.6%;
`uk-1983` 2002 −29.5%, 1990 −18.8%, 1987 −16.8%, 2008 −13.9% (sterling fell in 2008, softening the
loss).

Years only `uk-1983` has:

| year | inflation | gilt total return | equity total return (GBP) | cash  |
| ---- | --------- | ----------------- | ------------------------- | ----- |
| 2021 | 5.4%      | −6.2%             | 30.0%                     | 0.11% |
| 2022 | 10.5%     | −20.2%            | −8.4%                     | 1.47% |
| 2023 | 3.9%      | 5.0%              | 19.5%                     | 4.68% |
| 2024 | 2.6%      | −3.8%             | 27.1%                     | 5.11% |
| 2025 | 3.3%      | 4.7%              | 9.6%                      | 4.25% |

Gilt-method check: over 1994-2025, gilt total returns priced from the zero-coupon yield (annual
coupon) and from the Bank's 10-year par yield (semi-annual coupon) agree closely: mean 4.49% vs 4.41%,
standard deviation 8.66% vs 8.50%, correlation 0.998, largest single-year gap 1.3 points.

**What is lost versus `uk-1871`, plainly:**

- **107 years of history**, including both world wars (WW1: real equities −35%, real gilts −51%),
  the 1973-74 crash (real equities −72%, real gilts −39%), 1975's 22.7% inflation and most of the
  1970s stagflation. For a UK planner these are the worst sequences on record. `uk-1983` has
  nothing worse than 2002, 2008 and the 2022 gilt crash.
- **UK equities themselves.** The equity series is the US market in sterling. Over 1983-2020 it
  returned about 1.9 points a year more than UK equities after inflation (geometric 9.0% vs 7.1%). Over
  its whole span its real geometric return (9.0%) is far above the UK's 150-year 5.3%. **Historical runs
  on `uk-1983` will be more optimistic than on `uk-1871`.** Real cash and real gilts are also higher
  than the long run, because 1983-2020 was a falling-rate era. The 2021-25 years pull gilts back down.
- **Window count.** `historical-sequential` gets 43 − N + 1 windows (14 for a 30-year plan, 4 for a
  40-year plan) instead of 121 and 111. Plans longer than 43 years cannot use `historical-sequential`
  at all (`trialCountFor` throws a ScenarioError). `historical-random-restart` and `block-bootstrap`
  still work.
- **Basis changes.** Inflation is now December to December (JST used annual averages). It is CPI from
  1989 and RPI for 1983-88; RPI runs higher than CPI, so those six years overstate CPI-basis inflation
  slightly. Cash is Bank Rate, not the Treasury bill rate (the Bank's T-bill series stops in 2017). The
  two correlate at 1.00 with the JST bill rate over the overlap. Dividends are gross: no US withholding
  tax.

**What is gained:** 2021-2025 (the 2022 inflation spike and gilt crash), a series that can be rebuilt
every year by script, and a clean licence.

## Default for UK plans (decided 2026-11-16): `us-1928`, not `uk-1983`

`uk-1983` has 43 years, all after 1982, and its equity series is US shares in sterling. Sequential runs
of a plan longer than 43 years cannot work at all, and random-restart and block-bootstrap resample the
same 43 years, the best stretch of modern market history for a sterling 60/40 investor. The question is
which default gives a UK household the most defensible chance of success.

Measured on the UK sample household (`createUkSampleDocument`, Sam, retire at 60, plan to 92: 45 years,
2026-2070), seed 42. The plan as shipped is very well funded, so every historical option shows ~100%;
the spending was then raised until outcomes vary (living costs per month; 1,000 trials each, seed 42).
`uk-1871` (JST, withdrawn) is shown for reference only, as the best available picture of long UK history.

| Option                                          |   As shipped (2,300/month) | 2,900/month | 3,300/month | 3,700/month |
| ----------------------------------------------- | -------------------------: | ----------: | ----------: | ----------: |
| `uk-1983` random restart                        |                     100.0% |       93.8% |       73.7% |       38.5% |
| `uk-1983` block bootstrap (5 years)             |                      99.8% |       89.9% |       69.1% |       43.3% |
| `uk-1983` every start year once (sequential)    | cannot run (45 > 43 years) |           - |           - |           - |
| `us-1928` random restart                        |                     100.0% |       74.5% |       48.0% |       16.5% |
| `us-1928` block bootstrap (5 years)             |                      96.5% |       69.7% |       43.9% |       19.1% |
| `us-1928` sequential (54 windows)               |                     100.0% |       64.8% |       42.6% |       11.1% |
| `us-1928` random restart, UK plan inflation     |                     100.0% |       73.8% |       45.4% |       18.9% |
| Parametric normal (schema defaults)             |                      84.5% |       37.7% |       15.1% |        5.0% |
| Parametric log-normal (schema defaults)         |                      84.7% |       36.3% |       14.4% |        5.0% |
| Reference: `uk-1871` random restart (withdrawn) |                      94.5% |       50.0% |       23.7% |       11.8% |
| Reference: `uk-1871` sequential (withdrawn)     |                      94.3% |       44.3% |       16.0% |        6.6% |

Engine 0.5.0 (after the cash-flow timing fix; the numbers before it differed by at most 1.3 points). As
shipped = 2,000 trials, the other columns 1,000. (As shipped, 2,000 trials: block bootstrap with 10-year blocks on `uk-1983` 99.8%, normal with fat tails
85.5%; Shiller US 1871 data 100.0%.)

Reading it:

- **`uk-1983` is far more optimistic than long UK history**: 74% where the 150-year UK record gave 24%
  (3,300/month). It would tell a UK household its plan is safe when, on the longest UK evidence, it
  fails three times in four. It is not a defensible default for decisions.
- **`us-1928` is the closest of the shippable options to long UK history** (48% vs 24% at 3,300/month;
  75% vs 50% at 2,900), still optimistic, because US shares beat UK shares over the century. It has 98
  years including the Depression and US 1970s stagflation, supports `historical-sequential` for plans up
  to 98 years, and needs no new data. Results are in real terms: the engine applies the dataset's own
  inflation, so a GBP household sees US real returns. Holding inflation at the UK plan rate instead
  (`vary.inflation: false`) changes little (45% vs 48%).
- **The parametric defaults are the most pessimistic** (15%) but their calibration is arbitrary for a UK
  household (schema defaults: 7% nominal stocks, 17% volatility, 2% nominal bonds against 3% inflation,
  i.e. negative real bond returns) and not derived from any UK history. Calibrating them to the JST
  statistics would rest on the withdrawn data. Not defensible as a default either; they stay available.

**Decision: GB plans default to `us-1928` with the schema-default method (`historical-random-restart`).**
`uk-1983` stays selectable, labelled with its limits. The user-facing note in `defaultsForCountry('GB')`
says why and states that both are more favourable than long-run UK history; the `uk-1983` label, `limits`
and note state its coverage and the US-shares substitution wherever the dataset is shown.

Saved plans that named `uk-1871` are read as `uk-1983`, not as `us-1928`: that
keeps the plan's choice of UK sterling data, and the DATASET_REPLACED notice tells the user that the new UK
history is shorter and likely to look more favourable.

## What was implemented (2026-11-16), and where it departs from the original plan

- Registry (`stochastic/data/index.ts`): `MarketDatasetId = 'us-1928' | 'uk-1983'` (bundled). `us-1871`
  was also removed from the bundle (no licence; `DATA-LICENSES.md`), so the originally planned type is not used. Labels
  are generated from `firstYear`/`lastYear`; every dataset has `limits` and `attribution` strings, and
  `DATASET_ATTRIBUTIONS` exports the statements. Optional `us-1871-local` (Shiller, personal-use download).
- Schema (`schema/montecarlo.ts`): the plan schema's zod union, extended to both retired ids (`RETIRED_DATASETS`:
  `uk-1871` → `uk-1983`, `us-1871` → `us-1928`), no schema-version bump. The originally planned "one-time notice" had
  no mechanism: a transform alone loses the fact that the plan was migrated. So `Plan.monteCarlo` (a
  field-level `z.preprocess`, keeping `Plan` a `ZodObject` for `Plan.omit`) and the stochastic runners'
  settings record `replacedDataset`, and the engine reports a `DATASET_REPLACED` warning (severity
  `warning`, because the web app hides `info` on the dashboard and in reports) in `ProjectionResult.warnings`
  and `MonteCarloResult.warnings`. The marker is dropped when the dataset is changed, and
  `acknowledgeReplacedDataset` clears it; a "dismiss" control in the web app is still to be added (until
  then the notice shows on every run of the plan until the dataset is changed).
- Known gap: an API per-request override (`POST .../monte-carlo` with `settings.dataset: 'uk-1871'`) is
  parsed by `MonteCarloSettings.partial()` in `apps/api/src/schemas.ts` before core sees it, so it runs on
  `uk-1983` with `dataset: 'uk-1983'` in the result but without the notice. Fix (apps/api): parse the
  override through `withReplacedDataset` first.
- Generated OpenAPI snapshot (`apps/site/src/data/openapi.json`): the ten `dataset` enums were patched by
  hand to the generated shape (`anyOf` current ids / retired ids, plus `replacedDataset`), not regenerated,
  because `apps/api` was being changed by another engineer at the time. Regenerate it with
  `pnpm --filter @glideworth/site snapshot:openapi` once that work lands.

## Repository history

The derived `uk-1871` file (`jst.generated.ts`) is not part of this repository's published history: the
public repository starts from a fresh history that never contained it. The JST sections that remain in
`build_datasets.py` and the data README hold only download URLs and descriptions, not data. The derived
file must not ship in any built artifact (package, Docker image or web bundle).

## Rebuilding `uk-1983` each year

Once a year, after the ONS December CPI release (mid-January) and Damodaran's January update:

```
uv run --with xlrd python -I packages/core/src/stochastic/data/scripts/build_uk_open.py --fetch <tmp dir> packages/core/src/stochastic/data
npx vitest run packages/core/test/uk-open-dataset.test.ts
```

The script finds the last year every input covers. Update the label's year range when you rebuild.

## Possible later improvements

- If OECD's CC BY 4.0 licence for its data is confirmed in writing, extend gilts back to 1960 (with
  `cash: null` before 1975) and recover the 1970s, using OECD long-term rates and the Fed H.10 rates
  from 1971.
- Ask the Bank of England for written permission to use its yield-curve archive (1970+) or the
  Millennium dataset's gilt and bank-rate series commercially. Do not use its equity series, which is
  FTSE All-Share after 1962.
- License a UK equity total-return series (FTSE All-Share TR from LSEG, or Barclays) if the product
  needs true UK equities.
