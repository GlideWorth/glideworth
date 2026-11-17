import { useRef } from "react";

/** Where focus should go back to: the opener, and the page around it in case the opener is replaced. */
interface Opener {
  el: HTMLElement;
  /** The opener's ancestors, nearest first, without `body` and `html`. */
  path: HTMLElement[];
  /** Its tag and visible name, to find a re-rendered copy of the same control. */
  tag: string;
  name: string;
}

/** The last opener that was on the page itself (not inside a dialog). */
let lastPageOpener: Opener | null = null;

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const nameOf = (el: Element) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();

function describe(el: HTMLElement): Opener {
  const path: HTMLElement[] = [];
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) path.push(p);
  return { el, path, tag: el.tagName, name: nameOf(el) };
}

const inDialog = (el: Element) => !!el.closest('[role="dialog"], [role="alertdialog"]');

/**
 * Put focus back at `o`. When the opener itself is gone (a "Turn on" button that became "Turn off", a row
 * that re-rendered), focus the nearest part of the page that is still there: the same control if it was
 * re-rendered, else the first control in that part, else the part itself. Returns false when nothing is left.
 */
function restore(o: Opener): boolean {
  if (o.el.isConnected) {
    o.el.focus();
    return true;
  }
  const scope = o.path.find((p) => p.isConnected && p !== document.documentElement);
  if (!scope) return false;
  const controls = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((c) => !inDialog(c));
  const same = controls.filter((c) => c.tagName === o.tag && o.name !== "" && nameOf(c) === o.name);
  // A hidden control does not take focus, so try each until one does.
  for (const c of [...same, ...controls]) {
    c.focus();
    if (document.activeElement === c) return true;
  }
  if (!scope.hasAttribute("tabindex")) scope.setAttribute("tabindex", "-1");
  scope.focus();
  return true;
}

/**
 * Radix returns focus to the element that opened a dialog only when the dialog has a Trigger of its own.
 * Most dialogs and drawers here are opened by an ordinary button or a shortcut and controlled with
 * `open`, so on close focus would fall to the top of the page and a keyboard user would start over.
 * Spread the result on the Radix `Content`: it remembers what had focus when the dialog opened and puts
 * focus back there on close, unless the close already moved focus somewhere on purpose.
 *
 * Two cases need more than that. A dialog opened by another dialog as it closed (a new key's reveal after
 * the "New key" form, recovery codes after turning on two-step sign-in) has no opener on the page, so it
 * returns focus to whatever opened the first dialog. And an opener that was replaced while the dialog was
 * open hands focus to the nearest part of the page that is still there (see `restore`).
 */
export function useRestoreFocus() {
  const opener = useRef<Opener | null>(null);
  const fallback = useRef<Opener | null>(null);
  return {
    onOpenAutoFocus: () => {
      const a = document.activeElement;
      const el = a instanceof HTMLElement && a !== document.body && a.isConnected ? a : null;
      opener.current = el ? describe(el) : null;
      if (el && !inDialog(el)) lastPageOpener = opener.current;
      // Opened from inside another dialog (or with nothing focused): the page opener of the dialog before.
      fallback.current = !el || inDialog(el) ? lastPageOpener : null;
    },
    onCloseAutoFocus: (e: Event) => {
      const own = opener.current;
      const before = fallback.current;
      opener.current = null;
      fallback.current = null;
      const moved = document.activeElement && document.activeElement !== document.body;
      if (moved) return;
      if (own?.el.isConnected) {
        e.preventDefault();
        own.el.focus();
        return;
      }
      // An opener inside a dialog that has closed since: go back to the page opener before it.
      const target = own && !inDialog(own.el) ? own : (before ?? own);
      if (target && restore(target)) e.preventDefault();
    },
  };
}
