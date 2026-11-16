/** Lets a view render example data in its own currency/locale (e.g. the UK example household). */
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { makeFormatter, useFormat } from "../../lib/workspace";

type Fmt = ReturnType<typeof useFormat>;
const Ctx = createContext<Fmt | null>(null);

export function FormatOverride({
  locale,
  currency,
  children,
}: {
  locale: string;
  currency: string;
  children: ReactNode;
}) {
  const value = useMemo<Fmt>(() => makeFormatter({ locale, currency }), [locale, currency]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useViewFormat(): Fmt {
  const base = useFormat();
  return useContext(Ctx) ?? base;
}
