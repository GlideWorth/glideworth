import { describe, expect, it } from "vitest";
import {
  GlideworthDocument,
  Household,
  migrateDocument,
  SCHEMA_VERSION,
  ValidationError,
} from "../src/index.js";
import { createSampleDocument } from "../src/samples/index.js";

describe("schema", () => {
  it("parses the synthetic sample document", () => {
    const doc = createSampleDocument();
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.plans).toHaveLength(2);
    // defaults are filled in
    expect(doc.finances.accounts[0]?.behaviour.growth).toEqual({ kind: "inherit" });
    expect(doc.plans[0]?.drawdown.order.length).toBeGreaterThan(0);
  });

  it("round-trips through JSON and the migration hook", () => {
    const doc = createSampleDocument();
    const again = migrateDocument(JSON.parse(JSON.stringify(doc)));
    expect(again).toEqual(doc);
  });

  it("rejects documents from a newer schema", () => {
    const doc = { ...createSampleDocument(), schemaVersion: SCHEMA_VERSION + 1 };
    expect(() => migrateDocument(doc)).toThrow(ValidationError);
  });

  it("enforces household shape", () => {
    const bad = Household.safeParse({
      id: "h",
      name: "x",
      planningMode: "couple",
      people: [{ id: "a", name: "A", role: "primary", birthMonth: "1990-01" }],
      location: { country: "GB" },
      currency: "GBP",
      locale: "en-GB",
    });
    expect(bad.success).toBe(false);
  });

  it("exposes JSON schema for every top-level entity (API/MCP contract)", async () => {
    const { z } = await import("zod");
    const json = z.toJSONSchema(GlideworthDocument, { io: "input", unrepresentable: "any" });
    const text = JSON.stringify(json);
    expect(text).toContain('"plans"');
    expect(text).toContain('"Plan"');
  });
});
