import { createHmac, randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { webhookDeliveries, webhooks } from "../db/schema.js";
import { ApiError, notFound } from "../errors.js";
import { type DeliveryFn, safeDeliver, webhookUrlProblem } from "../security.js";
import { newId, nowIso } from "../util.js";
import {
  type DomainEvent,
  type ServiceCtx,
  WEBHOOK_EVENTS,
  type WebhookEventName,
} from "./context.js";

export interface WebhookInfo {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  createdAt: string;
}

export interface DeliveryInfo {
  id: string;
  webhookId: string;
  event: string;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface WebhookOptions {
  /** Replace the HTTP client (tests). Default: a client that refuses private addresses. */
  fetch?: typeof fetch;
  /** Allow webhook URLs that resolve to loopback/private/link-local addresses. Default false (SSRF guard). */
  allowPrivate?: boolean;
  /** Cloud: new and changed subscriptions must use https, on port 443 or 1024 and above. */
  httpsOnly?: boolean;
  /** Delay before attempt 2, 3, ... (ms). Default 1s, 5s, 30s. */
  retryDelaysMs?: number[];
  timeoutMs?: number;
  /** Cloud: most subscriptions a workspace may have (plan limit). */
  maxSubscriptions?: () => number;
  /** Cloud: no outbound delivery at all while true (the workspace is read-only or suspended). */
  suppressed?: () => boolean;
  /** Cloud: counts one delivery against the daily quota; false = do not send this one. */
  admitDelivery?: () => boolean;
  /** Cloud: sent as `X-Glideworth-Workspace` so a receiver can tell workspaces apart. */
  workspaceId?: string;
}

const toInfo = (r: typeof webhooks.$inferSelect): WebhookInfo => ({
  id: r.id,
  url: r.url,
  description: r.description,
  events: r.events,
  active: r.active,
  createdAt: r.createdAt,
});

/** Signature header value: `t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">`. */
export function signPayload(secret: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/**
 * Event, delivery id and signature headers. Sent under the current `X-Glideworth-*` names and, for receivers
 * written before the rename, the deprecated `X-Cairn-*` names with the same values.
 */
export function deliveryHeaders(
  event: string,
  deliveryId: string,
  signature: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const brand of ["glideworth", "cairn"]) {
    headers[`x-${brand}-event`] = event;
    headers[`x-${brand}-delivery`] = deliveryId;
    headers[`x-${brand}-signature`] = signature;
  }
  return headers;
}

export class WebhooksService {
  private inflight = new Set<Promise<void>>();
  private readonly deliver: DeliveryFn;
  private readonly allowPrivate: boolean;
  private readonly delays: number[];
  private readonly timeoutMs: number;

  constructor(
    private readonly ctx: ServiceCtx,
    private readonly opts: WebhookOptions = {},
  ) {
    this.allowPrivate = opts.allowPrivate ?? false;
    const injected = opts.fetch;
    this.deliver = injected
      ? (url, init) => injected(url, { ...init, redirect: "manual" })
      : safeDeliver({ allowPrivate: this.allowPrivate });
    this.delays = opts.retryDelaysMs ?? [1_000, 5_000, 30_000];
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    ctx.events.on("event", (ev: DomainEvent) => this.dispatch(ev));
  }

  private validate(url: string | undefined, events: string[] | undefined): void {
    const problem =
      url === undefined
        ? null
        : webhookUrlProblem(url, this.allowPrivate, { httpsOnly: this.opts.httpsOnly ?? false });
    if (problem) throw new ApiError(400, "VALIDATION", problem);
    const bad = (events ?? []).filter((e) => !WEBHOOK_EVENTS.includes(e as WebhookEventName));
    if (bad.length)
      throw new ApiError(400, "VALIDATION", `unknown events: ${bad.join(", ")}`, {
        supported: WEBHOOK_EVENTS,
      });
  }

  create(input: {
    url: string;
    events: string[];
    description?: string | undefined;
  }): WebhookInfo & { secret: string } {
    this.validate(input.url, input.events);
    const max = this.opts.maxSubscriptions?.();
    if (max !== undefined && this.ctx.db.select().from(webhooks).all().length >= max)
      throw new ApiError(409, "LIMIT_REACHED", `a workspace can have at most ${max} webhooks`, {
        limit: max,
      });
    const id = newId("whk");
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    this.ctx.db
      .insert(webhooks)
      .values({
        id,
        url: input.url,
        events: [...new Set(input.events)],
        description: input.description ?? null,
        secret,
      })
      .run();
    return { ...this.get(id), secret };
  }

  get(id: string): WebhookInfo {
    const r = this.ctx.db.select().from(webhooks).where(eq(webhooks.id, id)).get();
    if (!r) throw notFound("webhook", id);
    return toInfo(r);
  }

  list(): WebhookInfo[] {
    return this.ctx.db.select().from(webhooks).orderBy(desc(webhooks.createdAt)).all().map(toInfo);
  }

  update(
    id: string,
    patch: {
      url?: string | undefined;
      events?: string[] | undefined;
      active?: boolean | undefined;
      description?: string | null | undefined;
    },
  ): WebhookInfo {
    const cur = this.get(id);
    const next = {
      ...cur,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    } as WebhookInfo;
    this.validate(patch.url, patch.events);
    this.ctx.db
      .update(webhooks)
      .set({
        url: next.url,
        events: next.events,
        active: next.active,
        description: next.description,
      })
      .where(eq(webhooks.id, id))
      .run();
    return this.get(id);
  }

  delete(id: string): void {
    this.get(id);
    this.ctx.db.delete(webhooks).where(eq(webhooks.id, id)).run();
  }

  deliveries(webhookId: string): DeliveryInfo[] {
    this.get(webhookId);
    return this.ctx.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(100)
      .all()
      .map(({ payload: _p, ...d }) => d);
  }

  ping(id: string): void {
    const hook = this.ctx.db.select().from(webhooks).where(eq(webhooks.id, id)).get();
    if (!hook) throw notFound("webhook", id);
    this.enqueue(hook, { name: "webhook.ping", data: { message: "pong" } });
  }

  /** Deliveries (with their retries) still in progress. */
  busy(): boolean {
    return this.inflight.size > 0;
  }

  private dispatch(ev: DomainEvent): void {
    if (ev.name === "webhook.ping") return;
    if (this.opts.suppressed?.()) return;
    for (const hook of this.ctx.db.select().from(webhooks).where(eq(webhooks.active, true)).all())
      if (hook.events.includes(ev.name)) this.enqueue(hook, ev);
  }

  private enqueue(hook: typeof webhooks.$inferSelect, ev: DomainEvent): void {
    if (this.opts.suppressed?.()) return;
    if (this.opts.admitDelivery && !this.opts.admitDelivery()) return;
    const id = newId("dlv");
    const payload = JSON.stringify({ id, event: ev.name, createdAt: nowIso(), data: ev.data });
    this.ctx.db
      .insert(webhookDeliveries)
      .values({ id, webhookId: hook.id, event: ev.name, payload, status: "pending" })
      .run();
    const p = this.attempt(id, hook, payload).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  private async attempt(
    id: string,
    hook: typeof webhooks.$inferSelect,
    payload: string,
  ): Promise<void> {
    for (let n = 0; n <= this.delays.length; n++) {
      if (n > 0) await new Promise((r) => setTimeout(r, this.delays[n - 1]));
      let status: number | null = null;
      let error: string | null = null;
      try {
        const ts = Math.floor(Date.now() / 1000);
        const res = await this.deliver(hook.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Glideworth-Webhooks/1",
            ...(this.opts.workspaceId ? { "x-glideworth-workspace": this.opts.workspaceId } : {}),
            ...deliveryHeaders(
              (JSON.parse(payload) as { event: string }).event,
              id,
              signPayload(hook.secret, ts, payload),
            ),
          },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        status = res.status;
        if (res.ok) {
          this.ctx.db
            .update(webhookDeliveries)
            .set({
              status: "succeeded",
              attempts: n + 1,
              lastStatusCode: status,
              lastError: null,
              deliveredAt: nowIso(),
            })
            .where(eq(webhookDeliveries.id, id))
            .run();
          return;
        }
        error = `HTTP ${res.status}`;
      } catch (e) {
        error =
          e instanceof Error && e.message.startsWith("blocked:")
            ? e.message
            : e instanceof Error
              ? e.name
              : "error";
      }
      const last = n === this.delays.length;
      try {
        this.ctx.db
          .update(webhookDeliveries)
          .set({
            status: last ? "failed" : "pending",
            attempts: n + 1,
            lastStatusCode: status,
            lastError: error,
          })
          .where(eq(webhookDeliveries.id, id))
          .run();
      } catch {
        return; // webhook (and its deliveries) deleted meanwhile
      }
    }
  }

  /** Resolves when all in-flight deliveries (including retries) are done. For tests and shutdown. */
  async flush(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }
}
