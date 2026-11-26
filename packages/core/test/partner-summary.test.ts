/**
 * The partner summary is built from engine results only: every number in its sentences is one of its listed
 * figures, and every figure equals the engine field it names. Synthetic sample household (Avery and Jordan).
 */
import { describe, expect, it } from "vitest";
import {
  applyPlanPatch,
  auditAssumptions,
  buildPartnerSummary,
  buildSimulationInput,
  type PartnerSummary,
  partnerSummarySurvivorCases,
  roundForPartner,
  runMonteCarlo,
  type SimulationInput,
  simulate,
  toBasis,
} from "../src/index.js";
import { createSampleDocument, SAMPLE_PLAN_ID } from "../src/samples/index.js";

function build(mutate?: (i: SimulationInput) => SimulationInput) {
  let input = buildSimulationInput(createSampleDocument(), SAMPLE_PLAN_ID, { trace: "off" });
  if (mutate) input = mutate(input);
  const result = simulate(input);
  const monteCarlo = runMonteCarlo(input, { ...input.plan.monteCarlo, trials: 200, seed: 7 });
  const survivors = partnerSummarySurvivorCases(input).map((c) => ({
    personId: c.personId,
    age: c.age,
    result: simulate({ ...input, plan: applyPlanPatch(input.plan, c.patch) }),
  }));
  const findings = auditAssumptions(input, { result });
  const summary = buildPartnerSummary({ input, result, monteCarlo, survivors, findings });
  return { input, result, monteCarlo, survivors, findings, summary };
}

/** Every sentence a partner reads, except risks quoted from the assumption audit (checked separately). */
function sentences(s: PartnerSummary): string[] {
  return [
    s.headline,
    s.stopWork.text,
    s.spending.text,
    s.confidence.text,
    s.survivor.text,
    ...s.risks.filter((r) => !r.source.startsWith("audit:")).map((r) => r.text),
  ];
}

/** Number tokens as written (grouping separators kept), e.g. "2,041", "87%", "£48,300". */
const numbersIn = (text: string) => text.match(/\d[\d,.]*\d|\d/g) ?? [];

describe("buildPartnerSummary", () => {
  const b = build();
  const { summary, result, monteCarlo } = b;

  it("states nothing the engine did not compute: every number in the text is a listed figure", () => {
    const shown = summary.figures.flatMap((f) => numbersIn(f.display));
    for (const t of sentences(summary))
      for (const n of numbersIn(t)) expect(shown, `"${n}" in "${t}"`).toContain(n);
    expect(summary.figures.length).toBeGreaterThan(3);
    // Plain words: no long decimals (ages are whole years, money is rounded).
    for (const t of sentences(summary)) expect(t).not.toMatch(/\d\.\d{2,}/);
  });

  it("each figure equals the engine field it names", () => {
    const by = Object.fromEntries(summary.figures.map((f) => [f.id, f]));
    expect(by.retirementYear?.value).toBe(result.summary.retirementYear);
    expect(by.successRate?.value).toBe(monteCarlo.successRate);
    expect(by.trials?.value).toBe(monteCarlo.trials);
    const idx = result.periods.findIndex((p) => p.year === summary.spending.year);
    const p = result.periods[idx]!;
    expect(by.yearlySpending?.value).toBe(toBasis(p.totals.spending, p, "real", "flow"));
    expect(by.yearlySpending?.source).toContain(`periods[${idx}].totals.spending`);
    expect(by.yearlySpending?.display).toContain(
      new Intl.NumberFormat("en-US").format(roundForPartner(by.yearlySpending!.value)),
    );
    for (const c of summary.survivor.cases) {
      const run = b.survivors.find((r) => r.personId === c.personId && r.age === c.age)!;
      expect(c.success).toBe(run.result.summary.success);
      expect(c.firstShortfallYear).toBe(run.result.summary.firstShortfallYear);
    }
  });

  it("answers the five questions in plain words", () => {
    expect(summary.stopWork.year).toBe(result.summary.retirementYear);
    expect(summary.stopWork.text).toMatch(
      /^You can stop working in \d{4}, when Avery is \d+ and Jordan is \d+\.$/,
    );
    expect(summary.spending.text).toMatch(/a year/);
    expect(summary.confidence.level).not.toBe("unknown");
    expect(summary.survivor.applicable).toBe(true);
    expect(summary.survivor.cases.map((c) => c.name)).toEqual(
      expect.arrayContaining(
        ["Avery", "Jordan"].filter((n) => summary.people.some((p) => p.name === n)),
      ),
    );
    expect(summary.risks.length).toBeLessThanOrEqual(3);
    expect(summary.assumptions.map((a) => a.label)).toContain("Prices rise by");
    expect(summary.caveats.join(" ")).toMatch(/not financial advice/);
  });

  it("risks quoted from the audit are the audit's own titles", () => {
    const titles = b.findings.map((f) => `${f.title}.`);
    for (const r of summary.risks.filter((x) => x.source.startsWith("audit:")))
      expect(titles).toContain(r.text);
  });

  it("without a Monte Carlo result it says so instead of guessing", () => {
    const s = buildPartnerSummary({ input: b.input, result });
    expect(s.confidence).toMatchObject({ level: "unknown", successRate: null });
    expect(s.figures.find((f) => f.source.startsWith("monteCarlo"))).toBeUndefined();
    expect(s.survivor.text).toMatch(/not been run/);
  });

  it("a failing plan names its first shortfall year from the projection", () => {
    const bad = build((i) => ({
      ...i,
      plan: {
        ...i.plan,
        expenses: i.plan.expenses.map((e) => ({
          ...e,
          amount: { ...e.amount, value: e.amount.value * 4 },
        })),
      },
    }));
    expect(bad.result.summary.success).toBe(false);
    expect(bad.summary.spending.firstShortfallYear).toBe(bad.result.summary.firstShortfallYear);
    expect(bad.summary.risks[0]).toMatchObject({ id: "shortfall" });
    expect(bad.summary.risks[0]!.text).toContain(String(bad.result.summary.firstShortfallYear));
    for (const t of sentences(bad.summary)) {
      const shown = bad.summary.figures.flatMap((f) => numbersIn(f.display));
      for (const n of numbersIn(t)) expect(shown, `"${n}" in "${t}"`).toContain(n);
    }
  });

  it("rounds money to three significant figures", () => {
    expect(roundForPartner(48_251)).toBe(48_300);
    expect(roundForPartner(1_234_567)).toBe(1_230_000);
    expect(roundForPartner(449)).toBe(400);
  });
});
