/**
 * Operator console (spec 6.3): a separate Hono app served only on the private listener
 * (`GLIDEWORTH_OPS_LISTEN`). Server-rendered HTML, no script, a strict CSP, every value escaped.
 *
 * - Requests are refused unless they arrived on the ops listener's own socket (checked per request against the
 *   bound address), so mounting this app's `fetch` on the public port serves nothing.
 * - Operators sign in with password and a TOTP code (mandatory); sessions are 8 h absolute, 30 min idle;
 *   `__Host-gw_ops` cookie (HttpOnly, Secure, SameSite=Strict). Every POST carries the session's CSRF token
 *   (sign-in uses a double-submit token) and must be same-origin.
 * - Every page view and action is audited (`operator.viewed_account` / `operator.action`).
 * - Shown: control-plane facts only (ids, owner email, dates, status, access, plan, Stripe ids, counts, sizes,
 *   usage, backups, health). Never shown: workspace names (free text), person names, anything inside a tenant
 *   database. The one exception is the support view: an `admin` operator, a live owner-created support grant,
 *   read-only, watermarked, audited (`support_grant.used`, visible to the owner), and the owner is emailed on
 *   the grant's first use (`security-change`, kind `support-access-used`).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { BillingService } from "@glideworth/billing";
import { and, asc, count, desc, eq, gt, inArray, isNull, like, lte, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { normalizeEmail } from "../accounts/email.js";
import { controlBillingStore } from "../control/billing-store.js";
import {
  accounts,
  auditEvents,
  backups,
  emailLog,
  memberships,
  sessions,
  stripeEvents,
  subscriptions,
  supportGrants,
  tenantKeys,
  tenantSchedules,
  users,
} from "../control/schema.js";
import { withWriterLock } from "../control/writer-lock.js";
import { isAccountId, USER_ID_RE } from "../crypto/random.js";
import { CloudError } from "../errors.js";
import { clientIp } from "../http/common.js";
import { type Html, html, page, raw, securityHeaders } from "../http/html.js";
import type { CloudHttpDeps } from "../http/kit.js";
import { METRICS } from "../quotas.js";
import { type OperatorContext, OperatorService } from "./operators.js";

export const OPS_COOKIE = "__Host-gw_ops";
const PRE_COOKIE = "__Host-gw_ops_pre";

export interface OpsAppOptions {
  /** The address the ops listener is bound to (set once listening). Requests from any other socket are refused. */
  boundTo: () => { port: number; address?: string } | null;
}

type OpsEnv = { Variables: { op: OperatorContext } };

