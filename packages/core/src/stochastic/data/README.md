# Historical market data

Annual nominal returns used by `historical-random-restart`, `historical-sequential` and
`block-bootstrap` runs (`MonteCarloSettings.dataset`) and by deterministic `RateSpec.historical`
sequences (`HISTORICAL_SERIES`, which reads `us-1928`). Built from the public sources below by
[`scripts/build_datasets.py`](./scripts/build_datasets.py) (`us-1928`) and
[`scripts/build_uk_open.py`](./scripts/build_uk_open.py) (`uk-1983`). Nothing here was typed in by
hand or estimated: every value is an arithmetic transformation of a source cell, rounded to 6 decimal
places. Licence evidence for every source: [`DATA-LICENSES.md`](../../../../../DATA-LICENSES.md).

Each dataset has the six series the engine's `MarketPeriod` needs:

| series          | meaning                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `stocks`        | equity price return, excluding dividends                                                                     |
| `dividendYield` | dividends paid in the year divided by the price at the start of the year                                     |
| `bonds`         | government bond total return minus `bondYield` (so `bonds + bondYield` is the source's total return exactly) |
| `bondYield`     | bond income for the year (coupon)                                                                            |
| `cash`          | short-term rate; `null` where the source has none                                                            |
| `inflation`     | consumer price inflation                                                                                     |

Crypto has no long history, so historical runs draw crypto from the `distributions.crypto`
normal distribution (independently of the sampled year) when `vary.crypto` is on.

## Attribution (must be displayed)

`DATASET_ATTRIBUTIONS` in `index.ts` (and `MarketDataset.attribution`) carries the statements for the
app's dataset panels and "About the data" page:

- "Contains public sector information licensed under the Open Government Licence v3.0. Sources: Office
  for National Statistics (CPI, RPI); Bank of England (Bank Rate, gilt yields)." (`uk-1983`; a licence
  condition) with a link to the OGL v3.0.
- "Exchange rates: Board of Governors of the Federal Reserve System, H.10 Foreign Exchange Rates." (`uk-1983`)
- "US inflation: U.S. Bureau of Labor Statistics, Consumer Price Index for All Urban Consumers (CPI-U),
  series CUUR0000SA0." (`us-1928`)
- "US stock, bond and bill returns: Aswath Damodaran, Historical Returns on Stocks, Bonds and Bills, NYU
  Stern (pages.stern.nyu.edu/~adamodar)." (`us-1928`, `uk-1983`)

## `us-1928`: US, 1928 to 2025, calendar years (default for every country, including the UK)

- **Stocks and dividends.** Aswath Damodaran, _Historical Returns on Stocks, Bonds and Bills_,
  `histretSP.xls`, sheet "S&P 500 & Raw Data" (S&P 500, back-filled before 1957 by Damodaran).
  `stocks = P(y) / P(y-1) - 1`, `dividendYield = D(y) / P(y-1)`, where P is the year-end index level
  and D the dividends paid in year y. The build checks that their sum equals Damodaran's published
  total return to 1e-9.
  <https://pages.stern.nyu.edu/~adamodar/pc/datasets/histretSP.xls>
