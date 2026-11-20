# Self-hosting Glideworth

This guide covers running Glideworth on your own machine or server with Docker: installing, putting it
behind HTTPS, configuring it, upgrading, backing up and restoring, and moving it.

**The self-hosted build is the whole product.** It has every feature, there is no licence key, no paywall
and no feature that only the hosted service has. It has **no telemetry**: it does not report usage,
errors, version checks or analytics to anyone. The only outbound connections the server makes are the
webhooks you configure yourself. (In the browser, the optional API reference page at `/docs` loads its
viewer script from the jsDelivr CDN; nothing else in the app contacts a third party. The hosted service's
`/docs` is a server-rendered page with no third-party script.) The marketing website (`apps/site`) is not
part of this container. If you build it yourself, leave `PUBLIC_GTM_ID` unset: it is optional, off by
default, and only the official hosted website sets it. The app never loads that tag. The same image also runs the hosted service
(`GLIDEWORTH_MODE=cloud`); a self-hosted instance never loads that code. The software is
licensed under AGPL-3.0-only; see [`LICENSING.md`](../LICENSING.md).

## Contents

1. [Requirements](#requirements)
2. [Install with Docker Compose](#install-with-docker-compose)
3. [First run: passphrase and setup token](#first-run-passphrase-and-setup-token)
4. [HTTPS behind a reverse proxy](#https-behind-a-reverse-proxy)
5. [Environment variables](#environment-variables)
6. [Upgrading](#upgrading)
7. [Upgrading from Cairn](#upgrading-from-cairn)
8. [Backup and restore](#backup-and-restore)
9. [Moving to a new machine](#moving-to-a-new-machine)
10. [Sizing](#sizing)
11. [Troubleshooting](#troubleshooting)
12. [Support](#support)

## Requirements

- A Linux, macOS or Windows machine that runs **Docker Engine 24 or newer with the Compose plugin** (or
  Docker Desktop, OrbStack and similar). The image is built for `linux/amd64` and `linux/arm64`, so a
  Raspberry Pi 4 or newer 64-bit board works.
- About **1 GB of free memory** and **1 GB of disk** to start with (see [Sizing](#sizing)).
- For access from other devices over the internet: a domain name pointing at the machine, and ports 80 and
  443 open for the reverse proxy.
- Without Docker you can run from source: Node 24 and pnpm 10, `pnpm install`, `pnpm build`, `pnpm start`
  (see the README). The rest of this guide assumes Docker.

## Install with Docker Compose

Each release is published as a Docker image, `ghcr.io/glideworth/glideworth`, for `linux/amd64` and
`linux/arm64`. The repository's `docker-compose.yml` runs it: one container, one process, one port. The
container runs the API, the web app, the MCP endpoint and SQLite, with the data on a Docker volume. You need
only two files, not the whole repository:

```bash
mkdir glideworth && cd glideworth
curl -fsSLO https://raw.githubusercontent.com/GlideWorth/glideworth/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/GlideWorth/glideworth/main/.env.example -o .env
```

Edit `.env` before the first start. This command does the first two steps:

```bash
sed -i.bak -e "s/^GLIDEWORTH_SETUP_TOKEN=.*/GLIDEWORTH_SETUP_TOKEN=$(openssl rand -hex 24)/" \
  -e 's/^GLIDEWORTH_BOOTSTRAP_KEY=.*/GLIDEWORTH_BOOTSTRAP_KEY=/' .env   # set a setup token, clear the dev key
```

- set `GLIDEWORTH_SETUP_TOKEN` to a long random value (at least 8 characters; for example the output of
  `openssl rand -hex 24`). This stops a stranger who finds the port from choosing your passphrase first;
- clear `GLIDEWORTH_BOOTSTRAP_KEY` (or set your own secret). `.env.example` ships the public development key,
  which the server refuses in production and warns about at start-up;
- optionally pin a release by adding `GLIDEWORTH_VERSION=1.0.0` (without it you get `latest`). Pinning is
  recommended: you then upgrade when you choose to.

Then start it:

```bash
docker compose up -d
docker compose ps                    # the service should become "healthy"
docker compose logs -f glideworth
```

Open <http://localhost:8787> (change the host port with `GLIDEWORTH_PORT` in `.env`). Data lives in the
`glideworth-data` Docker volume and survives restarts and upgrades. The
database is `/data/glideworth.db` (`GLIDEWORTH_DATA_DIR=/data`, set by the image). Do not point
`GLIDEWORTH_DATA_DIR` or `GLIDEWORTH_DB_PATH` anywhere outside `/data`.

To build the image from source instead, clone the repository and run `docker compose up -d --build` in it.

To stop it: `docker compose stop`. To remove the container but keep the data: `docker compose down`.
`docker compose down -v` **deletes the volume and all your data**.

## First run: passphrase and setup token

On a fresh database the web app asks you to choose a passphrase (12 characters or more) and, if you set
`GLIDEWORTH_SETUP_TOKEN`, to enter that token. You become the owner and are signed in. After that the
setup screen is gone for good.

- A password manager passphrase is best. There is no email, so there is no "forgot password" link.
- **Forgot the passphrase?** Run, on the host:

  ```bash
  docker compose exec glideworth node dist/cli/admin.js reset-owner-passphrase
  ```

  It prints a one-time token. In the app choose "Use a reset token" and enter the token and a new
  passphrase. The owner is signed out everywhere.

- **API keys** (for scripts and AI assistants) are created in the app under Settings, or with
  `docker compose exec glideworth node dist/cli/create-key.js --name laptop --scopes read`. Give each tool
  the least scope it needs. MCP write tools stay off unless you set `GLIDEWORTH_MCP_ALLOW_WRITES=true`.
- If you left the setup token empty, the server logs a warning at start-up. Set one, or keep the port
  reachable only from your own machine, until you have chosen a passphrase.

## HTTPS behind a reverse proxy

Do not expose the container's port to the internet directly: it speaks plain HTTP. Put a reverse proxy
that terminates TLS in front of it, on the same host.

1. Bind the container to loopback only, so that only the proxy can reach it. Create
   `docker-compose.override.yml` next to `docker-compose.yml` (needs Docker Compose 2.24 or newer for
   `!override`):

   ```yaml
   services:
     glideworth:
       ports: !override
         - "127.0.0.1:8787:8787"
   ```

2. In `.env`, tell Glideworth it is behind a proxy and what its public address is:

   ```
   GLIDEWORTH_TRUST_PROXY=true
   GLIDEWORTH_COOKIE_SECURE=auto
   GLIDEWORTH_PUBLIC_URL=https://glideworth.example.com
   ```

   `GLIDEWORTH_TRUST_PROXY=true` makes the server trust the proxy's `X-Forwarded-For` and
   `X-Forwarded-Proto` headers (for login throttling and the secure cookie). Set it **only** when a proxy
   you control is the sole way to reach the port, otherwise clients can spoof their address.
   `GLIDEWORTH_PUBLIC_URL` is the OAuth issuer used for MCP sign-in from AI clients.

3. `docker compose up -d` to apply, then configure the proxy.

### Caddy (automatic certificates)

```caddyfile
glideworth.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
}
```

Caddy obtains and renews the certificate itself and sets the forwarded headers.

### nginx

```nginx
server {
    listen 80;
    server_name glideworth.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name glideworth.example.com;

    # Certificates, for example from certbot.
    ssl_certificate     /etc/letsencrypt/live/glideworth.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/glideworth.example.com/privkey.pem;

    # nginx's default is 1 MB; imports can be larger. Keep this at or above GLIDEWORTH_MAX_BODY_MB (default 10).
    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Long-running simulations and the MCP endpoint stream responses.
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

Check it: `curl -fsS https://glideworth.example.com/health` returns `{"status":"ok",...}`. A signed-in browser
session over HTTPS must receive a `Secure` cookie; if sign-in loops, see [Troubleshooting](#troubleshooting).

## Environment variables

Set these in `.env` next to `docker-compose.yml` (the compose file passes the ones it lists to the
container), or in the container's environment. All are optional. Values are read at start-up: restart after
a change (`docker compose up -d`). Defaults are those of the Docker image where they differ from the
server's own defaults. Every variable also works under its name from before the rename, `CAIRN_` instead of
`GLIDEWORTH_` (see [Upgrading from Cairn](#upgrading-from-cairn)).

| Variable                              | Default                    | What it does                                                                                                                                                                             |
| ------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GLIDEWORTH_PORT`                     | `8787`                     | Compose only: the host port that maps to the container.                                                                                                                                  |
| `GLIDEWORTH_API_PORT`                 | `8787`                     | Port the server listens on inside the container. Leave it (the compose file sets 8787).                                                                                                  |
| `GLIDEWORTH_HOST`                     | all interfaces             | Interface to bind. Use `127.0.0.1` when running from source behind a proxy on the same host.                                                                                             |
| `GLIDEWORTH_MODE`                     | `selfhost`                 | `selfhost` (this guide) or `cloud` (the hosted service; see `.env.example`). Anything else refuses to start.                                                                             |
| `GLIDEWORTH_DATA_DIR`                 | `/data` (image), `./data`  | The data directory. The database is `glideworth.db` in it unless `GLIDEWORTH_DB_PATH` names a file.                                                                                      |
| `GLIDEWORTH_DB_PATH`                  | `<data dir>/glideworth.db` | SQLite database file. Must be on the `/data` volume in Docker. While a file named `glideworth.db` does not exist and `cairn.db` does in the same directory, `cairn.db` is used.          |
| `GLIDEWORTH_SETUP_TOKEN`              | none                       | Required in the first-run setup when set (at least 8 characters). **Set it on any instance others can reach.**                                                                           |
| `GLIDEWORTH_BOOTSTRAP_KEY`            | none                       | An API key to create on first boot when no key exists. Format `glideworth_<8 lowercase alphanumerics>_<32 or more alphanumerics>` as in `docs/API.md`. Never use the public example key. |
| `GLIDEWORTH_BROWSER_AUTH`             | `true`                     | Passphrase and session-cookie sign-in for the browser. API keys always work.                                                                                                             |
| `GLIDEWORTH_SESSION_TTL_HOURS`        | `168`                      | Absolute session lifetime (7 days).                                                                                                                                                      |
| `GLIDEWORTH_SESSION_IDLE_HOURS`       | `24`                       | Idle timeout.                                                                                                                                                                            |
| `GLIDEWORTH_LOGIN_MAX_ATTEMPTS`       | `5`                        | Failed sign-ins per client in the window before throttling.                                                                                                                              |
| `GLIDEWORTH_LOGIN_WINDOW_MINUTES`     | `15`                       | The throttling window.                                                                                                                                                                   |
| `GLIDEWORTH_COOKIE_SECURE`            | `auto`                     | `auto` sets the Secure flag when the request is HTTPS (or the proxy says so); `true` or `false` forces it.                                                                               |
| `GLIDEWORTH_TRUST_PROXY`              | `false`                    | Trust `X-Forwarded-*` headers. Only behind a proxy you control.                                                                                                                          |
| `GLIDEWORTH_PUBLIC_URL`               | the request's origin       | Public base URL (`https://...`): the OAuth issuer and the base of OAuth endpoints. Set it behind a proxy.                                                                                |
| `GLIDEWORTH_MCP_ALLOW_WRITES`         | `false`                    | Enables the MCP write tools (which also need a key with write scope). Plan edits are still proposals you approve.                                                                        |
| `GLIDEWORTH_RATE_LIMIT_PER_MIN`       | `600`                      | Requests per minute per key or session; `0` disables.                                                                                                                                    |
| `GLIDEWORTH_SHARE_RATE_LIMIT_PER_MIN` | `60`                       | Public share-link reads per minute per client; `0` is unlimited.                                                                                                                         |
| `GLIDEWORTH_MAX_BODY_MB`              | `10`                       | Largest request body accepted (up to 200).                                                                                                                                               |
| `GLIDEWORTH_MAX_JOBS`                 | `2`                        | Simulations (Monte Carlo and solvers) that run at once, 1 to 16.                                                                                                                         |
| `GLIDEWORTH_MC_SHARDS`                | min(CPUs, 4)               | Worker threads one Monte Carlo run is split across, 1 to 32 (1 disables sharding).                                                                                                       |
| `GLIDEWORTH_MAX_JOB_SECONDS`          | `1800`                     | A background job (Monte Carlo, solver, sensitivity, attribution) running longer is stopped and fails with `JOB_TIMEOUT`.                                                                 |
| `GLIDEWORTH_WORKER_MAX_MB`            | `2048`                     | Heap limit of one job thread in MiB; a job that needs more fails with `JOB_OUT_OF_MEMORY` instead of exhausting the host.                                                                |
| `GLIDEWORTH_LOG_LEVEL`                | `info`                     | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stderr with allowlisted fields only: never a figure, a name, a message text or a token.                                       |
| `GLIDEWORTH_SCHEDULER`                | `true`                     | Run scheduled check-ins in this process.                                                                                                                                                 |
| `GLIDEWORTH_WEBHOOK_ALLOW_PRIVATE`    | `false`                    | Let webhooks deliver to loopback or private addresses. Off by default as an SSRF guard.                                                                                                  |
| `GLIDEWORTH_SEED_SAMPLE`              | `false` (image)            | Insert a synthetic sample household on first start. The server's own default is `true` for development.                                                                                  |
| `GLIDEWORTH_SERVE_WEB`                | on in production           | Serve the built web app from the API process.                                                                                                                                            |
| `GLIDEWORTH_WEB_DIST`                 | `/app/web` (image)         | Directory of the built web app.                                                                                                                                                          |
| `GLIDEWORTH_WEB_ORIGIN`               | none in production         | A browser origin allowed to call the API (development only). Leave empty in production.                                                                                                  |
| `NODE_ENV`                            | `production` (image)       | Production mode: stricter defaults, web app served, public example key refused.                                                                                                          |

## Upgrading

1. **Read the release notes** for the version you are moving to.
2. **Back up first** (see [Backup and restore](#backup-and-restore)):

   ```bash
   docker compose exec glideworth node dist/cli/admin.js backup --out /data/backups/pre-upgrade.db
   ```

3. **Update:** set `GLIDEWORTH_VERSION` in `.env` to the new version (or leave it unset for `latest`), then:

   ```bash
   docker compose pull
   docker compose up -d
   docker compose logs --tail 50 glideworth
   ```

   Database migrations are applied automatically at start-up. Check `docker compose ps` shows "healthy".
   If you build from source, run `git pull` (or check out the release tag) and `docker compose up -d --build`
   instead.

4. **If it goes wrong,** set `GLIDEWORTH_VERSION` back to the previous version and run `docker compose up -d`.
   If the database was changed in a way the old version cannot read, restore `pre-upgrade.db`.

Pin a release rather than running `latest` in production. Upgrade one minor version at a time if you have
skipped several, reading the notes for each. Releases and their notes:
<https://github.com/GlideWorth/glideworth/releases>.

## Upgrading from Cairn

Glideworth was developed under the working name **Cairn**. An install from that time upgrades like any
other release: pull, rebuild, start. You do not need to change your `.env`, your API keys or your AI-assistant
set-up, but the Docker volume needs one step (below), and you stay signed in. Take a backup first as usual (with the old service name,
`docker compose exec cairn node dist/cli/admin.js backup --out /data/backups/pre-glideworth.db`).

```bash
git pull
docker compose up -d --build --remove-orphans
docker compose logs --tail 50 glideworth
```

`--remove-orphans` is needed once: the Compose service, image and container are now called `glideworth`,
so it removes the old `cairn` container (which would otherwise keep port 8787). It does not touch volumes.

What keeps working, and how:

| Before (Cairn)                                                                                               | Now (Glideworth)                                                        | How the old form keeps working                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAIRN_*` environment variables (`.env`, Compose, `docker run -e`, systemd)                                  | `GLIDEWORTH_*`                                                          | Every variable is read under both names; the new name wins when both are set. The server prints one warning at start-up naming the old variables in use (never their values). The Compose file substitutes `${GLIDEWORTH_X:-${CAIRN_X:-default}}`, so an old `.env` is honoured. |
| Database file `cairn.db`                                                                                     | `glideworth.db`                                                         | If `glideworth.db` does not exist and `cairn.db` does in the same directory, `cairn.db` is used and the server logs one line saying so. Nothing is moved or copied.                                                                                                              |
| Docker volume `cairn-data`                                                                                   | `glideworth-data`                                                       | Not automatic: keep mounting `cairn-data` with an override file (see below).                                                                                                                                                                                                     |
| API keys `cairn_<prefix>_<secret>`                                                                           | `glideworth_<prefix>_<secret>`                                          | Old keys keep verifying; new keys are created in the new format.                                                                                                                                                                                                                 |
| Browser session cookies `cairn_session`, `cairn_csrf`                                                        | `glideworth_session`, `glideworth_csrf`                                 | An old cookie is accepted and, on the next page load, replaced by the new names for the same session.                                                                                                                                                                            |
| OAuth tokens `cairn_oat_…`, `cairn_ort_…`; client ids `cairn-client-…`                                       | `glideworth_oat_…`, `glideworth_ort_…`, `glideworth-client-…`           | Old tokens work until they expire; refreshing one returns new-format tokens. Registered clients keep their ids.                                                                                                                                                                  |
| Share links `/share/cairn_share_…`; invitation and passphrase-reset tokens `cairn-invite-…`, `cairn-reset-…` | `glideworth_share_…`, `glideworth-invite-…`, `glideworth-reset-…`       | Old links and tokens keep working until they expire, are used or are revoked.                                                                                                                                                                                                    |
| Webhook headers `X-Cairn-Event`, `X-Cairn-Delivery`, `X-Cairn-Signature`                                     | `X-Glideworth-Event`, `X-Glideworth-Delivery`, `X-Glideworth-Signature` | Both sets are sent with the same values. The `X-Cairn-*` headers are **deprecated** and will be removed in a later major version: switch receivers to the new names. The `User-Agent` is now `Glideworth-Webhooks/1`.                                                            |
| MCP server name `cairn`; resources `cairn://…`                                                               | `glideworth`; `glideworth://…`                                          | Stored `cairn://…` resource URIs still resolve (not listed). The name an AI client shows is whatever you registered it under (`claude mcp add cairn …` keeps working).                                                                                                           |
| Export files with `"app": "cairn"`; import `format: "cairn"`                                                 | `"app": "glideworth"`; `format: "glideworth"`                           | Imports accept both. CSV preset ids `cairn-accounts` and `cairn-progress` are aliases of `glideworth-accounts` and `glideworth-progress`.                                                                                                                                        |
| Backups `cairn-<timestamp>.db`                                                                               | `glideworth-<timestamp>.db`                                             | `restore --from` accepts any backup file, whatever its name.                                                                                                                                                                                                                     |
| Browser settings (theme, preferences, drafts, saved chart views)                                             | stored under `glideworth…` keys                                         | Moved from the old `cairn…` keys the first time the new version loads.                                                                                                                                                                                                           |
| Example key `cairn_devlocal_…` in an old `.env.example`                                                      | `glideworth_devlocal_…`                                                 | Both are public and both are refused in production.                                                                                                                                                                                                                              |

**The Docker volume.** The Compose file now names the volume `glideworth-data`. Compose names volumes
`<project>_<volume>`, so a Cairn-era install would start against a fresh, empty volume and your data would
look gone (it is still there, in `cairn-data`). Before you start the new version, either keep the old volume
with a `docker-compose.override.yml`:

```yaml
# docker-compose.override.yml
services:
  glideworth:
    volumes: !override
      - cairn-data:/data
volumes:
  cairn-data:
```

or copy the data into the new volume while the server is stopped:

```bash
docker compose stop glideworth
project=$(basename "$PWD")       # the Compose project name, unless you set COMPOSE_PROJECT_NAME
docker volume create "${project}_glideworth-data"
docker run --rm -v "${project}_cairn-data:/from:ro" -v "${project}_glideworth-data:/to" \
  alpine sh -c 'cp -a /from/. /to/'
```

Run `docker compose up -d`, check your data, and only then remove the old volume
(`docker volume rm "${project}_cairn-data"`). Renaming the file inside the volume (`cairn.db` to
`glideworth.db`) is optional too: stop the server, rename `cairn.db` and, if present, `cairn.db-wal` and
`cairn.db-shm` together, then start it.

If you run the image with `docker run` instead of Compose, keep mounting the same volume
(`-v cairn-data:/data`). The image sets `GLIDEWORTH_DATA_DIR=/data`, `GLIDEWORTH_WEB_DIST` and
`GLIDEWORTH_SEED_SAMPLE` itself; because the new name wins, a `-e CAIRN_WEB_DIST=…` or
`-e CAIRN_SEED_SAMPLE=…` you pass is ignored (the start-up warning says so): rename those to `GLIDEWORTH_…`.
The image no longer sets the database path itself (it is `glideworth.db` in the data directory), so a
`-e GLIDEWORTH_DB_PATH=…` or `-e CAIRN_DB_PATH=…` you pass is honoured. The port is not set by the image, so
`CAIRN_API_PORT` keeps working.

Running from source (`pnpm start`) works the same way: an existing `.env` with `CAIRN_*` lines and a
`cairn.db` keeps working unchanged.

## Backup and restore

All your data is one SQLite file on the `glideworth-data` volume. A backup is one self-contained file, is
integrity-checked, and can be taken **while the server is running**.

### Back up

```bash
# A named file on the volume
docker compose exec glideworth node dist/cli/admin.js backup --out /data/backups/manual.db

# Or let it name the file: /data/backups/<database name>-<timestamp>.db
docker compose exec glideworth node dist/cli/admin.js backup

# Copy it off the volume to the host (and then off the machine)
docker compose cp glideworth:/data/backups/manual.db ./glideworth-backup.db
```

Backups on the same volume protect against mistakes, not against losing the disk: **copy them somewhere
else**, regularly. For a daily backup, cron on the host can run the first command with a dated name
and `docker compose cp`, followed by an off-site copy (`rsync`, `restic`, `rclone`). A backup contains your
whole financial plan and your hashed credentials: store it as carefully as the live data (encrypt it).
`docker compose exec` needs a TTY-free form in cron: add `-T`.

You can also export one household as portable JSON from the app, or with
`GET /households/{id}/export` over the API. That is not a full backup (no users, keys or history).

### Restore

Stop the server first, so nothing writes while the file is replaced. Put the backup on the volume or mount
it, then:

```bash
docker compose stop glideworth

# Backup file is on the host, in the current directory:
docker compose run --rm --no-deps \
  -v "$PWD/glideworth-backup.db:/restore/backup.db:ro" \
  glideworth node dist/cli/admin.js restore --from /restore/backup.db --force

docker compose up -d
```

`--force` is required when a database already exists. The current database is kept next to it as
`<database>.pre-restore-<timestamp>` on the volume, so a wrong restore can be undone; delete those copies
when you no longer need them. A restored backup from an older version is migrated to the current schema.

## Moving to a new machine

1. On the old machine: take a backup and copy it off (above). Also copy your `.env` file (it holds the
   setup token and any settings; it is **not** inside the backup).
2. On the new machine: install Docker, `git clone` the repository (check out the same version or newer),
   put the `.env` in place, and build **without starting** it:

   ```bash
   docker compose build
   ```

3. Restore the backup into the new, empty volume before the first start (no `--force` is needed because no
   database exists yet):

   ```bash
   docker compose run --rm --no-deps \
     -v "$PWD/glideworth-backup.db:/restore/backup.db:ro" \
     glideworth node dist/cli/admin.js restore --from /restore/backup.db
   docker compose up -d
   ```

4. Sign in with your existing passphrase: users, sessions policy, API keys and share links travel with the
   database (existing browser sessions may need to sign in again). Update DNS and the reverse proxy
   configuration, and set `GLIDEWORTH_PUBLIC_URL` if the address changed (AI assistants connected over
   OAuth will need to reconnect if it did).
5. Keep the old machine's data until you are sure the new one works, then delete the old volume.

## Sizing

These are **estimates from one small test, not guarantees**. An idle container with the sample household
used roughly 190 MB of memory and almost no CPU, and the built image is about 500 MB on disk. The database
for a household is small (hundreds of kilobytes with the sample; a few megabytes after years of use with
history and snapshots). Simulations are the heavy part:

| Use                                                            | CPU          | Memory    | Disk              |
| -------------------------------------------------------------- | ------------ | --------- | ----------------- |
| One person or household, occasional use                        | 1 core       | 512 MB    | 2 GB              |
| Several households, regular use, 10,000-trial Monte Carlo runs | 2 to 4 cores | 1 to 2 GB | 5 GB plus backups |

Monte Carlo runs use worker threads: `GLIDEWORTH_MAX_JOBS` runs at once and each is split over up to
`GLIDEWORTH_MC_SHARDS` threads. More cores make runs faster; each concurrent job also uses extra memory, so
on a small machine lower `GLIDEWORTH_MAX_JOBS` to 1. SQLite on one volume means one instance serves one
database: run a single container, not several replicas. Put the volume on local SSD storage, not a network
filesystem.

## Troubleshooting

| Symptom                                                       | Check                                                                                                                                                                                                      |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container is "unhealthy" or exits                             | `docker compose logs glideworth`. The health check requests `/health` inside the container. A bad value in `.env` makes the server refuse to start and says which.                                         |
| Port already in use                                           | Another process uses 8787. Set `GLIDEWORTH_PORT` to a free port in `.env` and run `docker compose up -d`.                                                                                                  |
| "Setup token" is rejected                                     | The value must equal `GLIDEWORTH_SETUP_TOKEN` exactly. Wrong tokens count towards the sign-in throttle; wait for the window to pass.                                                                       |
| Cannot sign in over HTTPS, redirects back to the sign-in page | Set `GLIDEWORTH_TRUST_PROXY=true` and make sure the proxy sends `X-Forwarded-Proto: https`; leave `GLIDEWORTH_COOKIE_SECURE=auto`.                                                                         |
| "Too many attempts"                                           | Sign-in throttling (`GLIDEWORTH_LOGIN_MAX_ATTEMPTS` in `GLIDEWORTH_LOGIN_WINDOW_MINUTES`). Wait. Behind a proxy without `GLIDEWORTH_TRUST_PROXY=true`, all users look like one client and share the limit. |
| Everything is empty after an upgrade                          | You started a different volume: check `docker volume ls` and that the compose project name did not change (run from the same directory). Restore a backup if needed.                                       |
| Imports fail with 413                                         | The body is larger than `GLIDEWORTH_MAX_BODY_MB`; raise it, and raise `client_max_body_size` in nginx.                                                                                                     |
| Webhook to an internal address is blocked                     | By design (SSRF guard). Set `GLIDEWORTH_WEBHOOK_ALLOW_PRIVATE=true` only if you trust everyone with webhook access.                                                                                        |
| Restore says "not a ... database" or fails an integrity check | The file is not a Glideworth backup or is corrupt. Try an earlier backup.                                                                                                                                  |
| MCP client cannot connect                                     | The URL is `https://<your host>/mcp` with `Authorization: Bearer <key>`. Check the key's scope, and for OAuth clients that `GLIDEWORTH_PUBLIC_URL` is correct.                                             |
| Simulations are slow                                          | Lower the trial count, or give the container more CPUs, and see [Sizing](#sizing).                                                                                                                         |
| Docker build fails on `better-sqlite3`                        | The image compiles it when no prebuilt binary exists for your platform. Make sure the build has network access and enough memory (2 GB).                                                                   |

If you are stuck, collect `docker compose logs --tail 200 glideworth` and the output of `docker compose ps`,
remove anything personal, and ask in GitHub Discussions.

## Support

Glideworth is open source and self-hosting support is **community support**: use GitHub Discussions
for questions, and GitHub issues for reproducible bugs (the templates ask for the version and logs; never
post real financial data, passphrases or API keys). There is no service-level agreement, no private
support channel and no guaranteed response time for self-hosters. Security problems go to
[`SECURITY.md`](../SECURITY.md), not to a public issue.

If you would rather not run it yourself, the hosted service at glideworth.com runs the same software
for a subscription, with backups and updates handled for you.
