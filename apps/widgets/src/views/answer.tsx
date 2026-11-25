import { Actions, Button, Notice, Shell } from "../components/ui";
import { useFormatter } from "../context";
import type { AnswerView as AnswerViewData } from "../types";
import { clip, useAction, useOpenView } from "./shared";

export function AnswerView({ data }: { data: AnswerViewData }) {
  const fmt = useFormatter(data.plan);
  const action = useAction();
  const openView = useOpenView();
  const { figure, current } = data;
  const found = figure.value !== null;
  const shown = figure.value !== null ? fmt.figure(figure.value, figure.format) : "No answer found";
  const suffix = found && figure.format === "money" ? " a year" : "";
  const hasOps = found && Boolean(data.ops?.length);

  return (
    <Shell plan={data.plan} title={figure.label}>
      <section className="hero">
        <p className={found ? "big num" : "big is-muted"}>
          {shown}
          {suffix ? <span className="big-suffix">{suffix}</span> : null}
        </p>
        <p className="headline">{data.answer}</p>
        <p className="muted small">
          {current ? (
            <>
              {current.label}:{" "}
              <span className="num">{fmt.figure(current.value, figure.format)}</span>
            </>
          ) : null}
          {current && data.targetSuccessRate !== null ? " · " : null}
          {data.targetSuccessRate !== null ? (
            <>
              Target: <span className="num">{fmt.percent(data.targetSuccessRate, 0)}</span> chance
              of success
            </>
          ) : null}
        </p>
      </section>

      {hasOps ? (
        <Actions>
          <Button
            variant={data.plan.canWrite ? "secondary" : "primary"}
            busy={action.busy === "preview"}
            onClick={() =>
              void action.run("preview", () =>
                openView("preview_changes", { planId: data.plan.planId, ops: data.ops }, "compare"),
              )
            }
          >
            See it on my plan
          </Button>
          {data.plan.canWrite ? (
            <Button
              variant="primary"
              busy={action.busy === "use"}
              onClick={() =>
                void action.run("use", () =>
                  openView(
                    "propose_change_set",
                    { planId: data.plan.planId, ops: data.ops, summary: clip(data.answer) },
                    "review",
                  ),
                )
              }
            >
              Use this
            </Button>
          ) : null}
        </Actions>
      ) : null}
      {action.error ? <Notice tone="bad">{action.error}</Notice> : null}
    </Shell>
  );
}
