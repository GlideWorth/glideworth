# Glideworth user guide

Glideworth answers one question: **will my money last, and what can I change?** This guide explains the ideas,
walks a UK household through a plan, explains how the numbers are calculated, and is blunt about what Glideworth
does not do. It is a planning tool, not financial, tax or legal advice.

## 1. Concepts

**Household.** The people you plan for (one, or two for a couple), their birth months, where they live and
the currency. Dependents (children, people you support) are separate from the people.

**Current finances.** Where you are today: accounts (cash, ISAs, pensions, investments), real assets (a
home, a car, a rental) and debts, each with an owner. These are balances, not a forecast. You update them
(by hand, by CSV import, or from a script) and every plan that starts "now" reads them. Each update can
record a **progress snapshot** (at most one automatic snapshot per day), so you can compare reality with the
plan over time.

**Plan.** A scenario built on top of your finances: milestones, income, expenses, savings flows,
assumptions, tax settings and withdrawal rules. You can have many plans (retire at 60, retire at 57, downsize
at 70). A plan keeps a version history; every change is a new version you can go back to. A **branch** is a
plan that stores only its differences from a parent and follows the parent when it changes.

**Milestones.** Named moments the plan hangs things on: "Retirement" (say, at age 60), "Mortgage paid off",
"Life expectancy", "Financial independence" (say, when investments reach 25 times your spending). A milestone
is a date, an age, or a condition ("net worth at least ..."), or several joined by AND/OR. Income, expenses and
flows can start or end at a milestone, so moving retirement moves everything tied to it. If a milestone is
never reached, the plan says so.

**Flows.** What happens to money left over each year, in priority order: top up the emergency fund to a
target, contribute to the workplace pension (with the employer match), fill the ISA, then the SIPP, then
invest the rest. The order is the priority. Whatever is left after the last flow is saved to cash, or counts
as spending, as you choose.

**Drawdown.** When spending exceeds income, money comes out of your accounts in a set order (by default
cash, then taxable investments, then pensions, then tax-free accounts). You can reorder it, and you can set
when each account can be touched (pensions cannot be drawn before the minimum pension age, for example).
Withdrawals are taxed according to the account type.

**Today's money versus future money.** Every amount you enter says which it is. "Today's money" (real) is
what it would buy at today's prices; "future money" (nominal) is the actual number of pounds in that year.
Glideworth calculates in future money and shows either: the toggle is only a change of view and does not change
the plan. Prefer today's money when you think about whether you can afford a lifestyle, because a pound in
2060 is not a pound today. Be careful when you type "£2,000 a month": the frequency matters as much as the
number.

**Chance of success.** One projection uses one fixed set of assumptions (say 5% a year). Reality varies, so
Glideworth also replays your plan many times with different market histories and counts how often **every year's
spending is fully funded**. "85% chance of success" means 85 of 100 replays never ran short. It is a measure
of how fragile the plan is, not a forecast. Glideworth can also say _when_ the failures happen, whether bad early
returns (sequence-of-returns risk) separate success from failure, and what the typical failure looks like.

## 2. A UK walkthrough

This follows the synthetic UK sample, "Sam": born June 1978, an easy-access savings account, a stocks and
shares ISA, a general investment account, a small crypto holding, a SIPP and a workplace pension; a £58,000
salary, a State Pension, living costs of £2,300 a month plus £4,000 a year of travel; retire at 60, plan to 92. Load it with `pnpm seed` (it appears as `hh-uk-sample`, plan `uk-plan-main`). You can click through the
same steps in the web app, or use the API/MCP calls shown.

1. **Check your finances** (Current finances). Account types matter: an ISA is tax-free, a SIPP is taxed as
   income when drawn (with a quarter tax-free), a GIA pays capital gains and dividend tax. Set realistic
   balances; update them whenever you like (Progress, **Update balances**, records a snapshot).
2. **Choose how taxes are calculated** (Plan editor, Taxes). The default is a single flat rate per kind of
   income, which is simple but crude. For UK rules choose **estimate** with country United Kingdom: income
   tax and National Insurance by band, the personal allowance and its taper, dividend and savings allowances,
   capital gains tax, ISA and pension allowances, and the State Pension.
