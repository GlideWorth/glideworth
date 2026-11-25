import { render } from "@testing-library/react";
import { App } from "../src/App";
import type { Timing } from "../src/context";
import { createFakeHost, type Handler } from "../src/dev/fake-host";
import type { HostContext } from "../src/host";
import type { ToolResult } from "../src/types";

export const FAST: Timing = {
  debounceMs: 0,
  pollBackoffMs: [0],
  pollGiveUpMs: 5_000,
  pollWaitSeconds: 20,
};

export function renderApp(
  result: ToolResult | null,
  options: {
    handlers?: Record<string, Handler>;
    context?: HostContext;
    canMessage?: boolean;
    cancelled?: boolean;
    timing?: Timing;
  } = {},
) {
  const host = createFakeHost({
    result,
    handlers: options.handlers,
    context: options.context,
    canMessage: options.canMessage,
    cancelled: options.cancelled,
  });
  const view = render(<App host={host} timing={options.timing ?? FAST} />);
  return { host, ...view };
}

/** A promise you settle from the test, to control the order tool responses arrive in. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
