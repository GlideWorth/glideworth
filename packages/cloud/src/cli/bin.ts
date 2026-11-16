#!/usr/bin/env node
/** The `glideworth-cloud` executable (see main.ts). */
import { runCli } from "./main.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    // Interactive: read one line without echoing it.
    process.stderr.write("password: ");
    process.stdin.setRawMode(true);
    let line = "";
    for await (const chunk of process.stdin) {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stderr.write("\n");
          process.stdin.pause();
          return line;
        }
        if (ch === "\u0003") process.exit(130);
        line = ch === "\u007f" ? line.slice(0, -1) : line + ch;
      }
    }
    return line;
  }
  const parts: Buffer[] = [];
  for await (const c of process.stdin) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString("utf8");
}

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  readStdin,
});
process.exit(code);
