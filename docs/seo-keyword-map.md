# SEO keyword map

This is the source of truth for target keywords on the marketing site (`apps/site`,
[glideworth.com](https://glideworth.com)). Its job is to stop two indexable URLs competing for the same
query.

The table is every indexable URL the site build puts in the sitemap. It is derived from
`apps/site/src/pages` and `apps/site/src/content`. A built page is indexable when its HTML has no
`noindex` robots tag. Redirects are left out as well: a redirect is not a URL to rank.

Left out on purpose:

- `noindex` pages: `/404/`, `/tools/engine-check/`, and every `/blog/tags/<tag>/` archive.
- Redirects in `apps/site/astro.config.ts`: `/docs/api-and-mcp/connect-an-ai-assistant/`,
  `/planning/moving-country/`, `/features/cross-border/`,
  `/blog/planning-a-move-abroad-taxes-pensions/`, `/docs/planning/moving-country/`,
  `/docs/importing/bank-files/`.
- Non-HTML endpoints: `robots.txt`, `rss.xml`, `llms.txt`, `llms-full.txt`, the web manifest,
  Open Graph images, and `.well-known/security.txt`.
- Changelog entries. They are sections of `/changelog/`, not their own URLs.

Paths below are on `https://glideworth.com` and already include the trailing slash the site uses.

The title column is the rendered `<title>`. Every page except `/` appends ` · Glideworth` (a space, a
middle dot, a space, then the site name). `/` sets `fullTitle`, so its title is the string on its own.
The number in parentheses is the length of that rendered string. The H1 is the visible heading. On a
collection page the H1 is the frontmatter title, without ` · Glideworth`. Where the H1 and the SEO title
differ, both are the current source, not a target to rewrite in this file.

111 indexable URLs.

## Rules

- One primary target keyword per indexable URL.
- Titles are 60 characters or fewer. Count the rendered `<title>`, as the title column does.
- Exactly one H1 per page.
- A new page needs a keyword that no existing page owns. Otherwise improve the page that already owns
  it. Do not add a second page for the same keyword.
- A page that overlaps an owned keyword links to the owner. The anchor text is that keyword.
- Update this map in the same pull request as any page that changes its target keyword, its title, or
  its H1.

A secondary keyword is another query that same URL may rank for. It must not be some other URL's
primary keyword. `—` means the URL has no secondary.

## Indexable URLs

| URL                                                   | Primary keyword                               | Secondary keywords                                                     | Title                                                                      | H1                                                                                      |
| ----------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| /                                                     | retirement and fire planner                   | open source financial independence planner                             | Glideworth: retirement and FIRE planner (39)                               | Know when you can retire, and how much you can spend.                                   |
| /about/                                               | about glideworth                              | —                                                                      | About · Glideworth (18)                                                    | A planner you can see inside                                                            |
| /api/                                                 | retirement planner api                        | ai agent retirement planner                                            | API and MCP for AI agents · Glideworth (38)                                | Your plan, open to your AI assistant                                                    |
| /authors/glideworth-team/                             | glideworth team                               | —                                                                      | The Glideworth team · Glideworth (32)                                      | The Glideworth team                                                                     |
| /blog/                                                | retirement planning articles                  | —                                                                      | Blog · Glideworth (17)                                                     | Notes on planning, tax and building in the open                                         |
| /blog/ai-assistant-access-to-your-financial-plan/     | ai assistant financial plan                   | chatgpt access to a financial plan                                     | AI assistant access to your financial plan · Glideworth (55)               | AI assistant access to your financial plan                                              |
| /blog/barista-fire-part-time-income/                  | barista fire                                  | barista fire part time income                                          | Barista FIRE and part-time income · Glideworth (46)                        | Barista FIRE and part-time income                                                       |
| /blog/coast-fire-explained/                           | coast fire                                    | coast fire formula                                                     | Coast FIRE number, formula and gaps · Glideworth (48)                      | Coast FIRE number, formula and gaps                                                     |
| /blog/how-long-will-my-money-last/                    | retirement savings depletion formula          | how many years will savings last                                       | How long will my money last? · Glideworth (41)                             | How long will my money last?                                                            |
| /blog/monte-carlo-retirement-simulations/             | monte carlo retirement simulations            | retirement chance of success                                           | Monte Carlo retirement simulations · Glideworth (47)                       | Monte Carlo retirement simulations                                                      |
| /blog/what-a-tax-estimate-leaves-out/                 | what a tax estimate leaves out                | retirement tax estimate limits                                         | What a tax estimate leaves out · Glideworth (43)                           | What a tax estimate leaves out                                                          |
| /blog/what-is-your-fire-number/                       | fire number                                   | 25x rule                                                               | FIRE number: the 25x rule and its limits · Glideworth (53)                 | FIRE number: the 25x rule and its limits                                                |
| /blog/withdrawal-strategies-compared/                 | four withdrawal rules compared                | variable percentage withdrawal                                         | Withdrawal strategies: four rules compared · Glideworth (55)               | Withdrawal strategies: four rules compared                                              |
| /ca/                                                  | canada retirement planner                     | retirement planning software canada                                    | Canada retirement planner: RRSP, TFSA and tax · Glideworth (58)            | Know when you can retire in Canada, and how much you can spend.                         |
| /changelog/                                           | glideworth changelog                          | —                                                                      | Changelog · Glideworth (22)                                                | Changelog                                                                               |
| /compare/                                             | retirement planner comparisons                | —                                                                      | Comparisons · Glideworth (24)                                              | Comparisons                                                                             |
| /compare/boldin/                                      | boldin alternative                            | boldin mcp                                                             | Glideworth and Boldin compared · Glideworth (43)                           | Glideworth and Boldin compared                                                          |
| /compare/projectionlab/                               | projectionlab alternative                     | glideworth vs projectionlab                                            | Glideworth and ProjectionLab compared · Glideworth (50)                    | Glideworth and ProjectionLab compared                                                   |
| /compare/switch-from-projectionlab/                   | switch from projectionlab                     | migrate from projectionlab                                             | Switch from ProjectionLab: move your plan · Glideworth (54)                | Switch from ProjectionLab: move your plan                                               |
| /compare/spreadsheets/                                | retirement spreadsheet alternative            | firecalc alternative                                                   | Glideworth and spreadsheets or free calculators compared · Glideworth (69) | Glideworth and spreadsheets or free calculators compared                                |
| /contact/                                             | contact glideworth                            | —                                                                      | Contact · Glideworth (20)                                                  | Get in touch                                                                            |
| /docs/                                                | glideworth documentation                      | —                                                                      | Documentation · Glideworth (26)                                            | Documentation                                                                           |
| /docs/api-and-mcp/api-authentication/                 | glideworth api authentication                 | glideworth api scopes                                                  | API authentication, scopes and roles · Glideworth (49)                     | API authentication, scopes and roles                                                    |
| /docs/api-and-mcp/api-change-sets/                    | api change sets                               | glideworth safe plan edits                                             | API - change sets and safe edits · Glideworth (45)                         | API - change sets and safe edits                                                        |
| /docs/api-and-mcp/api-finances-and-plans/             | glideworth api households                     | glideworth api plans                                                   | API - households, finances and plans · Glideworth (49)                     | API - households, finances and plans                                                    |
| /docs/api-and-mcp/api-import-export-and-reports/      | glideworth api import and export              | glideworth api reports                                                 | API - import, export and reports · Glideworth (45)                         | API - import, export and reports                                                        |
| /docs/api-and-mcp/api-overview/                       | glideworth rest api overview                  | glideworth api conventions                                             | REST API overview and conventions · Glideworth (46)                        | REST API overview and conventions                                                       |
| /docs/api-and-mcp/api-quick-start/                    | glideworth api curl                           | glideworth api quick start                                             | API quick start with curl · Glideworth (38)                                | API quick start with curl                                                               |
| /docs/api-and-mcp/api-reference/                      | glideworth api reference                      | —                                                                      | API reference · Glideworth (26)                                            | API reference                                                                           |
| /docs/api-and-mcp/api-sharing-check-ins-and-webhooks/ | glideworth webhooks                           | glideworth share link api                                              | API - share links, check-ins and webhooks · Glideworth (54)                | API - share links, check-ins and webhooks                                               |
| /docs/api-and-mcp/api-simulation-and-jobs/            | retirement simulation api                     | glideworth solver api                                                  | API - simulation, solvers, insights and jobs · Glideworth (57)             | API - simulation, solvers, insights and jobs                                            |
| /docs/api-and-mcp/mcp-examples/                       | glideworth mcp examples                       | —                                                                      | MCP worked examples · Glideworth (32)                                      | MCP worked examples                                                                     |
| /docs/api-and-mcp/mcp-overview/                       | mcp server safety model                       | glideworth mcp read only                                               | MCP server overview and safety model · Glideworth (49)                     | MCP server overview and safety model                                                    |
| /docs/api-and-mcp/mcp-setup/                          | connect an ai assistant over mcp              | glideworth mcp setup                                                   | Connect an AI assistant over MCP · Glideworth (45)                         | Connect an AI assistant over MCP                                                        |
| /docs/api-and-mcp/mcp-tools/                          | glideworth mcp tools                          | glideworth mcp tool reference                                          | MCP tools reference · Glideworth (32)                                      | MCP tools reference                                                                     |
| /docs/getting-started/concepts/                       | glideworth plan concepts                      | —                                                                      | Core concepts · Glideworth (26)                                            | Core concepts                                                                           |
| /docs/getting-started/first-plan/                     | first glideworth plan                         | build a first retirement plan                                          | Your first plan in ten minutes · Glideworth (43)                           | Your first plan in ten minutes                                                          |
| /docs/getting-started/overview/                       | what is glideworth                            | —                                                                      | What Glideworth is · Glideworth (31)                                       | What Glideworth is                                                                      |
| /docs/hosted/hosted-service/                          | glideworth hosted service                     | glideworth cloud                                                       | The hosted service · Glideworth (31)                                       | The hosted service                                                                      |
| /docs/importing/csv/                                  | import a retirement plan from csv             | bank csv retirement import                                             | Import from CSV · Glideworth (28)                                          | Import from CSV                                                                         |
| /docs/importing/glideworth-json/                      | glideworth json backup                        | glideworth json restore                                                | Glideworth JSON backup and restore · Glideworth (47)                       | Glideworth JSON backup and restore                                                      |
| /docs/importing/projectionlab/                        | import projectionlab json                     | projectionlab export to glideworth                                     | Import from ProjectionLab · Glideworth (38)                                | Import from ProjectionLab                                                               |
| /docs/methodology/historical-data/                    | retirement historical market data             | us market history retirement                                           | Historical data and its limits · Glideworth (43)                           | Historical data and its limits                                                          |
| /docs/methodology/how-projections-work/               | how a retirement projection is computed       | —                                                                      | How a projection is computed · Glideworth (41)                             | How a projection is computed                                                            |
| /docs/methodology/known-limitations/                  | glideworth known limitations                  | —                                                                      | Known limitations · Glideworth (30)                                        | Known limitations                                                                       |
| /docs/methodology/monte-carlo/                        | monte carlo historical replay                 | seeded retirement monte carlo                                          | Monte Carlo and historical replay · Glideworth (46)                        | Monte Carlo and historical replay                                                       |
| /docs/planning/branches-and-what-ifs/                 | retirement plan what ifs                      | compare retirement scenarios                                           | Branches, compare, history and what-ifs · Glideworth (52)                  | Branches, compare, history and what-ifs                                                 |
| /docs/planning/build-a-plan/                          | build a glideworth plan                       | —                                                                      | Build a plan · Glideworth (25)                                             | Build a plan                                                                            |
| /docs/planning/progress-and-check-ins/                | retirement progress snapshots                 | scheduled retirement check-ins                                         | Progress snapshots and check-ins · Glideworth (45)                         | Progress snapshots and check-ins                                                        |
| /docs/planning/read-your-results/                     | read a retirement projection                  | —                                                                      | Read your results · Glideworth (30)                                        | Read your results                                                                       |
| /docs/planning/reports-exports-and-settings/          | retirement plan reports                       | glideworth export settings                                             | Reports, exports and settings · Glideworth (42)                            | Reports, exports and settings                                                           |
| /docs/planning/sharing-and-roles/                     | glideworth sharing and roles                  | retirement plan viewer role                                            | Sharing and roles · Glideworth (30)                                        | Sharing and roles                                                                       |
| /docs/planning/solvers-and-guardrails/                | glideworth solvers and insights               | —                                                                      | Solvers, guardrails and insights · Glideworth (45)                         | Solvers, guardrails and insights                                                        |
| /docs/planning/tax-and-currency/                      | retirement tax and currency settings          | —                                                                      | Tax settings, countries and currency · Glideworth (49)                     | Tax settings, countries and currency                                                    |
| /docs/reference/faq/                                  | glideworth faq                                | glideworth troubleshooting                                             | FAQ and troubleshooting · Glideworth (36)                                  | FAQ and troubleshooting                                                                 |
| /docs/self-hosting/backups-and-restore/               | glideworth backup and restore                 | move a glideworth server                                               | Backups, restore and moving machines · Glideworth (49)                     | Backups, restore and moving machines                                                    |
| /docs/self-hosting/configuration/                     | glideworth configuration                      | glideworth environment variables                                       | Configuration reference · Glideworth (36)                                  | Configuration reference                                                                 |
| /docs/self-hosting/docker/                            | glideworth docker                             | glideworth docker compose                                              | Install with Docker · Glideworth (32)                                      | Install with Docker                                                                     |
| /docs/self-hosting/reverse-proxy/                     | glideworth reverse proxy                      | glideworth https                                                       | HTTPS behind a reverse proxy · Glideworth (41)                             | HTTPS behind a reverse proxy                                                            |
| /docs/self-hosting/troubleshooting/                   | glideworth self hosting troubleshooting       | —                                                                      | Self-hosting troubleshooting · Glideworth (41)                             | Self-hosting troubleshooting                                                            |
| /docs/self-hosting/upgrading/                         | upgrade glideworth                            | —                                                                      | Upgrading · Glideworth (22)                                                | Upgrading                                                                               |
| /features/                                            | retirement planner features                   | —                                                                      | Features · Glideworth (21)                                                 | Everything the planner does                                                             |
| /features/branches-and-change-sets/                   | retirement plan branches                      | retirement plan change sets                                            | Branches, change sets and plan history · Glideworth (51)                   | Branches, change sets and plan history                                                  |
| /features/explanations-and-audit/                     | retirement assumption audit                   | retirement plan explanations                                           | Explanations and the assumption audit · Glideworth (50)                    | Explanations and the assumption audit                                                   |
| /features/import-and-export/                          | import and export a retirement plan           | retirement plan csv import                                             | Importing and exporting your data · Glideworth (46)                        | Importing and exporting your data                                                       |
| /features/mcp-server/                                 | chatgpt claude retirement plan                | mcp server for a financial plan                                        | Talk to ChatGPT or Claude about your plan · Glideworth (54)                | Talk to ChatGPT or Claude about your plan                                               |
| /features/monte-carlo/                                | historical retirement simulation              | retirement monte carlo failure analysis                                | Monte Carlo and historical simulation · Glideworth (50)                    | Monte Carlo and historical simulation                                                   |
| /features/multi-currency/                             | multi currency retirement planning            | retirement plan exchange rates                                         | Multi-currency planning · Glideworth (36)                                  | Multi-currency planning                                                                 |
| /features/plan-modelling/                             | household retirement plan model               | couple retirement plan                                                 | Plan modelling · Glideworth (27)                                           | Plan modelling                                                                          |
| /features/progress-and-check-ins/                     | retirement plan check-in                      | retirement progress tracking                                           | Progress tracking and scheduled check-ins · Glideworth (54)                | Progress tracking and scheduled check-ins                                               |
| /features/projections-and-ledger/                     | year by year retirement ledger                | retirement cash flow projection                                        | Projections and the year-by-year ledger · Glideworth (52)                  | Projections and the year-by-year ledger                                                 |
| /features/rest-api/                                   | retirement planner openapi                    | glideworth rest api                                                    | The REST API and OpenAPI document · Glideworth (46)                        | The REST API and OpenAPI document                                                       |
| /features/sharing-and-roles/                          | share a retirement plan                       | retirement plan household roles                                        | Sharing and household roles · Glideworth (40)                              | Sharing and household roles                                                             |
| /features/solvers/                                    | retirement spending solver                    | earliest retirement date solver                                        | Solvers for spending and retirement date · Glideworth (53)                 | Solvers for spending and retirement date                                                |
| /features/tax-estimates/                              | retirement tax estimates                      | tax estimates for several countries                                    | Tax estimates in 12 countries · Glideworth (42)                            | Tax estimates in 12 countries                                                           |
| /features/withdrawal-strategies/                      | withdrawal strategies                         | drawdown order                                                         | Withdrawal strategies and guardrails · Glideworth (49)                     | Withdrawal strategies and guardrails                                                    |
| /legal/                                               | glideworth legal documents                    | —                                                                      | Legal · Glideworth (18)                                                    | Legal                                                                                   |
| /legal/acceptable-use/                                | glideworth acceptable use                     | —                                                                      | Acceptable use policy · Glideworth (34)                                    | Acceptable use policy                                                                   |
| /legal/cookies/                                       | glideworth cookie policy                      | —                                                                      | Cookie policy · Glideworth (26)                                            | Cookie policy                                                                           |
| /legal/disclaimer/                                    | glideworth not financial advice               | —                                                                      | Not financial advice · Glideworth (33)                                     | Not financial advice                                                                    |
| /legal/dpa/                                           | glideworth data processing agreement          | —                                                                      | Data processing agreement · Glideworth (38)                                | Data processing agreement                                                               |
| /legal/notices/                                       | glideworth open source notices                | —                                                                      | Open-source and data notices · Glideworth (41)                             | Open-source and data notices                                                            |
| /legal/privacy/                                       | glideworth privacy policy                     | —                                                                      | Privacy policy · Glideworth (27)                                           | Privacy policy                                                                          |
| /legal/subprocessors/                                 | glideworth sub-processors                     | —                                                                      | Sub-processors · Glideworth (27)                                           | Sub-processors                                                                          |
| /legal/terms/                                         | glideworth terms of service                   | —                                                                      | Terms of service · Glideworth (29)                                         | Terms of service                                                                        |
| /open-source/                                         | open source retirement planner                | agpl retirement planner                                                | Open source · Glideworth (24)                                              | Open source, with nothing held back                                                     |
| /planning/                                            | retirement tax by country                     | country retirement tax estimates                                       | Planning by country · Glideworth (32)                                      | Tax estimates for your country                                                          |
| /planning/ae/                                         | uae retirement tax                            | uae end of service gratuity                                            | Retirement planning in the United Arab Emirates · Glideworth (60)          | Retirement planning in the United Arab Emirates                                         |
| /planning/au/                                         | australia capital gains tax pension exemption | australia superannuation pension tax                                   | Retirement planning in Australia · Glideworth (45)                         | Retirement planning in Australia                                                        |
| /planning/ca/                                         | canada retirement tax                         | rrsp rrif retirement tax                                               | Retirement planning in Canada · Glideworth (42)                            | Retirement planning in Canada                                                           |
| /planning/de/                                         | germany retirement tax                        | riester rurup retirement tax                                           | Retirement planning in Germany · Glideworth (43)                           | Retirement planning in Germany                                                          |
| /planning/es/                                         | spain retirement tax                          | spanish irpf pension tax                                               | Retirement planning in Spain · Glideworth (41)                             | Retirement planning in Spain                                                            |
| /planning/fr/                                         | france retirement tax                         | french pea assurance vie tax                                           | Retirement planning in France · Glideworth (42)                            | Retirement planning in France                                                           |
| /planning/ie/                                         | ireland retirement tax                        | irish pension lump sum tax                                             | Retirement planning in Ireland · Glideworth (43)                           | Retirement planning in Ireland                                                          |
| /planning/il/                                         | israel retirement tax                         | keren hishtalmut tax                                                   | Retirement planning in Israel · Glideworth (42)                            | Retirement planning in Israel                                                           |
| /planning/nl/                                         | netherlands retirement tax                    | dutch box 3 retirement tax                                             | Retirement planning in the Netherlands · Glideworth (51)                   | Retirement planning in the Netherlands                                                  |
| /planning/nz/                                         | new zealand retirement tax                    | kiwisaver retirement tax                                               | Retirement planning in New Zealand · Glideworth (47)                       | Retirement planning in New Zealand                                                      |
| /planning/uk/                                         | uk retirement tax                             | uk pension annual allowance                                            | Retirement planning in the United Kingdom · Glideworth (54)                | Retirement planning in the United Kingdom                                               |
| /planning/us/                                         | united states retirement tax                  | social security retirement tax                                         | Retirement planning in the United States · Glideworth (53)                 | Retirement planning in the United States                                                |
| /pricing/                                             | glideworth pricing                            | glideworth free trial                                                  | Pricing · Glideworth (20)                                                  | One plan, every feature.                                                                |
| /roadmap/                                             | glideworth roadmap                            | —                                                                      | Roadmap · Glideworth (20)                                                  | What we are building next                                                               |
| /security/                                            | glideworth security and privacy               | retirement planner privacy                                             | Security and privacy · Glideworth (33)                                     | Security and privacy                                                                    |
| /self-hosting/                                        | self host a retirement planner                | self hosted retirement planner                                         | Self-hosting · Glideworth (25)                                             | Run Glideworth yourself, free                                                           |
| /tools/                                               | free retirement calculators                   | free fire calculators                                                  | Free retirement and FIRE calculators · Glideworth (49)                     | Free retirement and FIRE calculators                                                    |
| /tools/barista-fire-calculator/                       | barista fire calculator                       | part time income fire calculator                                       | Barista FIRE calculator with part-time income · Glideworth (58)            | Barista FIRE calculator                                                                 |
| /tools/coast-fire-calculator/                         | coast fire calculator                         | coast number calculator                                                | Coast FIRE calculator: find your coast number · Glideworth (58)            | Coast FIRE calculator                                                                   |
| /tools/fat-fire-calculator/                           | fat fire calculator                           | fat fire number                                                        | Fat FIRE calculator: number, years, gap · Glideworth (52)                  | Fat FIRE calculator: a high spending target, and the gap to reach it                    |
| /tools/fire-calculator/                               | fire calculator                               | years to fire calculator                                               | FIRE calculator: your FIRE number and date · Glideworth (55)               | FIRE calculator: your FIRE number and when you reach it                                 |
| /tools/how-long-will-my-money-last/                   | how long will my money last calculator        | savings longevity calculator                                           | How long will my money last? Calculator · Glideworth (52)                  | How long will my money last?                                                            |
| /tools/monte-carlo-retirement-calculator/             | monte carlo retirement calculator             | retirement success rate calculator                                     | Monte Carlo retirement calculator · Glideworth (46)                        | Monte Carlo retirement calculator                                                       |
| /tools/retirement-withdrawal-calculator/              | safe withdrawal rate calculator               | 4% rule; retirement withdrawal calculator; guyton klinger / guardrails | Retirement withdrawal calculator: SWR, 4% rule · Glideworth (59)           | Retirement withdrawal calculator: safe withdrawal rate, the 4% rule and four strategies |
| /tools/rule-of-55/                                    | rule of 55                                    | rule of 55 calculator; 401(k) withdrawal at 55                         | Rule of 55: 401(k) withdrawals before 59½ · Glideworth (54)                | Rule of 55: take money from your 401(k) before 59½                                      |
| /tools/social-security-break-even-calculator/         | social security break even calculator         | social security 62 vs 67; social security spousal benefits calculator  | Social Security break-even calculator · Glideworth (50)                    | Social Security break-even calculator                                                   |
| /uk/                                                  | uk retirement planner                         | retirement planning software uk                                        | UK retirement planner: pensions, ISAs and tax · Glideworth (58)            | Know when you can retire in the UK, and how much you can spend.                         |

## Overlaps to watch

These are the phrases where more than one live page can rank. The owner is the only URL whose primary
or secondary keyword is that phrase. The others link to the owner with the phrase as the anchor.

### How long will my money last

`/tools/how-long-will-my-money-last/` owns **how long will my money last calculator**. The tool is the
page that should get the impressions for that search.

`/blog/how-long-will-my-money-last/` uses the same words in its title ("How long will my money last?").
It does not own the query. Its primary is **retirement savings depletion formula**. When the article
points at the calculator, the anchor is "how long will my money last calculator".

### Withdrawal strategies

Three pages meet on **withdrawal strategies**:

- `/tools/retirement-withdrawal-calculator/`
- `/blog/withdrawal-strategies-compared/`
- `/features/withdrawal-strategies/`

`/features/withdrawal-strategies/` owns **withdrawal strategies**. The feature page is the product page
for that subject, and its title is the phrase.

The calculator does not. Its primary is **safe withdrawal rate calculator**. Its secondaries are the
**4% rule**, **retirement withdrawal calculator**, and **guyton klinger / guardrails**. The article's
primary is **four withdrawal rules compared**. The calculator and the article link to the feature page
with the anchor "withdrawal strategies".

The feature page also explains the 4% rule and Guyton-Klinger. Those queries stay with the calculator.
The feature page's other keyword is **drawdown order**: which account the money comes from.

### Monte Carlo

`/tools/monte-carlo-retirement-calculator/` owns **monte carlo retirement calculator**.

`/blog/monte-carlo-retirement-simulations/` is the page that competes with the tool when both are read
as the same query. The article owns **monte carlo retirement simulations**, not the calculator query.
Two more pages sit next to the same subject and must stay on their own keywords:
`/features/monte-carlo/` owns **historical retirement simulation**, and
`/docs/methodology/monte-carlo/` owns **monte carlo historical replay**. When any of those three means
the calculator, the anchor is "monte carlo retirement calculator" and the link is the tool.

### FIRE number

`/blog/what-is-your-fire-number/` owns **fire number**.

`/tools/fire-calculator/` owns **fire calculator**. It does not own **fire number**, even though its H1
says "your FIRE number", and it does not own **fat fire calculator**. It links to
`/tools/fat-fire-calculator/` with the anchor "fat FIRE". Coast FIRE and Barista FIRE pages that mention
a FIRE number link to the blog post with the anchor "fire number".

### Boldin MCP

`/compare/boldin/` owns **boldin alternative**. **boldin mcp** is a secondary on that page only.

The MCP and API pages do not own it. That set is `/api/`, `/features/mcp-server/`,
`/features/rest-api/`, the pages under `/docs/api-and-mcp/`, and
`/blog/ai-assistant-access-to-your-financial-plan/`. Each keeps the primary in the table. When one of
them mentions Boldin's MCP, the anchor is "boldin mcp" and the link is `/compare/boldin/`.

### ProjectionLab vs Boldin

**projectionlab vs boldin** is a query both `/compare/projectionlab/` and `/compare/boldin/` can rank
for. It is listed against both comparison pages and it has no owner. It is not a primary or a secondary
on either page in the table. Do not add it to both. Giving it an owner means choosing one URL (one of
these two, or a new page) and pointing the other at that URL with the anchor "projectionlab vs boldin".

### UK retirement planner and UK retirement tax

`/uk/` is the United Kingdom version of the home page. It owns **uk retirement planner**, with
**retirement planning software uk** as its secondary. `/planning/uk/` keeps **uk retirement tax**: the
tax rules in detail. Each links to the other with the other's keyword as the anchor ("UK retirement
planner" on `/planning/uk/`, "UK retirement tax" on `/uk/`). `/uk/` does not target the UK calculator
queries (**uk fire calculator**, **isa vs pension calculator** and the others); it links to those tools.

The choice was checked with keyword data for the United Kingdom (OpenSEO, Google UK, English, read
2026-11-27): **uk retirement planner** 390 searches a month, commercial intent (its close variant
**retirement planning uk** shares the figure); **retirement planner uk** 70, keyword difficulty
40; **retirement planning software uk** 30, difficulty 7. Larger UK queries were left alone:
**pension calculator uk** (14,800) is a calculator query, **retirement planner** (6,600) is the root
page's territory, and **when can i retire uk** (2,400, difficulty 19) is unowned (below).

The same pattern applies to the next country versions (`/ca/`, `/au/`): a "<country> retirement planner"
primary on the version, the tax keyword staying on `/planning/<slug>/`.

### Canada retirement planner and Canada retirement tax

`/ca/` owns **canada retirement planner**, with **retirement planning software canada** as its secondary;
`/planning/ca/` keeps **canada retirement tax**, and each links to the other with the other's keyword as the
anchor. Keyword data for Canada (OpenSEO, Google Canada, English, read 2026-11-28): **canada retirement planner**
880 searches a month, keyword difficulty 11 (its close variants **canadian retirement planner** and **retirement
planning canada** share the figure); **retirement planning software canada** 480, difficulty 16, commercial intent,
with a first page of planning software (Optiml, Adviice, ProjectionLab); **retirement planner canada** 210,
difficulty 26. Left alone: **retirement calculator canada** (6,600) and **retirement income calculator canada**
(4,400) are calculator queries, and **cpp calculator** (12,100), **rrsp calculator** (9,900), **oas clawback**
(6,600) and **rrif minimum withdrawal** (5,400) are single-topic queries for a calculator or an article.

### Switching from ProjectionLab

`/compare/switch-from-projectionlab/` owns **switch from projectionlab**, with **migrate from projectionlab**
as its secondary. It is for readers who have already decided to leave, so it does not target
**projectionlab alternative** (owned by `/compare/projectionlab/`) or **import projectionlab json** (owned by
`/docs/importing/projectionlab/`). It links to both with those keywords as the anchors, and both link back
with the anchor "switch from ProjectionLab".

## Unowned searches

No indexable URL targets these. A nearby page is not the owner.

- **lif withdrawal formula.** `/planning/ca/` owns **canada retirement tax**. The Canada page covers
  RRSP, RRIF and LIRA rules. It does not describe a LIF withdrawal formula.
- **capped drawdown calculator.** `/planning/uk/` owns **uk retirement tax**, and the withdrawal
  calculator owns **safe withdrawal rate calculator**. Neither owns a capped drawdown calculator.
- **projectionlab vs boldin.** See the overlap above. Neither compare page owns it.
- **when can i retire uk.** `/uk/` answers it in its H1 but owns **uk retirement planner**, and
  `/tools/uk-pension-age-calculator/` (not yet in this table) answers the pension-age half. Pick one owner
  before targeting it.

## Title over the limit

`/compare/spreadsheets/` renders `Glideworth and spreadsheets or free calculators compared · Glideworth`,
which is 69 characters. The limit is 60. This file only records that. The page is unchanged.

It is the only indexable title over 60. `/planning/ae/` is 60, which is within the limit.
