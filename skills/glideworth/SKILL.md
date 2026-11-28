---
name: glideworth
description: Use Glideworth, an open-source retirement and financial planner, through its MCP server or REST API. Use when the user asks about their Glideworth plan or their retirement plan and Glideworth tools (such as get_plan_summary) or a Glideworth API key are available - chance of success, how much they can spend, when they can retire, taxes, what-ifs, updating balances - and whenever you propose a change to their plan. To install Glideworth or connect it to an assistant, follow the setup guide instead (docs/agents/SETUP.md in the repository).
---

# Using Glideworth

Glideworth plays out a household's finances year by year, tax included, and across thousands of simulated
markets. It answers "when can I retire", "how much can I spend", "will my money last" and "why would my plan
fail". You reach it through its MCP server (tools such as `get_plan_summary`) or its REST API. Everything here
works the same on the hosted service and on a self-hosted server.

If you need to install Glideworth or connect it to an assistant, stop and follow the setup guide:
<https://raw.githubusercontent.com/GlideWorth/glideworth/main/docs/agents/SETUP.md>.

## Rules

1. **Never change a plan without the user's clear yes.** Preview, propose, show the diff and the before and
   after, wait for approval, then apply. Details under [Changing a plan](#changing-a-plan).
2. **Results are estimates, not advice.** Say so when you report a figure someone may act on. Tax figures are
   estimates from stated tax-year tables, and each country lists what its model leaves out.
3. **Plan data is private.** Do not paste balances, names or results into web searches, other tools or files
   the user did not ask for. Quote only what the answer needs.
4. **Never ask for bank logins or bank credentials.** Glideworth does not link to banks and never needs them.
   Balances are typed in, imported from a CSV file or updated through the tools.
5. **Respect the owner's write setting.** When write tools are missing, writes are switched off on purpose.
   Tell the user how to turn them on (below); do not work around it with the REST API or a different key.
6. **Keep keys secret.** Do not print an API key back to the user, write it into a file that could be
   committed, or put it in a URL.

## Start here

Call `get_plan_summary` first. One call returns the plan (milestones, income, expenses, flows, each with its
id), the household's finances today (accounts, net worth) and the deterministic outcome (`success`,
`depletionYear`, `endNetWorthReal`, `retirementYear`, milestone dates and a five-yearly table). `planId`
defaults to the main plan and `householdId` to the only household.

- Copy ids exactly as tools return them (`list_households`, `list_plans`, `list_accounts`, `get_plan`).
- `planId is required here` with "0 plans exist" means the household has no plan yet. Ask the user to create
  one in the web app (or import one there) before you analyse anything. With several households or main plans,
  call `list_households` or `list_plans` and pass the id.
- Errors come back as `{ "error": { "code", "message", "hint" } }`. Follow the `hint`.

## Units

| What        | How it is written                                                                           |
| ----------- | ------------------------------------------------------------------------------------------- |
| Money       | A plain number in major units of the household currency: `1234.56`, not cents               |
| Rates       | Fractions: `0.07` is 7% a year                                                              |
| Basis       | `real` is today's money, `nominal` is future money. Outputs are in today's money by default |
| Frequencies | "20k a month" is `20000` with frequency `monthly`                                           |
| Dates       | `YYYY-MM` or `YYYY-MM-DD`                                                                   |

Report money in today's money unless the user asks otherwise, and say so.

## Which tool answers which question

