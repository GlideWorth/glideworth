/**
 * /llms.txt and /llms-full.txt, in the layout from https://llmstxt.org/ : a title, a blockquote
 * summary, short paragraphs, then sections of links. Wording that states a price, the trial or the
 * MCP address is built from src/config, so it cannot drift from the pages.
 */
import { priceSentence } from "../config/pricing";
import { site } from "../config/site";
import { facts } from "./facts";

export interface LlmsLink {
  name: string;
  /** Absolute https URL. */
  url: string;
  /** One line. Omitted when the link's name is enough. */
  note?: string;
}

export interface LlmsSection {
  heading: string;
  body?: string[];
  links: LlmsLink[];
}

export interface LlmsDoc {
  title: string;
  summary: string;
  body?: string[];
  sections: LlmsSection[];
}

/** "https://app.glideworth.com/mcp" — the hosted server mounts MCP at /mcp. */
export function hostedMcpUrl(): string {
  return `${site.appUrl}/mcp`;
}

/** Trial, price and the free self-hosted build, in one paragraph. */
export function pricingParagraph(): string {
  return `${priceSentence()} Self-hosting is free, under the ${site.license} licence, with the same planner.`;
}

/** Where an assistant connects, and how big the API and the tool list are. */
export function mcpParagraph(): string {
  return `The hosted MCP server is ${hostedMcpUrl()} (${facts.mcpTools} tools, ${facts.mcpReadTools} of them read-only and ${facts.mcpWriteTools} that can write). The hosted REST API exposes ${facts.apiOperations} operations. A self-hosted server serves MCP at /mcp on its own origin.`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function linkLine(link: LlmsLink): string {
  const name = oneLine(link.name);
  const note = link.note ? oneLine(link.note) : "";
  return note ? `- [${name}](${link.url}): ${note}` : `- [${name}](${link.url})`;
}

/** The markdown document. A trailing newline, and no trailing spaces. */
export function renderLlms(doc: LlmsDoc): string {
  const lines: string[] = [`# ${oneLine(doc.title)}`, "", `> ${oneLine(doc.summary)}`, ""];
  for (const paragraph of doc.body ?? []) lines.push(oneLine(paragraph), "");
  for (const section of doc.sections) {
    if (section.links.length === 0 && (section.body ?? []).length === 0) continue;
    lines.push(`## ${oneLine(section.heading)}`, "");
    for (const paragraph of section.body ?? []) lines.push(oneLine(paragraph), "");
    for (const link of section.links) lines.push(linkLine(link));
    if (section.links.length > 0) lines.push("");
  }
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}