3. **Choose the market history** (Chance of success, Settings, or the Plan editor's Monte Carlo settings). The
   default is US history since 1928, in real terms. **UK since 1983** uses UK inflation, gilts and Bank Rate with
   US shares in sterling; it is short and more optimistic than long UK history. See the limits below.
4. **Read the deterministic result** (Results). It shows net worth year by year, the milestone dates, and any
   year money runs short. For Sam the plan is funded to the end; the first questions to ask are where the
   money comes from in your sixties (the Cash flow page) and how much tax is paid (Taxes).
5. **Check the chance of success** (Chance of success). Read the headline, then the _Failures_ and
   _Sequence of returns_ panels: they say when a failing trial runs short and whether early returns decide it.
   Via the API: `POST /plans/uk-plan-main/monte-carlo?wait=60`, then `GET /jobs/{id}/result`. Via MCP:
   `run_monte_carlo`.
6. **Ask "how much can I spend?"** (Insights). At a 90% target the solver says, in pounds a year, what you
   could spend instead of today's £31,600 (about £36,100 on the sample), and offers the change.
7. **Ask "can I retire earlier?"**. The earliest-retirement solver gives a month and an age (for Sam, about
   56 and a half at 85%). To explore it safely, make a **branch** ("Retire three years earlier"): the main plan
   is untouched, and **Compare** shows both side by side.
8. **Look for mistakes** (Insights, audit). The audit flags things like "nothing pays for care costs in your
   80s" or a very high early withdrawal rate, and offers a fix you can preview before applying.
9. **Save what you decide** as a new plan version or branch; undo is always one step back through the history.

## 3. How results are calculated

### Time

- The engine steps **one calendar year at a time** (or a custom fiscal or rolling year). A plan that starts in
  November has a short first period of two months. Within a period, an event that starts in March counts for
  the months it is active, so the amounts are **prorated by month**.
- **Partial years are labelled.** Because the plan starts in the month your balances are dated and ends at
  its horizon, the first and last years usually cover fewer than 12 months, so their income, spending and
  taxes look low next to full years. Wherever one year's figures are shown (chart tooltips, the year table,
  the year drill-down, Cash flow and its Sankey) such a year says so, for example "2026 (Nov–Mar, 5 months)",
  and charts and tables mark it "2026*". The **Actual months / Annualised** switch shows a partial year's
  money moved scaled to a full year so it compares with the others. Balances, rates, totals over several
  years and CSV exports always use the actual months.
- A plan runs to the last life-expectancy milestone (or the end you set), never more than 100 years.
- There is no monthly or daily mode: sequence effects inside a year (a crash in March and a recovery by
  December) are not seen.

### Cash flow inside a year

- Each period adds income, takes off tax and expenses, and the surplus goes down the **flows**; a shortfall is
  drawn from accounts in the **drawdown** order. Tax depends on the withdrawals and the withdrawals depend on
  the tax, so Glideworth repeats the calculation until the two agree to a fraction of a penny.
- Growth is applied to the **opening** balance. Money added or taken out during the year is credited with part
  of the year's return according to the **cash-flow timing** setting: `mid` (default) assumes flows happen
  mid-year and earn half a year's return, `start` a full year, `end` none. Different tools choose differently,
  which is one reason two planners give different answers for the same inputs.
- The first year's amounts equal what you entered; later years grow by inflation (or by the change you set).
  Amounts entered in today's money are inflated to the year they are paid.

### Tax years

- Glideworth's periods are calendar years unless the plan uses a fiscal year (new UK plans align to April, Australian
  plans to July and New Zealand plans to April by default). Where the periods are calendar years, the UK tax
  year runs 6 April to 5 April, so a period year _Y_ uses the tax year _Y/Y+1_, which overlaps nine of its
  twelve months. Thresholds that are frozen by law stay frozen for
  the stated years and are then indexed with inflation.
