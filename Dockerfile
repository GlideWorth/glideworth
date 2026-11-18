# syntax=docker/dockerfile:1.7
#
# Glideworth: one container, one process, one port. The Hono API serves the built web app, the REST API
# (/api/v1), the MCP endpoint (/mcp) and /health. SQLite lives on the /data volume.
#
#   docker build -t glideworth .
#   docker run -p 8787:8787 -v glideworth-data:/data glideworth      # then open http://localhost:8787
#
# One image, two modes: GLIDEWORTH_MODE=selfhost (default, the above) or cloud (the hosted service: also set
# the cloud variables of .env.example; the operator console listens on GLIDEWORTH_OPS_LISTEN and the operator
# CLI is `glideworth-cloud`, on the PATH). Self-host never loads the cloud packages.
#
# Upgrading from Cairn: keep mounting your existing volume (for example `-v cairn-data:/data`). Its
# /data/cairn.db is used while /data/glideworth.db does not exist, and CAIRN_* variables keep working
# (see docs/SELF-HOSTING.md, "Upgrading from Cairn").
#
ARG NODE_VERSION=24

# ------------------------------------------------------------------------------------------ base
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo

# ---------------------------------------------------------------------------------------- deps
# Dependencies only (cached until a manifest or the lockfile changes). Needs a toolchain in case
# better-sqlite3 has no prebuilt binary for this platform.
FROM base AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The root `prepare` script (git hooks) runs on install; it exits at once because CI=true above.
COPY .husky/install.mjs .husky/install.mjs
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/importers/package.json packages/importers/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/billing/package.json packages/billing/package.json
COPY packages/cloud/package.json packages/cloud/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------------------- build
FROM deps AS build
# Hosted-service analytics (apps/web/src/lib/analytics.tsx). Only the production image workflow
# (deploy.yml, image-artifact.yml) passes these; self-host images leave them empty and ship no analytics.
ARG VITE_PUBLIC_POSTHOG_PROJECT_TOKEN=""
ARG VITE_PUBLIC_POSTHOG_HOST=""
ENV VITE_PUBLIC_POSTHOG_PROJECT_TOKEN=$VITE_PUBLIC_POSTHOG_PROJECT_TOKEN \
    VITE_PUBLIC_POSTHOG_HOST=$VITE_PUBLIC_POSTHOG_HOST
COPY tsconfig.base.json ./
# apps/web imports brand/logo.svg?raw (the build failed without it).
COPY brand brand
COPY packages packages
COPY apps apps
# core -> importers, email -> billing -> cloud -> api (topological order), then the web bundle. Type-checking
# the web app is CI's job (`pnpm typecheck`); the image build only needs the bundle.
RUN pnpm --filter @glideworth/core --filter @glideworth/importers --filter @glideworth/email \
      --filter @glideworth/billing --filter @glideworth/cloud --filter @glideworth/api build \
 && pnpm --filter @glideworth/web exec vite build \
 && printf '%s' "$VITE_PUBLIC_POSTHOG_HOST" > /repo/posthog-host
# A self-contained production tree for the API: compiled code, migrations and prod dependencies only
# (including the compiled workspace packages).
RUN pnpm --filter @glideworth/api deploy --prod --legacy /deploy

# ------------------------------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# The port is the server's default (8787) and is not set here, so a GLIDEWORTH_API_PORT or a pre-rename
# CAIRN_API_PORT given at `docker run` time is honoured either way.
# GLIDEWORTH_DATA_DIR, not GLIDEWORTH_DB_PATH: self-host keeps /data/glideworth.db (or an existing
# /data/cairn.db), cloud keeps its control plane and workspaces under /data and refuses GLIDEWORTH_DB_PATH.
# PATH: the operator CLI `glideworth-cloud` (packages/cloud's bin, linked by the deploy tree).
# GLIDEWORTH_TENANT_RUNTIME_MODULE: what that CLI loads to open workspaces while the server is stopped.
# GLIDEWORTH_POSTHOG_*: server error reports to PostHog in cloud mode (packages/cloud/src/log/error-reporter.ts),
# from the same build arguments as the web app's analytics. Self-host images are built without them, so they
# are empty and nothing is sent; self-host mode never loads the reporter in any case. In cloud mode an empty
# GLIDEWORTH_POSTHOG_PROJECT_TOKEN in .env.production turns reporting off.
ARG VITE_PUBLIC_POSTHOG_PROJECT_TOKEN=""
ARG VITE_PUBLIC_POSTHOG_HOST=""
ENV NODE_ENV=production \
    GLIDEWORTH_DATA_DIR=/data \
    GLIDEWORTH_WEB_DIST=/app/web \
    GLIDEWORTH_SEED_SAMPLE=false \
    GLIDEWORTH_TENANT_RUNTIME_MODULE=/app/dist/cloud-host.js \
    GLIDEWORTH_POSTHOG_PROJECT_TOKEN=$VITE_PUBLIC_POSTHOG_PROJECT_TOKEN \
    GLIDEWORTH_POSTHOG_HOST=$VITE_PUBLIC_POSTHOG_HOST \
    PATH=/app/node_modules/.bin:$PATH
WORKDIR /app
COPY --from=build --chown=node:node /deploy /app
COPY --from=build --chown=node:node /repo/apps/web/dist /app/web
# The PostHog host the bundle was built with (empty for self-host images); infra/scripts/gen-csp.sh reads it.
COPY --from=build --chown=node:node /repo/posthog-host /app/posthog-host
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
# 8787: the app. 8789: the cloud operator console (cloud mode only; publish it on a private address only).
EXPOSE 8787
# /health is public and cheap. Uses the port the server was told to listen on (either variable name).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.GLIDEWORTH_API_PORT||process.env.CAIRN_API_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Operator commands (inside the container): node dist/cli/admin.js backup | restore --from F --force | seed
# Cloud mode: glideworth-cloud operator create | backup-now | restore-tenant <id> | restore-test | ...
CMD ["node", "dist/server.js"]
