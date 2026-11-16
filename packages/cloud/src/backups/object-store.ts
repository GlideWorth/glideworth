/**
 * Object storage behind one interface (spec 8.3 `ObjectStore`): S3-compatible storage in production, memory in
 * tests, and (not in spec 8.3) a directory for development and the CLI tests. The AWS SDK is imported lazily,
 * only when an S3 store is first used, and the import can be replaced (tests inject a fake module, so no test
 * touches the network).
 */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ObjectStore } from "../types.js";

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
function assertKey(key: string): void {
  if (
    typeof key !== "string" ||
    !KEY_RE.test(key) ||
    key.split("/").some((s) => s === "" || s === "." || s === "..")
  )
    throw new Error("invalid object key");
}

async function collect(body: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of body as AsyncIterable<Buffer | string>) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

export function memoryObjectStore(): ObjectStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(key, body, bytes) {
      assertKey(key);
      const data = await collect(body);
      if (data.length !== bytes) throw new Error("object size mismatch");
      objects.set(key, data);
    },
    async get(key) {
      assertKey(key);
      const data = objects.get(key);
      if (!data) throw new ObjectNotFoundError();
      return Readable.from([Buffer.from(data)]);
    },
    async delete(keys) {
      for (const k of keys) objects.delete(k);
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super("object not found");
    this.name = "ObjectNotFoundError";
  }
}

/** Not in spec 8.3: objects as files under `root` (development, single-host tests of the CLI). */
export function fsObjectStore(root: string): ObjectStore {
  const base = resolve(root);
  const pathOf = (key: string) => {
    assertKey(key);
    const p = resolve(base, key);
    if (!p.startsWith(base + sep)) throw new Error("invalid object key");
    return p;
  };
  const walk = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)],
    );
  };
  return {
    async put(key, body, bytes) {
      const p = pathOf(key);
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      const tmp = `${p}.part`;
      await pipeline(body as NodeJS.ReadableStream, createWriteStream(tmp, { mode: 0o600 }));
      if (statSync(tmp).size !== bytes) {
        rmSync(tmp, { force: true });
        throw new Error("object size mismatch");
      }
      const { renameSync } = await import("node:fs");
      renameSync(tmp, p);
    },
    async get(key) {
      const p = pathOf(key);
      if (!existsSync(p)) throw new ObjectNotFoundError();
      return createReadStream(p);
    },
    async delete(keys) {
      for (const k of keys) rmSync(pathOf(k), { force: true });
    },
    async list(prefix) {
      return walk(base)
        .map((f) => relative(base, f).split(sep).join("/"))
        .filter((k) => !k.endsWith(".part") && k.startsWith(prefix))
        .sort();
    },
  };
}

/** The part of `@aws-sdk/client-s3` this store uses (so tests can inject a fake module). */
export interface S3Module {
  S3Client: new (cfg: Record<string, unknown>) => { send(cmd: unknown): Promise<unknown> };
  PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
  DeleteObjectsCommand: new (input: Record<string, unknown>) => unknown;
  ListObjectsV2Command: new (input: Record<string, unknown>) => unknown;
}

export function s3ObjectStore(o: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Tests: a fake of the SDK module. Default: `import('@aws-sdk/client-s3')` on first use. */
  sdk?: () => Promise<S3Module>;
}): ObjectStore {
  let ready: Promise<{ mod: S3Module; client: { send(cmd: unknown): Promise<unknown> } }> | null =
    null;
  const load = () => {
    ready ??= (
      o.sdk ?? (() => import("@aws-sdk/client-s3") as unknown as Promise<S3Module>)
    )().then((mod) => ({
      mod,
      client: new mod.S3Client({
        endpoint: o.endpoint,
        region: o.region,
        forcePathStyle: true,
        credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
      }),
    }));
    return ready;
  };
  return {
    async put(key, body, bytes) {
      assertKey(key);
      const { mod, client } = await load();
      await client.send(
        new mod.PutObjectCommand({
          Bucket: o.bucket,
          Key: key,
          Body: body,
          ContentLength: bytes,
          ContentType: "application/octet-stream",
        }),
      );
    },
    async get(key) {
      assertKey(key);
      const { mod, client } = await load();
      try {
        const res = (await client.send(
          new mod.GetObjectCommand({ Bucket: o.bucket, Key: key }),
        )) as {
          Body?: NodeJS.ReadableStream;
        };
        if (!res.Body) throw new ObjectNotFoundError();
        return res.Body;
      } catch (err) {
        if ((err as { name?: string }).name === "NoSuchKey") throw new ObjectNotFoundError();
        throw err;
      }
    },
    async delete(keys) {
      if (keys.length === 0) return;
      for (const k of keys) assertKey(k);
      const { mod, client } = await load();
      for (let i = 0; i < keys.length; i += 1000) {
        const res = (await client.send(
          new mod.DeleteObjectsCommand({
            Bucket: o.bucket,
            Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
          }),
        )) as { Errors?: unknown[] };
        if (res.Errors?.length) throw new Error("some objects could not be deleted");
      }
    },
    async list(prefix) {
      const { mod, client } = await load();
      const out: string[] = [];
      let token: string | undefined;
      do {
        const res = (await client.send(
          new mod.ListObjectsV2Command({
            Bucket: o.bucket,
            Prefix: prefix,
            ...(token ? { ContinuationToken: token } : {}),
          }),
        )) as {
          Contents?: Array<{ Key?: string }>;
          IsTruncated?: boolean;
          NextContinuationToken?: string;
        };
        for (const c of res.Contents ?? []) if (c.Key) out.push(c.Key);
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return out.sort();
    },
  };
}
