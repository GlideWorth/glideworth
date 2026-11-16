import { SUBJECTS } from "./subjects.js";
import { type RenderContext, type Rendered, TEMPLATE_CATEGORY, type TemplateId } from "./types.js";
import { assertEmail, assertUrl, escapeHtml, freeText } from "./validate.js";

/**
 * A template is a list of blocks. Every string is escaped (HTML) or flattened to one line (text) here, and
 * every URL is validated here, so a template cannot forget to.
 */
export type Block =
  | { kind: "p"; text: string }
  | { kind: "facts"; rows: [label: string, value: string][] }
  | { kind: "bullets"; items: string[] }
  | { kind: "action"; label: string; url: string }
  | { kind: "link"; label: string; url: string };

export const p = (text: string): Block => ({ kind: "p", text });
export const facts = (...rows: [string, string][]): Block => ({ kind: "facts", rows });
export const bullets = (items: string[]): Block => ({ kind: "bullets", items });
export const action = (label: string, url: string): Block => ({ kind: "action", label, url });
export const link = (label: string, url: string): Block => ({ kind: "link", label, url });

/** "Hello Sam," or just "Hello," when there is no usable name. */
export function greeting(name: string): string {
  const n = freeText(name, "name", 100);
  return n ? `Hello ${n},` : "Hello,";
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const INK = "#1a1a1a";
const MUTED = "#555555";
const LINK = "#0b4f6c";

function line(s: string): string {
  return freeText(s, "text", 1000);
}

function footerLines(category: "essential" | "checkin", ctx: RenderContext, unsub: string | null) {
  const out: { text: string; html: string }[] = [];
  const support = assertEmail(ctx.supportEmail, "supportEmail");
  out.push({
    text: `Questions? Write to ${support}.`,
    html: `Questions? Write to <a href="mailto:${escapeHtml(support)}" style="color:${LINK}">${escapeHtml(support)}</a>.`,
  });
  if (category === "essential") {
    out.push({
      text: "This is a service email about your account, so you cannot unsubscribe from it.",
      html: "This is a service email about your account, so you cannot unsubscribe from it.",
    });
  } else if (unsub) {
    out.push({
      text: `You get this because check-in emails are switched on. Unsubscribe: ${unsub}`,
      html: `You get this because check-in emails are switched on. <a href="${escapeHtml(unsub)}" style="color:${LINK}">Unsubscribe</a>.`,
    });
  } else {
    out.push({
      text: "You get this because check-in emails are switched on. You can switch them off in your settings.",
      html: "You get this because check-in emails are switched on. You can switch them off in your settings.",
    });
  }
  return out;
}

export function compose(
  id: TemplateId,
  heading: string,
  blocks: Block[],
  ctx: RenderContext,
): Rendered {
  const subject = SUBJECTS[id];
  const category = TEMPLATE_CATEGORY[id];
  const product = freeText(ctx.productName, "productName", 60) || "Glideworth";
  const unsub =
    ctx.unsubscribeUrl && category !== "essential"
      ? assertUrl(ctx.unsubscribeUrl, ctx, "unsubscribeUrl")
      : null;

  const text: string[] = [product, "", line(heading), ""];
  const html: string[] = [];

  for (const b of blocks) {
    switch (b.kind) {
      case "p":
        text.push(line(b.text), "");
        html.push(
          `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:${INK}">${escapeHtml(line(b.text))}</p>`,
        );
        break;
      case "facts":
        for (const [k, v] of b.rows) text.push(`${line(k)}: ${line(v)}`);
        text.push("");
        html.push(
          `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:16px;line-height:1.5;color:${INK}">${b.rows
            .map(
              ([k, v]) =>
                `<tr><td style="padding:2px 16px 2px 0;color:${MUTED};vertical-align:top">${escapeHtml(line(k))}</td><td style="padding:2px 0">${escapeHtml(line(v))}</td></tr>`,
            )
            .join("")}</table>`,
        );
        break;
      case "bullets":
        for (const i of b.items) text.push(`- ${line(i)}`);
        text.push("");
        html.push(
          `<ul style="margin:0 0 16px;padding-left:24px;font-size:16px;line-height:1.5;color:${INK}">${b.items
            .map((i) => `<li style="margin:0 0 4px">${escapeHtml(line(i))}</li>`)
            .join("")}</ul>`,
        );
        break;
      case "action": {
        const url = assertUrl(b.url, ctx);
        text.push(`${line(b.label)}:`, url, "");
        html.push(
          `<p style="margin:0 0 8px"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;background-color:${LINK};color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;border-radius:4px">${escapeHtml(line(b.label))}</a></p>`,
          `<p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:${MUTED}">If the button does not work, copy this address into your browser:<br><a href="${escapeHtml(url)}" style="color:${LINK};word-break:break-all">${escapeHtml(url)}</a></p>`,
        );
        break;
      }
      case "link": {
        const url = assertUrl(b.url, ctx);
        text.push(`${line(b.label)}:`, url, "");
        html.push(
          `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:${INK}">${escapeHtml(line(b.label))}:<br><a href="${escapeHtml(url)}" style="color:${LINK};word-break:break-all">${escapeHtml(url)}</a></p>`,
        );
        break;
      }
    }
  }

  const foot = footerLines(category, ctx, unsub);
  text.push("--", product, ...foot.map((f) => f.text), "");

  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#ffffff">
<div style="max-width:560px;margin:0 auto;padding:24px;font-family:${FONT};color:${INK}">
<p style="margin:0 0 24px;font-size:18px;font-weight:bold;color:${INK}">${escapeHtml(product)}</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${INK}">${escapeHtml(line(heading))}</h1>
${html.join("\n")}
<hr style="border:0;border-top:1px solid #dddddd;margin:24px 0 16px">
${foot.map((f) => `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:${MUTED}">${f.html}</p>`).join("\n")}
</div>
</body>
</html>
`;
  return { subject, text: text.join("\n"), html: doc, category };
}
