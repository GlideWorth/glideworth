/**
 * Google Tag Manager on the marketing site.
 *
 * The container id is the build-time variable `PUBLIC_GTM_ID`. It is unset in this repository
 * and in every self-hosted build, so those copies never contact Google. The official production
 * deploy is the only place that sets it. The signed-in app does not read the variable.
 *
 * Anything other than a container id is ignored, so a bad value cannot be interpolated into the
 * loader or the noscript iframe.
 */
const CONTAINER_ID = /^GTM-[A-Z0-9]+$/;

export function googleTagManagerId(raw: string | undefined): string | undefined {
  const id = (raw ?? "").trim();
  if (!CONTAINER_ID.test(id)) return undefined;
  return id;
}

/**
 * Calculators under `/tools/` keep the promise that nothing a visitor types leaves the browser.
 * Every other marketing page may load the tag.
 */
export function googleTagManagerOnPath(
  pathname: string,
  raw: string | undefined,
): string | undefined {
  const id = googleTagManagerId(raw);
  if (!id) return undefined;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const withSlash = path.endsWith("/") ? path : `${path}/`;
  if (withSlash === "/tools/" || withSlash.startsWith("/tools/")) return undefined;
  return id;
}
