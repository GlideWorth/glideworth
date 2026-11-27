# Connect Glideworth over MCP

The server is Streamable HTTP, or stdio for a local process. Money is in major currency units. Rates are fractions (`0.07` is 7%). Plan edits are proposals: preview, then apply only after the person agrees.

## Hosted

Endpoint: `https://app.glideworth.com/mcp`

Auth, either of:

- OAuth 2.1 with PKCE (S256). Send no key. A request with no credential returns 401, and `WWW-Authenticate` points at `/.well-known/oauth-protected-resource/mcp`.
- A workspace API key: `Authorization: Bearer gwk_...`. Create it under **Settings**, then **API keys**. The **Read** scope is read-only: plans, finances, and simulations. **Write** includes read, and it can propose and apply changes only when the workspace owner has turned on "Allow AI assistants to make changes" under **Settings**, **Workspace**.

Claude Code, using OAuth (no header):

```bash
claude mcp add --transport http glideworth https://app.glideworth.com/mcp
```

With a key instead, add `--header "Authorization: Bearer $GLIDEWORTH_MCP_KEY"`. `--scope user` keeps that entry out of the project.

## Self-hosted Docker

Image: `ghcr.io/glideworth/glideworth`. The container serves the app and MCP. Streamable HTTP is `http://localhost:8787/mcp` (host port `GLIDEWORTH_PORT`, default 8787).

The compose file and first-run steps are in the README, under "Self-hosting with Docker". A read-only key:

```bash
docker compose exec -T glideworth node dist/cli/create-key.js --name claude --scopes read
```

Send it as `Authorization: Bearer glideworth_...`. Write tools stay off unless `GLIDEWORTH_MCP_ALLOW_WRITES=true` and the key includes `write`.

stdio inside that container (the database is `/data/glideworth.db` via `GLIDEWORTH_DATA_DIR`):

```bash
docker exec -i glideworth node dist/mcp/stdio.js
```

## Self-hosted stdio

From a checkout, after `pnpm build`. There is no API key: the process is the credential. It is read-only unless `GLIDEWORTH_MCP_ALLOW_WRITES=true`.

```bash
GLIDEWORTH_DB_PATH=/absolute/path/to/glideworth.db node apps/api/dist/mcp/stdio.js
```

`GLIDEWORTH_DB_PATH` is the SQLite file. When the API is started from `apps/api`, the default file is `apps/api/data/glideworth.db`. A relative path is resolved from the process's working directory, so pass an absolute path. Do not start this through `pnpm run`: pnpm prints a banner on stdout, and stdout is the protocol channel.
