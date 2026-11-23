# Free calculators (`/tools/`)

No-sign-up calculators that run the real planning engine (`@glideworth/core`) in the visitor's browser.
Nothing a visitor types leaves the browser: no network requests, no storage, no analytics
(`privacy.test.ts` checks the source and, after a build, every script a calculator page can load).

## How it fits together

```
specs/index.ts      inputs of every calculator: keys, labels, units, ranges, defaults, helper text (no engine)
state.ts            defaults, validation, URL query string <-> values (no engine)
format.ts           display formatting; currency is for display only, never converted
closed-form.ts      the textbook formulas shown next to the engine's answers
chart.ts, render.ts results -> HTML and inline SVG; used at build time AND in the browser
carry.ts            the hand-off link into the full planner (format below)
registry.ts         names, paths, articles: the /tools/ index and "read next" links
engine/             the only code that imports @glideworth/core
  model.ts          inputs -> SimulationInput (one person, one account, flat tax, fixed horizon)
  coast.ts fire.ts fat-fire.ts barista.ts how-long.ts withdrawal.ts monte-carlo.ts   one module per calculator
  index.ts          runTool(id, values, { signal, onProgress }) -> ViewModel
worker/             engine.worker.ts (Web Worker), handle.ts (shared handler), client.ts (page side)
ui/mount.ts         page controller: plain DOM, no framework
../components/tools ToolPage.astro (page shell), Calculator.astro, Field.astro, PlannerCta.astro
../pages/tools      one page per calculator, plus index.astro
```

- **Build time.** Each page runs `runTool(id, defaults)` and the worked examples through the same engine
  modules, so the static HTML shows real numbers (useful without JavaScript) and cannot drift.
- **In the browser.** The page script (~24 KB, no engine) reads the URL, validates inputs inline, renders
  results with `render.ts` and keeps the query string and the planner link in step. The engine worker
  (one ~0.56 MB chunk, shared by every calculator page and cached) is created on the first interaction
  with the calculator or when the browser is idle. Every calculation runs in the worker; simulations
  report progress and stop on Cancel (`handle.ts`, checked between chunks of 50 trials). Without module
  workers, `client.ts` imports the engine on the main thread instead.

## Conventions every calculator states

- **Today's money.** Deterministic runs set inflation to 0 and use the visitor's return after inflation, so
  every engine figure is already in today's money. History runs take inflation from the data and the
  engine deflates results (`toBasis`: flows by the start-of-year index, balances by the end-of-year index).
- **Annual steps and cash-flow timing.** The engine steps one year at a time. `assumptions.cashFlowTiming`
  is the visitor's choice (default `mid`, the planner's default): a flow is credited with the share
  k = 1 / 0.5 / 0 of that year's return. `closed-form.ts` uses the same convention (F' = F × (1 + r)^k), so
  formula and engine agree exactly apart from whole-year checks and the final part-year (below).
- **Tax.** `plan.tax = { mode: 'flat', flat: { ordinary: <rate> } }` on a `generic-tax-deferred` account, so the
  rate applies to withdrawals only; 0% by default. Income (savings, part-time pay, pensions) is entered
  after tax (`character: 'tax-free'`). No country tax estimates in these tools.
- **Data.** History runs use `us-1928` only (Damodaran S&P 500, 10-year Treasury, T-bills; BLS CPI-U).
  The bundle holds only openly licensed data (`us-1928`, `uk-1983`; see `DATA-LICENSES.md`); the calculators
  are US-history tools and do not name the UK set.
- **Seeds.** Simulations are seeded (default 2026, editable); the same inputs and seed give the same result.

## Calculators and how they use the engine

