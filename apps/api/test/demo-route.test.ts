/**
 * The public demo is the web app at /demo (apps/web lib/demo.ts): the server only serves the SPA shell
 * there, to anyone, with the app host's usual headers. Nothing about it is a server route: no session,
 * no cookie, no data, and the app host stays out of search engines.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, setup } from "./helpers.js";

function distDir() {
  const dir = mkdtempSync(join(tmpdir(), "glideworth-web-demo-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><title>Glideworth</title><div id="root"></div>',
  );
  return dir;
}

let h: Harness | undefined;
afterEach(() => h?.close());

describe("/demo", () => {
  it("serves the app shell anonymously, with no cookie, no data and noindex", async () => {
    h = setup({ appOptions: { webDist: distDir() } });
    for (const path of ["/demo", "/demo/", "/demo/results", "/demo/plans/plan-main"]) {
      const r = await h.call(path, { key: null });
      expect(r.status, path).toBe(200);
      expect(r.text, path).toContain('<div id="root">');
      expect(r.headers.get("content-type"), path).toContain("text/html");
      expect(r.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
      expect(r.headers.get("x-frame-options"), path).toBe("DENY");
      expect(r.headers.get("set-cookie"), path).toBeNull();
      // The shell carries no household: the sample is bundled into the app's JavaScript.
      expect(r.text, path).not.toMatch(/Avery|household/i);
    }
  });

  it("is not an API: the API under /demo is not reachable and the API still needs a credential", async () => {
    h = setup({ appOptions: { webDist: distDir() } });
    expect((await h.call("/api/v1/households", { key: null })).status).toBe(401);
    const shell = await h.call("/demo/api/v1/households", { key: null });
    expect(shell.text).toContain('<div id="root">');
    expect(shell.text).not.toContain("hh-sample");
  });
});
