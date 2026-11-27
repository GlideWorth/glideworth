# Glideworth architecture

Glideworth is a self-hostable personal-finance and life-planning app. Besides the web app it provides
programmatic access (a full REST API that runs simulations, plus an MCP server) and planning tools
(solvers, guardrails, branching, explainability).

Status: the engine, tax plug-ins (US federal/payroll/state/local, UK, CA, AU, DE, NL, FR, ES, IL, IE, NZ, AE,
flat, custom), the cross-border model (§4.6),
stochastic runners, solvers/insights and importers are implemented and wired together. The few
remaining gaps throw `NotImplementedError` (or warn in non-strict mode); what is missing or partial is listed
in [STATUS.md](./STATUS.md) and [PARITY.md](./PARITY.md).

---

## 1. Packages and boundaries

```
packages/core        @glideworth/core       pure TS + zod. Schema, engine, tax plug-ins, stochastic, solvers, insights.
packages/importers   @glideworth/importers  pure TS. ProjectionLab JSON + CSV import, export.
apps/api             @glideworth/api        Hono on Node, SQLite (Drizzle + better-sqlite3), OpenAPI 3.1, MCP.
apps/web             @glideworth/web        React 19 + Vite + TanStack Router/Query + Tailwind v4 + Radix + ECharts.
```

Dependency rules. CI should enforce these; for now they are enforced by review.

- `core` depends only on `zod`. No DOM, no Node APIs, no clock (`Date.now()`), no randomness
  except the seeded RNG. It runs the same in Node, browsers and Web Workers.
- `importers` depends on `core`. It is pure, so it runs in the browser (client-side import preview)
  or on the server.
- `api` depends on `core` (and later `importers`). It never re-implements domain logic.
- `web` depends on `core` (and later `importers`). It persists only through the API. It runs
  simulations locally in Web Workers using `core`.

**Source vs dist resolution.** Every package exports a custom condition `@glideworth/source` that points
at `src/*.ts`. Dev tools resolve it: Vite and Vitest (`resolve.conditions`), tsx (`--conditions`)
and TypeScript (`customConditions` in `tsconfig.base.json`). So there is no build step in dev.
Production builds (`tsconfig.build.json`) clear `customConditions` and use `dist/`.
`pnpm build` runs packages in topological order.

## 2. Data model (single source of truth)

All domain types are Zod schemas in `packages/core/src/schema/*`. The TS types are inferred from
them (`z.infer` for the stored/parsed shape, `z.input` for what callers may send, with defaults
omitted). The API generates its OpenAPI 3.1 document from these same schemas, named with `.meta({ id })`:
254 named components in self-host mode. The web client validates responses with them too.

```
GlideworthDocument (schemaVersion = 4)       ← export/backup/import unit; what the web loads
├── household: Household               people (1–2, primary/partner; citizenships, US green card), dependents,
│                                      location (where the household lives for the whole plan), currency, locale
├── finances: CurrentFinances          asOf month; accounts[], realAssets[], debts[]  (starting conditions)
│   ├── Account                        type (43 types: US/UK/CA/AU/generic), owner, balance, cost/contribution basis,
│   │                                  behaviour: growth, dividends, fees, bonds, withdrawal & liquidity rules,
│   │                                  early-withdrawal penalty, distributions (RMD/custom), 72(t), UK UFPLS/PCLS…
│   ├── RealAsset                      16 types, loan (amortising), behaviour: appreciation, property tax,
│   │                                  maintenance/insurance/HOA, rental, sale, recurrence, liquidate-if-needed
│   └── Debt                           9 types, interest model, payment, behaviour: start, pay-from, forgiveness
├── plans: Plan[]
│   ├── startingConditions             live (reads CurrentFinances) | snapshot (fixed-date plan)
│   ├── lineage?                       branching: parentPlanId + RFC 6902 patch (+ pinned parent version)
│   ├── milestones[]                   criteria (age/date/milestone/metric) combined all|any; effects
│   ├── income[] / expenses[]          discriminated by type; Amount{value,basis}; Frequency; TimeRange of DateRefs;
│   │                                  Change (none/inflation±/rate/schedule); recurrence; tax character/withholding
│   ├── flows[] + leftover             ordered savings waterfall: contribution / debtPaydown / transfer
│   ├── accountSettings{id→patch}, plannedAccounts[], realAssetSettings, plannedRealAssets[], debtSettings, excludedIds
│   ├── drawdown, withdrawalStrategy?, flexSpending, riskGuardrails?, taxStrategy?
│   ├── assumptions                    inflation & returns (RateSpec), bonds/glide path, year alignment, horizon
│   ├── tax: TaxConfig                 mode estimate|flat|custom, jurisdictions, filing status, law toggles, estate
│   └── monteCarlo                     method, trials, seed, distributions, success definition, outcome categories
├── progress: ProgressSnapshot[]       actuals over time
└── settings: UserSettings
```

The data model makes these deliberate choices:

- **Units are explicit everywhere.** An `Amount` is `{ value, basis: 'real' | 'nominal' }`, and
  `Frequency` is required on every amount. This prevents the "$20k/month read as $20k/year" class of
  mistakes.
- **`DateRef` is one union** used for every start, end and binding: `planStart | planEnd | never |
  date | age | milestone`, each with `offsetMonths`.
- **Dependents are first-class.**
- **Behaviour lives on the entity with plan-level patches.** The entity holds default behaviour, and
  plans patch it. This keeps current finances and plans apart without duplicating data. The patch schemas (`AccountBehaviourPatch`, `RealAssetBehaviourPatch`,
  `DebtBehaviourPatch`) are **sparse**: built with `sparsePartial`, they never fill defaults, so a
  one-key override changes only that key.

### Schema versioning and migrations

`SCHEMA_VERSION` is in `schema/document.ts`. Every persisted JSON blob (DB `body` columns, exports)
records its version. `migrateDocument(raw)` walks `MIGRATIONS` from the blob's version to the
current one, then validates; `migratePlan(raw, schemaVersion?)` does the same for a single stored
plan body (it is wrapped in a minimal document so one migration list serves both). To add a breaking change, bump the version and append
`{ from: N, describe, up }`. The DB stores `schema_version` per row so rows can be upgraded lazily
on read (workstream e). The one migration so far, 1 → 2 (2026-11-19), removed moving country: it drops
`Plan.residency`, `relocate` milestone effects, the departure-tax / UK temporary non-residence / State
Pension freeze switches in `tax.crossBorder`, and `Person.residenceHistory` / `statePensionRecords`, from
documents, plans and branch patches. Stored plan rows migrate when read (`apps/api/src/services/migrate.ts`);
household rows drop the removed person fields when parsed. No SQL migration was needed.

## 3. Money and units (project-wide decision)

- Money is a JS `number` in **major currency units**: `1234.56` means 1,234.56 of the household
  currency. We never use integer minor units.
- The engine **never rounds intermediate values**. Rounding happens only at presentation
  (`Intl.NumberFormat`) and where importers must match external data. Tests compare with
  `toBeCloseTo`.
