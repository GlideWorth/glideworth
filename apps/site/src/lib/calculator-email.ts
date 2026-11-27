/**
 * "Email me this result" (components/CalculatorEmail.astro): the one place a calculator page sends anything, and
 * only when the visitor submits the form. It posts the form to its own `action` on this origin (the web server
 * forwards it to the app), so nothing goes to another site. It stores nothing in the browser.
 *
 * Without this script the form still works: a plain form post, answered with a page that links back. With it, the
 * answer shows in place, and the hidden fields follow the calculator: each completed run (ui/mount.ts) sends a
 * `glideworth:calculator-result` event with the inputs it used and its figures.
 */
import { RESULT_EVENT, type ResultDetail } from "../tools/ui/result-event";

const MESSAGES = {
  sending: "Sending…",
  sent: "Sent. Check your inbox.",
  sentConfirm: "Sent. Check your inbox, and click the link in the email to confirm the reminder.",
  invalidInputs: "Correct the highlighted input in the calculator first.",
  badEmail: "Enter a valid email address.",
  limited: "Too many emails were asked for. Try again later.",
  failed: "We could not send it right now. Try again later; your result stays on this page.",
} as const;

export function mountCalculatorEmail(form: HTMLFormElement): void {
  const status = form.querySelector<HTMLElement>("[data-calc-email-status]");
  const query = form.querySelector<HTMLInputElement>('input[name="q"]');
  const figures = form.querySelector<HTMLElement>("[data-calc-email-figures]");
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const email = form.querySelector<HTMLInputElement>('input[name="email"]');
  const consent = form.querySelector<HTMLInputElement>('input[name="updates"]');
  const tool = form.querySelector<HTMLInputElement>('input[name="tool"]')?.value;
  if (!status || !query || !figures || !button || !email) return;
  const initial = { query: query.value, figures: figures.innerHTML };
  let inputsValid = true;

  const say = (text: string, tone: "info" | "ok" | "error" = "info") => {
    status.textContent = text;
    status.dataset.tone = tone;
  };

  document.addEventListener(RESULT_EVENT, (e) => {
    const d = (e as CustomEvent<ResultDetail>).detail;
    if (!d || d.tool !== tool) return;
    inputsValid = d.query !== null;
    if (d.query === null) return;
    if (d.figures === null) {
      query.value = initial.query;
      figures.innerHTML = initial.figures;
      return;
    }
    query.value = d.query;
    figures.replaceChildren(
      ...d.figures.slice(0, 8).flatMap(([label, value]) => {
        const l = document.createElement("input");
        l.type = "hidden";
        l.name = "fl";
        l.value = label;
        const v = document.createElement("input");
        v.type = "hidden";
        v.name = "fv";
        v.value = value;
        return [l, v];
      }),
    );
  });

  form.addEventListener("submit", (e) => {
    if (typeof window.fetch !== "function" || typeof URLSearchParams !== "function") return; // plain post
    e.preventDefault();
    if (!inputsValid) return say(MESSAGES.invalidInputs, "error");
    if (!email.checkValidity()) {
      email.focus();
      return say(MESSAGES.badEmail, "error");
    }
    const ticked = consent?.checked === true;
    const body = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (typeof v === "string") body.append(k, v);
    button.disabled = true;
    say(MESSAGES.sending);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    window
      .fetch(form.action, {
        method: "POST",
        headers: { Accept: "application/json" },
        body,
        credentials: "omit",
        signal: abort.signal,
      })
      .then((res) => {
        if (res.status === 202) {
          say(ticked ? MESSAGES.sentConfirm : MESSAGES.sent, "ok");
          email.value = "";
          if (consent) consent.checked = false;
        } else if (res.status === 429) say(MESSAGES.limited, "error");
        else if (res.status === 400) say(MESSAGES.badEmail, "error");
        else say(MESSAGES.failed, "error");
      })
      .catch(() => say(MESSAGES.failed, "error"))
      .finally(() => {
        clearTimeout(timer);
        button.disabled = false;
      });
  });
}
