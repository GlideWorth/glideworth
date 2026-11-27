/**
 * The site's PostHog `before_send` (posthog-scrub.ts) on events shaped like the ones posthog-js 1.450 builds
 * (property names read from @posthog/browser-common's event-utils, heatmaps, autocapture and session-props).
 * Each test fails if a calculator input or a figure from the page could reach PostHog.
 */
import { describe, expect, it } from "vitest";
import { SPECS } from "../tools/specs";
import { defaults, toQuery } from "../tools/state";
import { isCalculatorPath, scrubSiteEvent, scrubUrl } from "./posthog-scrub";

const ORIGIN = "https://glideworth.com";
const CALC = "/tools/coast-fire-calculator/";
/** Inputs a visitor typed, as ui/mount.ts writes them into the address. */
const INPUTS = "age=37&retire=58&invested=123456&saving=4321&spend=54321&growth=6.5&v=1";
const CALC_URL = `${ORIGIN}${CALC}?${INPUTS}#results`;
const FIGURE = "$987,654";

/** Every string anywhere in the event, keys included. */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]);
  return [];
}

function expectNothingTyped(event: unknown) {
  const all = strings(event).join("\n");
  for (const secret of ["123456", "4321", "54321", "age=", "?", "#results", FIGURE, "987,654"])
    expect(all, `"${secret}" in ${all}`).not.toContain(secret);
}

/** A `$pageview` on a calculator page reloaded with its inputs in the address. */
function calculatorPageview() {
  return {
    event: "$pageview",
    uuid: "0190",
    properties: {
      token: "phc_x",
      $current_url: CALC_URL,
      $host: "glideworth.com",
      $pathname: CALC,
      $referrer: `${ORIGIN}/tools/fire-calculator/?spend=54321&v=1`,
      $referring_domain: "glideworth.com",
      $session_entry_url: CALC_URL,
      $session_entry_referrer: "$direct",
      $session_entry_pathname: CALC,
      $prev_pageview_pathname: "/tools/fire-calculator/",
      utm_source: "newsletter",
      title: "Coast FIRE calculator | Glideworth",
      $web_vitals_LCP_event: {
        name: "LCP",
        value: 812,
        $current_url: CALC_URL,
        attribution: { url: CALC_URL },
      },
    },
    $set_once: {
      $initial_current_url: CALC_URL,
      $initial_referrer: CALC_URL,
      $initial_utm_source: "newsletter",
    },
  };
}

describe("scrubUrl", () => {
  it("drops the query string and fragment", () => {
    expect(scrubUrl(CALC_URL)).toBe(`${ORIGIN}${CALC}`);
    expect(scrubUrl(`${CALC}?${INPUTS}`)).toBe(CALC);
    expect(scrubUrl(`${ORIGIN}/pricing/#faq`)).toBe(`${ORIGIN}/pricing/`);
    expect(scrubUrl("$direct")).toBe("$direct");
  });
});

describe("isCalculatorPath", () => {
  it("is every page under /tools/ and nothing else", () => {
    for (const p of ["/tools/", "/tools", CALC, "tools/engine-check/"])
      expect(isCalculatorPath(p), p).toBe(true);
    for (const p of ["/", "/pricing/", "/toolsmith/", "/blog/coast-fire-explained/"])
      expect(isCalculatorPath(p), p).toBe(false);
  });
});

