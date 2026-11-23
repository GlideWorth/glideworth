/**
 * The "For AI agents" section of /llms.txt and /llms-full.txt: where an agent finds the setup guide, the skill
 * and the MCP set-up page. The guide and the skill live in the public repository; the skill is also served by
 * this site (src/pages/.well-known/skills/default/skill.md.ts).
 */
import { absoluteUrl, site } from "../config/site";
import type { LlmsLink } from "./llms";
import { twinPath } from "./markdown-twin";

/** The public repository's raw file URL for a path on main. */
export function rawRepoUrl(path: string): string {
  const repo = new URL(site.repoUrl).pathname.replace(/^\/|\/$/g, "");
  return `https://raw.githubusercontent.com/${repo}/main/${path}`;
}

export const AGENT_SETUP_PATH = "docs/agents/SETUP.md";
export const SKILL_PATH = "/.well-known/skills/default/skill.md";

export const AGENTS_BODY =
  "To install or connect Glideworth for a person, follow the agent setup guide step by step: only the person chooses the passphrase, and plan edits are always proposals the person approves.";

export function agentLinks(): LlmsLink[] {
  return [
    {
      name: "Agent setup guide",
      url: rawRepoUrl(AGENT_SETUP_PATH),
      note: "Self-host with Docker or use the hosted service, create a least-privilege key, connect an MCP client and verify with get_plan_summary.",
    },
    {
      name: "Glideworth agent skill",
      url: absoluteUrl(SKILL_PATH),
      note: "How to use the MCP tools and REST API well: units, the start tool, which tool answers which question, and the propose, approve, apply rule for edits.",
    },
    {
      name: "Connect an AI assistant over MCP",
      url: absoluteUrl(twinPath("/docs/api-and-mcp/mcp-setup/")),
      note: "Claude Code, Claude Desktop, claude.ai, ChatGPT, Codex, Cursor, VS Code and generic clients, with troubleshooting.",
    },
    {
      name: "OpenAPI document (hosted)",
      url: `${site.appUrl}/openapi.json`,
      note: "Every REST operation of the hosted service. A self-hosted server serves its own at /openapi.json.",
    },
  ];
}
