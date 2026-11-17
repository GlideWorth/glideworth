/**
 * Printing swaps the page to its print layout, but a canvas chart keeps the pixel size it drew at
 * on screen, so it prints at its screen width (half a page in a two-column block) or blank. Call
 * `refit` when the print layout is in place and when the screen layout returns.
 *
 * Browsers differ in which signal arrives after the layout changes. Chromium and Firefox
 * notify the `print` media query once the print layout is applied; `beforeprint` and `afterprint`
 * cover the browsers that do not. Returns a function that removes the listeners.
 */
export function onPrintLayout(refit: () => void): () => void {
  const mql = typeof window.matchMedia === "function" ? window.matchMedia("print") : null;
  window.addEventListener("beforeprint", refit);
  window.addEventListener("afterprint", refit);
  mql?.addEventListener("change", refit);
  return () => {
    window.removeEventListener("beforeprint", refit);
    window.removeEventListener("afterprint", refit);
    mql?.removeEventListener("change", refit);
  };
}
