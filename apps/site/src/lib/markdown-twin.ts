/**
 * Markdown twins of the docs pages (https://llmstxt.org/): /docs/<slug>/ also exists as /docs/<slug>.md, for
 * language models and agents that read Markdown more reliably than HTML.
 *
 * A twin is made from the page's BUILT HTML, not from its MDX source, so components (Callout, Steps, FAQ,
 * CodeBlock, FeatureGrid, the API reference), `{facts.x}` expressions and `{{token}}` frontmatter come out
 * exactly as the HTML page shows them. The converter knows the small set of elements the site's prose emits;
 * anything else falls back to its text. `pnpm check:dist` checks every twin for leftover HTML and tokens.
 */
import { type DefaultTreeAdapterMap, parse } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export interface TwinPage {
  title: string;
  description: string;
  /** The HTML page's canonical URL, e.g. https://glideworth.com/docs/self-hosting/docker/ */
  url: string;
  body: string;
  /** "Last checked against the code on …", when the page has one. */
  checked?: string;
}

/** The twin's site path for a docs page path: /docs/a/b/ -> /docs/a/b.md */
export function twinPath(pagePath: string): string {
  return `${pagePath.replace(/\/+$/, "")}.md`;
}

const isElement = (n: Node): n is Element => "tagName" in n;
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;
const classes = (el: Element) => (attr(el, "class") ?? "").split(/\s+/).filter(Boolean);
const hasClass = (el: Element, name: string) => classes(el).includes(name);

function children(n: Node): Node[] {
  if (isElement(n) && n.tagName === "template") return [];
  return "childNodes" in n ? n.childNodes : [];
}

function find(n: Node, test: (el: Element) => boolean): Element | undefined {
  for (const c of children(n)) {
    if (isElement(c) && test(c)) return c;
    const hit = find(c, test);
    if (hit) return hit;
  }
  return undefined;
}

function textOf(n: Node): string {
  if (n.nodeName === "#text") return (n as DefaultTreeAdapterMap["textNode"]).value;
  return children(n).map(textOf).join("");
}

/** Elements that never carry content for a reader. */
const SKIP = new Set([
  "script",
  "style",
  "svg",
  "button",
  "template",
  "noscript",
  "iframe",
  "form",
]);
const BLOCK = new Set([
  "p",
  "ul",
  "ol",
  "pre",
  "table",
  "blockquote",
  "aside",
  "details",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "div",
  "section",
  "nav",
  "dl",
]);

interface Ctx {
  base: string;
}

function absolute(href: string, ctx: Ctx): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  return new URL(href, ctx.base).href;
}

/** Inline content: text, links, emphasis and code, on one logical line (line breaks collapse). */
function inline(n: Node, ctx: Ctx): string {
  if (n.nodeName === "#text") return escapeText((n as DefaultTreeAdapterMap["textNode"]).value);
  if (!isElement(n)) return "";
  if (SKIP.has(n.tagName) || attr(n, "aria-hidden") === "true") return "";
  const inner = () =>
    children(n)
      .map((c) => inline(c, ctx))
      .join("");
  switch (n.tagName) {
    case "br":
      return "\n";
    case "code":
      return codeSpan(textOf(n));
    case "strong":
    case "b": {
      const t = inner().trim();
      return t ? `**${t}**` : "";
    }
    case "em":
    case "i": {
      const t = inner().trim();
      return t ? `*${t}*` : "";
    }
    case "a": {
      const t = inner().trim();
      const href = attr(n, "href");
      if (!href || !t) return t;
      return `[${t}](${absolute(href, ctx)})`;
    }
    case "img": {
      const src = attr(n, "src");
      return src ? `![${attr(n, "alt") ?? ""}](${absolute(src, ctx)})` : "";
    }
    case "time":
      return inner();
    default:
      return inner();
  }
}

