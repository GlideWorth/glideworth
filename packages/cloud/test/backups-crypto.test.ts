/**
 * Security review of backup encryption (spec 7): what the `GWB1` envelope authenticates, how nonces and keys
 * are chosen, and what a restore refuses. Each test states the property it proves; `backups.test.ts` covers
 * the round trip and the basic tamper, truncation and tenant checks.
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BackupIntegrityError,
  CHUNK,
  type EnvelopeHeader,
  openStream,
  sealFile,
  sealStream,
} from "../src/backups/envelope.js";
import { controlBackupKey, unwrapDataKey, wrapDataKey } from "../src/backups/keys.js";
import { restoreControlPlane } from "../src/backups/service.js";
import { loadCloudConfig } from "../src/config.js";
import { backups, tenantKeys } from "../src/control/schema.js";
import { deriveKey } from "../src/crypto/keyring.js";
import { controlDbPath } from "../src/tenancy/paths.js";
import { tableDigests } from "../src/tenancy/sqlite-tools.js";
import {
  type Cloud,
  type FakeRuntime,
  makeCloud,
  removeTempDirs,
  signedUpBrowser,
  tempDir,
} from "./cloud-fixture.js";
import { testLog } from "./helpers.js";

const collect = async (it: AsyncIterable<Buffer>) => {
  const parts: Buffer[] = [];
  for await (const c of it) parts.push(c);
  return Buffer.concat(parts);
};
const TENANT = "tabcdefghijklmno";
const header: EnvelopeHeader = {
  v: 1,
  tenant: TENANT,
  schemaVersion: 2,
  createdAt: "2026-11-16T10:00:00.000Z",
  kekId: "k",
};
const key = new Uint8Array(randomBytes(32));

/** The parts of a sealed envelope: header bytes, base nonce, frames (length | ciphertext | tag). */
function parse(sealed: Buffer) {
  const hlen = sealed.readUInt32BE(4);
  const headerBytes = sealed.subarray(8, 8 + hlen);
  const nonce = sealed.subarray(8 + hlen, 8 + hlen + 12);
  const frames: Buffer[] = [];
  let at = 8 + hlen + 12;
  while (at < sealed.length) {
    const len = sealed.readUInt32BE(at);
    frames.push(sealed.subarray(at, at + 4 + len + 16));
    at += 4 + len + 16;
  }
  return { prefix: sealed.subarray(0, 8 + hlen + 12), headerBytes, nonce, frames };
}

const attempt = (buf: Buffer, tenant = TENANT, k: Uint8Array = key) =>
  collect(openStream(Readable.from([buf]), k, { tenant })).then(
    () => "opened",
    (e: unknown) => (e instanceof BackupIntegrityError ? e.reason : `other: ${String(e)}`),
  );