- **Bonds.** Same file: 10-year US Treasury total return (Damodaran reprices a constant-maturity
  10-year bond bought at par at last year's published 10-year Treasury yield). `bondYield` = previous year-end 10-year
  yield (the coupon of that bond), `bonds` = total return minus that coupon.
- **Cash.** Same file: 3-month T-bill, average rate over the year.
- **Inflation.** US BLS CPI-U, all items, not seasonally adjusted (BLS series `CUUR0000SA0`),
  December to December, to align with the calendar-year returns, downloaded from the Bureau of Labor
  Statistics by [`scripts/fetch_bls_cpi.py`](./scripts/fetch_bls_cpi.py) (BLS Public Data API, or the
  BLS series page when the API's daily limit is reached). Rebuilt this way on 2026-11-16: all 588
  values of `us-1928` came out identical to the previous build. (Damodaran's own inflation column
  uses annual averages, so it is not used.) <https://data.bls.gov/timeseries/CUUR0000SA0>
- **Licence.** Damodaran's usage rules: "I want the data to be widely used… If you do use my data
  and wish to acknowledge that you did get the data off my site, I thank you." BLS CPI data is a US
  government work in the public domain.

## `uk-1983`: UK, 1983 to 2025, calendar years

Built by `scripts/build_uk_open.py` (construction per series in its docstring; decision and statistics
in `docs/design/uk-dataset-replacement.md`):

- **Inflation.** ONS CPI index D7BT, December to December, from 1989; ONS RPI long-run index CDKO for
  1983-1988 (CPI has no December 1987 value). OGL v3.0.
- **Cash.** Bank of England Official Bank Rate, annual average (IADB IUAABEDR). OGL v3.0.
- **Gilts.** Bank of England 10-year nominal zero-coupon gilt yield (IADB IUDMNZC), last December
  value, priced as a 10-year par bond held for one year (`bondYield` = coupon, `bonds` = price change).
  OGL v3.0.
- **Equities.** S&P 500 price and dividends (Damodaran, the `us-1928` source) converted to sterling at
  the last December Federal Reserve H.10 noon buying rate (public domain). **These are US shares held by
  a sterling investor, not UK shares**: no openly licensed UK share history exists. No withholding tax.
- **Limits.** 43 years, all after 1982: no 1970s inflation, no wartime years; US shares beat UK shares
  over the period. Runs on it are more optimistic than long UK history, which is why UK plans default to
  `us-1928`. A plan longer than 43 years cannot use `historical-sequential` on it.

## Optional, not bundled: `us-1871-local` (Shiller, personal use)

Robert Shiller's `ie_data.xls` (shillerdata.com) has no explicit licence, so it is not distributed with
Glideworth (repository, builds, hosted service). A self-hoster may download it for personal use:

```
uv run --with xlrd python -I scripts/fetch_shiller_local.py ~/glideworth-local-data
export GLIDEWORTH_LOCAL_DATA_DIR=~/glideworth-local-data      # read by the API, CLI and MCP (Node only)
```

The script writes `us-1871.json` (same construction as the dataset Glideworth used to bundle: January to
January, Shiller's monthly bond returns, Damodaran T-bills from 1928, `cash: null` before). The engine
loads it lazily as dataset `us-1871-local` (`getMarketDataset`, `registerLocalDataset`). It is never
loaded in the browser. Keep the directory outside the repository; `data-local/` at the repository root is
git- and docker-ignored.

## Withdrawn datasets

- `uk-1871` (UK 1871-2020, Jordà-Schularick-Taylor Macrohistory Database, CC BY-NC-SA 4.0): removed
  because its licence forbids commercial use. Old plans are read as `uk-1983` with a `DATASET_REPLACED`
  notice.
- `us-1871` (Shiller, bundled until 2026-11-16): removed because it has no licence. Old plans are read
  as `us-1928` with a notice; see the optional download above.

## Not included, and why

- **Global equities.** No openly licensed published global index series was found (MSCI and
  Dimson-Marsh-Staunton data are proprietary).
- **UK equities.** FTSE All-Share, MSCI UK, the Barclays Equity Gilt Study and Dimson-Marsh-Staunton are
  proprietary; see `DATA-LICENSES.md`.
- **Crypto.** No public multi-decade history exists.

## Rebuilding

Instructions are in the docstrings of `scripts/build_datasets.py` (with `scripts/fetch_bls_cpi.py`) and
`scripts/build_uk_open.py`. Both need `xlrd` (for example
`uv run --with xlrd python -I build_datasets.py <downloads> <this dir>`). Update the year ranges in
`index.ts` labels by rebuilding (they are generated from `firstYear`/`lastYear`). The generated `*.generated.ts` files are excluded from oxfmt and oxlint (`.prettierignore`, `.oxlintignore`), so there is no format step.
