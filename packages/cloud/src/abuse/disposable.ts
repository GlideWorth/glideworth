/**
 * Disposable email domains (spec 3.7): the `disposable-email-domains` list (exact domains plus the wildcard
 * list, whose subdomains are all disposable) and a local override (`configureDisposableDomains`, or a file of
 * lines `+domain` to block and `-domain` to allow, `#` comments). A domain is disposable when it or any parent
 * domain is listed and not explicitly allowed. The list is loaded lazily on first use.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { domainToASCII } from "node:url";

let base: Set<string> | null = null;
let wildcard: Set<string> | null = null;
const extraBlock = new Set<string>();
const extraAllow = new Set<string>();

function load(): void {
  if (base && wildcard) return;
  const require = createRequire(import.meta.url);
  base = new Set(
    (require("disposable-email-domains/index.json") as string[]).map((d) => d.toLowerCase()),
  );
  wildcard = new Set(
    (require("disposable-email-domains/wildcard.json") as string[]).map((d) => d.toLowerCase()),
  );
}

const canonical = (domain: string): string => {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  return domainToASCII(d) || d;
};

export function isDisposableEmail(domain: string): boolean {
  if (typeof domain !== "string" || !domain) return false;
  load();
  const d = canonical(domain.includes("@") ? domain.slice(domain.lastIndexOf("@") + 1) : domain);
  const labels = d.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    if (extraAllow.has(candidate)) return false;
    if (extraBlock.has(candidate)) return true;
    if (base?.has(candidate) || wildcard?.has(candidate)) return true;
  }
  return false;
}

/** Replace the local override (process-wide). */
export function configureDisposableDomains(o: {
  block?: readonly string[];
  allow?: readonly string[];
}): void {
  extraBlock.clear();
  extraAllow.clear();
  for (const d of o.block ?? []) extraBlock.add(canonical(d));
  for (const d of o.allow ?? []) extraAllow.add(canonical(d));
}

/** Load the override from a file: `+domain` blocks, `-domain` allows, a bare domain blocks. */
export function loadDisposableOverrideFile(path: string): void {
  const block: string[] = [];
  const allow: string[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    if (line.startsWith("-")) allow.push(line.slice(1));
    else block.push(line.replace(/^\+/, ""));
  }
  configureDisposableDomains({ block, allow });
}
