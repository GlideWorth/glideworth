/**
 * Keys derived from `GLIDEWORTH_SECRETS_KEY` (32 bytes). Every use gets its own key through HKDF-SHA256 with a
 * label naming the purpose, so a value sealed or MACed for one purpose can never be accepted for another.
 *
 *   hmac(purpose, data)  HMAC-SHA256, hex. Recovery codes, device cookies, trial grants, rate-limit keys.
 *   seal(purpose, plain) AES-256-GCM, 96-bit random nonce, the purpose as additional data.
 *                        Format `v1.<base64url(nonce | ciphertext | tag)>`.
 *   open(purpose, sealed) the inverse; throws on any tampering, wrong purpose or wrong key.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

export interface Keyring {
  hmac(purpose: string, data: string): string;
  seal(purpose: string, plain: Uint8Array): string;
  open(purpose: string, sealed: string): Uint8Array;
}

const PURPOSE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SALT = Buffer.from("glideworth-cloud-keyring-v1", "utf8");
const NONCE = 12;
const TAG = 16;

/** HKDF-SHA256 of the secrets key for one labelled purpose (32 bytes). Also used for keys handed to other packages. */
export function deriveKey(secretsKey: Uint8Array, label: string): Uint8Array {
  if (secretsKey.length !== 32) throw new Error("the secrets key must be exactly 32 bytes");
  if (!PURPOSE_RE.test(label.replace(/^[a-z]+:/, ""))) throw new Error("invalid key purpose");
  return new Uint8Array(hkdfSync("sha256", secretsKey, SALT, Buffer.from(label, "utf8"), 32));
}

export class SealedValueError extends Error {
  constructor() {
    super("sealed value could not be opened");
    this.name = "SealedValueError";
  }
}

export function keyring(secretsKey: Uint8Array): Keyring {
  if (secretsKey.length !== 32) throw new Error("the secrets key must be exactly 32 bytes");
  const master = Uint8Array.from(secretsKey);
  const cache = new Map<string, Uint8Array>();
  const key = (kind: "hmac" | "seal", purpose: string): Uint8Array => {
    if (!PURPOSE_RE.test(purpose)) throw new Error("invalid key purpose");
    const label = `${kind}:${purpose}`;
    let k = cache.get(label);
    if (!k) {
      k = deriveKey(master, label);
      cache.set(label, k);
    }
    return k;
  };

  return {
    hmac(purpose, data) {
      return createHmac("sha256", key("hmac", purpose)).update(data, "utf8").digest("hex");
    },
    seal(purpose, plain) {
      const nonce = randomBytes(NONCE);
      const cipher = createCipheriv("aes-256-gcm", key("seal", purpose), nonce);
      cipher.setAAD(Buffer.from(purpose, "utf8"));
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return `v1.${Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url")}`;
    },
    open(purpose, sealed) {
      const k = key("seal", purpose);
      if (typeof sealed !== "string" || !sealed.startsWith("v1.")) throw new SealedValueError();
      const raw = Buffer.from(sealed.slice(3), "base64url");
      if (raw.length < NONCE + TAG) throw new SealedValueError();
      try {
        const decipher = createDecipheriv("aes-256-gcm", k, raw.subarray(0, NONCE));
        decipher.setAAD(Buffer.from(purpose, "utf8"));
        decipher.setAuthTag(raw.subarray(raw.length - TAG));
        return new Uint8Array(
          Buffer.concat([decipher.update(raw.subarray(NONCE, raw.length - TAG)), decipher.final()]),
        );
      } catch {
        throw new SealedValueError();
      }
    },
  };
}
