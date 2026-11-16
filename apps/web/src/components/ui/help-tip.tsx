import { CircleHelp } from "lucide-react";
import { Popover as P } from "radix-ui";
import type { ReactNode } from "react";

/**
 * Contextual help for a non-obvious field. A popover (not a hover tooltip) so it works with touch
 * and keyboard; the trigger is a real button with an accessible name.
 */
export function HelpTip({
  children,
  label = "More information",
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <P.Root>
      <P.Trigger
        type="button"
        aria-label={label}
        className="inline-flex size-4 items-center justify-center rounded-full text-ink-3 align-[-3px] hover:text-accent focus-visible:text-accent"
      >
        <CircleHelp className="size-3.5" />
      </P.Trigger>
      <P.Portal>
        <P.Content
          side="top"
          sideOffset={6}
          collisionPadding={12}
          className="z-[70] max-w-[280px] rounded-lg border border-border bg-surface px-3 py-2 text-[12px] leading-relaxed text-ink-2 shadow-pop"
        >
          {children}
          <P.Arrow className="fill-surface" />
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
