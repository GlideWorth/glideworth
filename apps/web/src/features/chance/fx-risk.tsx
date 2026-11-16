/**
 * Exchange-rate risk in Monte Carlo (`MonteCarloSettings.fx`): each foreign currency the household
 * holds gets a yearly volatility against the base currency, plus one common correlation. Off by
 * default: rates then follow their deterministic rate and drift in every trial.
 */
import type { MonteCarloSettings } from "@glideworth/core";
import { Field, Input } from "../../components/ui/input";

type Fx = NonNullable<MonteCarloSettings["fx"]>;

/** A typical yearly volatility of a major currency pair (about 8-10%). */
export const DEFAULT_FX_VOLATILITY = 0.09;

/** The volatility set for `currency` against `base` (either direction), or null when not sampled. */
export function fxVolatility(
  fx: MonteCarloSettings["fx"],
  currency: string,
  base: string,
): number | null {
  const p = fx?.pairs.find(
    (x) => (x.from === currency && x.to === base) || (x.from === base && x.to === currency),
  );
  return p ? p.volatility : null;
}

/** Turn sampling for one currency on (with a volatility) or off (null); other pairs are kept. */
export function withFxVolatility(
  fx: MonteCarloSettings["fx"],
  currency: string,
  base: string,
  volatility: number | null,
): MonteCarloSettings["fx"] {
  const others = (fx?.pairs ?? []).filter(
    (x) => !((x.from === currency && x.to === base) || (x.from === base && x.to === currency)),
  );
  const pairs: Fx["pairs"] =
    volatility === null
      ? others
      : [...others, { from: currency, to: base, volatility: Math.max(0, Math.min(2, volatility)) }];
  // No pairs left: drop the block so the settings read "off" (and the run matches the deterministic FX).
  return pairs.length ? { pairs, correlation: fx?.correlation ?? 0 } : undefined;
}

export function FxRiskSettings({
  value,
  set,
  currencies,
  base,
}: {
  value: MonteCarloSettings;
  set: (patch: Partial<MonteCarloSettings>) => void;
  /** Foreign currencies the household holds or plans with. */
  currencies: string[];
  base: string;
}) {
  if (!currencies.length) return null;
  const on = (value.fx?.pairs.length ?? 0) > 0;
  return (
    <div className="flex flex-col gap-2 rounded-md bg-surface-2 p-2.5">
      <div className="eyebrow">Exchange-rate risk</div>
      <p className="text-[11.5px] text-ink-3">
        Off: each currency follows the rate and drift in Current finances in every trial. On: each
        trial draws a yearly change around that path with the volatility you set (about 8–10% a year
        is typical for major currencies).
      </p>
      {currencies.map((c) => {
        const vol = fxVolatility(value.fx, c, base);
        return (
          <div
            key={c}
            className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-[12.5px]"
          >
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={vol !== null}
                onChange={(e) =>
                  set({
                    fx: withFxVolatility(
                      value.fx,
                      c,
                      base,
                      e.target.checked ? DEFAULT_FX_VOLATILITY : null,
                    ),
                  })
                }
              />
              {c} → {base}
            </label>
            {vol !== null ? (
              <Input
                aria-label={`${c} to ${base} volatility, % a year`}
                type="number"
                min={0}
                max={200}
                step={0.5}
                value={Math.round(vol * 1000) / 10}
                onChange={(e) =>
                  set({
                    fx: withFxVolatility(value.fx, c, base, (Number(e.target.value) || 0) / 100),
                  })
                }
              />
            ) : (
              <span className="text-ink-3">not sampled</span>
            )}
          </div>
        );
      })}
      {on && (value.fx?.pairs.length ?? 0) > 1 ? (
        <Field
          label="Correlation between currencies"
          hint="-1 to 1; 0.5 means they tend to move together"
        >
          {(id) => (
            <Input
              id={id}
              type="number"
              min={-1}
              max={1}
              step={0.1}
              value={value.fx?.correlation ?? 0}
              onChange={(e) =>
                set({
                  fx: {
                    pairs: value.fx?.pairs ?? [],
                    correlation: Math.max(-1, Math.min(1, Number(e.target.value) || 0)),
                  },
                })
              }
            />
          )}
        </Field>
      ) : null}
    </div>
  );
}
