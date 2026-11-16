import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export function Stat({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "positive" | "negative";
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="eyebrow">{label}</div>
      <div
        className={cn(
          "display num mt-1 text-[22px] leading-none font-semibold break-words sm:text-[26px]",
          tone === "negative" && "text-negative",
          tone === "positive" && "text-positive",
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-1.5 text-[12px] text-ink-3">{sub}</div> : null}
    </div>
  );
}
