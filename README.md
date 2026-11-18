# Glideworth

Glideworth is an open, self-hosted personal-finance and life-planning app. You describe your household, accounts,
income, spending and milestones; Glideworth projects your finances decades ahead, in today's money or in future
money, and tells you your chance of success, why a plan fails when it does, and what you could change.

It is also built to be driven by software: a complete REST API (OpenAPI 3.1) and an MCP server let scripts
and AI assistants read your plans, run simulations and propose edits safely, against your own machine.

Glideworth is an original application. How complete it is, feature by feature, is in
[docs/PARITY.md](docs/PARITY.md). The same software also runs as a hosted service, Glideworth Cloud, at
<https://glideworth.com> (14-day free trial with no card, then $9 a month or $90 a year); everything in this repository is free to run yourself.

## What it does

- **Plan** a household (one person or a couple): accounts, real assets, debts, income, expenses, savings
  flows, milestones (retire at 60, mortgage-free, life expectancy), drawdown order and assumptions.
- **Project** deterministically (a year-by-year ledger with taxes, withdrawals and every money movement) and
  probabilistically: Monte Carlo over historical or random returns (optionally with exchange-rate risk),
  historical backtests, sequence-of-returns analysis, milestone timing. A short first or last plan year is
  labelled as such and can be shown annualised.
- **Tax-aware**: estimates for the UK, US (federal, payroll, every state and some cities), Canada, Australia,
  Germany, the Netherlands, France, Spain, Israel, Ireland, New Zealand and the United Arab Emirates, or flat / custom rates. Each
  country lists what its estimate leaves out. Tables are for stated tax years and must be kept up to date
  ([status and limits](docs/STATUS.md)).
- **Several currencies**: accounts, property, debts and events in their own currency, with exchange rates and
  drift per household or per plan.
- **Answer questions**: the most you can spend at a target chance of success, the earliest retirement date,
  required savings, safe withdrawal rate, risk-based spending guardrails, tax-strategy comparison.
- **Explain**: why the plan fails, where the money went in a year, what an assumption audit finds, which
  edit explains a difference between two plans.
- **Experiment safely**: branches that follow a parent plan, a diff and merge, version history with undo,
  change sets (propose, preview, apply or discard), what-if templates, survivor scenarios.
- **Track progress**: balance snapshots over time against the plan, scheduled check-ins and notifications
  when the chance of success or a milestone moves.
- **Share and collaborate**: owner, editor and viewer sign-ins, read-only share links.
- **Import**: ProjectionLab JSON, bank/budgeting CSV (Monarch, YNAB and generic presets), OFX / QFX / QIF bank
  statements, and Glideworth's own export. **Export**: JSON, CSV tables, printable report.
- **Integrate**: scoped API keys, signed webhooks, idempotent and conflict-safe writes, MCP over stdio or HTTP.

## Requirements

- Node 24 (`.nvmrc`) and pnpm 10 (`corepack enable`)
- Docker, optionally, for the one-container deployment

## Quick start: development

```bash
pnpm install
cp .env.example .env     # dev defaults: API port 8787, a dev API key, a synthetic sample household
pnpm dev                 # API on :8787 and web on :5173
```

- Web app: <http://localhost:5173>. The Vite dev server proxies `/api` and adds the API key server-side, so
  no sign-in is needed in development.
- API reference: <http://localhost:8787/docs> (the page loads its script from a CDN; `/openapi.json` and the
  API itself work offline).
- The first start creates `apps/api/data/glideworth.db`, applies migrations, inserts the dev key from `.env` and
  seeds a **synthetic** US sample household (`hh-sample`). `pnpm seed` adds a synthetic UK one
  (`hh-uk-sample`); `pnpm seed -- --sample us --replace` reloads the US one. Nothing real ships with the repo.

Try the API (the key below is the public development key from `.env.example`):

