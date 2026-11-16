# Glideworth MCP server

Glideworth ships a [Model Context Protocol](https://modelcontextprotocol.io) server so AI agents (Claude
Desktop, Claude Code, Cursor, ...) can read your plans, run simulations and propose edits, **safely**.
It is a thin adapter over the same services as the [REST API](./API.md): every tool has a REST twin.

Design rules:

- **Read-only by default.** Write tools only exist when the server enables writes
  (`GLIDEWORTH_MCP_ALLOW_WRITES=true`) _and_ the connecting key has `write` scope. A client that cannot
  see a tool cannot call it.
- **Plan edits are change sets or branches, never overwrites.** The agent proposes RFC 6902 ops, gets a
  readable diff plus a before/after outcome, shows you, and only then applies. A stale proposal is a
  conflict, not a silent merge. Every apply is recorded in the plan history with the agent's identity.
  Household _data_ is different by design: `update_account_balances`, `record_progress_snapshot` and
  `apply_csv_import` write directly (they record actuals, not assumptions, and are atomic; snapshots
  keep the history), and `create_branch*` adds a what-if without touching the parent.
- **No delete tools.** Anything destructive has to be a change set (even "revert to version N" is a
  proposal). The only "undo" style tools are `revoke_share_link` (stops a link) and `unset_fx_rate` (removes one
  exchange-rate pair); neither deletes plans or household data.
- **Minimal inputs.** `planId` defaults to the main plan and `householdId` to the only household; when
  that is ambiguous the error names the candidates. Everything else has a default.
