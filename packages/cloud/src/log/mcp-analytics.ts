/**
 * MCP analytics for the hosted service: PostHog's `@posthog/mcp` instruments each MCP server so a tool call
 * becomes a `$mcp_tool_call` event (tool name, duration, error flag, client name and version), plus the
 * `initialize` and `tools/list` handshakes. Sent to the same PostHog project and behind the same gate as the
 * server error reports (`config.errorReports`), so a self-host copy, which has no token, sends nothing.
 *
 * What leaves is metadata, never content. By default the SDK sends the tool's arguments and result
 * (`$mcp_parameters`, `$mcp_response`), the agent's stated intent and error messages, and it adds `context`,
 * `llm_model` and `conversation_id` arguments to every tool's input schema. Here those arguments are off (the
 * tool schemas clients see are unchanged), `$exception` events are not sent (server errors already go to
 * Error Tracking through the error reporter), and `beforeSend` removes every content property below before an
 * event leaves. No person profile is created (no `identify`: the distinct id is the MCP session's) and
 * PostHog's GeoIP lookup is off (the request comes from our server, not the customer's machine).
 *
 * The MCP endpoint is stateless (a fresh server per request, JSON responses), so `instrument` runs once per
 * request on that request's server; the PostHog client is one per process and batches. `shutdown` flushes
 * what is queued; the server calls it on shutdown.
 */
import { instrument } from "@posthog/mcp";
import { PostHog } from "posthog-node";
import type { Logger } from "./index.js";

/** Properties that carry what a tool was asked or answered, or what went wrong in words. Never sent. */
export const MCP_CONTENT_PROPERTIES = [
  "$mcp_parameters",
  "$mcp_response",
  "$mcp_intent",
  "$mcp_intent_source",
  "$mcp_error_message",
  "$mcp_input_aliases_used",
  "$exception_list",
  "$exception_message",
  "$exception_type",
] as const;

type BeforeSend = NonNullable<NonNullable<Parameters<typeof instrument>[2]>["beforeSend"]>;
type CaptureEvent = Parameters<BeforeSend>[0];

export interface McpAnalytics {
  /** Instrument one MCP server (an `McpServer` from `@modelcontextprotocol/sdk`) before it handles a request. */
  instrument(server: unknown): void;
  /** Send what is queued and stop, waiting at most `timeoutMs`. */
  shutdown(timeoutMs?: number): Promise<void>;
}

export interface PostHogMcpAnalyticsOptions {
  /** The PostHog project token (public by design; the web app uses the same one). */
  token: string;
  /** The PostHog ingestion host, e.g. `https://us.i.posthog.com`. */
  host: string;
  /** `GLIDEWORTH_RELEASE` → `$mcp_server_build`. */
  release?: string | null;
  /** Warnings about the sender itself. */
  log?: Logger;
  /** posthog-node's HTTP client (tests: a capturing fake PostHog). */
  fetch?: typeof fetch;
}

/** Strip content from one event; drop `$exception` events outright. */
export function redactMcpEvent(event: CaptureEvent): CaptureEvent | null {
  if (event.event === "$exception") return null;
  for (const key of MCP_CONTENT_PROPERTIES) delete event.properties[key];
  return event;
}

export function createPostHogMcpAnalytics(o: PostHogMcpAnalyticsOptions): McpAnalytics {
  // Its own client: `instrument` sets `$lib` on the client it is given (PostHog's advice for MCP analytics).
  const posthog = new PostHog(o.token, {
    host: o.host,
    disableGeoip: true,
    ...(o.fetch ? { fetch: o.fetch as never } : {}),
  });
  let warnedAt = Number.NEGATIVE_INFINITY;
  posthog.on("error", (err: unknown) => {
    if (Date.now() - warnedAt < 60_000) return; // one line a minute while PostHog is unreachable
    warnedAt = Date.now();
    o.log?.warn("mcp_analytics.not_sent", { reason: err instanceof Error ? err.name : "unknown" });
  });
  return {
    instrument(server) {
      instrument(server, posthog, {
        context: false,
        captureModel: false,
        enableConversationId: false,
        enableExceptionAutocapture: false,
        beforeSend: redactMcpEvent,
        ...(o.release ? { serverBuild: o.release } : {}),
      });
    },
    shutdown: (timeoutMs = 5_000) => posthog.shutdown(timeoutMs),
  };
}