| Calculator                    | Engine calls                                                                                                                                                                                      | Notes                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Coast FIRE (`coast-fire`)     | `simulate` of a 1,000,000 balance (growth factors), of your balance with yearly saving (coast age = first year end at or above that age's coast number), and with saving stopped at the coast age | Formula: target ÷ (1 + r)^n, agrees to 0.01         |
| FIRE (`fire`)                 | `simulate` with yearly saving and a `financial-independence` milestone (portfolio ≥ FIRE number); `runMonteCarlo` `historical-sequential` on `us-1928` starting with the FIRE number              | Engine years = formula rounded up                   |
| Fat FIRE (`fat-fire`)         | The same `simulate` milestone three times (fat, regular and lean spending at one withdrawal rate); `historical-sequential` history test of the fat number only                                    | Same year-end check as FIRE; comparison is the gap  |
| Barista FIRE (`barista-fire`) | `solveRequiredPortfolio` (objective `noShortfall`, tolerance 1e-7) with spending, part-time pay until an age, flat tax; same for full retirement                                                  | Formula: present value of the net withdrawals       |
| How long (`how-long`)         | `simulate` for 100 years (years = whole funded years + funded share of the first short year); `runMonteCarlo` `historical-sequential`, 40-year window                                             | Formula: −ln(1 − rB/W′) ÷ ln(1 + r)                 |
| Withdrawal (`withdrawal`)     | `withdrawalStrategy` with `initial-percent`, `fixed-percent`, `guyton-klinger` (20%, 10%), `vpw`; `createMonteCarloSession` per rule, same seed; per-trial income from the shard                  | Log-normal real returns or `us-1928` random restart |
| Monte Carlo (`monte-carlo`)   | `createMonteCarloSession`: `historical-random-restart` or `block-bootstrap` (5 years) on `us-1928`, or `normal` with a log-normal shape; success `all-funded`                                     | 95% margin 1.96 √(p(1 − p)/n) shown                 |

Engine behaviour at depletion: since engine 0.5.0 a withdrawal can take only what the account holds at
the time the timing convention places it (`start`: the opening balance; `mid`: the opening balance
grown for half a year), so required portfolios equal the present value to solver precision for every
timing (before, with `start` or `mid` timing, the final withdrawal was paid from the year's grown
balance and required portfolios came out slightly low: 825,413 instead of 825,730 in the Barista
example). One difference remains: in a year with a negative return a `start` or `mid` withdrawal is
not allowed to exceed the account's current (already reduced) balance, so with negative returns the
years-the-money-lasts figure can differ from the formula by up to about 0.03 years.

## Hand-off into the planner (for the app team)

The planner box links to sign-up with the calculator's inputs, so the app can pre-fill a plan:

```
https://app.glideworth.com/signup?from=tool&tool=<id>&v=1&<key>=<value>&...
```

- `from=tool` marks a calculator hand-off; `tool` is one of `coast-fire`, `fire`, `fat-fire`, `barista-fire`,
  `how-long`, `withdrawal`, `monte-carlo`; `v` is the format version (1). Unknown keys must be ignored.
  For `fat-fire`, `spend` is the fat spending level. `lean` and `reg` are comparison levels for the calculator
  only; the planner does not apply them.
- The keys are exactly the calculator page's own query keys (a shared result URL is the same format
  without `from` and `tool`). Every key is always present.
- Money: whole or decimal major units, **today's money, per year**, no grouping (`spend=40000`).
  Percentages: percent numbers (`ret=5` is 5%, `tax=12.5` is 12.5%). Ages and years: whole numbers.
- Only shown while `site.cloudLaunched` is true; until then the box points to self-hosting.

