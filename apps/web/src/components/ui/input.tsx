import { type ComponentProps, type ReactNode, useId } from "react";
import { cn } from "../../lib/cn";

export const inputBase =
  "h-8 pointer-coarse:min-h-11 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink placeholder:text-ink-3 shadow-card transition-colors hover:border-border-strong focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus/20 disabled:opacity-50 aria-invalid:border-negative";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(inputBase, className)} {...props} />;
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  /** Gets the input id and, as a second argument, the attributes that tie the hint or error to it. */
  children: (
    id: string,
    a11y: { "aria-describedby": string | undefined; "aria-invalid": true | undefined },
  ) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-[12px] font-medium text-ink-2">
        {label}
      </label>
      {children(id, {
        "aria-describedby": error || hint ? noteId : undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {error ? (
        <p id={noteId} className="text-[11.5px] text-negative">
          {error}
        </p>
      ) : hint ? (
        <p id={noteId} className="text-[11.5px] text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