const fmtBytes = (n: number | null | undefined) =>
  n === null || n === undefined
    ? ""
    : n < 1024 * 1024
      ? `${Math.round(n / 1024)} KiB`
      : `${(n / 1024 / 1024).toFixed(1)} MiB`;

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createOpsApp(d: CloudHttpDeps, o: OpsAppOptions): Hono<OpsEnv> {
  const app = new Hono<OpsEnv>();
  const ops = new OperatorService({
    db: d.db,
    keys: d.keys,
    limiter: d.limiter,
    audit: d.audit,
    ...(d.now ? { now: d.now } : {}),
  });
  const now = () => d.now?.() ?? new Date();
  const store = controlBillingStore(d.db);
  const ip = (c: Context) => clientIp(c, false);

  const audit = (
    op: OperatorContext,
    event: string,
    accountId: string | null,
    detail: Record<string, string | number | boolean | null>,
  ) =>
    d.audit.record({
      actorType: "operator",
      actorId: op.operatorId,
      accountId,
      event,
      ip: null,
      detail,
    });

  // ---------------------------------------------------------------------------------------- listener guard
  app.use("*", async (c, next) => {
    const bound = o.boundTo();
    const socket = (
      c.env as { incoming?: { socket?: { localPort?: number; localAddress?: string } } } | undefined
    )?.incoming?.socket;
    const norm = (a: string | undefined) => (a ?? "").replace(/^::ffff:/, "");
    const wildcard = !bound?.address || bound.address === "0.0.0.0" || bound.address === "::";
    if (
      !bound ||
      socket?.localPort === undefined ||
      socket.localPort !== bound.port ||
      (!wildcard && norm(socket.localAddress) !== norm(bound.address))
    )
      return c.text("Not Found", 404);
    await next();
    securityHeaders(c);
  });

  app.onError((err, c) => {
    securityHeaders(c);
    if (err instanceof CloudError)
      return c.html(
        page(
          "Error",
          html`<h1>${err.status}</h1>
            <p>${err.message}</p>
            <p><a href="/">Back</a></p>`,
        ),
        err.status as 400,
      );
    d.log.error("ops.unhandled", { route: c.req.routePath, err });
    return c.html(page("Error", html`<h1>Something went wrong</h1>`), 500);
  });

  const sameOrigin = (c: Context) => {
    const origin = c.req.header("origin");
    const host = c.req.header("host");
    if (origin !== undefined && origin !== `http://${host}` && origin !== `https://${host}`)
      throw new CloudError(403, "CSRF", "cross-origin request refused");
    const site = c.req.header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin" && site !== "none")
      throw new CloudError(403, "CSRF", "cross-site request refused");
  };

  const form = async (c: Context): Promise<Record<string, string>> => {
    const type = c.req.header("content-type") ?? "";
    if (!/application\/x-www-form-urlencoded/i.test(type)) return {};
    const len = Number(c.req.header("content-length") ?? "0");
    if (len > 16 * 1024) throw new CloudError(413, "PAYLOAD_TOO_LARGE", "request body too large");
    const b = await c.req.parseBody();
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(b)) if (typeof v === "string") out[k] = v.slice(0, 2000);
    return out;
  };

  // ------------------------------------------------------------------------------------------------ login
  app.get("/login", (c) => {
    const pre = randomBytes(24).toString("base64url");
    setCookie(c, PRE_COOKIE, pre, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
      maxAge: 600,
    });
    return c.html(
      page(
        "Operator sign-in",
        html`<h1>Operator sign-in</h1>
          <form method="post" action="/login" class="box">
            <input type="hidden" name="_csrf" value="${pre}" />
            <p>
              <label
                >Email <input name="email" type="email" autocomplete="username" required
              /></label>
            </p>
            <p>
              <label
                >Password
                <input name="password" type="password" autocomplete="current-password" required
              /></label>
            </p>
            <p>
              <label
                >Authenticator code
                <input name="code" inputmode="numeric" autocomplete="one-time-code" required
              /></label>
            </p>
            <button type="submit">Sign in</button>
          </form>`,
      ),
    );
  });

  app.post("/login", async (c) => {
    sameOrigin(c);
    const f = await form(c);
    const pre = getCookie(c, PRE_COOKIE) ?? "";
    if (!pre || !f._csrf || !safeEq(pre, f._csrf))
      throw new CloudError(403, "CSRF", "reload the sign-in page and try again");
    const s = await ops.signIn(
      { email: f.email ?? "", password: f.password ?? "", code: f.code ?? "" },
      ip(c),
    );
    setCookie(c, OPS_COOKIE, s.token, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
      maxAge: s.maxAgeSeconds,
    });
    setCookie(c, PRE_COOKIE, "", {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
      maxAge: 0,
    });
    return c.redirect("/", 303);
  });

  // --------------------------------------------------------------------------------------- authenticated
  app.use("*", async (c, next) => {
    const op = ops.resolve(getCookie(c, OPS_COOKIE));
    if (!op) return c.redirect("/login", 303);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      sameOrigin(c);
      const f = await form(c);
      if (!f._csrf || !safeEq(f._csrf, op.csrf))
        throw new CloudError(403, "CSRF", "invalid form token; reload the page");
      (c as unknown as { _form: Record<string, string> })._form = f;
    }
    c.set("op", op);
    await next();
  });
  const fields = (c: Context) => (c as unknown as { _form?: Record<string, string> })._form ?? {};
  const requireAdmin = (op: OperatorContext) => {
    if (op.role !== "admin") throw new CloudError(403, "FORBIDDEN", "admin operators only");
  };

  const nav = (op: OperatorContext) =>
    html`<header>
      <strong>Glideworth ops</strong><a href="/">Health</a><a href="/workspaces">Workspaces</a
      ><a href="/users">Users</a><a href="/stripe-events">Stripe events</a>
      <span class="muted">${op.email} (${op.role})</span>
      <form class="inline" method="post" action="/logout">
        <input type="hidden" name="_csrf" value="${op.csrf}" /><button>Sign out</button>
      </form>
    </header>`;
  const render = (c: Context, title: string, body: Html, watermark?: string) =>
    c.html(page(title, body, { nav: nav(c.get("op")), ...(watermark ? { watermark } : {}) }));
  const action = (op: OperatorContext, path: string, label: string, extra: Html = raw("")) =>
    html`<form class="inline" method="post" action="${path}">
      <input type="hidden" name="_csrf" value="${op.csrf}" />${extra}<button>${label}</button>
    </form>`;

  app.post("/logout", (c) => {
    ops.signOut(getCookie(c, OPS_COOKIE));
    audit(c.get("op"), "operator.signout", null, {});
    setCookie(c, OPS_COOKIE, "", {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
      maxAge: 0,
    });
    return c.redirect("/login", 303);
  });

  // ----------------------------------------------------------------------------------------------- health
  app.get("/", (c) => {
    const op = c.get("op");
    audit(op, "operator.action", null, { action: "view", page: "health" });
    const byStatus = d.db
      .select({ status: accounts.status, n: count() })
      .from(accounts)
      .groupBy(accounts.status)
      .all();
    const failedEvents =
      d.db.select({ n: count() }).from(stripeEvents).where(eq(stripeEvents.status, "failed")).get()
        ?.n ?? 0;
    const since = new Date(now().getTime() - 24 * 3600_000).toISOString();
    const mailFailures =
      d.db
        .select({ n: count() })
        .from(emailLog)
        .where(and(eq(emailLog.status, "failed"), gt(emailLog.createdAt, since)))
        .get()?.n ?? 0;
    const reg = d.registry?.stats() ?? null;
    const b = d.backups.newestAt();
    const outbox = d.outbox?.stats() ?? null;
    const extra = d.health?.() ?? {};
    const oldestDue = d.db
      .select({ at: tenantSchedules.nextCheckinAt })
      .from(tenantSchedules)
      .innerJoin(accounts, eq(accounts.id, tenantSchedules.accountId))
      .where(
        and(eq(accounts.status, "active"), lte(tenantSchedules.nextCheckinAt, now().toISOString())),
      )
      .orderBy(asc(tenantSchedules.nextCheckinAt))
      .limit(1)
      .get()?.at;
    const lagSeconds = oldestDue ? Math.round((now().getTime() - Date.parse(oldestDue)) / 1000) : 0;
    const rows: Array<[string, string | number | null]> = [
      ...byStatus.map((r): [string, number] => [`workspaces ${r.status}`, r.n]),
      ["users", d.db.select({ n: count() }).from(users).get()?.n ?? 0],
      ["open tenants", reg?.open ?? null],
      ["leased tenants", reg?.leased ?? null],
      ["busy tenants", reg?.busy ?? null],
      ["scheduler lag (s)", lagSeconds],
      ["failed Stripe events", failedEvents],
      ["email failures (24 h)", mailFailures],
      ["outbox pending", outbox?.pending ?? null],
      ["outbox dead", outbox?.dead ?? null],
      ["newest tenant backup", b.tenant],
      ["newest control backup", b.control],
      ["newest verified restore", b.verified],
      ...Object.entries(extra),
    ];
    return render(
      c,
      "Health",
      html`<h1>Health</h1>
        <table>
          ${rows.map(
            ([k, v]) =>
              html`<tr>
                <th>${k}</th>
                <td>${v}</td>
              </tr>`,
          )}
        </table>
        ${op.role === "admin" ? html`<p>${action(op, "/migrate-all", "Run migrateAll")} ${action(op, "/billing/sweep", "Retry failed Stripe events")}</p>` : ""}`,
    );
  });

  // ------------------------------------------------------------------------------------------- workspaces
  const ownerEmail = (accountId: string) =>
    d.db
      .select({ email: users.email })
      .from(accounts)
      .innerJoin(users, eq(users.id, accounts.ownerUserId))
      .where(eq(accounts.id, accountId))
      .get()?.email ?? null;

  app.get("/workspaces", (c) => {
    const op = c.get("op");
    const q = (c.req.query("q") ?? "").trim();
    const status = c.req.query("status") ?? "";
    audit(op, "operator.action", null, { action: "view", page: "workspaces" });
    const conds = [];
    if (isAccountId(q)) conds.push(eq(accounts.id, q));
    else if (q) {
      const norm = normalizeEmail(q);
      conds.push(eq(users.emailNormalized, norm ?? "\u0000"));
    }
    if (["active", "suspended", "deleting", "deleted", "migration_failed"].includes(status))
      conds.push(eq(accounts.status, status as "active"));
    const rows = d.db
      .select({
        id: accounts.id,
        status: accounts.status,
        createdAt: accounts.createdAt,
        lastActiveAt: accounts.lastActiveAt,
        dbBytes: accounts.dbBytes,
        schemaVersion: accounts.schemaVersion,
        email: users.email,
        sub: subscriptions.status,
        lookupKey: subscriptions.priceLookupKey,
        members: sql<number>`(SELECT count(*) FROM memberships m WHERE m.account_id = ${accounts.id})`,
      })
      .from(accounts)
      .leftJoin(users, eq(users.id, accounts.ownerUserId))
      .leftJoin(subscriptions, eq(subscriptions.accountId, accounts.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(accounts.createdAt))
      .limit(200)
      .all();
    return render(
      c,
      "Workspaces",
      html`<h1>Workspaces</h1>
        <form method="get" class="box">
          <input name="q" placeholder="workspace id or owner email" value="${q}" />
          <select name="status">
            <option value="">any status</option>
            ${["active", "suspended", "deleting", "deleted", "migration_failed"].map(
              (s) => html`<option ${s === status ? raw("selected") : ""}>${s}</option>`,
            )}</select
          ><button>Search</button>
        </form>
        <table>
          <tr>
            <th>Id</th>
            <th>Owner</th>
            <th>Status</th>
            <th>Access</th>
            <th>Billing</th>
            <th>Members</th>
            <th>DB</th>
            <th>Schema</th>
            <th>Created</th>
            <th>Last active</th>
          </tr>
          ${rows.map((r) => {
            const e = d.entitlements.get(r.id);
            return html`<tr>
              <td><a href="/workspaces/${r.id}">${r.id}</a></td>
              <td>${r.email}</td>
              <td>${r.status}</td>
              <td>${e.level} (${e.reason})</td>
              <td>${r.sub} ${r.lookupKey}</td>
              <td>${r.members}</td>
              <td>${fmtBytes(r.dbBytes)}</td>
              <td>${r.schemaVersion}</td>
              <td>${r.createdAt}</td>
              <td>${r.lastActiveAt}</td>
            </tr>`;
          })}
        </table>`,
    );
  });

  app.get("/workspaces/:id", (c) => {
    const op = c.get("op");
    const id = c.req.param("id");
    if (!isAccountId(id)) throw new CloudError(404, "NOT_FOUND", "no such workspace");
    const a = d.db.select().from(accounts).where(eq(accounts.id, id)).get();
    if (!a) throw new CloudError(404, "NOT_FOUND", "no such workspace");
    audit(op, "operator.viewed_account", id, {});
    const sub = store.getSubscription(id);
    const e = d.entitlements.get(id);
    const usage = d.quotas.usage(id);
    const lastBackup = d.db
      .select({ at: backups.createdAt, verifiedAt: backups.verifiedAt, bytes: backups.bytes })
      .from(backups)
      .where(eq(backups.accountId, id))
      .orderBy(desc(backups.createdAt))
      .limit(1)
      .get();
    const lastVerified = d.db
      .select({ at: backups.verifiedAt })
      .from(backups)
      .where(and(eq(backups.accountId, id), sql`${backups.verifiedAt} IS NOT NULL`))
      .orderBy(desc(backups.verifiedAt))
      .limit(1)
      .get();
    const key = d.db
      .select({ destroyedAt: tenantKeys.destroyedAt })
      .from(tenantKeys)
      .where(eq(tenantKeys.accountId, id))
      .get();
    const memberRows = d.db
      .select({ userId: memberships.userId, role: memberships.role, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.accountId, id))
      .orderBy(asc(memberships.createdAt))
      .all();
    const grant = liveGrant(id);
    const flags = d.db
      .select({ event: auditEvents.event, at: auditEvents.at })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.accountId, id),
          inArray(auditEvents.event, [
            "billing.dispute",
            "billing.duplicate_subscription",
            "billing.alert",
          ]),
        ),
      )
      .orderBy(desc(auditEvents.at))
      .limit(10)
      .all();
    const stripe = (kind: "customers" | "subscriptions", v: string | null | undefined) =>
      v && /^[A-Za-z0-9_]+$/.test(v)
        ? html`<a href="https://dashboard.stripe.com/${kind}/${v}" rel="noreferrer">${v}</a>`
        : "";
    const rows: Array<[string, Html | string | number | null]> = [
      ["Id", a.id],
      ["Owner", ownerEmail(id)],
      ["Status", a.status],
      ["Access", `${e.level} (${e.reason})${e.changesAt ? ` until ${e.changesAt}` : ""}`],
      ["Subscription", sub ? `${sub.status} ${sub.priceLookupKey ?? ""}` : "none"],
      ["Trial ends", sub?.trialEndsAt ?? null],
      ["Period ends", sub?.currentPeriodEnd ?? null],
      ["Cancel at period end", sub ? String(sub.cancelAtPeriodEnd) : null],
      ["Comped until", sub?.compedUntil ?? null],
      ["Stripe customer", stripe("customers", sub?.stripeCustomerId)],
      ["Stripe subscription", stripe("subscriptions", sub?.stripeSubscriptionId)],
      ["MCP writes", String(a.mcpWrites)],
      ["DB size", fmtBytes(a.dbBytes)],
      ["Schema version", a.schemaVersion],
      ["Created", a.createdAt],
      ["Last active", a.lastActiveAt],
      ["Last backup", lastBackup?.at ?? null],
      ["Last verified restore", lastVerified?.at ?? null],
      [
        "Backup key",
        key?.destroyedAt ? `destroyed ${key.destroyedAt}` : key ? "present" : "missing",
      ],
      ["Support grant", grant ? `live until ${grant.expiresAt}` : "none"],
    ];
    const admin = op.role === "admin";
    return render(
      c,
      "Workspace",
      html`<h1>Workspace</h1>
        <table>
          ${rows.map(
            ([k, v]) =>
              html`<tr>
                <th>${k}</th>
                <td>${v}</td>
              </tr>`,
          )}
        </table>
        <h2>Usage today</h2>
        <table>
          ${METRICS.map(
            (m) =>
              html`<tr>
                <th>${m}</th>
                <td>${usage[m]}</td>
              </tr>`,
          )}
        </table>
        <h2>Members</h2>
        <table>
          <tr>
            <th>User</th>
            <th>Email</th>
            <th>Role</th>
          </tr>
          ${memberRows.map(
            (m) =>
              html`<tr>
                <td><a href="/users/${m.userId}">${m.userId}</a></td>
                <td>${m.email}</td>
                <td>${m.role}</td>
              </tr>`,
          )}
        </table>
        ${
          flags.length
            ? html`<h2 class="warn">Billing alerts</h2>
                <ul>
                  ${flags.map((f) => html`<li>${f.event} ${f.at}</li>`)}
                </ul>`
            : ""
        }
        <h2>Actions</h2>
        <div class="box">
          ${action(op, `/workspaces/${id}/extend-trial`, "Extend trial", html`<input name="days" type="number" min="1" max="90" value="7" /> `)}
          ${action(op, `/workspaces/${id}/comp`, "Comp until", html`<input name="until" type="date" required /> `)}
          ${a.status === "suspended" ? action(op, `/workspaces/${id}/unsuspend`, "Unsuspend") : action(op, `/workspaces/${id}/suspend`, "Suspend")}
          ${admin ? action(op, `/workspaces/${id}/restore`, "Restore from backup", html`<input name="at" placeholder="ISO time (empty = latest)" /> `) : ""}
          ${admin ? action(op, `/workspaces/${id}/refund`, "Refund", html`<input name="chargeId" placeholder="ch_..." required /> <input name="amount" type="number" min="1" placeholder="minor units (empty = full)" /> <input name="reason" placeholder="reason" required /> `) : ""}
          ${admin ? action(op, `/workspaces/${id}/delete`, "Delete (customer request)", html`<input name="confirm" placeholder="type the workspace id" required /> `) : ""}
          ${admin && grant ? html`<a href="/workspaces/${id}/support-view">Open support view (read-only)</a>` : ""}
        </div>`,
    );
  });

  const liveGrant = (accountId: string) =>
    d.db
      .select()
      .from(supportGrants)
      .where(
        and(
          eq(supportGrants.accountId, accountId),
          isNull(supportGrants.revokedAt),
          gt(supportGrants.expiresAt, now().toISOString()),
        ),
      )
      .orderBy(desc(supportGrants.expiresAt))
      .get();

  const done = (c: Context, path: string) => c.redirect(path, 303);
  const accountParam = (c: Context): string => {
    const id = c.req.param("id");
    if (
      !isAccountId(id) ||
      !d.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, id)).get()
    )
      throw new CloudError(404, "NOT_FOUND", "no such workspace");
    return id;
  };

  app.post("/workspaces/:id/extend-trial", async (c) => {
    const op = c.get("op");
    const id = accountParam(c);
    const days = Number(fields(c).days);
    if (!Number.isInteger(days) || days < 1 || days > 90)
      throw new CloudError(400, "VALIDATION", "days must be 1-90");
    await withWriterLock(d.db, `billing:${id}`, async () => {
      const rec = store.getSubscription(id);
      if (rec?.status !== "trialing_local")
        throw new CloudError(409, "CONFLICT", "only a local trial can be extended");
      const base = Math.max(now().getTime(), rec.trialEndsAt ? Date.parse(rec.trialEndsAt) : 0);
      store.saveSubscription({
        ...rec,
        trialEndsAt: new Date(base + days * 86_400_000).toISOString(),
        updatedAt: now().toISOString(),
      });
    });
    audit(op, "operator.action", id, { action: "extend_trial", days });
    return done(c, `/workspaces/${id}`);
  });

  app.post("/workspaces/:id/comp", async (c) => {
    const op = c.get("op");
    const id = accountParam(c);
    const until = fields(c).until ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(until)))
      throw new CloudError(400, "VALIDATION", "until must be a date");
    await withWriterLock(d.db, `billing:${id}`, async () =>
      (d.billing as BillingService).comp(id, new Date(until).toISOString()),
    );
    audit(op, "operator.action", id, { action: "comp", at: new Date(until).toISOString() });
    return done(c, `/workspaces/${id}`);
  });

  for (const [path, status, event] of [
    ["suspend", "suspended", "workspace.suspended"],
    ["unsuspend", "active", "workspace.unsuspended"],
  ] as const) {
    app.post(`/workspaces/:id/${path}`, async (c) => {
      const op = c.get("op");
      const id = accountParam(c);
      const from = status === "suspended" ? "active" : "suspended";
      const res = d.db
        .update(accounts)
        .set({ status })
        .where(and(eq(accounts.id, id), eq(accounts.status, from)))
        .run();
      if (res.changes !== 1) throw new CloudError(409, "CONFLICT", `the workspace is not ${from}`);
      if (status === "suspended") await d.registry?.close(id);
      d.audit.record({ actorType: "operator", actorId: op.operatorId, accountId: id, event });
      audit(op, "operator.action", id, { action: path });
      return done(c, `/workspaces/${id}`);
    });
  }

  app.post("/workspaces/:id/restore", async (c) => {
    const op = c.get("op");
    requireAdmin(op);
    const id = accountParam(c);
    const at = (fields(c).at ?? "").trim();
    const r = await d.backups.restoreTenant(id, {
      ...(at ? { at } : {}),
      operatorId: op.operatorId,
    });
    d.audit.record({
      actorType: "operator",
      actorId: op.operatorId,
      accountId: id,
      event: "workspace.restored",
    });
    audit(op, "operator.action", id, { action: "restore", at: at || null });
    d.log.info("ops.restore", {
      accountId: id,
      operatorId: op.operatorId,
      outcome: r.previous ? "replaced" : "created",
    });
    return done(c, `/workspaces/${id}`);
  });

  app.post("/workspaces/:id/refund", async (c) => {
    const op = c.get("op");
    requireAdmin(op);
    const id = accountParam(c);
    const f = fields(c);
    const amount = f.amount ? Number(f.amount) : undefined;
    try {
      await (d.billing as BillingService).refund({
        accountId: id,
        chargeId: f.chargeId ?? "",
        ...(amount !== undefined ? { amount } : {}),
        reason: f.reason ?? "",
        operatorId: op.operatorId,
      });
    } catch (err) {
      if (err instanceof RangeError)
        throw new CloudError(400, "VALIDATION", "check the charge id, amount and reason");
      throw err;
    }
    d.audit.record({
      actorType: "operator",
      actorId: op.operatorId,
      accountId: id,
      event: "billing.refund",
    });
    audit(op, "operator.action", id, { action: "refund" });
    return done(c, `/workspaces/${id}`);
  });

  app.post("/workspaces/:id/delete", async (c) => {
    const op = c.get("op");
    requireAdmin(op);
    const id = accountParam(c);
    if (fields(c).confirm !== id)
      throw new CloudError(400, "VALIDATION", "type the workspace id to confirm");
    const a = d.db
      .select({ owner: accounts.ownerUserId })
      .from(accounts)
      .where(eq(accounts.id, id))
      .get();
    if (!a?.owner) throw new CloudError(409, "CONFLICT", "the workspace has no owner");
    audit(op, "operator.action", id, { action: "delete" });
    await d.workspaces.deleteOwnedByUser(a.owner, id);
    return done(c, "/workspaces");
  });

  app.get("/workspaces/:id/support-view", async (c) => {
    const op = c.get("op");
    requireAdmin(op);
    const id = accountParam(c);
    const grant = liveGrant(id);
    if (!grant) throw new CloudError(403, "FORBIDDEN", "no live support grant for this workspace");
    const firstUse = !d.db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.event, "support_grant.used"),
          like(auditEvents.detail, `%"grantId":"${grant.id}"%`),
        ),
      )
      .get();
    d.audit.record({
      actorType: "operator",
      actorId: op.operatorId,
      accountId: id,
      event: "support_grant.used",
      detail: { grantId: grant.id },
    });
    if (firstUse) {
      // The owner sees `support_grant.used` in the workspace audit trail and is emailed once per grant.
      d.log.warn("ops.support_grant_first_use", { accountId: id, operatorId: op.operatorId });
      const owner = d.db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(accounts)
        .innerJoin(users, eq(users.id, accounts.ownerUserId))
        .where(eq(accounts.id, id))
        .get();
      if (owner && d.outbox) {
        d.outbox.enqueue({
          to: { email: owner.email, name: owner.name },
          userId: owner.id,
          template: "security-change",
          data: {
            name: owner.name,
            change: "support-access-used",
            at: now().toISOString().replace("T", " ").slice(0, 16) + " UTC",
            securityUrl: `${d.config.publicUrl.replace(/\/+$/, "")}/settings/workspace`,
          },
          dedupeKey: `support-access-used:${grant.id}`,
        });
        void d.outbox.drain().catch(() => undefined);
      }
    }
    if (!d.supportView || !d.registry)
      return render(
        c,
        "Support view",
        html`<h1>Support view</h1>
          <p>No viewer is configured.</p>`,
        "SUPPORT VIEW",
      );
    const view = await d.registry.with(id, (r) => d.supportView?.(r), { allowSuspended: true });
    return render(
      c,
      "Support view",
      html`<h1>Support view (read-only)</h1>
        <p class="warn">Grant ${grant.id}, until ${grant.expiresAt}. Every view is recorded.</p>
        ${(view?.sections ?? []).map(
          (s) =>
            html`<h2>${s.title}</h2>
              <table>
                ${s.rows.map(
                  ([k, v]) =>
                    html`<tr>
                      <th>${k}</th>
                      <td>${v}</td>
                    </tr>`,
                )}
              </table>`,
        )}`,
      `SUPPORT VIEW ${op.email}`,
    );
  });

  // ------------------------------------------------------------------------------------------------ users
  app.get("/users", (c) => {
    const op = c.get("op");
    const q = (c.req.query("q") ?? "").trim();
    audit(op, "operator.action", null, { action: "view", page: "users" });
    const norm = q ? normalizeEmail(q) : null;
    const rows =
      norm || USER_ID_RE.test(q)
        ? d.db
            .select()
            .from(users)
            .where(norm ? eq(users.emailNormalized, norm) : eq(users.id, q))
            .limit(20)
            .all()
        : [];
    return render(
      c,
      "Users",
      html`<h1>Users</h1>
        <form method="get" class="box">
          <input name="q" placeholder="exact email or user id" value="${q}" /><button>Find</button>
        </form>
        <table>
          <tr>
            <th>Id</th>
            <th>Email</th>
            <th>Verified</th>
            <th>2FA</th>
            <th>Last sign-in</th>
          </tr>
          ${rows.map(
            (u) =>
              html`<tr>
                <td><a href="/users/${u.id}">${u.id}</a></td>
                <td>${u.email}</td>
                <td>${u.emailVerifiedAt ? "yes" : "no"}</td>
                <td>${u.totpEnabledAt ? "on" : "off"}</td>
                <td>${u.lastSigninAt}</td>
              </tr>`,
          )}
        </table>`,
    );
  });

  const userParam = (c: Context) => {
    const id = c.req.param("id") ?? "";
    const u = USER_ID_RE.test(id)
      ? d.db.select().from(users).where(eq(users.id, id)).get()
      : undefined;
    if (!u) throw new CloudError(404, "NOT_FOUND", "no such user");
    return u;
  };

  app.get("/users/:id", (c) => {
    const op = c.get("op");
    const u = userParam(c);
    audit(op, "operator.action", null, { action: "view", page: "user" });
    const ms = d.db
      .select({ accountId: memberships.accountId, role: memberships.role, status: accounts.status })
      .from(memberships)
      .innerJoin(accounts, eq(accounts.id, memberships.accountId))
      .where(eq(memberships.userId, u.id))
      .all();
    const sessionCount =
      d.db.select({ n: count() }).from(sessions).where(eq(sessions.userId, u.id)).get()?.n ?? 0;
    return render(
      c,
      "User",
      html`<h1>User</h1>
        <table>
          <tr>
            <th>Id</th>
            <td>${u.id}</td>
          </tr>
          <tr>
            <th>Email</th>
            <td>${u.email}</td>
          </tr>
          <tr>
            <th>Verified</th>
            <td>${u.emailVerifiedAt ?? "no"}</td>
          </tr>
          <tr>
            <th>2FA</th>
            <td>${u.totpEnabledAt ? "on" : "off"}</td>
          </tr>
          <tr>
            <th>Last sign-in</th>
            <td>${u.lastSigninAt}</td>
          </tr>
          <tr>
            <th>Sessions</th>
            <td>${sessionCount}</td>
          </tr>
          <tr>
            <th>Disabled</th>
            <td>${u.disabledAt}</td>
          </tr>
        </table>
        <h2>Memberships</h2>
        <table>
          ${ms.map(
            (m) =>
              html`<tr>
                <td><a href="/workspaces/${m.accountId}">${m.accountId}</a></td>
                <td>${m.role}</td>
                <td>${m.status}</td>
              </tr>`,
          )}
        </table>
        <h2>Actions</h2>
        <div class="box">
          ${u.emailVerifiedAt ? "" : action(op, `/users/${u.id}/resend-verification`, "Resend verification")}
          ${action(op, `/users/${u.id}/signout-all`, "Sign out everywhere")}
        </div>`,
    );
  });

  app.post("/users/:id/resend-verification", async (c) => {
    const op = c.get("op");
    const u = userParam(c);
    await d.accounts.resendVerification(u.email, { ip: ip(c), userAgent: null, deviceToken: null });
    d.audit.record({
      actorType: "operator",
      actorId: op.operatorId,
      subjectUserId: u.id,
      event: "operator.action",
      detail: { action: "resend_verification" },
    });
    return done(c, `/users/${u.id}`);
  });

  app.post("/users/:id/signout-all", (c) => {
    const op = c.get("op");
    const u = userParam(c);
    const n = d.db.delete(sessions).where(eq(sessions.userId, u.id)).run().changes;
    d.audit.record({
      actorType: "operator",
      actorId: op.operatorId,
      subjectUserId: u.id,
      event: "operator.action",
      detail: { action: "signout_all", count: n },
    });
    return done(c, `/users/${u.id}`);
  });

  // -------------------------------------------------------------------------------------- stripe, migrate
  app.get("/stripe-events", (c) => {
    const op = c.get("op");
    audit(op, "operator.action", null, { action: "view", page: "stripe_events" });
    const rows = d.db
      .select({
        id: stripeEvents.id,
        type: stripeEvents.type,
        status: stripeEvents.status,
        attempts: stripeEvents.attempts,
        errorCode: stripeEvents.errorCode,
        accountId: stripeEvents.accountId,
        receivedAt: stripeEvents.receivedAt,
      })
      .from(stripeEvents)
      .where(inArray(stripeEvents.status, ["failed", "orphaned"]))
      .orderBy(desc(stripeEvents.receivedAt))
      .limit(200)
      .all();
    return render(
      c,
      "Stripe events",
      html`<h1>Failed and orphaned Stripe events</h1>
        ${op.role === "admin" ? html`<p>${action(op, "/billing/sweep", "Retry failed events now")}</p>` : ""}
        <table>
          <tr>
            <th>Event</th>
            <th>Type</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Error</th>
            <th>Workspace</th>
            <th>Received</th>
          </tr>
          ${rows.map(
            (r) =>
              html`<tr>
                <td>${r.id}</td>
                <td>${r.type}</td>
                <td>${r.status}</td>
                <td>${r.attempts}</td>
                <td>${r.errorCode}</td>
                <td>${r.accountId}</td>
                <td>${r.receivedAt}</td>
              </tr>`,
          )}
        </table>`,
    );
  });

  app.post("/billing/sweep", async (c) => {
    const op = c.get("op");
    requireAdmin(op);
    const r = await (d.billing as BillingService).sweep();
    audit(op, "operator.action", null, { action: "retry_stripe_events", count: r.retried });
    return done(c, "/stripe-events");
  });

  app.post("/migrate-all", async (c) => {
    const op = c.get("op");
    requireAdmin(op);
    if (!d.registry) throw new CloudError(503, "TENANT_UNAVAILABLE", "no registry");
    const r = await d.registry.migrateAll({ concurrency: 2 });
    audit(op, "operator.action", null, {
      action: "migrate_all",
      count: r.ok,
      status: r.failed.length ? "failures" : "ok",
    });
    return done(c, "/");
  });

  app.notFound((c) => c.text("Not Found", 404));
  return app;
}
