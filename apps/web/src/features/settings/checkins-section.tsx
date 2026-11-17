/** Settings → Check-ins: the schedule (`GET/PATCH /schedule`) and the main plan's health history. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { PercentInput } from "../../components/ui/number-input";
import { Select } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { useAccess } from "../../lib/access";
import { ApiRequestError, api, type Schedule } from "../../lib/api";
import { useMode } from "../../lib/auth";
import { relativeTime } from "../../lib/format";
import { useActivePlan, useFormat, useWorkspace } from "../../lib/workspace";
import { HealthHistory, useCheckInNow } from "../checkins/checkins";
import { SectionIntro, SettingRow, SettingsGroup } from "./settings-ui";

const CADENCE: { value: Schedule["cadence"]; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "quarterly", label: "Every quarter" },
];

export function CheckinsSection() {
  const cloud = useMode() === "cloud";
  const { data: ws } = useWorkspace();
  const f = useFormat();
  const qc = useQueryClient();
  const access = useAccess();
  const { plan } = useActivePlan();
  const run = useCheckInNow(plan?.id);
  const online = ws?.source === "api";
  const q = useQuery({
    queryKey: ["schedule"],
    queryFn: api.getSchedule,
    enabled: online,
    retry: false,
  });
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patchSchedule(patch),
    onSuccess: (s) => qc.setQueryData(["schedule"], s),
    onError: (e) =>
      toast({
        title: "Schedule not saved",
        description: e instanceof Error ? e.message : String(e),
        tone: "negative",
      }),
  });
  const s = q.data;
  const disabled = !access.canWrite || save.isPending;
  return (
    <>
      <SectionIntro title="Check-ins">
        Glideworth re-runs your main plan on a schedule (projection, chance of success and the
        assumption audit), keeps each result as a point of plan health, and tells you when something
        material moves.{" "}
        {cloud
          ? "It runs on the Glideworth Cloud servers that hold your workspace."
          : "It runs on your server; nothing leaves it."}
      </SectionIntro>
      <SettingsGroup
        title="Schedule"
        description={
          s
            ? `Last run ${relativeTime(s.lastRunAt, f.locale).toLowerCase()}${s.nextRunAt && s.enabled ? ` · next ${new Intl.DateTimeFormat(f.locale, { dateStyle: "medium", timeStyle: "short" }).format(Date.parse(s.nextRunAt))}` : ""}${s.running ? " · running now" : ""}`
            : undefined
        }
      >
        {!online ? (
          <EmptyState icon={TriangleAlert} title="The server is offline" compact>
            Check-ins run on your Glideworth server.
          </EmptyState>
        ) : q.isLoading ? (
          <div className="flex items-center gap-2 px-5 py-6 text-[12.5px] text-ink-3">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : q.isError || !s ? (
          <EmptyState icon={TriangleAlert} title="Check-ins unavailable" compact>
            {q.error instanceof ApiRequestError && q.error.status === 404
              ? "This server does not run check-ins yet."
              : "Could not load the schedule."}
          </EmptyState>
        ) : (
          <>
            <SettingRow
              label="Automatic check-ins"
              hint="When this is off, only check-ins you run yourself are recorded."
            >
              <Switch
                checked={s.enabled}
                disabled={disabled}
                aria-label="Automatic check-ins"
                onCheckedChange={(enabled) => save.mutate({ enabled })}
              />
            </SettingRow>
            <SettingRow label="How often">
              <Select
                aria-label="Check-in cadence"
                className="w-[160px]"
                value={s.cadence}
                onValueChange={(cadence) => save.mutate({ cadence, intervalHours: null })}
                options={CADENCE}
              />
            </SettingRow>
            <SettingRow
              label="Chance of success moves by"
              hint="Notify when it rises or falls by more than this between check-ins."
            >
              <PercentInput
                aria-label="Success-rate change threshold"
                className="w-[110px]"
                value={s.thresholds.successRateDelta}
                disabled={disabled}
                onValueChange={(v) =>
                  v !== null &&
                  v > 0 &&
                  save.mutate({ thresholds: { successRateDelta: Math.min(1, v) } })
                }
              />
            </SettingRow>
            <SettingRow
              label="A milestone slips by"
              hint="Months later than at the previous check-in."
            >
              <Select
                aria-label="Milestone slip threshold"
                className="w-[160px]"
                value={String(s.thresholds.milestoneSlipMonths)}
                onValueChange={(v) =>
                  save.mutate({ thresholds: { milestoneSlipMonths: Number(v) } })
                }
                options={[3, 6, 12, 24].map((m) => ({ value: String(m), label: `${m} months` }))}
              />
            </SettingRow>
            <SettingRow
              label="Net worth falls behind plan by"
              hint="Compared with what the previous check-in projected for today, in today's money."
            >
              <PercentInput
                aria-label="Behind-plan threshold"
                className="w-[110px]"
                value={s.thresholds.netWorthBehindPlan}
                disabled={disabled}
                onValueChange={(v) =>
                  v !== null &&
                  v > 0 &&
                  save.mutate({ thresholds: { netWorthBehindPlan: Math.min(1, v) } })
                }
              />
            </SettingRow>
          </>
        )}
      </SettingsGroup>
      <SettingsGroup
        title={plan ? `Plan health: ${plan.name}` : "Plan health"}
        description="Chance of success at each check-in. Scheduled runs cover the main plan of each household."
        actions={
          online && plan && access.canWrite ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => run.mutate()}
              disabled={run.isPending}
            >
              {run.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check in now
            </Button>
          ) : null
        }
      >
        <div className="px-5 py-4">
          <HealthHistory planId={plan?.id} />
        </div>
      </SettingsGroup>
    </>
  );
}
