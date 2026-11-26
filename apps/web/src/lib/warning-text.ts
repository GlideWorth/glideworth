/**
 * Fill a warning's `{token}` amounts in the basis the screen is showing. `format` is the app's
 * money formatter (currency, compact form, hide-amounts), so a warning reads like every other figure.
 */
import {
  type ProjectionResult,
  type SimWarning,
  type ValueBasis,
  warningText,
} from "@glideworth/core";

export function formatWarning(
  result: Pick<ProjectionResult, "periods">,
  warning: SimWarning,
  basis: ValueBasis,
  format: (value: number) => string,
): string {
  const period = warning.periodIndex !== null ? result.periods[warning.periodIndex] : undefined;
  return warningText(warning, { basis, period, format });
}
