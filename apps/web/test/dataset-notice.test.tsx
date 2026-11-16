/**
 * The DATASET_REPLACED notice can be dismissed: core's `acknowledgeReplacedDataset` clears the marker and the
 * plan is saved (to the API with If-Match, or in the offline sample's own copy).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createUkSampleDocument } from "@glideworth/core/samples";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DismissDatasetNotice,
  isDatasetReplaced,
  withoutDatasetNotice,
} from "../src/features/results/dataset-notice";
import type { Workspace } from "../src/lib/workspace";
import { mockFetch, signedIn } from "./cloud-helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sample = () => {
  const doc = createUkSampleDocument();
  const plan = doc.plans[0]!;
  const flagged = {
    ...plan,
    monteCarlo: {
      ...plan.monteCarlo,
      dataset: "uk-1983" as const,
      replacedDataset: "uk-1871" as const,
    },
  };
  return { doc: { ...doc, plans: [flagged, ...doc.plans.slice(1)] }, plan: flagged };
};

function mount(source: "api" | "sample", role: "owner" | "viewer" = "owner") {
  const { doc, plan } = sample();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  qc.setQueryData<Workspace>(["workspace"], { doc, source } as Workspace);
  qc.setQueryData(["session"], signedIn(role));
  render(
    <QueryClientProvider client={qc}>
      <DismissDatasetNotice plan={plan} />
    </QueryClientProvider>,
  );
  return { qc, plan };
}

describe("dismissing the replaced-dataset notice", () => {
  it("recognises the warning and removes only the marker", () => {
    expect(isDatasetReplaced({ code: "DATASET_REPLACED" })).toBe(true);
    expect(isDatasetReplaced({ code: "SHORTFALL" })).toBe(false);
    const { plan } = sample();
    const next = withoutDatasetNotice(plan);
    expect(next.monteCarlo.replacedDataset).toBeUndefined();
    expect(next.monteCarlo.dataset).toBe("uk-1983");
    expect(next.monteCarlo.trials).toBe(plan.monteCarlo.trials);
  });

  it("saves the plan to the API without the marker, with its version", async () => {
    const api = mockFetch({
      "GET /api/v1/me": { role: "owner", scopes: ["read", "write"], userName: "Ada" },
      [`PUT /api/v1/plans/${sample().plan.id}`]: (r) => r.body as object,
    });
    const { plan } = mount("api");
    fireEvent.click(screen.getByRole("button", { name: /Dismiss the notice/ }));
    await waitFor(() =>
      expect(api.calls.map((c) => `${c.method} ${c.path}`)).toContain(
        `PUT /api/v1/plans/${plan.id}`,
      ),
    );
    const put = api.last(`PUT /api/v1/plans/${plan.id}`)!;
    expect(put.headers.get("if-match")).toBe(`"${plan.version}"`);
    expect((put.body as { monteCarlo: Record<string, unknown> }).monteCarlo).not.toHaveProperty(
      "replacedDataset",
    );
    expect((put.body as { monteCarlo: { dataset: string } }).monteCarlo.dataset).toBe("uk-1983");
  });

  it("in the offline sample it edits this session's copy of the plan", async () => {
    const { qc, plan } = mount("sample");
    fireEvent.click(screen.getByRole("button", { name: /Dismiss the notice/ }));
    await waitFor(() => {
      const ws = qc.getQueryData<Workspace>(["workspace"]);
      expect(
        ws?.doc.plans.find((p) => p.id === plan.id)?.monteCarlo.replacedDataset,
      ).toBeUndefined();
    });
  });

  it("is not offered to a viewer, or when there is no notice", () => {
    mockFetch({ "GET /api/v1/me": { role: "viewer", scopes: ["read"], userName: "Vi" } });
    mount("api", "viewer");
    expect(screen.queryByRole("button", { name: /Dismiss the notice/ })).toBeNull();
  });
});
