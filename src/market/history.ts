// Rolling, in-memory price history per market. Momentum reads moving averages and
// short-horizon returns from it. Cheap ring buffer; one instance per running agent
// (the loop appends the fresh mark/index each tick).

export interface PricePoint {
  t: number;
  markX18: bigint;
  indexX18: bigint;
}

export class MarketHistory {
  private readonly points: PricePoint[] = [];

  constructor(private readonly cap = 240) {}

  push(p: PricePoint): void {
    this.points.push(p);
    if (this.points.length > this.cap) this.points.shift();
  }

  get length(): number {
    return this.points.length;
  }

  latest(): PricePoint | undefined {
    return this.points[this.points.length - 1];
  }

  /** Simple moving average of the last n mark prices (x18), or null if too few. */
  smaMark(n: number): bigint | null {
    if (n <= 0 || this.points.length < n) return null;
    let sum = 0n;
    for (let i = this.points.length - n; i < this.points.length; i++) {
      sum += this.points[i]!.markX18;
    }
    return sum / BigInt(n);
  }

  /** Mark return over the last n steps, in bps (now vs n-steps-ago). */
  returnBps(n: number): number | null {
    if (n <= 0 || this.points.length <= n) return null;
    const prev = this.points[this.points.length - 1 - n]!.markX18;
    const now = this.points[this.points.length - 1]!.markX18;
    if (prev === 0n) return null;
    return Number(((now - prev) * 10000n) / prev);
  }
}
