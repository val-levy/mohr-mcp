const WINDOW_MS = 60_000;
const SWEEP_EVERY = 1_000;

/**
 * Caps tool calls per account per minute. Counts live in this process only, so with several
 * instances the effective ceiling is higher; the limit exists to stop runaway loops, not to meter use.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private checks = 0;

  constructor(private readonly limit = 120) {}

  /** Counts one call for `key` and returns false if it is over the limit for the current minute. */
  allow(key: string): boolean {
    const time = Date.now();
    if (++this.checks % SWEEP_EVERY === 0) this.sweep(time);
    const window = this.windows.get(key);
    if (!window || time - window.startedAt >= WINDOW_MS) {
      this.windows.set(key, { startedAt: time, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.limit;
  }

  private sweep(time: number): void {
    for (const [key, window] of this.windows) {
      if (time - window.startedAt >= WINDOW_MS) this.windows.delete(key);
    }
  }
}
