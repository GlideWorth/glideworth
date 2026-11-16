/**
 * The calculator page controller: plain DOM code, no framework. It reads the form, validates inline,
 * keeps the inputs in the URL, and asks the engine worker for results, which it renders with the same
 * code the build used for the static page. The engine itself loads on the first interaction or when the
 * browser is idle. Nothing typed into the page leaves the browser: no network requests, no storage.
 */
import { plannerUrl } from "../carry";
import { currencySymbol, inputText } from "../format";
import { renderResults } from "../render";
import { defaults, fromQuery, isActive, parseNumber, toQuery, validate } from "../state";
import type { ToolSpec, Values } from "../types";
import { type RunHandle, runInEngine, warm } from "../worker/client";

const idle = (fn: () => void, timeout: number) => {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
  };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout });
  else setTimeout(fn, Math.min(timeout, 1500));
};

export function mountCalculator(spec: ToolSpec): void {
  const root = document.querySelector<HTMLElement>(`[data-tool="${spec.id}"]`);
  if (!root) return;
  const form = root.querySelector<HTMLFormElement>("[data-tool-form]")!;
  const results = root.querySelector<HTMLElement>("[data-results]")!;
  const announce = root.querySelector<HTMLElement>("[data-announce]")!;
  const status = root.querySelector<HTMLElement>("[data-status]")!;
  const statusText = root.querySelector<HTMLElement>("[data-status-text]")!;
  const progress = root.querySelector<HTMLProgressElement>("[data-progress]");
  const cancelBtn = root.querySelector<HTMLButtonElement>('[data-action="cancel"]');
  const runBtn = root.querySelector<HTMLButtonElement>('[data-action="run"]');
  const staticHtml = results.innerHTML;
  const input = (key: string) =>
    form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${key}"]`);

  let values: Values = defaults(spec);
  let current: RunHandle | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let warmed = false;
  /** A note that outlives one run (a damaged shared link). */
  let notice = "";

  const ensureEngine = () => {
    if (warmed) return;
    warmed = true;
    warm();
  };

  function setStatus(text: string, busy = false) {
    statusText.textContent = text;
    status.hidden = text === "" && !busy;
    results.classList.toggle("is-stale", busy);
    results.setAttribute("aria-busy", String(busy));
  }

  function showProgress(done: number, total: number) {
    if (!progress) return;
    progress.hidden = false;
    progress.max = total;
    progress.value = done;
    setStatus(
      `Running simulation ${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}…`,
      true,
    );
  }

  function hideProgress() {
    if (progress) progress.hidden = true;
    if (cancelBtn) cancelBtn.hidden = true;
  }

  function updateCurrency() {
    const cur = String(values.cur ?? "USD");
    const sym = currencySymbol(cur);
    for (const el of form.querySelectorAll<HTMLElement>("[data-currency]")) el.textContent = sym;
  }

  function updateVisibility() {
    for (const f of spec.fields) {
      if (!f.showWhen) continue;
      const wrap = form.querySelector<HTMLElement>(`[data-field="${f.key}"]`);
      if (wrap) wrap.hidden = !isActive(f, values);
    }
  }

  /** The planner box sits beside the calculator, not inside it, so look in the whole page. */
  function updateLinks() {
    const href = plannerUrl(spec, values);
    for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-planner-link]"))
      a.href = href;
  }

  /** Reads every input; returns the values and the field errors. */
  function readForm(): { next: Values; errors: Record<string, string> } {
    const next: Values = { ...values };
    for (const f of spec.fields) {
      const el = input(f.key);
      if (!el) continue;
      next[f.key] = f.kind === "number" ? parseNumber(el.value) : el.value;
    }
    return { next, errors: validate(spec, next) };
  }

  function showErrors(errors: Record<string, string>) {
    for (const f of spec.fields) {
      const el = input(f.key);
      const msg = form.querySelector<HTMLElement>(`#f-${f.key}-error`);
      if (!el || !msg) continue;
      const m = errors[f.key];
      el.setAttribute("aria-invalid", m ? "true" : "false");
      msg.textContent = m ?? "";
      msg.hidden = !m;
    }
  }

  function writeForm(v: Values) {
    for (const f of spec.fields) {
      const el = input(f.key);
      if (!el) continue;
      const x = v[f.key];
      el.value = f.kind === "number" && typeof x === "number" ? inputText(x, f.unit) : String(x);
    }
  }

  function compute() {
    current?.cancel();
    ensureEngine();
    const simulation = spec.mode === "simulation";
    setStatus(simulation ? "Starting the simulation…" : "Calculating…", true);
    if (simulation && cancelBtn) cancelBtn.hidden = false;
    if (runBtn) runBtn.hidden = true;
    const handle = runInEngine(spec.id, values, simulation ? showProgress : undefined);
    current = handle;
    handle.result
      .then((out) => {
        if (current !== handle) return;
        current = null;
        hideProgress();
        if (!out) {
          setStatus("Cancelled. The results below are from the last completed run.");
          if (runBtn) runBtn.hidden = false;
          return;
        }
        results.innerHTML = renderResults(out.vm);
        setStatus(notice);
        notice = "";
        // Announce after the DOM update so screen readers read the new summary once.
        announce.textContent = "";
        requestAnimationFrame(() => {
          announce.textContent = out.vm.announce;
        });
      })
      .catch((e: unknown) => {
        if (current !== handle) return;
        current = null;
        hideProgress();
        if (runBtn) runBtn.hidden = false;
        setStatus(`The calculation failed: ${e instanceof Error ? e.message : String(e)}`);
      });
  }

  function schedule(delay: number) {
    clearTimeout(timer);
    timer = setTimeout(compute, delay);
  }

  function onChange(immediate: boolean) {
    const { next, errors } = readForm();
    showErrors(errors);
    values = next;
    updateVisibility();
    updateCurrency();
    if (Object.keys(errors).length > 0) {
      clearTimeout(timer);
      current?.cancel();
      setStatus("Correct the highlighted input to update the results.", false);
      results.classList.add("is-stale");
      return;
    }
    history.replaceState(null, "", `${location.pathname}?${toQuery(spec, values)}${location.hash}`);
    updateLinks();
    schedule(immediate ? 0 : spec.mode === "simulation" ? 600 : 250);
  }

  // --- events
  form.addEventListener("input", () => onChange(false));
  form.addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLSelectElement) onChange(false);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    onChange(true);
  });
  form.addEventListener(
    "focusout",
    (e) => {
      const el = e.target as HTMLInputElement;
      const f = spec.fields.find((x) => x.key === el.name);
      if (!f || f.kind !== "number") return;
      const n = parseNumber(el.value);
      if (Number.isFinite(n) && !validate(spec, { ...values, [f.key]: n })[f.key])
        el.value = inputText(n, f.unit);
    },
    true,
  );
  for (const ev of ["focusin", "pointerdown", "keydown"] as const)
    root.addEventListener(ev, ensureEngine, { once: true, passive: true });

  cancelBtn?.addEventListener("click", () => current?.cancel());
  runBtn?.addEventListener("click", () => onChange(true));
  root.querySelector('[data-action="reset"]')?.addEventListener("click", () => {
    current?.cancel();
    current = null;
    clearTimeout(timer);
    hideProgress();
    values = defaults(spec);
    writeForm(values);
    showErrors({});
    updateVisibility();
    updateCurrency();
    updateLinks();
    history.replaceState(null, "", `${location.pathname}${location.hash}`);
    // The default results were rendered at build time: put them back without running anything.
    results.innerHTML = staticHtml;
    setStatus("");
    if (runBtn) runBtn.hidden = true;
    announce.textContent = "Inputs reset to the defaults.";
  });
  const copyBtn = root.querySelector<HTMLButtonElement>('[data-action="copy"]');
  copyBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      announce.textContent = "Link copied.";
      copyBtn.dataset.done = "true";
      setTimeout(() => delete copyBtn.dataset.done, 2000);
    } catch {
      announce.textContent = "Copy the address from the address bar to share these results.";
    }
  });

  // --- start: a shared link opens with its inputs; otherwise the static results already show the defaults.
  const fromUrl = fromQuery(spec, location.search);
  root.classList.add("is-live");
  if (fromUrl.present) {
    values = fromUrl.values;
    writeForm(values);
    const errors = validate(spec, values);
    showErrors(errors);
    updateVisibility();
    updateCurrency();
    updateLinks();
    if (fromUrl.invalid.length) {
      notice = `Some values in the link could not be read and were reset to the defaults (${fromUrl.invalid.join(", ")}).`;
      setStatus(notice);
    }
    if (Object.keys(errors).length === 0) {
      setStatus("Calculating the inputs from your link…", true);
      idle(compute, 800);
    }
  } else {
    updateLinks();
    // Fetch the engine ahead of the first interaction, except for a visitor who asked the browser to
    // save data: the static results are already on the page, and the engine still loads on first use.
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
      ?.saveData;
    if (!saveData) idle(ensureEngine, 4000);
  }
}
