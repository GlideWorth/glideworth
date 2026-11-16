/**
 * Counting semaphore with a bounded FIFO wait queue. A full queue rejects at once instead of letting waiters
 * (and their closures) pile up without limit under a flood.
 */
export class Semaphore {
  private active = 0;
  private peak = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    readonly max: number,
    private readonly maxQueue = Number.POSITIVE_INFINITY,
  ) {
    if (!Number.isInteger(max) || max < 1)
      throw new Error("semaphore size must be a positive integer");
  }

  /** Resolves with a release function once a slot is free. Rejects with `SemaphoreFullError` when saturated. */
  acquire(): Promise<() => void> {
    if (this.active < this.max) return Promise.resolve(this.take());
    if (this.queue.length >= this.maxQueue) return Promise.reject(new SemaphoreFullError());
    return new Promise((resolve) => this.queue.push(() => resolve(this.take())));
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  stats(): { active: number; waiting: number; peak: number } {
    return { active: this.active, waiting: this.queue.length, peak: this.peak };
  }

  resetPeak(): void {
    this.peak = this.active;
  }

  private take(): () => void {
    this.active++;
    if (this.active > this.peak) this.peak = this.active;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

export class SemaphoreFullError extends Error {
  constructor() {
    super("too many operations waiting");
    this.name = "SemaphoreFullError";
  }
}
