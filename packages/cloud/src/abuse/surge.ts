/**
 * Global sign-up surge alert (spec 3.7): warn when the sign-ups of the current hour exceed 10x the mean of
 * the trailing 24 hours (with a floor, so a quiet service does not alert on its tenth sign-up). Memory is
 * 25 counters.
 */
import type { Logger } from "../log/index.js";

const HOUR = 3600 * 1000;

export class SurgeDetector {
  private readonly counts = new Map<number, number>();
  private alertedHour = -1;

  constructor(
    private readonly log: Logger,
    private readonly o: { factor?: number; floor?: number } = {},
  ) {}

  record(nowMs: number): void {
    const hour = Math.floor(nowMs / HOUR);
    this.counts.set(hour, (this.counts.get(hour) ?? 0) + 1);
    for (const h of this.counts.keys()) if (h < hour - 24) this.counts.delete(h);
    let sum = 0;
    for (let h = hour - 24; h < hour; h++) sum += this.counts.get(h) ?? 0;
    const mean = sum / 24;
    const current = this.counts.get(hour) ?? 0;
    const threshold = Math.max((this.o.factor ?? 10) * mean, this.o.floor ?? 50);
    if (current > threshold && this.alertedHour !== hour) {
      this.alertedHour = hour;
      this.log.warn("signup.surge", { count: current, limit: Math.round(threshold) });
    }
  }
}
