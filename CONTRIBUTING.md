# Contributing to Glideworth

Thank you for helping. Glideworth is an open-source personal financial and retirement planner. Because it
produces numbers people may act on, correctness and evidence matter more here than speed.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md). For security problems, do not open an issue:
follow [SECURITY.md](SECURITY.md).

## Before you start

- **Questions and ideas:** use GitHub Discussions. **Bugs and requests:** use the issue templates.
- **Larger changes** (new features, new package, schema changes): open an issue or discussion first, so
  that you do not build something that will not be merged.
- **Licensing:** the app is AGPL-3.0-only, `packages/importers` is MIT. See [LICENSING.md](LICENSING.md).
- **CLA:** you must sign the [Contributor Licence Agreement](CLA.md) before a pull request can be merged
  (see below).

## Set up

You need **Node 24** (the version in `.nvmrc`) and **pnpm 10** (the version in `packageManager`; run
`corepack enable` and it is selected for you). Docker is optional.

```bash
git clone <your fork>
cd glideworth
corepack enable
pnpm install
cp .env.example .env        # development defaults: API on :8787, a dev API key, a synthetic sample household
pnpm dev                    # API on :8787 and web on :5173
```

The README has the rest: API reference, the one-process production build and the Docker build.
Day-to-day commands:

| Command           | What it does                                                            |
| ----------------- | ----------------------------------------------------------------------- |
| `pnpm dev`        | API and web in watch mode (no build needed: packages resolve to `src/`) |
| `pnpm test`       | all Vitest suites; `pnpm --filter <package> test` for one package       |
| `pnpm test:watch` | Vitest in watch mode                                                    |
| `pnpm format`     | format every file with oxfmt (`pnpm format:check` only checks)          |
| `pnpm lint:fix`   | apply oxlint's safe fixes                                               |
| `pnpm bench`      | wall-clock engine benchmarks (opt-in, not part of `pnpm test`)          |
| `pnpm knip`       | report unused files, exports and dependencies (informational)           |

## Quality gates

Every pull request must pass all of these, and CI runs them. CI does not run on draft pull requests (their
`CI gate` check fails until you mark the pull request ready for review), and a pull request must be up to date
with `main` before it merges:

```bash
pnpm typecheck
pnpm lint          # oxlint, warnings denied
pnpm format:check  # oxfmt
pnpm test
pnpm build
```

`pnpm install` also installs git hooks (husky): a pre-commit hook runs oxlint and oxfmt on the staged
files, and a pre-push hook runs typecheck, lint and tests. They are skipped in CI and Docker builds.
Set `HUSKY=0` to bypass them for one command. The engine benchmarks (`pnpm bench`) are wall-clock
measurements and are not part of `pnpm test`.

A pull request that changes a GitHub Actions workflow is also checked by
[zizmor](https://docs.zizmor.sh/), which looks for security mistakes in workflows (run it locally with
`uvx zizmor .github/workflows/`).

Run them locally before you push. Add tests with your change: a bug fix needs a test that fails without
the fix; a feature needs tests for its behaviour and its edges. Do not weaken, skip or delete a test to
make a change pass, unless the test was wrong, and then say so in the pull request.

## Package boundaries

From [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) section 1. A pull request that breaks these will be
sent back.

```
packages/core        pure TypeScript + zod: schema, engine, tax plug-ins, stochastic, solvers, insights
packages/importers   pure TypeScript: ProjectionLab / CSV import, exports         (MIT)
apps/api             Hono + SQLite + OpenAPI + MCP
apps/web             React + Vite
```

- `core` depends only on `zod`. No DOM, no Node APIs, no clock (`Date.now()`), no randomness except the
  seeded RNG. It must run the same in Node, a browser and a Web Worker.
- `importers` depends on `core` only. It stays pure so it can run in the browser.
- `api` depends on `core` and `importers`. It never re-implements domain logic.
- `web` depends on `core` and `importers`. It stores data only through the API.
- Nothing in `core` or `importers` may import from `apps/*`.
- The self-hosted build has every feature. Do not add a feature that is only reachable with a licence key,
  a payment or a hosted-service flag, and do not add telemetry of any kind.

## Synthetic data only

**Never commit real financial data**: no real balances, account numbers, names, addresses, employer
details, exports from your own ProjectionLab or bank, nor real tokens, passphrases, API keys or database
files. Fixtures, test vectors, screenshots and bug reports use invented people and invented numbers. If
you need a realistic file, generate one with the samples in `@glideworth/core/samples` (or the sample
household created by `pnpm seed`). Pull requests containing real data are closed, and the data is removed
from history, which may require a force-push.

## Adding or updating a tax year

Tables live in `packages/core/src/tax/data` and `packages/core/src/tax/jurisdictions/<country>.ts`; the
list of what each country leaves out is `TAX_SIMPLIFICATIONS`
(`packages/core/src/tax/data/simplifications.ts`).

