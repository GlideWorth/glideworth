import { X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useRestoreFocus } from "../../lib/restore-focus";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  const restoreFocus = useRestoreFocus();
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
      <D.Content
        {...restoreFocus}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-pop",
          className,
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <D.Title className="display text-[19px] font-semibold">{title}</D.Title>
            {description ? (
              <D.Description className="mt-1 text-ink-2">{description}</D.Description>
            ) : null}
          </div>
          <D.Close className="rounded-md p-1 text-ink-3 hover:bg-surface-2" aria-label="Close">
            <X className="size-4" />
          </D.Close>
        </div>
        {children}
      </D.Content>
    </D.Portal>
  );
}