- Tax is computed per period from the jurisdictions you chose: US federal, state and local; the UK; Canada
  (federal and province); Australia; Germany; the Netherlands; France; Spain (state and region); Israel;
  Ireland; New Zealand; a single flat rate; or your own brackets. A new household in one of these countries
  starts on its own preset, currency, tax year, pension wrappers and state-pension age. Each applies its own allowances,
  credits and rules for the income, gains and dividends in that period.
- Tax can be paid in the same period (the simplest) or settled in the next one (more like real life: tax
  withheld during the year, balance paid after).
- Statutory limits come from the account's country regardless of tax mode, for every country above:
  contribution limits, pension access ages, home-sale exclusions and minimum distributions. Pension wrappers
  that cannot legally be drawn early (UK pensions, German bAV / Riester / Rürup, Dutch pensions, the French
  PER, Israeli and Irish pensions, KiwiSaver) stay locked until their access age unless you model an early
  withdrawal penalty. French PEA and assurance-vie income stays inside the wrapper and is taxed as part of the
  gain when you withdraw.

### Chance of success

- Each trial replays the plan with a different sequence of market returns, dividends and inflation, drawn from
  history (starting at a random year and continuing; or every start year once; or blocks of consecutive
  years) or from a statistical distribution. A trial succeeds if every year's spending was funded (you can
  choose stricter or looser definitions). Results are reproducible: the same seed gives the same answer, and
  by default Glideworth uses a fixed seed so "same plan, change one number" compares like with like.
- Only the market varies (and, if you switch it on, exchange rates: Chance of success → Settings →
  Exchange-rate risk, a yearly volatility per foreign currency, about 8–10% is typical). Your income,
  spending, tax rules and dates are the plan's, in every trial.

### "This adds up"

Every year's drill-down ends with a reconciliation: money in equals money out, each account's opening balance
plus its flows and growth equals its closing balance, and last year's net worth plus the changes equals this
year's. In today's money the money moved during the year is valued at the prices when the year began and the
closing balances at the prices when it ended (as everywhere else in Glideworth), so an **Inflation** line shows the
buying power the year's money lost in between; every figure matches the one shown elsewhere.

### What is and is not modelled

Modelled: accounts by type with their tax rules; contribution limits; employer matches; pensions (defined
benefit and state), the UK State Pension with its triple lock; US Social Security estimates; required
minimum distributions; real assets with loans, rent, costs and sales; debts; milestones and their effects;
a partner's death (assets pass to the survivor, filing status changes); withdrawal rules (fixed percentage,
guardrails, VPW and others); flexible spending; Roth conversions and similar tax strategies; estate tax and
net legacy; fees; dividends.

Not modelled, or only roughly:

- Anything that happens **within** a year.
- **Inflation by category is optional**: healthcare, education, housing or your own categories can follow
  their own rate (and move with general inflation in chance-of-success runs); everything else follows one
  inflation path.
- **Currency risk is optional.** Accounts, property, debts and events can be in another currency, converted
  with your exchange-rate table and an assumed yearly drift. Exchange rates vary in chance-of-success runs only
  when you give a currency pair a volatility (and optionally a correlation between pairs); by default they
  follow the drift.
- **Randomised lifespan or care costs** in the Monte Carlo (you set a life expectancy; a care scenario is a
  what-if).
- **Law changes.** Rules are as stated for the tax years in the tables, plus the changes already legislated
  that the tables encode. Anything else is your assumption.
- Behaviour: panic selling, windfalls, a marriage or divorce you have not planned.
- Many local rules and edge cases (some US localities; the simplifications listed for each country in §4).
- Survivor pensions beyond what you enter (survivor benefits are **not** added automatically in a survivor
  what-if; the scenario says so).
- Investment fees beyond the percentage or amount you set; product charges you did not enter.

### Moving country, and money in more than one country

Glideworth works for anyone, wherever they live and however often they move. Three things drive it:

1. **Where you live, over time.** Your household's location is where you live at the start. Add moves to the
   plan's residency timeline (a month, a country and region, and whether it is one of you or both of you), or put
   a relocation effect on a milestone (for example "move back home when I retire"). Partners can live in
   different countries. A move part-way through a tax year splits it: each country taxes its share of the year by
   months, and pay is taxed by the country you live in while you earn it.
