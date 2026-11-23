/**
 * One rule for "is this dependent part of the household in this period", shared by the tax input
 * (the US child tax credit and the ACA household size read it), survivor filing status and the
 * web app, so they cannot disagree.
 *
 * A dependent counts in a period when they are born before the period ends and are younger than
 * their own `independentAtAge` at the period's start (ages are taken at the period start, as for
 * every other age the tax plug-ins see). No tax-law age test is applied here: each plug-in keeps its
 * own (the child tax credit's under-17 test, for example) on top of this one.
 */
import type { Dependent } from "../schema/household.js";
import { ageAt, type MonthIndex, parseMonth } from "./dates.js";

export function isDependentInPeriod(
  dep: Pick<Dependent, "birthMonth" | "independentAtAge">,
  start: MonthIndex,
  endExclusive: MonthIndex,
): boolean {
  const birth = parseMonth(dep.birthMonth);
  return birth < endExclusive && ageAt(birth, start) < dep.independentAtAge;
}
