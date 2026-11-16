/**
 * The one definition of how the site treats links to other origins: every <a> that points at another
 * origin carries rel="noopener noreferrer". Markdown and MDX links get it from the `a` override in
 * src/components/mdx.ts (MdxLink.astro); components that render an <a> from a prop (Button, Card, Footer,
 * Header, FeatureGrid, CTABand) call `externalLinkProps`; FAQ answers (HTML strings) go through
 * `withExternalRel`. `pnpm check:dist` fails any external <a> without the rel in the build.
 */

export const EXTERNAL_REL = "noopener noreferrer";

/** True for an absolute http(s) URL that is not on this site. */
export function isExternalHref(href: unknown): href is string {
  if (typeof href !== "string" || !/^https?:\/\//i.test(href)) return false;
  try {
    return new URL(href).origin !== "https://glideworth.com";
  } catch {
    return false;
  }
}

/** Merges the external rel tokens into an existing rel value. */
export function mergeRel(existing: unknown): string {
  const tokens = new Set(
    String(existing ?? "")
      .split(/\s+/)
      .filter(Boolean),
  );
  for (const t of EXTERNAL_REL.split(" ")) tokens.add(t);
  return [...tokens].join(" ");
}

/** Spread onto an <a>: `<a href={href} {...externalLinkProps(href)}>`. */
export function externalLinkProps(href: string | undefined): { rel?: string } {
  return isExternalHref(href) ? { rel: EXTERNAL_REL } : {};
}

/** Adds the rel to every external <a href="…"> in a string of HTML (used for FAQ answers). */
export function withExternalRel(html: string): string {
  return html.replace(
    /<a\b([^>]*?)\shref="(https?:\/\/[^"]*)"([^>]*)>/g,
    (whole, before, href, after) => {
      if (!isExternalHref(href) || /\srel=/.test(`${before}${after}`)) return whole;
      return `<a${before} href="${href}"${after} rel="${EXTERNAL_REL}">`;
    },
  );
}
