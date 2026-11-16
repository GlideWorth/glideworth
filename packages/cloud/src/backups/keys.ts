/**
 * Backup data keys (spec 7). Each tenant has 32 random bytes, wrapped with `GLIDEWORTH_BACKUP_KEK` by
 * AES-256-GCM; the additional data binds the wrap to the tenant id and the KEK id, so a wrapped key copied onto
 * another tenant's row does not open. The control plane's own backups use a key derived from the KEK (HKDF),
 * so restoring the control plane never depends on the control plane.
 *
 * Crypto-shredding: the wrapped key exists in exactly two places, the `tenant_keys` row and the escrow object
 * `keys/<id>.key` (control-plane backups are made with every `wrapped_dek` blanked, see BackupService). Deleting
 * both makes every backup of the tenant unreadable.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export interface Kek {
  id: string;
  key: Uint8Array;
}

const aad = (accountId: string, kekId: string) =>
  Buffer.from(`glideworth-dek-v1|${accountId}|${kekId}`, "utf8");

export class KeyUnavailableError extends Error {
  constructor(readonly reason: "destroyed" | "missing" | "wrong-kek" | "corrupt") {
    super(`backup key unavailable: ${reason}`);
    this.name = "KeyUnavailableError";
  }
}

export function newDataKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

export function wrapDataKey(dek: Uint8Array, accountId: string, kek: Kek): string {
  if (kek.key.length !== 32 || dek.length !== 32) throw new Error("keys must be 32 bytes");
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek.key, nonce);
  c.setAAD(aad(accountId, kek.id));
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return `v1.${Buffer.concat([nonce, ct, c.getAuthTag()]).toString("base64url")}`;
}

export function unwrapDataKey(
  wrapped: string | null,
  accountId: string,
  kekIdOfRow: string,
  kek: Kek,
): Uint8Array {
  if (wrapped === null) throw new KeyUnavailableError("destroyed");
  if (kekIdOfRow !== kek.id) throw new KeyUnavailableError("wrong-kek");
  if (!wrapped.startsWith("v1.")) throw new KeyUnavailableError("corrupt");
  const raw = Buffer.from(wrapped.slice(3), "base64url");
  if (raw.length !== 12 + 32 + 16) throw new KeyUnavailableError("corrupt");
  try {
    const d = createDecipheriv("aes-256-gcm", kek.key, raw.subarray(0, 12));
    d.setAAD(aad(accountId, kek.id));
    d.setAuthTag(raw.subarray(44));
    return new Uint8Array(Buffer.concat([d.update(raw.subarray(12, 44)), d.final()]));
  } catch {
    throw new KeyUnavailableError("corrupt");
  }
}

/** The control plane's backup key: HKDF of the KEK (never stored). */
export function controlBackupKey(kek: Kek): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      "sha256",
      kek.key,
      Buffer.from("glideworth-backup", "utf8"),
      Buffer.from(`control|${kek.id}`),
      32,
    ),
  );
}

/** Escrow object for a tenant's wrapped key (JSON so the KEK id travels with it). */
export function escrowObjectKey(region: string, accountId: string): string {
  return `${region}/keys/${accountId}.key`;
}
