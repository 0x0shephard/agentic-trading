import { sleep } from "../runtime/cadence";

/**
 * Token-bucket rate limiter for the global TPS cap. All agents share one bucket;
 * each acquires a token before sending a transaction, so the fleet's aggregate
 * send rate can't exceed `ratePerSec` (with a small `burst`). Protects the RPC /
 * nonce pool and keeps ETH burn bounded.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.ratePerSec);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(10, (deficit / this.ratePerSec) * 1000);
      await sleep(waitMs);
    }
  }
}
