/**
 * The country versions of the home page: the browser-side country guess, the banner's decision, the
 * hreflang set (generated from the registry, so it is reciprocal), and each entry's title and keyword
 * against docs/seo-keyword-map.md. After a build, the built pages are checked too.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "../config/site";
import {
  COUNTRY_CLOSED,
  countryFromTimeZone,
  guessCountry,
  regionFromLanguage,
  suggestedVersion,
  type VersionLink,
} from "./guess";
import {
  DEFAULT_LANDING,
  hreflangAlternates,
  LANDINGS,
  landingPath,
  versionLinks,
} from "./registry";

const siteRoot = join(import.meta.dirname, "../..");

describe("guessCountry", () => {
  it("reads the UK, the US, Canada and Australia from the time zone or the language", () => {
    expect(guessCountry({ timeZone: "Europe/London", languages: ["en-GB"] })).toBe("GB");
    expect(guessCountry({ languages: ["en-GB", "en"] })).toBe("GB");
    expect(guessCountry({ timeZone: "America/Chicago", languages: ["en-US"] })).toBe("US");
    expect(guessCountry({ timeZone: "Pacific/Honolulu" })).toBe("US");
    expect(guessCountry({ timeZone: "America/Toronto", languages: ["en-CA", "fr-CA"] })).toBe("CA");
    expect(guessCountry({ languages: ["fr-CA"] })).toBe("CA");
    expect(guessCountry({ timeZone: "Australia/Sydney", languages: ["en-AU"] })).toBe("AU");
    expect(guessCountry({ timeZone: "Australia/Perth" })).toBe("AU");
  });

  it("lets a single-country time zone win over the language, and the language break a tie", () => {
    // An en-US browser set up in London: where the computer is, not the default language.
    expect(guessCountry({ timeZone: "Europe/London", languages: ["en-US"] })).toBe("GB");
    expect(guessCountry({ timeZone: "America/Vancouver", languages: ["en-US"] })).toBe("CA");
    // UTC or a zone not in the table says nothing; the first language with a region decides.
    expect(guessCountry({ timeZone: "UTC", languages: ["en-AU", "en-GB"] })).toBe("AU");
    expect(guessCountry({ timeZone: "Etc/GMT", languages: ["en", "en-GB"] })).toBe("GB");
    expect(guessCountry({ timeZone: "Asia/Dubai", languages: ["en-US"] })).toBe("US");
  });

  it("returns nothing when unsure", () => {
    expect(guessCountry({})).toBeUndefined();
    expect(guessCountry({ timeZone: "UTC", languages: ["en"] })).toBeUndefined();
    expect(guessCountry({ timeZone: "Asia/Tokyo", languages: ["ja"] })).toBeUndefined();
    expect(guessCountry({ languages: ["es-419", "zh-Hant"] })).toBeUndefined();
  });

  it("survives garbage", () => {
    for (const input of [
      { timeZone: null, languages: null },
      { timeZone: 42, languages: [1, null, {}, ["en-GB"]] },
      { timeZone: {}, languages: "en-GB" as unknown as string[] },
      { timeZone: "x".repeat(10_000), languages: ["en-" + "G".repeat(500)] },
      { timeZone: "Europe/Atlantis", languages: ["", "-", "--GB", "123-GB", "en--"] },
    ]) {
      expect(guessCountry(input)).toBeUndefined();
    }
  });

  it("parses language regions and zones strictly", () => {
    expect(regionFromLanguage("en_au")).toBe("AU");
    expect(regionFromLanguage("zh-Hant-TW")).toBe("TW");
    expect(regionFromLanguage("en")).toBeUndefined();
    expect(regionFromLanguage("es-419")).toBeUndefined();
    expect(countryFromTimeZone("Europe/Dublin")).toBe("IE");
    expect(countryFromTimeZone("europe/london")).toBeUndefined();
  });

  it("stays a leaf module: the banner script loads it, and it must pull nothing else in", () => {
    const source = readFileSync(join(import.meta.dirname, "guess.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/fetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|posthog/i);
  });
});

describe("suggestedVersion", () => {
  const versions: VersionLink[] = [
    { code: "US", path: "/", label: "US" },
    { code: "GB", path: "/uk/", label: "UK" },
  ];
  const decide = (current: string, guess: string | undefined, stored: unknown = null) =>
    suggestedVersion({ current, versions, guess, stored })?.path;

  it("offers the guessed country's version when it is not this page", () => {
    expect(decide("US", "GB")).toBe("/uk/");
    expect(decide("GB", "US")).toBe("/");
  });

  it("shows nothing on the guessed country's own page, or when the guess has no version", () => {
    expect(decide("GB", "GB")).toBeUndefined();
    expect(decide("US", "US")).toBeUndefined();
    expect(decide("US", "DE")).toBeUndefined();
    expect(decide("GB", "IE")).toBeUndefined();
    expect(decide("US", undefined)).toBeUndefined();
  });

  it("lets a remembered choice beat the guess, and a closed suggestion stay closed", () => {
    expect(decide("US", "US", "GB")).toBe("/uk/");
    expect(decide("US", "GB", "US")).toBeUndefined();
    expect(decide("GB", "GB", "US")).toBe("/");
    expect(decide("US", "GB", COUNTRY_CLOSED)).toBeUndefined();
    expect(decide("GB", "US", COUNTRY_CLOSED)).toBeUndefined();
  });

  it("ignores a stored value that is not a version", () => {
    expect(decide("US", "GB", "FR")).toBe("/uk/");
    expect(decide("US", "GB", "")).toBe("/uk/");
    expect(decide("US", undefined, "{}")).toBeUndefined();
  });
});

describe("the registry", () => {
  it("has one entry per code, slug and hreflang, with the default at /", () => {
    expect(landingPath(DEFAULT_LANDING)).toBe("/");
    expect(LANDINGS[0]).toBe(DEFAULT_LANDING);
    for (const key of ["code", "slug", "hreflang"] as const) {
      const values = LANDINGS.map((e) => e[key]);
      expect(new Set(values).size, key).toBe(values.length);
    }
    for (const e of LANDINGS) {
      if (e !== DEFAULT_LANDING) expect(e.slug).toMatch(/^[a-z]{2}$/);
      expect(e.hreflang).toMatch(/^en-[A-Z]{2}$/);
    }
  });

  it("builds the hreflang set from the registry: every version plus x-default, absolute", () => {
    const set = hreflangAlternates();
    expect(set.map((a) => a.hreflang)).toEqual([...LANDINGS.map((e) => e.hreflang), "x-default"]);
    for (const e of LANDINGS)
      expect(set).toContainEqual({ hreflang: e.hreflang, href: `${site.url}${landingPath(e)}` });
    expect(set.at(-1)).toEqual({ hreflang: "x-default", href: `${site.url}/` });
    expect(versionLinks().map((v) => v.path)).toEqual(LANDINGS.map(landingPath));
  });

  it("gives every country version a /planning/ page with the same slug", () => {
    for (const e of LANDINGS.filter((x) => x !== DEFAULT_LANDING))
      expect(existsSync(join(siteRoot, "src/content/countries", `${e.slug}.mdx`)), e.slug).toBe(
        true,
      );
  });

  it("keeps titles within 60 characters and descriptions between 120 and 160", () => {
    for (const e of LANDINGS) {
      const title = e.seo.fullTitle ? e.seo.title : `${e.seo.title} · ${site.name}`;
      expect(title.length, title).toBeLessThanOrEqual(60);
      expect(e.seo.description.length, e.code).toBeGreaterThanOrEqual(120);
      expect(e.seo.description.length, e.code).toBeLessThanOrEqual(160);
    }
    const descriptions = LANDINGS.map((e) => e.seo.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("gives each version a primary keyword in the keyword map that no other URL owns", () => {
    const map = readFileSync(join(siteRoot, "../../docs/seo-keyword-map.md"), "utf8");
    const rows = map
      .split("\n")
      .filter((l) => /^\| \/\S*\s*\|/.test(l))
      .map((l) => l.split("|").map((c) => c.trim()))
      .map(([, url, primary, secondary]) => ({
        url: url!,
        keywords: [primary!, ...secondary!.split(";").map((s) => s.trim())].filter(
          (k) => k && k !== "—",
        ),
        primary: primary!,
      }));
    for (const e of LANDINGS) {
      const path = landingPath(e);
      const row = rows.find((r) => r.url === path);
      expect(row, `${path} is in docs/seo-keyword-map.md`).toBeDefined();
      expect(row!.primary).toBe(e.seo.primaryKeyword);
      const others = rows.filter(
        (r) => r.url !== path && r.keywords.includes(e.seo.primaryKeyword),
      );
      expect(
        others.map((r) => r.url),
        e.seo.primaryKeyword,
      ).toEqual([]);
    }
  });
});

const dist = join(siteRoot, "dist");
const built = LANDINGS.every((e) => existsSync(join(dist, landingPath(e), "index.html")));

describe.skipIf(!built)("the built country versions", () => {
  const html = (e: (typeof LANDINGS)[number]) =>
    readFileSync(join(dist, landingPath(e), "index.html"), "utf8");

  it("are self-canonical, carry the same reciprocal hreflang set, and have one h1", () => {
    const expected = hreflangAlternates()
      .map((a) => `${a.hreflang} ${a.href}`)
      .sort();
    for (const e of LANDINGS) {
      const page = html(e);
      expect(page).toContain(`<link rel="canonical" href="${site.url}${landingPath(e)}">`);
      const links = [...page.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)]
        .map((m) => `${m[1]} ${m[2]}`)
        .sort();
      expect(links, e.code).toEqual(expected);
      expect(page.match(/<h1[\s>]/g)?.length, e.code).toBe(1);
      // The banner is sent hidden and empty to everyone; the script fills it in.
      expect(page).toMatch(/<aside[^>]*data-country-banner[^>]*hidden/);
    }
  });

  it("leave US terms off the UK page", () => {
    const uk = LANDINGS.find((e) => e.code === "GB");
    if (!uk) return;
    const main = html(uk).split("<main")[1]!.split("</main>")[0]!;
    const text = main
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
      .replace(/<[^>]+>/g, " ");
    for (const term of ["401(k)", "IRA", "Roth", "Social Security", "IRS"])
      expect(text, term).not.toContain(term);
    expect(text).toContain("£");
  });

  it("leave US and UK terms off the Australian page", () => {
    const au = LANDINGS.find((e) => e.code === "AU");
    if (!au) return;
    const main = html(au).split("<main")[1]!.split("</main>")[0]!;
    const text = main
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
      .replace(/<[^>]+>/g, " ");
    for (const term of [
      "401(k)",
      "IRA",
      "Roth",
      "Social Security",
      "IRS",
      "ISA",
      "SIPP",
      "State Pension",
      "HMRC",
      "£",
    ])
      expect(text, term).not.toContain(term);
    expect(text).toContain("A$");
  });

  it("keep the hreflang set off every other page", () => {
    for (const path of [
      "pricing/index.html",
      "planning/uk/index.html",
      "tools/uk-fire-calculator/index.html",
    ]) {
      expect(readFileSync(join(dist, path), "utf8"), path).not.toMatch(/hreflang="en-GB"/);
    }
  });
});
