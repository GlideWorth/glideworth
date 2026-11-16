/**
 * Promise-based confirmation: `if (await confirmAction({...})) remove()`. One <ConfirmHost />
 * renders it (an accessible AlertDialog: focus starts on Cancel).
 */
import { AlertDialog as A } from "radix-ui";
import { create } from "zustand";
import { useRestoreFocus } from "../../lib/restore-focus";
import { Button } from "./button";

interface ConfirmRequest {
  title: string;
  description?: string;
  confirmLabel?: string;
  tone?: "danger" | "primary";
  resolve: (ok: boolean) => void;
}

const useConfirmStore = create<{ req: ConfirmRequest | null }>(() => ({ req: null }));

export function confirmAction(opts: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise((resolve) => useConfirmStore.setState({ req: { ...opts, resolve } }));
}

export function ConfirmHost() {
  const req = useConfirmStore((s) => s.req);
  const restoreFocus = useRestoreFocus();
  const close = (ok: boolean) => {
    req?.resolve(ok);
    useConfirmStore.setState({ req: null });
  };
  return (
    <A.Root open={!!req} onOpenChange={(o) => !o && close(false)}>
      <A.Portal>
        <A.Overlay className="fixed inset-0 z-[60] bg-black/30" />
        <A.Content
          {...restoreFocus}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-pop"
        >
          <A.Title className="display text-[18px] font-semibold">{req?.title}</A.Title>
          <A.Description className="mt-1.5 text-[13px] text-ink-2">
            {req?.description ?? ""}
          </A.Description>
          <div className="mt-5 flex justify-end gap-2">
            <A.Cancel asChild>
              <Button variant="ghost">Cancel</Button>
            </A.Cancel>
            <A.Action asChild>
              <Button
                variant={req?.tone === "primary" ? "primary" : "danger"}
                onClick={() => close(true)}
              >
                {req?.confirmLabel ?? "Confirm"}
              </Button>
            </A.Action>
          </div>
        </A.Content>
      </A.Portal>
    </A.Root>
  );
}
