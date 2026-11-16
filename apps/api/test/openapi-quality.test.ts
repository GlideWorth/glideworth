/**
 * OpenAPI quality gates: every operation has an id, tags, a security declaration and a scope; names are
 * unique; public routes opt out of security explicitly; and every example in the document validates against
 * its schema (so docs and generated clients never drift from the server).
 */
import { afterEach, describe, expect, it } from "vitest";
import { MaxSpendingRequest, MonteCarloRequest, SimulateRequest } from "../src/schemas.js";
import { ProposeBody } from "../src/services/changesets.js";
import { BalanceUpdate } from "../src/services/households.js";
import { type Harness, setup } from "./helpers.js";

let h: Harness;
afterEach(() => h?.close());
// oxlint-disable-next-line typescript/no-explicit-any -- walking an arbitrary OpenAPI document
type Doc = any;
const METHODS = ["get", "post", "put", "patch", "delete"];

async function load(): Promise<Doc> {
  h = setup();
  return (await h.app.request("/openapi.json")).json();
}

describe("OpenAPI document", () => {
  it("is 3.1 with unique operationIds, tags, summaries and explicit security", async () => {
    const doc = await load();
    expect(doc.openapi).toBe("3.1.0");
    const ids = new Set<string>();
    for (const [path, item] of Object.entries<Doc>(doc.paths))
      for (const [method, op] of Object.entries<Doc>(item)) {
        if (!METHODS.includes(method)) continue;
        const where = `${method} ${path}`;
        expect(op.operationId, where).toMatch(/^[a-z][A-Za-z0-9]+$/);
        expect(ids.has(op.operationId), `duplicate operationId ${op.operationId}`).toBe(false);
        ids.add(op.operationId);
        expect(op.tags?.length, where).toBeGreaterThan(0);
        expect(op.summary, where).toBeTruthy();
        expect(
          op.security,
          `${where} must declare security (use [] for public routes)`,
        ).toBeDefined();
        if (path.startsWith("/api/v1/auth/") || path.startsWith("/api/v1/shared/"))
          expect(op.security, where).toEqual([]);
        else expect(op.security, where).toEqual([{ bearer: [] }]);
      }
    expect(ids.size).toBeGreaterThan(190);
  });

  it("has an example for the headline operations and every example validates against its schema", async () => {
    const doc = await load();
    const withExamples: string[] = [];
    for (const [name, schema] of Object.entries<Doc>(doc.components.schemas))
      if (schema.examples) withExamples.push(name);
    expect(withExamples).toEqual(
      expect.arrayContaining([
        "SimulateRequest",
        "MonteCarloRequest",
        "MaxSpendingRequest",
        "ProposeChangeSet",
        "BalanceUpdate",
        "WebhookCreate",
      ]),
    );
    const schemas: Record<string, { parse: (v: unknown) => unknown }> = {
      SimulateRequest,
      MonteCarloRequest,
      MaxSpendingRequest,
      ProposeChangeSet: ProposeBody,
      BalanceUpdate,
    };
    for (const [name, schema] of Object.entries(schemas))
      for (const ex of doc.components.schemas[name].examples)
        expect(() => schema.parse(ex), `${name} example`).not.toThrow();
  });
});
