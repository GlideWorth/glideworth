import { Check, ChevronDown } from "lucide-react";
import { Select as S } from "radix-ui";
import { cn } from "../../lib/cn";
import { inputBase } from "./input";

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  hint?: string;
  /** Options with a group get a heading whenever the group changes (keep them contiguous). */
  group?: string;
}

export function Select<V extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  id,
  "aria-label": ariaLabel,
}: {
  value: V | undefined;
  onValueChange: (v: V) => void;
  options: SelectOption<V>[];
  placeholder?: string;
  className?: string;
  id?: string;
  "aria-label"?: string;
}) {
  return (
    // Always controlled: '' shows the placeholder (an undefined value would flip Radix to
    // uncontrolled and React warns when it later becomes defined).
    <S.Root value={value ?? ""} onValueChange={(v) => v !== "" && onValueChange(v as V)}>
      <S.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(inputBase, "flex items-center justify-between gap-2 text-left", className)}
      >
        <span className="min-w-0 flex-1 truncate">
          <S.Value placeholder={placeholder} />
        </span>
        <S.Icon>
          <ChevronDown className="size-3.5 text-ink-3" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={4}
          className="z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-pop"
        >
          <S.Viewport className="max-h-[min(360px,var(--radix-select-content-available-height))]">
            {options.map((o, i) => [
              o.group && o.group !== options[i - 1]?.group ? (
                <S.Label key={`group:${o.group}`} className="eyebrow px-2 pt-2.5 pb-1 first:pt-1">
                  {o.group}
                </S.Label>
              ) : null,
              <S.Item
                key={o.value}
                value={o.value}
                className="relative flex cursor-default select-none flex-col rounded-md py-1.5 pr-2 pl-7 text-[13px] outline-none data-[highlighted]:bg-surface-2"
              >
                <S.ItemIndicator className="absolute left-2 top-2">
                  <Check className="size-3.5 text-accent" />
                </S.ItemIndicator>
                <S.ItemText>{o.label}</S.ItemText>
                {o.hint ? <span className="text-[11.5px] text-ink-3">{o.hint}</span> : null}
              </S.Item>,
            ])}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
