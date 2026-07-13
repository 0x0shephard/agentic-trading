// The 8 agent archetypes (see overhaul/AGENTIC_TRADING_ARCHITECTURE.md §3) and
// their default parameters. These are STARTING points — the controller tunes the
// live behaviour via knobs (strategy/knobs.ts). `macro` (#7) is LLM-driven and
// implemented in Phase 4; its params are declared here for completeness.

export type ArchetypeId =
  | "hedger-short" // 1 — Datacenter hedger (structural short)
  | "hedger-long" //  2 — Compute buyer / AI lab (structural long)
  | "basis-arb" //    3 — Basis / cash-and-carry arb (mean-reverting)
  | "momentum" //     4 — Momentum / CTA (trend)
  | "market-maker" // 5 — Counter-flow inventory mean-reverter
  | "hft-taker" //    6 — Stat-arb / HFT taker (many tiny round-trips)
  | "macro" //        7 — Macro / directional (LLM, Phase 4)
  | "degen" //        8 — Overleveraged degen (liquidation feedstock)
  | "mark-manipulator"; // 9 — Mark/oracle manipulator (funding exploiter)

export interface ArchetypeParams {
  id: ArchetypeId;
  label: string;
  /** Base Poisson action rate (actions/hour) before knob multipliers. */
  baseRatePerHour: number;
  /** Absolute position notional this agent builds toward, USD. 0 = flat-target. */
  targetNotionalUsd: number;
  /** Typical per-action notional, USD. */
  clipNotionalUsd: number;
  /** Target leverage (notional / margin). */
  targetLeverage: number;
  /** Side bias: -1 short-only, +1 long-only, 0 either. */
  sideBias: -1 | 0 | 1;
  /** Default slippage cap, bps. */
  slippageBps: number;
}

export const DEFAULT_ARCHETYPES: Record<ArchetypeId, ArchetypeParams> = {
  "hedger-short": {
    id: "hedger-short",
    label: "Datacenter hedger",
    baseRatePerHour: 0.5,
    targetNotionalUsd: 300,
    clipNotionalUsd: 150,
    targetLeverage: 2.5,
    sideBias: -1,
    slippageBps: 200,
  },
  "hedger-long": {
    id: "hedger-long",
    label: "Compute buyer",
    baseRatePerHour: 0.5,
    targetNotionalUsd: 300,
    clipNotionalUsd: 150,
    targetLeverage: 2.5,
    sideBias: 1,
    slippageBps: 200,
  },
  "basis-arb": {
    id: "basis-arb",
    label: "Basis arb",
    baseRatePerHour: 6,
    targetNotionalUsd: 0,
    clipNotionalUsd: 100,
    targetLeverage: 3,
    sideBias: 0,
    slippageBps: 150,
  },
  momentum: {
    id: "momentum",
    label: "Momentum / CTA",
    baseRatePerHour: 30,
    targetNotionalUsd: 0,
    clipNotionalUsd: 40,
    targetLeverage: 3,
    sideBias: 0,
    slippageBps: 150,
  },
  "market-maker": {
    id: "market-maker",
    label: "Market maker",
    baseRatePerHour: 240,
    targetNotionalUsd: 0,
    clipNotionalUsd: 20,
    targetLeverage: 2,
    sideBias: 0,
    slippageBps: 100,
  },
  "hft-taker": {
    id: "hft-taker",
    label: "Stat-arb / HFT",
    baseRatePerHour: 480,
    targetNotionalUsd: 0,
    clipNotionalUsd: 12,
    targetLeverage: 2,
    sideBias: 0,
    slippageBps: 100,
  },
  macro: {
    id: "macro",
    label: "Macro / directional",
    baseRatePerHour: 0.2,
    targetNotionalUsd: 500,
    clipNotionalUsd: 250,
    targetLeverage: 3,
    sideBias: 0,
    slippageBps: 200,
  },
  degen: {
    id: "degen",
    label: "Overleveraged degen",
    baseRatePerHour: 4,
    targetNotionalUsd: 0,
    clipNotionalUsd: 40,
    targetLeverage: 9,
    sideBias: 0,
    slippageBps: 300,
  },
  "mark-manipulator": {
    id: "mark-manipulator",
    label: "Mark manipulator",
    // Event-driven: push, hold a few ticks to harvest, unwind. Moderate cadence.
    baseRatePerHour: 12,
    targetNotionalUsd: 0,
    // Large clip — must actually move the thin vAMM to open a dislocation.
    clipNotionalUsd: 200,
    targetLeverage: 3,
    sideBias: 0,
    // Price-insensitive on entry: it WANTS to move price, so allow wide slippage
    // (its own impact must not reject the tx).
    slippageBps: 400,
  },
};
