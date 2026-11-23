/**
 * /.well-known/skills/default/skill.md — the Glideworth agent skill, for assistants that discover skills by
 * URL. The one source is skills/glideworth/SKILL.md in the repository (copied into ~/.claude/skills or a
 * project's .claude/skills by people who install it); this route serves that file unchanged at build time.
 */
import type { APIRoute } from "astro";
import skill from "../../../../../../../skills/glideworth/SKILL.md?raw";

export const GET: APIRoute = () =>
  new Response(skill, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
