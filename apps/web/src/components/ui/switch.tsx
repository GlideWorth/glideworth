import { Switch as S } from "radix-ui";
import { type ReactNode, useId } from "react";
import { cn } from "../../lib/cn";

export function Switch({
  checked,
  onCheckedChange,
  id,
  disabled,
  "aria-label": ariaLabel,
  size = "md",
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
  size?: "sm" | "md";
}) {
  return (
    <S.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-colors",
        "bg-surface-3 data-[state=checked]:bg-accent disabled:opacity-50",
        size === "sm" ? "h-4 w-7" : "h-5 w-9",
      )}
    >
      <S.Thumb
        className={cn(
          "block rounded-full bg-surface shadow-card transition-transform",
          size === "sm"
            ? "size-3 translate-x-0.5 data-[state=checked]:translate-x-3.5"
            : "size-4 translate-x-0.5 data-[state=checked]:translate-x-4",
        )}
      />
    </S.Root>
  );
}

/** A labelled switch row with optional help text underneath. */
export function SwitchField({
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <label htmlFor={id} className="text-[12.5px] font-medium text-ink">
          {label}
        </label>
        {hint ? <p className="mt-0.5 text-[11.5px] text-ink-3">{hint}</p> : null}
      </div>
      <div className="pt-0.5">
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
      </div>
    </div>
  );
}

/** Compact inline switch followed by its label (for rows of toggles). */
export function InlineSwitch({
  label,
  checked,
  onCheckedChange,
  className,
}: {
  label: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <span className={cn("inline-flex items-center gap-2 text-[12.5px]", className)}>
      <Switch id={id} size="sm" checked={checked} onCheckedChange={onCheckedChange} />
      <label htmlFor={id}>{label}</label>
    </span>
  );
}
