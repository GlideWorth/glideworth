import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  dateFromFrontmatter,
  findRepoRoot,
  gitCommitDates,
  isoDay,
  lastmodForPath,
  lastmodForUrl,
  parseGitNameLog,
  readSourceDates,
  sourceCandidates,
  type LastmodSources,
} from "./sitemap-dates";

const siteRoot = fileURLToPath(new URL("../..", import.meta.url));

function sources(partial: Partial<LastmodSources> & Pick<LastmodSources, "read">): LastmodSources {
  return {
    list: () => [],
    gitDate: () => undefined,
    committed: {},
    repoPrefix: "apps/site",
    ...partial,
  };
}

describe("dateFromFrontmatter", () => {
  it("prefers an updated date over the published date and ignores the body", () => {
    const source = `---
title: Coast
pubDate: 2026-11-16
updatedDate: 2026-11-18
---

The body mentions pubDate: 2020-01-01 and must not win.
`;
    expect(dateFromFrontmatter(source)).toBe("2026-11-18");
  });

  it("reads lastChecked, lastUpdated, checkedOn and a date-only published field", () => {
    expect(dateFromFrontmatter("---\nlastChecked: 2026-11-17\n---\n")).toBe("2026-11-17");
    expect(dateFromFrontmatter('---\nlastUpdated: "2026-11-18"\n---\n')).toBe("2026-11-18");
    expect(dateFromFrontmatter("---\ncheckedOn: 2026-11-16\n---\n")).toBe("2026-11-16");
    expect(dateFromFrontmatter("---\ndate: 2026-11-15\n---\n")).toBe("2026-11-15");
  });

  it("rejects a missing frontmatter block and an impossible day", () => {
    expect(dateFromFrontmatter("no frontmatter\npubDate: 2026-11-16\n")).toBeUndefined();
    expect(dateFromFrontmatter("---\npubDate: 2026-13-40\n---\n")).toBeUndefined();
    expect(isoDay("2026-02-31")).toBeUndefined();
  });
});

describe("sourceCandidates", () => {
  it("points a post, a country and a doc at the content file, not the shared template", () => {
    expect(sourceCandidates("/blog/coast-fire-explained/")[0]).toBe(
      "src/content/blog/coast-fire-explained.mdx",
    );
    expect(sourceCandidates("/planning/uk/")[0]).toBe("src/content/countries/uk.mdx");
    expect(sourceCandidates("/docs/methodology/monte-carlo/")[0]).toBe(
      "src/content/docs/methodology/monte-carlo.mdx",
    );
    expect(sourceCandidates("/pricing/")[0]).toBe("src/pages/pricing.astro");
    expect(sourceCandidates("/authors/glideworth-team/")[0]).toBe(
      "src/content/authors/authors.json",
    );
    expect(sourceCandidates("/")[0]).toBe("src/pages/index.astro");
  });
});

describe("lastmodForPath", () => {
  it("uses frontmatter before git, and git before the committed snapshot", () => {
    const read = (path: string) =>
      path === "src/content/blog/coast-fire-explained.mdx"
        ? "---\npubDate: 2026-11-16\n---\n"
        : undefined;
    expect(
      lastmodForPath("/blog/coast-fire-explained/", sources({ read, gitDate: () => "2026-11-19" })),
    ).toBe("2026-11-16");

    const page = "src/pages/pricing.astro";
    expect(
      lastmodForPath(
        "/pricing/",
        sources({
          read: (path) => (path === page ? "---\nno date here\n" : undefined),
          gitDate: (path) => (path === `apps/site/${page}` ? "2026-11-12" : undefined),
          committed: { [`apps/site/${page}`]: "2020-01-01" },
        }),
      ),
    ).toBe("2026-11-12");

    expect(
      lastmodForPath(
        "/pricing/",
        sources({
          read: (path) => (path === page ? "<h1>Pricing</h1>" : undefined),
          committed: { [`apps/site/${page}`]: "2026-11-12" },
        }),
      ),
    ).toBe("2026-11-12");
  });

  it("dates a listing from its newest published entry and skips drafts", () => {
    const files: Record<string, string> = {
      "src/pages/changelog.astro": "---\nimport nothing\n---\n",
      "src/content/changelog/old.mdx": "---\ndate: 2026-11-15\n---\n",
      "src/content/changelog/new.mdx": "---\ndate: 2026-11-18\n---\n",
      "src/content/changelog/draft.mdx": "---\ndate: 2026-11-19\ndraft: true\n---\n",
    };
    expect(
      lastmodForPath(
        "/changelog/",
        sources({
          read: (path) => files[path],
          list: () =>
            Object.keys(files).filter((path) => path.startsWith("src/content/changelog/")),
          gitDate: () => "2020-01-01",
        }),
      ),
    ).toBe("2026-11-18");
  });

  it("returns nothing when the page has no file, no commit and no snapshot", () => {
    expect(lastmodForPath("/missing/", sources({ read: () => undefined }))).toBeUndefined();
  });
});

describe("parseGitNameLog", () => {
  it("keeps the first date seen for a path, which is the newest commit", () => {
    const log = [
      "2026-11-18",
      "apps/site/src/pages/pricing.astro",
      "",
      "2026-11-01",
      "apps/site/src/pages/pricing.astro",
      "apps/site/src/pages/index.astro",
    ].join("\n");
    const dates = parseGitNameLog(log);
    expect(dates.get("apps/site/src/pages/pricing.astro")).toBe("2026-11-18");
    expect(dates.get("apps/site/src/pages/index.astro")).toBe("2026-11-01");
  });
});

describe("the built site's dates", () => {
  it("reads the Coast FIRE post from its pubDate, not from git or the build clock", () => {
    expect(lastmodForUrl("https://glideworth.com/blog/coast-fire-explained/")).toBe("2026-11-16");
  });

  it("dates the changelog from the newest entry", () => {
    expect(lastmodForUrl("https://glideworth.com/changelog/")).toBe("2026-11-18");
  });

  it("keeps source-dates.json equal to git when the clone has full history", () => {
    const repoRoot = findRepoRoot(siteRoot);
    let shallow = true;
    try {
      shallow =
        execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim() === "true";
    } catch {
      shallow = true;
    }
    if (shallow) return;

    const git = gitCommitDates(repoRoot);
    const snapshot = readSourceDates(siteRoot);
    const roots = ["apps/site/src/pages/", "apps/site/src/content/"];
    for (const [file, date] of git) {
      if (!roots.some((root) => file.startsWith(root))) continue;
      if (!existsSync(join(repoRoot, file))) continue;
      expect(snapshot[file], file).toBe(date);
    }
    for (const [file, date] of Object.entries(snapshot)) {
      expect(git.get(file), file).toBe(date);
    }
  });
});
