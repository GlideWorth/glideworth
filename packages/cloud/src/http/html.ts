/**
 * Server-rendered HTML for the operator console and the unsubscribe pages. Every interpolated value is escaped
 * by the `html` tag; only `Html` values produced by the tag (or `raw`, used for constants) pass through. The
 * pages carry a strict Content-Security-Policy: no script at all, one hashed stylesheet, forms to self only.
 */
import { createHash } from "node:crypto";
import type { Context } from "hono";

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

export function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"'`]/g, (ch) => ESC[ch] as string);
}

type Part =
  | Html
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<Html | string | number | null | undefined>;

export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    const one = (x: unknown) => (x instanceof Html ? x.value : esc(x));
    out += Array.isArray(v) ? v.map(one).join("") : one(v);
    out += strings[i + 1] ?? "";
  });
  return new Html(out);
}

/** Trusted constant markup only (never data). */
export const raw = (s: string): Html => new Html(s);

export const STYLE = `
body{font:14px/1.45 system-ui,sans-serif;margin:0;color:#111;background:#fafafa}
header{background:#1f2937;color:#fff;padding:10px 20px;display:flex;gap:16px;align-items:center}
header a{color:#fff}main{padding:20px;max-width:1100px}
table{border-collapse:collapse;width:100%;background:#fff}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f3f4f6}form.inline{display:inline}input,select,button{font:inherit;padding:4px 6px}
.warn{color:#b91c1c}.muted{color:#6b7280}.box{background:#fff;border:1px solid #ddd;padding:12px;margin:12px 0}
.watermark{position:fixed;inset:0;pointer-events:none;color:rgba(185,28,28,.12);font-size:48px;transform:rotate(-20deg);display:flex;align-items:center;justify-content:center}
`;
export const STYLE_HASH = `sha256-${createHash("sha256").update(STYLE).digest("base64")}`;

export const CSP = [
  "default-src 'none'",
  `style-src '${STYLE_HASH}'`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "img-src 'none'",
].join("; ");

export function securityHeaders(c: Context): void {
  c.header("Content-Security-Policy", CSP);
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  // "same-origin", not "no-referrer": under "no-referrer" browsers send `Origin: null` on these pages' form posts
  // and the same-origin check refuses them. Other sites still get no referrer.
  c.header("Referrer-Policy", "same-origin");
  c.header("Cache-Control", "no-store");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
}

export function page(
  title: string,
  body: Html,
  o: { nav?: Html; watermark?: string } = {},
): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="referrer" content="same-origin" />
        <title>${title}</title>
        <style>
          ${raw(STYLE)}
        </style>
      </head>
      <body>
        ${o.nav ?? ""}
        <main>${body}</main>
        ${o.watermark ? html`<div class="watermark">${o.watermark}</div>` : ""}
      </body>
    </html>`.value;
}
