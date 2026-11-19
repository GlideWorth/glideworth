import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { site } from "../../config/site";

const dir = fileURLToPath(new URL(".", import.meta.url));
const suffix = ` · ${site.name}`;

function titleOf(source: string): string | undefined {
  const line = source.split("\n").find((entry) => entry.startsWith("title:"));
  if (!line) return undefined;
  return line
    .slice("title:".length)
    .trim()
    .replace(/^["']|["']$/g, "");
}

describe("blog titles", () => {
  const files = readdirSync(dir).filter((name) => name.endsWith(".mdx"));

  it.each(files)("%s stays within 60 characters with the site name", (name) => {
    const title = titleOf(readFileSync(join(dir, name), "utf8"));
    expect(title, name).toBeTruthy();
    expect(`${title}${suffix}`.length, `${title}${suffix}`).toBeLessThanOrEqual(60);
  });
});
