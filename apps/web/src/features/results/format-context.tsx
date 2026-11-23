/** Lets a view render example data in its own currency/locale (e.g. the UK example household). */
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { makeFormatter, useFormat } from "../../lib/workspace";
import { useAmountsHidden } from "../../stores/ui";

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
  const hidden = useAmountsHidden();
  const value = useMemo<Fmt>(
    () => makeFormatter({ locale, currency }, hidden),
    [locale, currency, hidden],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useViewFormat(): Fmt {
  const base = useFormat();
  return useContext(Ctx) ?? base;
}
