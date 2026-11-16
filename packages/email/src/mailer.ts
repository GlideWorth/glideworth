import { render } from "./render.js";
import {
  type Address,
  type EmailCategory,
  type EmailLogStore,
  type EmailTransport,
  EmailTransportError,
  type Mailer,
  type OutgoingEmail,
  type RenderContext,
  type SendOutcome,
  type SuppressionReason,
  type SuppressionReasonLookup,
  type SuppressionStore,
  TEMPLATE_CATEGORY,
  type TemplateData,
  type TemplateId,
  type UnsubscribeSigner,
} from "./types.js";
import { assertAddress, defaultNormalize, EmailValidationError } from "./validate.js";

/** Sent even to suppressed addresses: the person is trying to get into their account (spec 5.4). */
const ALWAYS_ATTEMPT: ReadonlySet<TemplateId> = new Set<TemplateId>([
  "verify-email",
  "password-reset",
]);
const DEFAULT_RETRY_DELAYS_MS = [1000, 5000, 30000];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createMailer(o: {
  transport: EmailTransport;
  from: Address;
  context: Omit<RenderContext, "unsubscribeUrl">;
  suppressions: SuppressionStore;
  log?: EmailLogStore;
  unsubscribe: UnsubscribeSigner;
  retryDelaysMs?: number[];
  normalize?: (email: string) => string;
}): Mailer {
  const normalize = o.normalize ?? defaultNormalize;
  const delays = o.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  const reasonOf = (email: string, category: EmailCategory): SuppressionReason => {
    const lookup = (o.suppressions as Partial<SuppressionReasonLookup>).reasonFor;
    const r = typeof lookup === "function" ? lookup.call(o.suppressions, email, category) : null;
    return r ?? (category === "checkin" ? "unsubscribe" : "bounce");
  };

  return {
    async send<T extends TemplateId>(
      to: Address,
      id: T,
      data: TemplateData[T],
      opts?: { userId?: string; idempotencyKey?: string },
    ): Promise<SendOutcome> {
      const category = TEMPLATE_CATEGORY[id];
      const record = (
        status: "sent" | "suppressed" | "failed",
        providerMessageId: string | null,
      ) => {
        try {
          o.log?.record({
            userId: opts?.userId ?? null,
            template: id,
            category,
            status,
            providerMessageId,
          });
        } catch {
          // A broken log must not turn a sent email into a failure.
        }
      };
      const fail = (code: string): SendOutcome => {
        record("failed", null);
        return { status: "failed", code };
      };

      if (!category) return { status: "failed", code: "unknown_template" };

      let recipient: Address;
      let from: Address;
      try {
        recipient = assertAddress(to, "to");
        from = assertAddress(o.from, "from");
      } catch (e) {
        return fail(e instanceof EmailValidationError ? e.code : "invalid_address");
      }

      const email = normalize(recipient.email);
      if (!ALWAYS_ATTEMPT.has(id) && o.suppressions.isSuppressed(email, category)) {
        record("suppressed", null);
        return { status: "suppressed", reason: reasonOf(email, category) };
      }

      let msg: OutgoingEmail;
      try {
        const headers: Record<string, string> = { "Auto-Submitted": "auto-generated" };
        const ctx: RenderContext = { ...o.context };
        if (category !== "essential") {
          const unsubscribeUrl = o.unsubscribe.url(email, category);
          ctx.unsubscribeUrl = unsubscribeUrl;
          headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
          headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
        }
        const r = render(id, data, ctx);
        msg = {
          to: recipient,
          from,
          subject: r.subject,
          text: r.text,
          html: r.html,
          headers,
          category,
          template: id,
          ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
        };
      } catch (e) {
        return fail(e instanceof EmailValidationError ? e.code : "render_failed");
      }

      for (let attempt = 0; ; attempt++) {
        try {
          const res = await o.transport.send(msg);
          record("sent", res.providerMessageId);
          return { status: "sent", providerMessageId: res.providerMessageId };
        } catch (e) {
          if (e instanceof EmailTransportError) {
            const delay = delays[attempt];
            if (e.retryable && delay !== undefined) {
              await sleep(delay);
              continue;
            }
            return fail(e.code);
          }
          return fail("transport_error");
        }
      }
    },
  };
}
