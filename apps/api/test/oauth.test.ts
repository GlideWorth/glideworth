/* oxlint-disable typescript/no-explicit-any -- tests probe arbitrary JSON responses */
/**
 * OAuth 2.1 for remote MCP clients: metadata, dynamic registration, PKCE authorization-code flow with a consent
 * screen, token/refresh/revoke, audience binding, scope mapping, redirect-URI validation, and the official
 * MCP SDK client connecting over HTTP without a pasted key.
 */
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it } from "vitest";
import { type Browser, browser } from "./browser.js";
import { type Harness, setup, WRITE_KEY } from "./helpers.js";

let h: Harness;
let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  h?.close();
});

const PASS = "owner passphrase one two";
const REDIRECT = "http://localhost:9999/callback";
const VERIFIER = "a-very-long-random-code-verifier-0123456789-abcdefghijklmnop";
const challengeOf = (v: string) => createHash("sha256").update(v).digest("base64url");
const BASE = "http://localhost";

async function boot(opts: Parameters<typeof setup>[0] = {}) {
  h = setup(opts);
  await h.services.auth.setup(PASS, undefined);
}

async function register(body: Record<string, unknown> = {}) {
  const r = await h.call("/oauth/register", {
    method: "POST",
    key: null,
    body: {
      client_name: "Test Agent",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      ...body,
    },
  });
  return r;
}

function authorizeQuery(clientId: string, o: Record<string, string | undefined> = {}) {
  const q = new URLSearchParams();
  const all: Record<string, string | undefined> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challengeOf(VERIFIER),
    code_challenge_method: "S256",
    state: "st-123",
    scope: "read simulate write",
    resource: `${BASE}/mcp`,
    ...o,
  };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) q.set(k, v);
  return q.toString();
}

const hiddenOf = (html: string) =>
  Object.fromEntries(
    [...html.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)"/g)].map((m) => [
      m[1]!,
      m[2]!.replace(/&amp;/g, "&"),
    ]),
  );

/** Drive the browser part: sign in, then decide on the consent screen. Returns the final redirect. */
async function consent(
  b: Browser,
  qs: string,
  o: { approve?: boolean; scopes?: string[]; login?: { user?: string; pass: string } | null } = {},
) {
  let r = await b.req(`/oauth/authorize?${qs}`);
  if (r.status === 200 && r.text.includes('http-equiv="refresh"'))
    r = await b.req(`/oauth/authorize?${qs}&_r=1`);
  if (r.text.includes('name="passphrase"')) {
    const login = o.login === undefined ? { pass: PASS } : o.login;
    if (!login) return r;
    const l = await b.req("/oauth/login", {
      method: "POST",
      form: {
        passphrase: login.pass,
        qs: hiddenOf(r.text).qs!,
        ...(login.user ? { user: login.user } : {}),
      },
    });
    expect(l.status).toBe(303);
    r = await b.req(l.headers.get("location")!);
  }
  if (r.status !== 200 || !r.text.includes('name="csrf"')) return r;
  const hidden = hiddenOf(r.text);
  return b.req("/oauth/authorize", {
    method: "POST",
    form: {
      ...hidden,
      grant: o.scopes ?? ["read", "simulate", "write"],
      decision: o.approve === false ? "deny" : "approve",
    },
  });
}

const codeFrom = (res: { status: number; headers: { get(name: string): string | null } }) => {
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
};

async function token(form: Record<string, string>) {
  const r = await h.app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { status: r.status, json: (await r.json()) as Record<string, any>, headers: r.headers };
}

/** Whole flow: register, consent, exchange. */
async function getTokens(
  o: { scopes?: string[]; user?: { user: string; pass: string }; scopeParam?: string } = {},
) {
  const reg = await register();
  const clientId = reg.json.client_id as string;
  const b = browser(h.app);
  const redir = codeFrom(
    (await consent(b, authorizeQuery(clientId, { scope: o.scopeParam }), {
      scopes: o.scopes,
      login: o.user ? { user: o.user.user, pass: o.user.pass } : undefined,
    })) as never,
  );
  const code = redir.searchParams.get("code")!;
  const t = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: VERIFIER,
    resource: `${BASE}/mcp`,
  });
  expect(t.status, JSON.stringify(t.json)).toBe(200);
  return {
    clientId,
    code,
    tokens: t.json as {
      access_token: string;
      refresh_token: string;
      scope: string;
      expires_in: number;
    },
    b,
  };
}

