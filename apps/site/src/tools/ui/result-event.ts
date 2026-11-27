/**
 * The event a calculator page sends after each completed run, for the "Email me this result" form
 * (lib/calculator-email.ts), so the form sends the inputs and figures the visitor is looking at. A DOM event only:
 * nothing leaves the page here.
 */
export const RESULT_EVENT = "glideworth:calculator-result";

export interface ResultDetail {
  tool: string;
  /** The query string of the inputs the shown result used; null while the inputs are invalid. */
  query: string | null;
  /** Label and value of the shown figures; null means "the build-time defaults again" (Reset). */
  figures: [string, string][] | null;
}
