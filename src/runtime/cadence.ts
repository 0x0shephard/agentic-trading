import type { Rng } from "./rng";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep up to `ms`, but wake early (within ~stepMs) if `abort()` becomes true.
 * Keeps shutdown/kill prompt even when an agent draws a long Poisson delay.
 */
export async function sleepUntil(ms: number, abort: () => boolean, stepMs = 250): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (abort()) return;
    await sleep(Math.min(stepMs, end - Date.now()));
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Exponential inter-arrival time for a Poisson process of `ratePerHour` events
 * per hour. Using real inter-arrival times (rather than a fixed tick) keeps the
 * flow realistic and — critically — keeps ETH spend bounded and predictable
 * instead of hammering the chain every second.
 */
export function poissonDelayMs(ratePerHour: number, rng: Rng): number {
  if (ratePerHour <= 0) return Number.POSITIVE_INFINITY;
  const ratePerMs = ratePerHour / 3_600_000;
  const u = clamp(rng(), 1e-12, 1 - 1e-12);
  return -Math.log(u) / ratePerMs;
}
