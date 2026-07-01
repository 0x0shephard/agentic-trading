import type { Logger } from "pino";
import type { Rng } from "../runtime/rng";
import type { MarketSnapshot, AccountMarketState } from "../market/snapshot";
import type { MarketHistory } from "../market/history";
import type { Knobs } from "./knobs";
import type { ArchetypeParams } from "../config/archetypes";

/**
 * A strategy's decision for one tick. Deliberately small and declarative — the
 * strategy expresses *intent*; the executor (execution/act.ts) turns it into a
 * priced, slippage-bounded, simulate-gated transaction.
 */
export type Intent =
  | { kind: "hold"; reason?: string }
  | { kind: "open"; isLong: boolean; baseSizeX18: bigint; slippageBps: number; reason?: string }
  /** fractionBps of the CURRENT position to close: 10000 = full, 5000 = half. */
  | { kind: "close"; fractionBps: number; slippageBps: number; reason?: string };

export interface StrategyContext {
  now: number;
  rng: Rng;
  snapshot: MarketSnapshot;
  account: AccountMarketState;
  /** Rolling price history for this market (momentum/returns). */
  history: MarketHistory;
  /** Controller-set knobs (see strategy/knobs.ts). */
  knobs: Knobs;
  /** This agent's archetype parameters. */
  params: ArchetypeParams;
  logger: Logger;
}

export interface Strategy {
  readonly name: string;
  decide(ctx: StrategyContext): Intent | Promise<Intent>;
}
