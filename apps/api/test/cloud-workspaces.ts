/**
 * Two fully populated workspaces for the cloud isolation and entitlement tests: an owner, an editor and a viewer
 * each, the synthetic sample (renamed and re-figured with a recognisable marker), and at least one resource of
 * every kind (extra household, duplicated plan, change set, job, webhook, share link, snapshot, notification,
 * API keys for every member, an OAuth grant, a pending invitation, an export, a support grant).
 */
import { createSampleDocument } from "@glideworth/core/samples";
import {
  addMember,
  apiKey,
  type Client,
  type Cloud,
  markedSample,
  oauthTokens,
  reauth,
  signUp,
  uniqueEmail,
} from "./cloud-harness.js";

export interface Workspace {
  marker: string;
  amount: number;
  accountId: string;
  owner: Awaited<ReturnType<typeof signUp>>;
  editor: Awaited<ReturnType<typeof addMember>>;
  viewer: Awaited<ReturnType<typeof addMember>>;
  ownerKey: string;
  editorKey: string;
  viewerKey: string;
  oauth: Awaited<ReturnType<typeof oauthTokens>>;
  /** Resource ids that exist only in this workspace. */
  ids: {
    household: string;
    plan: string;
    changeSet: string;
    job: string;
    webhook: string;
    shareLink: string;
    shareToken: string;
    snapshot: string;
    notification: string | null;
    ownerKeyId: string;
    editorKeyId: string;
    grant: string;
    oauthClient: string;
    invitation: string;
    exportId: string;
    supportGrant: string;
    session: string;
    editorTenantUserId: string;
    editorUserId: string;
    viewerUserId: string;
  };
  /** Strings that must never appear in another workspace's responses. */
  secrets: string[];
}

