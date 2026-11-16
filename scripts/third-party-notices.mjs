#!/usr/bin/env node
/**
 * Generates THIRD-PARTY-NOTICES.md: every production dependency of every workspace package, with its
 * version, licence and repository, grouped by licence. Licences that are not on the allow-list for
 * AGPL-3.0 distribution are flagged. Node standard library only.
 *
 *   node scripts/third-party-notices.mjs            write THIRD-PARTY-NOTICES.md
 *   node scripts/third-party-notices.mjs --check    exit 1 if the file is out of date or anything is flagged
 *   node scripts/third-party-notices.mjs --out FILE write somewhere else
 *
 * It reads the installed tree (run `pnpm install` first) and follows "dependencies" and
 * "optionalDependencies" (and non-optional "peerDependencies" when installed) from each workspace
 * package, using Node's resolution from the real path of each package, so it works with pnpm's layout.
 * devDependencies are not included: they are build tools and are not distributed. The web app's bundler
 * output only contains what is listed under its "dependencies", so that is the set that is reported.
 * The output has no timestamps, so it is reproducible.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Licences compatible with distributing this project under AGPL-3.0 without special handling. */
const ALLOWED = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
  "BlueOak-1.0.0",
  "Python-2.0",
  "MPL-2.0",
]);
/** Allowed, with a note that must be read. */
const NOTES = new Map([
  [
    "MPL-2.0",
    "Allowed. File-level copyleft: changes to the MPL-licensed files themselves must be published under MPL-2.0. Unmodified use in an AGPL-3.0 work is compatible (MPL-2.0 section 3.3).",
  ],
  ["Python-2.0", "Allowed. Permissive; keep the copyright notice and licence text."],
  [
    "Apache-2.0",
    "Allowed. Compatible with AGPL-3.0 (not with GPL-2.0-only). Keep NOTICE files if present.",
  ],
]);

const args = process.argv.slice(2);
const check = args.includes("--check");
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(ROOT, "THIRD-PARTY-NOTICES.md");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// ---------------------------------------------------------------- workspace discovery
function workspacePackages() {
  const dirs = [];
  for (const group of ["packages", "apps"]) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(join(base, d.name, "package.json")))
        dirs.push(join(base, d.name));
    }
  }
  return dirs.sort();
}

// ---------------------------------------------------------------- resolution
/** Find `<name>/package.json` by walking up node_modules directories from `fromDir`. */
function findPackage(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function depNames(pkg) {
  const names = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  for (const name of Object.keys(pkg.peerDependencies ?? {})) {
    if (!pkg.peerDependenciesMeta?.[name]?.optional) names.add(name);
  }
  return [...names];
}

// ---------------------------------------------------------------- licence handling
function licenceOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license.trim();
  if (pkg.license && typeof pkg.license === "object" && pkg.license.type)
    return String(pkg.license.type);
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    return `(${pkg.licenses.map((l) => (typeof l === "string" ? l : l.type)).join(" OR ")})`;
  }
  return "UNKNOWN";
}

/** Evaluate a (simple) SPDX expression: AND needs all allowed, OR needs one. Parentheses supported. */
function isAllowed(expr) {
  const tokens = expr.replace(/\(/g, " ( ").replace(/\)/g, " ) ").split(/\s+/).filter(Boolean);
  let i = 0;
  const parseOr = () => {
    let v = parseAnd();
    while (tokens[i]?.toUpperCase() === "OR") {
      i++;
      const r = parseAnd();
      v = v || r;
    }
    return v;
  };
  const parseAnd = () => {
    let v = parseAtom();
    while (tokens[i]?.toUpperCase() === "AND") {
      i++;
      const r = parseAtom();
      v = v && r;
    }
    return v;
  };
  const parseAtom = () => {
    const t = tokens[i++];
    if (t === "(") {
      const v = parseOr();
      i++; // ')'
      return v;
    }
    if (t === undefined) return false;
    return ALLOWED.has(t.replace(/\+$/, ""));
  };
  try {
    return parseOr();
  } catch {
    return false;
  }
}

function repoUrl(pkg) {
  let r = pkg.repository;
  if (r && typeof r === "object") r = r.url;
  if (typeof r !== "string" || !r) return pkg.homepage || "";
  r = r
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://");
  const short = r.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/);
  if (short) return `https://github.com/${short[1]}`;
  return r.replace(/^git@([^:]+):/, "https://$1/");
}

// ---------------------------------------------------------------- walk
const workspace = workspacePackages();
const workspaceNames = new Set(workspace.map((d) => readJson(join(d, "package.json")).name));
/** realpath -> { name, version, licence, repository, usedBy:Set } */
const found = new Map();
const missing = new Map(); // name -> Set(workspace)