describe("GWB1 envelope", () => {
  const plain = randomBytes(3 * CHUNK + 100); // four frames

  it("is AES-256-GCM: each frame decrypts with the standard cipher, base nonce XOR frame index, and the header hash, index and final flag as additional data", async () => {
    const sealed = await collect(sealStream(Readable.from([plain]), key, header));
    const { headerBytes, nonce, frames } = parse(sealed);
    expect(frames).toHaveLength(4);
    const headerHash = createHash("sha256").update(headerBytes).digest();
    for (const [i, frame] of frames.entries()) {
      const n = Buffer.from(nonce);
      n.writeBigUInt64BE(n.readBigUInt64BE(4) ^ BigInt(i), 4);
      const aad = Buffer.alloc(41);
      headerHash.copy(aad);
      aad.writeBigUInt64BE(BigInt(i), 32);
      aad[40] = i === frames.length - 1 ? 1 : 0;
      // Re-encrypting the frame's plaintext with those inputs gives the same bytes and tag.
      const c = createCipheriv("aes-256-gcm", key, n);
      c.setAAD(aad);
      const part = plain.subarray(i * CHUNK, Math.min(plain.length, (i + 1) * CHUNK));
      const ct = Buffer.concat([c.update(part), c.final()]);
      expect(frame.subarray(4, 4 + ct.length).equals(ct)).toBe(true);
      expect(frame.subarray(4 + ct.length).equals(c.getAuthTag())).toBe(true);
    }
  });

  it("uses a fresh random 96-bit base nonce per file, so the same data and key never repeat a nonce or a ciphertext", async () => {
    const nonces = new Set<string>();
    const bodies = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const sealed = await collect(sealStream(Readable.from([plain]), key, header));
      const { nonce, frames } = parse(sealed);
      expect(nonce).toHaveLength(12);
      nonces.add(nonce.toString("hex"));
      bodies.add(createHash("sha256").update(frames[0]!).digest("hex"));
    }
    expect(nonces.size).toBe(50);
    expect(bodies.size).toBe(50);
  });

  it("refuses reordered frames, a dropped middle frame, a duplicated frame and bytes after the last frame", async () => {
    const sealed = await collect(sealStream(Readable.from([plain]), key, header));
    const { prefix, frames } = parse(sealed);
    const [f0, f1, f2, f3] = frames as [Buffer, Buffer, Buffer, Buffer];
    expect(await attempt(Buffer.concat([prefix, f1, f0, f2, f3]))).toBe("authentication failed");
    expect(await attempt(Buffer.concat([prefix, f0, f2, f3]))).toBe("authentication failed");
    expect(await attempt(Buffer.concat([prefix, f0, f1, f1, f2, f3]))).toBe(
      "authentication failed",
    );
    expect(await attempt(Buffer.concat([sealed, Buffer.from([0])]))).toBe("authentication failed");
    // Swapping in the last frame of another file under the same key (the final frame of an older backup):
    const other = parse(await collect(sealStream(Readable.from([plain]), key, header)));
    expect(await attempt(Buffer.concat([prefix, f0, f1, f2, other.frames[3]!]))).toBe(
      "authentication failed",
    );
    expect(await attempt(sealed)).toBe("opened");
  });

  it("authenticates every header field, not only the tenant: an edited creation time, schema version or key id fails", async () => {
    const sealed = await collect(sealStream(Readable.from([plain]), key, header));
    const { headerBytes, nonce, frames } = parse(sealed);
    for (const edit of [
      { createdAt: "2020-01-01T00:00:00.000Z" },
      { schemaVersion: 1 },
      { kekId: "k2" },
    ]) {
      const h = Buffer.from(JSON.stringify({ ...header, ...edit }), "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(h.length);
      const forged = Buffer.concat([sealed.subarray(0, 4), len, h, nonce, ...frames]);
      expect(await attempt(forged)).toBe("authentication failed");
    }
    // A changed base nonce fails too.
    const n2 = Buffer.from(nonce);
    n2[0] = (n2[0] ?? 0) ^ 1;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(headerBytes.length);
    expect(
      await attempt(Buffer.concat([sealed.subarray(0, 4), len, headerBytes, n2, ...frames])),
    ).toBe("authentication failed");
  });

  it("produces no plaintext from a frame whose tag does not verify", async () => {
    const sealed = await collect(sealStream(Readable.from([plain]), key, header));
    const { prefix, frames } = parse(sealed);
    const bad = Buffer.from(frames[0]!);
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1; // last byte of the tag
    const got: Buffer[] = [];
    await expect(
      (async () => {
        for await (const c of openStream(Readable.from([Buffer.concat([prefix, bad])]), key, {
          tenant: TENANT,
        }))
          got.push(c);
      })(),
    ).rejects.toThrow(BackupIntegrityError);
    expect(got).toHaveLength(0);
  });

  it("refuses malformed framing without trying to decrypt or allocate: bad magic, header length, oversized frame", async () => {
    const sealed = await collect(sealStream(Readable.from([plain]), key, header));
    const { prefix, frames } = parse(sealed);
    expect(await attempt(Buffer.concat([Buffer.from("GWB2"), sealed.subarray(4)]))).toBe(
      "bad magic",
    );
    const huge = Buffer.from(sealed);
    huge.writeUInt32BE(1_000_000, 4);
    expect(await attempt(huge)).toBe("bad header length");
    const big = Buffer.from(frames[0]!);
    big.writeUInt32BE(CHUNK + 1, 0);
    expect(await attempt(Buffer.concat([prefix, big]))).toBe("bad frame");
  });
});

