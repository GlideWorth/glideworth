/**
 * Pieces shared by the hosted-mode settings screens: loading and error states for a request, error
 * toasts that stay quiet when the person cancelled a re-authentication, and a "type the name to confirm"
 * dialog for destructive actions.
 */
import { Loader2, RotateCw, TriangleAlert } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty-state";
import { toast } from "../../components/ui/toaster";
import { ApiRequestError } from "../../lib/api-error";
import { ReauthCancelled } from "../../lib/reauth";
import { describeError, FormAlert, TextField, useErrorFocus } from "./ui";

export function Loading({ what }: { what: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex items-center gap-2 px-5 py-6 text-[12.5px] text-ink-3"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden /> Loading {what}…
    </div>
  );
}

export function LoadError({
  error,
  what,
  onRetry,
}: {
  error: unknown;
  what: string;
  onRetry: () => void;
}) {
  const forbidden = error instanceof ApiRequestError && error.status === 403;
  return (
    <EmptyState
      icon={TriangleAlert}
      title={`${what} could not be loaded`}
      compact
      action={
        forbidden ? undefined : (
          <Button size="sm" onClick={onRetry}>
            <RotateCw /> Try again
          </Button>
        )
      }
    >
      {forbidden ? "Only the workspace owner can see this." : describeError(error)}
    </EmptyState>
  );
}

/** A failed action: say what could not be done and why. Silent when a re-authentication was cancelled. */
export function failToast(title: string, e: unknown): void {
  if (e instanceof ReauthCancelled) return;
  toast({ title, description: describeError(e), tone: "negative" });
}

/**
 * "Type X to confirm": the action button stays disabled until the text matches. `onConfirm` runs the
 * request; throw to keep the dialog open and show the message.
 */
export function TypedConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  body,
  expected,
  fieldLabel,
  confirmLabel,
  caseSensitive = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  body?: ReactNode;
  expected: string;
  fieldLabel: string;
  confirmLabel: string;
  caseSensitive?: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { ref, failed } = useErrorFocus();
  useEffect(() => {
    if (!open) {
      setTyped("");
      setError(null);
      setBusy(false);
    }
  }, [open]);
  const norm = (v: string) => (caseSensitive ? v.trim() : v.trim().toLowerCase());
  const matches = typed.length > 0 && norm(typed) === norm(expected);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      if (!(err instanceof ReauthCancelled)) {
        setError(describeError(err));
        failed();
      }
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        <form ref={ref} onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {body}
          <TextField
            large={false}
            label={fieldLabel}
            value={typed}
            onChange={setTyped}
            autoComplete="off"
            placeholder={expected}
          />
          {error ? <FormAlert>{error}</FormAlert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={!matches || busy}>
              {busy ? <Loader2 className="animate-spin" /> : null} {confirmLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
