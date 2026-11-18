/** Dropdown menu for row/card actions and "Add …" pickers (Radix, keyboard navigable). */
import { ChevronRight } from "lucide-react";
import { DropdownMenu as M } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export const ActionMenu = M.Root;
export const ActionMenuTrigger = M.Trigger;

export function ActionMenuContent({
  children,
  align = "end",
  className,
}: {
  children: ReactNode;
  align?: "start" | "end" | "center";
  className?: string;
}) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={4}
        collisionPadding={8}
        className={cn(
          "z-50 max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] min-w-[200px] overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-pop",
          className,
        )}
      >
        {children}
      </M.Content>
    </M.Portal>
  );
}

const itemCls =
  "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 pointer-coarse:min-h-11 text-[13px] text-ink outline-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50 [&_svg]:size-3.5 [&_svg]:text-ink-3";

export function ActionMenuItem({
  children,
  onSelect,
  hint,
  tone,
  disabled,
}: {
  children: ReactNode;
  onSelect: () => void;
  hint?: ReactNode;
  tone?: "negative";
  disabled?: boolean;
}) {
  return (
    <M.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(itemCls, tone === "negative" && "text-negative [&_svg]:text-negative")}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">{children}</span>
        {hint ? <span className="text-[11.5px] text-ink-3">{hint}</span> : null}
      </span>
    </M.Item>
  );
}

export function ActionMenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="eyebrow px-2 pt-2 pb-1">{children}</M.Label>;
}

export function ActionMenuSeparator() {
  return <M.Separator className="my-1 h-px bg-border" />;
}

export function ActionSubMenu({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <M.Sub>
      <M.SubTrigger className={cn(itemCls, "data-[state=open]:bg-surface-2")}>
        <span className="flex-1">{label}</span>
        <ChevronRight className="size-3.5" />
      </M.SubTrigger>
      <M.Portal>
        <M.SubContent
          sideOffset={4}
          collisionPadding={8}
          className="z-50 max-h-[60vh] min-w-[220px] overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-pop"
        >
          {children}
        </M.SubContent>
      </M.Portal>
    </M.Sub>
  );
}
