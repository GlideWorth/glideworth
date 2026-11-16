import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, READ_KEY, SIM_KEY, setup, WRITE_KEY } from "./helpers.js";

type Operation = {
  operationId?: string;
  security?: unknown[];
  parameters?: { name: string; in: string }[];
  responses?: Record<string, unknown>;
  tags?: string[];
  "x-required-scope"?: "read" | "simulate" | "write";
};
type Doc = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
};

let h: Harness;
let doc: Doc;
beforeAll(async () => {
  h = setup();
  doc = (await h.call<Doc>("/openapi.json", { key: null })).json;
});
afterAll(() => h.close());

const METHODS = ["get", "post", "put", "patch", "delete"];
const allOperations = () =>
  Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([m]) => METHODS.includes(m))
      .map(([method, op]) => ({ path, method, op })),
  );
/** Browser sign-in routes are public by design (they are how a session is obtained). */
const isAuthRoute = (path: string) =>
  path.startsWith("/api/v1/auth/") || path.startsWith("/api/v1/shared/");
const operations = () => allOperations().filter((o) => !isAuthRoute(o.path));

describe("OpenAPI 3.1 document", () => {
  it("is a well-formed 3.1 document", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Glideworth API");
    expect(doc.components.securitySchemes.bearer).toMatchObject({ type: "http", scheme: "bearer" });
    expect(operations().length).toBeGreaterThan(150);
  });

  it("every $ref resolves", () => {
    const missing: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (k === "$ref" && typeof x === "string") {
            const target = x
              .replace(/^#\//, "")
              .split("/")
              .reduce<unknown>((o, seg) => (o as Record<string, unknown> | undefined)?.[seg], doc);
            if (target === undefined) missing.push(x);
          } else walk(x);
        }
      }
    };
    walk(doc);
    expect(missing).toEqual([]);
  });

  it("operations have unique ids, declared path params, responses, security and a required scope", () => {
    const ids = new Set<string>();
    const problems: string[] = [];
    for (const { path, method, op } of operations()) {
      const where = `${method.toUpperCase()} ${path}`;
      if (!op.operationId) problems.push(`${where}: no operationId`);
      else if (ids.has(op.operationId))
        problems.push(`${where}: duplicate operationId ${op.operationId}`);
      else ids.add(op.operationId);
      if (!op.responses || !Object.keys(op.responses).some((c) => c.startsWith("2")))
        problems.push(`${where}: no 2xx response`);
      if (!op.security?.length) problems.push(`${where}: no security`);
      if (!op["x-required-scope"]) problems.push(`${where}: no x-required-scope`);
      if (!op.tags?.length) problems.push(`${where}: no tags`);
      for (const [, name] of path.matchAll(/\{(\w+)\}/g))
        if (!op.parameters?.some((p) => p.in === "path" && p.name === name))
          problems.push(`${where}: path param ${name} not declared`);
    }
    expect(problems).toEqual([]);
  });

  it("documents 100% of the registered /api routes (including the SSE stream)", () => {
    const documented = new Set(
      allOperations().map(({ path, method }) => `${method.toUpperCase()} ${path}`),
    );
    const registered = h.app.routes
      .filter((r) => r.path.startsWith("/api/") && r.method !== "ALL")
      .map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, "{$1}")}`);
    const undocumented = [...new Set(registered)].filter((r) => !documented.has(r));
    expect(undocumented).toEqual([]);
    expect(documented.has("GET /api/v1/jobs/{id}/events")).toBe(true);
  });

  it("covers every route group in the checklist", () => {
    const paths = Object.keys(doc.paths).join("\n");
    for (const needle of [
      "/api/v1/households",
      "/accounts",
      "/real-assets",
      "/debts",
      "/people",
      "/balances",
      "/snapshots/bulk",
      "/export",
      "/api/v1/import",
      "/api/v1/plans",
      "/income",
      "/expenses",
      "/milestones",
      "/flows",
      "/assumptions",
      "/tax-settings",
      "/withdrawal-strategy",
      "/duplicate",
      "/archive",
      "/branches",
      "/merge",
      "/versions",
      "/restore",
      "/simulate",
      "/monte-carlo",
      "/historical",
      "/solve/max-spending",
      "/solve/earliest-retirement",
      "/solve/required-savings",
      "/solve/goal-seek",
      "/insights/explain",
      "/insights/audit",
      "/insights/sensitivity",
      "/insights/guardrails",
      "/insights/compare",
      "/tax-breakdown",
      "/jobs",
      "/change-sets",
      "/settings",
      "/keys",
      "/webhooks",
    ])
      expect(paths, needle).toContain(needle);
  });

  it("exposes the core schemas as named components and the error envelope on every operation", () => {
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining([
        "Plan",
        "ProjectionResult",
        "Household",
        "Error",
        "Job",
        "ChangeSetView",
        "MonteCarloResult",
      ]),
    );
    for (const { path, method, op } of operations())
      expect(op.responses, `${method} ${path}`).toHaveProperty("400");
  });

  it("the only public API operations are the browser sign-in routes and the share-link read", () => {
    const auth = allOperations().filter((o) => isAuthRoute(o.path));
    expect(auth.map((o) => `${o.method} ${o.path}`).sort()).toEqual([
      "get /api/v1/auth/status",
      "get /api/v1/shared/{token}",
      "post /api/v1/auth/accept",
      "post /api/v1/auth/change-passphrase",
      "post /api/v1/auth/login",
      "post /api/v1/auth/logout",
      "post /api/v1/auth/logout-all",
      "post /api/v1/auth/setup",
    ]);
    for (const o of auth)
      expect(o.op.tags).toContain(o.path.startsWith("/api/v1/shared/") ? "Share links" : "Auth");
  });

  it("write operations document the Idempotency-Key header", () => {
    const op = doc.paths["/api/v1/plans"]!.post!;
    expect(op.parameters?.some((p) => p.name === "idempotency-key")).toBe(true);
  });
});

describe("scope enforcement on every operation", () => {
  const sub = (p: string) => p.replace(/\{\w+\}/g, "x");
  const status = async (method: string, path: string, key: string) =>
    (
      await h.call(sub(path), {
        method: method.toUpperCase(),
        key,
        ...(method === "get" ? {} : { body: {} }),
      })
    ).status;

  it("read keys cannot hit write operations; simulate keys cannot hit read or write operations", async () => {
    const failures: string[] = [];
    for (const { path, method, op } of operations()) {
      const need = op["x-required-scope"]!;
      const where = `${method.toUpperCase()} ${path} (needs ${need})`;
      const read = await status(method, path, READ_KEY);
      const sim = await status(method, path, SIM_KEY);
      const write = await status(method, path, WRITE_KEY);
      if (write === 403) failures.push(`${where}: write key got 403`);
      if (need === "write" && read !== 403) failures.push(`${where}: read key allowed (${read})`);
      if (need === "write" && sim !== 403) failures.push(`${where}: simulate key allowed (${sim})`);
      if (need === "read" && sim !== 403) failures.push(`${where}: simulate key allowed (${sim})`);
      if (need === "read" && read === 403 && !(op as Record<string, unknown>)["x-session-or-write"])
        failures.push(`${where}: read key denied`);
      if (need === "simulate" && (read === 403 || sim === 403))
        failures.push(`${where}: compute denied for read/simulate key`);
    }
    expect(failures).toEqual([]);
  });

  it("every operation requires authentication", async () => {
    const open: string[] = [];
    for (const { path, method } of operations()) {
      const r = await h.call(sub(path), {
        method: method.toUpperCase(),
        key: null,
        ...(method === "get" ? {} : { body: {} }),
      });
      if (r.status !== 401) open.push(`${method} ${path} -> ${r.status}`);
    }
    expect(open).toEqual([]);
  });
});
