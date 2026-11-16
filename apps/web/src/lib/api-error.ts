/**
 * The API client's error type, kept free of Zod and the domain schemas so the app shell can test for
 * it without loading the client (see lib/api-lazy.ts).
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** True when the server does not have this route yet (vs. a real "resource not found"). */
export function isMissingRoute(e: unknown): boolean {
  return (
    e instanceof ApiRequestError &&
    (e.status === 405 || e.status === 501 || (e.status === 404 && e.code !== "NOT_FOUND"))
  );
}
