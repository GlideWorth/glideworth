/**
 * An invalid calculator input must not leave the previous result looking current. A valid run that
 * is still in progress keeps the last result, dimmed.
 */
export function applyResultVisibility(
  results: {
    classList: { toggle(token: string, force?: boolean): boolean };
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  },
  state: { invalid: boolean; busy: boolean },
): void {
  results.classList.toggle("is-invalid", state.invalid);
  results.classList.toggle("is-stale", state.busy && !state.invalid);
  if (state.invalid) results.setAttribute("aria-hidden", "true");
  else results.removeAttribute("aria-hidden");
}