- Rates are decimal fractions per year: `0.07` means 7%.
- **Real vs nominal ("today's money").** Every user-entered amount carries a basis. All engine
  output is **nominal**. Each period carries two cumulative price indices relative to the plan start
  (reference month = 1): `priceIndexStart` (at the period's first month; 1 for the first period)
  and `priceIndex` (at the period end). The convention:
  - **Flows** (anything that happens _during_ a period: income, expenses, spending, taxes,
    contributions, withdrawals, shortfall, interest) are valued by the engine at the price level in
    force when the period starts (amounts are valued at their first active month), so they deflate
    by **`priceIndexStart`**. An inflation-linked amount entered in today's money (and starting at
    the plan start) therefore reads back _exactly as entered_ in every year, including a partial
    first period: £2,300 a month + £4,000 a year shows as £31,600 a year in today's money, not
    £30,829. The cash-flow timing convention (`cashFlowTiming`, mid-year by default) only decides
    how much investment growth a flow earns; it does not change the price level it is valued at.
  - **Stocks** (balances at the period end: net worth, account and loan balances, portfolio)
    deflate by **`priceIndex`**.
  - Ratios (savings rate, withdrawal rate) are never deflated.

  **The one helper**: `toBasis(value, period, basis, measure)` in `packages/core/src/engine/types.ts`
  (`measure` = `'flow' | 'stock'`, default `'stock'` for backwards compatibility), with
  `fromBasis` (inverse), `deflator(period, measure)`, `PERIOD_TOTALS_MEASURE` / `totalsMeasure(key)`
  (the measure of every `PeriodTotals` field and stochastic metric) and `series(result, pick,
  basis, measure)`. Core (insights, solvers, Monte Carlo percentiles, `summary.lifetimeTaxesReal`),
  the importers' exports, the API and the web must all convert through these, never by dividing by
  `priceIndex` themselves, so the layers cannot drift. Results cached before `priceIndexStart`
  existed still convert correctly: `deflator()` derives it from `priceIndex`, `market.inflation`
  and `months`. Monte Carlo shards carry `priceIndexStart` per trial and year; `percentiles` (real)
  deflate flow metrics with it. Reconciliation tables (`reconcileYear`) follow the same
  convention (flows and the opening position at the start index, closing balances at the end index) and
  add an `inflation` term, the buying power lost during the year, so each identity still holds exactly.

- **Currency.** Each household has a **base currency** (`Household.currency`). Accounts, real assets
  (with their loans and costs), debts and income/expense events may carry their own `currency`;
  `CurrentFinances.fxRates` (user-entered `{from, to, rate, annualDrift}` pairs as of `asOf`,
  overridable per plan with `Assumptions.fxRates`) converts each foreign currency to the base through
  a direct or inverse pair; a missing pair is a `ScenarioError`. The rate at month m is
  `rate × (1 + annualDrift)^(years since the plan start)`; FX is deterministic unless Monte Carlo
  samples it (`MonteCarloSettings.fx`, §4.4). Starting balances convert at the plan-start rate; each period the FX move revalues
  foreign holdings (reported inside account `growth` as `fxGain`, inside debt `interest`, and in
  asset value/loan); event amounts convert at the month they are valued. Results are in the base
  currency, with the original-currency detail kept (`closingOriginal`, `valueOriginal`,
  `requestedOriginal`, `amountOriginal`, `currency`, `fxRate`) and `meta.fxRates`. A table holds one
  rate per currency pair in either direction (`fxPairKey`, `fxRateIssues`); a plan pair replaces the
  household's pair whichever way it is quoted. Display currency
  and locale come from the household, overridable in `UserSettings`. All formatting goes through
  `apps/web/src/lib/format.ts`, and no `$` is hard-coded anywhere.
- **Inflation categories.** `Assumptions.inflationCategories` (healthcare, education, housing,
  custom) each have a rate: `premium` mode adds it to general inflation, `rate` mode uses its own
  rate (fixed or schedule) moved by `passThrough` × the general-inflation surprise. Events opt in
  with `inflationCategory`; the category index replaces the general one for their `inflation` change
  and their today's-money basis. Category indices are built from each path's general inflation, so
  Monte Carlo trials move them coherently. `PeriodResult.categoryPriceIndexStart` reports them.
- **Country defaults.** `defaultsForCountry(country, { region, birthMonth })` (core
  `defaults/country.ts`) is the single source for what a new household, plan, sample, template or
  import gets from its country: tax mode and jurisdiction stack (estimate whenever a preset is
  registered, so new presets are picked up automatically), default region, tax-year convention and
  matching year alignment (UK: 6 April, fiscal April alignment; AU: 1 July; NZ: 1 April), historical
  dataset with a note (GB: `us-1928`, with the reason; see `docs/design/uk-dataset-replacement.md`), typical account types and state-pension settings
  (age by cohort: UK SPA, DE Regelaltersgrenze, NL AOW age, FR legal age). GB, US, CA, AU, DE, NL, FR, ES,
  IL, IE, NZ and AE have their own entries; other countries get flat rates. AE pre-fills the AED/USD peg
  (`fxRates`, zero drift, from `CURRENCY_PEGS`) and onboarding `notes` (no expatriate state pension, gratuity).
  An account, real asset, debt or income event also has a **country** (`Account.jurisdiction`, `country`
  elsewhere): absent means the type's country (uk-isa -> GB), else the household's country; pay without a
  country is sourced where the household lives.
  Which account and income types belong to a household in a country is decided in one place, core
  `defaults/country-scope.ts` (`accountTypesForCountry`, `incomeTypesForCountry` and their `is...`
  checks): the country's own types plus the generic ones. Pickers offer only those, plus an item's
  current type and the types of its own country when it is abroad; other countries' types stay
  reachable through the "Other countries" submenus of the add menus.
  `planDefaultsForHousehold(household)` returns the plan fields to spread into a new plan;
  `monthOf(now)` / `emptyFinances(now)` date a new household (core has no clock).

## 4. Engine

### 4.1 Contract

```ts
simulate(input: SimulationInput, deps?: { taxRegistry?: TaxRegistry; historical?: HistoricalDataset }): ProjectionResult
SimulationInput = { household, finances, plan, options: { trace, strict, market?, resolution, lean } }
```

- The engine is pure and deterministic: there is no clock. The plan starts at `finances.asOf`, or
  at the snapshot's `asOf` for fixed-date plans.
- `options.market` (a `MarketPath`) overrides assumptions per period. This is the seam that lets
  Monte Carlo and historical runs reuse the engine.
- `deps.historical` defaults to the bundled `HISTORICAL_SERIES` (`us-1928`, 1928-2025), so deterministic
  `RateSpec.historical` sequences (with an optional additive `modifier`) need no wiring. A sequence
  that starts before the data (the schema still accepts 1871 for old plans) starts at the first year
  with data instead, with an `ASSUMPTION` warning; it is never padded by repeating that year.
  `assumptions.rateOverrides` sets a series to a rate over a time range on top of any RateSpec
  (the market-crash what-if); Monte Carlo trials keep their sampled rates.
- `options.strict` defaults to true: if the plan uses a feature whose phase isn't implemented, the
  engine throws `NotImplementedError(feature, workstream)`. In non-strict mode it emits one
  `FEATURE_NOT_MODELLED` warning per feature instead.