describe("backup keys", () => {
  it("each tenant has its own random data key; wraps are bound to tenant and KEK, and every wrap uses a new nonce", () => {
    const kek = { id: "k1", key: new Uint8Array(randomBytes(32)) };
    const a = new Uint8Array(randomBytes(32));
    const w1 = wrapDataKey(a, "taaaaaaaaaaaaaaa", kek);
    const w2 = wrapDataKey(a, "taaaaaaaaaaaaaaa", kek);
    expect(w1).not.toBe(w2);
    expect(Buffer.from(w1.slice(3), "base64url").subarray(0, 12)).not.toEqual(
      Buffer.from(w2.slice(3), "base64url").subarray(0, 12),
    );
    // A wrap moved to another tenant's row does not open.
    expect(() => unwrapDataKey(w1, "tbbbbbbbbbbbbbbb", "k1", kek)).toThrow(/corrupt/);
    // A different KEK with the same id does not open it either.
    expect(() =>
      unwrapDataKey(w1, "taaaaaaaaaaaaaaa", "k1", { id: "k1", key: new Uint8Array(32) }),
    ).toThrow(/corrupt/);
  });

  it("the control-plane key is derived from the KEK, differs from it and from the secrets-key derivations, and changes with the KEK id", () => {
    const kek = { id: "k1", key: new Uint8Array(randomBytes(32)) };
    const c1 = Buffer.from(controlBackupKey(kek));
    expect(c1).toHaveLength(32);
    expect(c1.equals(Buffer.from(kek.key))).toBe(false);
    expect(c1.equals(Buffer.from(controlBackupKey({ ...kek, id: "k2" })))).toBe(false);
    // Even if the operator reused one value for both secrets, the derivations would not meet.
    expect(c1.equals(Buffer.from(deriveKey(kek.key, "seal:backup")))).toBe(false);
  });

  it("configuration refuses a backup KEK equal to the secrets key", () => {
    const same = "ab".repeat(32);
    const r = (() => {
      try {
        return loadCloudConfig({
          GLIDEWORTH_SECRETS_KEY: same,
          GLIDEWORTH_BACKUP_KEK: same,
        } as unknown as NodeJS.ProcessEnv);
      } catch (e) {
        return e;
      }
    })();
    expect(String((r as Error)?.message ?? JSON.stringify(r))).toMatch(
      /GLIDEWORTH_BACKUP_KEK must differ from GLIDEWORTH_SECRETS_KEY/,
    );
  });
});