| The user asks                                                                   | Call                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Summarise my finances and plan"                                                | `get_plan_summary`; `get_household` for account detail                                                                                                |
| "What is my chance of success? Why does it fail?"                               | `run_monte_carlo` (read `headline` and `failureAnalysis`), then `explain_year` on the first failing year                                              |
| "How much can I spend?"                                                         | `solve_max_spending` with a `targetSuccessRate` such as `0.9`                                                                                         |
| "When can I retire?"                                                            | `solve_retirement_date`                                                                                                                               |
| "How much do I need to save?"                                                   | `solve_required_savings`, `solve_required_portfolio`                                                                                                  |
| "What withdrawal rate is safe?"                                                 | `solve_safe_withdrawal_rate`; guardrails with `evaluate_guardrails` or `guyton_klinger`                                                               |
| "What if I retire three years earlier?"                                         | `preview_whatif` with template `early-retirement`, then `compare_plans`                                                                               |
| "What if markets crash the year I retire?"                                      | `list_whatif_templates`, then `preview_whatif`                                                                                                        |
| "What if one of us dies early?"                                                 | `survivor_scenarios`                                                                                                                                  |
| "Where did the money go in 2041?"                                               | `explain_year`; a range with `explain_years`                                                                                                          |
| "Why did the plan end up here?"                                                 | `explain_projection`; `sensitivity` for the assumptions that matter most                                                                              |
| "What is wrong with my assumptions?"                                            | `audit_plan`; preview a finding's fix with `preview_changes`                                                                                          |
| "How much tax will I pay? How do I pay less?"                                   | `tax_breakdown`, `income_by_tax_rate`, `optimise_tax_strategy`, `strategy_matrix`                                                                     |
| "Should I convert to Roth? How much each year?"                                 | `plan_roth_conversions` (US; omit `targets` to let it choose), then `propose_change_set` with its `patch` if the user agrees                          |
| "How is my flat abroad taxed?"                                                  | `explain_item_taxation`, `tax_by_country`, `cross_border_rules`                                                                                       |
| "Why do these two plans differ?"                                                | `explain_difference`, `diff_plans`, `compare_plans`                                                                                                   |
| "What changed since my last check-in?"                                          | `what_changed_since_checkin`, `get_plan_health_history`, `list_notifications`                                                                         |
| "Why did my chance of success change?"                                          | `explain_result_change` (splits the movement by cause; read-only)                                                                                     |
| "Give me the year-by-year table"                                                | `export_table`; report data with `export_report`                                                                                                      |
| "Update my balances"                                                            | `list_accounts`, then `update_account_balances` (a write tool)                                                                                        |
| "I opened an ISA / sold the car / my rate changed"                              | `preview_household_change`, then `apply_household_change` with its `householdVersion` (a write tool)                                                  |
| "Overpay the mortgage or invest? Which savings changes let me retire earliest?" | `optimise_plan` with the flows as levers (`toggle`, `scale`, `redirect`), then `preview_changes` with `best.ops`                                      |
| "Copy, rename, archive this plan; make it the main one"                         | `duplicate_plan`, `rename_plan`, `set_plan_archived`, `set_main_plan` (write tools)                                                                   |
| "Import this CSV or spreadsheet"                                                | `preview_csv_import`, then `apply_csv_import`; balance history per account with `preview_balance_history_import`, then `apply_balance_history_import` |
| "Which exchange rates does the plan use?"                                       | `list_fx_rates`; change one with `set_fx_rate` (a write tool)                                                                                         |
| "Share my results with my partner"                                              | `create_share_link` (a write tool): an expiring, read-only link                                                                                       |

The deterministic projection itself is `simulate_plan`. Monte Carlo uses a fixed default seed, so repeated
runs agree and are cached.

**Long jobs.** Monte Carlo, the solvers, `optimise_plan`, guardrails, tax strategy and sensitivity wait up to `wait` seconds
(default 30). If the result is not ready they return a `jobId`; call `get_job` with that id and `wait: 60`.
Fewer `trials` make a run faster and noisier.

**Output size.** Tools return compact JSON. Pass `detail: "full"` only when you need everything.

## Changing a plan

Plan edits are never overwrites. They are RFC 6902 operations, checked against the plan version they were
written for.

1. **Try it without storing anything:** `preview_changes` with the operations. It returns the readable
   changes and the outcome before and after.
2. **Propose it:** `propose_change_set` with the same operations and the `baseVersion` you read. Nothing is
   applied yet.
