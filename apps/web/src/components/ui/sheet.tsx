/**
 * Sheet: a side drawer for editing one entity without leaving the page (full-screen on phones).
 * Built on Radix Dialog, so focus is trapped and Escape closes it.
 */
import { X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useRestoreFocus } from "../../lib/restore-focus";
import { useUi } from "../../stores/ui";

export const Sheet = D.Root;
export const SheetTrigger = D.Trigger;
export const SheetClose = D.Close;

export function SheetContent({
  title,
  eyebrow,
  description,
  children,
  footer,
  width = 560,
  className,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}) {
  const readOnly = useUi((s) => s.readOnly);
  const restoreFocus = useRestoreFocus();
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/25 data-[state=open]:animate-[glideworth-fade_140ms_ease-out]" />
      <D.Content
        {...restoreFocus}
        style={{ ["--sheet-w" as string]: `${width}px` }}
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface shadow-pop outline-none sm:w-[min(var(--sheet-w),96vw)]",
          "data-[state=open]:animate-[glideworth-sheet-in_180ms_cubic-bezier(.2,.8,.2,1)]",
          className,
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
          <div className="min-w-0">
            {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
            <D.Title className="display truncate text-[19px] font-semibold leading-tight">
              {title}
            </D.Title>
            {description ? (
              <D.Description className="mt-0.5 text-[12.5px] text-ink-2">
                {description}
              </D.Description>
            ) : (
              <D.Description className="sr-only">Edit details</D.Description>
            )}
          </div>
          <D.Close
            className="-mr-1 flex shrink-0 items-center justify-center rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink pointer-coarse:-my-2 pointer-coarse:-mr-3 pointer-coarse:size-11"
            aria-label="Close"
          >
            <X className="size-4" />
          </D.Close>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {readOnly ? (
            <p className="mb-3 rounded-md bg-surface-2 px-3 py-2 text-[12px] text-ink-2">
              View only: you can look at everything here but not change it.
            </p>
          ) : null}
          {/* A disabled fieldset disables every control inside it, for viewers. */}
          <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
            {children}
          </fieldset>
        </div>
        {footer ? (
          <footer className="flex flex-wrap items-center gap-2 border-t border-border bg-surface px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </footer>
        ) : null}
        <style>
          {
            "@keyframes glideworth-sheet-in{from{transform:translateX(24px);opacity:.4}to{transform:none;opacity:1}}@keyframes glideworth-fade{from{opacity:0}to{opacity:1}}"
          }
        </style>
      </D.Content>
    </D.Portal>
  );
}

/** A titled group inside a sheet or form. */
export function FormSection({
  title,
  description,
  children,
  aside,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-b border-border py-4 first:pt-0 last:border-b-0", className)}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[12.5px] font-semibold tracking-wide text-ink">{title}</h3>
          {description ? <p className="mt-0.5 text-[12px] text-ink-3">{description}</p> : null}
        </div>
        {aside}
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

/** Responsive grid of fields: 1 column on phones, 2 (or 3) on wider sheets. */
export function FieldGrid({
  children,
  cols = 2,
  className,
}: {
  children: ReactNode;
  cols?: 2 | 3;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-3", cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2", className)}>
      {children}
    </div>
  );
}
