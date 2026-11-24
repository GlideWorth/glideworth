/**
 * Edits to income and expense events that must not invent a second copy of a default.
 * A salary left at its starting name and amount, then switched to Bonus, becomes an annual bonus
 * rather than another "Sam's salary" of £45,000. Two salaries that do share a name are labelled
 * apart in the bonus's salary list.
 */

export function uniqueEventName(name: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  let n = 2;
  while (used.has(`${name} (${n})`)) n++;
  return `${name} (${n})`;
}

/** Drop name and amount when they are still the previous type's factory defaults. */
export function defaultsToReplace(
  current: { name: string; amount: { value: number; basis: string } },
  previous: { name: string; amount: { value: number; basis: string } },
): { name: boolean; amount: boolean } {
  return {
    name: current.name === previous.name,
    amount:
      current.amount.value === previous.amount.value &&
      current.amount.basis === previous.amount.basis,
  };
}

/**
 * A label for a salary in the bonus's source list. Identical names gain the amount, and if that
 * still collides, the end of the id, so two sources are never shown under one label.
 */
export function sourceOptionLabel(
  id: string,
  name: string,
  detail: string,
  peers: readonly { id: string; name: string; detail: string }[],
): string {
  const label = name.trim() || "Untitled";
  const sameName = peers.filter((p) => (p.name.trim() || "Untitled") === label);
  if (sameName.length < 2) return label;
  const withDetail = `${label} (${detail})`;
  const sameDetail = sameName.filter(
    (p) => `${p.name.trim() || "Untitled"} (${p.detail})` === withDetail,
  );
  return sameDetail.length > 1 ? `${withDetail} · ${id.slice(-4)}` : withDetail;
}

/** An empty percentage is not a zero. Keep the rate the user last entered. */
export function nextBonusRate(current: number, entered: number | null): number {
  return entered === null || !Number.isFinite(entered) ? current : entered;
}
