/**
 * The consent page's write box says what ticking it does, and does it (hosted mode):
 *   - an owner whose workspace does not allow AI assistants to make changes sees that ticking write turns that on
 *     (and for everyone, when others share the workspace); the box is not pre-ticked, and granting write turns
 *     the switch on, so the app gets its write tools at once;
 *   - an owner who does not grant write leaves the switch off;
 *   - an editor sees that the owner has not allowed changes yet, and their grant does not turn the switch on;
 *   - a viewer's write box is disabled.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addMember,
  bootCloud,
  Client,
  type Cloud,
  oauthTokens,
  PUBLIC_URL,
  signUp,
  markedSample,
} from "./cloud-harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let cloud: Cloud;
beforeAll(async () => {
  cloud = await bootCloud();
}, 120_000);
afterAll(async () => {
  await cloud?.close();
}, 120_000);

/** The consent page a signed-in browser sees for a client asking for every scope. */
async function consentPage(b: Client): Promise<string> {
  const reg = await new Client(cloud).post("/oauth/register", {
    client_name: "Consent test client",
    redirect_uris: ["http://127.0.0.1:9/callback"],
    token_endpoint_auth_method: "none",
  });
  expect(reg.status, reg.text).toBe(201);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: reg.json.client_id as string,
    redirect_uri: "http://127.0.0.1:9/callback",
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
    scope: "read simulate write",
    state: "s1",
    resource: `${PUBLIC_URL}/mcp`,
    _r: "1",
  });
  const page = await b.get(`/oauth/authorize?${q}`);
  expect(page.status, page.text.slice(0, 300)).toBe(200);
  return page.text;
}

const writeBox = (html: string) =>
  /<input type="checkbox" name="grant" value="write"[^>]*>/.exec(html)?.[0] ?? "";

const mcpTools = async (token: string): Promise<string[]> => {
  const r = await new Client(cloud)
    .withBearer(token)
    .post(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { headers: { accept: "application/json, text/event-stream" } },
    );
  expect(r.status, r.text).toBe(200);
  return (r.json.result.tools as Array<{ name: string }>).map((t) => t.name);
};

const changesAllowed = async (b: Client): Promise<boolean> =>
  (await b.get("/api/v1/workspace/settings")).json.mcpWrites === true;

describe("consent and the workspace's AI changes switch", () => {
  it("an owner's write grant turns the switch on; without write it stays off", async () => {
    const o = await signUp(cloud, { name: "Solo Owner" });
    const accountId = o.accountId as string;
    await o.browser.post("/api/v1/import", { data: markedSample("SoloWs", 2222) });

    const html = await consentPage(o.browser);
    expect(html).toContain(
      "Ticking this also allows AI assistants to make changes in this workspace. You can turn that off in Workspace settings.",
    );
    expect(html).not.toContain("for everyone in it");
    expect(writeBox(html)).not.toContain("checked");

    // Read and simulate only: the switch stays off and no write tools appear.
    const ro = await oauthTokens(cloud, o.browser, accountId, "read simulate");
    expect(await changesAllowed(o.browser)).toBe(false);
    expect(await mcpTools(ro.access)).not.toContain("apply_change_set");

    // Granting write is the owner's decision to allow changes: the app gets its write tools at once.
    const rw = await oauthTokens(cloud, o.browser, accountId, "read simulate write");
    expect(await changesAllowed(o.browser)).toBe(true);
    expect(await mcpTools(rw.access)).toContain("apply_change_set");

    // Now changes are allowed, write is pre-ticked and needs no note.
    const after = await consentPage(o.browser);
    expect(writeBox(after)).toContain("checked");
    expect(after).not.toContain("Ticking this also allows");
  });

  it("a shared workspace: the owner is told it is for everyone; an editor waits; a viewer cannot", async () => {
    const o = await signUp(cloud, { name: "Shared Owner" });
    const accountId = o.accountId as string;
    await o.browser.post("/api/v1/import", { data: markedSample("SharedWs", 3333) });
    const ed = await addMember(cloud, o.browser, accountId, "editor", "Shared Editor");
    const vw = await addMember(cloud, o.browser, accountId, "viewer", "Shared Viewer");

    expect(await consentPage(o.browser)).toContain(
      "Ticking this also allows AI assistants to make changes in this workspace, for everyone in it.",
    );

    const edPage = await consentPage(ed.browser);
    expect(edPage).toContain(
      "Your workspace owner hasn't allowed AI assistants to make changes yet.",
    );
    // The editor's write grant does not turn the switch on; it works once the owner allows changes.
    const et = await oauthTokens(cloud, ed.browser, accountId, "read simulate write");
    expect(await changesAllowed(o.browser)).toBe(false);
    expect(await mcpTools(et.access)).not.toContain("apply_change_set");

    const vwPage = await consentPage(vw.browser);
    expect(writeBox(vwPage)).toContain("disabled");
    expect(vwPage).toContain("Not available: viewers can't make changes.");
  });
});
