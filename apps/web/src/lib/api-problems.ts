/**
 * Two cloud API answers every screen can meet, whatever it was doing: `402 ACCOUNT_READ_ONLY` (the
 * workspace's trial or subscription ended; writes are refused) and `429 QUOTA_EXCEEDED` (a daily plan
 * limit is used up). The API client reports them here; one host in the shell (components/layout/
 * api-problems-host.tsx) explains them. Kept free of React and of the API client so it is tiny.
 */
export type ApiProblem =
  | { kind: "read-only"; reason?: string }
  | { kind: "quota"; metric?: string; limit?: number; resetsAt?: string };

type Listener = (p: ApiProblem) => void;
const listeners = new Set<Listener>();

export function onApiProblem(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** Called by the API clients for every failed response; ignores anything that is not one of the two. */
export function reportApiProblem(status: number, code: string, details: unknown): void {
  let problem: ApiProblem | null = null;
  if (status === 402 && code === "ACCOUNT_READ_ONLY") {
    const reason = rec(details).reason;
    problem = { kind: "read-only", ...(typeof reason === "string" ? { reason } : {}) };
  } else if (status === 429 && code === "QUOTA_EXCEEDED") {
    const d = rec(details);
    problem = {
      kind: "quota",
      ...(typeof d.metric === "string" ? { metric: d.metric } : {}),
      ...(typeof d.limit === "number" ? { limit: d.limit } : {}),
      ...(typeof d.resetsAt === "string" ? { resetsAt: d.resetsAt } : {}),
    };
  }
  if (problem) for (const fn of listeners) fn(problem);
}

/**
 * True for an error the shell already explains on its own (read-only workspace, daily limit). A screen
 * that toasts its failures skips these, so one failed action shows one message, not two.
 */
export function isExplainedProblem(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const { status, code } = e as { status?: unknown; code?: unknown };
  return (
    (status === 402 && code === "ACCOUNT_READ_ONLY") ||
    (status === 429 && code === "QUOTA_EXCEEDED")
  );
}

const METRIC_LABEL: Record<string, string> = {
  api_request: "API requests",
  job: "background jobs",
  worker_ms: "simulation time",
  webhook_delivery: "webhook deliveries",
  share_read: "share-link views",
};

/** "You have used today's limit of 100 background jobs. It resets at 02:00." (parts the API omits are left out). */
export function describeQuota(p: Extract<ApiProblem, { kind: "quota" }>, locale?: string): string {
  const what = p.metric
    ? (METRIC_LABEL[p.metric] ?? p.metric.replaceAll("_", " "))
    : "a daily limit";
  const limit = p.limit !== undefined ? ` of ${p.limit.toLocaleString(locale)}` : "";
  const at = p.resetsAt && !Number.isNaN(Date.parse(p.resetsAt)) ? new Date(p.resetsAt) : null;
  const when = at
    ? ` It resets ${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at)}.`
    : " It resets daily.";
  return `You have used today's limit${limit} for ${what}.${when}`;
}

export type LoadErrorCopy = { text: string; billing: boolean };

/**
 * What a settings screen says when its list query failed. A 402 means the server answered: the
 * workspace has never had a trial or subscription (no_subscription, which the shell shows no banner for)
 * or is read-only. "Not reachable" is only for a request that got no HTTP answer at all: the cloud client
 * reports that as status 0 / NETWORK, the self-host client lets fetch's TypeError through.
 * `billing` asks the caller to link to the billing section.
 */
export function describeLoadError(
  error: unknown,
  opts: { use: string; forbidden?: string; missing?: string },
): LoadErrorCopy {
  const { status, code, details } = (error && typeof error === "object" ? error : {}) as {
    status?: unknown;
    code?: unknown;
    details?: unknown;
  };
  if (status === 402 && code === "ACCOUNT_READ_ONLY") {
    return rec(details).reason === "no_subscription"
      ? { text: `Subscribe to ${opts.use}.`, billing: true }
      : {
          text: "This workspace is read-only. The owner can subscribe in billing settings.",
          billing: true,
        };
  }
  if (status === 403 && opts.forbidden) return { text: opts.forbidden, billing: false };
  if ((status === 404 || status === 501) && opts.missing)
    return { text: opts.missing, billing: false };
  if (status === 0 || code === "NETWORK" || error instanceof TypeError)
    return { text: "The Glideworth server is not reachable.", billing: false };
  return { text: "Glideworth could not load this. Try again in a moment.", billing: false };
}
