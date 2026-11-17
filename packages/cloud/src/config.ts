/**
 * Cloud configuration from the environment (spec 1). Fails closed: every missing, invalid or forbidden variable
 * is collected and reported together, by name only (values, which may be secrets, are never echoed).
 */
import { availableParallelism } from "node:os";
import { type HeartbeatConfig, loadHeartbeats } from "./heartbeat.js";

export interface CloudConfig {
  publicUrl: string;
  dataDir: string;
  secretsKey: Uint8Array;
  backupKek: { id: string; key: Uint8Array };
  pricingFile: string;
  tenantCacheSize: number;
  maxJobs: number;
  opsListen: { host: string; port: number };
  production: boolean;
  /**
   * Not in spec 1: "Sign in with Google" (OpenID Connect, federation/). Null when the client id and secret are
   * not set: then no Google route is registered and the web app shows no button.
   */
  google: GoogleConfig | null;
  /** Not in spec 1: optional dead-man's-switch ping URLs (heartbeat.ts). */
  heartbeats: HeartbeatConfig;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** The OpenID issuer whose discovery document is used. Always Google's in production. */
  issuer: string;
  /** Fixed from the public URL, never from a request: `<public URL>/api/v1/auth/google/callback`. */
  redirectUri: string;
}

export const GOOGLE_ISSUER = "https://accounts.google.com";

export class CloudConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`cloud configuration is invalid: ${problems.join("; ")}`);
    this.name = "CloudConfigError";
  }
}

/** A 32-byte key given as 64 hex characters or base64/base64url of 32 bytes. */
export function parseKey32(value: string | undefined): Uint8Array | null {
  if (!value) return null;
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return new Uint8Array(Buffer.from(v, "hex"));
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 32) return new Uint8Array(b);
  }
  return null;
}

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes)$/i.test(v.trim());

export function loadCloudConfig(env: NodeJS.ProcessEnv): CloudConfig {
  const problems: string[] = [];
  const production = env.NODE_ENV === "production";

  let publicUrl = "";
  const rawUrl = env.GLIDEWORTH_PUBLIC_URL;
  if (!rawUrl) problems.push("GLIDEWORTH_PUBLIC_URL is required");
  else {
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== "https:" && (production || u.protocol !== "http:"))
        problems.push("GLIDEWORTH_PUBLIC_URL must be an https URL");
      else if (u.username || u.password || u.search || u.hash)
        problems.push("GLIDEWORTH_PUBLIC_URL must not contain credentials, a query or a fragment");
      else publicUrl = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    } catch {
      problems.push("GLIDEWORTH_PUBLIC_URL must be an absolute URL");
    }
  }

  const secretsKey = parseKey32(env.GLIDEWORTH_SECRETS_KEY);
  if (!secretsKey)
    problems.push("GLIDEWORTH_SECRETS_KEY must be 32 bytes (64 hex characters or base64)");
  const kek = parseKey32(env.GLIDEWORTH_BACKUP_KEK);
  if (!kek) problems.push("GLIDEWORTH_BACKUP_KEK must be 32 bytes (64 hex characters or base64)");
  if (secretsKey && kek && Buffer.from(secretsKey).equals(Buffer.from(kek)))
    problems.push("GLIDEWORTH_BACKUP_KEK must differ from GLIDEWORTH_SECRETS_KEY");
  const kekId = env.GLIDEWORTH_BACKUP_KEK_ID?.trim() || "k1";
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(kekId))
    problems.push("GLIDEWORTH_BACKUP_KEK_ID must be 1-32 safe characters");

  // Self-host settings, under their current names and the pre-rename CAIRN_* aliases apps/api still reads.
  for (const prefix of ["GLIDEWORTH_", "CAIRN_"]) {
    for (const name of ["BOOTSTRAP_KEY", "SETUP_TOKEN", "DB_PATH"])
      if (env[prefix + name])
        problems.push(
          `${prefix}${name} is a single-tenant setting and must not be set in cloud mode`,
        );
    if (truthy(env[`${prefix}WEBHOOK_ALLOW_PRIVATE`]))
      problems.push(`${prefix}WEBHOOK_ALLOW_PRIVATE=true is not allowed in cloud mode`);
  }
  if (production) {
    if ((env.GLIDEWORTH_EMAIL_TRANSPORT ?? "file") === "file")
      problems.push("GLIDEWORTH_EMAIL_TRANSPORT=file is not allowed in production");
    if ((env.GLIDEWORTH_BILLING ?? "fake") === "fake")
      problems.push("GLIDEWORTH_BILLING=fake is not allowed in production");
    if (!env.GLIDEWORTH_TURNSTILE_SECRET)
      problems.push("GLIDEWORTH_TURNSTILE_SECRET is required in production");
  }

  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };
  const tenantCacheSize = int("GLIDEWORTH_TENANT_CACHE_SIZE", 256, 1, 100_000);
  const maxJobs = int("GLIDEWORTH_MAX_JOBS", Math.max(1, availableParallelism() - 1), 1, 1024);

  let opsListen = { host: "127.0.0.1", port: 8789 };
  const ops = env.GLIDEWORTH_OPS_LISTEN;
  if (ops) {
    const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(ops.trim());
    const port = m ? Number(m[2]) : Number.NaN;
    if (!m || port < 1 || port > 65535) problems.push("GLIDEWORTH_OPS_LISTEN must be host:port");
    else opsListen = { host: (m[1] as string).replace(/^\[|\]$/g, ""), port };
  }

  const dataDir = env.GLIDEWORTH_DATA_DIR?.trim() || "/data";
  const pricingFile = env.GLIDEWORTH_PRICING_FILE?.trim() ?? "";
  if (!pricingFile) problems.push("GLIDEWORTH_PRICING_FILE is required");

  const google = loadGoogle(env, publicUrl, production, problems);
  const heartbeats = loadHeartbeats(env, problems);

  if (problems.length) throw new CloudConfigError(problems);
  return {
    publicUrl,
    dataDir,
    secretsKey: secretsKey as Uint8Array,
    backupKek: { id: kekId, key: kek as Uint8Array },
    pricingFile,
    tenantCacheSize,
    maxJobs,
    opsListen,
    production,
    google,
    heartbeats,
  };
}

