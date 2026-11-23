/**
 * Text that may hold money amounts, for "Hide amounts" (privacy mode). While amounts are hidden it
 * masks any figure the money formatter did not already mask (prose from core, notifications), and it
 * gives screen readers "amount hidden" instead of the mask's dots. When amounts are shown it renders
 * the text unchanged. Stat, TD and Badge use it for their string content, so most screens need
 * nothing more.
 */
import { Children, type ReactNode } from "react";
import { AMOUNT_MASK, maskAmountsInText, speakAmounts } from "../../lib/format";
import { useAmountsHidden } from "../../stores/ui";

export function PrivateText({ children }: { children: string }) {
  const hidden = useAmountsHidden();
  const text = hidden ? maskAmountsInText(children) : children;
  if (!text.includes(AMOUNT_MASK)) return <>{text}</>;
  return (
    <>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{speakAmounts(text)}</span>
    </>
  );
}

/** `PrivateText` for each string child; other children pass through untouched. */
export function privateChildren(children: ReactNode): ReactNode {
  if (typeof children === "string") return <PrivateText>{children}</PrivateText>;
  if (!Array.isArray(children)) return children;
  return Children.map(children, (c) =>
    typeof c === "string" ? <PrivateText>{c}</PrivateText> : c,
  );
}
