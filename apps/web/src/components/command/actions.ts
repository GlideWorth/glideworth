/**
 * App-wide imperative actions shared by the command palette, keyboard shortcuts and buttons.
 * Heavy pieces (Monte Carlo pool, exporters) are imported on demand so the shell stays small.
 */
import type { GlideworthDocument, Plan } from "@glideworth/core";
import type { QueryClient } from "@tanstack/react-query";
import { loadApi } from "../../lib/api-lazy";
import { formatPercent } from "../../lib/format";
import type { Workspace } from "../../lib/workspace";
import { usePrefs } from "../../stores/prefs";
import { resolvedTheme, useUi } from "../../stores/ui";
import { dismissToast, toast } from "../ui/toaster";

export function toggleTheme() {
  const ui = useUi.getState();
  const next = resolvedTheme(ui.theme) === "dark" ? "light" : "dark";
  ui.setTheme(next);
  toast({ title: next === "dark" ? "Dark theme" : "Light theme", duration: 1500 });
}

export function toggleBasis() {
  const ui = useUi.getState();
  const next = ui.basis === "real" ? "nominal" : "real";
  ui.setBasis(next);
  toast({
    title: next === "real" ? "Showing today's money" : "Showing future money",
    description:
      next === "real" ? "Amounts are adjusted for inflation." : "Amounts are actual future values.",
    duration: 2200,
  });
}

/** Snapshot today's balances into Progress. */
export async function recordSnapshot(qc: QueryClient) {
  const ws = qc.getQueryData<Workspace>(["workspace"]);
  if (ws?.source !== "api") {
    toast({
      title: "Snapshots need the server",
      description: "Glideworth is showing offline sample data, so nothing can be recorded.",
      tone: "negative",
    });
    return;
  }
  try {
    await (await loadApi()).recordCurrentSnapshot(ws.doc.household.id, {});
    await qc.invalidateQueries({ queryKey: ["workspace"] });
    await qc.invalidateQueries({ queryKey: ["snapshots"] });
    toast({
      title: "Snapshot recorded",
      description: "Today's balances were added to Progress.",
      tone: "positive",
    });
  } catch (e) {
    toast({
      title: "Could not record a snapshot",
      description: e instanceof Error ? e.message : String(e),
      tone: "negative",
    });
  }
}

let mcRunning: AbortController | null = null;

/** Run chance of success for a plan in the background; the result appears everywhere it is shown. */
export async function runChance(doc: GlideworthDocument, plan: Plan, onView?: () => void) {
  mcRunning?.abort();
  const ac = new AbortController();
  mcRunning = ac;
  const [{ runChanceOfSuccess }, { useMcStore }, { buildSimulationInput }] = await Promise.all([
    import("../../features/chance/mc-pool"),
    import("../../features/chance/mc-store"),
    import("@glideworth/core"),
  ]);
  const prefs = usePrefs.getState().monteCarlo;
  const settings = plan.monteCarlo;
  const id = toast({
    title: `Running ${settings.trials.toLocaleString()} trials…`,
    description: plan.name,
    duration: 0,
    action: { label: "Cancel", onClick: () => ac.abort() },
  });
  try {
    const input = buildSimulationInput(doc, plan.id, { trace: "off" });
    const result = await runChanceOfSuccess(input, settings, {
      signal: ac.signal,
      ...(prefs.workers > 0 ? { workers: prefs.workers } : {}),
    });
    useMcStore
      .getState()
      .put(plan.id, { result, planVersion: plan.version, example: false, at: Date.now() });
    dismissToast(id);
    const locale = doc.settings.locale ?? doc.household.locale;
    toast({
      title: `Chance of success: ${formatPercent(result.successRate, locale, 0)}`,
      description: plan.name,
      tone: "positive",
      ...(onView ? { action: { label: "View", onClick: onView } } : {}),
    });
  } catch (e) {
    dismissToast(id);
    if (ac.signal.aborted) toast({ title: "Simulation cancelled", duration: 1800 });
    else
      toast({
        title: "Chance of success failed",
        description: e instanceof Error ? e.message : String(e),
        tone: "negative",
      });
  } finally {
    if (mcRunning === ac) mcRunning = null;
  }
}

/** Download a full JSON backup (server export when online, else the in-browser document). */
export async function downloadBackup(ws: Workspace | undefined) {
  if (!ws) return;
  const { exportDocument } = await import("@glideworth/importers");
  let text: string;
  try {
    text =
      ws.source === "api"
        ? JSON.stringify(await (await loadApi()).exportHousehold(ws.doc.household.id), null, 2)
        : exportDocument(ws.doc, new Date());
  } catch {
    text = exportDocument(ws.doc, new Date());
  }
  const stamp = new Date().toISOString().slice(0, 10);
  saveFile(`glideworth-backup-${stamp}.json`, text, "application/json");
  toast({
    title: "Backup downloaded",
    description: "Keep it somewhere safe: it contains all your data.",
  });
}

export function saveFile(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