2. **Where each thing is.** Every account, property, debt and income has a country. It defaults to your
   household's country (or the account type's: an ISA is British), and it does not change when you move: a UK
   pension stays a UK pension, a flat in Manchester stays in the UK. Set the country when you add something abroad
   (a UAE salary, a Spanish house, a US brokerage account).
3. **Which country may tax what.** The country you live in taxes your worldwide income. A country where something
   is may also tax it under its rules for non-residents (rent and property gains almost everywhere; UK pensions
   unless a treaty says otherwise). Glideworth's treaty table says who keeps the right to tax each kind of income, and
   your country of residence gives a credit for tax already paid elsewhere, so the same income is not taxed twice.
   US citizens and green-card holders also pay US tax wherever they live, after the foreign earned income
   exclusion and a credit for foreign tax. The tax results show every line by country and by reason (residence,
   source, citizenship, relief, exit tax, return), and each rule has a "how this is taxed and why" explanation
   with its official source.

What else changes when you move:

- **Wrappers.** An ISA keeps its UK shelter but you cannot pay in while you live abroad (from the tax year after you
  leave); UK pension contributions get relief on up to £3,600 a year for five tax years after leaving, then Glideworth
  stops them; Canadian TFSA and RRSP contributions stop. The new country may not recognise a foreign tax-free
  account at all: by default Glideworth taxes the growth when you take money out.
- **Exit and arrival.** Leaving Canada or Australia triggers a deemed sale of your investments (you can choose to
  defer it); arriving there resets their cost to market value. Coming back to the UK within five years makes gains
  you realised abroad taxable in the year you return.
- **State pensions.** A UK State Pension is frozen if you live where it is not uprated (the UAE, Canada,
  Australia...), and goes back to the current rate if you return. The audit tells you when you are short of
  qualifying years and what voluntary Class 3 contributions would cost.
- **Inheritance tax.** After leaving the UK you stay in scope of UK inheritance tax on your worldwide estate for 3
  to 10 years, depending on how long you lived there; after that only UK assets are.
- **Exchange rates.** Taxes in each country are worked out in its currency with your exchange-rate table, so add a
  rate for every currency involved (the audit lists missing ones).

The **United Arab Emirates** is supported in full: no income, capital gains, dividend, interest, wealth or
inheritance tax for individuals; the end-of-service gratuity on a salary (21 days of basic pay a year for five
years, 30 after, capped at two years); DEWS and the federal savings scheme as accounts; GPSSA pensions for UAE
nationals at a basic level; the dirham's US-dollar peg pre-filled. Corporate Tax on a business or freelance
licence above AED 1 million of turnover, and VAT, are out of scope.

Try the **relocation** what-if (move to a country in a given month, optionally coming back) or **compare staying
with moving**: Glideworth shows the plan difference, the change in lifetime tax by country and where the difference in
your final wealth comes from.

Where to find it in the app:

- **Plan editor → Where you live**: each person's residence as a strip over the plan, dated moves (who, when,
  where: country and region), moves that come from milestones, warnings for countries without rules, unknown
  treaty pairs and missing exchange rates (with an inline box to add the rate), and the plan's cross-border
  switches (rules on/off, departure tax, UK temporary non-residence, State Pension freeze). Moves also show on
  the plan timeline under each person. A milestone's "Relocate" effect can move one of you or both.
- **Current finances → About you**: per person, "Citizenship, past residence and state pension" (collapsed
  until you use it): citizenships, a US green card, where you lived before the plan starts, and state-pension
  records with qualifying years and the voluntary years you plan to buy.
- **Accounts, property, debts and income** each have a **Country** field. When it implies another currency
  Glideworth offers to switch (and asks for an exchange rate if it has none). Property abroad also takes the month you
  bought it and past valuations (the UK taxes non-residents only on the gain since April 2015 for homes when you
  give that value). A salary in the UAE can carry the **end-of-service gratuity** (service start, basic-wage
  share). A pension can be marked as a government pension.