- `options.lean` skips per-line detail for Monte Carlo trials.
- `ProjectionResult` contains:
  - `meta`: versions, currency, `referenceMonth`, start and end month, and `resolution`.
  - `periods[]`, each with:
    - `year`, `startMonth`, `months`, `ages`, `alive`, the realised `market`, and `priceIndex`
    - per-account balances (`opening`, `contributions`, `withdrawals`, `growth`, `dividends`,
      `fees`, transfers, `closing`, bases, `withdrawable`, `liquid`)
    - per real asset and per debt
    - `income[]`, `expenses[]` (`requested` vs `funded`, `spendingType`)
    - `taxes` (`lines` by jurisdiction and kind, `taxable`, `effective`, `marginal`, `withheld`,
      `settlement`, `facts`)
    - `ledgerNodes[]` + `ledger[]`: every money movement, from → to. This is the Sankey source of
      truth and the basis for "why" explanations.
    - `milestonesReached`, `totals` (net worth, liquid net worth, assets, liabilities, portfolio,
      cash, income, passive income, expenses, spending, taxes, contributions, withdrawals, savings
      rate, withdrawal rate, shortfall, `byCategory`), and `status`.
  - `milestones[]`: resolutions with month, period and ages, and whether they resolved via time or
    via a metric.
  - `warnings[]`.
  - `summary`.
  - `trace[]`: explainability entries, each tagged with a phase, a code, refs and data.

**Intra-year readiness.** Periods are keyed by `startMonth` + `months` (1–12). Event windows
resolve to month indexes, and amounts are prorated per month. The first and last periods can
already be partial; calendar alignment means a plan starting in November has a 2-month first
period. Monthly resolution will add periods with `months = 1` without changing any consumer that
iterates `periods`. `resolution: 'monthly'` is reserved and currently rejected.

### 4.2 Yearly pipeline (ordered phases)

The source of truth is `packages/core/src/engine/phases.ts → PIPELINE`. Each phase has an `id`, an
owner workstream and a status.

Before the loop:

1. **Validate and parse** the input (Zod).
2. **Choose starting conditions.** A snapshot plan uses its frozen finances; otherwise use the live
   finances.
3. **Merge entities with plan patches** (shallow per key) and drop excluded ids.
4. **Resolve time-only milestones.** Milestones built from age, date and other time milestones are
   resolved by fixpoint in dependency order. Cycles cause a `ScenarioError`.
5. **Compute the horizon.** It runs to the last life-expectancy milestone, or to
   `assumptions.end`, capped at `maxYears`.
6. **Build the periods** from the year alignment (calendar, fiscal or rolling).
7. **Fix market rates per period** from the `MarketPath`, or from the assumptions' `RateSpec`s.
   Then build the price index.
8. **Validate references.** Dangling ids cause a `ScenarioError`.

Per period, in order:

| #   | Phase id                 | Does                                                                                                                                                                                                                                                                             | Status      |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | `period.open`            | ages, survival; milestone effects (filing status, withholding) and deaths (survivor transfer, basis step-up); effective tax settings; reset accumulators                                                                                                                         | implemented |
| 2   | `milestones.time`        | record time-resolved milestones falling in this period                                                                                                                                                                                                                           | implemented |
| 3   | `accounts.growth`        | bond allocation (glide path, per-account overrides, asset location); growth (stocks/bonds blend, cash, crypto; fixed/schedule/historical rates), dividends/interest, fees on **opening** balances; DRIP window; qualified/ordinary split; taxable dividends/interest → tax items | implemented |
| 4   | `income`                 | every income type; recurrence, part-time, change limits; DB pensions; RSU vesting; Social Security estimate (claim age, earnings test, spousal, survivor); State Pension triple lock; benefit COLA; survivor share; route to pool or accounts                                    | implemented |
| 5   | `realAssets`             | planned (financed) purchases and recurrence; ownership costs with reassessment caps; rental income/costs; loan amortisation (offset accounts, term-end balloon); scheduled sales; appreciation                                                                                   | implemented |
| 6   | `debts`                  | interest accrual, scheduled payments (pay-from accounts, offsets), deductible interest, (taxable) forgiveness                                                                                                                                                                    | implemented |
| 7   | `expenses`               | expense events → required outflows; pay-from accounts; Medicare (explicit or auto); payroll deductions; charity (QCD/DAF); deductions/credits                                                                                                                                    | implemented |
| 8   | `accounts.distributions` | QCDs, US RMDs (SECURE 2.0), inherited 10-year/stretch, RRIF/AU minimums, custom schedules, 72(t) SEPP                                                                                                                                                                            | implemented |
| 9   | `spending.strategy`      | withdrawal-strategy mode (fixed, initial %, fixed %, 1/N, VPW, ratcheting, Clyatt 95%, Guyton–Klinger; floor/ceiling), risk guardrails (withdrawal-rate band from `evaluateGuardrails`, multiplier carried year to year) and flexible spending                                   | implemented |
| 10  | `tax.strategy`           | withdrawal shielding, Roth conversions / UK pension-to-ISA moves (ISA allowance-capped) and gain harvesting up to a bracket / IRMAA / ACA / income target, with headroom from `tax/strategy.ts`                                                                                  | implemented |
| 11  | `cashflow.settle`        | **fixpoint**: pay-from-account lines → net = inflow − required − taxes → flows (surplus) then leftover, or drawdown (deficit) → recompute taxes via jurisdiction stack → repeat until \|Δcash taxes\| < 1e-7; same- or next-period settlement                                    | implemented |
| 12  | `period.close`           | allocate unfunded shortfall (discretionary + hybrid discretionary share → rest of hybrid → essential), ledger entries, totals (Spending definition), **metric milestones** on end state, performance index, period result                                                        | implemented |

Conventions (workstream a). Code lives in `engine/<phase>.ts`; the rule maths for withdrawal
strategies and flex cuts are pure exports of `engine/strategy.ts`.

- Growth applies to the opening balance and flows are booked at period end; the **cash-flow timing
  convention** (`assumptions.cashFlowTiming`, default `'mid'`) then credits or debits each account's
  net flow with the share of the period's return it would have earned: `'start'` a full year
  (FIRECalc), `'mid'` half a year, `'end'` none (the old behaviour). The adjustment is part of
  `growth` and excluded from the flexible-spending performance index.
- **At depletion** (engine 0.5.0) the convention also limits what a withdrawal can take: only what
  the account holds when the convention says the money leaves (`accounts.ts → withdrawable`: for
  net flow `n` so far and timing factor `q = (1 + rate)^(share) - 1`, a further withdrawal `w` must
  keep `balance - w + (n - w) q >= 0`). With `'start'` and no other flows that is the opening
  balance; with `'mid'`, the opening balance grown for half a year. Before 0.5.0 a withdrawal could
  take the fully grown balance and the timing charge was clamped at zero, so every year in which an
  account was emptied (the final year of a depleting plan, but also a cash account drained before
  the next account, or a whole-balance transfer) handed the household growth the account had not
  earned: the Barista FIRE example's required portfolio came out at 825,413 instead of the closed
  form 825,730 (`'start'`) and 813,458 instead of 813,616 (`'mid'`). This was a defect, not a
  convention: it broke conservation between the growth credited and the flows paid. Known limit:
  in a year with a negative return a `'start'`/`'mid'` withdrawal is not allowed to exceed the
  account's current (already reduced) balance, although under the convention the money left before
  the loss; the remainder stays in the account (conserved) and that year can show a small shortfall.
