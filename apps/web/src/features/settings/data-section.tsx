import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, FileUp, Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { toast } from "../../components/ui/toaster";
import { api } from "../../lib/api";
import { plural } from "../../lib/format";
import { useWorkspace } from "../../lib/workspace";
import { usePrefs } from "../../stores/prefs";
import { BackupCard, RestoreCard, TablesCard } from "../import/data-export";
import { resetEditorStore } from "../plan-editor/state/doc-store";
import { SectionIntro, SettingsGroup } from "./settings-ui";

export const DELETE_PHRASE = "delete everything";

export function DataSection() {
  return (
    <>
      <SectionIntro title="Data">
        Your data lives on your own Glideworth server. Take it with you, bring more in, or erase it.
      </SectionIntro>
      <div className="grid gap-5 xl:grid-cols-2">
        <BackupCard />
        <RestoreCard />
      </div>
      <TablesCard />
      <SettingsGroup title="Import">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4 text-[13px] text-ink-2">
          <FileUp className="size-4 text-ink-3" aria-hidden />
          <span className="flex-1">
            ProjectionLab exports and CSVs of balances, history or transactions.
          </span>
          <Button asChild size="sm">
            <Link to="/import">
              Open Import & export <ArrowRight />
            </Link>
          </Button>
        </div>
      </SettingsGroup>
      <DangerZone />
    </>
  );
}

function DangerZone() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: ws } = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const online = ws?.source === "api";
  const doc = ws?.doc;

  const erase = async () => {
    setBusy(true);
    try {
      if (online) {
        const { items } = await api.listHouseholds();
        for (const h of items) await api.deleteHousehold(h.id);
        await api.replaceSettings({});
      }
      // Current names, and the pre-rename `cairn` ones in case a copy was left behind.
      for (const k of Object.keys(localStorage))
        if (/^(glideworth|cairn):/.test(k) || /^(glideworth|cairn)-(prefs|chart-prefs)$/.test(k))
          localStorage.removeItem(k);
      usePrefs.setState({ importChecklist: null, lastImport: null, tour: null });
      resetEditorStore();
      qc.clear();
      setOpen(false);
      toast({
        title: "All data deleted",
        description: "Glideworth is empty. Start again whenever you like.",
      });
      await navigate({ to: "/welcome" });
    } catch (e) {
      toast({
        title: "Could not delete everything",
        description: e instanceof Error ? e.message : String(e),
        tone: "negative",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-[var(--radius-card)] border border-negative/40 bg-surface shadow-card">
      <header className="flex items-start gap-3 border-b border-negative/20 px-5 py-3.5">
        <TriangleAlert className="mt-0.5 size-4 text-negative" aria-hidden />
        <div>
          <h2 className="text-[14px] font-semibold text-ink">Delete all data</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-3">
            Removes your household, every plan and its history, progress snapshots and settings from
            the server and this browser. API keys and webhooks are kept so integrations do not
            break. This cannot be undone.
          </p>
        </div>
      </header>
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <p className="flex-1 text-[12.5px] text-ink-2">
          Download a backup first if there is any chance you will want it back.
        </p>
        <Button variant="danger" onClick={() => setOpen(true)} disabled={!doc}>
          Delete all data…
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setTyped("");
        }}
      >
        <DialogContent
          title="Delete all data?"
          description={
            doc
              ? `${plural(doc.plans.length, "plan")}, ${plural(doc.finances.accounts.length, "account")} and ${plural(doc.progress.length, "snapshot")} will be permanently deleted.`
              : undefined
          }
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim().toLowerCase() === DELETE_PHRASE) void erase();
            }}
          >
            <label htmlFor="delete-confirm" className="text-[12.5px] text-ink-2">
              Type <strong className="font-mono text-ink">{DELETE_PHRASE}</strong> to confirm.
            </label>
            <Input
              id="delete-confirm"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="danger"
                disabled={typed.trim().toLowerCase() !== DELETE_PHRASE || busy}
              >
                {busy ? <Loader2 className="animate-spin" /> : null} Delete everything
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
