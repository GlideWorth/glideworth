/**
 * Files on disk (spec 2.4). Every path that contains a tenant id or an export id is built here and nowhere else.
 *
 *   $DATA_DIR/control/control.db
 *   $DATA_DIR/tenants/<id[1..2]>/<id>/tenant.db  (+ pre-migrate/<ts>.db, pre-restore-<ts>.db)
 *   $DATA_DIR/exports/<exportId>.db
 *   $DATA_DIR/staging/
 *
 * The id is checked against the strict pattern before it is used in any string operation that could become a
 * path (`../x`, absolute paths, uppercase, wrong length, NUL bytes, Unicode look-alikes all fail the ASCII-only
 * regex), and the resolved result must still lie inside the tenants directory.
 */
import { resolve, sep } from "node:path";
import { ACCOUNT_ID_RE } from "../crypto/random.js";

export class InvalidTenantIdError extends Error {
  constructor() {
    super("invalid tenant id");
    this.name = "InvalidTenantIdError";
  }
}

/** Fixed sub-paths inside a tenant directory. Callers cannot pass free-form segments. */
export type TenantFile =
  | { kind: "dir" }
  | { kind: "db" }
  | { kind: "pre-migrate-dir" }
  | { kind: "pre-migrate"; stamp: string }
  | { kind: "pre-restore"; stamp: string };

const STAMP_RE = /^\d{8}T\d{6}(\d{3})?Z$/;
const EXPORT_ID_RE = /^exp_[a-z2-7]{20}$/;

/** UTC timestamp usable in a file name: `20261116T101500123Z`. */
export const fileStamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(".", "");

export function assertTenantId(accountId: unknown): asserts accountId is string {
  if (typeof accountId !== "string" || accountId.length !== 16 || !ACCOUNT_ID_RE.test(accountId))
    throw new InvalidTenantIdError();
}

/** The one function that turns a tenant id into a path. */
export function tenantPath(
  dataDir: string,
  accountId: string,
  file: TenantFile = { kind: "db" },
): string {
  assertTenantId(accountId);
  const root = resolve(dataDir, "tenants");
  const dir = resolve(root, accountId.slice(1, 3), accountId);
  if (!dir.startsWith(root + sep)) throw new InvalidTenantIdError();
  let out: string;
  switch (file.kind) {
    case "dir":
      out = dir;
      break;
    case "db":
      out = resolve(dir, "tenant.db");
      break;
    case "pre-migrate-dir":
      out = resolve(dir, "pre-migrate");
      break;
    case "pre-migrate":
      if (!STAMP_RE.test(file.stamp)) throw new Error("invalid stamp");
      out = resolve(dir, "pre-migrate", `${file.stamp}.db`);
      break;
    case "pre-restore":
      if (!STAMP_RE.test(file.stamp)) throw new Error("invalid stamp");
      out = resolve(dir, `pre-restore-${file.stamp}.db`);
      break;
  }
  if (out !== dir && !out.startsWith(dir + sep)) throw new InvalidTenantIdError();
  return out;
}

export function exportPath(dataDir: string, exportId: string): string {
  if (typeof exportId !== "string" || !EXPORT_ID_RE.test(exportId))
    throw new Error("invalid export id");
  return resolve(dataDir, "exports", `${exportId}.db`);
}

export const controlDbPath = (dataDir: string): string => resolve(dataDir, "control", "control.db");
export const stagingDir = (dataDir: string): string => resolve(dataDir, "staging");
export const exportsDir = (dataDir: string): string => resolve(dataDir, "exports");
export const isExportId = (v: unknown): v is string =>
  typeof v === "string" && EXPORT_ID_RE.test(v);