- **Compact outputs.** Tools return compact JSON (no pretty-printing, ids included, money rounded to
  whole units in today's money) and take `detail: "summary" | "full"` where output can be large. Measured
  on the sample plans: a normal call is 0.1-4 KB (`get_plan_summary` 4-7 KB, `explain_years` about 7 KB,
  the two schema resources about 100 KB each and flagged as such). Solvers return an `answer` sentence, the
  money/date `details` and the `ops` that apply it, not the 40-point search trace (`detail: "full"`).
- **Errors say how to recover.** Every failure is an `isError` result with `code`, `message`, `details`
  and a `hint` (what to call next); a missing plan or household also lists the `validIds`. Unexpected
  failures say only `internal error`, never a stack trace or path.
- **Read-only means read-only.** Read and compute tools never change household or plan data (verified by
  row counts before/after calling every one). Compute tools do write cache and job rows, which is why Monte
  Carlo results are reproducible and repeat calls are instant.
- **Units are spelled out** in the server instructions: money in major currency units, rates as
  fractions, `real` = today's money, "20k/month" is `20000` with frequency `monthly`.

## Connect

Two transports expose the same tools:

| Transport       | Endpoint                                                         | Auth                                                       | Writes enabled by                                                                 |
| --------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Streamable HTTP | `POST http://localhost:8787/mcp`                                 | `Authorization: Bearer <api key>` (never a browser cookie) | `GLIDEWORTH_MCP_ALLOW_WRITES=true` on the server **and** a key with `write` scope |
| stdio           | `node apps/api/dist/mcp/stdio.js` (or the tsx source, see below) | none (a local process you start)                           | `GLIDEWORTH_MCP_ALLOW_WRITES=true` in the process env                             |

The HTTP endpoint is stateless (a fresh server per request, JSON responses), so it works behind plain
proxies. Which tools a key sees depends on its scopes: `read` gets the read and compute tools,
`simulate` gets only compute tools, `write` (with the server flag) adds the write tools. The HTTP server
is the same process that serves the web app and the REST API; in production it needs an API key even
though the browser uses a passphrase login (create one with `pnpm keys:create`, or set
`GLIDEWORTH_BOOTSTRAP_KEY`).

Create a least-privilege key for an agent:

```bash
pnpm keys:create -- --name claude-readonly --scopes read      # analysis only
pnpm keys:create -- --name claude-editor   --scopes read,write # can propose and apply change sets
```

Use absolute paths in every config below. Do not launch a stdio server through `pnpm run`: pnpm prints a
banner to stdout, which is the protocol channel. Logs go to stderr.

### Claude Code

**HTTP** (the API server must be running: `pnpm dev`, `pnpm start` or Docker):

```bash
claude mcp add --transport http glideworth http://localhost:8787/mcp \
  --header "Authorization: Bearer glideworth_xxxxxxxx_..."
# a different port / host: use its URL. Remote: put TLS in front and keep the key secret.
```

**stdio** (nothing else needs to run; reads the SQLite file directly), after `pnpm build`:

```bash
claude mcp add glideworth \
  -e GLIDEWORTH_DB_PATH=/abs/path/to/glideworth/apps/api/data/glideworth.db \
  -e GLIDEWORTH_MCP_ALLOW_WRITES=false \
  -- node /abs/path/to/glideworth/apps/api/dist/mcp/stdio.js
```

Without a build, run the source through tsx instead:
`-- /abs/path/to/glideworth/apps/api/node_modules/.bin/tsx --conditions=@glideworth/source /abs/path/to/glideworth/apps/api/src/mcp/stdio.ts`.
Set `GLIDEWORTH_MCP_ALLOW_WRITES=true` only when you want the agent to be able to propose and apply change sets.

Project-scoped config (`.mcp.json`, checked in or not):

```json
{
  "mcpServers": {
    "glideworth": {
      "type": "http",
      "url": "http://localhost:8787/mcp",
      "headers": { "Authorization": "Bearer ${GLIDEWORTH_MCP_KEY}" }
    }
  }
}
```

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`)
and restart the app.

**stdio** (reads the SQLite file directly; nothing else running):

```json
{
  "mcpServers": {
    "glideworth": {
      "command": "node",
      "args": ["/abs/path/to/glideworth/apps/api/dist/mcp/stdio.js"],
      "env": {
        "GLIDEWORTH_DB_PATH": "/abs/path/to/glideworth/apps/api/data/glideworth.db",
        "GLIDEWORTH_MCP_ALLOW_WRITES": "false"
      }
    }
  }
}
```

(Source mode: `"command": "/abs/path/to/glideworth/apps/api/node_modules/.bin/tsx"`,
`"args": ["--conditions=@glideworth/source", "/abs/path/to/glideworth/apps/api/src/mcp/stdio.ts"]`.)

If Glideworth runs in Docker, use the container's own copy of the server and database:

```json
{
  "mcpServers": {
    "glideworth": {
      "command": "docker",
      "args": [
        "exec",
        "-i",
        "-e",
        "GLIDEWORTH_MCP_ALLOW_WRITES=false",
        "glideworth",
        "node",
        "dist/mcp/stdio.js"
      ]
    }
  }
}
```

**HTTP** (a running API server), through the `mcp-remote` bridge for clients that only speak stdio:

```json
{
  "mcpServers": {
    "glideworth": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:8787/mcp",
        "--header",
        "Authorization:${GLIDEWORTH_AUTH}"
      ],
      "env": { "GLIDEWORTH_AUTH": "Bearer glideworth_xxxxxxxx_..." }
    }
  }
}
```

Newer Claude Desktop builds can add the same URL and header as a custom connector (Settings, Connectors)
instead of the bridge.

### Any other client

- HTTP: URL `http://localhost:8787/mcp`, header `Authorization: Bearer <key>`.
- stdio: run `node apps/api/dist/mcp/stdio.js` with `GLIDEWORTH_DB_PATH` set.
- Try it without a client: `npx @modelcontextprotocol/inspector` and point it at either transport.

### Remote clients: OAuth (no pasted key)

Hosted MCP clients connect by URL and sign in with **OAuth 2.1**, following the MCP authorization
specification: the first request to `/mcp` is `401` with a `WWW-Authenticate` header pointing at
`/.well-known/oauth-protected-resource/mcp`; the client discovers the authorization server, registers itself
(RFC 7591), sends the user to the consent screen served by Glideworth (it signs them in first), and redeems the code
with PKCE (S256). Tokens last an hour and refresh (with rotation). Bearer API keys keep working.

