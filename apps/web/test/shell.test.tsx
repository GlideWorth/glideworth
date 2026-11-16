import { UserSettings } from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { applyChartPrefs } from "../src/components/charts/echarts";
import { isNavActive } from "../src/components/layout/app-shell";
import { computeNextSteps } from "../src/components/layout/next-steps";
import { GO_TO, isTypingTarget } from "../src/components/layout/shortcuts";
import { Select } from "../src/components/ui/select";
import { mcpSnippets } from "../src/features/settings/ai-section";
import { csrfHeaders, interpretSession, passphraseStrength } from "../src/lib/auth";
import { formatMoney, setCompactNumbers } from "../src/lib/format";
import { mergeSettings } from "../src/lib/settings";
import { successTone } from "../src/stores/prefs";

describe("session status interpretation", () => {
  it('treats a missing route as "sessions not in use" (dev proxy / bearer keys)', () => {
    expect(interpretSession(404, null)).toEqual({ kind: "disabled" });
    expect(interpretSession(501, null)).toEqual({ kind: "disabled" });
  });
  it("maps the API status body", () => {
    expect(interpretSession(200, { setupRequired: true, authenticated: false })).toEqual({
      kind: "setup",
    });
    expect(interpretSession(200, { setupRequired: false, authenticated: false })).toEqual({
      kind: "login",
    });
    expect(
      interpretSession(200, { setupRequired: false, authenticated: true, via: "session" }),
    ).toMatchObject({
      kind: "authenticated",
      via: "session",
    });
    expect(interpretSession(401, {})).toEqual({ kind: "login" });
  });
  it("lets an API key through even before a passphrase exists (dev proxy on a fresh database)", () => {
    expect(
      interpretSession(200, { setupRequired: true, authenticated: true, via: "key" }),
    ).toMatchObject({
      kind: "authenticated",
      via: "key",
    });
  });
  it("reports an unreachable server", () => {
    expect(interpretSession(500, null).kind).toBe("unreachable");
  });
  it("rates passphrases and sends the CSRF token only on writes", () => {
    expect(passphraseStrength("short")).toBe(0);
    expect(passphraseStrength("twelve chars")).toBe(1);
    expect(passphraseStrength("quiet granite river lantern")).toBe(3);
    document.cookie = "glideworth_csrf=tok123; path=/";
    expect(csrfHeaders("GET")).toEqual({});
    expect(csrfHeaders("PATCH")).toEqual({ "x-csrf-token": "tok123" });
    document.cookie = "glideworth_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });
  it("still reads the CSRF cookie of a session signed in before the rename (cairn_csrf)", () => {
    document.cookie = "cairn_csrf=old456; path=/";
    expect(csrfHeaders("POST")).toEqual({ "x-csrf-token": "old456" });
    document.cookie = "glideworth_csrf=new789; path=/";
    expect(csrfHeaders("POST")).toEqual({ "x-csrf-token": "new789" });
    document.cookie = "cairn_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    document.cookie = "glideworth_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });
});

describe("navigation and shortcuts", () => {
  const item = (to: string) => ({ to, label: to, icon: () => null, owner: "i" }) as never;
  it("highlights exactly one of Plans / Plan editor", () => {
    expect(isNavActive(item("/plans"), "/plans")).toBe(true);
    expect(isNavActive(item("/plans"), "/plans/p1")).toBe(false);
    expect(isNavActive(item("/plans/active"), "/plans/p1")).toBe(true);
    expect(isNavActive(item("/"), "/results")).toBe(false);
    expect(isNavActive(item("/settings"), "/settings/keys")).toBe(true);
  });
  it("ignores single-key shortcuts while typing", () => {
    const input = document.createElement("input");
    const div = document.createElement("div");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("button");
    dialog.appendChild(inner);
    document.body.append(input, div, dialog);
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(div)).toBe(false);
    expect(isTypingTarget(inner)).toBe(true);
  });
  it('has unique "g then x" keys', () => {
    expect(new Set(GO_TO.map((g) => g.key)).size).toBe(GO_TO.length);
  });
});

describe("next-step hints", () => {
  it("suggests nothing for offline sample data", () => {
    const doc = createSampleDocument();
    expect(computeNextSteps(doc, doc.plans[0], { chanceRun: false, source: "sample" })).toEqual([]);
  });
  it("suggests accounts and a plan for an empty household", () => {
    const doc = createSampleDocument();
    const empty = {
      ...doc,
      finances: { ...doc.finances, accounts: [], realAssets: [], debts: [] },
      plans: [],
    };
    const asOf = new Date(`${doc.finances.asOf}-15T00:00:00Z`);
    expect(
      computeNextSteps(empty, undefined, { chanceRun: false, source: "api" }, asOf).map(
        (s) => s.id,
      ),
    ).toEqual(["add-accounts", "first-plan"]);
  });
  it("flags balances dated more than six months ago (plans would start in the past)", () => {
    const doc = createSampleDocument();
    const later = new Date(`${doc.finances.asOf}-15T00:00:00Z`);
    later.setUTCMonth(later.getUTCMonth() + 7);
    const steps = computeNextSteps(doc, doc.plans[0], { chanceRun: true, source: "api" }, later);
    expect(steps[0]?.id).toBe(`stale-asof:${doc.finances.asOf}`);
    const fresh = computeNextSteps(
      doc,
      doc.plans[0],
      { chanceRun: true, source: "api" },
      new Date(`${doc.finances.asOf}-15T00:00:00Z`),
    );
    expect(fresh.some((s) => s.id.startsWith("stale-asof"))).toBe(false);
  });
  it("suggests running chance of success and a first snapshot", () => {
    const doc = { ...createSampleDocument(), progress: [] };
    const now = new Date(`${doc.finances.asOf}-15T00:00:00Z`);
    const ids = computeNextSteps(doc, doc.plans[0], { chanceRun: false, source: "api" }, now).map(
      (s) => s.id,
    );
    expect(ids.some((i) => i.startsWith("chance:"))).toBe(true);
    expect(ids).toContain("first-snapshot");
    const after = computeNextSteps(doc, doc.plans[0], { chanceRun: true, source: "api" }, now).map(
      (s) => s.id,
    );
    expect(after.some((i) => i.startsWith("chance:"))).toBe(false);
  });
});

describe("preferences", () => {
  it("applies chart animation and smoothing without touching explicit choices", () => {
    const o = applyChartPrefs(
      {
        series: [
          { type: "line", data: [] },
          { type: "line", smooth: false, data: [] },
          { type: "bar", data: [] },
        ],
      },
      { animate: false, smooth: true },
    ) as { animation: boolean; series: { smooth?: unknown }[] };
    expect(o.animation).toBe(false);
    expect(o.series.map((s) => s.smooth)).toEqual([0.25, false, undefined]);
  });
  it("turns compact money off when the user prefers full numbers", () => {
    const fmt = { locale: "en-GB", currency: "GBP", compact: true };
    expect(formatMoney(1_250_000, fmt)).toMatch(/^£1\.25m$/i);
    setCompactNumbers(false);
    expect(formatMoney(1_250_000, fmt)).toBe("£1,250,000");
    setCompactNumbers(true);
  });
  it("merges nested settings patches and removes keys set to null", async () => {
    const base = UserSettings.parse({ displayCurrency: "EUR" });
    const next = await mergeSettings(base, {
      spending: { includeTaxes: true },
      displayCurrency: null,
    });
    expect(next.spending.includeTaxes).toBe(true);
    expect(next.spending.includeMortgage).toBe(true);
    expect(next.displayCurrency).toBeUndefined();
  });
  it("maps chance of success onto the user’s bands", () => {
    expect(successTone(0.9, { good: 0.8, fair: 0.6 })).toBe("positive");
    expect(successTone(0.7, { good: 0.8, fair: 0.6 })).toBe("warning");
    expect(successTone(0.5, { good: 0.8, fair: 0.6 })).toBe("negative");
    expect(successTone(0.7, { good: 0.95, fair: 0.75 })).toBe("negative");
  });
  it("builds MCP client snippets for this server", () => {
    const s = mcpSnippets("https://glideworth.example/mcp", "glideworth_abcdefgh_x");
    expect(s.claudeCode).toContain(
      "claude mcp add --transport http glideworth https://glideworth.example/mcp",
    );
    expect(s.claudeCode).toContain("Bearer glideworth_abcdefgh_x");
    expect(JSON.parse(s.claudeDesktop).mcpServers.glideworth.args).toContain(
      "https://glideworth.example/mcp",
    );
  });
});

function Harness() {
  const [v, setV] = useState<string | undefined>(undefined);
  return (
    <>
      <Select
        aria-label="Plan"
        value={v}
        onValueChange={setV}
        options={[{ value: "a", label: "A" }]}
        placeholder="None"
      />
      <button type="button" onClick={() => setV("a")}>
        pick
      </button>
    </>
  );
}

describe("Select", () => {
  it("stays controlled from undefined to a value (no React warning) and shows the placeholder", () => {
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      render(<Harness />);
      expect(screen.getByRole("combobox", { name: "Plan" }).textContent).toContain("None");
      fireEvent.click(screen.getByText("pick"));
      expect(screen.getByRole("combobox", { name: "Plan" }).textContent).toContain("A");
    } finally {
      console.error = orig;
    }
    expect(errors.filter((e) => String(e).includes("uncontrolled"))).toEqual([]);
  });
});
