/**
 * Commands from every area of the app, merged into the command palette (Cmd/Ctrl+K) wherever it
 * is open. The palette itself (plan-editor) contributes plan, section and "add" commands.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  Camera,
  CircleDollarSign,
  Compass,
  Dices,
  Download,
  Eye,
  EyeOff,
  FileUp,
  Keyboard,
  type LucideIcon,
  MessageSquare,
  SunMoon,
  Upload,
} from "lucide-react";
import { useMemo } from "react";
import { sectionsForMode } from "../../features/settings/sections";
import { useMode } from "../../lib/auth";
import { openFeedback, useFeedbackAvailable } from "../../lib/feedback";
import { useActivePlan } from "../../lib/workspace";
import { usePrefs } from "../../stores/prefs";
import { useUi } from "../../stores/ui";
import { NAV } from "../layout/nav";
import {
  downloadBackup,
  recordSnapshot,
  runChance,
  toggleBasis,
  toggleHideAmounts,
  toggleTheme,
} from "./actions";

export interface PaletteCommand {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon: LucideIcon;
  run: () => void;
}

/** Paths the plan-editor palette already offers under "Go to". */
const ALREADY = new Set(["/", "/finances", "/plans", "/results"]);

export function useGlobalCommands(): PaletteCommand[] {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { plan, workspace } = useActivePlan();
  const basis = useUi((s) => s.basis);
  const hideAmounts = useUi((s) => s.hideAmounts);
  const setShortcuts = useUi((s) => s.setShortcutsOpen);
  const mode = useMode();
  const feedback = useFeedbackAvailable();

  return useMemo(() => {
    const go = (to: string, search?: Record<string, string>) => () =>
      void navigate({ to, ...(search ? { search } : {}) } as never);
    const out: PaletteCommand[] = [];
    out.push(
      {
        id: "g:run-mc",
        group: "Actions",
        label: "Run chance of success",
        hint: plan?.name,
        icon: Dices,
        keywords: "monte carlo simulate trials probability",
        run: () => {
          if (workspace && plan)
            void runChance(workspace.doc, plan, () => void navigate({ to: "/chance" }));
        },
      },
      {
        id: "g:basis",
        group: "Actions",
        label: basis === "real" ? "Switch to future money" : "Switch to today's money",
        hint: "Real / nominal",
        icon: CircleDollarSign,
        keywords: "inflation real nominal basis toggle money mode",
        run: toggleBasis,
      },
      {
        id: "g:hide-amounts",
        group: "Actions",
        label: hideAmounts ? "Show amounts" : "Hide amounts",
        hint: "⇧H",
        icon: hideAmounts ? Eye : EyeOff,
        keywords: "privacy private mask blur screen share sharing stream screenshot balances",
        run: toggleHideAmounts,
      },
      {
        id: "g:theme",
        group: "Actions",
        label: "Toggle light / dark theme",
        icon: SunMoon,
        keywords: "dark mode light appearance",
        run: toggleTheme,
      },
      {
        id: "g:snapshot",
        group: "Actions",
        label: "Record a progress snapshot",
        hint: "Today's balances",
        icon: Camera,
        keywords: "net worth history progress actuals",
        run: () => void recordSnapshot(qc),
      },
      {
        id: "g:import-pl",
        group: "Actions",
        label: "Import from ProjectionLab…",
        icon: FileUp,
        keywords: "migrate json export upload",
        run: go("/import", { tab: "projectionlab" }),
      },
      {
        id: "g:import-csv",
        group: "Actions",
        label: "Import a CSV (balances, history, transactions)…",
        icon: Upload,
        keywords: "spreadsheet bank budget ynab monarch upload",
        run: go("/import", { tab: "csv" }),
      },
      {
        id: "g:backup",
        group: "Actions",
        label: "Download a full backup (JSON)",
        icon: Download,
        keywords: "export save",
        run: () => void downloadBackup(workspace),
      },
      {
        id: "g:shortcuts",
        group: "Actions",
        label: "Keyboard shortcuts",
        hint: "?",
        icon: Keyboard,
        keywords: "help keys hotkeys",
        run: () => setShortcuts(true),
      },
      {
        id: "g:tour",
        group: "Actions",
        label: "Take the guided tour",
        icon: Compass,
        keywords: "help onboarding introduction",
        run: () => {
          usePrefs.getState().set({ tour: "start" });
          void navigate({ to: "/" });
        },
      },
    );
    if (feedback)
      out.push({
        id: "g:feedback",
        group: "Actions",
        label: "Send feedback",
        icon: MessageSquare,
        keywords: "bug report problem feature request idea suggestion contact support",
        // After the palette has closed, so its focus return does not land on the form.
        run: () => setTimeout(openFeedback),
      });
    for (const g of NAV)
      for (const item of g.items) {
        if (ALREADY.has(item.to) || item.to.includes("active")) continue;
        out.push({
          id: `nav:${item.to}`,
          group: "Go to",
          label: item.label,
          hint: g.group,
          icon: ArrowRight,
          run: go(item.to),
        });
      }
    out.push({
      id: "nav:/import",
      group: "Go to",
      label: "Import & export",
      icon: ArrowRight,
      keywords: "data backup",
      run: go("/import"),
    });
    out.push({
      id: "nav:/welcome",
      group: "Go to",
      label: "Welcome & setup",
      icon: ArrowRight,
      keywords: "onboarding sample start",
      run: go("/welcome"),
    });
    for (const s of sectionsForMode(mode))
      out.push({
        id: `nav:settings:${s.id}`,
        group: "Settings",
        label: `Settings: ${s.label}`,
        hint: s.description,
        icon: s.icon,
        keywords: s.keywords,
        run: () => void navigate({ to: "/settings/$section", params: { section: s.id } }),
      });
    return out;
  }, [navigate, qc, plan, workspace, basis, hideAmounts, setShortcuts, mode, feedback]);
}
