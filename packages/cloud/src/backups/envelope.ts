/**
 * Backup envelope `GWB1` (spec 7): AES-256-GCM in 64 KiB chunks over the gzip of a database file.
 *
 *   "GWB1" | u32 header length | header JSON | 12-byte base nonce | frames…
 *   frame = u32 ciphertext length | ciphertext | 16-byte tag
 *
 * The header (version, tenant id or `control`, schema version, creation time, key-encryption key id) is
 * authenticated: every frame's additional data is SHA-256(header) | u64 frame index | final flag. So a header
 * edited to name another tenant, a reordered, dropped or truncated frame, or any flipped bit fails
 * decryption, and a restore checks the header's tenant id before decrypting anything. Frame nonces are the base
 * nonce with the frame index XORed into its last 8 bytes (unique per key: a fresh random base per file).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

export const MAGIC = Buffer.from("GWB1", "ascii");
export const CHUNK = 64 * 1024;
const NONCE = 12;
const TAG = 16;
const MAX_HEADER = 4096;

export interface EnvelopeHeader {
  v: 1;
  /** Tenant id, or `control` for the control plane. */
  tenant: string;
  schemaVersion: number | null;
  createdAt: string;
  kekId: string;
}

export class BackupIntegrityError extends Error {
  constructor(readonly reason: string) {
    super(`backup rejected: ${reason}`);
    this.name = "BackupIntegrityError";
  }
}

function frameNonce(base: Buffer, index: number): Buffer {
  const n = Buffer.from(base);
  const tail = n.readBigUInt64BE(4) ^ BigInt(index);
  n.writeBigUInt64BE(tail, 4);
  return n;
}

function frameAad(headerHash: Buffer, index: number, final: boolean): Buffer {
  const b = Buffer.alloc(32 + 8 + 1);
  headerHash.copy(b, 0);
  b.writeBigUInt64BE(BigInt(index), 32);
  b[40] = final ? 1 : 0;
  return b;
}

/** Encrypt an async source of plaintext bytes into envelope bytes. */
export async function* sealStream(
  source: AsyncIterable<Buffer | Uint8Array>,
  key: Uint8Array,
  header: EnvelopeHeader,
): AsyncGenerator<Buffer> {
  if (key.length !== 32) throw new Error("data key must be 32 bytes");
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const headerHash = createHash("sha256").update(headerBytes).digest();
  const base = randomBytes(NONCE);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(headerBytes.length);
  yield Buffer.concat([MAGIC, len, headerBytes, base]);

  let index = 0;
  let pending = Buffer.alloc(0);
  const seal = (plain: Buffer, final: boolean): Buffer => {
    const c = createCipheriv("aes-256-gcm", key, frameNonce(base, index));
    c.setAAD(frameAad(headerHash, index, final));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const l = Buffer.alloc(4);
    l.writeUInt32BE(ct.length);
    index++;
    return Buffer.concat([l, ct, c.getAuthTag()]);
  };
  for await (const chunk of source) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    // Keep at least one full chunk back: the last frame must carry the final flag.
    while (pending.length > CHUNK) {
      yield seal(pending.subarray(0, CHUNK), false);
      pending = pending.subarray(CHUNK);
    }
  }
  yield seal(pending, true);
}

function parseHeader(bytes: Buffer): EnvelopeHeader {
  let h: unknown;
  try {
    h = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new BackupIntegrityError("bad header");
  }
  const o = h as Partial<EnvelopeHeader>;
  if (
    o?.v !== 1 ||
    typeof o.tenant !== "string" ||
    typeof o.createdAt !== "string" ||
    typeof o.kekId !== "string" ||
    !(o.schemaVersion === null || typeof o.schemaVersion === "number")
  )
    throw new BackupIntegrityError("bad header");
  return o as EnvelopeHeader;
}

/**
 * Decrypt envelope bytes. `expect` is checked against the authenticated header before any plaintext is produced
 * (tenant id: a backup of one tenant can never be restored into another).
 */
export async function* openStream(
  source: AsyncIterable<Buffer | Uint8Array>,
  key: Uint8Array,
  expect: { tenant: string },
  onHeader?: (h: EnvelopeHeader) => void,
): AsyncGenerator<Buffer> {
  let buf = Buffer.alloc(0);
  const it = source[Symbol.asyncIterator]();
  let ended = false;
  const need = async (n: number): Promise<boolean> => {
    while (buf.length < n && !ended) {
      const r = await it.next();
      if (r.done) ended = true;
      else buf = Buffer.concat([buf, Buffer.from(r.value)]);
    }
    return buf.length >= n;
  };
  if (!(await need(8))) throw new BackupIntegrityError("truncated");
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new BackupIntegrityError("bad magic");
  const hlen = buf.readUInt32BE(4);
  if (hlen < 2 || hlen > MAX_HEADER) throw new BackupIntegrityError("bad header length");
  if (!(await need(8 + hlen + NONCE))) throw new BackupIntegrityError("truncated");
  const headerBytes = buf.subarray(8, 8 + hlen);
  const header = parseHeader(Buffer.from(headerBytes));
  if (header.tenant !== expect.tenant)
    throw new BackupIntegrityError("backup belongs to another tenant");
  onHeader?.(header);
  const headerHash = createHash("sha256").update(headerBytes).digest();
  const base = Buffer.from(buf.subarray(8 + hlen, 8 + hlen + NONCE));
  buf = buf.subarray(8 + hlen + NONCE);

  let index = 0;
  for (;;) {
    if (!(await need(4))) throw new BackupIntegrityError("truncated");
    const clen = buf.readUInt32BE(0);
    if (clen > CHUNK) throw new BackupIntegrityError("bad frame");
    if (!(await need(4 + clen + TAG))) throw new BackupIntegrityError("truncated");
    const ct = buf.subarray(4, 4 + clen);
    const tag = buf.subarray(4 + clen, 4 + clen + TAG);
    buf = buf.subarray(4 + clen + TAG);
    const final = !(await need(1));
    let plain: Buffer;
    try {
      const d = createDecipheriv("aes-256-gcm", key, frameNonce(base, index));
      d.setAAD(frameAad(headerHash, index, final));
      d.setAuthTag(tag);
      plain = Buffer.concat([d.update(ct), d.final()]);
    } catch {
      throw new BackupIntegrityError("authentication failed");
    }
    index++;
    yield plain;
    if (final) return;
  }
}

/** File -> gzip -> seal -> file. Returns the ciphertext size. */
export async function sealFile(
  src: string,
  dest: string,
  key: Uint8Array,
  header: EnvelopeHeader,
): Promise<void> {
  const gz = createReadStream(src).pipe(createGzip({ level: 6 }));
  await pipeline(sealStream(gz, key, header), createWriteStream(dest, { mode: 0o600 }));
}

/** Stream -> open -> gunzip -> file. Returns the authenticated header. */
export async function openToFile(
  source: AsyncIterable<Buffer | Uint8Array>,
  dest: string,
  key: Uint8Array,
  expect: { tenant: string },
): Promise<EnvelopeHeader> {
  let header: EnvelopeHeader | null = null;
  await pipeline(
    openStream(source, key, expect, (h) => {
      header = h;
    }),
    createGunzip(),
    createWriteStream(dest, { mode: 0o600 }),
  );
  if (!header) throw new BackupIntegrityError("no header");
  return header;
}
