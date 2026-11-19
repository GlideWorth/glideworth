# Glideworth REST API

Glideworth exposes everything the web app does over a versioned REST API, and it can run simulations
server-side. The same operations are available to AI agents through the [MCP server](./MCP.md); both
are thin adapters over `apps/api/src/services.ts`, so they behave identically.

- Base URL: `http://localhost:8787` (set `GLIDEWORTH_API_PORT`). In production the same port also serves the
  web app (see [Running in production](#running-in-production-one-process-one-port)).
- Interactive reference: `GET /docs` (self-host: Scalar UI, whose script loads from the jsDelivr CDN, so the
  page needs internet access, while `/openapi.json` and every API call work fully offline; the hosted service
  serves a server-rendered page with no script and nothing from another origin). Machine-readable:
  `GET /openapi.json` (OpenAPI 3.1, generated from the same Zod schemas as the engine, so request and
  response shapes cannot drift). It has 250 operations in self-host mode, 291 in cloud mode and 298 in cloud mode with
  "Sign in with Google" configured, as the hosted service is (see [Cloud mode](#cloud-mode-the-hosted-service)), each with a unique `operationId`, tags, a scope
  (`x-required-scope`) and an explicit `security` declaration (`[]` for the public auth routes). It passes
  Redocly and swagger-parser validation, and `npx openapi-typescript http://localhost:8787/openapi.json -o glideworth.d.ts`
  generates a complete TypeScript client; a test (`test/openapi-quality.test.ts`) keeps all of that true.
- All resource routes live under `/api/v1`. Public routes: `/health`, `/openapi.json`, `/docs` and the
  browser sign-in routes `/api/v1/auth/*`.

## Conventions

**Units.** Money is a JSON number in **major currency units** (`1234.56`), never cents. Rates are
decimal fractions (`0.07` = 7%). Every user-entered amount is `{ "value", "basis": "real" | "nominal" }`
plus a `frequency`, so "$20k/month" can never be read as "$20k/year". Engine results are nominal with
a per-period `priceIndex`; the compact views below default to real (today's) money.

**Errors.** Every error has the same envelope and a stable `code`:

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "plan is at version 3, not 2",
    "details": { "currentVersion": 3 }
  }
}
```

| Status    | Codes                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400       | `VALIDATION` (details = Zod issues), `INVALID_TOKEN` (invite / reset token invalid, used or expired; also a body that addresses `__proto__`, `constructor` or `prototype`)                                                                                                                                                                                                            |
| 401 / 403 | `UNAUTHORIZED`, `FORBIDDEN` (details.required = the scope or `owner` role you lack; details.role = your role), `CSRF` (cookie-authenticated write without a valid `X-CSRF-Token`, or from another origin)                                                                                                                                                                             |
| 404       | `NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                           |
| 409       | `VERSION_CONFLICT`, `CONFLICT`, `IN_USE`, `PATCH_CONFLICT` (a patch op whose target is missing or whose `test` failed: core's `PatchConflictError`), `CHANGESET_CONFLICT`, `CHANGESET_NOT_PROPOSED`, `PARENT_MOVED`, `LAST_WRITE_KEY`, `JOB_NOT_FINISHED`, `JOB_FAILED`, `JOB_CANCELLED`, `ALREADY_CONFIGURED`, `SETUP_REQUIRED`, `LOGIN_TAKEN`, `OWNER_PROTECTED`, `CHECKIN_RUNNING` |
| 422       | scenario errors (dangling reference, circular milestone, unknown person in a template), `IMPORT_FAILED`, `IMPORT_TIMEOUT`, `IMPORT_OUT_OF_MEMORY` (see "Export and import"), `IDEMPOTENCY_KEY_REUSED`                                                                                                                                                                                 |
| 413       | `PAYLOAD_TOO_LARGE`: the body exceeds `GLIDEWORTH_MAX_BODY_MB` (default 10)                                                                                                                                                                                                                                                                                                           |
| 429       | `RATE_LIMITED` (with `Retry-After`)                                                                                                                                                                                                                                                                                                                                                   |
| 501       | `NOT_IMPLEMENTED` with `details.feature` and `details.workstream`: the plan uses something the engine does not model yet                                                                                                                                                                                                                                                              |
| 503       | `IMPORT_BUSY` (with `Retry-After`): every import thread is busy and the import queue is full; `TENANT_UNAVAILABLE`                                                                                                                                                                                                                                                                    |

**Pagination.** List endpoints take `limit` (1-200, default 50) and `cursor`, and return
`{ "items": [...], "nextCursor": "..." | null, "total": n }`.

**Optimistic concurrency.** Plans and households return `ETag: "<version>"` (plans and households both start at version 1; every write adds one). Send
`If-Match: "<version>"` on writes; a stale version is `409 VERSION_CONFLICT`. `PUT /plans/{id}`
requires it; everywhere else it is optional (omitted = "last write wins"). `If-None-Match` on a GET
returns `304`.

**Idempotency.** Send `Idempotency-Key: <unique string>` on any `POST/PUT/PATCH/DELETE`. The first
successful response is stored (24h) and replayed verbatim for retries (`Idempotent-Replay: true`).
Reusing a key with a different request is `422 IDEMPOTENCY_KEY_REUSED`. (Creating API keys and
webhooks is exempt: their one-time secrets are never stored for replay.)

**Rate limiting.** 600 requests/minute per key (or session) by default (`GLIDEWORTH_RATE_LIMIT_PER_MIN`,
`0` = off). Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`; `429` carries `Retry-After`.

**Request size.** Bodies over `GLIDEWORTH_MAX_BODY_MB` (default 10 MiB) are refused with `413 PAYLOAD_TOO_LARGE`
before they are read; this covers `/api/*` and `/mcp`. A full household export is about 12 KB, so the limit
only matters for CSV text and very large imports.

**Partial updates.** Two flavours, both id-addressed:

- JSON Merge Patch (RFC 7386) on `PATCH` of any single resource (`PATCH /plans/{id}/expenses/{itemId}`
  with `{"amount": {"value": 6000}}`).
- JSON Patch (RFC 6902) on the whole plan (`PATCH /plans/{id}`, content type
  `application/json-patch+json`), with one extension: address array items by id, not index:
  `/income/[id=salary]/amount/value`.

## Authentication

There are two ways in, and they never interfere with each other:

|             | API key                                              | Browser session                           |
| ----------- | ---------------------------------------------------- | ----------------------------------------- |
| For         | scripts, integrations, MCP, Claude                   | the web app                               |
| Credential  | `Authorization: Bearer glideworth_<prefix>_<secret>` | passphrase login, then an httpOnly cookie |
| Scopes      | per key (`read`, `simulate`, `write`)                | the single owner: everything              |
| Writes need | nothing extra                                        | `X-CSRF-Token` header (see below)         |
| `/mcp`      | yes                                                  | **no** (MCP is bearer-only)               |

**Development** (`pnpm dev`): the Vite dev server proxies `/api` and injects `GLIDEWORTH_API_KEY` server-side
(the key is never in the browser bundle), so the browser needs no sign-in. The bootstrap key in `.env` is
inserted on first boot. The key in `.env.example` (`glideworth_devlocal_...`) is public, so with
`NODE_ENV=production` (`pnpm start`, Docker) the server **refuses to insert it** and logs a warning:
create a real key with `pnpm keys:create`.

**Production** (`pnpm start`, Docker): there is no proxy to inject a key, so the browser signs in with a
passphrase you choose on first run. API keys keep working for programmatic access.

### API keys

Every `/api/*` route and `/mcp` accepts `Authorization: Bearer glideworth_<prefix>_<secret>` (keys created
before the rename from Cairn, `cairn_<prefix>_<secret>`, keep working). Keys are stored
as a SHA-256 hash only; the secret is shown once at creation and is never logged.

| Scope      | Allows                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `read`     | `GET` everything, and run compute (simulations, solvers, insights): it only derives numbers from data the key can read |
| `simulate` | run compute and read job status/results, but **not** read raw data (a "calculator" key)                                |
| `write`    | all mutations (plans, finances, change sets, keys, webhooks, imports). Implies `read` and `simulate`                   |

A key can only mint keys with scopes it has itself, and a key never has more than its **user's role** allows (see
[Household collaboration](#household-collaboration)). Keys created before collaboration belong to the owner.
The last active `write` key cannot be revoked.

Create the first key with the bootstrap variable or the CLI:

```bash
# On first boot, if there are no keys, GLIDEWORTH_BOOTSTRAP_KEY is inserted with read+write.
export GLIDEWORTH_BOOTSTRAP_KEY=glideworth_devlocal_0123456789abcdef0123456789abcdef   # format: glideworth_<8 lowercase alnum>_<32+ alnum>
pnpm --filter @glideworth/api dev            # http://localhost:8787

pnpm keys:create -- --name laptop --scopes read,simulate   # prints a new key once
```

### Browser sign-in (production)

Public routes under `/api/v1/auth` (all documented in OpenAPI under the **Auth** tag):

| Route                                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/auth/status`                                 | `{ setupRequired, setupTokenRequired?, multiUser, authenticated, via?, user?: { id, name, role }, csrfToken?, expiresAt? }`. `multiUser` is true once the owner has invited someone: the login screen should then ask for a sign-in name. Call it on load: `setupRequired` -> show "choose a passphrase"; `authenticated: false` -> show login                                                                                                                                              |
| `POST /api/v1/auth/setup` `{ passphrase, setupToken? }`   | **First run only**: set the passphrase (12+ characters) and sign in. `409 ALREADY_CONFIGURED` afterwards. If the server has `GLIDEWORTH_SETUP_TOKEN`, the token must be sent too (status then reports `setupTokenRequired: true`), so a stranger cannot claim a fresh, reachable instance. Wrong tokens count against the login throttle below. Without a token the first visitor wins: the server logs a warning at start-up, so set one, or bind to `127.0.0.1`, until you have signed in |
| `POST /api/v1/auth/login` `{ passphrase, user? }`         | verify and open a session. `user` is the sign-in name; **omit it for the owner** (a single-user instance never needs it). `401` wrong passphrase (an unknown name looks the same), `429` throttled. Responses carry `user: { id, name, role }`                                                                                                                                                                                                                                              |
| `POST /api/v1/auth/accept` `{ token, passphrase }`        | accept an **invite** or a **passphrase reset**: choose a passphrase and be signed in. The token works once and expires after 7 days                                                                                                                                                                                                                                                                                                                                                         |
| `POST /api/v1/auth/logout-all`                            | end every session of the signed-in user (needs `X-CSRF-Token`)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /api/v1/auth/logout`                                | end the session and clear the cookies (needs `X-CSRF-Token`)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /api/v1/auth/change-passphrase` `{ current, next }` | change **your own**; every other session of yours is signed out and a fresh one is issued                                                                                                                                                                                                                                                                                                                                                                                                   |

How it works:

- **Hashing.** The passphrase is hashed with **scrypt** (N=32768, r=8, p=1, random 16-byte salt, parameters
  stored with the hash) and compared in constant time. Only the hash is stored (`auth_credentials`).
- **Session cookie.** `glideworth_session` is a random 256-bit token: `HttpOnly`, `SameSite=Strict`, `Path=/`,
  `Secure` over https (or when `X-Forwarded-Proto: https`; `GLIDEWORTH_COOKIE_SECURE` forces it). Only the
  token's SHA-256 is stored server-side (`auth_sessions`), so a database leak does not leak sessions.
- **Expiry.** Absolute lifetime `GLIDEWORTH_SESSION_TTL_HOURS` (default 168 = 7 days) and an idle timeout
  `GLIDEWORTH_SESSION_IDLE_HOURS` (default 24). Expired sessions are rejected and purged.
- **CSRF.** Login and setup return a `csrfToken` (also set as the readable `glideworth_csrf` cookie, which is
  useless without the session cookie). Every cookie-authenticated **write** must echo it as
  `X-CSRF-Token: <token>`, and if the request carries an `Origin` header it must match the server's host
  (or `GLIDEWORTH_WEB_ORIGIN`). `GET` needs no token. API-key requests are exempt.
- **Throttling.** Failed logins (and wrong setup tokens, and wrong `current` passphrases on change-passphrase) are limited per client (`GLIDEWORTH_LOGIN_MAX_ATTEMPTS`, default 5 per
  `GLIDEWORTH_LOGIN_WINDOW_MINUTES`, default 15) and globally (5x that, against distributed guessing). The
  response is `429 RATE_LIMITED` with `Retry-After`, **even for the right passphrase** until the window
  passes. Attempts are counted before the (slow) hash check runs, so a burst of parallel guesses cannot slip past the limit. A success clears the client's count. Behind a reverse proxy set `GLIDEWORTH_TRUST_PROXY=true` so the
  real client address is used.
- **CORS.** In production no other origin is trusted (the web app is same-origin). In development the Vite origin from `GLIDEWORTH_WEB_ORIGIN` (default `http://localhost:5173`) is allowed. Leave `GLIDEWORTH_WEB_ORIGIN` empty in production: a page on another localhost port is _same-site_, so it would otherwise be trusted with your session.
- Plan versions written from the browser are attributed to `{ kind: "user", label: "web app" }`.

```bash
curl -c jar -X POST $GLIDEWORTH/api/v1/auth/setup -H 'content-type: application/json' \
  -d '{"passphrase":"correct horse battery staple"}'            # first run
curl -b jar $GLIDEWORTH/api/v1/plans                                  # reads: cookie only
CSRF=$(awk '$6=="glideworth_csrf"{print $7}' jar)
curl -b jar -X PATCH $GLIDEWORTH/api/v1/plans/plan-main/expenses/exp-living \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -d '{"name":"Living"}'
```

From a browser the web app just uses `fetch` with same-origin credentials (the default) and sends
`X-CSRF-Token` from `GET /api/v1/auth/status` (or the `glideworth_csrf` cookie) on writes.

### Household collaboration

One instance can have several logins: the **owner** (created at first-run setup, exactly one) invites a partner
or a read-only adviser. The single-user path is unchanged: set a passphrase, sign in with the passphrase alone.

| Role                  | Can                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`               | everything, including users, webhooks, OAuth clients and the audit log                                                                      |
| `editor` (a partner)  | read, simulate and **write** (plans, finances, imports, share links, check-in schedule, their own API keys); not users, webhooks, audit log |
| `viewer` (an adviser) | **read and simulate only**: every route and MCP tool that writes is refused / absent                                                        |

Roles are instance-wide and enforced where scopes are: every route declares its scope, and a caller's scopes are
capped by their role (browser session, API key and OAuth token alike). A `viewer`'s `POST /plans` is
`403 FORBIDDEN` with `details: { required: "write", role: "viewer" }`; owner-only routes say `details.required: "owner"`.
Demoting or disabling a user takes effect on all their credentials at once (sessions end, keys are capped or refused).

| Route (owner only unless noted)                                   | Purpose                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /users`                                                      | people who can sign in: `{ items: [{ id, login, name, role, status: active\|invited\|disabled, createdAt, lastLoginAt }] }`                                                                                                                                                                                                               |
| `POST /users` `{ name, role: editor\|viewer, login? }`            | **invite**. Creates the user (status `invited`) and returns `{ user, invite: { token, kind: "invite", expiresAt } }`. Give the token to the person (put it in a link); they send it to `POST /auth/accept` with the passphrase they choose, so the owner never learns it                                                                  |
| `POST /users/{id}/invite`                                         | a fresh invite for someone who has not accepted yet                                                                                                                                                                                                                                                                                       |
| `PATCH /users/{id}` `{ name?, role?, disabled? }`                 | rename, change role, disable/enable. The owner cannot be demoted or disabled (`409 OWNER_PROTECTED`)                                                                                                                                                                                                                                      |
| `DELETE /users/{id}`                                              | remove a user (sessions, keys and OAuth grants go too; history keeps their name)                                                                                                                                                                                                                                                          |
| `POST /users/{id}/reset-passphrase`                               | **passphrase reset**: signs the user out everywhere and returns `{ user, reset: { token, expiresAt } }` for `POST /auth/accept`. The owner's own passphrase: `POST /auth/change-passphrase`, or on the server `pnpm cli reset-owner-passphrase` (prints a one-time token)                                                                 |
| `GET /audit-log?userId=&resourceType=&resourceId=&limit=&before=` | **who changed what**: `{ items: [{ id, at, userId, userName, via, credentialId, action, resourceType, resourceId, status, detail }], nextBefore }`. Every write by a user, key, OAuth client or MCP tool, plus refused writes (`status: 403`), sign-ins and consents. `action` is `METHOD /route/:pattern`, `mcp:<tool>` or an auth event |
| `GET /me` (any)                                                   | `{ keyId, name, scopes, via, userId, userName, role }`                                                                                                                                                                                                                                                                                    |
| `GET/POST /me/keys`, `DELETE /me/keys/{id}` (any role)            | your own API keys; scopes are capped by your role (a viewer can mint `read`/`simulate` keys for their own tools). Creating and revoking needs a signed-in session or a write key                                                                                                                                                          |
| `GET /keys`, `POST /keys`, `DELETE /keys/{id}` (editor)           | the owner sees all keys (`userId`, `userName` say whose); editors see and revoke only their own                                                                                                                                                                                                                                           |

**Who changed what in plan history.** Plan versions already carry an `actor`; it now names the person:
`{ kind: "user"\|"api-key"\|"mcp", id, label, userId, userName }` (a browser session is `kind: "user"` with the
person's name as `label`; an API key's label is `<key name> (<person>)` for non-owners). `GET /plans/{id}/versions`
therefore shows who made each edit; the audit log covers everything else.

Sign-in throttling is per client address and global (as before); the sign-in name does not weaken it.

## Running in production (one process, one port)

```bash
pnpm build           # core -> importers -> api (dist/) and the web bundle (apps/web/dist)
pnpm start           # NODE_ENV=production node apps/api/dist/server.js  -> http://localhost:8787
```

In production (`NODE_ENV=production`, set by `pnpm start` and the Docker image) the API server also
serves the built web app from `apps/web/dist` (override with `GLIDEWORTH_WEB_DIST`; force on/off with
`GLIDEWORTH_SERVE_WEB`):

- real files are served with `ETag`/`304`, hashed `/assets/*` with a one-year `immutable` cache,
  `index.html` with `no-cache`, plus `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`;
- any other extension-less `GET` (a client-side route like `/plans/plan-main`) falls back to
  `index.html` (SPA fallback); a missing asset is a real `404`;
- `/api/*`, `/mcp`, `/docs`, `/openapi.json` and `/health` are never shadowed by the shell;
- paths cannot escape the web directory.

On first start with an empty database open `http://localhost:8787/`, choose a passphrase and you are in.

**Docker.** One container, SQLite on a volume, health check:

```bash
docker compose up -d --build                  # http://localhost:8787 ; data in the cairn-data volume
docker compose exec glideworth node dist/cli/admin.js backup --out /data/backups/manual.db
docker build -t glideworth . && docker run -p 8787:8787 -v glideworth-data:/data glideworth
```

The image is a multi-stage build (deps -> build -> slim runtime, non-root `node` user, `/data` volume,
`HEALTHCHECK` on `/health`). Behind a TLS-terminating reverse proxy set `GLIDEWORTH_TRUST_PROXY=true` (and
leave `GLIDEWORTH_COOKIE_SECURE=auto`); set `GLIDEWORTH_SETUP_TOKEN` if the port is reachable by others before you
have chosen a passphrase.

**Backup, restore, seed.** (`pnpm` from the repo; `node dist/cli/admin.js ...` inside the container.)

```bash
pnpm backup                         # consistent online copy -> data/backups/glideworth-<timestamp>.db (a single file)
pnpm backup -- --out ~/glideworth.db
pnpm restore -- --from ~/glideworth.db --force   # STOP THE SERVER first; the old DB is kept as glideworth.db.pre-restore-<ts>
pnpm seed                           # load the synthetic UK sample household (hh-uk-sample) from @glideworth/core
pnpm seed -- --sample us --replace
```

Backups use SQLite's online backup API (safe while the server runs, WAL included), are integrity-checked,
and restoring migrates the file to the current schema. For a portable per-household export use
`GET /households/{id}/export`.

## Quick start (curl)

```bash
export GLIDEWORTH=http://localhost:8787
export KEY=glideworth_devlocal_0123456789abcdef0123456789abcdef
alias api='curl -s -H "Authorization: Bearer $KEY" -H "content-type: application/json"'   # interactive bash/zsh; in a script use a function

# Who am I?
api $GLIDEWORTH/api/v1/me

# The sample household and its plans. A fresh dev database is seeded with the synthetic US sample
# (hh-sample, plans plan-main and plan-early); every example below uses its ids. `pnpm seed` adds the
# UK sample (hh-uk-sample, uk-plan-main) to the database named by GLIDEWORTH_DB_PATH.
api $GLIDEWORTH/api/v1/households
api "$GLIDEWORTH/api/v1/plans?limit=5"

# Deterministic projection, compact: net worth and taxes every 5 years, in today's money
api -X POST $GLIDEWORTH/api/v1/plans/plan-main/simulate -d '{
  "view": { "basis": "real", "fromYear": 2030, "everyNYears": 5, "series": ["netWorth", "taxes"] }
}'

# Chance of success: an async job. ?wait=60 blocks until it finishes (otherwise you get 202 + a job).
# The response is the finished job; fetch the numbers from its result link (trials: 100 to 10000).
api -X POST "$GLIDEWORTH/api/v1/plans/plan-main/monte-carlo?wait=60" -d '{ "settings": { "trials": 1000 } }'
api $GLIDEWORTH/api/v1/jobs/<job id>/result

# Edit one number safely: read the version, then PATCH with If-Match (the version is the ETag; a fresh plan is at "1")
api -i $GLIDEWORTH/api/v1/plans/plan-main/expenses/exp-living | grep -i etag
api -X PATCH $GLIDEWORTH/api/v1/plans/plan-main/expenses/exp-living \
  -H 'If-Match: "1"' -d '{"amount": {"value": 5600, "basis": "real"}}'

# The integration use case: a budgeting tool pushes balances in one atomic call
api -X POST $GLIDEWORTH/api/v1/households/hh-sample/balances \
  -H 'Idempotency-Key: sync-2026-11-15' -d '{
    "accounts": [{"accountId": "acc-cash", "balance": 31250.40}, {"accountId": "acc-brokerage", "balance": 171904.12}],
    "debts": [{"debtId": "debt-car", "balance": 8120}]
  }'
```

## Route groups

All paths are under `/api/v1`. The OpenAPI document lists every operation with its schemas; this is
the map.

| Group                        | Routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth** (public)            | `GET /auth/status`; `POST /auth/setup`, `/auth/login`, `/auth/accept`, `/auth/logout`, `/auth/logout-all`, `/auth/change-passphrase`                                                                                                                                                                                                                                                                                                                                                                          |
| **Users & audit**            | `/users` (invite, role, disable, reset), `GET /audit-log`, `GET /me`, `/me/keys`, `/me/oauth-grants`: see [Household collaboration](#household-collaboration)                                                                                                                                                                                                                                                                                                                                                 |
| **Share links**              | `POST /plans/{id}/share-links`, `GET /share-links`, `DELETE /share-links/{id}`, `POST /share-links/{id}/refresh`; public `GET /shared/{token}`: see [Share links](#share-links)                                                                                                                                                                                                                                                                                                                               |
| **Check-ins**                | `GET/PATCH /schedule`, `POST /plans/{id}/checkins`, `GET /plans/{id}/health`, `GET /plans/{id}/changes-since-checkin`, `GET /notifications`, `POST /notifications/read`: see [Scheduled check-ins](#scheduled-check-ins)                                                                                                                                                                                                                                                                                      |
| **FX rates**                 | `GET/PUT/POST /households/{id}/fx-rates`, `DELETE /households/{id}/fx-rates/{FROM-TO}`: see [Multi-currency](#multi-currency)                                                                                                                                                                                                                                                                                                                                                                                 |
| **OAuth**                    | `/.well-known/oauth-*`, `/oauth/*` (protocol), `GET /oauth/clients`, `DELETE /oauth/clients/{id}`: see [OAuth for remote MCP clients](#oauth-for-remote-mcp-clients)                                                                                                                                                                                                                                                                                                                                          |
| **Households & people**      | `GET/POST /households`; `GET/PUT/PATCH/DELETE /households/{id}`; `/households/{id}/people[/{personId}]` and `/dependents[/{id}]` (CRUD; adding a second person switches the household to couple mode)                                                                                                                                                                                                                                                                                                         |
| **Finances**                 | `/households/{id}/accounts`, `/real-assets`, `/debts` (list, create, get, PUT, PATCH, DELETE by id; delete is `409 IN_USE` while a plan references the item, unless `force=true`; prefer `archived: true`); `POST /households/{id}/balances` (bulk update); **`PUT /households/{id}/current-finances`** (whole document, atomic); **`PUT /households/{id}/reorder/{accounts\|real-assets\|debts\|plans}`** (display order)                                                                                    |
| **Plans**                    | `GET/POST /plans`; `GET/PUT/PATCH/DELETE /plans/{id}`; `POST /plans/{id}/duplicate`, `/archive`, `/unarchive`, `/set-main`                                                                                                                                                                                                                                                                                                                                                                                    |
| **Plan collections**         | `/plans/{id}/income`, `/expenses`, `/milestones`, `/flows`, `/planned-accounts`, `/planned-real-assets`: list, add (`id` optional, `?index=`), get, PUT, PATCH, DELETE by id; `PUT /plans/{id}/reorder/{collection}` (flows: the order is the funding priority)                                                                                                                                                                                                                                               |
| **Plan settings**            | singletons with GET/PUT/PATCH/DELETE: `/assumptions`, `/tax-settings`, `/withdrawal-strategy`, `/drawdown`, `/flex-spending`, `/risk-guardrails`, `/tax-strategy`, `/monte-carlo-settings`, `/leftover` (DELETE removes optional ones, resets the others to defaults)                                                                                                                                                                                                                                         |
| **History & undo**           | `GET /plans/{id}/versions`, `GET .../versions/{n}`, `GET .../versions/{n}/diff?against=current`, `POST .../versions/{n}/restore` (writes the old body as a **new** version; history is append-only)                                                                                                                                                                                                                                                                                                           |
| **Branches**                 | `POST /plans/{id}/branches`, `GET /plans/{id}/branches`, `GET /plans/{id}/diff` (branch vs parent, with outcomes), `POST /plans/{id}/merge`                                                                                                                                                                                                                                                                                                                                                                   |
| **Change sets**              | `POST /plans/{id}/change-sets` (propose), `GET /plans/{id}/change-sets`, `GET /change-sets/{id}`, `POST /change-sets/{id}/apply`, `POST /change-sets/{id}/discard`, `POST /plans/{id}/preview` (what-if, stores nothing)                                                                                                                                                                                                                                                                                      |
| **Simulation**               | `POST /plans/{id}/simulate`, `POST /simulate` (stateless), `POST /plans/{id}/monte-carlo`, `/historical`                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Solvers**                  | `POST /plans/{id}/solve/max-spending`, `/earliest-retirement`, `/required-savings`, `/required-portfolio`, `/safe-withdrawal-rate`, `/goal-seek`, `/tax-strategy`                                                                                                                                                                                                                                                                                                                                             |
| **Insights**                 | `POST /plans/{id}/insights/explain`, `/explain-year`, `/explain-years`, `/explain-difference`, `/audit`, `/sensitivity`, `/guardrails`, `/guyton-klinger`, **`/income-by-tax-rate`**, **`/strategy-matrix`** (job); `GET /plans/{id}/tax-breakdown`; `POST /insights/compare`                                                                                                                                                                                                                                 |
| **Assets abroad**            | `GET /plans/{id}/cross-border/items`, `POST /plans/{id}/insights/explain-taxation`, `GET /plans/{id}/tax-breakdown/by-country`; rule tables `GET /cross-border/countries`, `/cross-border/non-resident-rules/{country}`, `/cross-border/treaties[?country=]`, `/cross-border/treaties/{a}/{b}`, `/cross-border/wrappers?residence=&accountCountry=`, `/cross-border/simplifications?countries=`, `POST /cross-border/explain`: see [Assets in another country](#assets-in-another-country-cross-border-plans) |
| **Scenarios**                | `GET /scenarios/templates`; `POST /plans/{id}/scenarios/{templateId}/preview`, `.../branch`; `GET /plans/{id}/scenarios/survivor`                                                                                                                                                                                                                                                                                                                                                                             |
| **Jobs**                     | `GET /jobs`, `GET /jobs/{id}`, `GET /jobs/{id}/result`, `GET /jobs/{id}/events` (SSE), `POST /jobs/{id}/cancel`                                                                                                                                                                                                                                                                                                                                                                                               |
| **Progress**                 | `/households/{id}/snapshots` (list, create, get, PUT, PATCH, DELETE), `POST .../snapshots/record` (from current finances), `POST .../snapshots/bulk`                                                                                                                                                                                                                                                                                                                                                          |
| **Data**                     | `GET /households/{id}/export` (also `/document`), `POST /import` (Glideworth or ProjectionLab; `dryRun`), `POST /households/{id}/import/csv` (+ `/analyze`), `GET /plans/{id}/export/tables/{table}`, `GET /households/{id}/export/progress`, `GET /plans/{id}/report`                                                                                                                                                                                                                                        |
| **Settings, keys, webhooks** | `GET/PUT/PATCH /settings`; `GET/POST /keys`, `DELETE /keys/{id}` (revoke); `/webhooks` CRUD (owner), `/webhooks/{id}/ping`, `/webhooks/{id}/deliveries`; webhook events: `plan.updated`, `simulation.completed`, `snapshot.created`, `snapshot.updated`, `checkin.completed`, `notification.created`, `webhook.ping`                                                                                                                                                                                          |

## Web app endpoints

What the browser client needs beyond the per-item CRUD:

**Save the whole current-finances document atomically.** `PUT /api/v1/households/{id}/current-finances`
with `{ "household": {...}?, "finances": {...} }` replaces the people/dependents (when `household` is
given) and every account, real asset and debt in **one** validated, all-or-nothing write; invalid input
or a stale `If-Match: "<household version>"` changes nothing (`400` / `409 VERSION_CONFLICT`). The
response is `{ household, finances, version, snapshot }` with the new version also in `ETag`. The same
body is accepted by `PUT /households/{id}` (a bare `Household` still works there too). One save bumps the
version once, however many items changed.

**Display order.** `PUT /api/v1/households/{id}/reorder/{collection}` with `{ "ids": ["acc-b", "acc-a"] }`,
`collection` one of `accounts`, `real-assets`, `debts`, `plans`. Listed ids come first in that order; the
rest keep their relative order after them; an unknown id is a `404` with `details.unknownIds` and changes
nothing. For finances the order is the array order of the stored document (so `GET .../accounts`, exports
and the web app all agree; `If-Match` is the household version; no snapshot is created). Plans keep a
per-household `sortOrder`: `GET /plans?householdId=` and the document export follow it, new plans go last,
edits do not reset it. Both return the resulting order of every id.

**Progress snapshots.** The routes are exactly:

|                                                                   |                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------- |
| `GET /api/v1/households/{id}/snapshots?from=&to=&limit=&cursor=`  | list (newest first)                                |
| `POST /api/v1/households/{id}/snapshots`                          | create with explicit values                        |
| `POST /api/v1/households/{id}/snapshots/record`                   | snapshot **current finances** (`{ date?, note? }`) |
| `POST /api/v1/households/{id}/snapshots/bulk`                     | backfill (`{ items, onConflict }`)                 |
| `GET/PUT/PATCH/DELETE /api/v1/households/{id}/snapshots/{snapId}` | one snapshot                                       |

There is no `/api/v1/progress` route; the web client already calls the paths above, so no alias is needed.

**Auto-snapshots: at most one per day per household.** A finance write that moves a balance (account,
real asset, debt, bulk `balances`, `current-finances`, CSV import) no longer creates a snapshot each time.
When `settings.autoProgressSnapshots` is `true` (the default) the household's automatic snapshot for
**today** is created, or **updated in place** (same id, new values) if it already exists, so the day has
one. `snapshot.created` fires once; each update fires `snapshot.updated`. A manual / `api` / import
snapshot already dated today is the user's own record and is left alone. With the setting `false`
nothing is recorded automatically; `recordSnapshot: true` on `POST .../balances` still records one.
Writes that move no balance (renames, reordering, people) never snapshot.

## Simulation

### Deterministic projection

`POST /plans/{id}/simulate` runs the deterministic engine. Without `view` you get the full
`ProjectionResult` (every period, ledger and trace: large). With `view` you get a small
`CompactProjection`:

```json
{
  "trace": "off",
  "view": {
    "basis": "real",
    "fromYear": 2030,
    "toYear": 2060,
    "everyNYears": 5,
    "series": ["netWorth", "liquidNetWorth", "spending", "taxes", "shortfall"],
    "accountIds": ["acc-brokerage"],
    "include": ["summary", "milestones", "warnings"]
  }
}
```

`series` is any of `netWorth, liquidNetWorth, assets, liabilities, portfolio, cash, realAssets, income,
passiveIncome, expenses, spending, taxes, contributions, withdrawals, savingsRate, withdrawalRate,
shortfall`. Compact money is rounded to whole units.

`POST /simulate` is stateless: send a full `SimulationInput`, nothing is stored.

**Caching.** Results are cached in `simulation_runs`, keyed by plan id + **plan version** + options
hash (which includes the household version, because "live" plans read current finances) + engine
version. Any edit bumps the version, so entries are never stale. Compact views report `meta.cached`.

**Schema migration on read.** Every stored plan body is read through `@glideworth/core`'s `migratePlan` with
the `schema_version` it was written with, so a future schema bump upgrades old rows lazily (no data
migration to run).

### Async jobs: Monte Carlo, historical, solvers, guardrails, tax strategy

These run in Node **worker threads** (`GLIDEWORTH_MAX_JOBS` at a time, default 2) and return **`202`** with
a job:

```bash
api -X POST $GLIDEWORTH/api/v1/plans/plan-main/monte-carlo -d '{"settings": {"trials": 2000, "method": "historical-random-restart"}}'
# => { "id": "job_...", "status": "running", "progress": 0.12, "links": { "self": ..., "result": ..., "events": ..., "cancel": ... } }
```

- **Sharded Monte Carlo.** One run is split across several worker threads: each runs a slice of the
  trials (`runMonteCarloShard`), the slices are merged (`mergeMonteCarloShards`) and summarised
  (`summarizeMonteCarlo`). The result is identical to a single-threaded run with the same seed. Shards =
  `min(CPUs, 4)` (`GLIDEWORTH_MC_SHARDS` overrides, `1` disables), never fewer than 200 trials each, so small
  runs stay on one thread. `historical-sequential` (a data-driven trial count) is never split.
  This works in the built server and the Docker image, not only in dev.
- **Poll**: `GET /jobs/{id}` -> `status` (`queued|running|succeeded|failed|cancelled`), `progress` 0..1.
- **Stream**: `GET /jobs/{id}/events` is Server-Sent Events (`status`, `progress`, then `done`; data is the
  job JSON). Browsers' `EventSource` cannot set the `Authorization` header but does send the session
  cookie, so the web app can use it directly; elsewhere use `curl -N` or `fetch` streaming.
- **Result**: `GET /jobs/{id}/result`. Monte Carlo/historical results are thinned by default
  (`detail=summary`: p10/p50/p90 net-worth fan every 5 years, no per-trial rows). Use `?detail=full`,
  `?metrics=netWorth,spending`, `?percentiles=0.05,0.5,0.95`, `?everyNYears=1` to ask for more.
- **Wait**: `?wait=<seconds>` (max 120) on the start request blocks until the job finishes and
  responds `200` with the finished job.
- **Cancel**: `POST /jobs/{id}/cancel` terminates every worker thread of the job (in-process runs stop
  between trial chunks via the async runner).
- A failed job carries the typed error (`error.code`, `error.details`): e.g. `NOT_IMPLEMENTED` with the
  workstream that owns the missing feature. Jobs interrupted by a restart become `failed` with
  `INTERRUPTED`.
- **Determinism.** Unless you pass `settings.seed` (or the plan sets one), a fixed default seed is used,
  so "same plan, change one number" comparisons share random draws and repeat requests are cache hits
  (`cached: true`). `"randomSeed": true` draws a fresh seed and bypasses the cache.

### Solvers

All are async jobs with the same `?wait=` / `monteCarlo` override (`{"monteCarlo": {"trials": 200}}` makes
them faster and noisier) and `maxEvaluations`:

| Route                        | Body (besides `targetSuccessRate`)             | Answers                                           |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `solve/max-spending`         | `expenseIds?`                                  | how much can I spend                              |
| `solve/earliest-retirement`  | `milestoneId`                                  | earliest retirement month                         |
| `solve/required-savings`     | `flowId`                                       | how much must I save                              |
| `solve/required-portfolio`   | `accountIds?`                                  | how much do I need (a scale on invested balances) |
| `solve/safe-withdrawal-rate` | `years?` (30), `accountIds?`                   | highest constant withdrawal rate                  |
| `solve/goal-seek`            | `variable`, `objective`, `direction`, `bounds` | any variable vs any objective                     |
| `solve/tax-strategy`         | `objective?`, `candidates?`                    | rank tax strategies (below)                       |

`insights/guardrails` evaluates the plan's `riskGuardrails` (or ones in the body; `monteCarlo` overrides
apply: it runs many simulations).

### Insights

- `explain`: findings from the engine trace and ledger ("why did the plan fail / why did this withdrawal
  come from that account"). Optional `question`.
- `explain-year` `{ year | periodIndex, basis?, detail? }`: where the money went in one year: income,
  outflows, saving, withdrawals by account, investment return, net-worth change, as sentences plus top line
  items (`detail: "full"` adds the ledger/trace evidence). `explain-years` does a range
  (`fromYear`, `toYear`, `everyNYears`).
- `explain-difference` `{ otherPlanId, attribute?, metric? }`: the plan in the path is the baseline. A diff,
  an explanation and (with `attribute`) how much of the outcome change each individual edit explains, by
  replaying each edit alone, plus the interaction left over. `metric: "successRate"` is an async job.
- `audit`: modelling mistakes (double-counted housing, real/nominal mix-ups, implausible returns, ...)
  with severities and counts; result-based checks (penalties, spending drops, cash drag) run when the
  plan projects.
- `sensitivity`: tornado data; `metric` is `endNetWorthReal` (default, instant), `lifetimeTaxesReal`,
  `totalShortfallReal` or `successRate` (Monte Carlo: async job).
- `guyton-klinger`: money-terms guardrails (portfolio below which to cut / above which to raise, the
  action now). Defaults from the plan's first year; pass `portfolio`, `spending`, `initialRate`,
  `guardrail` (0.2), `adjustment` (0.1) to override.
- `compare`: 2-6 plans side by side (first = baseline), what differs, optional explanations.
- `tax-breakdown`: taxes per year by jurisdiction and kind, effective/marginal rates. Cross-border plans
  also get `totals.byCountry` / `totals.byBasis`, per-year `byCountry`, and `basis`, `country`,
  `personId` on lines (`detail=lines`); single-country output is unchanged.
- `solve/tax-strategy`: ranks candidate strategies (UK: drawdown order, using the personal allowance in
  gap years, tax-free lump sum timing; US: drawdown order and bracket filling) by `objective`
  (`endNetWorthReal`, `lifetimeTaxesReal`, `successRate`), or your own `candidates: [{id, label, patch}]`.
  The result has `baseline`, `ranked`, `best` (with the plan `patch` that applies it) and an explanation;
  candidates the engine cannot model are reported `unsupported`, not skipped.

### What-if scenarios

Templates turn a few parameters into a plan patch (ops). Preview shows what it would do; branch stores it.

```bash
api $GLIDEWORTH/api/v1/scenarios/templates                      # id, title, params + JSON Schema
api -X POST $GLIDEWORTH/api/v1/plans/plan-main/scenarios/market-crash/preview \
  -d '{"params": {"year": 2035, "drop": 0.4}}'              # ops, changes, before/after; stores nothing
api -X POST $GLIDEWORTH/api/v1/plans/plan-main/scenarios/early-retirement/branch \
  -d '{"params": {"years": 2}, "name": "Retire two years earlier"}'   # write scope; the parent is untouched
api "$GLIDEWORTH/api/v1/plans/plan-main/scenarios/survivor?ages=70,80,90&evaluate=true"
```

Templates: `market-crash`, `job-loss`, `career-break`, `early-retirement`, `downsizing`, `child`,
`inheritance`, `long-term-care`, `survivor`. Unknown template `404`; bad parameters `400`. Survivor
scenarios cover each partner at each age (couples only; empty for one person) and carry notes: survivor
benefits are **not** added automatically.

## Assets in another country (cross-border plans)

The household lives in one country, `Household.location`, for the whole plan; Glideworth does not model moving
country. Every account, property, debt and income can have a country of its own, so a household in Spain can keep
a UK pension and a let flat in London. When the plan estimates taxes and something is in another country (or a US
citizen or green-card holder lives outside the US), the other country taxes it as a non-resident and the household's
country gives relief under the treaty. See docs/ARCHITECTURE.md §4.6 for the model and docs/USER-GUIDE.md for the
user's view.

**Where it is set.** Account `jurisdiction`, `RealAsset.country` / `acquiredOn` / `valuations`, `Debt.country`,
income `country` / `governmentService` and salary `endOfService` go through the usual finance and plan routes.
`Person.citizenships` and `usGreenCard` are fields of the person
(`PUT/PATCH /households/{id}/people/{personId}`).

**Tax by country and basis.** `GET /plans/{id}/tax-breakdown/by-country?basis=real&fromYear=&toYear=`:
lifetime `totals.rows` (`{country, basis, amount}`), `totals.byCountry`, `totals.byBasis`, per-year rows,
the basis glossary and the simplifications that apply. `basis` is one of `residence` (the household's country),
`source` (another country taxing a non-resident), `citizenship` (US persons abroad) and `relief` (negative: the
credit for tax paid elsewhere). Plans with nothing abroad answer `crossBorder: false` with one residence row.

**How is this taxed and why.** `POST /plans/{id}/insights/explain-taxation {itemId, year?}` for an
account, real asset, debt or income: the item's country and currency, the country the household lives in,
and per income category the non-resident rule, the treaty article, the residence country's view of a foreign
wrapper, whether each side taxes and the relief; `warnings` for unknown treaty pairs and unrecognised wrappers;
`citizenship` for US persons abroad. Unknown ids are a 404 listing the plan's cross-border items
(`GET /plans/{id}/cross-border/items`).

**Rule tables** (read scope, no plan needed): `GET /cross-border/countries`,
`/cross-border/non-resident-rules/{country}` (404 lists the countries that have rules),
`/cross-border/treaties`, `/cross-border/treaties/{a}/{b}` (`residentIn<A>` / `residentIn<B>` decisions per
category, or `known: false` with the fallback), `/cross-border/wrappers?residence=US&accountCountry=GB`,
`POST /cross-border/explain {residence, source, category, accountType?}`,
`/cross-border/simplifications?countries=GB,AE`.

**Audit.** `POST /plans/{id}/insights/audit` includes the cross-border checks: `XB_FOREIGN_ASSET_BASE_CURRENCY`,
`XB_MISSING_FX`, `XB_TAX_FX_MISSING`, `XB_WRAPPER_NON_RESIDENT_CONTRIBUTIONS`, `XB_UNKNOWN_TREATY`.

**Caching.** Results are cached per plan version, options, household version and engine version (0.6.0);
rows from another engine version are never served.

**Stored plans from before 2026-11-19.** Plans, documents and branch patches saved with a residency timeline,
relocation milestone effects, past residence or state-pension records are migrated when they are read
(document schema version 2): those fields are dropped and the household stays at its location.

Validation messages name the failing fields everywhere (`validation failed: income.0.amount.value: ...`), and
a Glideworth import whose plans name another household is a 422 saying which `householdId` to set.

## Change sets: how agents make safe edits

A change set is a proposed list of RFC 6902 ops against one plan version. Proposing it changes
nothing: you get the human-readable diff and a before/after simulation summary. Then you apply it or
discard it.

```bash
# 1. Propose (nothing is written to the plan)
api -X POST $GLIDEWORTH/api/v1/plans/plan-main/change-sets -d '{
  "summary": "Raise travel budget to 15k/yr",
  "rationale": "User asked to travel more in early retirement",
  "ops": [{ "op": "replace", "path": "/expenses/[id=exp-travel]/amount/value", "value": 15000 }]
}'
# => { "id": "cs_...", "status": "proposed", "baseVersion": 1,
#      "changes": [{ "description": "Travel raised from 9,000 to 15,000 per year", ... }],
#      "preview": { "before": { "endNetWorthReal": ..., "depletionYear": null, ... },
#                   "after":  { "endNetWorthReal": ..., "depletionYear": 2071, ... } } }

# 2. Review it with the user, then apply (atomic; writes a plan version attributed to your key)
api -X POST $GLIDEWORTH/api/v1/change-sets/cs_.../apply

# ...or discard it
api -X POST $GLIDEWORTH/api/v1/change-sets/cs_.../discard
```

- If the plan changed after the proposal, apply fails with `409 CHANGESET_CONFLICT`
  (`details.baseVersion`, `details.currentVersion`) and the set is marked `conflict`: re-read the plan
  and propose again. Nothing is ever merged silently.
- Proposing against a stale `baseVersion`, or with an op whose path does not exist, fails immediately
  (`VERSION_CONFLICT` / `PATCH_CONFLICT`, a `409`).
- Every apply writes a `plan_versions` row (`GET /plans/{id}/versions`) with the actor, the message
  and the `changeSetId`.
- `POST /plans/{id}/preview` runs the same what-if without storing a change set.
- Undo = `POST /plans/{id}/versions/{n}/restore` (a new version holding the old content).
- For exploratory scenarios use a **branch** (`POST /plans/{id}/branches` with an optional initial
  `patch`, or a what-if template): it stores only its differences from the parent, follows the parent (or
  pins its version), is re-materialised whenever the parent changes, and can be merged back or promoted.

### Worked example: an agent edits a plan safely

The user asks an agent: "Can I spend 500 more a month on dining?" The agent uses a key with `read`+`write`
(`pnpm keys:create -- --name agent --scopes read,write`). The numbers below are illustrative.

```bash
KEY=glideworth_agent000_...   # read+write
api() { curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' "$@"; }

# 1. Read the plan and note its version and the ids of what to change.
api $GLIDEWORTH/api/v1/plans/plan-main/expenses/exp-living -i | egrep -i '^etag|"amount"'
#   ETag: "4"          amount: { value: 5200, basis: "real" }, frequency: "monthly"

# 2. Ask "what if" first. Nothing is stored.
api -X POST $GLIDEWORTH/api/v1/plans/plan-main/preview -d '{
  "ops": [{ "op": "replace", "path": "/expenses/[id=exp-living]/amount/value", "value": 5700 }]
}'
#   => changes: [{ path, kind: "changed", entity, before: 5200, after: 5700,
#                  description: "Living expenses changed from 5,200 to 5,700 a month" }],
#      preview: { before: { endNetWorthReal: 910000, depletionYear: null },
#                 after:  { endNetWorthReal: 802000, depletionYear: null } }

# 3. Propose it as a change set, against the version that was read (baseVersion 4).
api -X POST $GLIDEWORTH/api/v1/plans/plan-main/change-sets -d '{
  "summary": "Living expenses +500/month (dining)",
  "rationale": "User asked about spending 500/month more on dining",
  "baseVersion": 4,
  "ops": [{ "op": "replace", "path": "/expenses/[id=exp-living]/amount/value", "value": 5700 }]
}'
#   => { "id": "cs_9f2c...", "status": "proposed", "baseVersion": 4, "changes": [...], "preview": {...} }

# 4. SHOW THE USER the changes and before/after; apply only after they agree.
api -X POST $GLIDEWORTH/api/v1/change-sets/cs_9f2c.../apply
#   => { "changeSet": { "status": "applied" }, "plan": { "version": 5 } }

# If someone edited the plan between 3 and 4 the apply is refused, nothing is merged:
#   409 { "error": { "code": "CHANGESET_CONFLICT", "details": { "baseVersion": 4, "currentVersion": 5 } } }
# -> re-read, propose again.

# 5. Undo, if the user changes their mind: the apply is in the history under the agent's identity.
api $GLIDEWORTH/api/v1/plans/plan-main/versions            # actor: { kind: "api-key", label: "agent" }, changeSetId
api -X POST $GLIDEWORTH/api/v1/plans/plan-main/versions/4/restore -d '{}'   # writes version 4's content as version 6
```

The same flow over MCP (`preview_changes` -> `propose_change_set` -> `apply_change_set`) is in
[MCP.md](./MCP.md#worked-example-an-agent-edits-a-plan-safely-via-a-change-set).

## Export and import

```bash
# Full backup of one household (GlideworthDocument, schema version 2: household, finances, plans, progress, settings)
api $GLIDEWORTH/api/v1/households/hh-sample/export > backup.json

# Restore into a clean database (409 if the household exists, unless "mode": "replace")
api -X POST $GLIDEWORTH/api/v1/import -d "{\"data\": $(cat backup.json)}"

# ProjectionLab export: dryRun first to see issues and per-entity counts without writing anything
api -X POST $GLIDEWORTH/api/v1/import -d "{\"format\": \"projectionlab\", \"dryRun\": true, \"data\": $(cat pl-export.json)}"
```

`mode` is `create` (default; `409` if the household exists), `replace` (the document becomes the household; plans
and snapshots that are not in it are removed) or `merge` (the household, finances and the plans in the document
are updated; everything else is kept; settings are left alone). **Plan version history is preserved**: a plan
that already exists keeps every earlier version and the import is recorded as its next version (message
`imported`, actor = who imported); a new plan starts at version 1 with an `imported` entry. A household that is
replaced or merged keeps counting its version (ETag) upward.

**Imports run in a worker thread.** The document import (`POST /import`), the CSV routes (`import/csv`,
`import/csv/analyze`) are parsed, analysed and previewed in a separate thread (and so are
the MCP import tools), so a large or crafted file does not hold up other requests. The request waits for the result;
an apply is then written in one transaction. Limits:

| Situation                                                                                                                                       | Answer                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| The import runs longer than 15 s (`GLIDEWORTH_IMPORT_TIMEOUT_SECONDS`)                                                                          | `422 IMPORT_TIMEOUT` (`details.limitSeconds`); the thread is stopped and nothing is written. Import a smaller file or a shorter date range |
| The import needs more than 512 MiB of memory (`GLIDEWORTH_IMPORT_WORKER_MAX_MB`)                                                                | `422 IMPORT_OUT_OF_MEMORY`; nothing is written                                                                                             |
| Every import thread is busy (default min(2, CPUs - 1); `GLIDEWORTH_IMPORT_WORKERS`) and 8 more imports already wait (`GLIDEWORTH_IMPORT_QUEUE`) | `503 IMPORT_BUSY` with `Retry-After: 5`                                                                                                    |
| The workspace already has 2 imports running                                                                                                     | `429 RATE_LIMITED` with `Retry-After: 5`                                                                                                   |
| The household changed between reading it and writing the import (`dryRun: false`)                                                               | `409 VERSION_CONFLICT`; nothing is written. Run the import again                                                                           |

The two `422`s depend on the file, so retrying the same file does not help; `503` and `429` are worth retrying.

### CSV import (dry run first)

`POST /households/{id}/import/csv` takes `{ text, kind, options?, planId?, dryRun? }` where `kind` is
`account-balances`, `progress-snapshots` or `transactions` (summarised into annual expense events on
`planId`). **`dryRun` defaults to `true`**: you get the delimiter/preset/column analysis, issues and, for
balances, a reconciliation of matched / created / unmatched accounts with before/after balances; nothing is
written. Repeat with `"dryRun": false` to apply atomically (finances, snapshots and the plan in one
transaction; blocking errors are `422 IMPORT_FAILED` and change nothing).

```bash
api -X POST $GLIDEWORTH/api/v1/households/hh-sample/import/csv -d '{
  "kind": "account-balances",
  "text": "Account,Balance,Date\nHigh-yield savings,31000,2026-11-15\nCar loan,11000,2026-11-15\n",
  "options": { "accountMap": { "Cash ISA": "uk-isa" }, "createMissing": false }
}'
api -X POST $GLIDEWORTH/api/v1/households/hh-sample/import/csv/analyze -d '{ "kind": "progress-snapshots", "text": "..." }'
```

### Table and report exports

```bash
api "$GLIDEWORTH/api/v1/plans/plan-main/export/tables/year-by-year?basis=real"           # JSON table
api "$GLIDEWORTH/api/v1/plans/plan-main/export/tables/taxes?format=csv" > taxes.csv      # CSV download
api "$GLIDEWORTH/api/v1/households/hh-sample/export/progress?format=csv" > progress.csv
api "$GLIDEWORTH/api/v1/plans/plan-main/report?basis=real&tableEvery=5"                  # printable report as data
```

Tables: `year-by-year`, `cash-flow`, `taxes`, `account-balances` (money rounded to 2 dp in the requested
basis). The report carries key figures, milestones, series, the year table, current finances,
assumptions and standing caveats; the web app renders it.

## Progress snapshots and balances

`POST /households/{id}/balances` updates many balances atomically (an unknown id changes nothing and
returns `404` with `details.unknownIds`), can move `asOf`, and records a progress snapshot when asked or
per the daily auto-snapshot rule above. It updates **accounts** (`accounts[].balance`, `costBasis`,
`contributionBasis`), **real assets** (`realAssets[].currentValue` and/or **`loanBalance`**, the mortgage paying
down) and **debts** (`debts[].balance`). For a mortgage, send `realAssets: [{ assetId, loanBalance }]`, or the
asset id in `debts: [{ debtId: <assetId>, balance }]`; an asset without a loan is `422 SCENARIO`.

A household created without `finances` (`POST /households` with only `household`) has empty balances dated
**this month**, so plans that follow live finances start now. `POST .../snapshots/bulk` backfills history, and
`POST .../snapshots/record` snapshots the current finances.

## Share links

Give someone (an adviser, a friend) a link to a plan's **results** without an account. The link serves a
**snapshot of computed results** taken when the link is created (`POST /share-links/{id}/refresh` retakes it):
the plan name, a summary (chance of success, retirement and FI year, funded or not), the reached milestones
(life-expectancy ones are left out: they name a person) and a year-by-year table. It never contains the
household, people, accounts, balances, settings or other plans, and the public route never computes, so an
anonymous caller costs nothing.

| Route                                                                                                                                                                          | Purpose                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /plans/{id}/share-links` (editor) `{ label?, privacy: full\|percent\|hidden = full, basis: real\|nominal = real, expiresInDays: 1-365 = 30, includeSuccessRate = true }` | `201 { link, token, path: "/share/<token>", apiPath: "/api/v1/shared/<token>" }`. The **token is shown once** (256 random bits; only a hash is stored)                                                                                          |
| `GET /share-links?planId=` (editor)                                                                                                                                            | `{ items: [{ id, planId, label, privacy, basis, createdAt, expiresAt, revokedAt, status: active\|expired\|revoked, snapshotAt, viewCount, lastViewedAt, createdBy }] }`                                                                         |
| `DELETE /share-links/{id}` (editor)                                                                                                                                            | **revoke**: it stops working at once (returns the link)                                                                                                                                                                                         |
| `POST /share-links/{id}/refresh` (editor)                                                                                                                                      | retake the snapshot; token and expiry stay                                                                                                                                                                                                      |
| `GET /shared/{token}` (**public**, rate limited)                                                                                                                               | the snapshot: `{ kind: "glideworth-shared-plan", version, generatedAt, expiresAt, label, plan: { name }, privacy, currency?, unit, basis, summary, milestones, years: [{ year, funded, netWorth, portfolio, income, spending, taxes }], note }` |

Privacy: `full` = amounts in the household currency (`unit: "currency"`). `percent` = every amount is a
percentage (1 dp) of the plan's **starting net worth**, no currency (`unit: "percent-of-starting-net-worth"`; needs
a positive starting net worth, else `422`). `hidden` = every amount is `null`; success rate, years, `funded`
flags and milestones remain.

The public route returns `404 NOT_FOUND` for unknown, expired and revoked tokens alike, is limited to
`GLIDEWORTH_SHARE_RATE_LIMIT_PER_MIN` (default 60) requests per client address (`429` + `Retry-After`), sends
`Cache-Control: no-store` and `X-Robots-Tag: noindex`. A share token is not an API credential: it opens no
other route. The web app serves its own page at `/share/<token>` on top of the JSON.

## Scheduled check-ins

An in-process scheduler (a plain timer; nothing external) re-runs the **main active plan of every household**
on a cadence (default weekly, on unless `GLIDEWORTH_SCHEDULER=false`; the first run is a baseline): the projection, the
Monte Carlo chance of success and the assumption audit. Each run is one row of the **plan health history**.

| Route                                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /schedule` / `PATCH /schedule` (write)                | `{ enabled, cadence: daily\|weekly\|monthly\|quarterly, intervalHours?, thresholds: { successRateDelta = 0.05, milestoneSlipMonths = 6, netWorthBehindPlan = 0.1 }, monteCarloTrials?, lastRunAt, nextRunAt, running }`                                                                                                                                                                                           |
| `POST /plans/{id}/checkins` (write)                        | check in now (waits for Monte Carlo): `{ health, previous, changes, notifications }`                                                                                                                                                                                                                                                                                                                              |
| `GET /plans/{id}/health?limit=&since=`                     | the time series, newest first: `{ items: [{ id, takenAt, trigger, planVersion, successRate, fiYear, actualNetWorth, plannedNetWorth, netWorthVsPlan: { delta, ratio }, endNetWorthReal, depletionYear, milestones, findings, currency }] }`                                                                                                                                                                       |
| `GET /plans/{id}/changes-since-checkin?since=&refresh=`    | **what changed since my last check-in**: `{ since, lastCheckIn, current, planVersionNow, planVersionAtCheckIn, householdChanged, netWorth: { atCheckIn, now, change }, edits: [{ version, createdAt, actor, message }], changes, notifications, note }`. Deterministic recompute against the stored check-in (the chance of success is the stored one); `refresh=true` takes a new check-in first (needs `write`) |
| `GET /notifications?unread=&planId=&since=&limit=`         | `{ items: [{ id, createdAt, kind, severity, planId, healthId, title, body, read }], unread }`                                                                                                                                                                                                                                                                                                                     |
| `POST /notifications/read` (write) `{ ids? \| all: true }` | mark read                                                                                                                                                                                                                                                                                                                                                                                                         |

**Material changes** (each becomes a notification and is listed in `changes`): `success-rate-change` (moved by
more than `successRateDelta`), `milestone-slipped` (moved later by `milestoneSlipMonths` or more, or no longer
reached), `audit-finding` (a warning/critical finding that was not there last time) and `behind-plan` (net worth is
more than `netWorthBehindPlan` below what the previous check-in projected for today, interpolated across the year;
today's money, approximate). Webhooks: `checkin.completed` (every check-in: `checkInId, planId, planName, trigger,
successRate, fiYear, changes`) and `notification.created` (`notificationId, kind, severity, planId, title`).

## OAuth for remote MCP clients

Hosted MCP clients (a chat app that connects to your server by URL) sign in with OAuth 2.1 instead of a pasted
key, following the MCP authorization specification (2026-07-28 revision; the 2025-06-18 flow works too) and
tested with the official SDK client. **Bearer API keys keep working on `/mcp`.** OAuth tokens are accepted on
`/mcp` only, never on the REST API.

| Endpoint                                                                                    | Standard  |                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | RFC 9728  | `resource`, `authorization_servers`, `scopes_supported`                                                                                                            |
| `GET /.well-known/oauth-authorization-server` (also `/.well-known/openid-configuration`)    | RFC 8414  | endpoints, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, `authorization_response_iss_parameter_supported: true` |
| `POST /oauth/register`                                                                      | RFC 7591  | dynamic client registration for **public** clients (`redirect_uris` required; max 500 clients, rate limited)                                                       |
| `GET/POST /oauth/authorize`                                                                 | OAuth 2.1 | consent screen served by the API (signs the user in first); redirects with `code`, `state` and `iss` (RFC 9207)                                                    |
| `POST /oauth/token`                                                                         | OAuth 2.1 | `authorization_code` (PKCE) and `refresh_token` grants; `application/x-www-form-urlencoded`                                                                        |
| `POST /oauth/revoke`                                                                        | RFC 7009  |                                                                                                                                                                    |

A request to `/mcp` without a valid credential is `401` with `WWW-Authenticate: Bearer realm="glideworth",
resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="read simulate"`, which is how a
client discovers all of the above. Rules enforced:

- **PKCE is required, S256 only** (`plain`, a missing challenge or a malformed one is `invalid_request`); the
  `code_verifier` is checked at the token endpoint; a code works once (replaying it revokes what it issued) and
  lives 5 minutes.
- **Redirect URIs** must be `https` or `http` on `localhost`/`127.0.0.1`/`[::1]`, no fragment or credentials, and
  are matched **exactly** at registration time and on every authorization and token request. An unknown client or
  an unregistered redirect URI shows an error page and never redirects.
- **Resource indicators (RFC 8707)**: tokens are bound to `<origin>/mcp`; a different `resource` is `invalid_target`
  and a token whose audience differs is `401`.
- **Scopes** `read`, `simulate`, `write` map to the key scopes (and to the MCP tools that exist). The user can
  untick scopes on the consent screen but never add any; scopes are capped by the **role** of the user who
  consented (a viewer cannot grant `write`) and re-capped on every request, so demoting or disabling the user
  takes effect immediately. `write` tools additionally need `GLIDEWORTH_MCP_ALLOW_WRITES=true`.
- **Tokens**: access 1 hour, refresh 30 days with **rotation** (replaying a rotated refresh token revokes the
  grant). Codes, access and refresh tokens are stored as hashes only. OAuth writes are audited under the person.
- **Consent screen**: shows the client name, the redirect host and the scopes; has no framing (`X-Frame-Options:
DENY`), a CSRF token and a same-origin check on the decision, and escapes everything. Because the session cookie
  is `SameSite=Strict`, the first hop is a same-origin refresh page so the cookie can be sent.
- Not supported (by design): confidential clients, client ID metadata documents (the spec now prefers them over
  dynamic registration; registration is what the SDK and most hosted clients use today), the implicit and password
  grants.

Set **`GLIDEWORTH_PUBLIC_URL`** (e.g. `https://glideworth.example.com`) behind a proxy: it is the issuer and the base of all
endpoints. Without it the request's origin is used (`GLIDEWORTH_TRUST_PROXY=true` honours `X-Forwarded-*`).
Manage grants with `GET /me/oauth-grants` / `DELETE /me/oauth-grants/{grantId}` (your own) and, as owner,
`GET /oauth/clients` / `DELETE /oauth/clients/{id}`.

## Multi-currency

Accounts, real assets, debts and events may carry a `currency` other than the household's. Each foreign currency
needs an FX pair (either direction) in `CurrentFinances.fxRates`; plans can override pairs or add drift in
`assumptions.fxRates`. The engine reports base-currency figures (`closingOriginal` keeps the original).

| Route                                                               | Purpose                                                                                                                                            |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /households/{id}/fx-rates`                                     | `{ baseCurrency, items: [{ from, to, rate, annualDrift }] }` (rate = base units per 1 foreign unit as of `asOf`; `annualDrift` moves it each year) |
| `POST /households/{id}/fx-rates` `{ from, to, rate, annualDrift? }` | add or update one pair                                                                                                                             |
| `PUT /households/{id}/fx-rates` `{ items }`                         | replace all pairs                                                                                                                                  |
| `DELETE /households/{id}/fx-rates/{FROM-TO}`                        | remove one pair (`GBP-USD`)                                                                                                                        |

All honour `If-Match` (the household version) and bump it. Progress snapshots, check-in net worth and the MCP
`get_household` totals convert foreign items with these rates (a missing pair counts at 1 and is reported;
the engine itself refuses such a plan).

## More analysis

| Route                                                                                    | Purpose                                                                                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /plans/{id}/insights/strategy-matrix` `{ candidates?, successRate = true }` (job)  | **strategies x metrics** (lifetime tax, net legacy, chance of success, final net worth) with per-column scores 0..1, deltas and `best` per column: a heatmap |
| `POST /plans/{id}/insights/income-by-tax-rate` `{ jurisdictionId?, basis?, schedules? }` | income taxed at each marginal rate per year: `{ columns: [{ rate, labels }], years, cells[year][column], detail }`                                           |

## Webhooks

```bash
api -X POST $GLIDEWORTH/api/v1/webhooks -d '{"url": "https://example.com/glideworth-hook", "events": ["plan.updated", "simulation.completed", "snapshot.created"]}'
# => { "id": "whk_...", "secret": "whsec_..." }   (the secret is returned once)
```

| Event                  | Fired when                                                                                         | `data`                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `plan.updated`         | a plan is created, changed (incl. change-set apply, restore, branch re-materialisation) or deleted | `planId, householdId, name, version, change, message, actor`         |
| `simulation.completed` | an async job succeeds                                                                              | `jobId, kind, planId, planVersion, successRate?`                     |
| `snapshot.created`     | a progress snapshot is recorded                                                                    | `snapshotId, householdId, date, netWorth, source`                    |
| `snapshot.updated`     | today's automatic snapshot was updated in place                                                    | `snapshotId, householdId, date, netWorth, source`                    |
| `checkin.completed`    | a scheduled or manual check-in finished                                                            | `checkInId, planId, planName, trigger, successRate, fiYear, changes` |
| `notification.created` | a check-in raised a notification                                                                   | `notificationId, kind, severity, planId, title`                      |
| `webhook.ping`         | `POST /webhooks/{id}/ping`                                                                         | `message`                                                            |

Each delivery is a `POST` with `content-type: application/json` and the body
`{ "id": "dlv_...", "event": "...", "createdAt": "...", "data": {...} }`, plus headers
`X-Glideworth-Event`, `X-Glideworth-Delivery` and **`X-Glideworth-Signature: t=<unix seconds>,v1=<hex>`** where
`v1 = HMAC-SHA256(secret, "<t>.<raw body>")`. Verify it, and reject old timestamps. **Deprecated:** each
delivery also carries `X-Cairn-Event`, `X-Cairn-Delivery` and `X-Cairn-Signature` with the same values, for
receivers written before the rename from Cairn; they will be removed in a later major version, so read the
`X-Glideworth-*` headers.

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(secret, rawBody, header, toleranceSeconds = 300) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return expected.length === v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

Non-2xx responses and network errors are retried (after 1s, 5s, 30s); the outcome per delivery is in
`GET /webhooks/{id}/deliveries`. Redirects are not followed.

**SSRF guard.** A webhook URL comes from an API caller, so by default the server refuses `localhost`,
`*.local`, `*.internal`, and any address in loopback, private (10/8, 172.16/12, 192.168/16), link-local
(169.254/16, which includes cloud metadata services), carrier-grade NAT, multicast or reserved space, IPv4
and IPv6 (including `::ffff:` and NAT64 forms), plus URLs with embedded credentials. Registration returns
`400 VALIDATION` for an obviously private URL, and every delivery re-checks the addresses the hostname
_resolves to_ inside the socket's own lookup, so a public name that points at private space (or is
rebound later) is refused too (the delivery fails with `blocked: private address`). To deliver to a service
on your own network set `GLIDEWORTH_WEBHOOK_ALLOW_PRIVATE=true` on the server.

## Cloud mode (the hosted service)

The same server runs the hosted service when started with `GLIDEWORTH_MODE=cloud`. Everything in this document applies, per **workspace**: each workspace
is its own SQLite database, and a credential only ever opens the workspace it belongs to. What differs:

| Topic               | Self-host                                                | Cloud                                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| People              | one owner + invited users (`/api/v1/users`), passphrases | accounts with email, password and optional TOTP (`/api/v1/auth/*`, `/api/v1/account/*`); members of a workspace with a role (`/api/v1/workspace/members`, invitations)                                    |
| Browser session     | `glideworth_session` cookie + `X-CSRF-Token`             | `__Host-gw_session` (HttpOnly) + `__Host-gw_csrf` (readable): send its value as `X-CSRF-Token` on every write; writes must also be same-origin (`Origin`, `Sec-Fetch-Site`)                               |
| API keys            | `glideworth_<8>_<secret>`                                | `gwk_<workspace>_<8>_<secret>` (create with `POST /api/v1/me/keys` or `/api/v1/keys`; a write-scoped key needs a re-authentication in the last 10 minutes when created from the browser)                  |
| OAuth (MCP clients) | passphrase on the consent page, `glideworth_oat_` tokens | sign in with the cloud account (`/signin?next=…`), pick the workspace on the consent page; tokens `gwa_`/`gwr_`/`gwc_<workspace>_…`; issuer is always `GLIDEWORTH_PUBLIC_URL`                             |
| Share links         | `glideworth_share_…`                                     | `gws_<workspace>_…` (same public route `GET /api/v1/shared/{token}`; unknown, expired, revoked, deleted or suspended are one 404)                                                                         |
| MCP writes          | `GLIDEWORTH_MCP_ALLOW_WRITES` for the instance           | per workspace: the owner turns them on (`PATCH /api/v1/workspace/settings { mcpWrites }`), and the credential needs `write`                                                                               |
| Limits              | `GLIDEWORTH_RATE_LIMIT_PER_MIN` per key                  | per key 600/min (key `<workspace>:<credential>`), per workspace 1,200/min and 100,000/day, jobs (1 running + 10 queued, 300/day, worker time, trials), webhooks, share reads, API keys, storage: the plan |
| Not registered      |                                                          | `/api/v1/users*`, `/api/v1/auth/{setup,login,logout,logout-all,change-passphrase,accept}`, `/oauth/login`                                                                                                 |

**The free trial.** A new workspace starts a no-card free trial with full access (`access.reason: "trial"`,
`changesAt` = the trial end). When it ends without a subscription the workspace becomes read-only with
`details.reason: "trial_expired"`. A workspace with no subscription record at all (`no_subscription`, rare) has
no access: every tenant route, reads included, answers **`402 ACCOUNT_READ_ONLY`**. The cloud routes (auth,
account, billing, workspace, invitations) always work.

**Read-only workspaces.** When a free trial ends without a subscription, a payment lapses past its grace period
or a subscription is cancelled, the workspace becomes read-only and nothing is deleted at that point: every route declared with
scope `write` answers **`402 ACCOUNT_READ_ONLY`** with `details.reason` and `details.billingUrl`, except the
routes marked `x-allow-when-read-only` (revoking keys, share links and webhooks, marking notifications read).
New async jobs are refused (a cached result is still served), MCP write tools are not offered, scheduled
check-ins pause and outbound webhooks stay silent. Reads, exports and synchronous projections keep working. A
suspended workspace answers `403 ACCOUNT_SUSPENDED` (bearer credentials: 401). Under the terms of service a
workspace whose trial ended unpaid, or that was cancelled, is deleted 12 months later; the owner is emailed 30
and 7 days before (subscribing again stops it).

**Cloud errors** (same envelope): 402 `ACCOUNT_READ_ONLY`, 403 `ACCOUNT_SUSPENDED` / `REAUTH_REQUIRED` /
`CSRF`, 409 `CHECKOUT_IN_PROGRESS`, 429 `RATE_LIMITED` (with `Retry-After`) and `QUOTA_EXCEEDED`
(`details.metric`, `details.resetsAt`), 503 `TENANT_UNAVAILABLE`, 507 `STORAGE_QUOTA_EXCEEDED`. A job stopped
by its time limit fails with `JOB_TIMEOUT` (both modes).

**Cloud-only operations** (49; tags `Cloud auth`, `Cloud account`, `Cloud workspaces`, `Cloud billing`,
`Cloud email` in `/openapi.json` of a cloud server): sign-up (with the required `adultConfirmed: true`),
verification, sign-in and TOTP, re-authentication, password reset, account and sessions, workspaces
(create, switch with `POST /api/v1/workspaces/{id}/activate`, settings, members, invitations, ownership
transfer, export as a SQLite file a self-hoster can run, support grants, deletion), billing (status, Stripe
Checkout, customer portal), the Stripe webhook and email unsubscribe. `GET /api/v1/auth/status` answers
`{ mode: "cloud", authenticated, user, workspace: { id, name, role, access, trialEndsAt }, workspaces,
csrfToken, expiresAt }`.

## Configuration

Every variable is also listed, with comments, in `.env.example`. Each one is also read under its name from
before the rename, `CAIRN_` instead of `GLIDEWORTH_`; the new name wins when both are set, and the server
warns once at start-up when an old name is in use (docs/SELF-HOSTING.md, "Upgrading from Cairn").

| Variable                                                            | Default                                        | Meaning                                                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GLIDEWORTH_API_PORT`                                               | `8787`                                         | listen port                                                                                                  |
| `GLIDEWORTH_HOST`                                                   | all                                            | interface to bind (`127.0.0.1` behind a same-host proxy)                                                     |
| `GLIDEWORTH_MODE`                                                   | `selfhost`                                     | `selfhost` or `cloud` (the hosted service; its variables are in `.env.example`)                              |
| `GLIDEWORTH_DATA_DIR`                                               | `./data` (Docker: `/data`)                     | data directory of both modes; self-host keeps `glideworth.db` there                                          |
| `GLIDEWORTH_DB_PATH`                                                | `<data dir>/glideworth.db`                     | SQLite file (migrations from `apps/api/drizzle` run on boot). Refused in cloud mode                          |
| `GLIDEWORTH_BOOTSTRAP_KEY`                                          |                                                | inserted with read+write when the key table is empty (the public example key is refused in production)       |
| `GLIDEWORTH_SEED_SAMPLE`                                            | `true`                                         | seed the synthetic US sample household (`hh-sample`) into an empty DB (the Docker image defaults to `false`) |
| `GLIDEWORTH_WEB_ORIGIN`                                             | dev: `http://localhost:5173`; production: none | the one browser origin trusted for CORS and CSRF (the Vite dev server)                                       |
| `GLIDEWORTH_MCP_ALLOW_WRITES`                                       | `false`                                        | MCP write tools (see [MCP.md](./MCP.md))                                                                     |
| `GLIDEWORTH_MAX_JOBS`                                               | `2`                                            | concurrent worker-thread jobs                                                                                |
| `GLIDEWORTH_MC_SHARDS`                                              | `min(CPUs, 4)`                                 | worker threads one Monte Carlo run is split across (`1` = off)                                               |
| `GLIDEWORTH_MAX_JOB_SECONDS` / `GLIDEWORTH_WORKER_MAX_MB`           | `1800` / `2048`                                | a job running longer is stopped (`JOB_TIMEOUT`); heap limit of one job thread                                |
| `GLIDEWORTH_LOG_LEVEL`                                              | `info`                                         | JSON log lines on stderr, allowlisted fields only (never figures, names, messages or tokens)                 |
| `GLIDEWORTH_RATE_LIMIT_PER_MIN`                                     | `600`                                          | per-key requests/minute (`0` = unlimited)                                                                    |
| `GLIDEWORTH_MAX_BODY_MB`                                            | `10`                                           | largest request body (413 beyond it)                                                                         |
| `GLIDEWORTH_WEBHOOK_ALLOW_PRIVATE`                                  | `false`                                        | allow webhooks to loopback / private / link-local addresses                                                  |
| `NODE_ENV`                                                          |                                                | `production` serves the web app and is set by `pnpm start` / Docker                                          |
| `GLIDEWORTH_SERVE_WEB` / `GLIDEWORTH_WEB_DIST`                      | on in production / `apps/web/dist`             | serve the built web app, and from where                                                                      |
| `GLIDEWORTH_BROWSER_AUTH`                                           | `true`                                         | passphrase + session-cookie sign-in (API keys always work)                                                   |
| `GLIDEWORTH_SETUP_TOKEN`                                            |                                                | required in first-run setup when set (8+ chars)                                                              |
| `GLIDEWORTH_SESSION_TTL_HOURS` / `GLIDEWORTH_SESSION_IDLE_HOURS`    | `168` / `24`                                   | session lifetime / idle timeout                                                                              |
| `GLIDEWORTH_COOKIE_SECURE`                                          | `auto`                                         | cookie `Secure` flag: `auto` (https), `true`, `false`                                                        |
| `GLIDEWORTH_TRUST_PROXY`                                            | `false`                                        | use `X-Forwarded-For` for login throttling (behind your proxy only)                                          |
| `GLIDEWORTH_LOGIN_MAX_ATTEMPTS` / `GLIDEWORTH_LOGIN_WINDOW_MINUTES` | `5` / `15`                                     | failed-login throttling                                                                                      |
| `GLIDEWORTH_PUBLIC_URL`                                             | request origin                                 | public base URL: the OAuth issuer and the base of OAuth endpoints                                            |
| `GLIDEWORTH_SHARE_RATE_LIMIT_PER_MIN`                               | `60`                                           | public share-link reads per client address (`0` = unlimited)                                                 |
| `GLIDEWORTH_SCHEDULER`                                              | `true`                                         | run scheduled check-ins in this process (the schedule is set through the API)                                |
| `GLIDEWORTH_PORT`                                                   | `8787`                                         | Docker Compose: host port                                                                                    |

## Security model

What the server enforces, and the tests that keep it true (`apps/api/test/security.test.ts`,
`auth.test.ts`, `http-server.test.ts`):

- **Every route is authenticated and scoped.** A test walks the whole OpenAPI document: with no credential
  every operation is `401`; a `read` or `simulate` key is `403` on every write; a `simulate` key is `403`
  on every read. Only `/health`, `/openapi.json`, `/docs`, `/api/v1/auth/*`, `GET /api/v1/shared/{token}` and the
  OAuth discovery / protocol endpoints are public.
- **Roles** (owner / editor / viewer) cap the scopes of every credential; a viewer is refused on every write route
  and has no write MCP tools (`collab.test.ts`). Owner-only routes are refused to editors.
- **Share links** serve a stored snapshot only, behind an unguessable token, with expiry, revocation and a rate
  limit (`share-links.test.ts`). **OAuth** requires PKCE S256, exact redirect URIs, audience-bound tokens, rotating
  refresh tokens and honours scopes and roles on every request (`oauth.test.ts`, including the official SDK client).
- **Keys** are stored as SHA-256 only, compared in constant time, shown once, never logged.
- **Sessions** are `HttpOnly`, `SameSite=Strict`, random 256-bit tokens stored only as hashes, with CSRF
  token and `Origin` checks on cookie-authenticated writes. `/mcp` never accepts cookies.
- **Passphrase and setup-token guessing** is throttled per client and globally, including parallel bursts.
- **SQL**: all queries are parameterised through Drizzle (no string-built SQL anywhere).
- **Prototype pollution**: bodies, JSON Patch ops and MCP arguments that address `__proto__`,
  `constructor` or `prototype` are refused before they reach the patch engine.
- **SSRF**: webhook destinations are checked at registration and at connection time (see Webhooks).
- **Input size**: `GLIDEWORTH_MAX_BODY_MB`, plus bounded `limit`, `trials`, `maxEvaluations`, string and array
  lengths in the schemas.
- **Files**: the API never reads or writes a path from a request. Static serving resolves inside the web
  directory only; backup/restore are operator CLI commands. Import and export are JSON bodies.
- **Errors** never contain stack traces, SQL or file paths: unexpected failures are `500 INTERNAL` with the
  detail in the server log only (the same on MCP).
- **Logs** contain no keys, passphrases, webhook secrets or request bodies.
- **Response headers**: `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Cache-Control: no-store` on
  the API; `X-Frame-Options: DENY` on the web app.
- **Dependencies**: `pnpm audit` reports one moderate advisory (esbuild 0.18 inside `drizzle-kit`, a
  development-only tool used by `pnpm db:generate`; it is not in the runtime image).
- **Not covered**: TLS (put a reverse proxy in front for anything beyond localhost), per-plan key scoping (roles
  are instance-wide, not per household).

## Not built yet

Per-household access control (roles are instance-wide), OAuth client ID metadata documents and confidential
clients, and farming solver Monte Carlo evaluations out across workers (a single solver evaluation runs in one thread;
plain Monte Carlo runs are sharded).
