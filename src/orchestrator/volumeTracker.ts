// Rolling traded-notional tracker (USD) over a time window. The orchestrator
// feeds it every executed trade; the controller reads windowed volume to compare
// against the Vol target.
export class VolumeTracker {
  private events: { t: number; usd: number }[] = [];

  constructor(private readonly windowMs = 3_600_000) {}

  record(notionalUsd: number): void {
    if (notionalUsd > 0) this.events.push({ t: Date.now(), usd: notionalUsd });
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.events.length > 0 && this.events[0]!.t < cutoff) this.events.shift();
  }

  volumeUsd(): number {
    this.prune(Date.now());
    return this.events.reduce((sum, e) => sum + e.usd, 0);
  }
}