1. **Open an issue first** (the "Tax-rule correction" template) if you are not sure what has changed.
2. **Use official sources only**: the tax authority's published rates and thresholds, the legislation, or
   the government's own guidance (for example gov.uk, irs.gov, canada.ca, ato.gov.au). Do not use blogs,
   forum posts or other calculators as sources. They may point you to the right page.
3. **Record the evidence.** In the pull request description and in a comment next to each figure, give:
   the URL, the document and section or table, and the date you read it. For a figure you could not
   confirm, say so and mark it provisional in `TAX_SIMPLIFICATIONS`, as the existing tables do.
4. **State the tax year exactly** (for example `2026/27` for the UK, `2026` for the US) and what happens
   for later years (the engine carries rates forward and indexes thresholds; do not copy a year forward
   yourself unless the rule is legislated).
5. **Add test vectors** in `packages/core/test/`: at least one worked example per changed band,
   allowance or rule, with synthetic inputs, the expected tax, and where the expected result comes from
   (an official worked example or an official calculator, with the URL). Include the edge cases at each
   threshold (just below, at, just above). Existing files such as `tax-uk.test.ts` show the shape.
6. **Update the documentation**: the tax-year table and the "figures that could not be confirmed" list in
   [docs/STATUS.md](docs/STATUS.md), and the country's simplifications.
7. Run the four quality gates. Existing tests whose numbers change must be updated with the new source
   cited, not deleted.

## Adding a jurisdiction

1. Open an issue to agree the scope and a maintainer for that country. A country with no one who can
   verify it against official sources will not be merged.
2. Create `packages/core/src/tax/jurisdictions/<code>.ts` implementing the `TaxJurisdiction` interface
   (`packages/core/src/tax/types.ts`) and register it in `packages/core/src/tax/registry.ts`
   (`IMPLEMENTED_JURISDICTIONS`).
3. Add the country's account types, defaults (currency, locale, state-pension rules) and
   `TAX_SIMPLIFICATIONS` entries listing everything the estimate leaves out. A plain "not modelled" list is
   a feature: users must see what is missing.
4. Add tests as above (official examples, thresholds, a full-plan golden test), and the same
   documentation updates, plus a row in the PARITY or STATUS tables.
5. If it affects cross-border results, add the treaty or residence rule with its source and mark rows you
   could not verify as "not verified".

Data sets (market history, inflation) are a separate matter: they need a licence that allows commercial
redistribution and an entry in `DATA-LICENSES.md`. Do not add data whose terms you have not checked.

## Commits and pull requests

- **One logical change per pull request**, small enough to review. Unrelated clean-ups go separately.
- **Branch** from `main`; keep your branch rebased on it. Do not commit to `main` directly.
- **Commit messages:** an imperative subject under about 70 characters ("Add NZ 2027-28 bands"), then a
  body that says why, if it is not obvious. Reference the issue ("Closes #123").
- **Pull request:** fill in the template: what and why, the checklist, sources for tax changes. Say what
  you tested and what you did not.
- **Reviews:** a maintainer reviews every change; expect questions about evidence and tests. The project
  is run by very few people, so please be patient and keep the pull request alive if asked for changes.
- **Style:** oxfmt decides formatting (`pnpm format`; a pre-commit hook formats the staged files). Follow the surrounding code. Money is a number in major currency
  units, rates are fractions (`0.07` for 7%).
- **Documentation and API:** update `docs/` and the OpenAPI schema (it is generated from the Zod schemas in
  `core`) when behaviour changes.

## Contributor licence agreement

Before the first pull request is merged you sign the [CLA](CLA.md) once, by commenting on the pull request
(the CLA workflow explains how). The agreement lets the project keep the option to relicense. If you
cannot use the comment process, [CLA.md](CLA.md) describes a manual route. The check must be green before
merge. If your employer may own what you write, get their permission first.

## Machine-generated contributions

You may use AI coding assistants and other generators, but you are the author and you are responsible:

- **A human must review** every line before submitting, and must be able to explain and defend it in
  review. Unreviewed bulk output will be closed.
- **Run the tests yourself**, and include new tests that you have read and checked: tests written by the
  same tool that wrote the code prove little, so check them against official sources.
- **Disclose** it in the pull request: the tool and what it did (the template has a field). Disclosure is
  not penalised. Undisclosed machine-generated work found later may be reverted.
- **Evidence still rules for tax and finance.** A generator cannot be the source of a rate or a rule. Every
  figure needs an official source that a human has opened and read.
- **Do not paste private data into a tool** to produce a contribution, and do not paste secrets.
- You must be entitled to submit the result under the CLA. If you are not sure that you are, do not submit
  it.
- Fully automated pull requests (opened by a bot or agent with no human in the loop) are not accepted,
  except dependency updates from Dependabot.

## Reporting problems

- Bugs and feature requests: the issue templates.
- A wrong tax figure: the "Tax-rule correction" template, with an official source.
- Security: [SECURITY.md](SECURITY.md), never a public issue.
- Conduct: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
