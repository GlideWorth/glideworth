import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";
import { privateChildren } from "./private-text";

/**
 * A box that scrolls. A scrollable box is a keyboard stop (otherwise a keyboard user cannot reach the
 * columns or rows that do not fit), and a stop needs a name, so it is a labelled group.
 */
export function ScrollRegion({
  label,
  axis = "x",
  className,
  ...props
}: ComponentProps<"div"> & { label: string; axis?: "x" | "y" }) {
  return (
    <div
      role="group"
      // A scrollable box must be reachable by keyboard (WCAG 2.1.1); it has a role and a name.
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      aria-label={label}
      className={cn(axis === "x" ? "overflow-x-auto" : "overflow-y-auto", className)}
      {...props}
    />
  );
}

export function Table({ className, "aria-label": label, ...props }: ComponentProps<"table">) {
  return (
    <ScrollRegion label={label ?? "Table, scrolls sideways if it does not fit"}>
      <table
        aria-label={label}
        className={cn("w-full border-collapse text-[13px]", className)}
        {...props}
      />
    </ScrollRegion>
  );
}
export function THead(props: ComponentProps<"thead">) {
  return <thead className="sticky top-0 bg-surface" {...props} />;
}
export function TBody(props: ComponentProps<"tbody">) {
  return <tbody className="[&>tr:hover]:bg-surface-2/60" {...props} />;
}
export function TR({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("border-b border-border last:border-b-0", className)} {...props} />;
}
export function TH({ className, numeric, ...props }: ComponentProps<"th"> & { numeric?: boolean }) {
  return (
    <th
      className={cn(
        "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3",
        numeric && "text-right",
        className,
      )}
      {...props}
    />
  );
}
export function TD({
  className,
  numeric,
  children,
  ...props
}: ComponentProps<"td"> & { numeric?: boolean }) {
  return (
    <td className={cn("px-3 py-1.5 text-ink", numeric && "num text-right", className)} {...props}>
      {privateChildren(children)}
    </td>
  );
}
