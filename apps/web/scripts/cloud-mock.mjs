#!/usr/bin/env node
/**
 * Development aid, never part of a build: serves the BUILT web app (`pnpm --filter @glideworth/web build`)
 * with a small in-memory stand-in for the hosted ("cloud") API, so the cloud screens can be looked at in a
 * browser before the real server exists.
 *
 *   node scripts/cloud-mock.mjs [port]            (default 4399)
 *
 * The mock lives only in this preview process (a Vite preview middleware). Pick what the "server" looks
 * like with  /__mock/set?scenario=trial|active|cancelling|pastdue|readonly|suspended  &role=owner|editor|viewer
 * &totp=0|1  &workspaces=1|2  &signedin=0|1  &captcha=0|1 ; then open any app address.
 * Sign in with any email and a password of 12+ characters; the two-step code is 123456.
 * Shapes follow packages/cloud/src/http/routes/*.ts.
 */
import { fileURLToPath } from "node:url";
import { preview } from "vite";

const DAY = 86_400_000;
const state = {
  scenario: "trial",
  role: "owner",
  totp: false,
  workspaces: 1,
  signedIn: false,
  captcha: false,
  name: "Ada Lovelace",
  email: "ada@example.com",
  alerts: true,
  mcpWrites: false,
  wsName: "Lovelace household",
  members: [
    { userId: "u1", role: "owner", name: "Ada Lovelace" },
    { userId: "u2", role: "editor", name: "Charles Babbage" },
    { userId: "u3", role: "viewer", name: "Mary Somerville" },
  ],
  invitations: [
    {
      id: "inv1",
      email: "annie@example.com",
      role: "viewer",
      expiresAt: new Date(Date.now() + 6 * DAY).toISOString(),
    },
  ],
};

const iso = (days) => new Date(Date.now() + days * DAY).toISOString();
function access() {
  switch (state.scenario) {
    case "readonly":
      return { level: "read_only", reason: "trial_expired", changesAt: null };
    case "pastdue":
      return { level: "full", reason: "past_due_grace", changesAt: iso(4) };
    case "suspended":
      return { level: "suspended", reason: "suspended", changesAt: null };
    case "trial":
      return { level: "full", reason: "trial", changesAt: iso(12) };
    default:
      return { level: "full", reason: "active", changesAt: null };
  }
}
const trialEndsAt = () => (state.scenario === "trial" ? iso(12) : null);
const role = () => state.role;

function status() {
  const base = {
    mode: "cloud",
    csrfToken: null,
    ...(state.captcha ? { captcha: { siteKey: "1x00000000000000000000AA" } } : {}),
    terms: { version: "2026-11-16" },
  };
  if (!state.signedIn) return { ...base, authenticated: false };
  const ws = (id, name, r) => ({ id, name, role: r, access: access() });
  return {
    ...base,
    authenticated: true,
    user: { id: "u1", email: state.email, name: state.name, role: role(), totp: state.totp },
    workspace: { ...ws("acc_1", state.wsName, role()), trialEndsAt: trialEndsAt() },
    workspaces: [
      ws("acc_1", state.wsName, role()),
      ...(state.workspaces > 1 ? [ws("acc_2", "Babbage partnership", "editor")] : []),
    ],
    csrfToken: "mock",
    expiresAt: iso(30),
  };
}

function billing() {
  const s = state.scenario;
  const trial = s === "trial";
  return {
    status: trial
      ? "trialing_local"
      : s === "readonly"
        ? "trialing_local"
        : s === "pastdue"
          ? "past_due"
          : "active",
    productId: "cloud",
    plan: trial || s === "readonly" ? null : "Glideworth Cloud",
    lookupKey: trial || s === "readonly" ? null : "cloud_monthly_v1",
    interval: trial || s === "readonly" ? null : "month",
    trialEndsAt: trial ? trialEndsAt() : s === "readonly" ? iso(-3) : null,
    currentPeriodEnd: trial || s === "readonly" ? null : iso(19),
    cancelAtPeriodEnd: s === "cancelling",
    access: access(),
    role: role(),
    offered: [
      {
        lookupKey: "cloud_monthly_v1",
        interval: "month",
        product: "Glideworth Cloud",
        unitAmount: 900,
        currency: "usd",
        taxBehavior: "exclusive",
      },
      {
        lookupKey: "cloud_yearly_v1",
        interval: "year",
        product: "Glideworth Cloud",
        unitAmount: 9000,
        currency: "usd",
        taxBehavior: "exclusive",
      },
    ],
  };
}

