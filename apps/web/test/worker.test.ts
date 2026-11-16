import { buildSimulationInput, NotImplementedError } from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import { errorPayload } from "../src/features/chance/mc-handle";
import { ApiRequestError, createApiClient } from "../src/lib/api";
import { handleRequest } from "../src/workers/handle";
import { runSimulation } from "../src/workers/sim-client";

describe("simulation worker harness", () => {
  const doc = createSampleDocument();
  it("runs the engine and returns a projection", () => {
    const res = handleRequest({
      id: 1,
      kind: "simulate",
      input: buildSimulationInput(doc, "plan-main"),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.periods.length).toBeGreaterThan(10);
  });
  it("serialises NotImplemented errors with feature + workstream (synthetic error)", () => {
    const payload = errorPayload(new NotImplementedError("example.feature", "z", "synthetic"));
    expect(payload).toMatchObject({
      name: "NotImplementedError",
      code: "NOT_IMPLEMENTED",
      feature: "example.feature",
      workstream: "z",
    });
  });
  it("serialises plain errors without a code", () => {
    expect(errorPayload(new Error("boom"))).toEqual({ name: "Error", message: "boom" });
  });
  it("falls back to inline execution without Worker support", async () => {
    const { result } = await runSimulation(buildSimulationInput(doc, "plan-early"));
    expect(result.meta.planId).toBe("plan-early");
  });
});

describe("api client", () => {
  it("validates responses with the shared Zod schemas", async () => {
    const doc = createSampleDocument();
    const client = createApiClient({
      fetch: async () =>
        new Response(JSON.stringify(doc.plans[0]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const plan = await client.getPlan("plan-main");
    expect(plan.name).toBe("Main plan");
  });
  it("surfaces typed API errors", async () => {
    const client = createApiClient({
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "nope" } }), {
          status: 404,
        }),
    });
    await expect(client.getPlan("x")).rejects.toBeInstanceOf(ApiRequestError);
  });
});
