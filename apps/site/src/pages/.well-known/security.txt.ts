/**
 * RFC 9116 security.txt. The fields come from @glideworth/cloud/security-txt, which the app host serves
 * too; only Canonical is this site's own. check:dist fails when Expires is less than 30 days away.
 */
import { securityTxt } from "@glideworth/cloud/security-txt";
import type { APIRoute } from "astro";
import { site } from "../../config/site";

export const GET: APIRoute = () =>
  new Response(securityTxt(`${site.url}/.well-known/security.txt`), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