```bash
export GLIDEWORTH=http://localhost:8787 KEY=glideworth_devlocal_0123456789abcdef0123456789abcdef
curl -s -H "Authorization: Bearer $KEY" $GLIDEWORTH/api/v1/me
curl -s -X POST "$GLIDEWORTH/api/v1/plans/plan-main/monte-carlo?wait=60" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"settings":{"trials":1000}}'
# -> a job; its result (successRate, percentiles, failure analysis) is at links.result:
curl -s -H "Authorization: Bearer $KEY" "$GLIDEWORTH/api/v1/jobs/<job id>/result"
```

The full walkthrough (every route group, errors, idempotency, change sets, webhooks) is in
[docs/API.md](docs/API.md).

## Quick start: production, one process, one port

```bash
pnpm install
pnpm build               # core -> importers -> api (dist/) and the web bundle (apps/web/dist)
pnpm start               # NODE_ENV=production node apps/api/dist/server.js -> http://localhost:8787
```

The same port serves the web app, `/api`, `/mcp` and `/docs`. Open it, choose a passphrase (12 or more
characters) and you are in. Set `GLIDEWORTH_SETUP_TOKEN` in `.env` first if anyone else can reach the port, and
empty `GLIDEWORTH_WEB_ORIGIN`. The public example API key in `.env.example` is **refused** in production: create
your own with `pnpm keys:create -- --name laptop --scopes read,write`.

Backups are one file and safe while the server runs:

```bash
pnpm backup                              # -> apps/api/data/backups/glideworth-<timestamp>.db
pnpm backup -- --out ~/glideworth.db
pnpm restore -- --from ~/glideworth.db --force   # stop the server first; the old DB is kept beside it
```

## Quick start: Docker

```bash
cp .env.example .env     # then set GLIDEWORTH_SETUP_TOKEN, and leave GLIDEWORTH_BOOTSTRAP_KEY empty (or your own secret)
docker compose up -d --build            # http://localhost:8787, data in the cairn-data volume
docker compose exec glideworth node dist/cli/admin.js backup --out /data/backups/manual.db
```

