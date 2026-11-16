import { type Address, type EmailTransport, EmailTransportError } from "../types.js";
import { guard } from "./memory.js";

const HOSTS = { eu: "api.eu.mailgun.net", us: "api.mailgun.net" } as const;
const DOMAIN_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

function formatAddress(a: Address): string {
  if (!a.name) return a.email;
  return `"${a.name.replace(/[\\"]/g, "\\$&")}" <${a.email}>`;
}

/**
 * Mailgun HTTP API (`POST /v3/<domain>/messages`, multipart form, HTTP basic auth `api:<key>`). No SDK.
 * Tracking is switched off per message. Mailgun has no send idempotency key, so `idempotencyKey` is not sent.
 */
export function mailgunTransport(o: {
  apiKey: string;
  domain: string;
  region: "eu" | "us";
  fetch?: typeof fetch;
  timeoutMs?: number;
}): EmailTransport {
  if (!o.apiKey) throw new Error("mailgun apiKey is required");
  if (!DOMAIN_RE.test(o.domain)) throw new Error("mailgun domain is not valid");
  const host = HOSTS[o.region];
  if (!host) throw new Error("mailgun region must be 'eu' or 'us'");
  const doFetch = o.fetch ?? fetch;
  const url = `https://${host}/v3/${o.domain}/messages`;
  const auth = `Basic ${Buffer.from(`api:${o.apiKey}`, "utf8").toString("base64")}`;

  return {
    name: "mailgun",
    async send(msg) {
      guard("mailgun", msg);
      const form = new FormData();
      form.set("from", formatAddress(msg.from));
      form.set("to", formatAddress(msg.to));
      form.set("subject", msg.subject);
      form.set("text", msg.text);
      form.set("html", msg.html);
      if (msg.replyTo) form.set("h:Reply-To", formatAddress(msg.replyTo));
      for (const [k, v] of Object.entries(msg.headers)) form.set(`h:${k}`, v);
      form.set("o:tracking", "no");
      form.set("o:tracking-clicks", "no");
      form.set("o:tracking-opens", "no");
      form.set("o:tag", msg.template);

      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { Authorization: auth },
          body: form,
          signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
        });
      } catch {
        throw new EmailTransportError("mailgun", "network", true, "could not reach Mailgun");
      }

      if (res.ok) {
        let id: string | null = null;
        try {
          const body = (await res.json()) as { id?: unknown };
          if (typeof body.id === "string") id = body.id;
        } catch {
          // Accepted but no readable body: still a success.
        }
        return { providerMessageId: id };
      }

      let detail = "";
      try {
        const body = (await res.json()) as { message?: unknown };
        if (typeof body.message === "string") detail = body.message.slice(0, 200);
      } catch {
        // No JSON body.
      }
      const s = res.status;
      const suffix = detail ? `: ${detail}` : "";
      if (s === 429)
        throw new EmailTransportError(
          "mailgun",
          "rate_limited",
          true,
          `Mailgun returned 429${suffix}`,
        );
      if (s >= 500)
        throw new EmailTransportError(
          "mailgun",
          "provider_error",
          true,
          `Mailgun returned ${s}${suffix}`,
        );
      if (s === 401 || s === 403)
        throw new EmailTransportError("mailgun", "auth", false, `Mailgun returned ${s}${suffix}`);
      if (s === 404)
        throw new EmailTransportError(
          "mailgun",
          "not_found",
          false,
          `Mailgun returned 404${suffix}`,
        );
      throw new EmailTransportError("mailgun", "rejected", false, `Mailgun returned ${s}${suffix}`);
    },
  };
}
