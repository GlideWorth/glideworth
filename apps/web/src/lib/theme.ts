import { useEffect, useState } from "react";
import { resolvedTheme, type ThemePref, useUi } from "../stores/ui";

/** Applies the theme preference to <html data-theme> and tracks the OS preference. */
export function useThemeSync(): "light" | "dark" {
  const pref = useUi((s) => s.theme);
  const [resolved, setResolved] = useState(() => resolvedTheme(pref));
  useEffect(() => {
    const apply = (p: ThemePref) => {
      const r = resolvedTheme(p);
      document.documentElement.dataset.theme = r;
      setResolved(r);
    };
    apply(pref);
    if (pref !== "system" || typeof matchMedia === "undefined") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => apply("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [pref]);
  return resolved;
}

export function useResolvedTheme(): "light" | "dark" {
  const pref = useUi((s) => s.theme);
  const [t, setT] = useState(() => resolvedTheme(pref));
  useEffect(() => {
    setT(resolvedTheme(pref));
    const obs = new MutationObserver(() =>
      setT((document.documentElement.dataset.theme as "light" | "dark") ?? "light"),
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, [pref]);
  return t;
}

/**
 * Mirrors the appearance preferences onto <html> data attributes so CSS can respond:
 * data-density (Tailwind's spacing scale tightens), data-transparency (solid chrome) and
 * data-motion (app-level reduced motion, in addition to the OS setting).
 */
export function useAppearanceSync(): void {
  const density = useUi((s) => s.density);
  const reduceTransparency = useUi((s) => s.reduceTransparency);
  const reduceMotion = useUi((s) => s.reduceMotion);
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.density = density;
    el.dataset.transparency = reduceTransparency ? "reduced" : "full";
    el.dataset.motion = reduceMotion ? "reduced" : "full";
  }, [density, reduceTransparency, reduceMotion]);
}

/** True when either the OS or the app asks for reduced motion. */
export function motionReduced(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.motion === "reduced")
    return true;
  return (
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