/** Collapses whitespace and escapes what Markdown would otherwise read as markup. */
function escapeText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/<(?=[a-z!/?])/gi, "\\<")
    .replace(/([*`])/g, "\\$1");
}

function codeSpan(code: string): string {
  const text = code.replace(/\s+/g, " ");
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function inlineBlock(el: Node, ctx: Ctx): string {
  return children(el)
    .map((c) => inline(c, ctx))
    .join("")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

function fenced(code: string, lang: string): string {
  const runs = code.match(/^`{3,}/gm) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${fence}${lang}\n${code.replace(/\n+$/, "")}\n${fence}`;
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, i) => (line === "" ? line : (i === 0 ? first : rest) + line))
    .join("\n");
}

/** FeatureGrid: each item is a heading (often a link) and a sentence. */
function featureList(el: Element, ctx: Ctx): string {
  return children(el)
    .filter((li): li is Element => isElement(li) && li.tagName === "li")
    .map((li) => {
      const title = find(li, (e) => /^h[1-6]$/.test(e.tagName));
      const body = find(li, (e) => e.tagName === "p");
      const t = title ? inlineBlock(title, ctx) : "";
      const b = body ? inlineBlock(body, ctx) : "";
      return `- ${t ? `**${t}**` : ""}${t && b ? ": " : ""}${b}`;
    })
    .join("\n");
}

function list(el: Element, ctx: Ctx): string {
  if (hasClass(el, "feature-grid")) return featureList(el, ctx);
  const ordered = el.tagName === "ol";
  let n = Number(attr(el, "start") ?? 1);
  const items: string[] = [];
  for (const li of children(el)) {
    if (!isElement(li) || li.tagName !== "li") continue;
    const marker = ordered ? `${n++}. ` : "- ";
    const body = blocks(li, ctx) || " ";
    items.push(prefixLines(body, marker, " ".repeat(marker.length)));
  }
  const loose = items.some((i) => i.includes("\n\n"));
  return items.join(loose ? "\n\n" : "\n");
}

function table(el: Element, ctx: Ctx): string {
  const rows: string[][] = [];
  const walk = (n: Node) => {
    for (const c of children(n)) {
      if (!isElement(c)) continue;
      if (c.tagName === "tr") {
        rows.push(
          children(c)
            .filter((x): x is Element => isElement(x) && (x.tagName === "td" || x.tagName === "th"))
            .map((cell) =>
              blocksInline(cell, ctx).replace(/\|/g, "\\|").replace(/\n+/g, " ").trim(),
            ),
        );
      } else walk(c);
    }
  };
  walk(el);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array<string>(width - r.length).fill("")];
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  const [head, ...body] = rows;
  return [
    line(head!),
    `| ${Array<string>(width).fill("---").join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

/** A table cell may hold paragraphs or lists; flatten them onto one line. */
function blocksInline(el: Element, ctx: Ctx): string {
  return blocks(el, ctx)
    .replace(/\n{2,}/g, " ")
    .replace(/\n/g, " ");
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

/** One block element to Markdown (no surrounding blank lines). */
function block(el: Element, ctx: Ctx): string {
  if (SKIP.has(el.tagName) || attr(el, "aria-hidden") === "true") return "";
  const tag = el.tagName;
  if (/^h[1-6]$/.test(tag)) {
    const t = inlineBlock(el, ctx).replace(/\n/g, " ");
    return t ? `${"#".repeat(Number(tag[1]))} ${t}` : "";
  }
  switch (tag) {
    case "p":
      return inlineBlock(el, ctx);
    case "ul":
    case "ol":
      return list(el, ctx);
    case "pre": {
      const lang = attr(el, "data-language") ?? "";
      return fenced(textOf(el), lang === "plaintext" ? "text" : lang);
    }
    case "table":
      return table(el, ctx);
    case "hr":
      return "---";
    case "blockquote":
      return quote(blocks(el, ctx));
    case "aside": {
      if (!hasClass(el, "callout")) return blocks(el, ctx);
      // Callout: "Warning" label and optional title become the first line of a blockquote.
      const label = find(el, (e) => hasClass(e, "callout-label"));
      const heading = find(el, (e) => hasClass(e, "callout-heading"));
      const body = find(el, (e) => hasClass(e, "callout-body"));
      const titleParts = [
        label && textOf(label).trim(),
        heading && inlineBlock(heading, ctx),
      ].filter(Boolean);
      const first = titleParts.length ? `**${titleParts.join(": ")}**` : "";
      return quote([first, body ? blocks(body, ctx) : ""].filter(Boolean).join("\n\n"));
    }
    case "details": {
      const summary = children(el).find(
        (c): c is Element => isElement(c) && c.tagName === "summary",
      );
      const heading = summary && find(summary, (e) => /^h[1-6]$/.test(e.tagName));
      const title = summary ? inlineBlock(heading ?? summary, ctx).replace(/\n/g, " ") : "";
      const level = heading ? Number(heading.tagName[1]) : 0;
      const head = title ? (level ? `${"#".repeat(level)} ${title}` : `**${title}**`) : "";
      const rest = children(el).filter((c) => c !== summary);
      return [head, blocksOf(rest, ctx)].filter(Boolean).join("\n\n");
    }
    case "figure": {
      const caption = children(el).find(
        (c): c is Element => isElement(c) && c.tagName === "figcaption",
      );
      // A CodeBlock's caption bar holds only its title and copy button.
      const isCode = hasClass(el, "codeblock");
      const rest = children(el).filter((c) => c !== caption);
      const captionText = caption && !isCode ? inlineBlock(caption, ctx) : "";
      return [blocksOf(rest, ctx), captionText && `*${captionText}*`].filter(Boolean).join("\n\n");
    }
    case "dl":
      return children(el)
        .filter(isElement)
        .map((c) => (c.tagName === "dt" ? `**${inlineBlock(c, ctx)}**` : blocks(c, ctx)))
        .join("\n\n");
    default:
      return blocks(el, ctx);
  }
}

function blocksOf(nodes: Node[], ctx: Ctx): string {
  const out: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    const t = run
      .map((c) => inline(c, ctx))
      .join("")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/ {2,}/g, " ")
      .trim();
    if (t) out.push(t);
    run = [];
  };
  for (const c of nodes) {
    if (isElement(c) && (BLOCK.has(c.tagName) || SKIP.has(c.tagName))) {
      flush();
      const b = block(c, ctx).trim();
      if (b) out.push(b);
    } else run.push(c);
  }
  flush();
  return out.join("\n\n");
}

function blocks(el: Node, ctx: Ctx): string {
  return blocksOf(children(el), ctx);
}

/** Reads a built docs page: title, description, canonical URL and the prose body as Markdown. */
export function docsPageToTwin(html: string): TwinPage | undefined {
  const doc = parse(html);
  const article = find(doc, (e) => e.tagName === "article" && hasClass(e, "docs-main"));
  if (!article) return undefined;
  const canonical = find(doc, (e) => e.tagName === "link" && attr(e, "rel") === "canonical");
  const url = canonical ? (attr(canonical, "href") ?? "") : "";
  const head = find(article, (e) => hasClass(e, "docs-head"));
  const h1 = head && find(head, (e) => e.tagName === "h1");
  const lede = head && find(head, (e) => hasClass(e, "lede"));
  const prose = find(article, (e) => hasClass(e, "prose"));
  const checked = find(article, (e) => e.tagName === "p" && hasClass(e, "checked"));
  if (!h1 || !prose || !url) return undefined;
  const ctx = { base: url };
  return {
    title: textOf(h1).replace(/\s+/g, " ").trim(),
    description: lede ? textOf(lede).replace(/\s+/g, " ").trim() : "",
    url,
    body: blocks(prose, ctx),
    ...(checked ? { checked: textOf(checked).replace(/\s+/g, " ").trim() } : {}),
  };
}

/** The twin file: title, summary, where the HTML page is, then the body. Ends with one newline. */
export function renderTwin(page: TwinPage): string {
  const parts = [`# ${page.title}`];
  if (page.description) parts.push(`> ${page.description}`);
  parts.push(`HTML version: ${page.url}`);
  parts.push(page.body);
  if (page.checked) parts.push(`*${page.checked}*`);
  return `${parts
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim()}\n`;
}
