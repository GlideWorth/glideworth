import { createContext, useContext, useMemo } from "react";
import { createFormatter, type Formatter } from "./format";
import type { Host, HostState } from "./host";
import { errorFrom, ToolError } from "./routing";
import type { PlanRef, ToolResult, WidgetPayload } from "./types";

/** Delays the views use; tests shorten them. */
export interface Timing {
  /** Wait before re-running a what-if after a stepper change. */
  debounceMs: number;
  /** Pause between get_job polls, growing with each poll that is still running. */
  pollBackoffMs: readonly number[];
  /** Stop polling after this long and offer a retry. */
  pollGiveUpMs: number;
  /** Seconds get_job waits server-side per poll. */
  pollWaitSeconds: number;
}

export const DEFAULT_TIMING: Timing = {
  debounceMs: 400,
  pollBackoffMs: [500, 1000, 2000, 4000, 8000],
  pollGiveUpMs: 3 * 60 * 1000,
  pollWaitSeconds: 20,
};

export interface WidgetApi {
  host: Host;
  hostState: HostState;
  timing: Timing;
  /** Calls a tool; throws ToolError when the result is an error. */
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Opens a view on top of the current one (shows Back). */
  push(payload: WidgetPayload): void;
  /** Swaps the current view (a pending run that finished). */
  replace(payload: WidgetPayload): void;
  back(): void;
  canGoBack: boolean;
}

export const WidgetContext = createContext<WidgetApi | null>(null);

export function useWidget(): WidgetApi {
  const api = useContext(WidgetContext);
  if (!api) throw new Error("useWidget outside WidgetContext");
  return api;
}

export function useFormatter(plan: PlanRef): Formatter {
  const { hostState } = useWidget();
  const locale = hostState.context.locale;
  return useMemo(() => createFormatter(locale, plan.currency), [locale, plan.currency]);
}

export async function callOrThrow(
  host: Host,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const result = await host.callTool({ name, arguments: args });
  if (result.isError) throw new ToolError(errorFrom(result));
  return result;
}

export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}
