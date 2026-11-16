/**
 * T-BACKUP (spec 7, 10): encrypted backups, restore equality, tamper refusal, tenant binding, crypto-shredding,
 * retention, the restore test, control-plane backup and restore, and the S3 store's request shapes.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackupIntegrityError, openStream, sealStream } from "../src/backups/envelope.js";
import { KeyUnavailableError, unwrapDataKey, wrapDataKey } from "../src/backups/keys.js";
import { type S3Module, s3ObjectStore } from "../src/backups/object-store.js";
import { restoreControlPlane } from "../src/backups/service.js";
import { accounts, backups, tenantKeys } from "../src/control/schema.js";
import { CloudError } from "../src/errors.js";
import { controlDbPath } from "../src/tenancy/paths.js";
import { tableDigests } from "../src/tenancy/sqlite-tools.js";
import {
  type Cloud,
  type FakeRuntime,
  makeCloud,
  removeTempDirs,
  SENTINEL_AMOUNT,
  SENTINEL_HOUSEHOLD,
  signedUpBrowser,
} from "./cloud-fixture.js";
import { testLog } from "./helpers.js";

let cloud: Cloud;
beforeEach(async () => {
  cloud = await makeCloud();
});
afterEach(async () => {
  await cloud.close();
  removeTempDirs();
});

async function tenantWithData(n = 25) {
  const { accountId } = await signedUpBrowser(cloud);
  const id = accountId as string;
  await cloud.registry.with(id, (r) => {
    const rt = r as FakeRuntime;
    rt.addHousehold("hh_main", SENTINEL_HOUSEHOLD, Number(SENTINEL_AMOUNT));
    for (let i = 0; i < n; i++) rt.addHousehold(`hh_${i}`, `H${i}`, i * 1000.5);
  });
  return id;
}

const collect = async (it: AsyncIterable<Buffer>) => {
  const parts: Buffer[] = [];
  for await (const c of it) parts.push(c);
  return Buffer.concat(parts);
};
const header = {
  v: 1 as const,
  tenant: "tabcdefghijklmno",
  schemaVersion: 2,
  createdAt: "2026-11-16T10:00:00.000Z",
  kekId: "k",
};

describe("envelope", () => {
  const key = new Uint8Array(randomBytes(32));
  const plain = randomBytes(200 * 1024 + 17); // four frames

  it("round-trips across frame boundaries", async () => {
    const sealed = await collect(sealStream(Readable.from([plain]), key, header));
    expect(sealed.subarray(0, 4).toString()).toBe("GWB1");
    const back = await collect(openStream(Readable.from([sealed]), key, { tenant: header.tenant }));
    expect(back.equals(plain)).toBe(true);
  });

  it("refuses a flipped bit, truncation, an extra frame, a wrong key and another tenant’s header", async () => {
    const sealed = await collect(sealStream(Readable.from([plain]), key, header));
    const attempt = (buf: Buffer, k = key, tenant = header.tenant) =>
      collect(openStream(Readable.from([buf]), k, { tenant })).then(
        () => "opened",
        (e: unknown) => (e instanceof BackupIntegrityError ? e.reason : "other"),
      );
    const flipped = Buffer.from(sealed);
    flipped.writeUInt8((flipped.readUInt8(flipped.length - 100) ^ 1) & 0xff, flipped.length - 100);
    expect(await attempt(flipped)).toBe("authentication failed");
    // Cut at a frame boundary: the remaining last frame was not sealed as final.
    const frame = 4 + 64 * 1024 + 16;
    const headerLen = 8 + sealed.readUInt32BE(4) + 12;
    expect(await attempt(sealed.subarray(0, headerLen + frame))).toBe("authentication failed");
    expect(await attempt(sealed.subarray(0, sealed.length - 5))).toBe("truncated");
    expect(
      await attempt(Buffer.concat([sealed, sealed.subarray(headerLen, headerLen + frame)])),
    ).toBe("authentication failed");
    expect(await attempt(sealed, new Uint8Array(randomBytes(32)))).toBe("authentication failed");
    expect(await attempt(sealed, key, "tbbbbbbbbbbbbbbb")).toBe("backup belongs to another tenant");
    // Rewriting the header to claim another tenant breaks authentication of every frame.
    const forged = Buffer.from(
      sealed.toString("latin1").replace(header.tenant, "tbbbbbbbbbbbbbbb"),
      "latin1",
    );
    expect(await attempt(forged, key, "tbbbbbbbbbbbbbbb")).toBe("authentication failed");
  });

  it("data keys are bound to their tenant and KEK", () => {
    const kek = { id: "k1", key: new Uint8Array(randomBytes(32)) };
    const dek = new Uint8Array(randomBytes(32));
    const w = wrapDataKey(dek, "taaaaaaaaaaaaaaa", kek);
    expect(
      Buffer.from(unwrapDataKey(w, "taaaaaaaaaaaaaaa", "k1", kek)).equals(Buffer.from(dek)),
    ).toBe(true);
    expect(() => unwrapDataKey(w, "tbbbbbbbbbbbbbbb", "k1", kek)).toThrow(KeyUnavailableError);
    expect(() => unwrapDataKey(w, "taaaaaaaaaaaaaaa", "k2", kek)).toThrow(KeyUnavailableError);
    expect(() => unwrapDataKey(null, "taaaaaaaaaaaaaaa", "k1", kek)).toThrow(/destroyed/);
  });
});

describe("tenant backups and restore", () => {
  it("backs up only changed tenants; the object is encrypted (no plaintext figures in the bucket)", async () => {
    const id = await tenantWithData();
    const first = await cloud.backups.sweep();
    expect(first.backedUp).toBe(1);
    expect((await cloud.backups.sweep()).backedUp).toBe(0);
    const keys = [...cloud.store.objects.keys()];
    expect(keys.some((k) => k.startsWith(`test/tenants/${id}/`))).toBe(true);
    expect(keys).toContain(`test/keys/${id}.key`);
    for (const [, body] of cloud.store.objects) {
      expect(body.includes(Buffer.from(SENTINEL_HOUSEHOLD))).toBe(false);
      expect(body.includes(Buffer.from("SQLite format 3"))).toBe(false);
    }
    expect(readdirSync(resolve(cloud.dataDir, "staging"))).toEqual([]);
  });

  it("a write right after a backup is never skipped by the next sweep", async () => {
    const id = await tenantWithData();
    expect((await cloud.backups.sweep()).backedUp).toBe(1);
    expect((await cloud.backups.sweep()).backedUp).toBe(0);
    // No pause: file-system timestamps may not even tick between the backup and this write.
    await cloud.registry.with(id, (r) => (r as FakeRuntime).addHousehold("hh_late", "Late", 1));
    expect((await cloud.backups.sweep()).backedUp).toBe(1);
    expect((await cloud.backups.sweep()).backedUp).toBe(0);
  });

  it("restore equals the source (row counts and a checksum of every table), keeps the previous file", async () => {
    const id = await tenantWithData(40);
    const source = tableDigests(cloud.registry.pathFor(id));
    await cloud.backups.backupTenant(id);
    // Damage after the backup.
    await cloud.registry.with(id, (r) => (r as FakeRuntime).db.exec("DELETE FROM households"));
    const r = await cloud.backups.restoreTenant(id, { operatorId: "op_test" });
    expect(r.previous && existsSync(r.previous)).toBe(true);
    expect(tableDigests(cloud.registry.pathFor(id))).toEqual(source);
    const rows = await cloud.registry.with(id, (rt) => (rt as FakeRuntime).households());
    expect(rows.find((h) => h.id === "hh_main")?.name).toBe(SENTINEL_HOUSEHOLD);
  });

  it("a tampered object is refused and the live file is untouched", async () => {
    const id = await tenantWithData();
    const { objectKey } = await cloud.backups.backupTenant(id);
    const live = tableDigests(cloud.registry.pathFor(id));
    const body = cloud.store.objects.get(objectKey) as Buffer;
    body.writeUInt8(body.readUInt8(body.length - 40) ^ 0xff, body.length - 40);
    await expect(cloud.backups.restoreTenant(id, { operatorId: "op" })).rejects.toBeInstanceOf(
      BackupIntegrityError,
    );
    expect(tableDigests(cloud.registry.pathFor(id))).toEqual(live);
  });

  it("a backup cannot be restored into another tenant", async () => {
    const a = await tenantWithData();
    const b = await tenantWithData();
    const { objectKey } = await cloud.backups.backupTenant(a);
    // Point B's latest backup record at A's object: the header (and B's key) refuse it.
    await cloud.backups.backupTenant(b);
    const rowB = cloud.db.select().from(backups).where(eq(backups.accountId, b)).get();
    cloud.db
      .update(backups)
      .set({ objectKey: `${objectKey}.copy` })
      .where(eq(backups.id, rowB?.id as string))
      .run();
    cloud.store.objects.set(`${objectKey}.copy`, cloud.store.objects.get(objectKey) as Buffer);
    const liveB = tableDigests(cloud.registry.pathFor(b));
    await expect(cloud.backups.restoreTenant(b, { operatorId: "op" })).rejects.toBeInstanceOf(
      BackupIntegrityError,
    );
    expect(tableDigests(cloud.registry.pathFor(b))).toEqual(liveB);
  });

  it("restore at a time picks the newest backup at or before it", async () => {
    const id = await tenantWithData(1);
    await cloud.backups.backupTenant(id);
    const t1 = cloud.now().toISOString();
    cloud.advance(60_000);
    await cloud.registry.with(id, (r) => (r as FakeRuntime).addHousehold("hh_later", "Later", 1));
    await cloud.backups.backupTenant(id);
    await cloud.backups.restoreTenant(id, { at: t1, operatorId: "op" });
    const rows = await cloud.registry.with(id, (r) => (r as FakeRuntime).households());
    expect(rows.some((h) => h.id === "hh_later")).toBe(false);
    await expect(
      cloud.backups.restoreTenant(id, { at: "2000-01-01T00:00:00Z", operatorId: "op" }),
    ).rejects.toBeInstanceOf(CloudError);
  });
});

describe("crypto-shredding and retention", () => {
  it("shredding destroys the key row and escrow object: every backup becomes unreadable and is deleted", async () => {
    const id = await tenantWithData();
    const { objectKey } = await cloud.backups.backupTenant(id);
    const copy = Buffer.from(cloud.store.objects.get(objectKey) as Buffer); // an attacker's copy of the object
    await cloud.backups.shred(id);
    const k = cloud.db.select().from(tenantKeys).where(eq(tenantKeys.accountId, id)).get();
    expect(k?.wrappedDek).toBeNull();
    expect(k?.destroyedAt).toBeTruthy();
    expect([...cloud.store.objects.keys()].filter((x) => x.includes(id))).toEqual([]);
    cloud.store.objects.set(objectKey, copy);
    cloud.db
      .insert(backups)
      .values({ id: "bk_resurrected", accountId: id, objectKey, bytes: copy.length, sha256: "x" })
      .run();
    await expect(cloud.backups.restoreTenant(id, { operatorId: "op" })).rejects.toBeInstanceOf(
      KeyUnavailableError,
    );
  });

  it("prune keeps everything for 48 h, then the newest per day for 30 days", async () => {
    const id = await tenantWithData(1);
    const base = cloud.now().getTime();
    const day = 86_400_000;
    const insert = (ageMs: number, n: string) =>
      cloud.db
        .insert(backups)
        .values({
          id: `bk_${n}`,
          accountId: id,
          objectKey: `test/tenants/${id}/x/${n}`,
          bytes: 1,
          sha256: "x",
          createdAt: new Date(base - ageMs).toISOString(),
        })
        .run();
    for (const n of ["a", "b", "c", "d", "e", "f", "g"])
      cloud.store.objects.set(`test/tenants/${id}/x/${n}`, Buffer.from("x"));
    insert(3_600_000, "a"); // 1 h: kept
    insert(30 * 3_600_000, "b"); // 30 h: kept
    insert(5 * day, "c"); // day 5, newest of its day: kept
    insert(5 * day + 60_000, "d"); // day 5, older: pruned
    insert(20 * day, "e"); // kept
    insert(31 * day, "f"); // too old: pruned
    insert(40 * day, "g"); // pruned
    expect(await cloud.backups.prune()).toBe(3);
    const left = cloud.db
      .select({ id: backups.id })
      .from(backups)
      .all()
      .map((r) => r.id)
      .sort();
    expect(left).toEqual(["bk_a", "bk_b", "bk_c", "bk_e"]);
    expect(cloud.store.objects.has(`test/tenants/${id}/x/f`)).toBe(false);
  });
});

describe("daily restore test", () => {
  it("verifies the latest backups (sets verified_at) and alerts on a corrupt one", async () => {
    const a = await tenantWithData();
    const b = await tenantWithData();
    await cloud.backups.sweep();
    const ok = await cloud.backups.verifySample(5);
    expect(ok).toEqual({ verified: 2, failed: [] });
    expect(cloud.db.select().from(backups).where(isNull(backups.verifiedAt)).all()).toHaveLength(0);
    const rowB = cloud.db.select().from(backups).where(eq(backups.accountId, b)).get();
    const obj = cloud.store.objects.get(rowB?.objectKey as string) as Buffer;
    obj.writeUInt8(obj.readUInt8(200) ^ 0x01, 200);
    const bad = await cloud.backups.verifySample(5);
    expect(bad.failed).toEqual([b]);
    const { logLines } = await import("./helpers.js");
    expect(logLines.some((l) => l.includes("backup.verify_failed") && l.includes(b))).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("control plane", () => {
  it("control backups carry no tenant data keys; restore-control brings keys back from escrow, never a shredded one", async () => {
    const keep = await tenantWithData(1);
    const gone = await tenantWithData(1);
    await cloud.backups.sweep(); // escrows both keys
    await cloud.backups.backupControl();
    const controlObj = [...cloud.store.objects.entries()].find(([k]) =>
      k.startsWith("test/control/"),
    );
    expect(controlObj).toBeTruthy();
    await cloud.backups.shred(gone);
    await cloud.close();
    const live = controlDbPath(cloud.dataDir);
    const r = await restoreControlPlane({
      store: cloud.store,
      kek: cloud.kek,
      region: "test",
      dataDir: cloud.dataDir,
      log: testLog,
    });
    expect(r.keysRestored).toBe(1);
    expect(r.previous && existsSync(r.previous)).toBe(true);
    const db = new Database(live, { readonly: true });
    const rows = db.prepare("SELECT account_id, wrapped_dek FROM tenant_keys").all() as Array<{
      account_id: string;
      wrapped_dek: string | null;
    }>;
    db.close();
    expect(rows.find((x) => x.account_id === keep)?.wrapped_dek).toBeTruthy();
    expect(rows.find((x) => x.account_id === gone)?.wrapped_dek).toBeNull();
    // The control plane reopens fine for the rest of the suite.
    cloud = await makeCloud({ dataDir: cloud.dataDir });
    expect(cloud.db.select().from(accounts).all().length).toBe(2);
  });
});

describe("S3 store (no network)", () => {
  it("sends the right commands through the lazily loaded SDK", async () => {
    const sent: Array<{ cmd: string; input: Record<string, unknown> }> = [];
    let constructed: Record<string, unknown> | null = null;
    const cmd = (name: string) =>
      class {
        constructor(readonly input: Record<string, unknown>) {
          sent.push({ cmd: name, input });
        }
      };
    let loads = 0;
    const fakeSdk: S3Module = {
      S3Client: class {
        constructor(cfg: Record<string, unknown>) {
          constructed = cfg;
        }
        async send(c: { input: Record<string, unknown> }) {
          const last = sent.at(-1);
          if (last?.cmd === "Get") return { Body: Readable.from([Buffer.from("hello")]) };
          if (last?.cmd === "List")
            return { Contents: [{ Key: "p/b" }, { Key: "p/a" }], IsTruncated: false };
          return c ? {} : {};
        }
      },
      PutObjectCommand: cmd("Put"),
      GetObjectCommand: cmd("Get"),
      DeleteObjectsCommand: cmd("Delete"),
      ListObjectsV2Command: cmd("List"),
    } as never;
    const store = s3ObjectStore({
      endpoint: "https://s3.example.test",
      region: "eu-central",
      bucket: "bucket",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret-example",
      sdk: async () => {
        loads++;
        return fakeSdk;
      },
    });
    expect(loads).toBe(0);
    await store.put("p/x.enc", Readable.from([Buffer.from("abc")]), 3);
    expect(sent[0]).toMatchObject({
      cmd: "Put",
      input: { Bucket: "bucket", Key: "p/x.enc", ContentLength: 3 },
    });
    expect(constructed).toMatchObject({
      endpoint: "https://s3.example.test",
      region: "eu-central",
      forcePathStyle: true,
    });
    const got = await collect((await store.get("p/x.enc")) as AsyncIterable<Buffer>);
    expect(got.toString()).toBe("hello");
    expect(await store.list("p/")).toEqual(["p/a", "p/b"]);
    await store.delete(["p/a", "p/b"]);
    expect(sent.at(-1)).toMatchObject({
      cmd: "Delete",
      input: { Bucket: "bucket", Delete: { Objects: [{ Key: "p/a" }, { Key: "p/b" }] } },
    });
    expect(loads).toBe(1);
    await expect(store.put("../escape", Readable.from([]), 0)).rejects.toThrow(
      /invalid object key/,
    );
  });
});
