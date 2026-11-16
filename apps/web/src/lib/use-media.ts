import { useSyncExternalStore } from "react";

/** Live `matchMedia` result (false during SSR/tests without matchMedia). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof matchMedia === "undefined") return () => {};
      const mq = matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => (typeof matchMedia === "undefined" ? false : matchMedia(query).matches),
    () => false,
  );
}

/** Tailwind breakpoints used by the shell. */
export const MD = "(min-width: 768px)";
export const LG = "(min-width: 1024px)";
