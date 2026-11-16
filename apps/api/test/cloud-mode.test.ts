/**
 * T-MODE (design section 10): one image, two modes.
 *
 *  - Self-host registers none of the cloud routes, and the module graph of a running self-host server contains
 *    no `@glideworth/cloud`, `@glideworth/billing`, `@glideworth/email` and no `stripe` (checked in a child
 *    process that records every module it resolves; the same probe run in cloud mode sees them, so the probe
 *    itself is proven to work).
 *  - Cloud refuses to start on each missing or forbidden variable, naming it and never echoing its value.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { start } from "@glideworth/cloud/server";
import { afterAll, describe, expect, it } from "vitest";
import { resolveMode } from "../src/config.js";
import { createCloudHost } from "../src/cloud-host.js";
import { cloudEnv } from "./cloud-harness.js";
import { setup } from "./helpers.js";

const API = resolve(import.meta.dirname, "..");
const SERVER = join(API, "src", "server.ts");
const dirs: string[] = [];
const tmp = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `gw-mode-${tag}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });

/** Start `server.ts` in a child, record every module URL it resolves, report once it listens. */
async function loadedModules(env: NodeJS.ProcessEnv): Promise<{ urls: string[]; out: string }> {
  const dir = tmp("probe");
  const probe = join(dir, "probe.mjs");
  const report = join(dir, "modules.json");
  writeFileSync(
    probe,
    `import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
const seen = new Set();
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    seen.add(r.url);
    return r;
  },
});
const report = () => {
  writeFileSync(${JSON.stringify(report)}, JSON.stringify([...seen]));
  process.exit(0);
};
setTimeout(report, Number(process.env.PROBE_MS ?? 4000));
await import(${JSON.stringify(SERVER)});
`,
  );
  return new Promise((res, rej) => {
    const child = spawn(
      process.execPath,
      ["--conditions=@glideworth/source", "--import", "tsx", probe],
      { cwd: API, env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", rej);
    child.on("exit", () => {
      let urls: string[] = [];
      try {
        urls = JSON.parse(readFileSync(report, "utf8")) as string[];
      } catch {
        urls = [];
      }
      res({ urls, out });
    });
  });
}

const CLOUD_MODULES =
  /\/packages\/(cloud|billing|email)\/|@glideworth\/(cloud|billing|email)|\/node_modules\/stripe\/|\/node_modules\/\.pnpm\/stripe@/;

describe("self-host", () => {
  it("registers none of the cloud routes", async () => {
    const h = setup();
    for (const [method, path] of [
      ["POST", "/api/v1/auth/signup"],
      ["GET", "/api/v1/billing"],
      ["POST", "/api/v1/billing/checkout"],
      ["POST", "/stripe/webhook"],
      ["GET", "/email/unsubscribe"],
      ["GET", "/api/v1/workspaces"],
      ["GET", "/api/v1/workspace/members"],
      ["GET", "/api/v1/account/sessions"],
    ] as const) {
      const r = await h.call(path, { method, ...(method === "POST" ? { body: {} } : {}) });
      expect([401, 404], `${method} ${path}`).toContain(r.status);
      expect(r.json.error.code).toMatch(/^(NOT_FOUND|UNAUTHORIZED)$/);
    }
    const doc = (await h.call("/openapi.json")).json as { paths: Record<string, unknown> };
    for (const p of Object.keys(doc.paths))
      expect(p).not.toMatch(/^\/api\/v1\/(account|workspaces?|billing)|^\/stripe|^\/email/);
    h.close();
  });

  it("loads no cloud package and no stripe; the same probe sees them in cloud mode", async () => {
    const dataDir = tmp("selfhost");
    const self = await loadedModules({
      NODE_ENV: "test",
      GLIDEWORTH_API_PORT: String(await freePort()),
      GLIDEWORTH_HOST: "127.0.0.1",
      GLIDEWORTH_DATA_DIR: dataDir,
      GLIDEWORTH_SEED_SAMPLE: "false",
      GLIDEWORTH_SCHEDULER: "false",
    });
    expect(self.out).toContain("server on http://127.0.0.1:");
    expect(self.urls.length).toBeGreaterThan(100);
    expect(self.urls.filter((u) => CLOUD_MODULES.test(u))).toEqual([]);

    const cloudDir = tmp("cloud");
    const cloud = await loadedModules({
      ...cloudEnv(cloudDir),
      GLIDEWORTH_API_PORT: String(await freePort()),
      GLIDEWORTH_HOST: "127.0.0.1",
      GLIDEWORTH_OPS_LISTEN: `127.0.0.1:${await freePort()}`,
    });
    expect(cloud.out).toContain("cloud.listening");
    expect(cloud.urls.some((u) => /\/packages\/cloud\//.test(u))).toBe(true);
    expect(cloud.urls.some((u) => /\/packages\/billing\//.test(u))).toBe(true);
  }, 60_000);

  it("GLIDEWORTH_MODE (and CAIRN_MODE) select the mode; anything else is refused", () => {
    expect(resolveMode({})).toBe("selfhost");
    expect(resolveMode({ GLIDEWORTH_MODE: "cloud" })).toBe("cloud");
    expect(resolveMode({ CAIRN_MODE: "cloud" })).toBe("cloud");
    expect(resolveMode({ GLIDEWORTH_MODE: "selfhost", CAIRN_MODE: "cloud" })).toBe("selfhost");
    expect(() => resolveMode({ GLIDEWORTH_MODE: "hosted" })).toThrow(/GLIDEWORTH_MODE/);
  });
});

describe("cloud start-up refusals", () => {
  const boot = (env: NodeJS.ProcessEnv) =>
    start({
      env,
      host: createCloudHost({ webDist: null }),
      listen: { host: "127.0.0.1", port: 0, opsPort: 0 },
      timers: false,
      handleSignals: false,
    });
  const SECRET_VALUE = "do-not-echo-this-value-1234567890";

  it.each([
    ["GLIDEWORTH_PUBLIC_URL", { GLIDEWORTH_PUBLIC_URL: "" }],
    ["GLIDEWORTH_SECRETS_KEY", { GLIDEWORTH_SECRETS_KEY: "" }],
    ["GLIDEWORTH_SECRETS_KEY", { GLIDEWORTH_SECRETS_KEY: SECRET_VALUE }],
    ["GLIDEWORTH_BACKUP_KEK", { GLIDEWORTH_BACKUP_KEK: "" }],
    ["GLIDEWORTH_BACKUP_KEK", { GLIDEWORTH_BACKUP_KEK: "abcd" }],
    ["GLIDEWORTH_PRICING_FILE", { GLIDEWORTH_PRICING_FILE: "" }],
    ["GLIDEWORTH_BOOTSTRAP_KEY", { GLIDEWORTH_BOOTSTRAP_KEY: SECRET_VALUE }],
    ["CAIRN_BOOTSTRAP_KEY", { CAIRN_BOOTSTRAP_KEY: SECRET_VALUE }],
    ["GLIDEWORTH_SETUP_TOKEN", { GLIDEWORTH_SETUP_TOKEN: SECRET_VALUE }],
    ["CAIRN_SETUP_TOKEN", { CAIRN_SETUP_TOKEN: SECRET_VALUE }],
    ["GLIDEWORTH_DB_PATH", { GLIDEWORTH_DB_PATH: "/data/glideworth.db" }],
    ["CAIRN_DB_PATH", { CAIRN_DB_PATH: "/data/cairn.db" }],
    ["GLIDEWORTH_WEBHOOK_ALLOW_PRIVATE", { GLIDEWORTH_WEBHOOK_ALLOW_PRIVATE: "true" }],
    ["CAIRN_WEBHOOK_ALLOW_PRIVATE", { CAIRN_WEBHOOK_ALLOW_PRIVATE: "true" }],
    [
      "GLIDEWORTH_EMAIL_TRANSPORT",
      { NODE_ENV: "production", GLIDEWORTH_PUBLIC_URL: "https://x.example" },
    ],
    ["GLIDEWORTH_BILLING", { NODE_ENV: "production", GLIDEWORTH_PUBLIC_URL: "https://x.example" }],
    [
      "GLIDEWORTH_TURNSTILE_SECRET",
      { NODE_ENV: "production", GLIDEWORTH_PUBLIC_URL: "https://x.example" },
    ],
  ] as const)("refuses on %s", async (name, extra) => {
    const env = { ...cloudEnv(tmp("refuse")), ...extra };
    let message = "";
    try {
      const s = await boot(env);
      await s.close();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(name);
    expect(message).not.toContain(SECRET_VALUE);
  });

  it("the server process exits non-zero, naming the variable only", async () => {
    const dataDir = tmp("exit");
    const out = await new Promise<{ code: number | null; text: string }>((res) => {
      const child = spawn(
        process.execPath,
        ["--conditions=@glideworth/source", "--import", "tsx", SERVER],
        {
          cwd: API,
          env: {
            PATH: process.env.PATH,
            ...cloudEnv(dataDir),
            GLIDEWORTH_DB_PATH: join(dataDir, "glideworth.db"),
            GLIDEWORTH_SETUP_TOKEN: SECRET_VALUE,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let text = "";
      child.stdout.on("data", (d) => (text += d));
      child.stderr.on("data", (d) => (text += d));
      child.on("exit", (code) => res({ code, text }));
    });
    expect(out.code).not.toBe(0);
    expect(out.text).toContain("GLIDEWORTH_DB_PATH");
    expect(out.text).toContain("GLIDEWORTH_SETUP_TOKEN");
    expect(out.text).not.toContain(SECRET_VALUE);
  }, 30_000);
});
