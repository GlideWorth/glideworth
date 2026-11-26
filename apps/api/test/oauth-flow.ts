/** A person connects an MCP client through the real OAuth consent screen (PKCE), signing in with their passphrase. */
import { createHash } from "node:crypto";
import { expect } from "vitest";
import { browser } from "./browser.js";
import type { Harness } from "./helpers.js";

const REDIRECT = "http://localhost:9999/callback";
const VERIFIER = "a-very-long-random-code-verifier-0123456789-abcdefghijklmnop";

const hiddenOf = (html: string) =>
  Object.fromEntries(
    [...html.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)"/g)].map((m) => [
      m[1]!,
      m[2]!.replace(/&amp;/g, "&"),
    ]),
  );

/** Ticks every scope in `grant` on the consent screen; returns the access token and the scope granted. */
export async function oauthTokenFor(
  h: Harness,
  login: { user: string; pass: string },
  grant: string[] = ["read", "simulate", "write"],
): Promise<{ access: string; scope: string }> {
  const reg = await h.call("/oauth/register", {
    method: "POST",
    key: null,
    body: {
      client_name: "Test client",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    },
  });
  const clientId = reg.json.client_id as string;
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    code_challenge_method: "S256",
    state: "s",
    scope: grant.join(" "),
    resource: "http://localhost/mcp",
  }).toString();
  const b = browser(h.app);
  let r = await b.req(`/oauth/authorize?${q}`);
  if (r.text.includes('http-equiv="refresh"')) r = await b.req(`/oauth/authorize?${q}&_r=1`);
  const l = await b.req("/oauth/login", {
    method: "POST",
    form: { passphrase: login.pass, user: login.user, qs: hiddenOf(r.text).qs! },
  });
  expect(l.status).toBe(303);
  r = await b.req(l.headers.get("location")!);
  const done = await b.req("/oauth/authorize", {
    method: "POST",
    form: { ...hiddenOf(r.text), grant, decision: "approve" },
  });
  expect(done.status).toBe(302);
  const code = new URL(done.headers.get("location")!).searchParams.get("code")!;
  const t = await h.app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: VERIFIER,
      resource: "http://localhost/mcp",
    }).toString(),
  });
  const tj = (await t.json()) as { access_token: string; scope: string };
  return { access: tj.access_token, scope: tj.scope };
}

/** One JSON-RPC call to /mcp with a bearer credential. */
export async function mcpCall(
  h: Harness,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  // oxlint-disable-next-line typescript/no-explicit-any -- JSON-RPC replies are probed freely
): Promise<{ status: number; json: any }> {
  const r = await h.app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await r.text();
  const line = text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "{}");
  let json: unknown = {};
  try {
    json = JSON.parse(line);
  } catch {
    /* not JSON (e.g. a 401 body) */
  }
  return { status: r.status, json };
}
