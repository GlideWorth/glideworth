#!/usr/bin/env node
/**
 * Real-process smoke test of cloud mode against the BUILT server (run `pnpm build` first).
 *
 *   node apps/api/scripts/cloud-smoke.mjs            # from the repository root
 *   KEEP=1 node apps/api/scripts/cloud-smoke.mjs     # keep the temporary data directory for inspection
 *
 * Starts `node apps/api/dist/server.js` with GLIDEWORTH_MODE=cloud on spare loopback ports, a temporary data
 * directory and only local fakes: GLIDEWORTH_BILLING=fake, the file email transport, the development CAPTCHA
 * token, the directory object store for backups. Nothing leaves the machine (no Stripe, email provider,
 * Turnstile or S3), and port 8787 is never used. Then, as a customer would: sign up (verification link read
 * from the file transport), verify, sign out and sign in, create a household and a plan, run a simulation job,
 * create an API key and call the API and /mcp with it, start a checkout and complete it through the fake
 * gateway with correctly signed Stripe webhooks, check the entitlement change, export the workspace, delete
 * it, and check the workspace file is gone. One PASS/FAIL line per step; exit status 1 on any failure.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(here, "..");
const repo = resolve(apiDir, "..", "..");
const server = join(apiDir, "dist", "server.js");
if (!existsSync(server)) {
  console.error(`FAIL  built server not found at ${server}: run \`pnpm build\` first`);
  process.exit(1);
}

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

const dataDir = mkdtempSync(join(tmpdir(), "glideworth-cloud-smoke-"));
const port = await freePort();
let opsPort = await freePort();
while (opsPort === port || opsPort === 8787) opsPort = await freePort();
if (port === 8787) throw new Error("refusing port 8787");
const base = `http://127.0.0.1:${port}`;
const env = {
  PATH: process.env.PATH,
  NODE_ENV: "development",
  GLIDEWORTH_MODE: "cloud",
  GLIDEWORTH_HOST: "127.0.0.1",
  GLIDEWORTH_API_PORT: String(port),
  GLIDEWORTH_OPS_LISTEN: `127.0.0.1:${opsPort}`,
  GLIDEWORTH_PUBLIC_URL: base,
  GLIDEWORTH_DATA_DIR: dataDir,
  GLIDEWORTH_SECRETS_KEY: randomBytes(32).toString("hex"),
  GLIDEWORTH_BACKUP_KEK: randomBytes(32).toString("base64"),
  GLIDEWORTH_PRICING_FILE: join(repo, "packages", "billing", "pricing.example.json"),
  GLIDEWORTH_BILLING: "fake",
  GLIDEWORTH_EMAIL_TRANSPORT: "file",
  GLIDEWORTH_DEV_CAPTCHA_TOKEN: "smoke-captcha",
  GLIDEWORTH_SERVE_WEB: "false",
  GLIDEWORTH_LOG_LEVEL: "warn",
};

const child = spawn(process.execPath, [server], {
  cwd: apiDir,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOut = "";
child.stdout.on("data", (d) => (serverOut += d));
child.stderr.on("data", (d) => (serverOut += d));

let failed = 0;
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push(`PASS  ${name}${detail ? ` (${detail})` : ""} ${Date.now() - t0}ms`);
    console.log(results.at(-1));
    return true;
  } catch (err) {
    failed++;
    results.push(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(results.at(-1));
    return false;
  }
};
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ------------------------------------------------------------------------------------------- client
const jar = new Map();
async function req(method, path, { body, bearer, form, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (bearer) h.authorization = `Bearer ${bearer}`;
  else if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  if (method !== "GET") h.origin = base;
  if (!bearer && method !== "GET" && jar.get("__Host-gw_csrf"))
    h["x-csrf-token"] = jar.get("__Host-gw_csrf");
  let payload;
  if (raw !== undefined) payload = raw;
  else if (form) {
    payload = new URLSearchParams(form).toString();
    h["content-type"] = "application/x-www-form-urlencoded";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h["content-type"] ??= "application/json";
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    redirect: "manual",
    ...(payload === undefined ? {} : { body: payload }),
  });
  if (!bearer)
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (/Max-Age=0/i.test(sc) || v === "") jar.delete(k);
      else jar.set(k, v);
    }
  const buf = Buffer.from(await res.arrayBuffer());
  let json;
  try {
    json = JSON.parse(buf.toString("utf8"));
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text: buf.toString("utf8"), buf, headers: res.headers };
}
const ok = (r, what) => {
  must(r.status < 300, `${what}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return r;
};

/** The newest message of `template` to `email` in the file transport's outbox directory. */
function mailTo(email, template) {
  const dir = join(dataDir, "mail-outbox");
  if (!existsSync(dir)) return null;
  const msgs = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .map((m) => m.message ?? m)
    .filter((m) => m.to?.email === email && (!template || m.template === template));
  return msgs.at(-1) ?? null;
}
const tokenIn = (text) => decodeURIComponent(/#token=([^\s"<]+)/.exec(text)?.[1] ?? "");
const waitFor = async (fn, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
};

// ------------------------------------------------------------------------------------------- steps
const email = `smoke.${Date.now()}@example.org`;
const password = `smoke ${randomBytes(9).toString("hex")} passphrase`;
const state = {};

try {
  const up = await step("server starts in cloud mode and answers /health", async () => {
    const r = await waitFor(async () => {
      try {
        const res = await fetch(`${base}/health`);
        return res.ok ? res : null;
      } catch {
        return null;
      }
    }, 30_000);
    must(r, `no /health within 30 s; server output:\n${serverOut.slice(-2000)}`);
    return `port ${port}, ops ${opsPort}`;
  });
  if (!up) throw new Error("server did not start");

  await step("sign up (adults-only confirmation, development CAPTCHA)", async () => {
    const r = await req("POST", "/api/v1/auth/signup", {
      body: {
        email,
        password,
        name: "Smoke Tester",
        captchaToken: "smoke-captcha",
        termsVersion: "2026-11",
        adultConfirmed: true,
      },
    });
    must(r.status === 202, `HTTP ${r.status} ${r.text}`);
  });

  await step("verification link read from the file email transport", async () => {
    const m = await waitFor(() => mailTo(email, "verify-email"));
    must(m, "no verify-email message in mail-outbox/");
    state.verifyToken = tokenIn(m.text);
    must(state.verifyToken, "no #token= link in the message");
  });

  await step("verify the address (workspace and trial created, signed in)", async () => {
    ok(await req("POST", "/api/v1/auth/verify", { body: { token: state.verifyToken } }), "verify");
    const s = ok(await req("GET", "/api/v1/auth/status"), "status").json;
    must(s.authenticated && s.workspace?.id, "no workspace after verification");
    state.accountId = s.workspace.id;
    state.accessBefore = s.workspace.access;
    return `workspace ${state.accountId}, access ${s.workspace.access.level}/${s.workspace.access.reason}`;
  });

  await step("sign out and sign in again", async () => {
    ok(await req("POST", "/api/v1/auth/signout", { body: {} }), "signout");
    must((await req("GET", "/api/v1/households")).status === 401, "still signed in after sign-out");
    const r = ok(
      await req("POST", "/api/v1/auth/signin", {
        body: { email, password, captchaToken: "smoke-captcha" },
      }),
      "signin",
    );
    must(r.json.status === "signed-in", `sign-in answered ${r.text}`);
  });

  await step("create a household and a plan through the API", async () => {
    const { createSampleDocument } = await import("@glideworth/core/samples");
    const doc = createSampleDocument();
    const hh = ok(
      await req("POST", "/api/v1/households", {
        body: {
          household: { ...doc.household, id: "hh-smoke", name: "Smoke household" },
          finances: doc.finances,
        },
      }),
      "household",
    );
    const plan = { ...doc.plans[0], id: "plan-smoke", householdId: "hh-smoke", name: "Smoke plan" };
    const p = ok(await req("POST", "/api/v1/plans", { body: plan }), "plan");
    state.planId = p.json.id;
    return `${hh.json?.id ?? "hh-smoke"}, ${state.planId}`;
  });

  await step("run a simulation job (Monte Carlo, worker threads, real engine)", async () => {
    const r = ok(
      await req("POST", `/api/v1/plans/${state.planId}/monte-carlo?wait=60`, {
        body: { settings: { trials: 500 } },
      }),
      "monte-carlo",
    );
    must(r.json.status === "succeeded", `job ${r.json.status}: ${JSON.stringify(r.json.error)}`);
    const res = ok(await req("GET", `/api/v1/jobs/${r.json.id}/result`), "result");
    must(typeof res.json.successRate === "number", "no successRate in the result");
    return `success rate ${(res.json.successRate * 100).toFixed(1)}%`;
  });

  await step("create an API key and call the API and /mcp with it", async () => {
    ok(await req("POST", "/api/v1/auth/reauth", { body: { password } }), "reauth");
    const k = ok(
      await req("POST", "/api/v1/me/keys", { body: { name: "smoke", scopes: ["read", "write"] } }),
      "key",
    );
    state.key = k.json.key;
    must(
      state.key.startsWith(`gwk_${state.accountId}_`),
      "key is not a routed gwk_ key of this workspace",
    );
    const plans = ok(await req("GET", "/api/v1/plans", { bearer: state.key }), "plans with key");
    must(
      plans.json.items.some((p) => p.id === state.planId),
      "the plan is not listed",
    );
    const m = ok(
      await req("POST", "/mcp", {
        bearer: state.key,
        headers: { accept: "application/json, text/event-stream" },
        body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      }),
      "mcp",
    );
    const tools = m.json?.result?.tools ?? [];
    must(tools.length > 40, `only ${tools.length} MCP tools`);
    return `${tools.length} MCP tools (writes off by default)`;
  });

  await step(
    "checkout: fake Checkout completed through correctly signed Stripe webhooks",
    async () => {
      const co = ok(
        await req("POST", "/api/v1/billing/checkout", { body: { lookupKey: "cloud_monthly_v1" } }),
        "checkout",
      );
      const sessionId = String(co.json.url).split("/").at(-1);
      const done = ok(
        await req("POST", "/__dev/billing/complete-checkout", { body: { sessionId } }),
        "complete (fake gateway)",
      );
      must(done.json.events.length > 0, "no events");
      for (const ev of done.json.events) {
        const w = await req("POST", "/stripe/webhook", {
          raw: ev.body,
          headers: { "stripe-signature": ev.header, "content-type": "application/json" },
        });
        must(w.status === 200, `webhook HTTP ${w.status} ${w.text}`);
      }
      const bad = await req("POST", "/stripe/webhook", {
        raw: done.json.events[0].body,
        headers: { "stripe-signature": "t=1,v1=00", "content-type": "application/json" },
      });
      must(bad.status === 400, `a forged signature answered ${bad.status}`);
      return `${done.json.events.length} signed events delivered; forged signature refused`;
    },
  );

  await step("entitlement changed from the trial to the paid subscription", async () => {
    const s = ok(await req("GET", "/api/v1/auth/status"), "status").json;
    const b = ok(await req("GET", "/api/v1/billing"), "billing").json;
    must(s.workspace.access.level === "full", "not at full access");
    must(s.workspace.access.reason === "active", `access reason ${s.workspace.access.reason}`);
    return `${state.accessBefore.reason} -> ${s.workspace.access.reason}; billing ${JSON.stringify(b).slice(0, 80)}`;
  });

  await step("export the workspace (a valid SQLite database)", async () => {
    ok(await req("POST", "/api/v1/auth/reauth", { body: { password } }), "reauth");
    const e = ok(await req("POST", "/api/v1/workspace/export", { body: {} }), "export");
    const dl = ok(await req("GET", `/api/v1/workspace/exports/${e.json.exportId}`), "download");
    must(dl.buf.subarray(0, 15).toString("latin1") === "SQLite format 3", "not an SQLite file");
    const again = await req("GET", `/api/v1/workspace/exports/${e.json.exportId}`);
    must(again.status >= 400, "the export downloaded twice");
    return `${dl.buf.length} bytes, single download`;
  });

  await step("delete the workspace; its database file is gone", async () => {
    const tenantsDir = join(dataDir, "tenants");
    const files = () => readdirSync(tenantsDir, { recursive: true }).map(String);
    must(
      files().some((f) => f.includes(state.accountId) && f.endsWith("tenant.db")),
      "no tenant file before deletion",
    );
    ok(await req("POST", "/api/v1/auth/reauth", { body: { password } }), "reauth");
    const settings = ok(await req("GET", "/api/v1/workspace/settings"), "settings").json;
    ok(
      await req("DELETE", "/api/v1/workspace", { body: { confirmName: settings.name } }),
      "delete",
    );
    const gone = await waitFor(() => !files().some((f) => f.includes(state.accountId)), 15_000);
    must(gone, "the tenant directory still exists");
    const k = await req("GET", "/api/v1/plans", { bearer: state.key });
    must(k.status === 401, `the API key still answers ${k.status}`);
  });
} catch (err) {
  failed++;
  console.log(`FAIL  ${err instanceof Error ? err.message : String(err)}`);
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      r();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(t);
      r();
    });
  });
  if (/"level":"error"/.test(serverOut))
    console.log(
      "NOTE  the server logged errors:\n" +
        serverOut
          .split("\n")
          .filter((l) => l.includes('"level":"error"'))
          .slice(0, 5)
          .join("\n"),
    );
  if (process.env.KEEP) console.log(`data directory kept: ${dataDir}`);
  else rmSync(dataDir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} step(s) FAILED` : "\nall steps passed");
  process.exit(failed ? 1 : 0);
}
