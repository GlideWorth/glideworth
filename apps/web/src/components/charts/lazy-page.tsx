/** Lazy route pages: code-split each analysis area (and ECharts with it) out of the main bundle. */
import { type ComponentType, type JSX, lazy, Suspense } from "react";
import { NoPlanGate } from "../layout/no-plan";
import { PagePending } from "../layout/route-states";

export function lazyPage<M extends Record<string, unknown>>(
  load: () => Promise<M>,
  name: keyof M & string,
  /** Page title for the "no plan yet" state, for pages that analyse the active plan. */
  needsPlan?: string,
): () => JSX.Element {
  const L = lazy(async () => ({ default: (await load())[name] as ComponentType }));
  function LazyPage() {
    const page = (
      <Suspense fallback={<PagePending />}>
        <L />
      </Suspense>
    );
    return needsPlan ? <NoPlanGate title={needsPlan}>{page}</NoPlanGate> : page;
  }
  LazyPage.displayName = `Lazy(${name})`;
  return LazyPage;
}
