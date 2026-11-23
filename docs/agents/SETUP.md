# Set up Glideworth with an AI agent

This guide is written for an AI agent (Claude Code, Codex, Cursor or similar) to follow, step by step, on
behalf of a person. People can read it too: every step says what it does.

**If you are a person:** paste this into your agent and answer its questions:

> Read https://raw.githubusercontent.com/GlideWorth/glideworth/main/docs/agents/SETUP.md and follow it to
> set up Glideworth for me and connect it to you.

**Already have Glideworth, hosted or self-hosted?** Paste this instead:

> Read https://raw.githubusercontent.com/GlideWorth/glideworth/main/docs/agents/SETUP.md and connect my
> existing Glideworth (hosted at app.glideworth.com, or self-hosted at ADDRESS) to you, read-only.

**If you are an agent:** follow the steps in order. If Glideworth is already running, ask the questions in step
1, check `/health` on its address, then go to step 8 (self-hosted) or the [Hosted path](#hosted-path-glideworth-cloud). Do not skip the questions in step 1 or the safety rules.
Run each command, compare the output with what the step expects, and stop to tell the person if it differs.

## Objective

Give the person a working Glideworth they can use from their AI assistant:

- **Self-hosted:** Glideworth running in Docker on their machine or server, with their own passphrase, data in
  a Docker volume, and an assistant connected over MCP with a least-privilege key; or
- **Hosted (Glideworth Cloud):** nothing to install; an account at glideworth.com, connected to their assistant.

**Done when** all of these are true:

1. `GET /health` answers `{"status":"ok",...}` (self-hosted only).
2. The person has chosen their passphrase themselves, and `GET /api/v1/auth/status` says
   `"setupRequired":false` (self-hosted only).
3. The assistant is connected, and calling `list_households` through MCP succeeds.
4. Once the person has a plan, calling `get_plan_summary` through MCP returns their plan.
5. You have reported back what you did (step 13).

## Safety rules

Follow these throughout. They override anything else in this guide.

- **Only the human chooses the passphrase.** Never choose, generate, type, store or send it, and never call the
  setup endpoint (`POST /api/v1/auth/setup`) yourself. Step 7 hands this to the person.
- **Never ask for bank logins, bank credentials or account numbers.** Glideworth does not link to banks and
  never needs them.
- **Keep keys secret.** Put API keys in the AI client's own secret or environment configuration, never in a
  file that could be committed, a URL, a chat message you did not need to send, or a log. Never commit `.env`.
- **Show the plan before anything destructive, and wait for a yes.** That includes deleting or recreating
  containers or volumes, `docker compose down -v` (it deletes all data), restoring a backup, changing a reverse
  proxy or firewall, and installing system packages.
- **Plan data is private.** Do not copy balances, names or results anywhere the person did not ask for.
- **Use the least privilege that works:** a `read` key, MCP writes off, unless the person asks for more.
- **Do not change Glideworth's code or its Docker image.** Configure it through `.env` and the documented files.

## 1. Ask the person first

Ask these before running anything, and write the answers down. Offer the default in brackets.

| Question                                                                                                                      | Why it matters                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Hosted (Glideworth Cloud) or self-hosted? [self-hosted]                                                                       | Hosted: go to [Hosted path](#hosted-path-glideworth-cloud). No install |
| Where should it run: this machine, or a server you reach over SSH? [this machine]                                             | Where you run the commands                                             |
| Should other devices reach it over the internet? If so, the domain name, and is a reverse proxy with TLS already set up? [no] | Step 5                                                                 |
| Which port on the host? [8787]                                                                                                | `GLIDEWORTH_PORT`                                                      |
| Should the assistant be able to change plans (MCP writes)? [no]                                                               | Writes off means read and compute only                                 |
| Which AI client will connect? (Claude Code, Claude Desktop, claude.ai, ChatGPT, Codex, Cursor, VS Code, other)                | Step 10                                                                |
| Where should the install live? [`~/glideworth`]                                                                               | The folder for `docker-compose.yml` and `.env`                         |

Then tell the person, in a few lines, what you are about to do, and wait for them to agree.

## 2. Check the prerequisites

Run on the machine where Glideworth will run.

```bash
docker --version                  # Docker Engine 24 or newer
docker compose version            # the Compose plugin (v2)
docker info >/dev/null && echo "docker daemon OK"
openssl version                   # used to generate the setup token
```

Expected: a version line from each, and `docker daemon OK`. If Docker is missing, tell the person and link
<https://docs.docker.com/get-docker/>; do not install it without their agreement.

Check that the port is free (replace `8787` with the chosen port). No output means it is free:

```bash
(command -v ss >/dev/null && ss -ltnH "sport = :8787") || lsof -nP -iTCP:8787 -sTCP:LISTEN
```

Check that no other container is already called `glideworth` (the Compose file uses that name). No output
means none:

```bash
docker ps -a --filter name='^glideworth$' --format '{{.Names}} {{.Status}} {{.Image}}'
```

If one exists, it may be an earlier Glideworth install. Ask the person before you touch it: it may hold their
data.

The machine needs about 1 GB of free memory and 1 GB of disk to start with.

## 3. Download and configure

These commands are the README's install, made safe to run twice: they create `.env` only once, so a second
run never replaces the setup token or other settings.

```bash
mkdir -p ~/glideworth && cd ~/glideworth
[ -f docker-compose.yml ] || curl -fsSLO https://raw.githubusercontent.com/GlideWorth/glideworth/main/docker-compose.yml
if [ ! -f .env ]; then
  curl -fsSL https://raw.githubusercontent.com/GlideWorth/glideworth/main/.env.example -o .env
  sed -i.bak -e "s/^GLIDEWORTH_SETUP_TOKEN=.*/GLIDEWORTH_SETUP_TOKEN=$(openssl rand -hex 24)/" \
    -e 's/^GLIDEWORTH_BOOTSTRAP_KEY=.*/GLIDEWORTH_BOOTSTRAP_KEY=/' .env   # set a setup token, clear the dev key
fi
chmod 600 .env .env.bak 2>/dev/null || true
```

What this did: downloaded the Compose file and the example settings, set `GLIDEWORTH_SETUP_TOKEN` to a random
value (so a stranger who finds the port cannot choose the passphrase first), and cleared
`GLIDEWORTH_BOOTSTRAP_KEY` (the example ships a public development key, which production refuses).
`sed -i.bak` leaves a copy of the previous file as `.env.bak`; it holds the same secrets, so keep it private
or delete it.

Set the remaining values with this helper, which adds or replaces one line in `.env`:

```bash
set_env() { if grep -q "^$1=" .env; then sed -i.bak "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }

# Pin the latest release, so upgrades happen only when the person chooses (step 12):
set_env GLIDEWORTH_VERSION "$(curl -fsSL https://api.github.com/repos/GlideWorth/glideworth/releases/latest \
  | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p')"
set_env GLIDEWORTH_PORT 8787                 # the port from step 1
set_env GLIDEWORTH_MCP_ALLOW_WRITES false    # true only if the person asked for MCP writes
grep -E '^GLIDEWORTH_(VERSION|PORT|MCP_ALLOW_WRITES)=' .env
```

Expected: three lines, for example `GLIDEWORTH_VERSION=1.1.0`. If `GLIDEWORTH_VERSION=` is empty, the GitHub
API was unreachable: pick the newest version from <https://github.com/GlideWorth/glideworth/releases>
(without the leading `v`) and set it by hand.

### Settings you may need

From [`.env.example`](../../.env.example) and [SELF-HOSTING.md](../SELF-HOSTING.md#environment-variables).
All are optional. Only the ones listed in `docker-compose.yml` reach the container; the rest of `.env.example`
is for running from source.

| Variable                           | Needed                       | Default        | Secret | What it does                                                                |
| ---------------------------------- | ---------------------------- | -------------- | ------ | --------------------------------------------------------------------------- |
| `GLIDEWORTH_SETUP_TOKEN`           | Yes, on any reachable server | none           | Yes    | Must be entered with the first passphrase. At least 8 characters            |
| `GLIDEWORTH_BOOTSTRAP_KEY`         | No: leave empty              | none           | Yes    | An API key created on first boot. Never the example key                     |
| `GLIDEWORTH_VERSION`               | Recommended                  | `latest`       | No     | The image tag to run (Compose only)                                         |
| `GLIDEWORTH_PORT`                  | No                           | `8787`         | No     | The host port (Compose only)                                                |
| `GLIDEWORTH_MCP_ALLOW_WRITES`      | No                           | `false`        | No     | Turns on MCP write tools; they also need a key with `write` scope           |
| `GLIDEWORTH_TRUST_PROXY`           | Behind a reverse proxy       | `false`        | No     | Trust `X-Forwarded-*`. Only when a proxy you control is the only way in     |
| `GLIDEWORTH_COOKIE_SECURE`         | No                           | `auto`         | No     | Secure cookie flag; `auto` follows the request scheme                       |
| `GLIDEWORTH_PUBLIC_URL`            | Behind a reverse proxy       | request origin | No     | The public `https://` address: the OAuth issuer for assistants that sign in |
| `GLIDEWORTH_MAX_JOBS`              | No                           | `2`            | No     | Simulations at once, 1 to 16. Use 1 on a small machine                      |
| `GLIDEWORTH_MC_SHARDS`             | No                           | min(CPUs, 4)   | No     | Worker threads per Monte Carlo run                                          |
| `GLIDEWORTH_RATE_LIMIT_PER_MIN`    | No                           | `600`          | No     | Requests per minute per key or session; `0` disables                        |
| `GLIDEWORTH_MAX_BODY_MB`           | No                           | `10`           | No     | Largest request body, up to 200                                             |
| `GLIDEWORTH_WEBHOOK_ALLOW_PRIVATE` | No                           | `false`        | No     | Let webhooks reach private addresses (an SSRF guard when off)               |

The Compose file fixes the rest for the container: production mode, self-host mode, data in the
`glideworth-data` volume at `/data`, no sample household.

## 4. Start it and check its health

```bash
cd ~/glideworth
docker compose up -d
docker compose ps
```

Wait until `docker compose ps` shows the service as `(healthy)`; it takes about 20 seconds. Then:

```bash
curl -fsS http://localhost:8787/health
```

Expected (the version numbers will differ):

```json
{ "status": "ok", "engineVersion": "0.7.0", "schemaVersion": 6 }
```

If it is not healthy, run `docker compose logs --tail 100 glideworth`: a bad value in `.env` makes the server
refuse to start and say which. See [Troubleshooting](#troubleshooting).

## 5. Optional: reach it from other devices (domain and TLS)

Skip this when Glideworth only needs to work on this machine. Never expose port 8787 to the internet directly:
it speaks plain HTTP. Show the person this plan and get their yes before changing anything.

1. Bind the container to loopback only, with `docker-compose.override.yml` next to `docker-compose.yml`
   (Docker Compose 2.24 or newer):

   ```yaml
   services:
     glideworth:
       ports: !override
         - "127.0.0.1:8787:8787"
   ```

2. Tell Glideworth it is behind a proxy, and its public address:

   ```bash
   set_env GLIDEWORTH_TRUST_PROXY true
   set_env GLIDEWORTH_COOKIE_SECURE auto
   set_env GLIDEWORTH_PUBLIC_URL https://glideworth.example.com
   docker compose up -d
   ```

3. Put a TLS reverse proxy in front. With Caddy, which gets the certificate itself:

   ```caddyfile
   glideworth.example.com {
       encode zstd gzip
       reverse_proxy 127.0.0.1:8787
   }
   ```

   nginx needs response buffering off, a read timeout of a few minutes and a body size limit of at least
   12 MB; the full block is in [SELF-HOSTING.md](../SELF-HOSTING.md#nginx).

4. Check: `curl -fsS https://glideworth.example.com/health` answers `{"status":"ok",...}`.

Assistants that run in the cloud (claude.ai, ChatGPT) can only connect to an address they can reach over HTTPS,
so they need this step.

## 6. Check that first-run setup is waiting

```bash
curl -fsS http://localhost:8787/api/v1/auth/status
```

Expected:

```json
{ "setupRequired": true, "setupTokenRequired": true, "multiUser": false, "authenticated": false }
```

`"setupRequired":false` means someone has already chosen a passphrase: this is not a fresh install. Stop and
ask the person.

## 7. Hand over to the person: the passphrase

This step is the person's. Only the human chooses the passphrase. Tell them:

> Glideworth is running. Please open **http://localhost:8787** (or your https address) in your browser and
> choose a passphrase of 12 characters or more. A password manager is best: there is no email reset. It will
> also ask for the setup token, which is in `~/glideworth/.env` on the line starting `GLIDEWORTH_SETUP_TOKEN=`.
> Tell me when you are signed in.

You may show them the token so that they can paste it (it is only useful until the passphrase is set):

```bash
grep '^GLIDEWORTH_SETUP_TOKEN=' ~/glideworth/.env | cut -d= -f2
```

Then wait. When they say they are done, confirm:

```bash
curl -fsS http://localhost:8787/api/v1/auth/status
```

Expected: `"setupRequired":false`.

If they forget the passphrase later, `docker compose exec glideworth node dist/cli/admin.js
reset-owner-passphrase` prints a one-time reset token for them to use in the app ("Use a reset token").

## 8. Create a least-privilege key for the assistant

Create one key per assistant, with only the scope it needs:

```bash
cd ~/glideworth
docker compose exec -T glideworth node dist/cli/create-key.js --name claude-code-readonly --scopes read
```

Expected:

```
Created key_xxxxxxxx (read). Store this key now; it is not shown again:
glideworth_xxxxxxxx_<32 or more characters>
```

Scopes: `read` (read and compute tools), `simulate` (compute tools only), `write` (adds the write tools, and
only when `GLIDEWORTH_MCP_ALLOW_WRITES=true`). Use `--scopes read,write` only if the person asked for writes.
The person can also create and revoke keys in the app under **Settings**, then **API keys**.

Put the key straight into the client's configuration in step 10. Do not echo it again or save it anywhere else.

## 9. Check the MCP endpoint with the key

Before configuring the client, confirm the key works. Put the key in a variable for this shell only:

```bash
read -rs GLIDEWORTH_MCP_KEY && export GLIDEWORTH_MCP_KEY   # paste the key, then Enter
curl -sS -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer $GLIDEWORTH_MCP_KEY" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_households","arguments":{}}}'
```

Expected on a fresh install, before the person has entered anything:

```json
{ "result": { "content": [{ "type": "text", "text": "[]" }] }, "jsonrpc": "2.0", "id": 1 }
```

A `401` means the key is wrong. A household list (not `[]`) means data already exists.

## 10. Connect the assistant

Follow the section for the client the person chose in [docs/MCP.md](../MCP.md#client-setup): Claude Code,
Claude Desktop, claude.ai, ChatGPT, Codex, Cursor, VS Code or a generic stdio client. Each section has the
hosted and self-hosted address, and both the API-key and the OAuth form.

For Claude Code on the same machine, keeping the key out of any project file:

```bash
claude mcp add --scope user --transport http glideworth http://localhost:8787/mcp \
  --header "Authorization: Bearer $GLIDEWORTH_MCP_KEY"
```

Then run `claude mcp get glideworth`. Expected: `Status: ✔ Connected`.

Most clients load MCP servers at start-up: ask the person to restart the client, or open a new session, before
the next step.

## 11. Verify from the assistant

In the connected client, call these tools (or ask the assistant to):

1. `list_households`: succeeds; `[]` until the person has created a household.
2. `get_plan_summary` with no arguments, once the person has a plan. Expected shape (values are theirs):

   ```json
   {
     "plan": {
       "id": "plan-main",
       "name": "...",
       "version": 3,
       "isMain": true,
       "currency": "USD",
       "milestones": [],
       "income": [],
       "expenses": [],
       "flows": []
     },
     "finances": { "householdId": "...", "asOf": "2026-11-01", "netWorth": 0 },
     "outcome": {
       "success": true,
       "depletionYear": null,
       "endNetWorthReal": 0,
       "retirementYear": 2040,
       "basis": "real",
       "years": []
     }
   }
   ```

   Before any plan exists it returns an error whose message starts `planId is required here: 0 plans exist`.
   That is expected: the connection works.

The person can now build their household and plan in the web app (or import a file there). If they want to try
the assistant first, offer to load a synthetic sample household with
`docker compose exec glideworth node dist/cli/admin.js seed --sample us` (made-up people and numbers). Do this
only with their agreement: it adds a household to their instance, which they can delete in the app.

Install the Glideworth agent skill too, so that the assistant uses the tools well: see
[skills/glideworth/SKILL.md](../../skills/glideworth/SKILL.md). For Claude Code:

```bash
mkdir -p ~/.claude/skills/glideworth
curl -fsSL https://raw.githubusercontent.com/GlideWorth/glideworth/main/skills/glideworth/SKILL.md \
  -o ~/.claude/skills/glideworth/SKILL.md
```

## 12. Backups and upgrades

Tell the person how these work; set up a schedule only if they ask.

**Back up** (safe while it runs; one file holds everything):

```bash
cd ~/glideworth
docker compose exec -T glideworth node dist/cli/admin.js backup --out /data/backups/manual.db
docker compose cp glideworth:/data/backups/manual.db ./glideworth-backup.db
```

Expected: `Backup written: /data/backups/manual.db`. A backup holds the whole plan and hashed credentials: keep
copies off the machine, encrypted. Restoring is in [SELF-HOSTING.md](../SELF-HOSTING.md#restore); it replaces
the database, so show the person the plan first.

**Upgrade** to a new release, after reading its notes at <https://github.com/GlideWorth/glideworth/releases>:

```bash
cd ~/glideworth
docker compose exec -T glideworth node dist/cli/admin.js backup --out /data/backups/pre-upgrade.db
set_env GLIDEWORTH_VERSION 1.2.3      # the new version, without the leading v (set_env: step 3)
docker compose pull && docker compose up -d
curl -fsS http://localhost:8787/health
```

Migrations run at start-up. To roll back, set the previous version and run `docker compose up -d`; if the old
version cannot read the database, restore `pre-upgrade.db`.

## Hosted path (Glideworth Cloud)

Nothing to install, and backups are handled.

1. The person signs up at <https://app.glideworth.com/signup> (a free trial with no card). They choose their own
   password; you do not.
2. They build or import their plan in the app.
3. Connect the assistant to `https://app.glideworth.com/mcp`, one of two ways:
   - **Sign in (OAuth), preferred:** add the URL to the client with no key. On first use the client opens a
     Glideworth consent screen where the person signs in, picks the workspace and approves the scopes.
   - **API key:** the person creates a key in the app under **Settings**, then **API keys** (it starts
     `gwk_`), and you put it in the client as `Authorization: Bearer gwk_...`.

   The per-client steps are in [docs/MCP.md](../MCP.md#client-setup).

4. Writes are off until the workspace owner turns on **Allow AI assistants to make changes** under
   **Settings**, then **Workspace**.
5. Verify as in step 11.

## Troubleshooting

| What you see                                           | Likely cause                                                       | What to do                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `Cannot connect to the Docker daemon`                  | Docker is not running                                              | Ask the person to start Docker Desktop, or `sudo systemctl start docker` with their agreement |
| `port is already allocated` / `address already in use` | Something else uses the port                                       | `set_env GLIDEWORTH_PORT <free port>` and `docker compose up -d`                              |
| `container name "/glideworth" is already in use`       | An older install or another project                                | Ask the person; it may hold their data. Do not remove it without a yes                        |
| Service never becomes `healthy`, or exits              | A bad value in `.env`                                              | `docker compose logs --tail 100 glideworth` names the variable                                |
| `/health` works in the container but not from the host | The port is published elsewhere, or a VM or firewall is in the way | `docker compose port glideworth 8787`; on a remote server use its address or the proxy        |
| `"setupRequired":false` on a new install               | The volume already has a database                                  | Stop and ask: this is an existing instance                                                    |
| Setup token rejected                                   | Typo, or `.env` changed after start                                | Copy it again from `.env`; wrong tries count towards the sign-in throttle                     |
| `401` from `/mcp`                                      | Missing or wrong key or token; browser sessions are not accepted   | Check the `Authorization: Bearer` header; create a new key (step 8)                           |
| `403` with `lacks the 'read' scope`                    | The key has too narrow a scope                                     | Create a key with the scope you need                                                          |
| No write tools in the client                           | `GLIDEWORTH_MCP_ALLOW_WRITES` is `false`, or the key lacks `write` | Expected unless the person asked for writes. Change both, restart, reconnect                  |
| `405` on `GET /mcp`                                    | Normal: the server is stateless and only answers `POST`            | Nothing; clients use `POST`                                                                   |
| OAuth sign-in loops or the redirect fails              | `GLIDEWORTH_PUBLIC_URL` missing or wrong behind a proxy            | Set it to the exact `https://` address and `docker compose up -d`                             |
| Sign-in loops in the browser over HTTPS                | The proxy does not send `X-Forwarded-Proto: https`                 | Set `GLIDEWORTH_TRUST_PROXY=true` and check the proxy headers                                 |
| Long tools time out behind a proxy                     | Proxy buffering or a short read timeout                            | nginx: `proxy_buffering off; proxy_read_timeout 300s;`                                        |
| `planId is required here: 0 plans exist`               | No plan yet                                                        | Expected on a fresh install; the person creates one in the app                                |
| A tool returns `jobId` and `running`                   | The job took longer than `wait`                                    | Call `get_job` with the `jobId` and `wait: 60`                                                |

More: [SELF-HOSTING.md](../SELF-HOSTING.md#troubleshooting) and [docs/MCP.md](../MCP.md#troubleshooting).

## 13. Report back

Finish by telling the person, briefly:

- where Glideworth runs (folder, address, port) and which version;
- that they chose the passphrase, and that the setup token is no longer needed;
- which key you created (its name and scope, never the key itself), and where the client keeps it;
- whether MCP writes are on or off, and how to change that;
- which client you connected, and the result of the verification in step 11;
- how to back up and upgrade (step 12), and anything that did not work or that you skipped.

## See also

- [README](../../README.md) and [SELF-HOSTING.md](../SELF-HOSTING.md): the same install, for people.
- [docs/MCP.md](../MCP.md): every client, every tool, the safety model.
- [skills/glideworth/SKILL.md](../../skills/glideworth/SKILL.md): how an assistant should use Glideworth once
  connected.