- **VPW** amortises the opening portfolio as an end-of-year annuity at fixed real rates
  (`VPW_REAL_RETURNS`), so in the final year the payment is portfolio x (1 + r), more than the whole
  portfolio. It is capped at 100% of the portfolio (VPW's final-year percentage); earlier years are
  unchanged. Before the cap the final year was underpaid in every trial with `'start'` timing and in
  about 30-40% with `'mid'`/`'end'` (us-1928, 60/40, 30 years, 400 random-restart trials: 100% /
  39% / 29%). After it, the remaining final-year underpayments (19.5% of those trials, every timing)
  are all years whose return was negative: the money is not there when it is taken (and, for
  `'start'`, the negative-return limit above). That residue is a property of treating VPW's amount as
  a spending target fixed at the start of the year, not of the VPW rule.
- Amounts are valued at the first active month of the period, so year 1 equals the entered amount.
  `growFromToday` (default) anchors change at the plan start; otherwise at the event start.
- Recurrence: occurrence k starts at `start + k × (duration + yearsBetween × 12)`, scaled by
  `(1 + scalingRate)^k`, while it starts before `until`. Schedules (`Change.schedule`, rate and
  bond schedules) evaluate DateRef points with step/linear interpolation; before the first point
  the first value applies; points bound to unreached milestones are ignored.
- A metric milestone is reached in the last month of the period where it first holds, so events
  bound to it start the **next** period. Time milestones resolve to exact months; in an OR
  milestone, a time branch fires at its exact month. `average` measurement = mean projected
  spending (from expense events, today's money) over the remaining plan (or `averageYears`), plus
  outflows with no event (real-asset running costs, loan/debt payments) carried forward at this
  period's level, loan/debt payments only until the outstanding balance would be repaid.
- `before` criteria are true from the plan start until the referenced month.
- Milestone effects apply from the first period starting at or after the milestone month. A person
  is alive through their death month (death effect or, in a couple, their life-expectancy
  milestone); their income, expenses and flows stop after it (`survivorShare` continues);
  ownership passes to the survivor at the next period start with a basis step-up (full for sole
  ownership; half for joint, full in US community-property states); married filing becomes
  qualifying-surviving-spouse for two years with a dependent at home, else single.
- Taxes: `same-period` pays the liability in the period (`withheld = total`). `next-period` pays
  withholding (income: fixed rate, auto = share of liability, none; withdrawals at the plan rates)
  and settles the balance next period; the last period trues up.
- Forced distributions (RMD, SEPP, custom, QCD) are taken before the settle, so they fund
  expenses first ("expenses reduce the RMD"); RMDs use the period's opening balance.
- Drawdown order: excess-cash accounts, plan entries, unmatched accounts in default category order,
  then liquidatable real assets. Pay-from-account lines draw their accounts in global category
  order (list order within a category). Liquidation and PCLS cash beyond the need is saved to the
  leftover account.
- Withdrawal tax handling:
  - **Taxable accounts:** realise gains pro rata to cost basis.
  - **Tax-deferred accounts:** ordinary income, minus any tax-free share. UK pensions default to
    UFPLS (25% of each withdrawal tax-free); PCLS takes a 25% lump sum on first access; both are
    capped by the lump-sum allowance (£268,275 per person).
  - **Tax-free accounts:** contribution basis first. Earnings are taxed and penalised only when
    withdrawn early. LISA early withdrawals pay a 25% charge on the whole amount (engine line).
  - **Cash, HSA and education accounts:** treated as qualified use. Interest on cash accounts is
    taxable whether it is modelled as growth or as a yield.
- UK pensions are not withdrawable before the normal minimum pension age in force at the time
  (55 before 6 April 2028, 57 from then: someone aged 55-56 on that date loses access again until
  57; protected pension ages are not modelled) unless the account models an early-withdrawal
  penalty. An early, penalised withdrawal has no tax-free element and no PCLS is taken before the
  access age.
- Statutory rules come from the jurisdiction of the account's country **whatever the tax mode**
  (`engine/rules.ts`, which maps a country to its plug-in through the tax module's
  `NATIONAL_JURISDICTION_BY_COUNTRY`): contribution limits (`contributionLimit`, per owner and allowance
  group, MPAA after flexible access, LISA within the ISA allowance, DE Riester/Rürup/bAV, FR PER, ES plan,
  IE age-related relief), sub-limits (`contributionSubLimit`: UK cash ISA), access ages
  (`pensionAccessAge`: UK normal minimum pension age, US 59.5 / HSA 65, AU preservation age, DE 62, NL AOW
  age, IL 67, IE 60, NZ 65), main-home gain exclusions (`homeSaleExclusion`) and minimum distributions. The
  engine's fallback table only applies to countries without a plug-in. Account types flagged
  `lockedUntilAccessAge` (UK pensions, DE bAV/Riester/Rürup, NL pension, FR PER from 64, IL/IE pensions,
  KiwiSaver) cannot be drawn before that age unless the account models an early-withdrawal penalty;
  `sheltersIncome` wrappers (FR PEA, assurance-vie) are taxable-treatment accounts whose dividends are
  reinvested untaxed and never raise the cost basis, so the whole gain is taxed on withdrawal.
- `TaxYearInput.wealth` carries the period-start split a savings/wealth tax needs: `cash` (cash
  accounts), `taxableInvestments` (taxable accounts plus investment real estate that is not the main home)
  and `debts` (debts plus loans on assets other than the main home); NL box 3 uses it. Statutory minimum
  distributions (US RMDs on traditional accounts, RRIF, AU pension) apply by default.
- Withdrawal rules also cover HSA (non-medical use taxable + 20% before 65; qualified up to the
  period's healthcare spending), 529/Coverdell (non-qualified earnings taxable + 10%; qualified up
  to education spending) and the Roth five-year rule (`Account.openedOn`).
- An asset purchase the period cannot fully fund is postponed, not recorded as bought: its lines
  are dropped, funded cash returns to savings and the purchase is retried next period.
- The ledger books expense lines at their requested amount; any unfunded part enters the pool
  from the `shortfall` node, so every period's pool balances exactly. `reconcileYear(result, i)`
  (insights) turns this into a "this adds up" table: cash in = cash out, per-account opening +
  flows + growth = closing, and the year-on-year net-worth bridge.
- Employer pension contributions, UK relief-at-source top-ups and LISA bonuses are paid straight
  into accounts: they count in `totals.income` and `totals.contributions` (the savings rate counts
  them on both sides) and are reported in `totals.externalContributions`, so cash income is
  `income - externalContributions`.
- **Savings rate** = `savedFromIncome / afterTaxIncome`, in [0, 1] (null when after-tax income is
  not positive). `afterTaxIncome` = income (including employer and government top-ups) minus
  one-off income (inheritance and windfall events) minus taxes; `savedFromIncome` = contributions
  minus withdrawals minus the period's one-off inflows (`oneOffInflows`: asset-sale proceeds,
  whether saved directly or via the pool, plus inheritances and windfalls), clamped to
  [0, afterTaxIncome]. Saving a windfall or a sale is not saving out of income.
- **Debt payoff strategies.** A debtPaydown flow with `allocation: { strategy: 'avalanche' |
  'snowball', targetIds?, rollover }` spreads its payment across debts and financed assets: the
  avalanche pays the highest APR first, the snowball the smallest balance first; with `rollover`
  the scheduled payments of debts already paid off join the budget. Extra payments are reported
  per debt as `DebtPeriod.extraPayments`.
- **State-pension deferral and contribution sub-limits are plug-in hooks.** Deferral uplift
  (`deferral` on `state-pension` events) comes from the country plug-in's `statePensionAge` +
  `statePensionDeferralUplift`: GB +1% per 9 weeks deferred past State Pension age (at least 9 weeks),
  DE +0.5% a month past the Regelaltersgrenze, for a pension not yet in payment at the plan start.
  The cash ISA sub-limit for accounts with `ukIsaType: 'cash'` is the UK plug-in's
  `contributionSubLimit` (`tax.uk.cashIsaLimit`; only when the plan sets an amount, since Budget 2026
  withdrew the announced £12,000 limit; default from April 2027, savers 65+ exempt), applied inside the
  overall ISA allowance. Optional capital gains on rebalancing
  (`assumptions.rebalancingGains`): when a taxable account's bond share changes, the switched share
  of the opening balance realises its pro-rata unrealised gain (basis rises by the gain).
- Negative (overdrawn) balances earn no investment growth or yield and pay no %-of-balance fee.
- Monte Carlo historical methods with inflation held at the plan rate keep each data year's real
  return (nominal series are re-priced at the plan's inflation).
- The Spending metric follows `SimulationOptions.spendingDefinition`
  (UserSettings.spending; default: mortgage interest counts, principal and taxes do not).

### 4.3 Taxes plug in

```ts
interface TaxJurisdiction {
  id;
  label;
  level: "national" | "state" | "local" | "payroll" | "synthetic";
  country?;
  status;
  owner;
  computeYear(input: TaxYearInput, priorLevels: TaxYearOutput[]): TaxYearOutput;
  contributionLimit?(q);
  requiredDistribution?(q);
  defaultCharacter?(incomeType);
  lawToggles?;
  pensionAccessAge?(q);
  homeSaleExclusion?(q);
  statePensionAge?(q);
  statePensionDeferralUplift?(q);
  contributionSubLimit?(q);
}
```

- **Inputs.** The engine builds one `TaxYearInput` per period (`engine/settle.ts → buildTaxInput`). It
  contains: people (ages, survival, birth year and month), filing status, location, the price index,
  income items by resolved character with `incomeType` and CA/AU dividend treatments (bond-fund
  distributions are tagged `bond-dividend` and taxed as interest), withdrawal items (gross, taxable
  portion, penalty rate, `isConversion`), deductions with `accountId`/`accountType`/
  `pensionScheme`/`employer`, the plan's `TaxConfig`, `history`, and optionally `wealth`
  (period-start metrics), `transactions` (securities traded) and `aca` (benchmark premium).
  The UK fact `uk.reliefAtSourceTopUp` is deposited into the relief-at-source pensions after the
  settle. With `trace: 'full'` each period's `taxes.brackets` comes from `explainYear`;
  `meta.taxSources` lists `TaxJurisdiction.sources`.
- **The stack.** A `TaxRegistry` resolves the stack:
  - `flat` mode resolves to `['flat']`, and `custom` to `['custom']`.
  - `estimate` mode derives the stack from the location. A US household in New York City gets
    `us-federal, us-payroll, us-state:NY, us-local:nyc`, and GB, CA and AU get their own presets.
  - Parameterised ids (`us-state:CA`) resolve to the base plug-in, which reads the region.
- **Ordering.** Each level sees the outputs of earlier levels (AGI conformity, SALT).
- **Registration.** Registering a plug-in with an existing id replaces it, which is how workstream
  (b) swaps stubs for real implementations.
- **What is implemented.** `flat`, `custom`, `us-federal`, `us-payroll`, `us-state` (all states +
  DC), `us-local`, `uk`, `ca-federal`, `ca-province`, `au`, `de`, `nl`, `fr`, `es` (`es:<region>`), `il`,
  `ie`, `nz`, `ae` (no personal tax; the UAE savings-scheme cap; data and sources in `tax/data/ae.ts`).
  `TaxYearInput.nonResident` (optional) asks a plug-in to tax the given people as non-residents (the UK drops
  the personal allowance for people not entitled to it). Unknown countries in estimate mode throw
  `NotImplementedError`. `progressiveTax(income, BracketTable, priceIndex, scale)` is the shared
  bracket helper.

### 4.4 Monte Carlo and historical reuse the deterministic engine

```ts
runMonteCarlo(input, settings, options?): MonteCarloResult            // sync, any method
runMonteCarloAsync(input, settings, { chunkSize, signal, onPartial }) // yields between chunks; cancellable
runHistorical(input, { dataset?, startYears?, settings? }): MonteCarloResult  // one trial per start year
createMonteCarloSession(input, settings, { trialOffset, trialCount }) // step(n) / result() / shard()
runMonteCarloShard(input, settings, { trialOffset, trialCount }): MonteCarloShard   // worker slice
mergeMonteCarloShards(shards: MonteCarloShard[]): MonteCarloShard     // any order
summarizeMonteCarlo(shard, settings): MonteCarloResult
runTrial(input, settings, trial) / getTrialMarketPath(...)            // inspect one trial in full
sampleMarketPath(settings, periods, rng, trial, { base, startYears }): MarketPath
createRng(seed) / deriveSeed(seed, trial)                             // mulberry32 + Box-Muller
HISTORICAL_SERIES                                                     // engine `historical` dep
```

Each trial is
`simulate({ ...input, options: { market: sampleMarketPath(...), lean: true, trace: 'off' } })`.
Each trial derives its own seed with `deriveSeed(seed, trial)`. So sharding trials across workers
(`trialOffset`/`trialCount`) and merging the raw shards gives exactly the single-threaded result.
`settings.seed = null` uses `options.seed`, else a hash of plan id and version (core has no
randomness); callers wanting a fresh seed per run pass one in and it is recorded in the result.

- **Samplers.** `normal` (Cholesky-correlated stocks/bonds/inflation; optional `distributionShape:
  'lognormal'` and `fatTails` multivariate Student-t; dividends clamped at 0; crypto and optional cash
  independent), `historical-random-restart`, `historical-sequential` (no looping) and
  `block-bootstrap`. Bundled datasets (`us-1928`, `uk-1983`) live in
  `packages/core/src/stochastic/data` with provenance, licences and attribution statements
  (`DATASET_ATTRIBUTIONS`) in its README. `us-1871-local` (Shiller) is an optional personal-use
  download for self-hosters (`GLIDEWORTH_LOCAL_DATA_DIR`, Node only). Retired ids (`uk-1871` JST,
  `us-1871` Shiller) parse to `uk-1983` / `us-1928` without a schema-version bump; the plan keeps a
  `replacedDataset` marker and the engine reports `DATASET_REPLACED` (in `ProjectionResult.warnings`
  and `MonteCarloResult.warnings`) until the dataset is changed or the marker is acknowledged. Series switched off
  in `vary` (and cash where a dataset has none) use the deterministic projection's rates.
- **Per-account treatment.** `behaviour.monteCarlo: 'fixed'` (or `accountOverrides`) is applied as a
  plan `accountSettings` patch that pins the account's growth (and dividend yield) to the plan's
  deterministic rates or to custom rates; the engine needs no special mode.
- **Results.** `percentiles` (real) and `percentilesNominal` for every `PeriodTotals` series,
  success under `settings.success` (`all-funded`, `liquid-floor`, `never-depleted`, `end-floor`),
  outcome categories, failure-year histogram, milestone timing (percentiles + cumulative share by
  year), sequence-of-returns buckets, best/worst/median/p10/p90 representative trials, statistics
  split at a milestone, and per-trial summaries. Raw per-trial year data lives only in shards
  (typed arrays), never as full projections.
- **Timing convention.** See `assumptions.cashFlowTiming` (§4.2). Validation (test
  `stochastic-firecalc`): 60/40, $1m, 4% inflation-adjusted, 30 years, 0.18% fees. FIRECalc (US
  1871-) 96.8%, 4 of 126 cycles failing. Glideworth on `us-1928` (69 cycles): `'start'` 94.2% (4
  failing, all mid-1960s starts; 96.8% when FIRECalc's 57 pre-1928 cycles, all successes, are added
  back), `'mid'` (default) 95.7%, `'end'` 98.6%. On Shiller's 1871 data (no longer bundled) the same
  engine gave 95.2% / 98.4% / 99.2%.
- **FX risk.** `MonteCarloSettings.fx` (default off) gives currency pairs (which must involve the
  household currency) a yearly volatility and a common correlation. The sampler draws, after every other
  series, a mean-one log-normal shock per pair and period (`MarketPeriod.fx`, per foreign currency); the
  engine builds the rate path from the deterministic rate and drift times those shocks
  (`engine/indices.ts → buildFxPath / fxAt`). Zero volatility reproduces the deterministic run.
- **Per-series sources.** `MonteCarloSettings.sources` keeps a series at the plan assumption
  (`'fixed'`) or draws it from its distribution (`'distribution'`) whatever the method.

### 4.5 Solvers and insights

These are async contracts that take an injectable `evaluate`, so the web app can farm Monte Carlo
out to workers:

- `goalSeek` (generic: a variable, an objective and a direction)
- `solveMaxSpending`
- `solveEarliestRetirement`
- `solveRequiredSavings`
- `evaluateGuardrails`

The insights contracts:

- `explainProjection` and `explainDifference` return `Explanation{headline, findings[]}`, built from
  the trace, the ledger and warnings.
- `auditAssumptions` returns `Finding[]`.
- `diffPlans` returns a `PlanDiff` with human-readable changes plus an RFC 6902 patch (plans of
  different households are refused).
- `applyPlanPatch` and `materializePlan` handle branching. The patch engine refuses the path
  segments `__proto__`, `constructor` and `prototype` (`ValidationError`), never reads or writes
  through inherited members (own properties only) and refuses patch values that contain those keys.
- Analytics data (`insights/analytics.ts`): `strategyMetricsMatrix` (tax/drawdown strategies ×
  lifetime tax, net legacy, chance of success, final net worth, with 0..1 heatmap scores and
  deltas to the baseline), `incomeByTaxRate` / `incomeByTaxRateForInput` (per year, income in each
  rate band from the bracket fill of a `trace: 'full'` run) and `netLegacyAtEnd`.
- Importers: CSV (balances, progress, transactions; generic, Monarch and YNAB presets), ProjectionLab JSON
  (including optional per-entity `currency` and `settings.ci.exchangeRates`) and Glideworth JSON.

### 4.6 Items in another country: source taxation and treaties

Code: `engine/crossborder.ts` (`initCrossBorder`, `crossBorderTaxes`, `nonResidentContributionCap`),
`engine/rules.ts` (`accountCountryOf`), `tax/crossborder/*` (data: `NON_RESIDENT_RULES`, `TREATIES` and
`treatyRule`, `WRAPPER_RECOGNITION` and `wrapperView`, `COUNTRY_TAX_CURRENCY`, `CURRENCY_PEGS`,
`explainCrossBorderTreatment`), `insights/crossborder.ts` (audit), `insights/crossborder-explain.ts` (tax by
country, explain one item, simplifications).

- **Fixed residence.** The household lives at `Household.location` for the whole plan; moving country is not
  modelled (it was removed on 2026-11-19 for lack of demand; see §2 for the migration). What can be in another
  country is the household's money: an account (`Account.jurisdiction`, else the country of its type), a real
  asset (`country`), a debt (`country`) or an income event (`country`), each with its own currency and the FX
  table of §3. People carry `citizenships` and `usGreenCard`.
- **Activation** (`initCrossBorder`). A run is cross-border when the plan is in estimate mode,
  `tax.crossBorder.mode` is not `off`, and either more than one country is involved (an account / asset / debt /
  income in another country) or a US citizen or green-card holder lives outside the US. An explicit
  `tax.jurisdictions` stack counts only US persons abroad. Otherwise nothing below runs: single-country results
  are byte-identical to the engine before this model existed (test `crossborder-regression`, 31 households, full
  trace); the only cost is one boolean check per period. A household in a country with no tax preset can still
  be cross-border: its foreign items are taxed at source, and a warning says income tax where the household lives is not included.
- **Per period** (`crossBorderTaxes`, inside the settle fixpoint):
  1. _Items_ are classified by source country and category (employment, rental, private / state / government
     pension, pension lump sum, interest, dividends, property gains, securities gains, other) from their source id:
     rent and sale gains follow the asset's country, dividends / interest / withdrawals the account's, income the
     event's.
  2. _Residence tax_: the residence country's stack on the household's worldwide income, minus items a treaty
     gives only to the source country; foreign wrappers are seen through `wrapperView` (conservative: foreign
     tax-free wrappers are not recognised by default, so the earnings share of a withdrawal is a gain; a foreign
     pension's tax-free lump sum is taxable), foreign account types are mapped to generic ones, and foreign pay
     is ordinary income (no local payroll tax). `tax.crossBorder.wrapperRecognition` overrides recognition per
     pair and account type.
  3. _Source tax_, per person: for every other country with items, its `NON_RESIDENT_RULES` decide what it taxes
     (flat final withholding, or the national plug-in run with `nonResident`), subject to the treaty
     (`treatyRule(residence, source, category)`: residence / source / shared / government-pension allocation,
     rate caps; a flat rate can depend on the residence country, `rateByResidence`). UK: personal allowance only
     for British / EEA citizens; the disregarded-income limit (lower of the full calculation and tax on
     non-disregarded income without allowance); non-resident CGT on UK property from the April 2015 / 2019 value,
     time-apportioned or whole (lowest). US and Germany: no standard deduction / Grundfreibetrag for
     non-residents (the plug-ins read `nonResident`); German property gains exempt after 10 years.
     A treaty's `savingClause` lets the US tax its own residents despite an allocation to the other State,
     except for the categories the treaty excepts.
  4. _Relief_: the residence country credits each source country's tax, limited to its own tax on the same items
     (with-and-without difference). Unknown pairs fall back to this credit method with a warning.
  5. _Citizenship_: a US person living outside the US also pays US federal tax on worldwide income (less what a
     treaty keeps from the saving clause, `citizenshipMayTax`) after the foreign earned income exclusion with the
     stacking rule (tax on all income less the tax on the excluded amount at the same rates), less a foreign tax
     credit limited to the US income tax on foreign income; foreign tax on excluded pay and foreign social
     security contributions are not credited. The residence country credits US tax on US-source income.

  Money is converted to each jurisdiction's currency (`COUNTRY_TAX_CURRENCY`) with the plan's FX table at the
  period start and back; a missing pair is a warning (rate 1) and an audit finding. Tax lines keep their plug-in
  `jurisdictionId` and add `basis` (`residence | source | citizenship | relief`), `country` and `personId`;
  `taxes.byCountry` summarises the period. The marginal rate is a finite difference of the whole computation;
  bracket fill (`trace: 'full'`) comes from each computation's `explainYear`.

- **Rules that follow the account's country, not the household's**: contribution limits and access ages
  (`accountCountryOf`); main-home relief of the home's country; non-resident contribution bars
  (`nonResidentContributionCap`, applied in flows whatever the flow's limit setting): ISA, LISA, UK pensions,
  TFSA, RRSP, FHSA and LIRA take no contributions from a household living elsewhere. The UK's relief on £3,600
  gross a year for 5 tax years after leaving is not modelled, because the engine does not know when you left.
- **UAE gratuity**: `endOfService` on a salary pays `aeGratuity(years, last monthly basic)` in the month the salary
  ends (`engine/income.ts`).
- **Insights**: `crossBorderFindings` (in `auditAssumptions`: `XB_FOREIGN_ASSET_BASE_CURRENCY`, `XB_MISSING_FX`,
  `XB_TAX_FX_MISSING`, `XB_WRAPPER_NON_RESIDENT_CONTRIBUTIONS`, `XB_UNKNOWN_TREATY`), `taxByCountry` (lifetime
  and per-year rows by country and basis), `explainItemTaxation(input, itemId, year)` (one item's country, the
  household's residence country and, per income category, the non-resident rule, treaty article, wrapper view
  and relief), `crossBorderItems(input)` and `crossBorderSimplificationsFor(countries)`.

## 5. Persistence (apps/api)

SQLite through Drizzle. Migrations live in `apps/api/drizzle/` (generated with
`pnpm db:generate`) and are applied on boot. Domain objects are stored as validated JSON `body`
columns next to a few indexed columns. Zod stays the only shape definition.

| table                | purpose                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `households`         | household JSON + current-finances JSON, version                                                                |
| `plans`              | plan JSON (materialised for branches), `parent_plan_id`, `version` (optimistic concurrency)                    |
| `plan_versions`      | immutable history: one row per write, with actor and change-set id. This powers undo, audit and "what changed" |
| `change_sets`        | proposed RFC 6902 edits with base version, status, preview (MCP and What-If)                                   |
| `progress_snapshots` | actuals over time                                                                                              |
| `api_keys`           | `glideworth_<prefix>_<secret>`. Only the sha256 hash is stored; scopes are `read` and/or `write`               |
| `user_settings`      | UserSettings JSON                                                                                              |
| `simulation_runs`    | optional cache keyed by plan version, kind, input hash and engine version                                      |

**Cloud mode** (`GLIDEWORTH_MODE=cloud`, the hosted service; code in `packages/cloud`) keeps this schema
unchanged and runs one such database per customer workspace (`$GLIDEWORTH_DATA_DIR/tenants/<xx>/<id>/tenant.db`)
next to a control-plane database (people, sessions, workspaces, memberships, subscriptions, quotas, audit,
backups) owned by `packages/cloud`. Route handlers never capture a `Services`: they read the request's
(`servicesOf(c)`), which is the single instance in self-host mode and the workspace's own in cloud mode, set by
`tenantAuth` after the credential verified inside that workspace. `apps/api/src/tenant-runtime.ts` builds a
workspace's `Services` with its plan's hooks (job admission and limits, the fair thread gate, webhook
suppression and quotas, routed credential formats, the global scheduler); `apps/api/src/cloud-host.ts` is
what `@glideworth/cloud/server` boots (loaded by dynamic import in cloud mode only; self-host never loads a
cloud package, `test/cloud-mode.test.ts` checks the module graph). Every bearer credential carries its
workspace id (`gwk_`, `gwa_`, `gwr_`, `gwc_`, `gws_`) and verifies only inside it;
`test/cloud-isolation.test.ts` calls every operation with one workspace's credentials and another's ids.

Self-host auth is single-household. Two ways in, which never interfere (full detail in
[API.md](API.md#authentication)):

- **API keys** (`Authorization: Bearer glideworth_<prefix>_<secret>`) for everything under `/api/*` and `/mcp`.
  Scopes: `read` (GET and compute), `simulate` (compute only), `write` (mutations; implies the others).
  On first boot `GLIDEWORTH_BOOTSTRAP_KEY` is inserted when the key table is empty (the public example key is
  refused in production). In dev, the Vite proxy injects the key server-side.
- **Browser session** (passphrase hashed with scrypt, `HttpOnly` `SameSite=Strict` cookie, CSRF token) for
  the web app in production. `/mcp` never accepts cookies.

## 6. API surface (v1)

OpenAPI 3.1 is served at `/openapi.json` (251 operations in self-host mode, 292 in cloud mode: the 12
passphrase and instance-user operations are replaced by 53 account, workspace, billing and email ones; 299 with
the 7 "Sign in with Google" operations, which exist only when it is configured, as on the hosted service), with a
Scalar docs UI at `/docs` (cloud: a server-rendered page without third-party script). The route
groups are: households and people, accounts/assets/debts, plans and their collections and singletons,
history and undo, branches, change sets, simulation and jobs (Monte Carlo, historical, solvers, SSE),
insights, scenarios, progress snapshots, export/import, settings, keys, webhooks and browser auth. The map is
in [API.md](API.md#route-groups); the document is the reference.

Errors use the shape `{ error: { code, message, details } }`:

- 400 for validation failures
- 401 and 403 for auth
- 404 for unknown resources
- 409 for conflicts and version mismatches, including **`PATCH_CONFLICT`** (core
  `PatchConflictError` from `applyPlanPatch`: an op whose target is missing or whose `test` fails
  against the current plan)
- 422 for scenario errors
- **501 for `NOT_IMPLEMENTED`**, with `details.feature` and `details.workstream`

All operations go through `apps/api/src/services.ts`, and REST and MCP are thin adapters over it.
This keeps the two surfaces identical.

Planned by workstream (e):

- CRUD on finances, events, milestones and flows, addressed by id
- Monte Carlo, historical and solver endpoints, including async jobs with progress
- change sets: propose, preview, apply, discard
- branches and diff
- progress snapshots
- import and export
- webhooks
- settings
- key management

## 7. MCP surface

The same 67 tools (49 read/compute, 18 write) are exposed over Streamable HTTP at `/mcp` (bearer auth) and
over stdio (`apps/api/dist/mcp/stdio.js`). The server instructions spell out units. The tool list, the
resources and prompts, client set-up and the safety model are in [MCP.md](MCP.md).

- **Safety model.**
  - Read-only by default. Write tools are registered only when `GLIDEWORTH_MCP_ALLOW_WRITES=true` **and** the key
    has `write` scope (cloud: when the workspace owner turned MCP writes on **and** the credential has `write`,
    which a read-only workspace never has). On the cloud consent page the write box says what ticking it does in
    the picked workspace: an owner granting `write` turns MCP writes on (for everyone, when others share the
    workspace); an editor's grant waits for the owner; a viewer's box is disabled.
  - Plan edits are **change sets** (RFC 6902 ops against `baseVersion`, a before/after preview, an explicit
    apply that fails with a conflict if the plan moved) or **branches**; there is no whole-plan overwrite and
    no delete tool. Household data writes (balances, snapshots, CSV import) are direct and atomic.
  - Every apply writes a `plan_versions` row with the actor (`mcp`, the key id and name).
- **Agent ergonomics.** `planId`/`householdId` default when unambiguous, outputs are compact (solvers return a
  sentence, details and ops, not the search trace), Monte Carlo explains when and why trials fail, errors carry
  a recovery `hint`.

## 8. Web app

- **Shell and routing.** TanStack Router uses a code-based route tree (`src/router.tsx`) with one
  page module per area under `src/features/<area>/`. The app shell has a sidebar (Overview,
  Planning, Analysis, Settings), a plan switcher, a global **Today's money / Future money** toggle,
  and a theme toggle.
- **Data.** TanStack Query loads the workspace (a `GlideworthDocument`) from the API. If the API is
  unreachable, it falls back to the bundled **synthetic** sample, clearly badged "Sample data ·
  offline".
- **Public demo (`/demo`).** A page loaded under `/demo` runs the same app as the sign-up-free demo
  (`lib/demo.ts`): the router uses the `/demo` base path, the workspace is the bundled synthetic sample plus
  this browser's edits (`glideworth:demo:*` keys, cleared by "Reset demo"), the session is "no sign-in", and
  every engine run happens in the browser's workers. A network guard wraps `fetch` and `XMLHttpRequest` so a
  demo page can request only build assets and the analytics relay from its own origin: no request reaches
  the API, so a signed-in visitor's workspace can never load into it. Account-only pages (import, onboarding,
  share links, keys, billing and other server-side settings) are hidden or replaced by a sign-up prompt.
- **Simulation.** Simulations run in a module Web Worker (`src/workers/simulation.worker.ts`)
  through a promise RPC (`sim-client.ts`) with an inline fallback. Errors cross the boundary typed
  (NotImplemented carries feature and workstream).
- **Bundle splitting.** The app shell (router, layout, session, workspace, notifications) has no runtime
  import of `@glideworth/core`, Zod or the typed API client: `lib/api-lazy.ts` loads the client (and the
  schemas it validates with) on first use, the offline sample and `buildSimulationInput` are imported when
  needed, the engine runs in workers (the inline fallback imports it lazily), the command palette loads
  on first open and ECharts with the first chart. Initial JS is about 590 KB (200 KB gzipped), mostly React,
  the router and Radix. The build writes the service worker's precache list (`vite.config.ts`).
- **Partial years.** `lib/period.ts` labels a first/last period shorter than 12 months everywhere a single
  year is shown; `conv(..., { annualise })` scales such a year's flows to 12 months when the user picks
  the annualised view (never balances, sums over years or exports).
- **Design system.**
  - **Tokens.** CSS variables in `styles.css`, with light and dark themes. The palette is a
    warm-paper neutral with a spruce accent, ochre emphasis and terracotta for risk.
  - **Typography.** Fraunces for display figures and Inter (tabular numerals) for data.
  - **Components.** These are shadcn-style Radix components in `src/components/ui/`: Button,
    Input/Field, Select, Dialog, Card, Tabs, Table, Tooltip, Badge, Segmented, Stat,
    NumberInput/CurrencyInput/PercentInput/AmountInput (locale-aware, with a basis toggle) and
    DateRefPicker.
- **Charts.** A tree-shaken ECharts wrapper (`components/charts/echarts.tsx`) is themed from the
  same tokens at runtime.
- **Local state.** Zustand (`stores/ui.ts`) holds local UI preferences only.

## 9. Differentiators we commit to

1. **First-class REST API that runs simulations.** It is versioned, follows OpenAPI 3.1 generated
   from the domain schema, uses scoped keys, has ETag/If-Match concurrency and a stateless
   `/simulate`. Later it gets async Monte Carlo jobs and webhooks.
2. **MCP server** over HTTP and stdio, read-only by default, with **previewable change sets**,
   optimistic concurrency and an audit trail.
3. **Goal-seek solvers:**
   - max sustainable spending at a target success rate
   - earliest retirement date
   - required savings
   - a generic goal seek over any numeric path, with sensitivity bands
4. **Spending guardrails.** These are risk-based (a success-rate band) and evaluated from one shared
   simulation set, with a "what to do this year" output. The textbook strategies are also included:
   Guyton–Klinger, ratcheting, VPW, Clyatt 95% and 1/N.
5. **Plan branching with inheritance.** A child stores an RFC 6902 patch over its parent, can pin
   or follow the parent version, has a structured diff, and has history and undo through
   `plan_versions`.
6. **Explainability.** It answers "why did this plan fail" and "why did that withdrawal come from
   that account". It works from the engine trace plus the ledger, and `explainDifference` covers
   "what changed between two runs".
7. **Assumption audit.** It flags double-counted housing, real/nominal mix-ups, implausible drops,
   missing flows, unrealistic returns and penalised early withdrawals.
8. **Household survivor scenarios.** A death-of-either-spouse milestone effect handles survivor
   transfer, filing-status change, basis step-up and survivor benefits, with one-click "what if A
   dies at X" comparisons.
9. **ProjectionLab export importer** with an issues report, plus a **CSV import** with column
   mapping and a reconciliation preview.
10. **Units you can't misread:** explicit basis and frequency, real and nominal for every series,
    and multi-currency formatting from day one.
11. **Open, reproducible engine:** seeded runs, published methodology, and test vectors.

## 10. Testing strategy

Vitest runs as a workspace (`vitest.config.ts → projects`).

- **`core`:** unit tests covering:
  - schema round trips and migrations
  - engine phases, with hand-computed expectations: growth, flat tax, gross-up drawdown, shortfall
    allocation, milestones, real/nominal
  - money conservation through the ledger
  - determinism
  - typed stub errors
  - the RNG
- **`api`:** in-memory SQLite plus `app.request()`, covering:
  - health
  - OpenAPI
  - auth and scopes
  - the create → get → simulate vertical slice
  - optimistic concurrency
  - 501 mapping
  - an MCP client over Streamable HTTP
- **`web`:** jsdom, covering:
  - formatting and locale parsing
  - the worker handler
  - the typed API client
  - components

Workstreams add golden-file tests. Tax test vectors come from published examples. Monte Carlo is
compared against known historical success rates.
