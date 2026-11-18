import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-ink hover:bg-accent-hover shadow-card",
        secondary:
          "bg-surface text-ink border border-border hover:border-border-strong hover:bg-surface-2 shadow-card",
        ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
        subtle: "bg-accent-soft text-accent hover:brightness-95",
        danger: "bg-negative text-white hover:brightness-95",
      },
      // On touch screens every size is at least 44px tall (and icons 44px wide); desktop keeps the
      // compact sizes.
      size: {
        sm: "h-7 px-2.5 text-[12.5px] pointer-coarse:min-h-11",
        md: "h-8 px-3 text-[13px] pointer-coarse:min-h-11",
        lg: "h-10 px-4 text-sm pointer-coarse:min-h-11",
        icon: "size-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
