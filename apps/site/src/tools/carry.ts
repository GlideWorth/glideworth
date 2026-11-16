/**
 * The hand-off into the full planner: a sign-up link that carries the calculator's inputs, so the app
 * can pre-fill a plan. Format (documented in README.md for the app team):
 *
 *   https://app.glideworth.com/signup?from=tool&tool=<id>&v=1&<the calculator's own query keys>
 *
 * The keys and units are the same as the calculator page's own URL (state.ts). The link is built in
 * the browser from what the visitor typed; nothing is sent until the visitor follows it.
 */
import { site } from "../config/site";
import { toQuery } from "./state";
import type { ToolSpec, Values } from "./types";

export function plannerUrl(spec: ToolSpec, values: Values): string {
  const params = new URLSearchParams({ from: "tool", tool: spec.id });
  const own = new URLSearchParams(toQuery(spec, values));
  for (const [k, v] of own) params.set(k, v);
  return `${site.signupUrl}?${params.toString()}`;
}

/** Whether the hosted planner takes sign-ups yet (site.cloudLaunched). */
export const plannerOpen: boolean = site.cloudLaunched;