- **Scopes** map to what the connection can do: `read` (data tools), `simulate` (compute tools), `write`
  (write tools, and only when `GLIDEWORTH_MCP_ALLOW_WRITES=true`). On the consent screen the user can grant less than
  was asked, never more; the grant is capped by their **role** (a viewer's connection never has write tools) and
  follows later role changes.
- Put Glideworth behind TLS and set `GLIDEWORTH_PUBLIC_URL`; the OAuth redirect URIs must be `https` or `localhost`.
- Revoke a client with `GET/DELETE /api/v1/me/oauth-grants` (yours) or `GET/DELETE /api/v1/oauth/clients` (owner).
- Every write through MCP is recorded in the audit log under the person who consented (or whose key it is).

Details, endpoints and the security rules are in [API.md](./API.md#oauth-for-remote-mcp-clients).

## Tools

75 tools: 54 read/compute tools (all `readOnlyHint`) and 21 write tools (only with writes enabled and a `write` key; never for a `viewer`). The hosted service (cloud mode) has the same tools; there, writes are enabled per workspace by its owner (workspace settings, `mcpWrites`) instead of `GLIDEWORTH_MCP_ALLOW_WRITES`, credentials are `gwk_…` API keys or `gwa_…` OAuth tokens of one workspace, the OAuth consent page signs you in with your Glideworth account and asks which workspace to connect, and a read-only workspace (trial ended, payment lapsed) offers no write tools while job tools answer `ACCOUNT_READ_ONLY` with the billing link. The server instructions the client receives (about 2 KB) point agents at the right tool for the common questions.

Money in outputs is in today's money unless a `basis` argument says otherwise. Ids are always the
ones returned by the list tools; pass them back verbatim.

### Read (key scope `read`)

| Tool                                 | What it does                                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_households`                    | households: id, people, currency, location                                                                                                                                                   |
| `get_household`                      | accounts, real assets, debts and totals (`detail: full` = raw documents)                                                                                                                     |
| `list_accounts`                      | account id, name, type, owner, balance                                                                                                                                                       |
| `list_plans`                         | plans: id, name, **version**, isMain, status, parent (if a branch), in the user's display order                                                                                              |
| `get_plan`                           | compact plan (milestones, income, expenses, flows with ids, amounts like `5200 real/monthly`, date ranges) or `detail: full`                                                                 |
| `list_plan_versions`                 | edit history: version, time, actor, message                                                                                                                                                  |
| `diff_plans`                         | readable differences between two plans                                                                                                                                                       |
| `list_progress_snapshots`            | recorded actuals over time                                                                                                                                                                   |
| `list_change_sets`, `get_change_set` | proposals and their previews                                                                                                                                                                 |
| `export_table`                       | a projection table (`year-by-year`, `cash-flow`, `taxes`, `account-balances`) as thinned rows or CSV text                                                                                    |
| `export_report`                      | the printable report as data: key figures, milestones, assumptions, finances, caveats, thinned series                                                                                        |
| `list_fx_rates`                      | FX pairs the household uses for foreign-currency accounts, assets and debts                                                                                                                  |
| `get_residency_timeline`             | who lives where, when: household location, dated moves, relocation milestones, past residence, citizenships; only the years whose residence changes; warnings                                |
| `cross_border_rules`                 | the rule tables: `kind` = `countries`, `non-resident` (a country's rules for non-residents), `treaty` (a pair, both directions), `wrappers` (foreign-wrapper recognition), `simplifications` |
| `get_plan_health_history`            | the plan's check-in time series: success rate, FI year, net worth vs plan, open findings                                                                                                     |
| `list_notifications`                 | notifications raised by check-ins (unread by default)                                                                                                                                        |
| `get_checkin_schedule`               | cadence, thresholds, last/next run                                                                                                                                                           |
| `what_changed_since_checkin`         | **what changed since my last check-in**: material changes, edits since and by whom, net worth moved; `refresh=true` takes a new check-in first (needs write)                                 |
| `preview_bank_file_import`           | **dry run** of an OFX / QFX / QIF import: accounts (numbers masked), balance reconciliation, annual expense summary, issues. Writes nothing                                                  |
| `preview_csv_import`                 | **dry run** of a CSV import (balances / progress history / transactions): detected columns, issues, before/after reconciliation. Writes nothing                                              |

### Compute (scope `simulate` or `read`)

| Tool                                                                                                                                           | What it does                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_plan_summary`                                                                                                                             | **best first call**: compact plan + the household's current finances (net worth) + deterministic outcome + 5-yearly net worth table                                                                                                                                                                                                                 |
| `simulate_plan`                                                                                                                                | deterministic projection; choose `fromYear/toYear/everyNYears/series/accountIds/basis`                                                                                                                                                                                                                                                              |
| `run_monte_carlo`                                                                                                                              | chance of success (`trials`, `seed`, `method`); returns a one-sentence `headline`, success rate, outcome counts, thinned p10/p50/p90 fan and, when trials fail, `failureAnalysis` (years first shortfalls land in, sequence-of-returns risk by early-return quintile, failures before/after retirement). Sharded across worker threads for big runs |
| `run_historical_backtest`                                                                                                                      | replay through every historical start year                                                                                                                                                                                                                                                                                                          |
| `compare_plans`                                                                                                                                | 2-6 plans side by side, what differs, optional explanation                                                                                                                                                                                                                                                                                          |
| `explain_projection`                                                                                                                           | why the plan ended up here (optional `question`)                                                                                                                                                                                                                                                                                                    |
| `explain_year`, `explain_years`                                                                                                                | where the money went in one year / a range: income, outflows, saving, withdrawals, investment return, net-worth change (no ledger evidence unless `detail: full`)                                                                                                                                                                                   |
| `explain_difference`                                                                                                                           | why two plans end differently; with `attribute` how much of the change each edit explains (`metric: successRate` runs Monte Carlo)                                                                                                                                                                                                                  |
| `audit_plan`                                                                                                                                   | assumption audit, most severe first; a finding with a `fix` carries ready-made ops (`detail: full` adds the evidence)                                                                                                                                                                                                                               |
| `sensitivity`                                                                                                                                  | tornado: which assumptions move the outcome most                                                                                                                                                                                                                                                                                                    |
| `solve_max_spending`, `solve_retirement_date`, `solve_required_savings`, `solve_required_portfolio`, `solve_safe_withdrawal_rate`, `goal_seek` | goal-seek solvers at a target success rate (`trials` and `maxEvaluations` trade accuracy for speed). Result: `answer` (a sentence in money or dates), `details`, `neighbours` (the same answer at nearby targets), `ops` that apply it. `solve_required_savings` explains which flows can be solved for when you name one that cannot               |
| `evaluate_guardrails`                                                                                                                          | what the risk-based guardrail rules give for this year's spending (needs the plan's `riskGuardrails`; `trials` to go faster)                                                                                                                                                                                                                        |
| `guyton_klinger`                                                                                                                               | money-terms Guyton-Klinger guardrails: when to cut or raise, and the action now                                                                                                                                                                                                                                                                     |
| `optimise_tax_strategy`                                                                                                                        | compare tax strategies (UK allowance use, drawdown order, US bracket filling) or your own candidate patches; they come back ordered by the chosen measure, and the highest-scoring one as ops                                                                                                                                                       |
| `tax_breakdown`                                                                                                                                | taxes by year, jurisdiction and kind (cross-border plans add country and basis)                                                                                                                                                                                                                                                                     |
| `tax_by_country`                                                                                                                               | lifetime and per-year tax by country and basis (residence, source, citizenship, relief, exit, return) with the simplifications that apply                                                                                                                                                                                                           |
| `explain_item_taxation`                                                                                                                        | how one account, property, debt or income is taxed in a year and why: non-resident rule, treaty article, wrapper recognition, relief, warnings                                                                                                                                                                                                      |
| `compare_stay_or_move`                                                                                                                         | stay vs a move (`to`, `month`, `returnMonth?`, `personId?`) or vs `movePlanId`: deltas, tax by country for both, attribution, changes. Stores nothing                                                                                                                                                                                               |
| `compare_debt_payoff`                                                                                                                          | minimum payments vs avalanche vs snowball: interest paid/saved, debt-free date                                                                                                                                                                                                                                                                      |
| `strategy_matrix`                                                                                                                              | strategies x metrics (lifetime tax, net legacy, chance of success, final net worth) with scores; a job                                                                                                                                                                                                                                              |
| `income_by_tax_rate`                                                                                                                           | income taxed at each marginal rate per year                                                                                                                                                                                                                                                                                                         |
| `compare_sepp_methods`                                                                                                                         | 72(t) SEPP: RMD vs fixed amortisation vs fixed annuitisation                                                                                                                                                                                                                                                                                        |
| `list_whatif_templates`                                                                                                                        | scenario templates and their parameters (JSON Schema)                                                                                                                                                                                                                                                                                               |
| `preview_whatif`                                                                                                                               | instantiate a template for a plan: ops, readable changes, before/after. Stores nothing                                                                                                                                                                                                                                                              |
| `survivor_scenarios`                                                                                                                           | couples: what if each partner dies at 70 / 80 / 90 (or your ages), with before/after outcomes (a one-person household gets an explanatory note, not an empty list)                                                                                                                                                                                  |
| `preview_changes`                                                                                                                              | what-if: apply ops **in memory**, return diff + before/after; stores nothing                                                                                                                                                                                                                                                                        |
| `get_job`                                                                                                                                      | status/progress/result of a long job (`wait` seconds optional)                                                                                                                                                                                                                                                                                      |

Long-running tools (`run_monte_carlo`, solvers, guardrails, tax strategy, successRate attribution and
sensitivity) wait up to `wait` seconds (default 30) and return the result; if it is not ready they return
`{ jobId, status, progress, hint }` and the agent calls `get_job`. Clients that send a `progressToken`
receive MCP progress notifications while it runs. A finished solver result carries the job's `status:
"succeeded"` and the solver's own outcome as `solverStatus` (`converged`, `max-evaluations`, ...). Monte
Carlo uses a fixed default seed, so repeated calls are reproducible, comparable across plans, and cached.

### Write (needs `GLIDEWORTH_MCP_ALLOW_WRITES=true` and scope `write`)

| Tool                                    | What it does                                                                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `propose_change_set`                    | propose RFC 6902 `ops` for a plan: returns the readable diff and before/after outcome. **Applies nothing.**                                                                                                                               |
| `apply_change_set`                      | apply a proposed set atomically; `CHANGESET_CONFLICT` if the plan moved since                                                                                                                                                             |
| `discard_change_set`                    | drop a proposal                                                                                                                                                                                                                           |
| `propose_revert`                        | propose a change set that turns the plan back into version N (undo is also a proposal)                                                                                                                                                    |
| `create_branch`                         | create a what-if branch (optionally with initial ops); the parent is untouched                                                                                                                                                            |
| `create_branch_from_template`           | store a what-if template as a branch of the plan; the parent is untouched                                                                                                                                                                 |
| `apply_bank_file_import`                | apply an OFX/QFX/QIF import atomically (preview first)                                                                                                                                                                                    |
| `apply_csv_import`                      | apply a CSV import atomically (run `preview_csv_import` first and show the reconciliation)                                                                                                                                                |
| `update_account_balances`               | set many balances at once (all-or-nothing): accounts, real-asset values, **mortgage/loan balances** (`realAssets[].loanBalance`, or the asset id in `debts`) and debts; updates today's automatic progress snapshot (at most one per day) |
| `record_progress_snapshot`              | snapshot today's net worth from current balances                                                                                                                                                                                          |
| `cancel_job`                            | cancel a running job (returns once it has actually stopped)                                                                                                                                                                               |
| `run_checkin`                           | check in on a plan now (projection + Monte Carlo + audit) and store it in the health history; returns the material changes                                                                                                                |
| `mark_notifications_read`               | mark notifications read (`ids` or `all`)                                                                                                                                                                                                  |
| `set_checkin_schedule`                  | enable/disable, cadence, change thresholds                                                                                                                                                                                                |
| `create_share_link`                     | expiring, revocable read-only link to a plan's results (`privacy`: full / percent / hidden); the token is returned once                                                                                                                   |
| `list_share_links`, `revoke_share_link` | links and their status; stop one                                                                                                                                                                                                          |
| `propose_move`                          | propose (as a change set) that one person or everyone moves to a country from a month, optionally back later; returns the diff, before/after and the template notes                                                                       |
| `set_person_cross_border`               | update a person's citizenships, US green card, residence history and state-pension records (household write; only the fields passed change)                                                                                               |
| `set_fx_rate`, `unset_fx_rate`          | add/update or remove an FX pair (base units per foreign unit, optional annual drift)                                                                                                                                                      |

Tool failures are returned as `isError: true` results with `{ "error": { "code", "message", "details" } }`
(codes as in the REST API, e.g. `NOT_FOUND`, `VERSION_CONFLICT`, `PATCH_CONFLICT`, `CHANGESET_CONFLICT`,
`NOT_IMPLEMENTED` with `details.workstream`) so the agent can recover instead of seeing a protocol
failure.

### Patch addressing

Ops are JSON Patch with id-addressed array items. Never use indexes:

```json
[{ "op": "replace", "path": "/expenses/[id=exp-travel]/amount/value", "value": 15000 },
 { "op": "replace", "path": "/income/[id=inc-avery-salary]/amount/value", "value": 140000 },
 { "op": "add", "path": "/milestones/-", "value": { "id": "ms-move", "name": "Move", "kind": "custom", "criteria": [ ... ] } }]
```

An op whose target does not exist, or a failed `test` op, is `PATCH_CONFLICT` (nothing is applied).
Read `glideworth://schema/plan` (below) for the exact shapes.

## Resources

| URI                                              | Content                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `glideworth://schema/document`                   | JSON Schema of the whole `GlideworthDocument` (about 100 KB)                                  |
| `glideworth://schema/plan`                       | JSON Schema of a plan (about 100 KB)                                                          |
| `glideworth://docs/edit-paths`                   | the dozen most common plan edits as ready-to-adapt ops (read before the big schemas)          |
| `glideworth://docs/glossary`                     | terms: household, plan, branch, milestone, flow, real vs nominal, success rate, change set... |
| `glideworth://docs/units`                        | money, rates, bases, frequencies, patch addressing                                            |
| `glideworth://docs/change-sets`                  | the propose / review / apply workflow                                                         |
| `glideworth://plans/{planId}`                    | the full plan document (listed per plan)                                                      |
| `glideworth://plans/{planId}/summary`            | the compact plan                                                                              |
| `glideworth://households/{householdId}/document` | the whole workspace (large)                                                                   |

URIs saved before the rename from Cairn (`cairn://…`) still resolve to the same resources; they are not
listed and are deprecated.

## Prompts

| Prompt                     | Arguments                       | What it asks the agent to do                                                                        |
| -------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `review_my_plan`           | `planId?`                       | outcome + Monte Carlo + audit + sensitivity, then the three most valuable changes (changes nothing) |
| `why_might_my_plan_fail`   | `planId?`                       | chance of success, then `failureAnalysis` and `explain_year` on the earliest failure year           |
| `how_much_can_i_spend`     | `planId?`, `targetSuccessRate?` | `solve_max_spending`, quote the money per year, offer ops                                           |
| `can_i_retire_earlier`     | `planId?`, `targetSuccessRate?` | `solve_retirement_date`, explain the trade-off, offer a branch                                      |
| `retire_earlier_as_branch` | `planId?`, `years`              | `preview_whatif`, `create_branch_from_template`, Monte Carlo on both, `compare_plans`               |
| `check_my_assumptions`     | `planId?`                       | `audit_plan`, preview then propose the fix of the top finding, apply only after approval            |
| `what_if_spending`         | `planId?`, `change`             | translate "+500/month on dining" into ops, `preview_changes`, report before/after                   |
| `monthly_checkin`          | `householdId?`                  | collect balances, `update_account_balances`, compare with earlier snapshots and the plan            |

## Moving country

"Should we move to X?" → `compare_stay_or_move` (then `create_branch_from_template` with `templateId:
"relocation"` to keep it, or `propose_move` to change the plan itself). "How is my UK flat taxed after we
move?" → `explain_item_taxation`. "What do we pay where?" → `tax_by_country`. "Is there a treaty?" →
`cross_border_rules kind=treaty`. Residence status is what the plan says: Glideworth applies no statutory
residence test; say so when you answer.

## The six tasks, tool by tool

Each of these was run end to end through a real MCP client (stdio and Streamable HTTP) against the sample
plans, and is covered by `apps/api/test/mcp-agent.test.ts`.

| Task                                                                      | Tools, in order                                                                                                                                                  |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Summarise my finances and plan"                                          | `get_plan_summary` (plan, net worth, outcome in one call); `get_household` for account detail                                                                    |
| "Chance of success, and why does it fail when it fails"                   | `run_monte_carlo` (headline + `failureAnalysis`), then `explain_year` on `earliestFailureYear`, `explain_projection`, `sensitivity`                              |
| "Retire three years earlier: show the difference and save it as a branch" | `preview_whatif {templateId: "early-retirement", params: {years: 3}}`, `create_branch_from_template`, `run_monte_carlo` on both, `compare_plans {explain: true}` |
| "The most I can spend at 90% success"                                     | `solve_max_spending {targetSuccessRate: 0.9}`: `answer` is money per year; `ops` apply it                                                                        |
| "Update my balances and record a snapshot"                                | `list_accounts`, `update_account_balances {accounts: [...], recordSnapshot: true}`                                                                               |
| "Review my assumptions and show what changing the top finding would do"   | `audit_plan`, `preview_changes` with the finding's `fix.patch`, `propose_change_set`, (user agrees) `apply_change_set`                                           |

## Worked example: an agent edits a plan safely via a change set

User: "Can I spend 500 more a month on dining?" The agent is connected with a `read`+`write` key and the
server has `GLIDEWORTH_MCP_ALLOW_WRITES=true`. Every call below is a tool call; the numbers are illustrative.

**1. Orient.** `list_plans {}` -> `[{ id: "plan-main", version: 4, isMain: true, ... }]`. Then
`get_plan_summary { planId: "plan-main" }` -> compact plan (ids and amounts such as
`{ id: "exp-living", amount: "5200 real/monthly" }`), the deterministic outcome (`success: true`,
`endNetWorthReal: 910000`) and the 5-yearly table. The agent notes **version 4** and that dining lives in
`exp-living`.

**2. Ask "what if", storing nothing.**

```json
preview_changes {
  "planId": "plan-main",
  "ops": [{ "op": "replace", "path": "/expenses/[id=exp-living]/amount/value", "value": 5700 }]
}
```

```json
{
  "planVersion": 4,
  "changes": ["Living expenses raised from 5,200 to 5,700 per month"],
  "preview": {
    "before": { "endNetWorthReal": 910000, "depletionYear": null },
    "after": { "endNetWorthReal": 802000, "depletionYear": null }
  }
}
```

Optionally check the risk, not just the deterministic path: `run_monte_carlo { planId: "plan-main" }`
before, then on a branch (step 3b) after.

**3. Propose it** (still nothing is applied), against the version that was read:

```json
propose_change_set {
  "planId": "plan-main",
  "baseVersion": 4,
  "summary": "Living expenses +500/month (dining)",
  "rationale": "User asked whether they can spend 500/month more on dining",
  "ops": [{ "op": "replace", "path": "/expenses/[id=exp-living]/amount/value", "value": 5700 }]
}
```

```json
{
  "id": "cs_9f2c1a",
  "planId": "plan-main",
  "baseVersion": 4,
  "status": "proposed",
  "summary": "Living expenses +500/month (dining)",
  "changes": ["Living expenses raised from 5,200 to 5,700 per month"],
  "before": { "endNetWorthReal": 910000, "depletionYear": null },
  "after": { "endNetWorthReal": 802000, "depletionYear": null },
  "next": "Show the user the changes and before/after, then call apply_change_set (or discard_change_set)."
}
```

**3b. Or explore without touching the plan at all.** A what-if branch follows its parent and can be
compared: `create_branch { planId: "plan-main", name: "Dining +500", ops: [...] }` then
`compare_plans { planIds: ["plan-main", "<branch id>"], explain: true }`.

**4. Show the user, and wait.** The agent reports: "That takes about 108k off end net worth in today's
money (910k -> 802k) and the plan still never runs short. Want me to apply it?" **It applies only after
the user says yes:**

```json
apply_change_set { "changeSetId": "cs_9f2c1a" }
```

```json
{ "changeSetId": "cs_9f2c1a", "status": "applied", "planId": "plan-main", "newVersion": 5 }
```

**5. If the plan moved meanwhile** (the user edited it in the web app between 3 and 4), the apply is
refused and nothing is merged:

```json
{
  "error": {
    "code": "CHANGESET_CONFLICT",
    "message": "plan changed since the proposal",
    "details": { "baseVersion": 4, "currentVersion": 5 }
  }
}
```

The agent re-reads (`get_plan_summary`), proposes again against version 5, and shows the user again.

**6. Undo is also a proposal.** `list_plan_versions { planId: "plan-main" }` shows the agent's apply as
`{ version: 5, by: { kind: "mcp", label: "..." }, changeSetId: "cs_9f2c1a" }`. To go back:
`propose_revert { planId: "plan-main", version: 4 }` -> review -> `apply_change_set`. History is
append-only: the revert is version 6 holding version 4's content.

What makes it safe: the agent cannot overwrite a plan or delete anything; each edit is checked against
the version it was written for; the user sees the diff and the before/after before anything changes; and
every apply is attributed in the plan history.

## Other workflows

**"How am I doing?"** (read-only key)

1. `list_plans` -> pick the main plan.
2. `get_plan_summary { planId }` -> success, first shortfall year, end net worth, milestone dates.
3. `run_monte_carlo { planId, trials: 1000 }` -> success rate and fan.
4. `explain_projection`, `explain_years` and `audit_plan` if the answer is bad. Report in today's money.

**"Can I retire earlier?"** use the `can_i_retire_earlier` prompt, or: `solve_retirement_date
{ planId, milestoneId: "ms-retire", targetSuccessRate: 0.85 }`; or try a template:
`preview_whatif { planId, templateId: "early-retirement", params: { years: 3 } }` then
`create_branch_from_template`, and `compare_plans { planIds: [main, branch], explain: true }`.

**"What if the market crashes in 2035?"** `preview_whatif { templateId: "market-crash", params: { year:
2035, drop: 0.4 } }`; for a couple, `survivor_scenarios { planId }`.

**"Where did the money go in 2041?"** `explain_year { planId, year: 2041 }`.

**"What changed between these two plans, and why does it matter?"** `explain_difference { basePlanId,
otherPlanId }` -> the edits ranked by how much of the outcome change each explains.

**"Is my withdrawal strategy tax-efficient?"** `optimise_tax_strategy { planId, objective:
"lifetimeTaxesReal" }` -> ranked strategies; preview the best one's ops with `preview_changes`.

**"Import my bank balances."** `preview_csv_import { householdId, kind: "account-balances", text }` ->
show the reconciliation (matched / unmatched accounts, before/after) -> `apply_csv_import` with the same
arguments after the user agrees.

**Monthly sync** (the `monthly_checkin` prompt): `list_accounts`, ask for balances, then
`update_account_balances { householdId, accounts: [{ accountId, balance }] }` (atomic; updates today's
automatic snapshot, so repeated syncs the same day leave one), `list_progress_snapshots`,
`get_plan_summary`.

## Troubleshooting

- _Client shows no write tools:_ the server flag is off (`GLIDEWORTH_MCP_ALLOW_WRITES`), or the key lacks
  `write`. Tool registration is decided per connection; reconnect after changing either.
- _`401` from `/mcp` in production:_ MCP needs an API key; the browser passphrase / session cookie is not
  accepted there. Create one with `pnpm keys:create`.
- _stdio server "fails to start" in Claude Desktop:_ use absolute paths, make sure the build exists
  (`pnpm build`) when using `dist/mcp/stdio.js`, and make sure nothing else writes to stdout (do not
  launch via `pnpm run`). Logs go to stderr.
- _Solver or Monte Carlo tool returns `{ jobId, status: "running" }`:_ it was not finished within `wait`
  seconds; call `get_job { jobId, wait: 60 }`. Use `trials` / `maxEvaluations` to make solvers faster.
- _`householdId is required here` / `planId is required here`:_ more than one household (or main plan)
  exists, so there is no default; call `list_households` / `list_plans` and pass the id.
- _`plans ... belong to different households`:_ compare, diff and explain plans of one household (a plan and
  its branch); different households have different people and accounts.
- _`NOT_IMPLEMENTED` errors:_ the plan uses an engine feature that has not landed yet; `details.workstream`
  names the owner. The tool wiring needs no change when it does.
- _`CHANGESET_CONFLICT`:_ someone (you, the web app, another agent) edited the plan after the proposal.
  Re-read with `get_plan_summary` and propose again.
- _`PATCH_CONFLICT`:_ an op's target does not exist (check ids with `get_plan`) or a `test` op failed.