async function mcpTools(accessToken: string): Promise<{ status: number; tools: string[] }> {
  const r = await h.app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  if (r.status !== 200) return { status: r.status, tools: [] };
  const j = (await r.json()) as { result: { tools: { name: string }[] } };
  return { status: 200, tools: j.result.tools.map((t) => t.name) };
}

describe("discovery", () => {
  it("serves protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414)", async () => {
    await boot();
    for (const p of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const r = await h.call(p, { key: null });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({
        resource: `${BASE}/mcp`,
        authorization_servers: [BASE],
        scopes_supported: ["read", "write", "simulate"],
        bearer_methods_supported: ["header"],
      });
    }
    const m = (await h.call("/.well-known/oauth-authorization-server", { key: null })).json;
    expect(m).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("the consent pages let the browser send its origin back (the form post would otherwise arrive with `Origin: null`)", async () => {
    // Under "no-referrer" Chrome sends `Origin: null` on the consent form's POST, and the same-origin check
    // refuses it: nobody could approve a client.
    const page = await h.app.request("/oauth/authorize?client_id=x&response_type=code");
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    const api = await h.app.request("/health");
    expect(api.headers.get("referrer-policy")).toBe("no-referrer");
    const nullOrigin = await h.app.request("/oauth/authorize", {
      method: "POST",
      headers: { origin: "null", "content-type": "application/x-www-form-urlencoded" },
      body: "decision=approve",
    });
    expect(nullOrigin.status).toBe(403);
  });

  it("GLIDEWORTH_PUBLIC_URL pins the issuer regardless of the Host header", async () => {
    await boot({ appOptions: { publicUrl: "https://glideworth.example.com/" } });
    const m = (
      await h.call("/.well-known/oauth-authorization-server", {
        key: null,
        headers: { host: "evil.test" },
      })
    ).json;
    expect(m.issuer).toBe("https://glideworth.example.com");
    expect(m.token_endpoint).toBe("https://glideworth.example.com/oauth/token");
  });

  it("an unauthenticated /mcp request is a 401 that points at the metadata and names the scopes", async () => {
    await boot();
    const r = await h.call("/mcp", { method: "POST", key: null, body: {} });
    expect(r.status).toBe(401);
    const www = r.headers.get("www-authenticate")!;
    expect(www).toMatch(/^Bearer /);
    expect(www).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    expect(www).toContain('scope="read simulate"');
    const bad = await h.call("/mcp", { method: "POST", key: "glideworth_oat_garbage", body: {} });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("metadata and token endpoints allow cross-origin browser clients (no credentials)", async () => {
    await boot();
    const r = await h.app.request("/oauth/token", {
      method: "OPTIONS",
      headers: { origin: "https://hosted.example", "access-control-request-method": "POST" },
    });
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    expect(
      (
        await h.app.request("/.well-known/oauth-authorization-server", {
          headers: { origin: "https://x.example" },
        })
      ).headers.get("access-control-allow-origin"),
    ).toBe("*");
  });
});

describe("dynamic client registration (RFC 7591)", () => {
  it("registers a public client", async () => {
    await boot();
    const r = await register();
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      client_name: "Test Agent",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
    expect(r.json.client_id).toMatch(/^glideworth-client-/);
    expect(r.json.client_secret).toBeUndefined();
  });

  it("refuses unsafe redirect URIs and confidential clients", async () => {
    await boot();
    for (const uri of [
      "http://evil.example/cb",
      "javascript:alert(1)",
      "https://ok.example/cb#frag",
      "not a uri",
      "file:///etc/passwd",
      "https://user:pw@ok.example/cb",
      "myapp://callback",
    ]) {
      const r = await register({ redirect_uris: [uri] });
      expect(r.status, uri).toBe(400);
      expect(r.json.error).toBe("invalid_redirect_uri");
    }
    expect((await register({ redirect_uris: [] })).status).toBe(400);
    expect(
      (
        await register({
          redirect_uris: [
            "https://ok.example/cb",
            "http://127.0.0.1:3000/cb",
            "http://[::1]:3000/cb",
          ],
        })
      ).status,
    ).toBe(201);
    const secret = await register({ token_endpoint_auth_method: "client_secret_basic" });
    expect(secret.status).toBe(400);
    expect(secret.json.error).toBe("invalid_client_metadata");
    expect((await register({ grant_types: ["password"] })).status).toBe(400);
    expect((await register({ scope: "admin" })).status).toBe(400);
  });
});

describe("authorization endpoint", () => {
  it("never redirects on an unknown client or an unregistered redirect URI (it shows the error)", async () => {
    await boot();
    const reg = (await register()).json.client_id as string;
    const b = browser(h.app);
    const unknown = await b.req(`/oauth/authorize?${authorizeQuery("nope")}`);
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("location")).toBeNull();
    const other = await b.req(
      `/oauth/authorize?${authorizeQuery(reg, { redirect_uri: "https://attacker.example/cb" })}`,
    );
    expect(other.status).toBe(400);
    expect(other.headers.get("location")).toBeNull();
    // exact match: a prefix or a different port is not the registered URI
    for (const r of [
      "http://localhost:9999/callback/x",
      "http://localhost:9998/callback",
      "http://localhost:9999/callbac",
    ]) {
      const x = await b.req(`/oauth/authorize?${authorizeQuery(reg, { redirect_uri: r })}`);
      expect(x.status, r).toBe(400);
    }
  });

  it("requires PKCE with S256: a missing challenge or the plain method is an error redirect carrying iss", async () => {
    await boot();
    const id = (await register()).json.client_id as string;
    const b = browser(h.app);
    for (const q of [
      authorizeQuery(id, { code_challenge: undefined }),
      authorizeQuery(id, { code_challenge_method: "plain" }),
      authorizeQuery(id, { code_challenge_method: undefined }),
      authorizeQuery(id, { code_challenge: "short" }),
    ]) {
      const r = await b.req(`/oauth/authorize?${q}`);
      const loc = codeFrom(r);
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get("error")).toBe("invalid_request");
      expect(loc.searchParams.get("state")).toBe("st-123");
      expect(loc.searchParams.get("iss")).toBe(BASE);
      expect(loc.searchParams.get("code")).toBeNull();
    }
    const t = codeFrom(
      await b.req(`/oauth/authorize?${authorizeQuery(id, { response_type: "token" })}`),
    );
    expect(t.searchParams.get("error")).toBe("unsupported_response_type");
    expect(
      codeFrom(
        await b.req(`/oauth/authorize?${authorizeQuery(id, { scope: "read admin" })}`),
      ).searchParams.get("error"),
    ).toBe("invalid_scope");
    expect(
      codeFrom(
        await b.req(
          `/oauth/authorize?${authorizeQuery(id, { resource: "https://other.example/mcp" })}`,
        ),
      ).searchParams.get("error"),
    ).toBe("invalid_target");
  });

  it("shows a consent screen (after signing in) that names the client, the redirect host and the scopes", async () => {
    await boot();
    const id = (await register({ client_name: "<script>alert(1)</script> Agent" })).json
      .client_id as string;
    const b = browser(h.app);
    // first hop: same-origin refresh so the SameSite=Strict session cookie can be sent
    const first = await b.req(`/oauth/authorize?${authorizeQuery(id)}`);
    expect(first.text).toContain('http-equiv="refresh"');
    const login = await b.req(`/oauth/authorize?${authorizeQuery(id)}&_r=1`);
    expect(login.text).toContain('name="passphrase"');
    expect(login.headers.get("x-frame-options")).toBe("DENY");
    expect(login.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const l = await b.req("/oauth/login", {
      method: "POST",
      form: { passphrase: PASS, qs: hiddenOf(login.text).qs! },
    });
    const page = await b.req(l.headers.get("location")!);
    expect(page.status).toBe(200);
    expect(page.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt; Agent");
    expect(page.text).not.toContain("<script>alert");
    expect(page.text).toContain("http://localhost:9999");
    for (const s of ["read", "simulate", "write"]) expect(page.text).toContain(`value="${s}"`);
    // already signed in: straight to consent after the hop
    const again = await b.req(`/oauth/authorize?${authorizeQuery(id)}&_r=1`);
    expect(again.text).toContain('name="csrf"');
  });

  it("a wrong passphrase on the consent sign-in does not sign in", async () => {
    await boot();
    const id = (await register()).json.client_id as string;
    const b = browser(h.app);
    const r = await consent(b, authorizeQuery(id), {
      login: { pass: "wrong wrong wrong wrong" },
    }).catch((e) => e);
    // consent() asserts a 303 either way; the next page must be the sign-in form again with an error
    expect(JSON.stringify(r)).toBeTruthy();
    const page = await b.req(`/oauth/authorize?${authorizeQuery(id)}&_r=1&error=wrong+passphrase`);
    expect(page.text).toContain('name="passphrase"');
    expect(page.text).not.toContain('name="csrf"');
  });

  it("deny sends access_denied with state and iss; no code is issued", async () => {
    await boot();
    const id = (await register()).json.client_id as string;
    const loc = codeFrom(
      (await consent(browser(h.app), authorizeQuery(id), { approve: false })) as never,
    );
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("st-123");
    expect(loc.searchParams.get("iss")).toBe(BASE);
    expect(h.ctx.sqlite.prepare("select count(*) n from oauth_codes").get()).toEqual({ n: 0 });
  });

  it("the decision POST needs the session, the form token and a same-origin request, and is validated again", async () => {
    await boot();
    const id = (await register()).json.client_id as string;
    const b = browser(h.app);
    const qs = authorizeQuery(id);
    const form = {
      client_id: id,
      redirect_uri: REDIRECT,
      state: "s",
      code_challenge: challengeOf(VERIFIER),
      code_challenge_method: "S256",
      response_type: "code",
      grant: ["read"],
      decision: "approve",
    };
    // not signed in
    expect((await browser(h.app).req("/oauth/authorize", { method: "POST", form })).status).toBe(
      401,
    );
    await consent(b, qs, { approve: false });
    // signed in but no form token / wrong token
    expect((await b.req("/oauth/authorize", { method: "POST", form })).status).toBe(403);
    expect(
      (await b.req("/oauth/authorize", { method: "POST", form: { ...form, csrf: "x".repeat(32) } }))
        .status,
    ).toBe(403);
    // cross-origin post
    const csrf = b.csrf()!;
    expect(
      (
        await b.req("/oauth/authorize", {
          method: "POST",
          form: { ...form, csrf },
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    // a forged redirect_uri in the hidden fields is caught by the re-validation: error page, not a redirect
    const forged = await b.req("/oauth/authorize", {
      method: "POST",
      form: { ...form, csrf, redirect_uri: "https://attacker.example/cb" },
    });
    expect(forged.status).toBe(400);
    expect(forged.headers.get("location")).toBeNull();
    // no PKCE challenge in a forged form
    const nopkce = await b.req("/oauth/authorize", {
      method: "POST",
      form: { ...form, csrf, code_challenge: "" },
    });
    expect(codeFrom(nopkce).searchParams.get("error")).toBe("invalid_request");
    expect(h.ctx.sqlite.prepare("select count(*) n from oauth_codes").get()).toEqual({ n: 0 });
  });
});

describe("token endpoint", () => {
  it("exchanges a code with the right verifier for short-lived tokens that open /mcp", async () => {
    await boot();
    const { tokens, code } = await getTokens();
    expect(tokens).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read simulate write",
    });
    expect(tokens.access_token).toMatch(/^glideworth_oat_/);
    expect(tokens.refresh_token).toMatch(/^glideworth_ort_/);
    const t = await mcpTools(tokens.access_token);
    expect(t.status).toBe(200);
    expect(t.tools).toContain("get_plan_summary");
    // only hashes are stored
    const rows =
      JSON.stringify(h.ctx.sqlite.prepare("select * from oauth_tokens").all()) +
      JSON.stringify(h.ctx.sqlite.prepare("select * from oauth_codes").all());
    expect(rows).not.toContain(tokens.access_token);
    expect(rows).not.toContain(tokens.refresh_token);
    expect(rows).not.toContain(code);
  });

  it("PKCE is verified: a wrong or missing verifier fails and burns the code", async () => {
    await boot();
    const reg = (await register()).json.client_id as string;
    const mk = async () =>
      new URL(
        (await consent(browser(h.app), authorizeQuery(reg))).headers.get("location")!,
      ).searchParams.get("code")!;
    const base = { grant_type: "authorization_code", redirect_uri: REDIRECT, client_id: reg };
    const c1 = await mk();
    const wrong = await token({ ...base, code: c1, code_verifier: "x".repeat(60) });
    expect(wrong).toMatchObject({ status: 400, json: { error: "invalid_grant" } });
    expect((await token({ ...base, code: c1, code_verifier: VERIFIER })).json.error).toBe(
      "invalid_grant",
    ); // burnt
    const c2 = await mk();
    expect((await token({ ...base, code: c2 })).json.error).toBe("invalid_request");
    expect((await token({ ...base, code: c2, code_verifier: "short" })).json.error).toBe(
      "invalid_grant",
    );
  });

  it("binds the code to its client and redirect URI", async () => {
    await boot();
    const reg = (await register()).json.client_id as string;
    const other = (await register({ client_name: "Other" })).json.client_id as string;
    const mk = async () =>
      new URL(
        (await consent(browser(h.app), authorizeQuery(reg))).headers.get("location")!,
      ).searchParams.get("code")!;
    const ok = {
      grant_type: "authorization_code",
      code: "",
      redirect_uri: REDIRECT,
      client_id: reg,
      code_verifier: VERIFIER,
    };
    expect((await token({ ...ok, code: await mk(), client_id: other })).json.error).toBe(
      "invalid_grant",
    );
    expect(
      (await token({ ...ok, code: await mk(), redirect_uri: "http://localhost:9999/other" })).json
        .error,
    ).toBe("invalid_grant");
    expect(
      (await token({ ...ok, code: await mk(), resource: "https://other.example/mcp" })).json.error,
    ).toBe("invalid_target");
    expect((await token({ ...ok, code: await mk() })).status).toBe(200);
    expect((await token({ grant_type: "password", client_id: reg })).json.error).toBe(
      "unsupported_grant_type",
    );
  });

  it("an authorization code works once; replaying it revokes what it issued", async () => {
    await boot();
    const { clientId, code, tokens } = await getTokens();
    expect((await mcpTools(tokens.access_token)).status).toBe(200);
    const replay = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: VERIFIER,
    });
    expect(replay.json.error).toBe("invalid_grant");
    expect((await mcpTools(tokens.access_token)).status).toBe(401);
  });

  it("an expired code is refused", async () => {
    await boot();
    const reg = (await register()).json.client_id as string;
    const code = new URL(
      (await consent(browser(h.app), authorizeQuery(reg))).headers.get("location")!,
    ).searchParams.get("code")!;
    h.ctx.sqlite.prepare("update oauth_codes set expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect(
      (
        await token({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: reg,
          code_verifier: VERIFIER,
        })
      ).json.error,
    ).toBe("invalid_grant");
  });

  it("refresh rotates the refresh token; replaying a rotated one revokes the grant; scope cannot widen", async () => {
    await boot();
    const { clientId, tokens } = await getTokens({ scopes: ["read"] });
    expect(tokens.scope).toBe("read");
    const widen = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      scope: "read write",
    });
    expect(widen.json.error).toBe("invalid_scope");
    const r1 = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(tokens.refresh_token);
    expect((await mcpTools(r1.json.access_token)).status).toBe(200);
    expect((await mcpTools(tokens.access_token)).status).toBe(401); // the old pair was consumed
    const replay = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(replay.json.error).toBe("invalid_grant");
    expect((await mcpTools(r1.json.access_token)).status).toBe(401); // the whole grant is revoked
    expect(
      (
        await token({
          grant_type: "refresh_token",
          refresh_token: r1.json.refresh_token,
          client_id: clientId,
        })
      ).json.error,
    ).toBe("invalid_grant");
  });

  it("refresh needs the same client", async () => {
    await boot();
    const { tokens } = await getTokens();
    const other = (await register({ client_name: "Other" })).json.client_id as string;
    expect(
      (
        await token({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: other,
        })
      ).json.error,
    ).toBe("invalid_grant");
  });

  it("revocation (RFC 7009) kills the token; unknown tokens are not an error", async () => {
    await boot();
    const { clientId, tokens } = await getTokens();
    const rev = (t: string) =>
      h.app.request("/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: t, client_id: clientId }).toString(),
      });
    expect((await rev("glideworth_oat_unknown")).status).toBe(200);
    expect((await rev(tokens.access_token)).status).toBe(200);
    expect((await mcpTools(tokens.access_token)).status).toBe(401);
    expect(
      (
        await token({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: clientId,
        })
      ).json.error,
    ).toBe("invalid_grant");
  });

  it("token responses are not cacheable", async () => {
    await boot();
    const r = await token({ grant_type: "password" });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("scopes, audience and roles", () => {
  it("scope mapping: read-only grant has no write tools; simulate-only has no data-reading tools", async () => {
    await boot({ mcpAllowWrites: true });
    const full = await getTokens();
    const names = (await mcpTools(full.tokens.access_token)).tools;
    expect(names).toContain("apply_change_set");
    expect(names).toContain("list_plans");
    const ro = (await mcpTools((await getTokens({ scopes: ["read"] })).tokens.access_token)).tools;
    expect(ro).toContain("list_plans");
    expect(ro).toContain("simulate_plan");
    expect(ro).not.toContain("apply_change_set");
    expect(ro).not.toContain("update_account_balances");
    const sim = (await mcpTools((await getTokens({ scopes: ["simulate"] })).tokens.access_token))
      .tools;
    expect(sim).toContain("simulate_plan");
    expect(sim).not.toContain("list_plans");
    expect(sim).not.toContain("apply_change_set");
  });

  it("a client cannot grant itself more than it asked for: the user can narrow, never widen", async () => {
    await boot({ mcpAllowWrites: true });
    const t = await getTokens({ scopeParam: "read", scopes: ["read", "write"] });
    expect(t.tokens.scope).toBe("read");
  });

  it("OAuth tokens open /mcp only: the REST API and everything else stay closed to them", async () => {
    await boot({ mcpAllowWrites: true });
    const { tokens } = await getTokens();
    for (const p of ["/api/v1/plans", "/api/v1/me", "/api/v1/users", "/api/v1/keys"])
      expect((await h.call(p, { key: tokens.access_token })).status, p).toBe(401);
    expect((await mcpTools(tokens.access_token)).status).toBe(200);
  });

  it("tokens are bound to this MCP endpoint (RFC 8707 audience)", async () => {
    await boot();
    const { tokens } = await getTokens();
    expect((await mcpTools(tokens.access_token)).status).toBe(200);
    h.ctx.sqlite.prepare("update oauth_tokens set resource = 'https://other.example/mcp'").run();
    expect((await mcpTools(tokens.access_token)).status).toBe(401);
    h.ctx.sqlite.prepare("update oauth_tokens set resource = NULL").run();
    expect((await mcpTools(tokens.access_token)).status).toBe(401);
  });

  it("expired access tokens are refused; the refresh token still works", async () => {
    await boot();
    const { clientId, tokens } = await getTokens();
    h.ctx.sqlite
      .prepare("update oauth_tokens set access_expires_at = '2000-01-01T00:00:00.000Z'")
      .run();
    expect((await mcpTools(tokens.access_token)).status).toBe(401);
    const r = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(r.status).toBe(200);
    expect((await mcpTools(r.json.access_token)).status).toBe(200);
  });

  it("a viewer cannot grant write; and demoting/disabling the user takes effect on live tokens", async () => {
    await boot({ mcpAllowWrites: true });
    const owner = browser(h.app);
    await owner.req("/api/v1/auth/login", { method: "POST", body: { passphrase: PASS } });
    const inv = await owner.req("/api/v1/users", {
      method: "POST",
      body: { name: "Pat", role: "viewer" },
    });
    await browser(h.app).req("/api/v1/auth/accept", {
      method: "POST",
      body: { token: inv.json.invite.token, passphrase: "pat passphrase five six" },
    });
    // the consent screen shows write as unavailable, and a forged form asking for it is capped
    const reg = (await register()).json.client_id as string;
    const pb = browser(h.app);
    const loc = codeFrom(
      (await consent(pb, authorizeQuery(reg), {
        scopes: ["read", "write"],
        login: { user: "pat", pass: "pat passphrase five six" },
      })) as never,
    );
    const t = await token({
      grant_type: "authorization_code",
      code: loc.searchParams.get("code")!,
      redirect_uri: REDIRECT,
      client_id: reg,
      code_verifier: VERIFIER,
    });
    expect(t.json.scope).toBe("read");
    expect((await mcpTools(t.json.access_token)).tools).not.toContain("apply_change_set");
    // an editor's token loses write when the editor is demoted
    const inv2 = await owner.req("/api/v1/users", {
      method: "POST",
      body: { name: "Sam", role: "editor" },
    });
    await browser(h.app).req("/api/v1/auth/accept", {
      method: "POST",
      body: { token: inv2.json.invite.token, passphrase: "sam passphrase three four" },
    });
    const sb = browser(h.app);
    const l2 = codeFrom(
      (await consent(sb, authorizeQuery(reg), {
        login: { user: "sam", pass: "sam passphrase three four" },
      })) as never,
    );
    const t2 = await token({
      grant_type: "authorization_code",
      code: l2.searchParams.get("code")!,
      redirect_uri: REDIRECT,
      client_id: reg,
      code_verifier: VERIFIER,
    });
    expect(t2.json.scope).toBe("read simulate write");
    expect((await mcpTools(t2.json.access_token)).tools).toContain("apply_change_set");
    await owner.req(`/api/v1/users/${inv2.json.user.id}`, {
      method: "PATCH",
      body: { role: "viewer" },
    });
    expect((await mcpTools(t2.json.access_token)).tools).not.toContain("apply_change_set");
    await owner.req(`/api/v1/users/${inv2.json.user.id}`, {
      method: "PATCH",
      body: { disabled: true },
    });
    expect((await mcpTools(t2.json.access_token)).status).toBe(401);
  });

  it("OAuth writes are audited under the person who consented, and clients/grants can be managed", async () => {
    await boot({ mcpAllowWrites: true });
    const { tokens, clientId } = await getTokens();
    const r = await h.app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "update_account_balances",
          arguments: {
            accounts: [{ accountId: "acc-cash", balance: 4321 }],
            recordSnapshot: false,
          },
        },
      }),
    });
    expect(r.status).toBe(200);
    const log = h.services.audit.list({});
    expect(
      log.some(
        (e) =>
          e.action === "mcp:update_account_balances" && e.via === "oauth" && e.userId === "owner",
      ),
    ).toBe(true);
    expect(log.some((e) => e.action === "oauth.consent" && e.resourceId === clientId)).toBe(true);
    // owner admin views
    const owner = browser(h.app);
    await owner.req("/api/v1/auth/login", { method: "POST", body: { passphrase: PASS } });
    const clients = (await owner.req("/api/v1/oauth/clients")).json.items;
    expect(clients[0]).toMatchObject({ id: clientId, name: "Test Agent", activeTokens: 1 });
    const grants = (await owner.req("/api/v1/me/oauth-grants")).json.items;
    expect(grants).toHaveLength(1);
    expect(
      (await owner.req(`/api/v1/me/oauth-grants/${grants[0].id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await mcpTools(tokens.access_token)).status).toBe(401);
    expect(
      (await owner.req(`/api/v1/oauth/clients/${clientId}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await h.call("/api/v1/oauth/clients", { key: WRITE_KEY })).status).toBe(200);
  });

  it("bearer API keys keep working on /mcp", async () => {
    await boot();
    expect((await mcpTools(WRITE_KEY)).status).toBe(200);
  });
});

describe("the official MCP SDK client connects over HTTP with OAuth (no pasted key)", () => {
  it("discovers, registers, authorizes (PKCE), exchanges the code and calls tools", async () => {
    await boot({ mcpAllowWrites: true });
    await new Promise<void>((resolve) => {
      server = serve({ fetch: h.app.fetch, port: 0, hostname: "127.0.0.1" }, () =>
        resolve(),
      ) as Server;
    });
    const origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const REDIR = "http://127.0.0.1:7777/callback";

    // The client application's storage, the way a real MCP client keeps it
    let info: OAuthClientInformationMixed | undefined;
    let saved: OAuthTokens | undefined;
    let verifier = "";
    let authUrl: URL | undefined;
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return REDIR;
      },
      get clientMetadata() {
        return {
          client_name: "SDK test client",
          redirect_uris: [REDIR],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
      },
      state: () => "sdk-state",
      clientInformation: () => info,
      saveClientInformation: (i) => {
        info = i;
      },
      tokens: () => saved,
      saveTokens: (t) => {
        saved = t;
      },
      redirectToAuthorization: (u) => {
        authUrl = u;
      },
      saveCodeVerifier: (v) => {
        verifier = v;
      },
      codeVerifier: () => verifier,
    };

    const connect = () => {
      const c = new Client({ name: "sdk", version: "1" });
      const t = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        authProvider: provider,
      });
      return { c, t };
    };

    // 1. no credentials: the SDK follows the 401 -> metadata -> registration -> authorization URL
    const first = connect();
    await expect(first.c.connect(first.t)).rejects.toThrow(/auth|Unauthorized/i);
    expect(info?.client_id).toMatch(/^glideworth-client-/);
    expect(authUrl).toBeDefined();
    expect(authUrl!.origin).toBe(origin);
    expect(authUrl!.pathname).toBe("/oauth/authorize");
    expect(authUrl!.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl!.searchParams.get("resource")).toBe(`${origin}/mcp`);

    // 2. the person approves in their browser (real HTTP, cookies, the consent form)
    const jar = new Map<string, string>();
    const send = async (url: string, init: RequestInit = {}) => {
      const res = await fetch(url, {
        ...init,
        redirect: "manual",
        headers: {
          ...(init.headers as object),
          ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        },
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const [k, ...v] = pair!.split("=");
        jar.set(k!, v.join("="));
      }
      return { res, text: await res.text() };
    };
    const qs = authUrl!.search.slice(1);
    const hop = await send(authUrl!.toString());
    expect(hop.text).toContain('http-equiv="refresh"');
    const loginPage = await send(`${origin}/oauth/authorize?${qs}&_r=1`);
    const login = await send(`${origin}/oauth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ passphrase: PASS, qs: hiddenOf(loginPage.text).qs! }).toString(),
    });
    const consentPage = await send(`${origin}${login.res.headers.get("location")}`);
    const hidden = hiddenOf(consentPage.text);
    const decision = await send(`${origin}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...hidden, grant: "read", decision: "approve" }).toString(),
    });
    expect(decision.res.status).toBe(302);
    const back = new URL(decision.res.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(REDIR);
    expect(back.searchParams.get("state")).toBe("sdk-state");
    expect(back.searchParams.get("iss")).toBe(origin);

    // 3. the client redeems the code (the SDK validates iss and sends the PKCE verifier + resource)
    await first.t.finishAuth(back.searchParams.get("code")!);
    expect(saved?.access_token).toMatch(/^glideworth_oat_/);
    expect(saved?.refresh_token).toMatch(/^glideworth_ort_/);
    expect(saved?.scope).toBe("read");

    // 4. a fresh connection is authorised and honours the granted scope
    const second = connect();
    await second.c.connect(second.t);
    const tools = (await second.c.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("list_plans");
    expect(tools).not.toContain("apply_change_set");
    const res = (await second.c.callTool({ name: "list_plans", arguments: {} })) as {
      content: { text: string }[];
    };
    expect(JSON.parse(res.content[0]!.text)[0]).toMatchObject({ id: "plan-main" });
    await second.c.close();
  }, 30_000);
});

describe("tokens issued before the rename", () => {
  it("cairn_oat_ access tokens and cairn_ort_ refresh tokens keep working; new ones are glideworth_", async () => {
    await boot();
    const { clientId, tokens } = await getTokens();
    expect(tokens.access_token).toMatch(/^glideworth_oat_/);
    expect(tokens.refresh_token).toMatch(/^glideworth_ort_/);
    expect(clientId).toMatch(/^glideworth-client-/);
    // Store the same grant as the old build would have: same secrets, old prefixes.
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const access = `cairn_oat_${tokens.access_token.slice("glideworth_oat_".length)}`;
    const refresh = `cairn_ort_${tokens.refresh_token.slice("glideworth_ort_".length)}`;
    h.ctx.sqlite
      .prepare("update oauth_tokens set access_hash = ?, refresh_hash = ? where access_hash = ?")
      .run(sha(access), sha(refresh), sha(tokens.access_token));
    expect((await mcpTools(tokens.access_token)).status).toBe(401);
    expect((await mcpTools(access)).status).toBe(200);
    const t = await token({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    });
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    expect(t.json.access_token).toMatch(/^glideworth_oat_/);
    expect((await mcpTools(t.json.access_token)).status).toBe(200);
  });
});
