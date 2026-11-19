/**
 * /llms-full.txt — the same map as /llms.txt, plus what each country's tax estimate includes and
 * leaves out, and the legal pages. Built from the page list and collections.
 */
import type { APIRoute } from "astro";
import { llmsFullText } from "../lib/llms-catalog";

export const GET: APIRoute = async () =>
  new Response(await llmsFullText(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