const ok = { status: "ok" };
/** METHOD path -> [status, body]. */
function route(method, path, body) {
  const key = `${method} ${path}`;
  switch (key) {
    case "GET /api/v1/auth/status":
      return [200, status()];
    case "POST /api/v1/auth/signup":
      return [202, { status: "check-email" }];
    case "POST /api/v1/auth/resend-verification":
    case "POST /api/v1/auth/password/forgot":
      return [202, { status: "check-email" }];
    case "POST /api/v1/auth/verify":
      if (body?.token !== "good") return [400, err("INVALID_TOKEN", "this link is not valid")];
      state.signedIn = true;
      return [200, { status: "signed-in", redirectTo: "/", csrfToken: "mock" }];
    case "POST /api/v1/auth/signin":
      if (!body?.password || body.password.length < 12)
        return [401, err("UNAUTHORIZED", "email or password is wrong")];
      if (state.totp)
        return [
          200,
          { status: "totp-required", next: "totp", challenge: "chal-1", expiresAt: iso(0.003) },
        ];
      state.signedIn = true;
      return [200, { status: "signed-in", redirectTo: "/", csrfToken: "mock" }];
    case "POST /api/v1/auth/signin/totp":
      if (body?.code !== "123456" && !body?.recoveryCode)
        return [401, err("UNAUTHORIZED", "the code is wrong")];
      state.signedIn = true;
      return [200, { status: "signed-in", redirectTo: "/", csrfToken: "mock" }];
    case "POST /api/v1/auth/password/reset":
      state.signedIn = true;
      return [200, { status: "signed-in", redirectTo: "/", csrfToken: "mock" }];
    case "POST /api/v1/auth/signout":
      state.signedIn = false;
      return [204, null];
    case "POST /api/v1/auth/reauth":
      return [200, { status: "ok", csrfToken: "mock" }];
    case "GET /api/v1/account/profile":
      return [
        200,
        {
          id: "u1",
          email: state.email,
          name: state.name,
          emailVerifiedAt: iso(-9),
          twoFactorEnabled: state.totp,
          signinAlerts: state.alerts,
          checkinEmails: true,
        },
      ];
    case "PATCH /api/v1/account/profile":
      if (typeof body?.name === "string") state.name = body.name;
      if (typeof body?.signinAlerts === "boolean") state.alerts = body.signinAlerts;
      return [200, ok];
    case "POST /api/v1/account/email":
      return [202, { status: "check-email" }];
    case "POST /api/v1/account/password":
      return [200, { ...ok, csrfToken: "mock" }];
    case "GET /api/v1/account/sessions":
      return [
        200,
        {
          items: [
            {
              id: "aaaaaaaaaaaaaaaa",
              device: "Chrome on macOS",
              ip: "203.0.113.5",
              createdAt: iso(-2),
              lastSeenAt: new Date().toISOString(),
              current: true,
            },
            {
              id: "bbbbbbbbbbbbbbbb",
              device: "Safari on iPhone",
              ip: "198.51.100.9",
              createdAt: iso(-20),
              lastSeenAt: iso(-3),
              current: false,
            },
            {
              id: "cccccccccccccccc",
              device: "Firefox on Windows",
              ip: "192.0.2.44",
              createdAt: iso(-40),
              lastSeenAt: iso(-11),
              current: false,
            },
          ],
        },
      ];
    case "POST /api/v1/account/totp/begin":
      return [
        200,
        {
          secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
          otpauthUri: `otpauth://totp/Glideworth:${state.email}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Glideworth`,
        },
      ];
    case "POST /api/v1/account/totp/confirm":
      state.totp = true;
      return [200, { recoveryCodes: Array.from({ length: 10 }, (_, i) => `k${i}q4m-7wz${i}x`) }];
    case "DELETE /api/v1/account/totp":
      state.totp = false;
      return [204, null];
    case "POST /api/v1/account/recovery-codes":
      return [200, { recoveryCodes: Array.from({ length: 10 }, (_, i) => `n${i}b8c-2fd${i}h`) }];
    case "GET /api/v1/account/personal-data":
      return [200, { profile: { email: state.email } }];
    case "GET /api/v1/workspace/settings":
      return [
        200,
        {
          id: "acc_1",
          name: state.wsName,
          mcpWrites: state.mcpWrites,
          status: "active",
          role: role(),
          limits: { editors: 3, viewers: 2 },
          trialEndsAt: trialEndsAt(),
        },
      ];
    case "PATCH /api/v1/workspace/settings":
      if (typeof body?.name === "string") state.wsName = body.name;
      if (typeof body?.mcpWrites === "boolean") state.mcpWrites = body.mcpWrites;
      return [200, ok];
    case "GET /api/v1/workspace/members":
      return [200, { items: state.members }];
    case "GET /api/v1/workspace/invitations":
      return [200, { items: state.invitations }];
    case "POST /api/v1/workspace/invitations":
      state.invitations.push({
        id: `inv${state.invitations.length + 2}`,
        email: body.email,
        role: body.role,
        expiresAt: iso(7),
      });
      return [201, { id: "invx" }];
    case "GET /api/v1/workspace/support-grants":
      return [
        200,
        {
          items: [
            {
              id: "g1",
              reason: "Help with my import",
              expiresAt: iso(2),
              revokedAt: null,
              createdAt: iso(-1),
            },
          ],
        },
      ];
    case "POST /api/v1/workspace/export":
      return [202, { exportId: "exp_1", expiresAt: iso(1) }];
    case "GET /api/v1/billing":
      return [200, billing()];
    case "POST /api/v1/billing/checkout":
      return [200, { url: "https://checkout.stripe.com/c/pay/mock", reused: false }];
    case "POST /api/v1/billing/portal":
      return [200, { url: "https://billing.stripe.com/p/session/mock" }];
    case "POST /api/v1/workspace/invitations/accept":
      return [200, { userId: "u1", role: "editor", name: state.name, workspaceId: "acc_2" }];
    default: {
      if (method === "DELETE" || method === "POST" || method === "PATCH")
        if (/^\/api\/v1\/(workspace|workspaces|account)\//.test(path)) return [204, null];
      return [404, err("NOT_FOUND", "not found")];
    }
  }
}
const err = (code, message) => ({ error: { code, message } });

export function cloudMock() {
  return {
    name: "glideworth-cloud-mock",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/__mock/set") {
          const q = url.searchParams;
          if (q.has("scenario")) state.scenario = q.get("scenario");
          if (q.has("role")) state.role = q.get("role");
          if (q.has("totp")) state.totp = q.get("totp") === "1";
          if (q.has("workspaces")) state.workspaces = Number(q.get("workspaces"));
          if (q.has("signedin")) state.signedIn = q.get("signedin") === "1";
          if (q.has("captcha")) state.captcha = q.get("captcha") === "1";
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(state.scenario));
          return;
        }
        const isApi = url.pathname.startsWith("/api/") || url.pathname === "/health";
        if (!isApi) return next();
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          let body;
          try {
            body = raw ? JSON.parse(raw) : undefined;
          } catch {
            body = undefined;
          }
          const [code, payload] = route(req.method ?? "GET", url.pathname, body);
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.end(payload === null ? "" : JSON.stringify(payload));
        });
      });
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 4399);
  const server = await preview({
    root: fileURLToPath(new URL("..", import.meta.url)),
    plugins: [cloudMock()],
    preview: { port, strictPort: true, host: "127.0.0.1" },
  });
  server.printUrls();
}
