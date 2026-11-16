/**
 * The `next` redirect rule, enforced on the client as well as by the server (packages/cloud
 * http/common.ts `safeNext`): only a same-origin relative path. Absolute URLs, `//host`, backslashes,
 * control characters and anything that resolves to another origin become `/`. A path that is itself a
 * sign-in page also becomes `/`, so signing in cannot loop.
 */
import { CLOUD_PUBLIC_PATHS } from "../../lib/auth";

export function safeNext(next: unknown, origin: string = window.location.origin): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return "/";
  // oxlint-disable-next-line eslint/no-control-regex -- control characters are what we refuse
  if (!next.startsWith("/") || next.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(next))
    return "/";
  try {
    const u = new URL(next, origin);
    if (u.origin !== origin) return "/";
    if (CLOUD_PUBLIC_PATHS.includes(u.pathname)) return "/";
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return "/";
  }
}

/** The page's own `?next=` value, validated. */
export const nextFromLocation = (): string =>
  safeNext(new URLSearchParams(window.location.search).get("next"));

/** Full page navigation (so every cached figure and the CSRF cookie start fresh). Indirect for tests. */
export const nav = {
  go(path: string) {
    window.location.assign(path);
  },
};