/**
 * `GLIDEWORTH_GOOGLE_CLIENT_ID` and `GLIDEWORTH_GOOGLE_CLIENT_SECRET` together, or neither (feature off).
 * `GLIDEWORTH_GOOGLE_ISSUER` points the client at another OpenID provider (a local fake) and is refused in
 * production, so production only ever trusts Google's issuer.
 */
function loadGoogle(
  env: NodeJS.ProcessEnv,
  publicUrl: string,
  production: boolean,
  problems: string[],
): GoogleConfig | null {
  const id = env.GLIDEWORTH_GOOGLE_CLIENT_ID?.trim() ?? "";
  const secret = env.GLIDEWORTH_GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const rawIssuer = env.GLIDEWORTH_GOOGLE_ISSUER?.trim() ?? "";
  if (!id && !secret) {
    if (rawIssuer) problems.push("GLIDEWORTH_GOOGLE_ISSUER is set without a Google client");
    return null;
  }
  if (!id || !secret) {
    problems.push(
      "GLIDEWORTH_GOOGLE_CLIENT_ID and GLIDEWORTH_GOOGLE_CLIENT_SECRET must be set together",
    );
    return null;
  }
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(id))
    problems.push("GLIDEWORTH_GOOGLE_CLIENT_ID is not a valid client id");
  else if (production && !id.endsWith(".apps.googleusercontent.com"))
    problems.push("GLIDEWORTH_GOOGLE_CLIENT_ID must be a Google web client id");
  if (!/^[\x21-\x7e]{8,256}$/.test(secret))
    problems.push("GLIDEWORTH_GOOGLE_CLIENT_SECRET is not a valid client secret");
  let issuer = GOOGLE_ISSUER;
  if (rawIssuer) {
    if (production) problems.push("GLIDEWORTH_GOOGLE_ISSUER must not be set in production");
    else {
      try {
        const u = new URL(rawIssuer);
        const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
        if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback))
          problems.push("GLIDEWORTH_GOOGLE_ISSUER must be an https URL");
        else if (u.username || u.password || u.search || u.hash)
          problems.push("GLIDEWORTH_GOOGLE_ISSUER must be a plain URL");
        else issuer = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
      } catch {
        problems.push("GLIDEWORTH_GOOGLE_ISSUER must be an absolute URL");
      }
    }
  }
  return {
    clientId: id,
    clientSecret: secret,
    issuer,
    redirectUri: `${publicUrl}/api/v1/auth/google/callback`,
  };
}