describe("scrubSiteEvent", () => {
  it("removes calculator inputs from the current URL, referrer, session-entry, initial and nested URLs", () => {
    const out = scrubSiteEvent(calculatorPageview(), true)!;
    expectNothingTyped(out);
    expect(out.properties!.$current_url).toBe(`${ORIGIN}${CALC}`);
    expect(out.properties!.$referrer).toBe(`${ORIGIN}/tools/fire-calculator/`);
    expect(out.$set_once!.$initial_current_url).toBe(`${ORIGIN}${CALC}`);
    // Campaign tags are read into their own properties before before_send runs; they stay.
    expect(out.properties!.utm_source).toBe("newsletter");
    expect(out.$set_once!.$initial_utm_source).toBe("newsletter");
    expect(out.properties!.token).toBe("phc_x");
  });

  it("removes them from the referrer of the next page, which is not a calculator page", () => {
    const next = {
      event: "$pageview",
      properties: {
        $current_url: `${ORIGIN}/pricing/?utm_source=x`,
        $pathname: "/pricing/",
        $referrer: CALC_URL,
        $session_entry_url: CALC_URL,
      },
    };
    const out = scrubSiteEvent(next, false)!;
    expectNothingTyped(out);
    expect(out.properties!.$referrer).toBe(`${ORIGIN}${CALC}`);
  });

  it("removes them from any absolute URL, whatever the property is called", () => {
    const out = scrubSiteEvent(
      { event: "x", properties: { u: CALC_URL, r: CALC_URL, list: [CALC_URL] } },
      false,
    )!;
    expectNothingTyped(out);
  });

  it("re-keys heatmap points by the page without its query string", () => {
    const out = scrubSiteEvent(
      {
        event: "$$heatmap",
        properties: {
          $current_url: CALC_URL,
          $heatmap_data: {
            [CALC_URL]: [{ x: 1, y: 2, type: "click" }],
            [`${ORIGIN}${CALC}?age=40&v=1`]: [{ x: 3, y: 4, type: "click" }],
          },
        },
      },
      true,
    )!;
    expectNothingTyped(out);
    expect(out.properties!.$heatmap_data).toEqual({
      [`${ORIGIN}${CALC}`]: [
        { x: 1, y: 2, type: "click" },
        { x: 3, y: 4, type: "click" },
      ],
    });
  });

  it("drops element text on calculator pages, in the event and in each element", () => {
    const click = {
      event: "$autocapture",
      properties: {
        $current_url: CALC_URL,
        $pathname: CALC,
        $el_text: FIGURE,
        $elements: [
          { tag_name: "output", $el_text: FIGURE, attr__href: `${CALC}?${INPUTS}`, nth_child: 1 },
        ],
        $elements_chain: `output:nth-child="1"nth-of-type="1"text="${FIGURE}";div.tool-results:nth-child="2"`,
        $input_value: "123456",
      },
    };
    // Flagged by the page the SDK started on, or by the event's own $pathname.
    for (const onCalculatorPage of [true, false]) {
      const out = scrubSiteEvent(structuredClone(click), onCalculatorPage)!;
      expectNothingTyped(out);
      expect(out.properties!.$elements).toEqual([
        { tag_name: "output", attr__href: CALC, nth_child: 1 },
      ]);
      expect(out.properties).not.toHaveProperty("$elements_chain");
    }
  });

  it("keeps a calculator page's elements chain that has no text, with hrefs cut to the path", () => {
    const chain = `a.tool-link:attr__href="${CALC}?${INPUTS}"href="${CALC}?${INPUTS}"nth-child="1"nth-of-type="1"`;
    const out = scrubSiteEvent(
      { event: "$autocapture", properties: { $pathname: CALC, $elements_chain: chain } },
      true,
    )!;
    expect(out.properties!.$elements_chain).toBe(
      `a.tool-link:attr__href="${CALC}"href="${CALC}"nth-child="1"nth-of-type="1"`,
    );
  });

  it("keeps element text on other pages", () => {
    const out = scrubSiteEvent(
      {
        event: "$autocapture",
        properties: { $pathname: "/pricing/", $el_text: "Start free trial" },
      },
      false,
    )!;
    expect(out.properties!.$el_text).toBe("Start free trial");
  });

  it("drops copied text and copy events on calculator pages", () => {
    const copy = {
      event: "$copy_autocapture",
      properties: { $pathname: CALC, $selected_content: FIGURE },
    };
    expect(scrubSiteEvent(copy, true)).toBeNull();
    expect(scrubSiteEvent(copy, false)).toBeNull();
  });

  it("removes every calculator's real default inputs from its address", () => {
    for (const spec of Object.values(SPECS)) {
      const query = toQuery(spec, defaults(spec));
      const url = `${ORIGIN}/tools/${spec.id}/?${query}`;
      const out = scrubSiteEvent(
        {
          event: "$pageview",
          properties: { $current_url: url, $referrer: url, $pathname: `/tools/${spec.id}/` },
        },
        true,
      )!;
      expect(strings(out).join("\n"), spec.id).not.toContain(query);
      expect(strings(out).join("\n"), spec.id).not.toContain("?");
    }
  });
});

/** @posthog/browser-common CAMPAIGN_PARAMS: read from the address into their own properties, before before_send. */
const CAMPAIGN_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gad_source",
  "mc_cid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "twclid",
  "li_fat_id",
  "igshid",
  "ttclid",
  "rdt_cid",
  "epik",
  "qclid",
  "sccid",
  "oppref",
  "bfcid",
  "irclid",
  "_kx",
]);

describe("calculator inputs and campaign tags", () => {
  it("no calculator input is named like a campaign tag, which posthog-js would copy into its own property", () => {
    for (const spec of Object.values(SPECS))
      for (const f of spec.fields)
        expect(CAMPAIGN_PARAMS.has(f.key) || f.key.startsWith("utm_"), `${spec.id}.${f.key}`).toBe(
          false,
        );
  });
});
