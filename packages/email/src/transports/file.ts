import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nodemailer from "nodemailer";
import {
  type EmailTransport,
  EmailTransportError,
  type OutgoingEmail,
  type StoredEmail,
} from "../types.js";
import { toMailOptions } from "./compose.js";
import { guard } from "./memory.js";

const URL_RE = /https?:\/\/[^\s<>"']+/g;

/** Links in the plain-text body, in order, without duplicates or trailing punctuation. */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?)\]]+$/, "");
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

const builder = nodemailer.createTransport({
  streamTransport: true,
  buffer: true,
  newline: "unix",
});

/**
 * Development transport: writes `<timestamp>-<id>.eml` and `.json` to `dir` and keeps an index. Existing
 * `.json` files in `dir` are loaded on creation so the index survives a restart. Bodies and links are
 * stored: use only in development and tests.
 */
export function fileTransport(o: { dir: string }): EmailTransport & {
  list(): StoredEmail[];
  latestTo(email: string): StoredEmail | undefined;
  clear(): void;
} {
  const files = new Map<string, string[]>();
  const index: StoredEmail[] = [];

  try {
    for (const f of readdirSync(o.dir)
      .filter((n) => n.endsWith(".json"))
      .sort()) {
      try {
        const stored = JSON.parse(readFileSync(join(o.dir, f), "utf8")) as StoredEmail;
        if (stored && typeof stored.id === "string" && stored.message) {
          index.push(stored);
          files.set(stored.id, [f, f.replace(/\.json$/, ".eml")]);
        }
      } catch {
        // Ignore files that are not ours.
      }
    }
  } catch {
    // Directory does not exist yet.
  }

  return {
    name: "file",
    async send(msg: OutgoingEmail) {
      guard("file", msg);
      const id = randomUUID();
      const at = new Date().toISOString();
      const base = `${at.replace(/[-:.]/g, "")}-${id}`;
      try {
        mkdirSync(o.dir, { recursive: true });
        const built = await builder.sendMail(toMailOptions(msg));
        const stored: StoredEmail = {
          id,
          at,
          message: structuredClone(msg),
          links: extractLinks(msg.text),
        };
        writeFileSync(join(o.dir, `${base}.eml`), built.message as Buffer);
        writeFileSync(join(o.dir, `${base}.json`), `${JSON.stringify(stored, null, 2)}\n`);
        index.push(stored);
        files.set(id, [`${base}.json`, `${base}.eml`]);
      } catch (e) {
        throw new EmailTransportError(
          "file",
          "write_failed",
          false,
          e instanceof Error ? e.message : "write failed",
        );
      }
      return { providerMessageId: id };
    },
    list: () => [...index],
    latestTo(email) {
      const want = email.trim().toLowerCase();
      for (let i = index.length - 1; i >= 0; i--) {
        const s = index[i];
        if (s && s.message.to.email.toLowerCase() === want) return s;
      }
      return undefined;
    },
    clear() {
      for (const names of files.values())
        for (const n of names) rmSync(join(o.dir, n), { force: true });
      files.clear();
      index.length = 0;
    },
  };
}
