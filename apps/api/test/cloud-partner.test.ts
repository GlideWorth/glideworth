/**
 * A partner with view-only access in cloud mode (workspace members are managed by `@glideworth/cloud`): the
 * viewer's API key is refused on every write route (the session case is in cloud-entitlements.test.ts), an OAuth
 * consent with every scope ticked yields read-only scopes and read-only MCP tools, the partner summary is theirs
 * to read, and removing them from the workspace ends their session, key and OAuth token at once.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootCloud, Client, type Cloud, oauthTokens, reauth } from "./cloud-harness.js";
import { seedWorkspace, type Workspace } from "./cloud-workspaces.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let cloud: Cloud;
let W: Workspace;
let viewerOAuth: string;

beforeAll(async () => {
  cloud = await bootCloud();
  W = await seedWorkspace(cloud, "Partnerton", 432187.55);
  await reauth(W.owner.browser);
  await W.owner.browser.patch("/api/v1/workspace/settings", { mcpWrites: true });
  viewerOAuth = (await oauthTokens(cloud, W.viewer.browser, W.accountId)).access;
}, 120_000);
afterAll(() => cloud?.close(), 120_000);

const mcp = (token: string, method: string, params: Record<string, unknown> = {}) =>
  new Client(cloud)
    .withBearer(token)
    .post(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method, params },
      { headers: { accept: "application/json, text/event-stream" } },
    );

describe("a cloud viewer", () => {
  it("their API key is refused on every write route of the OpenAPI document", async () => {
    const doc = (await (await fetch(`${cloud.base}/openapi.json`)).json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const k = new Client(cloud).withBearer(W.viewerKey);
    let n = 0;
    for (const [path, item] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(item)) {
        if (op["x-required-scope"] !== "write" && op["x-required-role"] !== "owner") continue;
        const url = path.replace(/\{(\w+)\}/g, (_, p: string) =>
          p === "id" && path.startsWith("/api/v1/plans/")
            ? "plan-main"
            : p === "id" && path.startsWith("/api/v1/households/")
              ? "hh-sample"
              : p === "version"
                ? "1"
                : "missing-id",
        );
        const r = await k.req(method.toUpperCase(), url, method === "get" ? {} : { body: {} });
        expect(r.status, `${method} ${path}: ${r.text.slice(0, 120)}`).toBe(403);
        n++;
      }
    expect(n).toBeGreaterThan(100);
  });

  it("an OAuth grant with every scope ticked is read-only, and so are its MCP tools", async () => {
    const names = async (token: string) =>
      ((await mcp(token, "tools/list")).json.result.tools as Array<{ name: string }>).map(
        (t) => t.name,
      );
    const tools = await names(viewerOAuth);
    expect(tools.length).toBeGreaterThan(30);
    // The viewer lacks exactly the write-scope tools the owner has. readOnlyHint is not the test: the tools that
    // start a calculation are not marked read-only, and a viewer may run them.
    const ownerOAuth = (await oauthTokens(cloud, W.owner.browser, W.accountId)).access;
    const lacking = (await names(ownerOAuth)).filter((n) => !tools.includes(n));
    expect(lacking).toEqual(
      expect.arrayContaining([
        "apply_change_set",
        "propose_change_set",
        "update_account_balances",
        "create_share_link",
      ]),
    );
    expect(lacking).toHaveLength(19);
    const r = await mcp(viewerOAuth, "tools/call", {
      name: "apply_change_set",
      arguments: { changeSetId: W.ids.changeSet },
    });
    expect(r.json.error ?? r.json.result?.isError).toBeTruthy();
  });

  it("reads the partner summary of their workspace", async () => {
    const r = await W.viewer.browser.get("/api/v1/plans/plan-main/partner-summary");
    expect(r.status, r.text).toBe(200);
    expect(r.json.planId).toBe("plan-main");
    expect(r.json.headline).toEqual(expect.any(String));
    const viaMcp = await mcp(viewerOAuth, "tools/call", {
      name: "get_partner_summary",
      arguments: {},
    });
    expect(viaMcp.json.result.isError).toBeFalsy();
  });

  it("removal from the workspace ends their session, API key and OAuth token at once", async () => {
    const before = [
      (await W.viewer.browser.get("/api/v1/plans")).status,
      (await new Client(cloud).withBearer(W.viewerKey).get("/api/v1/plans")).status,
      (await mcp(viewerOAuth, "tools/list")).status,
    ];
    expect(before).toEqual([200, 200, 200]);
    await reauth(W.owner.browser);
    const rm = await W.owner.browser.req(
      "DELETE",
      `/api/v1/workspace/members/${W.ids.viewerUserId}`,
      {},
    );
    expect(rm.status, rm.text).toBe(204);
    expect([401, 403]).toContain((await W.viewer.browser.get("/api/v1/plans")).status);
    expect((await new Client(cloud).withBearer(W.viewerKey).get("/api/v1/plans")).status).toBe(401);
    expect((await mcp(viewerOAuth, "tools/list")).status).toBe(401);
  });
});
