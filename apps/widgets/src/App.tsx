import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { callOrThrow, DEFAULT_TIMING, type Timing, type WidgetApi, WidgetContext } from "./context";
import type { Host, HostContext } from "./host";
import { routeToolResult } from "./routing";
import type { ToolResult, WidgetPayload } from "./types";
import { AnswerView } from "./views/answer";
import { CompareView } from "./views/compare";
import { OutcomeView } from "./views/outcome";
import { PendingView } from "./views/pending";
import { ReviewView } from "./views/review";
import { EmptyState, ErrorState } from "./views/status";
import { TaxView } from "./views/tax";
import { YearView } from "./views/year";

function PayloadView({ payload }: { payload: WidgetPayload }) {
  switch (payload.view) {
    case "outcome":
      return <OutcomeView data={payload} />;
    case "pending":
      return <PendingView data={payload} />;
    case "compare":
      return <CompareView data={payload} />;
    case "answer":
      return <AnswerView data={payload} />;
    case "review":
      return <ReviewView data={payload} />;
    case "year":
      return <YearView data={payload} />;
    case "tax":
      return <TaxView data={payload} />;
  }
}

/** Follows the host theme and applies the host's CSS variables over Glideworth's own tokens. */
function useHostAppearance(context: HostContext) {
  const { theme, locale } = context;
  const variables = context.styles?.variables;
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "light" || theme === "dark") root.dataset.theme = theme;
    else delete root.dataset.theme;
  }, [theme]);
  useEffect(() => {
    if (locale) document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    if (!variables) return;
    const root = document.documentElement;
    const set: string[] = [];
    for (const [name, value] of Object.entries(variables)) {
      if (!name.startsWith("--") || typeof value !== "string" || !value) continue;
      root.style.setProperty(name, value);
      set.push(name);
    }
    return () => {
      for (const name of set) root.style.removeProperty(name);
    };
  }, [variables]);
}

const payloadKeys = new WeakMap<WidgetPayload, number>();
let nextPayloadKey = 1;
/** A stable React key per payload object, so a new payload always mounts a fresh view. */
function keyOf(payload: WidgetPayload): number {
  let key = payloadKeys.get(payload);
  if (key === undefined) {
    key = nextPayloadKey++;
    payloadKeys.set(payload, key);
  }
  return key;
}

interface Nav {
  source: ToolResult | null;
  entries: WidgetPayload[];
}

export function App({ host, timing = DEFAULT_TIMING }: { host: Host; timing?: Timing }) {
  const hostState = useSyncExternalStore(host.subscribe, host.getState, host.getState);
  useHostAppearance(hostState.context);
  const { toolResult, cancelled } = hostState;
  const routed = useMemo(() => routeToolResult(toolResult, { cancelled }), [toolResult, cancelled]);
  const [nav, setNav] = useState<Nav>({ source: null, entries: [] });

  // A new tool result starts a new stack.
  const base = useMemo<WidgetPayload[]>(
    () => (routed.kind === "payload" ? [routed.payload] : []),
    [routed],
  );
  const entries = nav.source === toolResult ? nav.entries : base;

  const push = useCallback(
    (payload: WidgetPayload) =>
      setNav((current) => {
        const from = current.source === toolResult ? current.entries : base;
        return { source: toolResult, entries: [...from, payload] };
      }),
    [toolResult, base],
  );
  const replace = useCallback(
    (payload: WidgetPayload) =>
      setNav((current) => {
        const from = current.source === toolResult ? current.entries : base;
        return { source: toolResult, entries: [...from.slice(0, -1), payload] };
      }),
    [toolResult, base],
  );
  const back = useCallback(
    () =>
      setNav((current) => {
        const from = current.source === toolResult ? current.entries : base;
        return { source: toolResult, entries: from.length > 1 ? from.slice(0, -1) : from };
      }),
    [toolResult, base],
  );
  const call = useCallback(
    (name: string, args: Record<string, unknown>) => callOrThrow(host, name, args),
    [host],
  );

  const api: WidgetApi = useMemo(
    () => ({ host, hostState, timing, call, push, replace, back, canGoBack: entries.length > 1 }),
    [host, hostState, timing, call, push, replace, back, entries.length],
  );

  const top = entries[entries.length - 1];
  const insets = hostState.context.safeAreaInsets;
  const style = insets
    ? {
        paddingTop: insets.top,
        paddingRight: insets.right,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
      }
    : undefined;
  const full = hostState.context.displayMode === "fullscreen";

  return (
    <WidgetContext.Provider value={api}>
      <div className={`app${full ? " is-fullscreen" : ""}`} style={style}>
        {top ? (
          <PayloadView key={keyOf(top)} payload={top} />
        ) : routed.kind === "error" ? (
          <ErrorState message={routed.message} />
        ) : (
          <EmptyState reason={routed.kind === "empty" ? routed.reason : "none"} />
        )}
      </div>
    </WidgetContext.Provider>
  );
}
