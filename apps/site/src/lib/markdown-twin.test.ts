import { describe, expect, it } from "vitest";
import { agentLinks, rawRepoUrl } from "./llms-agents";
import { docsPageToTwin, renderTwin, twinPath } from "./markdown-twin";

/** A docs page as DocsLayout and the MDX components build it (trimmed, synthetic text). */
const PAGE = `<!doctype html><html><head>
<link rel="canonical" href="https://glideworth.com/docs/self-hosting/docker/">
<link rel="alternate" type="text/markdown" href="/docs/self-hosting/docker.md">
</head><body>
<nav class="docs-nav"><a href="/docs/">Docs</a></nav>
<article class="docs-main">
  <nav class="breadcrumbs"><ol><li><a href="/">Home</a></li></ol></nav>
  <script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
  <header class="docs-head"><span class="eyebrow">Self-hosting</span><h1>Install with Docker</h1>
    <p class="lede">Run it in one container.</p></header>
  <div class="prose prose-wide">
    <p>The build has <strong>no
telemetry</strong>. See <a href="#sizing">Sizing</a> and the <a href="/docs/self-hosting/reverse-proxy/">proxy</a>.
Keep the key in <code>GLIDEWORTH_MCP_KEY</code>; send <code>Authorization: Bearer &lt;key&gt;</code>. Type a &lt;passphrase&gt; of 12 * characters.</p>
    <h2 id="install">Install</h2>
    <div class="steps steps-slot"><ol>
      <li><p>Download the files.</p>
        <figure class="codeblock"><figcaption class="codeblock-bar"><span class="codeblock-title">Terminal</span>
          <button type="button" class="codeblock-copy">Copy</button></figcaption>
          <pre class="astro-code" data-language="bash"><code><span class="line"><span>mkdir glideworth &amp;&amp; cd glideworth</span></span>
<span class="line"><span>docker compose up -d</span></span></code></pre></figure>
        <script type="module" src="/_astro/CodeBlock.js"></script></li>
      <li><p>Open it.</p></li>
    </ol></div>
    <aside class="callout callout-risk" role="note"><p class="callout-title"><span class="callout-label">Important</span>
      <span class="callout-heading">Do not run down -v</span></p>
      <div class="callout-body"><p><code>docker compose down -v</code> deletes <strong>all your data</strong>.</p></div></aside>
    <div class="table-scroll" tabindex="0" role="group"><table><thead><tr><th>Variable</th><th>Default</th></tr></thead>
      <tbody><tr><td><code>GLIDEWORTH_PORT</code></td><td>8787 | host</td></tr></tbody></table></div>
    <div class="faq"><details class="faq-item"><summary><h2 class="faq-q">Is it advice?</h2>
      <svg class="faq-icon" aria-hidden="true"><path d="M3 8h10"/></svg></summary>
      <div class="faq-a"><p>No. See <a href="/docs/methodology/known-limitations/" rel="noopener">limits</a>.</p></div></details></div>
    <ul class="feature-grid cols-2" role="list"><li class="feature"><h3 class="feature-title"><a href="/docs/hosted/hosted-service/">Hosted</a></h3>
      <p class="feature-body">Run for you.</p></li></ul>
  </div>
  <p class="checked">Last checked against the code on <time datetime="2026-11-23">23 November 2026</time>.</p>
  <p class="markdown-link"><a href="/docs/self-hosting/docker.md">This page as Markdown</a></p>
</article></body></html>`;

describe("Markdown twins of docs pages", () => {
  it("maps a docs page path to its twin", () => {
    expect(twinPath("/docs/self-hosting/docker/")).toBe("/docs/self-hosting/docker.md");
    expect(twinPath("/docs/")).toBe("/docs.md");
  });

  const twin = docsPageToTwin(PAGE);
  const md = twin ? renderTwin(twin) : "";

  it("reads the title, summary, canonical URL and last-checked line", () => {
    expect(twin?.title).toBe("Install with Docker");
    expect(twin?.description).toBe("Run it in one container.");
    expect(twin?.url).toBe("https://glideworth.com/docs/self-hosting/docker/");
    expect(md.startsWith("# Install with Docker\n\n> Run it in one container.\n\n")).toBe(true);
    expect(md).toContain("HTML version: https://glideworth.com/docs/self-hosting/docker/");
    expect(md).toContain("*Last checked against the code on 23 November 2026.*");
  });

  it("keeps only the prose: no breadcrumbs, sidebar, scripts, buttons or the Markdown link", () => {
    expect(md).not.toContain("Home");
    expect(md).not.toContain("BreadcrumbList");
    expect(md).not.toContain("Copy");
    expect(md).not.toContain("This page as Markdown");
    const prose = md.replace(/^ *```[\s\S]*?^ *```$/gm, "").replace(/`[^`]*`/g, "");
    expect(prose).not.toMatch(/(^|[^\\])<\/?[a-z]+[\s>]/m);
  });

  it("writes inline markup, absolute links, code spans and escapes", () => {
    expect(md).toContain(
      "The build has **no telemetry**. See [Sizing](https://glideworth.com/docs/self-hosting/docker/#sizing) and the [proxy](https://glideworth.com/docs/self-hosting/reverse-proxy/).",
    );
    expect(md).toContain("`Authorization: Bearer <key>`");
    expect(md).toContain("a \\<passphrase> of 12 \\* characters");
  });

  it("expands Steps with a CodeBlock into a numbered list with an indented fence", () => {
    expect(md).toContain(
      [
        "## Install",
        "",
        "1. Download the files.",
        "",
        "   ```bash",
        "   mkdir glideworth && cd glideworth",
        "   docker compose up -d",
        "   ```",
        "",
        "2. Open it.",
      ].join("\n"),
    );
  });

  it("turns a Callout into a titled blockquote", () => {
    expect(md).toContain(
      "> **Important: Do not run down -v**\n>\n> `docker compose down -v` deletes **all your data**.",
    );
  });

  it("writes tables, FAQ answers and feature grids as Markdown", () => {
    expect(md).toContain(
      "| Variable | Default |\n| --- | --- |\n| `GLIDEWORTH_PORT` | 8787 \\| host |",
    );
    expect(md).toContain(
      "## Is it advice?\n\nNo. See [limits](https://glideworth.com/docs/methodology/known-limitations/).",
    );
    expect(md).toContain(
      "- **[Hosted](https://glideworth.com/docs/hosted/hosted-service/)**: Run for you.",
    );
  });

  it("ignores pages that are not docs pages", () => {
    expect(docsPageToTwin("<html><body><p>Redirecting</p></body></html>")).toBeUndefined();
  });
});

describe("For AI agents links in /llms.txt", () => {
  it("points at the public repository's setup guide, the served skill and the MCP twin", () => {
    expect(rawRepoUrl("docs/agents/SETUP.md")).toBe(
      "https://raw.githubusercontent.com/GlideWorth/glideworth/main/docs/agents/SETUP.md",
    );
    const urls = agentLinks().map((l) => l.url);
    expect(urls).toContain("https://glideworth.com/.well-known/skills/default/skill.md");
    expect(urls).toContain("https://glideworth.com/docs/api-and-mcp/mcp-setup.md");
  });
});
