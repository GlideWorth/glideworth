import { useRef } from "react";

/**
 * Radix returns focus to the element that opened a dialog only when the dialog has a Trigger of its own.
 * Most dialogs and drawers here are opened by an ordinary button or a shortcut and controlled with
 * `open`, so on close focus would fall to the top of the page and a keyboard user would start over.
 * Spread the result on the Radix `Content`: it remembers what had focus when the dialog opened and puts
 * focus back there on close, unless the close already moved focus somewhere on purpose.
 */
export function useRestoreFocus() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      const a = document.activeElement;
      opener.current = a instanceof HTMLElement && a !== document.body ? a : null;
    },
    onCloseAutoFocus: (e: Event) => {
      const el = opener.current;
      opener.current = null;
      const moved = document.activeElement && document.activeElement !== document.body;
      if (el?.isConnected && !moved) {
        e.preventDefault();
        el.focus();
      }
    },
  };
}
