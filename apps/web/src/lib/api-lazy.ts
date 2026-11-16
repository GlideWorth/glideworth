/**
 * The typed API client validates every response with the domain's Zod schemas (lib/api.ts), which
 * is most of the weight of @glideworth/core's schema code. The app shell (workspace, session, settings,
 * notifications, command actions) loads it on first use instead of at start-up, so first paint never
 * waits for Zod or the schemas; feature pages import lib/api directly (they are lazy chunks anyway).
 */
import type { ApiClient } from "./api";

export { ApiRequestError, isMissingRoute } from "./api-error";

let client: Promise<ApiClient> | undefined;

export function loadApi(): Promise<ApiClient> {
  client ??= import("./api").then((m) => m.api);
  return client;
}