One container, SQLite on a volume, non-root user, health check on `/health`. Behind a TLS reverse proxy set
`GLIDEWORTH_TRUST_PROXY=true`. Details: [docs/API.md](docs/API.md#running-in-production-one-process-one-port).

## Importing from ProjectionLab

Export your data from ProjectionLab (account menu, JSON export), then either:

- in the web app: **Import**, drop the file, review the report (what mapped exactly, what was approximated,
  what has no equivalent), apply; or
- over the API, dry run first:

```bash
curl -s -X POST $GLIDEWORTH/api/v1/import -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d "{\"format\":\"projectionlab\",\"dryRun\":true,\"data\":$(cat projectionlab-export.json)}"
```

The report lists every issue by key path (never your values) and per-entity counts. A re-import of the same
household needs `"mode": "replace"`. Your ProjectionLab plugin API key, if present in the file, is discarded.
Bank balances can come from CSV (`POST /households/{id}/import/csv`, dry run by default).

Glideworth is not affiliated with or endorsed by ProjectionLab. The name is used only to say which file format
the importer reads.

## Connecting an AI assistant (MCP)

Glideworth's MCP server has 54 read and compute tools and, only if you enable them, 21 write tools. Plan edits
are always proposals you approve; nothing can be deleted.

```bash
pnpm keys:create -- --name claude --scopes read          # least privilege: analysis only
claude mcp add --transport http glideworth http://localhost:8787/mcp \
  --header "Authorization: Bearer glideworth_xxxxxxxx_..."
```

or over stdio, with no server running (after `pnpm build`):

```bash
claude mcp add glideworth -e GLIDEWORTH_DB_PATH=/abs/path/apps/api/data/glideworth.db -e GLIDEWORTH_MCP_ALLOW_WRITES=false \
  -- node /abs/path/apps/api/dist/mcp/stdio.js
```

Then ask: "Summarise my finances and plan", "What is my chance of success, and why does it fail when it
fails?", "What if I retire three years earlier? Save it as a branch.", "What is the most I can spend at 90%
success?", "Review my assumptions and show what changing the top finding would do." Claude Desktop, Cursor and other clients,
the write tools, prompts and resources are covered in [docs/MCP.md](docs/MCP.md).

## Project layout

```
packages/core        domain schema (Zod), the engine, tax plug-ins, Monte Carlo, solvers, insights, samples
packages/importers   ProjectionLab and CSV import, JSON / CSV / report export
apps/api             Hono REST API + OpenAPI 3.1, SQLite (Drizzle), jobs in worker threads, MCP server, CLI
apps/web             React app (Vite): builder, results, chance of success, cash flow, taxes, estate, compare
docs/                ARCHITECTURE, API, MCP, USER-GUIDE, PARITY, STATUS, SELF-HOSTING
private/             your own local files (for example an export): gitignored, never committed
```

Money is a number in major currency units, rates are fractions (`0.07` = 7%), the engine's output is
nominal with a per-period price index so every series can be shown in today's money. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Testing

```bash
pnpm test                # Vitest across every package (engine, importers, API, MCP, web); one importer suite
                         # runs only when you have a ProjectionLab export locally, and is skipped otherwise
pnpm typecheck           # tsc --noEmit in every package
pnpm lint                # oxlint (warnings denied); `pnpm format:check` checks formatting (oxfmt)
pnpm bench               # opt-in engine benchmarks (wall-clock, not part of `pnpm test`)
pnpm --filter @glideworth/api test    # just the API and MCP suites
```

The API suites include a real-socket server test, a security suite (SSRF, throttling, scope enforcement on
every route, prototype pollution), OpenAPI quality gates, and an MCP suite that drives the six
agent tasks end to end.

## Privacy model

Glideworth is self-hosted and local-first. Your data lives in one SQLite file on your machine (or your Docker
volume). Nothing is sent anywhere: no telemetry, no analytics, no hosted AI, no account linking. The only
network calls the server makes are webhooks you configure (blocked for private addresses unless you allow
them). The browser needs the internet for one optional thing: the `/docs` page loads its viewer script from
the jsDelivr CDN. The marketing website is a separate static build. It loads Google Tag Manager only when
`PUBLIC_GTM_ID` is set at build time. That variable is unset in this repository and in a self-hosted build.
The official hosted website is the only place that sets it, and the app never loads the tag. An AI assistant sees only what its tools return, with the scopes you gave its key, and a
model provider that you connect sees that data too: use a local model if that matters. Passphrases are
hashed with scrypt, API keys and sessions are stored as hashes, and a local `private/` folder (gitignored, for
your own files) is never read by the app.

## More documentation

|                                              |                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md)     | concepts, a UK walkthrough, how results are calculated, limitations           |
| [docs/API.md](docs/API.md)                   | REST API: conventions, auth, every route group, security model, configuration |
| [docs/MCP.md](docs/MCP.md)                   | MCP tools, resources, prompts, client setup, worked examples                  |
| [docs/PARITY.md](docs/PARITY.md)             | a feature-by-feature matrix of what is implemented, partial or missing        |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | packages, data model, engine pipeline, tax plug-ins, persistence              |
| [docs/STATUS.md](docs/STATUS.md)             | what is built, test totals, known limitations, what remains                   |
| [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) | install, configure, back up and upgrade your own instance                     |

## Licence

Glideworth is licensed under the GNU Affero General Public License v3.0 only ([LICENSE](LICENSE)); the
importers package (`packages/importers`) is MIT. [LICENSING.md](LICENSING.md) explains which licence covers
what, and [DATA-LICENSES.md](DATA-LICENSES.md) lists the sources and licences of the bundled data sets and
tax tables. Running your own copy is covered in [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

## Contributing

Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) first (set-up, checks, the contributor
agreement and how to report security problems).
