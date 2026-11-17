import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { googleTagManagerId, googleTagManagerOnPath } from "./gtm";

describe("googleTagManagerId", () => {
  it("is off when unset or blank", () => {
    expect(googleTagManagerId(undefined)).toBeUndefined();
    expect(googleTagManagerId("")).toBeUndefined();
    expect(googleTagManagerId("   ")).toBeUndefined();
  });

  it("accepts a container id", () => {
    expect(googleTagManagerId(" GTM-ABC123 ")).toBe("GTM-ABC123");
  });

  it("rejects values that are not a container id", () => {
    expect(googleTagManagerId("G-ABC123")).toBeUndefined();
    expect(googleTagManagerId("gtm-ABC123")).toBeUndefined();
    expect(googleTagManagerId("GTM-")).toBeUndefined();
    expect(googleTagManagerId('GTM-ABC";alert(1)')).toBeUndefined();
    expect(googleTagManagerId("GTM-ABC/evil")).toBeUndefined();
    expect(
      googleTagManagerId("https://www.googletagmanager.com/gtm.js?id=GTM-ABC"),
    ).toBeUndefined();
  });
});

describe("googleTagManagerOnPath", () => {
  it("stays off the calculators, where visitors type figures", () => {
    expect(googleTagManagerOnPath("/tools/", "GTM-ABC")).toBeUndefined();
    expect(googleTagManagerOnPath("/tools", "GTM-ABC")).toBeUndefined();
    expect(googleTagManagerOnPath("/tools/coast-fire-calculator/", "GTM-ABC")).toBeUndefined();
    expect(googleTagManagerOnPath("/tools/engine-check/", "GTM-ABC")).toBeUndefined();
  });

  it("loads on marketing pages when an id is set", () => {
    expect(googleTagManagerOnPath("/", "GTM-ABC")).toBe("GTM-ABC");
    expect(googleTagManagerOnPath("/pricing/", "GTM-ABC")).toBe("GTM-ABC");
    expect(googleTagManagerOnPath("/legal/cookies/", "GTM-ABC")).toBe("GTM-ABC");
  });

  it("does not treat a similarly named path as a calculator", () => {
    expect(googleTagManagerOnPath("/tooling/", "GTM-ABC")).toBe("GTM-ABC");
  });

  it("stays off every page when the id is unset", () => {
    expect(googleTagManagerOnPath("/", "")).toBeUndefined();
    expect(googleTagManagerOnPath("/pricing/", undefined)).toBeUndefined();
  });
});

describe("the tag is not hardcoded", () => {
  const repo = join(import.meta.dirname, "../../../..");
  // Split so this file does not itself contain the production container id.
  const productionContainer = ["GTM", "5M4QSMSJ"].join("-");
  const allowed = new Set([join(repo, ".github/workflows/deploy.yml")]);

  // A missing directory is skipped: the public export leaves out infra/ and the deploy workflow.
  function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
      if (name === "node_modules" || name === "dist" || name === ".astro") return [];
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }

  it("appears only in the production deploy, not in the app, the site source or example env", () => {
    const files = [
      ...walk(join(repo, "apps")),
      ...walk(join(repo, "packages")),
      ...walk(join(repo, "docs")),
      ...walk(join(repo, "infra")),
      ...walk(join(repo, ".github")),
      join(repo, ".env.example"),
      join(repo, "README.md"),
    ];
    const hits = files.filter(
      (file) => !allowed.has(file) && readFileSync(file, "utf8").includes(productionContainer),
    );
    expect(hits).toEqual([]);
  });

  it("the loader is the GTM snippet with consent denied, and the app does not load it", () => {
    const loader = readFileSync(
      join(repo, "apps/site/src/components/GoogleTagManager.astro"),
      "utf8",
    );
    expect(loader).toContain("https://www.googletagmanager.com/gtm.js?id=");
    expect(loader).toContain("https://www.googletagmanager.com/ns.html?id=");
    expect(loader).toContain('gtag("consent", "default"');
    expect(loader).toContain('ad_storage: "denied"');
    expect(loader).toContain('ad_user_data: "denied"');
    expect(loader).toContain('ad_personalization: "denied"');
    expect(loader).toContain('analytics_storage: "denied"');
    const web = walk(join(repo, "apps/web"))
      .filter((file) => /\.(ts|tsx|html)$/.test(file))
      .filter((file) => /googletagmanager|gtag\(/.test(readFileSync(file, "utf8")));
    expect(web).toEqual([]);
  });
});
