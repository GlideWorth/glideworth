import { describe, expect, it } from "vitest";
import { renderResults } from "./render";
import type { ViewModel } from "./types";

const vm = (rows: string[][]): ViewModel => ({
  tool: "guardrails",
  headline: "h",
  announce: "a",
  figures: [],
  charts: [],
  table: { caption: "Your guardrails", columns: ["", "Guyton-Klinger", "Risk-based"], rows },
  method: [],
  warnings: [],
});

describe("result tables", () => {
  it("lets a long text cell wrap and keeps figures on one line", () => {
    const html = renderResults(
      vm([
        ["Spending now", "$50,000 (hold)", "$50,000 (hold)"],
        [
          "What sets it off",
          "Withdrawal rate above 6.00% or below 4.00%",
          "Chance of success below 70% or above 95%",
        ],
      ]),
    );
    expect(html).toContain('<td class="num">$50,000 (hold)</td>');
    expect(html).toContain('<td class="num long">Withdrawal rate above 6.00% or below 4.00%</td>');
  });
});