const ok = <T extends { status: number; text: string }>(r: T, what: string): T => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`);
  return r;
};

export async function seedWorkspace(
  cloud: Cloud,
  marker: string,
  amount: number,
): Promise<Workspace> {
  const owner = await signUp(cloud, { name: `${marker} Owner` });
  const accountId = owner.accountId as string;
  const b: Client = owner.browser;
  ok(await b.post("/api/v1/import", { data: fewTrials(markedSample(marker, amount)) }), "import");
  const editor = await addMember(cloud, b, accountId, "editor", `${marker} Editor`);
  const viewer = await addMember(cloud, b, accountId, "viewer", `${marker} Viewer`);
  const ownerKey = await apiKey(b);
  const editorKey = await apiKey(editor.browser);
  const viewerKey = await apiKey(viewer.browser, ["read"]);
  const k = b.withBearer(ownerKey);

  const sample = createSampleDocument() as unknown as {
    household: Record<string, unknown>;
    finances: Record<string, unknown>;
  };
  const hhId = `hh-${marker.toLowerCase()}-2`;
  ok(
    await k.post("/api/v1/households", {
      household: {
        ...sample.household,
        id: hhId,
        name: `${marker} Second Household`,
      },
      finances: sample.finances,
    }),
    "household",
  );
  const dup = ok(
    await k.post("/api/v1/plans/plan-main/duplicate", { name: `${marker} Private Plan` }),
    "duplicate",
  );
  const plan = dup.json.id as string;
  const cs = ok(
    await k.post(`/api/v1/plans/${plan}/change-sets`, {
      ops: [{ op: "replace", path: "/name", value: `${marker} Proposed Name` }],
      summary: `${marker} rename`,
      preview: false,
    }),
    "change set",
  );
  const job = ok(await k.post(`/api/v1/plans/${plan}/monte-carlo?wait=5`, {}), "job");
  const wh = ok(
    await k.post("/api/v1/webhooks", {
      url: `https://hooks.${marker.toLowerCase()}.example/receive`,
      events: ["plan.updated", "simulation.completed"],
      description: `${marker} hook`,
    }),
    "webhook",
  );
  const share = ok(
    await k.post(`/api/v1/plans/${plan}/share-links`, {
      label: `${marker} share`,
      includeSuccessRate: false,
    }),
    "share",
  );
  const snap = ok(
    await k.post(`/api/v1/households/${hhId}/snapshots/record`, { note: `${marker} note` }),
    "snapshot",
  );
  // A check-in (health record + possibly notifications).
  ok(await k.post(`/api/v1/plans/${plan}/checkins`, {}), "checkin");
  const notes = await k.get("/api/v1/notifications");
  const oauth = await oauthTokens(cloud, b, accountId);
  const grants = ok(await b.get("/api/v1/me/oauth-grants"), "grants");
  const keys = ok(await k.get("/api/v1/keys"), "keys");
  await reauth(b);
  const inv = ok(
    await b.post("/api/v1/workspace/invitations", {
      email: uniqueEmail("pending"),
      role: "viewer",
    }),
    "invitation",
  );
  const exp = ok(await b.post("/api/v1/workspace/export", {}), "export");
  const grant = ok(
    await b.post("/api/v1/workspace/support-grants", { reason: "help with import", days: 1 }),
    "support grant",
  );
  const sessions = ok(await b.get("/api/v1/account/sessions"), "sessions");
  const members = ok(await b.get("/api/v1/workspace/members"), "members");
  await cloud.rt.accounts.settled();
  await cloud.rt.outbox.drain();

  const keyItems = keys.json.items as Array<{ id: string; userId: string | null; name: string }>;
  const memberList = (members.json.items ?? members.json) as Array<{
    userId: string;
    tenantUserId?: string;
    role: string;
  }>;
  const editorMember = memberList.find((m) => m.role === "editor");
  const viewerMember = memberList.find((m) => m.role === "viewer");
  const ownerKeyPrefix = ownerKey.split("_")[2];
  const editorKeyPrefix = editorKey.split("_")[2];
  return {
    marker,
    amount,
    accountId,
    owner,
    editor,
    viewer,
    ownerKey,
    editorKey,
    viewerKey,
    oauth,
    ids: {
      household: hhId,
      plan,
      changeSet: cs.json.id,
      job: job.json.id,
      webhook: wh.json.id,
      shareLink: share.json.link.id,
      shareToken: share.json.token,
      snapshot: snap.json.id,
      notification: (notes.json?.items?.[0]?.id as string | undefined) ?? null,
      ownerKeyId: `key_${ownerKeyPrefix}`,
      editorKeyId: `key_${editorKeyPrefix}`,
      grant: grants.json.items[0].id,
      oauthClient: oauth.clientId,
      invitation: inv.json.id,
      exportId: exp.json.exportId,
      supportGrant: grant.json.id,
      session: (sessions.json.items ?? sessions.json)[0].id,
      editorTenantUserId: editorMember?.tenantUserId ?? "",
      editorUserId: editorMember?.userId ?? editor.userId,
      viewerUserId: viewerMember?.userId ?? viewer.userId,
    },
    secrets: [
      marker,
      String(amount),
      ownerKey,
      editorKey,
      viewerKey,
      oauth.access,
      oauth.refresh,
      share.json.token,
      owner.email,
      editor.email,
      viewer.email,
      plan,
      cs.json.id,
      job.json.id,
      wh.json.id,
      share.json.link.id,
      hhId,
      ...keyItems.map((x) => x.id),
    ],
  };
}

/** Every row of every table of a workspace database (equality = nothing changed). */
export async function dumpTenant(cloud: Cloud, accountId: string): Promise<string> {
  return cloud.rt.registry.with(accountId, (r) => {
    const raw = (r.db as unknown as { $client: import("better-sqlite3").Database }).$client;
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    return JSON.stringify(
      tables.map((t) => [t.name, raw.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()]),
    );
  });
}

/**
 * Monte Carlo trials in the seeded plans. The isolation sweep calls every operation and MCP tool, and the
 * analysis ones run for real on the caller's own plan; at the default 1000 trials that simulating took about
 * 90% of cloud-isolation.test.ts (157 s against 15 s). Isolation does not depend on the trial count.
 */
const SEED_TRIALS = 50;

/** Sets every Monte Carlo `trials` in the document to SEED_TRIALS. */
function fewTrials<T>(doc: T): T {
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.trials === "number") o.trials = SEED_TRIALS;
      Object.values(o).forEach(walk);
    }
  };
  walk(doc);
  return doc;
}
