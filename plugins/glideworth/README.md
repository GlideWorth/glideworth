# Glideworth plugin for Claude Code

Glideworth is a retirement and financial planner. It plays out a household's finances year by year, tax
included, and across thousands of simulated markets. This plugin connects Claude Code to your Glideworth plan, so
you can ask "when can I retire?", "how much can I spend?", "why would my plan fail?" or "what if I retire three
years earlier?" and get answers from your own plan.

## What it adds

- **The Glideworth MCP server** at `https://app.glideworth.com/mcp`. You sign in with your Glideworth account
  (OAuth) the first time a tool runs; no API key is stored in the plugin.
- **The Glideworth skill**, which teaches Claude to start from a plan summary, explain results in plain
  language, and never change a plan without your clear yes.

## Safety

- **Read-only by default.** Write tools only exist when you grant the `write` scope on the consent screen and the
  workspace allows AI assistants to make changes. If you own the workspace, granting `write` turns that on; the
  consent screen says so.
- **No silent edits.** Plan changes are proposed as change sets with a diff and a before/after outcome, and
  applied only after you agree. Every applied change is in the plan history.
- **No money movement.** Glideworth does not link to banks, move money or place trades.
- **Estimates, not advice.** Projections and tax figures are estimates from stated assumptions.

## Install

```text
/plugin marketplace add GlideWorth/glideworth
/plugin install glideworth@glideworth
```

## Self-hosted servers

Running Glideworth yourself? Skip the plugin's server and add your own URL instead, as described in the
[MCP setup guide](https://glideworth.com/docs/api-and-mcp/mcp-setup/). The skill works the same either way.

## Privacy and support

- Privacy policy: <https://glideworth.com/legal/privacy/> (section 9 covers AI assistants you connect)
- Terms: <https://glideworth.com/legal/terms/>
- Support: <https://glideworth.com/contact/> or support@glideworth.com

The skill in `skills/glideworth/SKILL.md` is a copy of the repository's `skills/glideworth/SKILL.md`; a test keeps
them identical.
