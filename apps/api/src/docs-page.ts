/**
 * The API reference page served at `/docs` in cloud mode: server-rendered from the OpenAPI document, with no
 * script at all and nothing loaded from another origin (legal-decisions.md section 3 item 12: the hosted
 * reference must not load its viewer from a CDN). Self-host keeps the Scalar viewer.
 */

type Json = Record<string, unknown>;

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );

/** Escaped text with `code` spans and **bold**; nothing else from Markdown. */
const inline = (s: unknown) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

const paragraphs = (s: unknown) =>
  String(s ?? "")
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p>${inline(p)}</p>`)
    .join("");

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

const refName = (schema: unknown): string => {
  const s = schema as { $ref?: string; type?: string; items?: unknown } | undefined;
  if (!s) return "";
  if (s.$ref) return s.$ref.split("/").pop() ?? "";
  if (s.type === "array") return `${refName(s.items)}[]`;
  return s.type ?? "object";
};

const anchor = (method: string, path: string) =>
  `${method}-${path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

export const DOCS_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Phone widths: long tokens (`gwk_<workspace>_<prefix>_<secret>`, header names, paths) break anywhere rather
// than widen the page, and a parameter table that is still too wide scrolls inside itself.
const CSS = `body{font:15px/1.55 system-ui,sans-serif;margin:0;background:#f6f5f2;color:#1d2420;overflow-wrap:break-word}
code,h1,h3,td,th{overflow-wrap:anywhere}pre{max-width:100%;overflow-x:auto}pre code{overflow-wrap:normal}
table{display:block;max-width:100%;overflow-x:auto}
header{padding:1.25rem 1.5rem;background:#1d2420;color:#f6f5f2}header a{color:#cfe3d6}
main{max-width:64rem;margin:0 auto;padding:1rem 1.5rem 4rem}nav{columns:3 14rem;font-size:.92rem}
h2{margin-top:2.2rem;border-bottom:1px solid #ccc}h3{font-size:1rem;margin:1.4rem 0 .3rem;font-family:ui-monospace,monospace}
.m{display:inline-block;min-width:4.2rem;font-weight:700;text-transform:uppercase;font-size:.8rem}
.op{background:#fff;border-radius:10px;padding:.2rem 1rem .6rem;margin:.8rem 0;box-shadow:0 1px 4px #0001}
code{background:#eee;padding:.05rem .3rem;border-radius:4px}table{border-collapse:collapse;font-size:.9rem}
td,th{border-bottom:1px solid #e3e3e3;padding:.2rem .6rem;text-align:left;vertical-align:top}.muted{color:#555}
@media (prefers-color-scheme:dark){body{background:#151a17;color:#e8ece9}.op{background:#1f2622}code{background:#2c342f}.muted{color:#aab}td,th{border-color:#333}}`;

/** Render the reference page from an OpenAPI 3.1 document. */
export function renderApiReference(doc: Json): string {
  const info = (doc.info ?? {}) as Json;
  const paths = (doc.paths ?? {}) as Record<string, Record<string, Json>>;
  const tagOrder = ((doc.tags ?? []) as Array<{ name: string; description?: string }>).map(
    (t) => t.name,
  );
  const tagText = new Map(
    ((doc.tags ?? []) as Array<{ name: string; description?: string }>).map((t) => [
      t.name,
      t.description,
    ]),
  );
  const byTag = new Map<string, Array<{ method: string; path: string; op: Json }>>();
  for (const [path, item] of Object.entries(paths))
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const tag = ((op.tags as string[] | undefined) ?? ["Other"])[0] ?? "Other";
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push({ method, path, op });
    }
  const tags = [
    ...tagOrder.filter((t) => byTag.has(t)),
    ...[...byTag.keys()].filter((t) => !tagOrder.includes(t)).sort(),
  ];
  const count = [...byTag.values()].reduce((n, l) => n + l.length, 0);

  const section = (tag: string) => {
    const ops = byTag.get(tag) ?? [];
    return `<h2 id="tag-${esc(anchor("t", tag))}">${esc(tag)}</h2>${tagText.get(tag) ? `<p class="muted">${inline(tagText.get(tag))}</p>` : ""}${ops
      .map(({ method, path, op }) => {
        const params = (op.parameters ?? []) as Array<{
          name: string;
          in: string;
          required?: boolean;
          description?: string;
          schema?: unknown;
        }>;
        const body = ((op.requestBody as Json | undefined)?.content as Json | undefined)?.[
          "application/json"
        ] as { schema?: unknown } | undefined;
        const responses = Object.entries((op.responses ?? {}) as Record<string, Json>);
        const scope = op["x-required-scope"];
        return `<div class="op" id="${anchor(method, path)}"><h3><span class="m">${esc(method)}</span> ${esc(path)}</h3>
<p><strong>${inline(op.summary)}</strong>${op.operationId ? ` <span class="muted">(${esc(op.operationId)})</span>` : ""}</p>
${paragraphs(op.description)}
${scope ? `<p class="muted">Required scope: <code>${esc(scope)}</code>${op["x-required-role"] ? `, role <code>${esc(op["x-required-role"])}</code>` : ""}</p>` : ""}
${
  params.length
    ? `<table><tr><th>Parameter</th><th>In</th><th>Type</th><th></th></tr>${params
        .map(
          (p) =>
            `<tr><td><code>${esc(p.name)}</code>${p.required ? " *" : ""}</td><td>${esc(p.in)}</td><td>${esc(refName(p.schema))}</td><td>${inline(p.description)}</td></tr>`,
        )
        .join("")}</table>`
    : ""
}
${body ? `<p>Body: <code>${esc(refName(body.schema))}</code> (JSON)</p>` : ""}
<p class="muted">Responses: ${responses.map(([code, r]) => `<code>${esc(code)}</code> ${esc(r.description)}`).join(" · ")}</p></div>`;
      })
      .join("")}`;
  };

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(info.title ?? "API")} reference</title><style>${CSS}</style></head>
<body><header><h1>${esc(info.title)} <span class="muted">${esc(info.version)}</span></h1><p>${count} operations. Machine-readable: <a href="/openapi.json">/openapi.json</a> (schemas, examples, every field).</p></header>
<main>${paragraphs(info.description)}<nav>${tags.map((t) => `<div><a href="#tag-${esc(anchor("t", t))}">${esc(t)}</a> <span class="muted">${byTag.get(t)?.length ?? 0}</span></div>`).join("")}</nav>
${tags.map(section).join("")}</main></body></html>`;
}
