import { useState } from "react";
import {
  Actions,
  Button,
  ChangeList,
  Chip,
  Chips,
  Collapsible,
  Notice,
  Shell,
} from "../components/ui";
import { useFormatter, useWidget } from "../context";
import { bodyOf, ToolError } from "../routing";
import type { ReviewView as ReviewViewData } from "../types";
import { outcomeDeltas, useAction, worseWarning } from "./shared";

export function ReviewView({ data }: { data: ReviewViewData }) {
  const { call, host } = useWidget();
  const fmt = useFormatter(data.plan);
  const [status, setStatus] = useState(data.status);
  const [version, setVersion] = useState(data.appliedVersion);
  const [settled, setSettled] = useState(false);
  const action = useAction();
  const warning = data.before && data.after ? worseWarning(data.before, data.after, fmt) : null;
  const deltas =
    data.before && data.after ? outcomeDeltas(data.before, data.after, fmt).slice(0, 3) : [];

  const apply = () =>
    action.run("apply", async () => {
      try {
        const result = await call("apply_change_set", { changeSetId: data.changeSetId });
        const body = bodyOf(result);
        const next = typeof body.newVersion === "number" ? body.newVersion : null;
        setVersion(next);
        setStatus("applied");
        await host.updateModelContext(
          `The user applied change set ${data.changeSetId} in the Glideworth view; the plan is now version ${next ?? "updated"}.`,
        );
      } catch (err) {
        if (err instanceof ToolError && err.code === "CHANGESET_CONFLICT") {
          setStatus("conflict");
          return;
        }
        if (notProposed(err)) return;
        throw err;
      }
    });

  /** Already applied or discarded elsewhere (in the app, or by the assistant): stop offering the buttons. */
  const notProposed = (err: unknown) => {
    if (!(err instanceof ToolError) || err.code !== "CHANGESET_NOT_PROPOSED") return false;
    setSettled(true);
    return true;
  };

  const discard = () =>
    action.run("discard", async () => {
      try {
        await call("discard_change_set", { changeSetId: data.changeSetId });
      } catch (err) {
        if (notProposed(err)) return;
        throw err;
      }
      setStatus("discarded");
      await host.updateModelContext(
        `The user discarded change set ${data.changeSetId} in the Glideworth view; the plan is unchanged.`,
      );
    });

  return (
    <Shell plan={data.plan} title="Review this change">
      <p className="headline lead">{data.summary}</p>
      {data.rationale ? (
        <Collapsible title="Why">
          <p className="prose">{data.rationale}</p>
        </Collapsible>
      ) : null}

      {data.changes.length ? <ChangeList changes={data.changes} /> : null}

      {deltas.length ? (
        <Chips>
          {deltas.map((d) => (
            <Chip
              key={d.key}
              label={d.label}
              value={d.after}
              detail={`was ${d.before}`}
              tone={d.tone}
            />
          ))}
        </Chips>
      ) : null}

      {status === "applied" ? (
        <Notice tone="good">
          Applied — plan is now version {version ?? data.plan.planVersion + 1}.
        </Notice>
      ) : null}
      {status === "discarded" ? <Notice>Discarded. Your plan is unchanged.</Notice> : null}
      {status === "conflict" ? (
        <Notice tone="bad">
          Your plan changed since this was proposed. Ask to propose it again.
        </Notice>
      ) : null}

      {warning && status === "proposed" ? <p className="warning">{warning}</p> : null}
      {settled ? <Notice>This change was already applied or discarded.</Notice> : null}
      {status === "proposed" && data.plan.canWrite && !settled ? (
        <Actions>
          <Button
            variant={warning ? "secondary" : "primary"}
            busy={action.busy === "apply"}
            disabled={action.busy !== null}
            onClick={() => void apply()}
          >
            Apply
          </Button>
          <Button
            variant="quiet"
            busy={action.busy === "discard"}
            disabled={action.busy !== null}
            onClick={() => void discard()}
          >
            Discard
          </Button>
        </Actions>
      ) : null}
      {status === "proposed" && !data.plan.canWrite ? (
        <p className="muted small">
          Nothing has changed yet. Applying changes needs write access, which the workspace owner
          can turn on in Glideworth.
        </p>
      ) : null}
      {action.error ? <Notice tone="bad">{action.error}</Notice> : null}
    </Shell>
  );
}
