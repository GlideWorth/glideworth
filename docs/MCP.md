# Glideworth MCP server

Glideworth ships a [Model Context Protocol](https://modelcontextprotocol.io) server so AI assistants (Claude,
ChatGPT, Codex, Cursor, VS Code and others) can read your plans, run simulations and propose edits, **safely**.
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

Use absolute paths in every stdio config below. Do not launch a stdio server through `pnpm run`: pnpm prints a
banner to stdout, which is the protocol channel. Logs go to stderr.

## Client setup

Every client needs two things: the address of the MCP endpoint, and a credential (an API key, or an OAuth
sign-in that the client does for you).

|               | Hosted (Glideworth Cloud)                                                                        | Self-hosted                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| URL           | `https://app.glideworth.com/mcp`                                                                 | `http://localhost:8787/mcp` on the same machine; `https://<your domain>/mcp` behind a TLS proxy |
| API key       | **Settings**, then **API keys** in the app (starts `gwk_`)                                       | **Settings**, then **API keys**, or `create-key` (below); starts `glideworth_`                  |
| OAuth sign-in | Yes: add the URL with no key and sign in when the client asks                                    | Yes, over HTTPS with `GLIDEWORTH_PUBLIC_URL` set (or on `localhost`)                            |
| Write tools   | The workspace owner turns on "Allow AI assistants to make changes" (**Settings**, **Workspace**) | `GLIDEWORTH_MCP_ALLOW_WRITES=true` on the server, and a key with `write` scope                  |

On a Docker install, create a key with
`docker compose exec -T glideworth node dist/cli/create-key.js --name <client> --scopes read`; from a
checkout, `pnpm keys:create -- --name <client> --scopes read`. The examples below read the key from an
environment variable, `GLIDEWORTH_MCP_KEY`, so that it stays out of files you might share or commit. Swap the
hosted URL for yours when you self-host.