3. **Show the user** the readable changes and the before and after, in plain words and today's money, and ask
   whether to apply it. Wait for a clear yes.
4. **Apply only after that yes:** `apply_change_set`. If it answers `CHANGESET_CONFLICT`, the plan changed in
   the meantime: call `get_plan_summary` again, propose again and ask again. Use `discard_change_set` if the
   user says no.

For a what-if the user wants to keep alongside the main plan, create a branch instead
(`create_branch`, or `create_branch_from_template` after `preview_whatif`); the main plan is untouched. Undo
is a proposal too: `list_plan_versions`, then `propose_revert`.

Address list items by id, never by position:

```json
[{ "op": "replace", "path": "/expenses/[id=exp-living]/amount/value", "value": 5700 }]
```

An operation whose target does not exist is `PATCH_CONFLICT`; check ids with `get_plan`. The resource
`glideworth://docs/edit-paths` lists the common edits, ready to adapt.

Household data is different: `update_account_balances`, `record_progress_snapshot` and `apply_csv_import`
write directly, because they record what happened rather than assumptions. Read the figures back to the user
and get their confirmation before you call them. Other household edits (a new account, a property sold, a new
mortgage rate, a partner) go through `preview_household_change`, which stores nothing and lists each change
with the main plan before and after; after the user agrees, `apply_household_change` with the same operations
and the `householdVersion` the preview returned. Something a plan still uses cannot be removed: archive it
(`update` with `{"archived": true}`) or change the plan first.

`optimise_plan` only searches the levers you give it, with the deterministic projection (no Monte Carlo):
say so when you report its answer, and check the chance of success of the result with `run_monte_carlo` on a
branch before the user acts on it.

**Write tools are missing?** They exist only when writes are on and the key or connection has the `write`
scope. On a self-hosted server the owner sets `GLIDEWORTH_MCP_ALLOW_WRITES=true` and uses a key with `write`;
on the hosted service the workspace owner turns on "Allow AI assistants to make changes" under Settings, then
Workspace. The client must reconnect afterwards. Without writes you can still preview everything.

## Reporting results

- Lead with the answer in one sentence, then the two or three numbers behind it.
- Say which plan you used, that money is in today's money, and the target success rate where one applies.
- A chance of success is the share of simulated market histories in which the plan paid for every year. It is
  a stress test, not a forecast.
- For tax, say it is an estimate and mention what the country's model leaves out when it matters.
- Do not tell the user what they should do with their money. Show the trade-off and let them decide.

## REST API instead of MCP

Every MCP tool has a REST twin. Send `Authorization: Bearer <key>` to the same origin:

| Task                     | Request                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| Who am I, which scopes   | `GET /api/v1/me`                                                                                          |
| Households and plans     | `GET /api/v1/households`, `GET /api/v1/plans`, `GET /api/v1/plans/{id}`                                   |
| Deterministic projection | `POST /api/v1/plans/{id}/simulate`                                                                        |
| Chance of success        | `POST /api/v1/plans/{id}/monte-carlo?wait=60`, then `GET /api/v1/jobs/{id}/result`                        |
| What-if, storing nothing | `POST /api/v1/plans/{id}/preview`                                                                         |
| Propose, then apply      | `POST /api/v1/plans/{id}/change-sets`, then (after the user agrees) `POST /api/v1/change-sets/{id}/apply` |

The full list is the OpenAPI document at `/openapi.json` on the same origin (hosted:
<https://app.glideworth.com/openapi.json>). Send an `Idempotency-Key` header on writes so that a retry is
safe, and `If-Match` with the version you read on direct edits; see
<https://glideworth.com/docs/api-and-mcp/api-overview/>.

## More

- MCP setup for each client: <https://glideworth.com/docs/api-and-mcp/mcp-setup/>
- Every tool: <https://glideworth.com/docs/api-and-mcp/mcp-tools/>
- Worked examples: <https://glideworth.com/docs/api-and-mcp/mcp-examples/>
