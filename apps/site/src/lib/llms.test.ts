import { describe, expect, it } from "vitest";
import { pricing } from "../config/pricing";
import { site } from "../config/site";
import { facts } from "./facts";
import { hostedMcpUrl, mcpParagraph, pricingParagraph, renderLlms } from "./llms";

describe("LLM catalog wording", () => {
  it("states the trial, the price and the free self-hosted build from the pricing config", () => {
    const text = pricingParagraph();
    expect(text).toContain(`${pricing.trialDays}-day free trial with no card`);
    expect(text).toContain("$9 a month or $90 a year");
    expect(text).toContain("Self-hosting is free");
    expect(pricing.monthly).toBe(9);
    expect(pricing.yearly).toBe(90);
    expect(pricing.trialNeedsCard).toBe(false);
  });

  it("points at the hosted MCP server on the app origin", () => {
    expect(hostedMcpUrl()).toBe("https://app.glideworth.com/mcp");
    expect(mcpParagraph()).toContain(hostedMcpUrl());
    expect(mcpParagraph()).toContain(`${facts.mcpTools} tools`);
    expect(mcpParagraph()).toContain(`${facts.apiOperations} operations`);
  });
});

describe("renderLlms", () => {
  it("writes the llmstxt.org layout and keeps a note on one line", () => {
    const text = renderLlms({
      title: site.name,
      summary: "A planner.",
      body: ["First paragraph."],
      sections: [
        {
          heading: "Calculators",
          links: [
            {
              name: "Coast FIRE calculator",
              url: "https://glideworth.com/tools/coast-fire-calculator/",
              note: "One line.\nStill one line.",
            },
          ],
        },
      ],
    });
    expect(text).toBe(
      [
        "# Glideworth",
        "",
        "> A planner.",
        "",
        "First paragraph.",
        "",
        "## Calculators",
        "",
        "- [Coast FIRE calculator](https://glideworth.com/tools/coast-fire-calculator/): One line. Still one line.",
        "",
      ].join("\n"),
    );
  });
});
