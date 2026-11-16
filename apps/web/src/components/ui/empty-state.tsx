import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Empty states that teach: what this is, why it matters, and the one action to take. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center text-center",
        compact ? "gap-1.5 px-4 py-6" : "gap-2 px-6 py-10",
        className,
      )}
    >
      <div className="flex size-9 items-center justify-center rounded-full border border-dashed border-border-strong text-ink-3">
        <Icon className="size-4" />
      </div>
      <div className="text-[13.5px] font-semibold text-ink">{title}</div>
      {children ? (
        <div className="max-w-md text-[12.5px] leading-relaxed text-ink-2">{children}</div>
      ) : null}
      {action ? <div className="mt-1.5 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
