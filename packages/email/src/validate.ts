import type { Address, OutgoingEmail, RenderContext } from "./types.js";

/** Thrown for input that must never reach a message: hostile addresses, headers, URLs, bad template data. */
export class EmailValidationError extends Error {
  constructor(
    readonly code: "invalid_address" | "invalid_header" | "invalid_url" | "invalid_data",
    message: string,
  ) {
    super(message);
    this.name = "EmailValidationError";
  }
}

// oxlint-disable-next-line eslint/no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// oxlint-disable-next-line eslint/no-control-regex -- matching control characters is the point.
const CONTROL_G = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const ADDRESS = /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]+$/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function hasControlChars(s: string): boolean {
  return CONTROL.test(s);
}

export function assertEmail(email: unknown, label = "address"): string {
  if (typeof email !== "string")
    throw new EmailValidationError("invalid_address", `${label} must be a string`);
  const e = email.trim();
  if (e.length < 3 || e.length > 254 || !ADDRESS.test(e) || CONTROL.test(e)) {
    throw new EmailValidationError("invalid_address", `${label} is not a valid email address`);
  }
  return e;
}

export function assertAddress(a: Address, label: string): Address {
  const email = assertEmail(a?.email, label);
  if (a.name === undefined) return { email };
  if (typeof a.name !== "string" || CONTROL.test(a.name) || a.name.length > 200) {
    throw new EmailValidationError("invalid_address", `${label} name is not allowed`);
  }
  return { email, name: a.name };
}

export function assertHeaderValue(name: string, value: unknown): string {
  if (typeof value !== "string" || CONTROL.test(value) || value.length > 2000) {
    throw new EmailValidationError("invalid_header", `header ${name} has an invalid value`);
  }
  return value;
}

/** Final check applied by every transport on the way out. */
export function assertOutgoing(msg: OutgoingEmail): void {
  assertAddress(msg.to, "to");
  assertAddress(msg.from, "from");
  if (msg.replyTo) assertAddress(msg.replyTo, "replyTo");
  assertHeaderValue("Subject", msg.subject);
  if (msg.subject.length === 0 || msg.subject.length > 200) {
    throw new EmailValidationError("invalid_header", "subject has an invalid length");
  }
  for (const [k, v] of Object.entries(msg.headers)) {
    if (!HEADER_NAME.test(k))
      throw new EmailValidationError("invalid_header", "header name is not allowed");
    assertHeaderValue(k, v);
  }
}

/** A URL is allowed when it is https, or when it is on the configured public URL's origin (dev http). */
export function assertUrl(
  value: unknown,
  ctx: Pick<RenderContext, "appUrl">,
  label = "url",
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new EmailValidationError("invalid_url", `${label} is not a valid URL`);
  }
  // The URL parser silently strips tabs and newlines; reject them instead.
  if (CONTROL.test(value) || /\s/.test(value)) {
    throw new EmailValidationError(
      "invalid_url",
      `${label} contains whitespace or control characters`,
    );
  }
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new EmailValidationError("invalid_url", `${label} is not a valid URL`);
  }
  if (u.username || u.password) {
    throw new EmailValidationError("invalid_url", `${label} must not contain credentials`);
  }
  if (u.protocol !== "https:") {
    let app: URL | null = null;
    try {
      app = new URL(ctx.appUrl);
    } catch {
      app = null;
    }
    if (!app || u.origin !== app.origin) {
      throw new EmailValidationError("invalid_url", `${label} must be https or on the public URL`);
    }
  }
  return u.href;
}

/** Collapse whitespace and control characters so a free-text value stays on one line. */
export function oneLine(s: string): string {
  return s.replace(CONTROL_G, " ").replace(/\s+/g, " ").trim();
}

/** Free text from the outside (names, devices, workspace names): a bounded single line. */
export function freeText(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string")
    throw new EmailValidationError("invalid_data", `${label} must be a string`);
  const s = oneLine(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function positiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100000) {
    throw new EmailValidationError("invalid_data", `${label} must be a positive integer`);
  }
  return value;
}

export function nonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new EmailValidationError("invalid_data", `${label} must be a non-negative integer`);
  }
  return value;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function defaultNormalize(email: string): string {
  return email.trim().normalize("NFKC").toLowerCase();
}
