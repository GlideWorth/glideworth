/**
 * Email routes (spec 5.4).
 *
 * `GET /email/unsubscribe?t=` shows a confirmation page and changes nothing (link scanners follow GETs);
 * `POST /email/unsubscribe` (the page's form, or a mail client's RFC 8058 one-click POST) records the
 * suppression and turns the person's check-in emails off, or, for a `marketing` (list) token, marks the
 * calculator consent record unsubscribed. The signed token is the authorisation, so no session
 * or CSRF token is involved (one-click POSTs come from mail providers, cross-site by design).
 *
 * `POST /email/webhooks/mailgun` (review finding 4, spec 5.4 "provider bounce and complaint webhooks"):
 * HMAC-SHA256(signing key, timestamp + token) verified in constant time, timestamp within 15 minutes, each
 * token accepted once (replay table). Permanent failures and complaints suppress every category; the mailer
 * still attempts verification and password-reset mail (spec 5.4).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { eq, lt } from "drizzle-orm";
import type { Context } from "hono";
import { normalizeEmail } from "../../accounts/email.js";
import { controlEmailStores } from "../../control/email-stores.js";
import { users, webhookNonces } from "../../control/schema.js";
import { CloudError } from "../../errors.js";
import { recordListUnsubscribe } from "../../marketing/service.js";
import { html, page, securityHeaders } from "../html.js";
import type { RouteKit } from "../kit.js";

const MAILGUN_MAX_BYTES = 256 * 1024;
const MAILGUN_TOLERANCE_S = 15 * 60;

export function verifyMailgunSignature(
  key: string,
  sig: { timestamp?: unknown; token?: unknown; signature?: unknown },
  nowSeconds: number,
): boolean {
  const { timestamp, token, signature } = sig;
  if (typeof timestamp !== "string" || typeof token !== "string" || typeof signature !== "string")
    return false;
  if (
    !/^\d{1,12}$/.test(timestamp) ||
    token.length < 10 ||
    token.length > 200 ||
    !/^[0-9a-f]{64}$/.test(signature)
  )
    return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAILGUN_TOLERANCE_S) return false;
  const expected = createHmac("sha256", key)
    .update(timestamp + token)
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export function emailRoutes(k: RouteKit): void {
  const { d } = k;
  const tag = "Cloud email";
  const stores = controlEmailStores(d.db);

  const htmlPage = (
    c: Context,
    status: 200 | 400,
    title: string,
    body: ReturnType<typeof html>,
  ) => {
    securityHeaders(c);
    return c.html(page(title, body), status);
  };

  const tokenFrom = async (c: Context): Promise<string> => {
    const q = c.req.query("t");
    if (q) return q;
    const type = c.req.header("content-type") ?? "";
    if (/application\/x-www-form-urlencoded|multipart\/form-data/i.test(type)) {
      const form = await c.req.parseBody();
      return typeof form.t === "string" ? form.t : "";
    }
    return "";
  };

  k.op(
    {
      method: "get",
      path: "/email/unsubscribe",
      tag,
      summary: "Unsubscribe confirmation page (changes nothing)",
      auth: "none",
      ok: 200,
      query: z.object({ t: z.string().max(2048).optional() }),
      okSchema: z.string(),
      okContentType: "text/html",
    },
    (c, { query }) => {
      const v = query.t ? d.unsubscribe.verify(query.t) : null;
      if (!v)
        return htmlPage(
          c,
          400,
          "Link not valid",
          html`<h1>This link is not valid</h1>
            <p>You can change email settings in your account.</p>`,
        );
      const list = v.category === "marketing";
      return htmlPage(
        c,
        200,
        "Unsubscribe",
        html`<h1>${list ? "Stop Glideworth reminders and updates?" : "Stop check-in emails?"}</h1>
          <p>
            ${
              list
                ? "You will no longer get the yearly re-check reminder or Glideworth updates."
                : "You will no longer get scheduled check-in summaries. Account and security emails still arrive."
            }
          </p>
          <form method="post" action="/email/unsubscribe">
            <input type="hidden" name="t" value="${query.t}" /><button type="submit">
              Unsubscribe
            </button>
          </form>`,
      );
    },
  );

  k.op(
    {
      method: "post",
      path: "/email/unsubscribe",
      tag,
      summary: "Unsubscribe (form or RFC 8058 one-click)",
      auth: "none",
      ok: 200,
      rawBody: {
        contentType: "application/x-www-form-urlencoded",
        description: "`t=<token>` or `List-Unsubscribe=One-Click`",
      },
      okSchema: z.string(),
      okContentType: "text/html",
    },
    async (c) => {
      k.floodLimit(c, "unsubscribe", 300); // one-click POSTs come from a few mail-provider addresses
      const v = d.unsubscribe.verify(await tokenFrom(c));
      if (!v)
        return htmlPage(
          c,
          400,
          "Link not valid",
          html`<h1>This link is not valid</h1>
            <p>You can change email settings in your account.</p>`,
        );
      stores.suppressions.suppress(v.email, v.category, "unsubscribe");
      if (v.category === "checkin")
        d.db
          .update(users)
          .set({ checkinEmails: false })
          .where(eq(users.emailNormalized, v.email))
          .run();
      if (v.category === "marketing")
        recordListUnsubscribe(d.db, v.email, k.now(), d.productEvents ?? null);
      d.log.info("email.unsubscribed", { category: v.category });
      return htmlPage(
        c,
        200,
        "Unsubscribed",
        html`<h1>You are unsubscribed</h1>
          <p>
            ${
              v.category === "marketing"
                ? "No more reminders or updates will be sent."
                : "No more check-in emails will be sent."
            }
          </p>`,
      );
    },
  );

  if (!d.mailgunWebhookSigningKey) return;
  const signingKey = d.mailgunWebhookSigningKey;

  k.op(
    {
      method: "post",
      path: "/email/webhooks/mailgun",
      tag,
      summary: "Mailgun bounce and complaint events (signed)",
      auth: "none",
      ok: 200,
      rawBody: { contentType: "application/json", description: "Mailgun webhook payload" },
      okSchema: z.object({ status: z.string() }),
    },
    async (c) => {
      const raw = await c.req.text();
      if (Buffer.byteLength(raw, "utf8") > MAILGUN_MAX_BYTES)
        throw new CloudError(413, "PAYLOAD_TOO_LARGE", "request body too large");
      let body: { signature?: Record<string, unknown>; "event-data"?: Record<string, unknown> };
      try {
        body = JSON.parse(raw);
      } catch {
        throw new CloudError(400, "VALIDATION", "invalid request");
      }
      const now = k.now();
      if (
        !verifyMailgunSignature(signingKey, body.signature ?? {}, Math.floor(now.getTime() / 1000))
      ) {
        d.log.warn("email.webhook_signature_invalid", { provider: "mailgun" });
        throw new CloudError(401, "UNAUTHORIZED", "invalid signature");
      }
      const nonce = createHash("sha256").update(String(body.signature?.token)).digest("hex");
      d.db.delete(webhookNonces).where(lt(webhookNonces.expiresAt, now.toISOString())).run();
      const fresh =
        d.db
          .insert(webhookNonces)
          .values({ id: nonce, expiresAt: new Date(now.getTime() + 24 * 3600_000).toISOString() })
          .onConflictDoNothing()
          .run().changes === 1;
      if (!fresh) return c.json({ status: "duplicate" }, 200);
      const ev = body["event-data"] ?? {};
      const kind = ev.event;
      const permanent = kind === "failed" && ev.severity === "permanent";
      const recipient = typeof ev.recipient === "string" ? normalizeEmail(ev.recipient) : null;
      if (!recipient || (!permanent && kind !== "complained"))
        return c.json({ status: "ignored" }, 200);
      const reason = kind === "complained" ? "complaint" : "bounce";
      stores.suppressions.suppress(recipient, "all", reason);
      d.audit.record({
        actorType: "system",
        actorId: null,
        event: "email.suppressed",
        detail: { reason },
      });
      d.log.info("email.suppressed", { reason, provider: "mailgun" });
      return c.json({ status: "suppressed" }, 200);
    },
  );
}
