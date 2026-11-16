import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "min-h-[72px] w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[13px] text-ink shadow-card placeholder:text-ink-3",
        "transition-colors hover:border-border-strong focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus/20",
        className,
      )}
      {...props}
    />
  );
}