Assistants that run in the cloud (claude.ai, ChatGPT, and Claude Desktop's custom connectors) connect from
their provider's servers, so they can reach only an address that is public and served over HTTPS. A
`localhost` address works only with clients that run on your machine (Claude Code, Codex, Cursor, VS Code,
Claude Desktop's local servers).

**Check any client** by asking: _"Use Glideworth: call `list_households`, then `get_plan_summary`, and tell me
my main plan's name and whether it runs out of money."_ `list_households` succeeds (it returns `[]` before you
have entered anything); `get_plan_summary` returns `plan`, `finances` and `outcome` once a plan exists. With
the default read-only setup, the client lists 50 tools; with writes on and a `write` key, 69.

For an agent that should install and connect Glideworth end to end, see
[docs/agents/SETUP.md](./agents/SETUP.md). To teach an assistant how to use the tools well, install the
[Glideworth skill](../skills/glideworth/SKILL.md).

### Claude Code

The plugin (hosted service): it adds the server and the skill in one step, and you sign in with OAuth the first
time a tool runs.

```text
/plugin marketplace add GlideWorth/glideworth
/plugin install glideworth@glideworth
```

HTTP with a key (the server must be running). `--scope user` keeps it out of project files:

```bash
claude mcp add --scope user --transport http glideworth https://app.glideworth.com/mcp \
  --header "Authorization: Bearer $GLIDEWORTH_MCP_KEY"
claude mcp get glideworth      # Status: ✔ Connected
```

HTTP with OAuth: leave out `--header`, then run `/mcp` in a Claude Code session and choose to authenticate;
your browser opens Glideworth's consent screen.

stdio (nothing else needs to run; reads the SQLite file directly), after `pnpm build` in a checkout:

```bash
claude mcp add glideworth \
  -e GLIDEWORTH_DB_PATH=/abs/path/to/glideworth/apps/api/data/glideworth.db \
  -e GLIDEWORTH_MCP_ALLOW_WRITES=false \
  -- node /abs/path/to/glideworth/apps/api/dist/mcp/stdio.js
```

Without a build, run the source through tsx instead:
`-- /abs/path/to/glideworth/apps/api/node_modules/.bin/tsx --conditions=@glideworth/source /abs/path/to/glideworth/apps/api/src/mcp/stdio.ts`.
Set `GLIDEWORTH_MCP_ALLOW_WRITES=true` only when you want the agent to be able to propose and apply change sets.

Project-scoped config (`.mcp.json`; Claude Code expands `${GLIDEWORTH_MCP_KEY}` from your environment, and asks
you to approve a project server the first time):

```json
{
  "mcpServers": {
    "glideworth": {
      "type": "http",
      "url": "https://app.glideworth.com/mcp",
      "headers": { "Authorization": "Bearer ${GLIDEWORTH_MCP_KEY}" }
    }
  }
}
```

Add the skill: copy [`skills/glideworth/SKILL.md`](../skills/glideworth/SKILL.md) to
`~/.claude/skills/glideworth/SKILL.md` (every project) or `.claude/skills/glideworth/SKILL.md` (one project).

### Claude Desktop

**Custom connector** (hosted, or a self-hosted server with a public HTTPS address): add it the same way as on
claude.ai, below. Claude brokers it through your account, so it is not reachable on `localhost`.

**Local server**: edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows:
`%APPDATA%\Claude\`) and restart the app.

stdio from a checkout (reads the SQLite file directly; nothing else running):

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

HTTP through the `mcp-remote` bridge, for a running server that the connector cannot reach:

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

### claude.ai (custom connector)

These steps follow Anthropic's help page
([custom connectors](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp),
read 2026-11-23); we have not tested every plan, and menu names change.

1. **Customize**, then **Connectors**, then **+ Add**, then **Add custom connector**. (On Team and Enterprise
   plans an owner adds it under **Organization settings**, **Connectors**, and members then connect it.)
2. Name it `Glideworth` and enter the URL: `https://app.glideworth.com/mcp`, or your own `https://` address.
3. Authentication: choose to sign in (OAuth), and let Claude register itself. Glideworth's consent screen
   opens; sign in, pick what to grant, approve. Alternatively, add a request header
   `Authorization: Bearer <key>`; on a shared Team connector everyone then uses that one key's access.
4. In a chat, enable the connector and ask the check question above.

The server must be reachable from the public internet on port 443. Free plans allow one custom connector.

### ChatGPT

OpenAI's help pages
([developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta),
[adding a custom MCP server](https://developers.openai.com/api/docs/guides/developer-mode), read 2026-11-23)
describe the steps below. We have not verified them in ChatGPT itself, and they change often: treat the menu
names as a guide.

1. Open **Plugins** (chatgpt.com/plugins), select **+**, then **Add custom MCP server**. Older accounts reach
   the same form through **Settings**, **Apps & Connectors**, with developer mode on.
2. Enter a name and, under **Connection**, the server URL: `https://app.glideworth.com/mcp` (or your own
   public `https://` address).
3. Authentication: **OAuth**. ChatGPT registers itself and sends you to Glideworth's consent screen. The pages
   describe OAuth or no authentication, not a fixed API key, so use OAuth.
4. Accept the warning and create it, then enable it in a chat and ask the check question above.

According to those pages, full MCP support (including write tools) is for Business and Enterprise/Edu
workspaces, and Pro accounts can connect custom servers for reading only. ChatGPT asks for confirmation before
it calls a tool that is not marked read-only; every Glideworth write tool is in that group.

### Codex CLI

With a key (Codex reads it from the environment variable you name; verified with Codex CLI 0.167):

```bash
codex mcp add glideworth --url https://app.glideworth.com/mcp --bearer-token-env-var GLIDEWORTH_MCP_KEY
codex mcp list
```

That writes this to `~/.codex/config.toml`, which you can also edit by hand:

```toml
[mcp_servers.glideworth]
url = "https://app.glideworth.com/mcp"
bearer_token_env_var = "GLIDEWORTH_MCP_KEY"
```

With OAuth instead: `codex mcp add glideworth --url https://app.glideworth.com/mcp`, then
`codex mcp login glideworth`.

### Cursor

Add Glideworth to `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for every project. Cursor expands
`${env:NAME}` in `url` and `headers`:

```json
{
  "mcpServers": {
    "glideworth": {
      "url": "https://app.glideworth.com/mcp",
      "headers": { "Authorization": "Bearer ${env:GLIDEWORTH_MCP_KEY}" }
    }
  }
}
```

For OAuth, leave out `headers`: Cursor discovers Glideworth's authorization server, registers itself and asks
you to sign in.

**Add to Cursor** link (hosted, OAuth; it carries no key). Open it in a browser on a machine with Cursor:

```
cursor://anysphere.cursor-deeplink/mcp/install?name=glideworth&config=eyJ1cmwiOiJodHRwczovL2FwcC5nbGlkZXdvcnRoLmNvbS9tY3AifQ%3D%3D
```

The `config` value is the base64 of `{"url":"https://app.glideworth.com/mcp"}`
([Cursor's install links](https://cursor.com/docs/mcp/install-links)). Cursor documents these links with a
local-server example; we have not tested this remote one in Cursor, so if it does nothing, use the JSON above.
Never put an API key in a link: base64 is not encryption.

### VS Code

VS Code's editor-managed format, `.vscode/mcp.json` in the workspace, uses `servers` and asks for the key
once:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "glideworth-key",
      "description": "Glideworth API key",
      "password": true
    }
  ],
  "servers": {
    "glideworth": {
      "type": "http",
      "url": "https://app.glideworth.com/mcp",
      "headers": { "Authorization": "Bearer ${input:glideworth-key}" }
    }
  }
}
```

For OAuth, leave out `headers` and `inputs`; VS Code asks you to sign in. VS Code's
[MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) (read
2026-11-23) now calls `.vscode/mcp.json` a deprecated format for new Copilot set-ups, which use `.mcp.json` at
the workspace root with `mcpServers` (the same shape as Claude Code's above, `${NAME}` for environment
variables), and says that harness cannot pass a prompted secret into a header. We have not tested either file
in VS Code: if the key form does not connect, use OAuth or the environment-variable form.

### Any other client (generic)

- **HTTP:** URL `https://app.glideworth.com/mcp` (or your own), header `Authorization: Bearer <key>`, or OAuth
  discovery from the `401` (below).
- **stdio:** `node /abs/path/to/glideworth/apps/api/dist/mcp/stdio.js` with `GLIDEWORTH_DB_PATH` set (a checkout
  after `pnpm build`), or `docker exec -i glideworth node dist/mcp/stdio.js` for a Docker install. Set
  `GLIDEWORTH_MCP_ALLOW_WRITES` in that process's environment.
- **An HTTP-only server for a stdio-only client:** the `mcp-remote` bridge, as under Claude Desktop.
- **Try it without a client:** `npx @modelcontextprotocol/inspector`, and point it at either transport.

## Remote clients: OAuth (no pasted key)

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

69 tools: 50 read/compute tools and 19 write-scope tools (only with writes enabled and a `write` key; never for a `viewer`). Every tool carries a `title` and accurate annotations: the 50 read/compute tools and `list_share_links` (write scope, because share links are sensitive, but it only reads) are `readOnlyHint`; `destructiveHint` is true for every tool that overwrites or removes existing state (applying a change set or an import, setting balances, FX rates or the check-in schedule, discarding or cancelling, revoking a link, marking notifications read), even where the plan history can undo it; `openWorldHint` is true only for `create_share_link`, which publishes plan results at a public URL. The hosted service (cloud mode) has the same tools; there, writes are enabled per workspace by its owner (workspace settings, `mcpWrites`) instead of `GLIDEWORTH_MCP_ALLOW_WRITES`, credentials are `gwk_…` API keys or `gwa_…` OAuth tokens of one workspace, the OAuth consent page signs you in with your Glideworth account and asks which workspace to connect, and a read-only workspace (trial ended, payment lapsed) offers no write tools while job tools answer `ACCOUNT_READ_ONLY` with the billing link. The server instructions the client receives (about 2 KB) point agents at the right tool for the common questions.

Money in outputs is in today's money unless a `basis` argument says otherwise. Ids are always the
ones returned by the list tools; pass them back verbatim.

### Read (key scope `read`)

| Tool                                 | What it does                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_households`                    | households: id, people, currency, location                                                                                                                                                                                           |
| `get_household`                      | accounts, real assets, debts and totals (`detail: full` = raw documents)                                                                                                                                                             |
| `list_accounts`                      | account id, name, type, owner, balance                                                                                                                                                                                               |
| `list_plans`                         | plans: id, name, **version**, isMain, status, parent (if a branch), in the user's display order                                                                                                                                      |
| `get_plan`                           | compact plan (milestones, income, expenses, flows with ids, amounts like `5200 real/monthly`, date ranges) or `detail: full`                                                                                                         |
| `list_plan_versions`                 | edit history: version, time, actor, message                                                                                                                                                                                          |
| `diff_plans`                         | readable differences between two plans                                                                                                                                                                                               |
| `list_progress_snapshots`            | recorded actuals over time                                                                                                                                                                                                           |
| `list_change_sets`, `get_change_set` | proposals and their previews                                                                                                                                                                                                         |
| `export_table`                       | a projection table (`year-by-year`, `cash-flow`, `taxes`, `account-balances`) as thinned rows or CSV text                                                                                                                            |
| `export_report`                      | the printable report as data: key figures, milestones, assumptions, finances, caveats, thinned series                                                                                                                                |
| `list_fx_rates`                      | FX pairs the household uses for foreign-currency accounts, assets and debts                                                                                                                                                          |
| `cross_border_rules`                 | the rule tables: `kind` = `countries`, `non-resident` (a country's rules for non-residents), `treaty` (a pair, both directions), `wrappers` (foreign-wrapper recognition), `simplifications`                                         |
| `get_plan_health_history`            | the plan's check-in time series: success rate, FI year, net worth vs plan, open findings                                                                                                                                             |
| `list_notifications`                 | notifications raised by check-ins (unread by default)                                                                                                                                                                                |
| `get_checkin_schedule`               | cadence, thresholds, last/next run                                                                                                                                                                                                   |
| `what_changed_since_checkin`         | **what changed since my last check-in**: material changes, edits since and by whom, net worth moved; read-only (`run_checkin` takes a new check-in)                                                                                  |
| `preview_csv_import`                 | **dry run** of a CSV import (balances / progress history / transactions): detected columns, issues, before/after reconciliation. Writes nothing                                                                                      |
| `preview_balance_history_import`     | **dry run** of a balance-history import (pasted cells, CSV/TSV or mapped rows): how the file was read, column matches with confidence, flagged cells by reference, added/updated/removed counts for merge or replace. Writes nothing |

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
| `tax_by_country`                                                                                                                               | lifetime and per-year tax by country and basis (residence, source, citizenship, relief) with the simplifications that apply                                                                                                                                                                                                                         |
| `explain_item_taxation`                                                                                                                        | how one account, property, debt or income is taxed in a year and why: non-resident rule, treaty article, wrapper recognition, relief, warnings                                                                                                                                                                                                      |
| `strategy_matrix`                                                                                                                              | strategies x metrics (lifetime tax, net legacy, chance of success, final net worth) with scores; a job                                                                                                                                                                                                                                              |
| `income_by_tax_rate`                                                                                                                           | income taxed at each marginal rate per year                                                                                                                                                                                                                                                                                                         |
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
| `apply_csv_import`                      | apply a CSV import atomically (run `preview_csv_import` first and show the reconciliation)                                                                                                                                                |
| `apply_balance_history_import`          | write a balance-history import atomically (same arguments; run the preview first). Repeating it changes nothing                                                                                                                           |
| `update_account_balances`               | set many balances at once (all-or-nothing): accounts, real-asset values, **mortgage/loan balances** (`realAssets[].loanBalance`, or the asset id in `debts`) and debts; updates today's automatic progress snapshot (at most one per day) |
| `record_progress_snapshot`              | snapshot today's net worth from current balances                                                                                                                                                                                          |
| `cancel_job`                            | cancel a running job (returns once it has actually stopped)                                                                                                                                                                               |
| `run_checkin`                           | check in on a plan now (projection + Monte Carlo + audit) and store it in the health history; returns the material changes                                                                                                                |
| `mark_notifications_read`               | mark notifications read (`ids` or `all`)                                                                                                                                                                                                  |
| `set_checkin_schedule`                  | enable/disable, cadence, change thresholds                                                                                                                                                                                                |
| `create_share_link`                     | expiring, revocable read-only link to a plan's results (`privacy`: full / percent / hidden); the token is returned once                                                                                                                   |
| `list_share_links`, `revoke_share_link` | links and their status; stop one                                                                                                                                                                                                          |
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

## Interactive views (ChatGPT and Claude)

Hosts that support MCP Apps (ChatGPT, Claude) show some results as an interactive view instead of only text:

| View            | Tools                                                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Will it last?   | `run_monte_carlo` (a fan of outcomes; a pending view while it runs, finished by `get_job`), `simulate_plan`                                                                             |
| What changes?   | `preview_whatif` (with steppers for the template's numbers), `preview_changes`, `compare_plans`                                                                                         |
| Solver answer   | `solve_max_spending`, `solve_retirement_date`, `solve_required_savings`, `solve_required_portfolio`, `solve_safe_withdrawal_rate` (a pending view while it runs, finished by `get_job`) |
| Review a change | `propose_change_set`, `propose_revert` (Apply and Discard appear only on a connection with writes)                                                                                      |
| One year        | `explain_year`                                                                                                                                                                          |
| Tax over time   | `tax_breakdown`                                                                                                                                                                         |

These tools name the view's template, `ui://glideworth/app-<hash>.html` (`text/html;profile=mcp-app`), in their
`_meta`. The view's data arrives in the tool result's `_meta["glideworth/widget"]`, which the host passes to the
view and not to the model: the text the model reads is the same compact JSON as in any other client, and its numbers
are the view's numbers. The view fetches nothing itself, so its content security policy lists no domains. It links
into the web app when the server knows its public URL (`GLIDEWORTH_PUBLIC_URL`). Self-hosted servers serve the same
views.

## Assets in another country

The household lives in one country (its location) for the whole plan; Glideworth does not model moving
country. Accounts, property, debts and income can be in another country. "How is my UK flat taxed while we
live in Spain?" → `explain_item_taxation`. "What do we pay where?" → `tax_by_country`. "Is there a treaty?"
→ `cross_border_rules kind=treaty`. Residence status is what the household says: Glideworth applies no
statutory residence test; say so when you answer. A person's citizenships and US green card are set through
the REST person endpoints (`PUT/PATCH /api/v1/households/{id}/people/{personId}`); no tool sets them.

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

**"Here is my net-worth spreadsheet."** `preview_balance_history_import { text }` (a Date column and one column per
account, or dates across) -> show `parse.columns` (which column went to which account), the flagged cells and the
counts; if the dates are ambiguous, ask the user and pass `options.dateFormat` -> `apply_balance_history_import`
with the same arguments after the user agrees.

**Monthly sync** (the `monthly_checkin` prompt): `list_accounts`, ask for balances, then
`update_account_balances { householdId, accounts: [{ accountId, balance }] }` (atomic; updates today's
automatic snapshot, so repeated syncs the same day leave one), `list_progress_snapshots`,
`get_plan_summary`.

## Troubleshooting

| What you see                                           | Cause                                                                                                                                                     | Fix                                                                                                                                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` from `/mcp`                                      | No credential, a wrong or revoked key, or an expired token. The browser sign-in cookie is not accepted                                                    | Send `Authorization: Bearer <key>`, or let the client sign in with OAuth (the `401` carries `WWW-Authenticate` with the metadata URL). Create a new key if unsure                     |
| `403`, `API key lacks the 'read' scope`                | The key's scopes do not cover what was asked (a `simulate` key has no data tools)                                                                         | Create a key with the scope you need: `read` for analysis, `read,write` for edits                                                                                                     |
| Client shows no write tools                            | Writes are off on the server (`GLIDEWORTH_MCP_ALLOW_WRITES`, or the hosted workspace setting), or the key lacks `write`, or the person's role is `viewer` | Turn on both, then reconnect: tools are decided per connection                                                                                                                        |
| `405` on `GET /mcp`                                    | Normal. The server is stateless and answers only `POST`                                                                                                   | Nothing to fix; clients then only `POST`                                                                                                                                              |
| Works on `localhost`, fails through the domain         | The reverse proxy buffers responses, times out long calls, or does not forward the scheme                                                                 | nginx: `proxy_buffering off; proxy_read_timeout 300s;` and `X-Forwarded-Proto`; set `GLIDEWORTH_TRUST_PROXY=true` ([SELF-HOSTING.md](./SELF-HOSTING.md#https-behind-a-reverse-proxy)) |
| OAuth sign-in fails or redirects to the wrong address  | `GLIDEWORTH_PUBLIC_URL` is missing or wrong, or the address is plain `http` on a non-`localhost` host                                                     | Set `GLIDEWORTH_PUBLIC_URL` to the exact `https://` address and restart                                                                                                               |
| claude.ai or ChatGPT cannot reach a self-hosted server | They connect from their own servers                                                                                                                       | Give Glideworth a public `https://` address (reverse proxy), or use a local client                                                                                                    |
| stdio server "fails to start" in Claude Desktop        | Relative paths, no build, or something writing to stdout                                                                                                  | Use absolute paths, run `pnpm build` for `dist/mcp/stdio.js`, do not launch via `pnpm run`. Logs go to stderr                                                                         |
| A tool returns `{ jobId, status: "running" }`          | It did not finish within `wait` seconds                                                                                                                   | Call `get_job { jobId, wait: 60 }`; lower `trials` / `maxEvaluations` for faster solvers                                                                                              |
| `planId is required here`                              | No plan exists yet ("0 plans exist"), or several households or main plans exist                                                                           | Create a plan in the app; otherwise call `list_households` / `list_plans` and pass the id                                                                                             |
| `plans ... belong to different households`             | Compare, diff and explain work within one household                                                                                                       | Use a plan and its branch                                                                                                                                                             |
| `NOT_IMPLEMENTED`                                      | The plan uses an engine feature that has not landed yet; `details.workstream` names it                                                                    | Skip that analysis or remove the feature                                                                                                                                              |
| `CHANGESET_CONFLICT`                                   | Someone (you, the web app, another agent) edited the plan after the proposal                                                                              | Re-read with `get_plan_summary` and propose again                                                                                                                                     |
| `PATCH_CONFLICT`                                       | An op's target does not exist (check ids with `get_plan`), or a `test` op failed                                                                          | Address list items by id, never by index                                                                                                                                              |