describe("restore", () => {
  let cloud: Cloud;
  beforeEach(async () => {
    cloud = await makeCloud();
  });
  afterEach(async () => {
    await cloud.close();
    removeTempDirs();
  });

  async function tenant(n = 3) {
    const { accountId } = await signedUpBrowser(cloud);
    const id = accountId as string;
    await cloud.registry.with(id, (r) => {
      for (let i = 0; i < n; i++) (r as FakeRuntime).addHousehold(`hh_${i}`, `H${i}`, i);
    });
    return id;
  }
  const dek = (id: string) => {
    const row = cloud.db.select().from(tenantKeys).where(eq(tenantKeys.accountId, id)).get()!;
    return unwrapDataKey(row.wrappedDek, id, row.kekId, cloud.kek);
  };
  const latestRow = (id: string) =>
    cloud.db.select().from(backups).where(eq(backups.accountId, id)).get()!;

  it("a tenant's data key cannot open another tenant's backup, even with the header and record rewritten", async () => {
    const a = await tenant();
    const b = await tenant();
    expect(Buffer.from(dek(a)).equals(Buffer.from(dek(b)))).toBe(false);
    const { objectKey } = await cloud.backups.backupTenant(a);
    const body = cloud.store.objects.get(objectKey)!;
    // Without the header check, B's key still fails on A's frames.
    expect(await attempt(body, a, dek(b))).toBe("authentication failed");
  });

  it("an older genuine backup put in place of the newest is refused (the record's checksum binds the object)", async () => {
    const id = await tenant();
    const first = await cloud.backups.backupTenant(id);
    cloud.advance(60_000);
    await cloud.registry.with(id, (r) => (r as FakeRuntime).addHousehold("hh_new", "New", 1));
    const second = await cloud.backups.backupTenant(id);
    const live = tableDigests(cloud.registry.pathFor(id));
    cloud.store.objects.set(second.objectKey, cloud.store.objects.get(first.objectKey)!);
    await expect(cloud.backups.restoreTenant(id, { operatorId: "op" })).rejects.toMatchObject({
      reason: "checksum mismatch",
    });
    expect(tableDigests(cloud.registry.pathFor(id))).toEqual(live);
  });

  it("validates the decrypted file: an authentic envelope holding a SQLite file that is not a Glideworth database is refused", async () => {
    const id = await tenant();
    await cloud.backups.backupTenant(id);
    const row = latestRow(id);
    const dir = tempDir("gw-foreign");
    const foreign = resolve(dir, "foreign.db");
    const db = new Database(foreign);
    db.exec("CREATE TABLE notes (x TEXT); INSERT INTO notes VALUES ('hello');");
    db.close();
    const enc = resolve(dir, "foreign.enc");
    await sealFile(foreign, enc, dek(id), {
      v: 1,
      tenant: id,
      schemaVersion: row.schemaVersion,
      createdAt: row.createdAt,
      kekId: cloud.kek.id,
    });
    const sha = createHash("sha256").update(readFileSync(foreign)).digest("hex");
    cloud.db.update(backups).set({ sha256: sha }).where(eq(backups.id, row.id)).run();
    cloud.store.objects.set(row.objectKey, readFileSync(enc));
    const live = tableDigests(cloud.registry.pathFor(id));
    await expect(cloud.backups.restoreTenant(id, { operatorId: "op" })).rejects.toMatchObject({
      reason: "not a Glideworth database",
    });
    expect(tableDigests(cloud.registry.pathFor(id))).toEqual(live);
  });

  it("validates the decrypted file: authentic bytes that are not SQLite at all are refused", async () => {
    const id = await tenant();
    await cloud.backups.backupTenant(id);
    const row = latestRow(id);
    const dir = tempDir("gw-garbage");
    const junk = resolve(dir, "junk.bin");
    writeFileSync(junk, randomBytes(10_000));
    const enc = resolve(dir, "junk.enc");
    await sealFile(junk, enc, dek(id), {
      v: 1,
      tenant: id,
      schemaVersion: row.schemaVersion,
      createdAt: row.createdAt,
      kekId: cloud.kek.id,
    });
    cloud.store.objects.set(row.objectKey, readFileSync(enc));
    await expect(cloud.backups.restoreTenant(id, { operatorId: "op" })).rejects.toBeInstanceOf(
      BackupIntegrityError,
    );
  });

  it("object keys cannot leave the store: path traversal and odd segments are refused before any I/O", async () => {
    for (const k of ["../x", "a/../../x", "a//b", "./a", "/abs", "a/./b", "a\\..\\b"])
      await expect(cloud.store.get(k)).rejects.toThrow(/invalid object key/);
    // A backup record pointing outside its prefix is still read only through the store's key check.
    const id = await tenant();
    await cloud.backups.backupTenant(id);
    cloud.db
      .update(backups)
      .set({ objectKey: "../../etc/passwd" })
      .where(eq(backups.id, latestRow(id).id))
      .run();
    await expect(cloud.backups.restoreTenant(id, { operatorId: "op" })).rejects.toThrow(
      /invalid object key/,
    );
  });

  it("a tenant id that is not a tenant id is refused before any path is built", async () => {
    for (const bad of ["../control", "control", "tAAAAAAAAAAAAAAA/..", ""])
      await expect(cloud.backups.restoreTenant(bad, { operatorId: "op" })).rejects.toThrow();
  });

  it("restore-control refuses an older control backup copied under a newer name (no silent rollback)", async () => {
    await tenant(1);
    const older = await cloud.backups.backupControl();
    cloud.advance(3_600_000);
    await tenant(1); // a second workspace, so the newer control plane differs
    const newer = await cloud.backups.backupControl();
    // Someone who can write to the bucket but has no key replaces the newest control backup with the older one.
    cloud.store.objects.set(newer.objectKey, cloud.store.objects.get(older.objectKey)!);
    await cloud.close();
    const live = controlDbPath(cloud.dataDir);
    const before = readFileSync(live);
    await expect(
      restoreControlPlane({
        store: cloud.store,
        kek: cloud.kek,
        region: "test",
        dataDir: cloud.dataDir,
        log: testLog,
      }),
    ).rejects.toMatchObject({ reason: "backup time does not match its name" });
    expect(readFileSync(live).equals(before)).toBe(true);
    cloud = await makeCloud({ dataDir: cloud.dataDir });
  });

  it("restore-control refuses a tenant backup put in the control prefix (wrong key and wrong header)", async () => {
    const id = await tenant(1);
    const { objectKey } = await cloud.backups.backupTenant(id);
    const ctl = await cloud.backups.backupControl();
    cloud.store.objects.set(ctl.objectKey, cloud.store.objects.get(objectKey)!);
    await cloud.close();
    await expect(
      restoreControlPlane({
        store: cloud.store,
        kek: cloud.kek,
        region: "test",
        dataDir: cloud.dataDir,
        log: testLog,
      }),
    ).rejects.toMatchObject({ reason: "backup belongs to another tenant" });
    cloud = await makeCloud({ dataDir: cloud.dataDir });
  });
});
