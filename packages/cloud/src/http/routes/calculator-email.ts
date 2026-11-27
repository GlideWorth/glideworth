/**
 * "Email me this result" on the marketing site's free calculators (marketing/service.ts). Registered only when
 * `GLIDEWORTH_CALCULATOR_EMAIL_ORIGIN` is set.
 *
 * `POST /email/calculator`: the calculator page's form. The site's web server forwards it from the site's own
 * origin (infra/compose/Caddyfile), so the page talks to nothing but its own origin. A plain form post (no
 * JavaScript) gets an HTML page back; the page script asks for JSON with `Accept: application/json`. Only the
 * site's origin (or this one) may post.
 *
 * `GET /email/calculator/confirm?t=` shows a button and changes nothing (link scanners follow GETs);
 * `POST /email/calculator/confirm` confirms the double opt-in.
 */
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { CloudError } from "../../errors.js";
import {
  calculatorById,
  FORM_FIELDS,
  readInputs,
  toQuery,
} from "../../marketing/calculator-email.js";
import type { CalculatorEmailService } from "../../marketing/service.js";
import { clientIp } from "../common.js";
import { type Html, html, page, securityHeaders } from "../html.js";
import type { RouteKit } from "../kit.js";

const first = (v: unknown): string =>
  typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "";
const all = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter(
    (x): x is string => typeof x === "string",
  );

export function calculatorEmailRoutes(
  k: RouteKit,
  service: CalculatorEmailService,
  siteOrigin: string,
): void {
  const tag = "Cloud email";
  const allowedOrigins = new Set([siteOrigin, k.publicOrigin]);

  const htmlPage = (c: Context, status: 200 | 400 | 429, title: string, body: Html) => {
    securityHeaders(c);
    return c.html(page(title, body), status);
  };
  const backLink = (href: string) => html`<p><a href="${href}">Back to the calculator</a></p>`;

  /** Form posts only, from the site or this origin; the request body is read here, not by the validator. */
  const assertFromSite = (c: Context) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowedOrigins.has(origin))
      throw new CloudError(403, "CSRF", "cross-origin request refused");
    const site = c.req.header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin" && site !== "none")
      throw new CloudError(403, "CSRF", "cross-site request refused");
    const type = c.req.header("content-type") ?? "";
    if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)\b/i.test(type))
      throw new CloudError(400, "VALIDATION", "send the form as form data");
  };

  k.op(
    {
      method: "post",
      path: "/email/calculator",
      tag,
      summary: "Email a free calculator's result to the visitor (marketing site form)",
      description:
        "Queues one email with the calculator's inputs, the figures the page showed (kept only when they match a shape the calculator produces) and a link that reopens it. With `updates` set to the consent version, also records a pending marketing consent and puts the double opt-in link in the same email. The answer is the same for every address. Limited per client address, per recipient and in total.",
      auth: "none",
      ok: 202,
      rawBody: {
        contentType: "application/x-www-form-urlencoded",
        description:
          "`email`, `tool` (calculator id), `q` (the calculator's query string), `fl`/`fv` (repeated: figure label and value), `updates` (consent version, only when the box is ticked), `website` (must be empty).",
      },
      okSchema: z.object({ status: z.literal("sent") }),
    },
    async (c) => {
      const wantsJson = /application\/json/i.test(c.req.header("accept") ?? "");
      let back = siteOrigin;
      try {
        assertFromSite(c);
        const form = await c.req.parseBody({ all: true });
        const tool = first(form[FORM_FIELDS.tool]);
        const query = first(form[FORM_FIELDS.query]);
        const entry = calculatorById(tool);
        if (entry) back = `${siteOrigin}${entry.path}?${toQuery(entry, readInputs(entry, query))}`;
        const consent = first(form[FORM_FIELDS.consent]);
        service.request({
          email: first(form[FORM_FIELDS.email]),
          tool,
          query,
          figureLabels: all(form[FORM_FIELDS.figureLabel]),
          figureValues: all(form[FORM_FIELDS.figureValue]),
          consentVersion: consent ? consent : null,
          honeypot: first(form[FORM_FIELDS.honeypot]),
          ip: clientIp(c, !!k.d.trustProxy),
        });
        if (wantsJson) return c.json({ status: "sent" as const }, 202);
        return htmlPage(
          c,
          200,
          "Check your inbox",
          html`<h1>Check your inbox</h1>
            <p>
              Your result is on its way. If you ticked the reminder box, the email also has a link
              to confirm it: nothing more is sent until you click it.
            </p>
            ${backLink(back)}`,
        );
      } catch (err) {
        if (wantsJson || !(err instanceof CloudError) || (err.status !== 400 && err.status !== 429))
          throw err;
        const status = err.status === 429 ? 429 : 400;
        return htmlPage(
          c,
          status,
          "Not sent",
          html`<h1>We could not send it</h1>
            <p>
              ${
                status === 429
                  ? "Too many emails were asked for. Try again later."
                  : "Check the email address and try again."
              }
            </p>
            ${backLink(back)}`,
        );
      }
    },
  );

  const badLink = (c: Context) =>
    htmlPage(
      c,
      400,
      "Link not valid",
      html`<h1>This link is not valid</h1>
        <p>
          It may have expired (links work for 7 days) or already been used. You can ask again from
          any calculator.
        </p>
        <p><a href="${siteOrigin}/tools/">Free calculators</a></p>`,
    );

  k.op(
    {
      method: "get",
      path: "/email/calculator/confirm",
      tag,
      summary: "Double opt-in confirmation page (changes nothing)",
      auth: "none",
      ok: 200,
      query: z.object({ t: z.string().max(256).optional() }),
      okSchema: z.string(),
      okContentType: "text/html",
    },
    (c, { query }) => {
      if (!query.t || !service.canConfirm(query.t)) return badLink(c);
      return htmlPage(
        c,
        200,
        "Confirm",
        html`<h1>Confirm your reminder</h1>
          <p>
            Once a year we will remind you to re-check your calculation, and now and then send
            Glideworth updates. Every email has a one-click unsubscribe.
          </p>
          <form method="post" action="/email/calculator/confirm">
            <input type="hidden" name="t" value="${query.t}" /><button type="submit">
              Yes, add me
            </button>
          </form>`,
      );
    },
  );

  k.op(
    {
      method: "post",
      path: "/email/calculator/confirm",
      tag,
      summary: "Confirm the double opt-in",
      auth: "none",
      ok: 200,
      rawBody: { contentType: "application/x-www-form-urlencoded", description: "`t=<token>`" },
      okSchema: z.string(),
      okContentType: "text/html",
    },
    async (c) => {
      // The token is the authorisation, as for unsubscribe: no origin check. (The host sends this page with
      // `Referrer-Policy: no-referrer`, under which browsers post with `Origin: null`.)
      k.floodLimit(c, "calc-confirm", 30);
      const form = await c.req.parseBody();
      const done = service.confirm(first(form.t));
      if (!done) return badLink(c);
      return htmlPage(
        c,
        200,
        "Confirmed",
        html`<h1>You are on the list</h1>
          <p>
            We will remind you once a year to re-check your calculation. Changed your mind?
            <a href="${done.unsubscribeUrl}">Unsubscribe</a>.
          </p>
          <p><a href="${siteOrigin}/tools/">Back to the free calculators</a></p>`,
      );
    },
  );
}
