/**
 * `pnpm --filter @glideworth/widgets dev`: every view and state outside a host, with light/dark and narrow/wide
 * toggles. Tool calls made by the views are answered from the fixtures.
 */
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../App";
import {
  answerSpending,
  compareFor,
  compareOps,
  FIXTURES,
  outcomeMonteCarlo,
  resultOf,
  reviewProposed,
  yearShortfall,
  yearView,
} from "../fixtures";
import { createFakeHost, type Handler } from "./fake-host";

const delay = <T,>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

let polls = 0;
const handlers: Record<string, Handler> = {
  explain_year: (args) =>
    delay(
      500,
      resultOf({
        ...(Number(args.year) > 2055 ? yearShortfall : yearView),
        year: Number(args.year),
      }),
    ),
  preview_whatif: (args) => {
    const params = (args.params ?? {}) as { retirementYear?: number; spending?: number };
    return delay(
      700,
      resultOf(compareFor(params.retirementYear ?? 2033, params.spending ?? 96_000)),
    );
  },
  preview_changes: () => delay(500, resultOf({ ...compareOps, template: null })),
  propose_change_set: (args) =>
    delay(
      500,
      resultOf({ ...reviewProposed, summary: String(args.summary ?? reviewProposed.summary) }),
    ),
  apply_change_set: () =>
    delay(600, resultOf(reviewProposed, { status: "applied", newVersion: 13 })),
  discard_change_set: () => delay(400, resultOf(reviewProposed, { status: "discarded" })),
  create_branch_from_template: () =>
    delay(500, {
      content: [
        { type: "text", text: JSON.stringify({ id: "plan_branch_1", name: "Retire earlier" }) },
      ],
    }),
  get_job: (args) => {
    polls += 1;
    const done =
      args.jobId === "job_sample_solver" ? resultOf(answerSpending) : resultOf(outcomeMonteCarlo);
    return delay(
      1200,
      polls % 4 === 0
        ? done
        : {
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "running", progress: (polls % 4) / 4 }),
              },
            ],
          },
    );
  },
};

function Preview() {
  const [name, setName] = useState("outcome-mc");
  const [dark, setDark] = useState(window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [narrow, setNarrow] = useState(true);
  const fixture = FIXTURES[name] ?? FIXTURES["outcome-mc"];
  const host = useMemo(
    () =>
      createFakeHost({
        handlers,
        result: fixture?.result ?? null,
        cancelled: fixture?.cancelled ?? false,
        context: { theme: dark ? "dark" : "light", locale: navigator.language },
      }),
    // A fresh host per fixture and theme, so each starts from its initial state.
    [fixture, dark],
  );

  return (
    <div className="preview" style={{ fontFamily: "system-ui", padding: 16 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
          alignItems: "center",
        }}
      >
        <label>
          View{" "}
          <select value={name} onChange={(e) => setName(e.currentTarget.value)}>
            {Object.entries(FIXTURES).map(([key, f]) => (
              <option key={key} value={key}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => setDark((v) => !v)}>
          {dark ? "Light" : "Dark"}
        </button>
        <button type="button" onClick={() => setNarrow((v) => !v)}>
          {narrow ? "Wide (720px)" : "Narrow (360px)"}
        </button>
      </div>
      <div
        style={{
          width: narrow ? 360 : 720,
          maxWidth: "100%",
          border: "1px dashed #8888",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <App key={`${name}-${dark}`} host={host} />
      </div>
    </div>
  );
}

export function mountPreview(root: HTMLElement) {
  createRoot(root).render(
    <StrictMode>
      <Preview />
    </StrictMode>,
  );
}
