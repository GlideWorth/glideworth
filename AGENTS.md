# AGENTS.md

Instructions for AI coding agents working in this repository. People should read
[CONTRIBUTING.md](CONTRIBUTING.md); where the two differ, CONTRIBUTING.md wins.

If you are an agent setting Glideworth up or connecting it to an assistant, rather than changing its code, read
[docs/agents/SETUP.md](docs/agents/SETUP.md) instead. To use a running Glideworth through MCP or the REST API,
read [skills/glideworth/SKILL.md](skills/glideworth/SKILL.md).

## The project

Glideworth is a retirement and financial planner: a projection engine, Monte Carlo, solvers, a REST API, an MCP
server and a React web app. TypeScript, pnpm workspaces, Node 24 (`.nvmrc`), pnpm 10.

```
packages/core        schema, engine, tax plug-ins, stochastic, solvers, insights  (depends only on zod)
packages/importers   ProjectionLab / CSV import, exports                        (MIT; depends only on core)
apps/api             Hono + SQLite + OpenAPI + MCP                              (core, importers)
apps/web             React + Vite                                               (core, importers; data via the API)
apps/site            the marketing and documentation site (Astro)
```

Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). What is built and what is not trusted yet:
[docs/STATUS.md](docs/STATUS.md).

## Commands

```bash
pnpm install
cp .env.example .env          # dev defaults: API :8787, a public dev API key, a synthetic sample household
pnpm dev                      # API :8787, web :5173
pnpm --filter @glideworth/core test    # one package; prefer this while iterating
```

Before you finish, run the gates CI runs, and report any that fail:

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```

## Rules that are easy to break

- **`packages/core` is pure.** No DOM, no Node APIs, no `Date.now()`, no `Math.random()`: use the seeded RNG. It
  runs unchanged in Node, the browser and Web Workers. Nothing in `core` or `importers` imports from `apps/*`.
- **Money** is a plain number in major currency units (`1234.56`). **Rates** are fractions (`0.07` for 7%). Every
  amount has a basis: `real` (today's money) or `nominal`.
- **Agent docs follow the code.** `docs/agents/SETUP.md` and `skills/glideworth/SKILL.md` name real MCP tools,
  and `apps/api/test/agent-docs.test.ts` fails when one is renamed or removed. The site serves the skill from
  that file at `/.well-known/skills/default/skill.md`.
- **The schema is the API.** Zod schemas in `packages/core/src/schema` generate the OpenAPI document and the MCP
  tool inputs. A change to stored documents needs a migration in `MIGRATIONS` and a `SCHEMA_VERSION` bump.
- **Plan edits are change sets** (RFC 6902 patches proposed, then applied), never silent overwrites, in the API
  and MCP alike.
- **Self-hosted builds have every feature.** Do not gate anything behind a licence key, payment or hosted-only
  flag, and add no telemetry to self-hosted code.
- **Synthetic data only.** Never commit real balances, names, exports, tokens or database files. Use the samples in
  `@glideworth/core/samples`.

## Tax and financial figures

You cannot be the source of a rate, threshold or rule. Every figure needs an official source (the tax authority,
the legislation or government guidance) that a human has opened, cited next to the figure with its URL, section
and the date read. If you cannot confirm a figure, mark it unconfirmed in `TAX_SIMPLIFICATIONS` and
`docs/STATUS.md` instead of guessing. Follow "Adding or updating a tax year" in CONTRIBUTING.md step by step, with
test vectors at each threshold (just below, at and just above).

## Tests

A bug fix needs a test that fails without it. Do not weaken, skip or delete a test to make a change pass; if a test
was wrong, say so in the pull request. Tests you write prove little on their own, so tie expected tax results to an
official worked example or calculator.

## Pull requests

A human must review every line and open the pull request. Fully automated pull requests are not accepted, except
Dependabot's. Fill in the template, including the field that discloses which tool was used and what it did. Keep
one logical change per pull request.
