import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";
import { privateChildren } from "./private-text";

const badge = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
  {
    variants: {
      tone: {
        neutral: "bg-surface-2 text-ink-2",
        accent: "bg-accent-soft text-accent",
        ochre: "bg-ochre-soft text-ochre",
        negative: "bg-negative-soft text-negative",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({
  className,
  tone,
  children,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badge>) {
  return (
    <span className={cn(badge({ tone }), className)} {...props}>
      {privateChildren(children)}
    </span>
  );
}