- **Taxes**: for a cross-border plan, what the estimate leaves out comes first, then tax by country and reason
  for the whole plan and the selected year (with each person's residence and months), relief shown as its own
  negative column so you can see nothing is taxed twice, and **How this is taxed, and why** for any account,
  property or income in any year: the non-resident rule, the treaty article with its source, how the country
  you live in sees a foreign account, and warnings. The Results year drill-down shows the same table.
- **Insights → Stay or move?**: choose where, when, who and whether you come back; the move runs in the
  background and you see lifetime tax by country for both, where the difference in end net worth comes from,
  the plan changes, and buttons to save it as a branch or compare. Cross-border audit findings link to the
  place to fix them.

A household that never moves and holds nothing abroad sees none of this except the country fields and an empty
"Where you live" section.

## 4. Limitations

- **Moving country is an estimate of the tax mechanics, not of your status.** Glideworth does not apply any
  residence test (the UK statutory residence test, 183-day rules, tie-breakers): you are resident where your
  timeline says. Split years are prorated by months (the real UK split-year treatment keeps a full personal
  allowance). Treaty relief is assumed claimed. Only UK-UAE is implemented article by article; UK-US, UK-Australia,
  UK-Canada, UK-Spain, UK-France and US-Canada are basic; any other pair uses the credit method with a warning.
  Non-resident rules are detailed for the UK, basic for the US and the other countries (no withholding on
  interest or dividends, resident rates used for non-residents). Departure taxes cover taxable investment
  accounts only, at their value at the start of the year you leave. One cost basis is kept per account (after a
  deemed sale it is the market value everywhere). Temporary non-residence covers capital gains only (not pension
  lump sums taken abroad). A gratuity or bonus paid after you move is taxed where you then live. US citizens
  abroad pay federal tax only (no state tax), with one foreign-tax-credit basket and no carry-forward.

- **UK history starts in 1983 and uses US shares in sterling.** The UK set (1983-2025) has UK inflation (ONS),
  Bank Rate and 10-year gilts (Bank of England), all openly licensed, but no openly licensed UK share history
  exists, so its shares are the US market converted to sterling. It is 43 years long, has no 1970s inflation or
  wartime years, and US shares beat UK shares over the period, so it is markedly more optimistic than long UK
  history. A plan longer than 43 years cannot use "every start year once" on it.
- **Every country defaults to US history 1928-2025, including the UK.** For UK plans that is a deliberate choice:
  US 1928-2025 is longer and includes the Depression and the 1970s, so it is less optimistic than the UK set,
  though still more favourable than long-run UK history. Results are in real terms, so you are testing against
  American history after inflation. The reasoning, with numbers, is in `docs/design/uk-dataset-replacement.md`.
- **Two older data sets were withdrawn.** UK 1871-2020 (Jordà-Schularick-Taylor, non-commercial licence) and US
  1871-2025 (Shiller, no explicit licence). Plans that used them now run on UK 1983-2025 and US 1928-2025
  respectively and show a notice saying so; results differ from before. Self-hosters can download the Shiller
  data for personal use (`packages/core/src/stochastic/data/scripts/fetch_shiller_local.py`); it is never part of
  the hosted service. Deterministic "historical" rate sequences now start no earlier than 1928.
- **Tax tables are for stated tax years and must be updated.** UK 2025/26 and 2026/27 with the announced
  2027/28 and 2029/30 changes; US federal, payroll and every state 2026 (plus the sunset variant of the 2017
  law); Canada 2026; Australia 2025-26 to 2027-28 (`packages/core/src/tax/data`). Rates, thresholds and allowances change
  every year, often at short notice: someone has to add the new year each spring, and results for later years
  index the last known thresholds with inflation, which will be wrong whenever the rules change.
- **The UK, US, Canadian and Australian estimates leave things out too**, each listed with its tax results
  (Taxes page and plan tax settings). The main ones:
  - _UK:_ no carry-forward of unused pension annual allowance; Class 1 employee and Class 4 NI only; one
    pair of CGT rates for all assets (no Business Asset Disposal Relief); no blind person's or married
    couple's allowance, trading or property allowance, Gift Aid band extension; student-loan interest ignored.
  - _US:_ itemised deductions are what you enter (the SALT cap is not applied for you); AMT adds back only
    the standard deduction; QBI is simplified; credits are the child tax credit and the ACA premium credit
    only (no EITC, education or care credits); states start from federal AGI with no state-specific
    additions or subtractions, and some state rows carry a noted approximation; local tax only for the
    cities in the table.
  - _Canada:_ no AMT; GIS is an amount you enter (no income test); provincial low-income reductions and the
    Quebec return's own amounts are not modelled.
  - _Australia:_ residents only; no SAPTO, HELP repayments or Medicare levy surcharge; Medicare levy uses
    single thresholds; no carry-forward concessional cap or transfer balance cap.
  - _Everywhere:_ gains are realised pro rata to cost basis and treated as long-term; losses are never
    realised, so there is no loss relief.
- **Germany, the Netherlands, France, Spain, Israel, Ireland and New Zealand are estimated at a basic
  level.** Tax years: Germany, Netherlands, Israel and Ireland 2026; New Zealand 2026-27; France uses the
  2026 finance law (which taxes 2025 income, the latest enacted barème) with 2026 social rates; Spain uses
  the 2025 income-tax scales (the latest the tax agency has published) with 2026 social security. Each
  country's full list of simplifications is shown with its tax results; the main ones are:
  - _Germany:_ statutory health insurance at the average supplementary rate (no private insurance);
    no Kindergeld / child-allowance comparison; investments assumed to be equity funds (30% partial
    exemption, switchable) and no Vorabpauschale; Riester allowance not modelled; tax not rounded to
    whole euros; self-employed pay no social contributions.
  - _Netherlands:_ box 3 uses the 2026 deemed returns (provisional savings and debt rates) without the
    actual-return counter-evidence route; savings, taxable investments (with investment property) and debts
    other than the main-home mortgage come from your accounts, pensions excluded; pension contributions are deducted without checking
    the jaarruimte; no mortgage-interest or own-home rules; box 2 only for income you tag as such.
  - _France:_ salaries are gross with employee pension contributions and CSG/CRDS (other contributions
    not modelled); pensions pay full-rate CSG; PEA and assurance-vie are assumed held 5 / 8 years
    (switchable), and their income is kept inside the wrapper automatically; the PER is available from 64
    (the 2023 reform's legal age; its 2025 suspension is not modelled); flat tax is 31.4% from 2026;
    no high-income contribution or IFI.
  - _Spain:_ only Madrid, Cataluña, Andalucía and Valencia have their own scales (others use a scale equal
    to the state one); individual returns only; no regional minimums or deductions; wealth tax is off by
    default and ignores the main-home exemption and the large-fortunes solidarity tax.
  - _Israel:_ capital gains are taxed on the nominal gain (Israel taxes only the real, inflation-adjusted
    gain, so long-held assets are over-taxed); pensions are taxed in full because the partial exemption
    could not be confirmed from an official source; only the basic 2.25 credit points.
  - _Ireland:_ CGT averages 33% and 31% by days in 2026 (the rate fell on 7 October 2026) and is 31% from 2027; no exit tax on
    funds; no reduced USC rates for over-70s; the 25% tax-free retirement lump sum is not applied
    automatically (set a tax-free withdrawal share on the account to model it).
  - _New Zealand:_ no capital gains tax at all (no bright-line or FIF rules); dividends assumed fully
    imputed; no independent earner tax credit.
- **None of the presets has been checked against every official calculator.** They are tested against
  worked examples (`packages/core/test/tax-*.test.ts`, `golden-*.test.ts`); treat a figure as an estimate and
  check anything you will act on.
- **Past returns do not predict the future.** A plan that works in every historical replay can still fail, and
  one that fails in some can work. The chance of success is a stress test, not a probability of the future.
- **It is a model of you, not you.** Garbage in, garbage out: the audit catches common mistakes (counting
  housing twice, mixing today's and future money), not every one.
- **Self-hosted means you are responsible.** Back up the database (`pnpm backup`), keep the server up to date,
  and keep the port off the public internet unless you have set a passphrase, a setup token and TLS.
- **No advice.** Glideworth does not know your circumstances, your tax residence in detail or your risk
  tolerance. Talk to a regulated adviser before acting on a projection.
