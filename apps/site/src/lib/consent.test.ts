import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONSENT_KEY,
  CONSENT_MAX_AGE_DAYS,
  CONSENT_VERSION,
  readConsent,
  writeConsent,
} from "./consent";

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 17);

describe("readConsent", () => {
  it("reads back what writeConsent stored", () => {
    expect(readConsent(writeConsent("granted", now), now)?.analytics).toBe("granted");
    expect(readConsent(writeConsent("denied", now), now)?.analytics).toBe("denied");
  });

  it("treats a missing, broken or foreign value as no choice, so the banner asks", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "granted",
      "{",
      "null",
      "[]",
      '{"analytics":"granted"}',
    ]) {
      expect(readConsent(raw, now), String(raw)).toBeUndefined();
    }
    expect(
      readConsent(JSON.stringify({ v: CONSENT_VERSION, analytics: "maybe", at: now }), now),
    ).toBeUndefined();
    expect(
      readConsent(JSON.stringify({ v: CONSENT_VERSION + 1, analytics: "granted", at: now }), now),
    ).toBeUndefined();
  });

  it("asks again once the answer is older than the maximum age, or dated in the future", () => {
    const stored = (at: number) => writeConsent("granted", at);
    expect(readConsent(stored(now - CONSENT_MAX_AGE_DAYS * DAY), now)).toBeDefined();
    expect(readConsent(stored(now - CONSENT_MAX_AGE_DAYS * DAY - 1), now)).toBeUndefined();
    expect(readConsent(stored(now + DAY), now)).toBeUndefined();
  });
});

describe("the loader and the banner agree", () => {
  const site = join(import.meta.dirname, "../..");
  const loader = readFileSync(join(site, "src/components/GoogleTagManager.astro"), "utf8");
  const banner = readFileSync(join(site, "src/components/ConsentBanner.astro"), "utf8");
  const layout = readFileSync(join(site, "src/layouts/BaseLayout.astro"), "utf8");

  it("the loader takes the key, version and maximum age from the consent module", () => {
    expect(loader).toMatch(/import \{[^}]*CONSENT_KEY[^}]*\} from "\.\.\/lib\/consent"/);
    expect(loader).toContain("consentKey, consentVersion, consentMaxAgeMs");
    expect(CONSENT_KEY).toBe("glideworth-consent");
  });

  it("only analytics storage is ever granted", () => {
    expect(loader).toContain('gtag("consent", "update", { analytics_storage: "granted" })');
    expect(loader).not.toMatch(/(ad_storage|ad_user_data|ad_personalization)\s*:\s*"granted"/);
    expect(banner).toContain("gtag('consent', 'update', { analytics_storage: choice })");
    expect(banner).not.toMatch(/ad_storage|ad_user_data|ad_personalization/);
  });

  it("offers reject and accept with the same styling, and starts hidden", () => {
    expect(banner).toMatch(/class="consent-btn" data-consent-choice="denied"/);
    expect(banner).toMatch(/class="consent-btn" data-consent-choice="granted"/);
    expect(banner).toMatch(/data-consent-banner hidden/);
  });

  it("is rendered only where the tag loads", () => {
    expect(layout).toContain("{showConsent && <ConsentBanner />}");
    expect(layout).toContain("googleTagManagerOnPath(Astro.url.pathname, PUBLIC_GTM_ID)");
  });
});