for (const wsDir of workspace) {
  const wsPkg = readJson(join(wsDir, "package.json"));
  const wsLabel = relative(ROOT, wsDir);
  const seen = new Set();
  const visit = (pkg, fromDir, optionalPath) => {
    for (const name of depNames(pkg)) {
      if (workspaceNames.has(name)) continue;
      const dir = findPackage(name, fromDir);
      if (!dir) {
        const isOptional = optionalPath || pkg.optionalDependencies?.[name] !== undefined;
        if (!isOptional) {
          if (!missing.has(name)) missing.set(name, new Set());
          missing.get(name).add(wsLabel);
        }
        continue;
      }
      let entry = found.get(dir);
      if (!entry) {
        const p = readJson(join(dir, "package.json"));
        entry = {
          name: p.name ?? name,
          version: p.version ?? "?",
          licence: licenceOf(p),
          repository: repoUrl(p),
          usedBy: new Set(),
          dir,
        };
        found.set(dir, entry);
      }
      entry.usedBy.add(wsLabel);
      if (seen.has(dir)) continue;
      seen.add(dir);
      visit(
        readJson(join(dir, "package.json")),
        dir,
        optionalPath || pkg.optionalDependencies?.[name] !== undefined,
      );
    }
  };
  visit(wsPkg, wsDir, false);
}

if (found.size === 0) {
  console.error("No dependencies found. Run `pnpm install` first.");
  process.exit(2);
}

// ---------------------------------------------------------------- report
const entries = [...found.values()].sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
const byLicence = new Map();
for (const e of entries) {
  if (!byLicence.has(e.licence)) byLicence.set(e.licence, []);
  byLicence.get(e.licence).push(e);
}
const licences = [...byLicence.keys()].sort(
  (a, b) => byLicence.get(b).length - byLicence.get(a).length || a.localeCompare(b),
);
const flagged = entries.filter((e) => !isAllowed(e.licence));

const lines = [];
lines.push("# Third-party notices");
lines.push("");
lines.push(
  "Glideworth includes or links the open-source packages below. Each is the work of its authors and is used under the licence shown. This file is generated by `scripts/third-party-notices.mjs` from the installed production dependencies of every workspace package; do not edit it by hand. Regenerate it after changing dependencies (`pnpm install`, then `node scripts/third-party-notices.mjs`).",
);
lines.push("");
lines.push(
  "Scope: production dependencies (`dependencies`, `optionalDependencies`, required `peerDependencies`) of `packages/*` and `apps/*`, followed transitively. Development tools (compilers, test runners, linters, bundlers) are not distributed and are not listed. The licence text of each package ships inside the package itself. Bundled data sets are covered by `DATA-LICENSES.md`.",
);
lines.push("");
lines.push("## Summary");
lines.push("");
lines.push(`${entries.length} packages under ${licences.length} licence expressions.`);
lines.push("");
lines.push("| Licence | Packages | Status |");
lines.push("|---|---:|---|");
for (const l of licences) {
  const status = isAllowed(l)
    ? NOTES.has(l)
      ? "allowed (see note)"
      : "allowed"
    : "**FLAGGED: review before distribution**";
  lines.push(`| ${l} | ${byLicence.get(l).length} | ${status} |`);
}
lines.push("");
lines.push("## Flagged packages");
lines.push("");
if (flagged.length === 0) {
  lines.push("None. Every production dependency is under a licence on the allow-list.");
} else {
  lines.push(
    "These packages have a licence that is not on the allow-list (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, CC0-1.0, Unlicense, BlueOak-1.0.0, Python-2.0, MPL-2.0) and must be reviewed by the project owner before distribution.",
  );
  lines.push("");
  lines.push("| Package | Version | Licence | Used by | Repository |");
  lines.push("|---|---|---|---|---|");
  for (const e of flagged) {
    lines.push(
      `| ${e.name} | ${e.version} | ${e.licence} | ${[...e.usedBy].sort().join(", ")} | ${e.repository || "n/a"} |`,
    );
  }
}
if (missing.size) {
  lines.push("");
  lines.push("## Not installed");
  lines.push("");
  lines.push("Declared but not found in `node_modules` (so not inspected): ");
  for (const [name, by] of [...missing].sort())
    lines.push(`- ${name} (${[...by].sort().join(", ")})`);
}
lines.push("");
lines.push("## Packages by licence");
for (const l of licences) {
  const list = byLicence.get(l);
  lines.push("");
  lines.push(`### ${l} (${list.length})`);
  lines.push("");
  const note = NOTES.get(l);
  if (note) {
    lines.push(`Note: ${note}`);
    lines.push("");
  }
  if (!isAllowed(l)) {
    lines.push("**Flagged: not on the allow-list.**");
    lines.push("");
  }
  lines.push("| Package | Version | Repository |");
  lines.push("|---|---|---|");
  for (const e of list) lines.push(`| ${e.name} | ${e.version} | ${e.repository || "n/a"} |`);
}
lines.push("");
const text = lines.join("\n");

console.log(
  `${entries.length} production packages, ${licences.length} licence expressions, ${flagged.length} flagged.`,
);
for (const e of flagged)
  console.log(
    `  FLAGGED ${e.name}@${e.version}  ${e.licence}  (${[...e.usedBy].sort().join(", ")})`,
  );

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== text) {
    console.error(
      `${relative(ROOT, OUT)} is out of date. Run: node scripts/third-party-notices.mjs`,
    );
    process.exit(1);
  }
  if (flagged.length) process.exit(1);
  console.log(`${relative(ROOT, OUT)} is up to date.`);
} else {
  writeFileSync(OUT, text);
  console.log(`Wrote ${relative(ROOT, OUT)}`);
}
