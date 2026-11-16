#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { runCli } from "./run.js";

const code = await runCli(process.argv.slice(2), {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, content) => writeFileSync(path, content, "utf8"),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  now: () => new Date(),
});
process.exitCode = code;