| Key              | Meaning                                                                                                      | Used by                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `cur`            | Display currency, ISO 4217 (USD, GBP, EUR, CAD, AUD, NZD, CHF, AED, SGD); no conversion                      | all                                                             |
| `timing`         | Cash-flow timing: `start`, `mid` or `end` (→ `assumptions.cashFlowTiming`)                                   | all                                                             |
| `age`            | Age now (Barista: age leaving full-time work; Monte Carlo/withdrawal have none)                              | coast-fire, fire, fat-fire, barista-fire, how-long              |
| `retire`         | Retirement age                                                                                               | coast-fire                                                      |
| `balance`        | Invested today / portfolio at the start                                                                      | all                                                             |
| `spend`          | Yearly spending (how-long: yearly withdrawal; fat-fire: the fat level), today's money, rising with inflation | all but withdrawal                                              |
| `wr`             | Withdrawal rate used for the FIRE number, %                                                                  | coast-fire, fire, fat-fire                                      |
| `ret`            | Steady return after inflation, % a year                                                                      | coast-fire, fire, fat-fire, barista-fire, how-long              |
| `save`           | Yearly saving into the portfolio until coast / FI, after tax                                                 | coast-fire, fire, fat-fire                                      |
| `tax`            | Flat tax on portfolio withdrawals, %                                                                         | fire, fat-fire, barista-fire, how-long, withdrawal, monte-carlo |
| `hy`             | Retirement length (years) for the history test of the FIRE number                                            | fire, fat-fire                                                  |
| `stocks`         | Stock share of the portfolio in history runs, % (rest in 10-year Treasuries)                                 | fire, fat-fire, how-long, withdrawal, monte-carlo               |
| `lean`, `reg`    | Yearly spending for the lean and regular comparison, today's money. Not applied by the planner.              | fat-fire                                                        |
| `pt`             | Part-time pay after tax, per year                                                                            | barista-fire                                                    |
| `ptUntil`        | Age the part-time pay stops                                                                                  | barista-fire                                                    |
| `planTo`         | Age the plan runs to                                                                                         | barista-fire                                                    |
| `rate`           | Initial withdrawal rate, %                                                                                   | withdrawal                                                      |
| `years`          | Length of retirement / plan, years                                                                           | withdrawal, monte-carlo                                         |
| `method`         | Market model: `parametric`, `history` (random start years), `block` (5-year blocks, Monte Carlo only)        | withdrawal, monte-carlo                                         |
| `mean`, `vol`    | Log-normal real return: average and standard deviation, % (with `method=parametric`)                         | withdrawal, monte-carlo                                         |
| `trials`         | Number of simulations                                                                                        | withdrawal, monte-carlo                                         |
| `seed`           | Random seed (0 to 4294967295)                                                                                | withdrawal, monte-carlo                                         |
| `inc`, `incFrom` | Other income after tax per year, starting after `incFrom` years                                              | monte-carlo                                                     |

Suggested mapping in the app: one person aged `age`, one investment account with `balance`, a living
expense of `spend` (real, yearly), an income of `save` routed to that account until retirement, a
retirement milestone at `retire` (or `age` for Barista), part-time pay `pt` until `ptUntil`, plan end at
`planTo`, `assumptions.cashFlowTiming = timing`, a bond allocation of 1 − `stocks`/100, Monte Carlo
settings from `method`, `trials`, `seed`. Ask the visitor before replacing tax settings: the tools use a
flat rate, the planner should offer its country estimate.

## Adding a calculator (the country wave: UK pension drawdown, UK take-home pay, UAE gratuity)

1. Add the id to `ToolId` (`types.ts`), its inputs to `specs/index.ts`, an engine module in `engine/`
   returning a `ViewModel`, and register it in `engine/index.ts` and `registry.ts` (`group: 'country'`
   and a group heading on `pages/tools/index.astro`).
2. A country tool builds its own `SimulationInput` (household `location.country`, `tax.mode: 'estimate'`)
   instead of `model.ts`'s flat-tax household, and states what that country's model leaves out
   (`TAX_SIMPLIFICATIONS`).
3. Add the page in `pages/tools/` with `ToolPage`, an entry in `config/pages.ts`, tests next to the others.

## Tests

`npx vitest run apps/site` (project `site`): builders, formula-versus-engine agreement with stated
tolerances (`formula-engine.test.ts`), the articles' worked examples, determinism, URL round-trips,
edge cases and a seeded sweep that no input yields NaN or Infinity, the worker's progress and cancel
messages, and the privacy scan.
