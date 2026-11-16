import nodemailer, { type Transporter } from "nodemailer";
import { type EmailTransport, EmailTransportError } from "../types.js";
import { toMailOptions } from "./compose.js";
import { guard } from "./memory.js";

const RETRYABLE_CODES = new Set([
  "ECONNECTION",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

function mapError(e: unknown): EmailTransportError {
  const err = e as { code?: unknown; responseCode?: unknown; message?: unknown };
  const code = typeof err.code === "string" ? err.code : "";
  const rc = typeof err.responseCode === "number" ? err.responseCode : 0;
  // Never include the connection URL (it can hold credentials): use the library's message only.
  const message =
    typeof err.message === "string" ? err.message.replace(/\S*:\/\/\S*/g, "[url]") : "smtp error";
  if (rc >= 400 && rc < 500) return new EmailTransportError("smtp", `smtp_${rc}`, true, message);
  if (rc >= 500) return new EmailTransportError("smtp", `smtp_${rc}`, false, message);
  if (code === "EAUTH") return new EmailTransportError("smtp", "auth", false, message);
  if (RETRYABLE_CODES.has(code))
    return new EmailTransportError("smtp", code.toLowerCase(), true, message);
  return new EmailTransportError("smtp", code ? code.toLowerCase() : "smtp_error", false, message);
}

/**
 * SMTP through nodemailer. `url` is a nodemailer connection URL (`smtps://user:pass@host`, `smtp://host:587`).
 * `transporter` is for tests only.
 */
export function smtpTransport(o: { url: string; transporter?: Transporter }): EmailTransport {
  let t: Transporter | undefined = o.transporter;
  const get = (): Transporter => {
    t ??= nodemailer.createTransport({
      url: o.url,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    return t;
  };
  return {
    name: "smtp",
    async send(msg) {
      guard("smtp", msg);
      try {
        const info = await get().sendMail(toMailOptions(msg));
        const rejected = [...(info.rejected ?? [])];
        if (rejected.length > 0) {
          throw new EmailTransportError("smtp", "rejected", false, "the recipient was rejected");
        }
        return { providerMessageId: typeof info.messageId === "string" ? info.messageId : null };
      } catch (e) {
        if (e instanceof EmailTransportError) throw e;
        throw mapError(e);
      }
    },
  };
}
