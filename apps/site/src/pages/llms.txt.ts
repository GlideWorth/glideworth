/** /llms.txt — a short map of the site for language models. Built from the page list and collections. */
import type { APIRoute } from "astro";
import { llmsText } from "../lib/llms-catalog";

export const GET: APIRoute = async () =>
  new Response(await llmsText(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
