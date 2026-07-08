import type { TradeEvent } from "../runtime/agentLoop";

/** Per-agent session counters, accumulated in-memory while the swarm runs. */
export interface AgentStats {
  trades: number; // successful sends
  volumeUsd: number; // successful traded notional
  opens: number;
  closes: number;
  reverts: number; // sent but reverted on-chain
  skips: number; // skipped (couldn't afford gas)
  gasUsed: bigint;
  gasCostWei: bigint;
}

function empty(): AgentStats {
  return { trades: 0, volumeUsd: 0, opens: 0, closes: 0, reverts: 0, skips: 0, gasUsed: 0n, gasCostWei: 0n };
}

/** Accumulates per-agent trade attribution for the fleet report. */
export class Attribution {
  private readonly stats = new Map<number, AgentStats>();

  record(index: number, e: TradeEvent): void {
    let s = this.stats.get(index);
    if (!s) {
      s = empty();
      this.stats.set(index, s);
    }
    if (e.skipped) {
      s.skips += 1;
      return;
    }
    if (e.gasUsed) s.gasUsed += e.gasUsed;
    if (e.gasCostWei) s.gasCostWei += e.gasCostWei;
    if (e.reverted) {
      s.reverts += 1;
      return;
    }
    s.trades += 1;
    s.volumeUsd += e.notionalUsd;
    if (e.intent === "open") s.opens += 1;
    else s.closes += 1;
  }

  get(index: number): AgentStats | undefined {
    return this.stats.get(index);
  }

  totalVolumeUsd(): number {
    let sum = 0;
    for (const s of this.stats.values()) sum += s.volumeUsd;
    return sum;
  }

  totalGasCostWei(): bigint {
    let sum = 0n;
    for (const s of this.stats.values()) sum += s.gasCostWei;
    return sum;
  }
}
