import type { Strategy } from "../types";
import { baseSizeForNotionalX18 } from "../helpers";

const FADE_MIN_BPS = 15; // fade a dislocation this size, else coin-flip

/**
 * Archetype #6 — Stat-arb / HFT taker. Tiny, fast round-trips: if flat, open a
 * small clip (fading any small dislocation, else random); if in a position,
 * immediately close it. The TPS / trade-count generator.
 */
export const hftTakerStrategy: Strategy = {
  name: "hft-taker",
  decide(ctx) {
    const { snapshot, account, params, rng } = ctx;
    if (account.sizeX18 !== 0n) {
      return { kind: "close", fractionBps: 10000, slippageBps: params.slippageBps, reason: "complete round-trip" };
    }
    const dev = snapshot.markIndexDevBps;
    const isLong = Math.abs(dev) >= FADE_MIN_BPS ? dev < 0 : rng() < 0.5;
    const size = baseSizeForNotionalX18(params.clipNotionalUsd, snapshot.markPriceX18);
    if (size <= 0n) return { kind: "hold", reason: "clip too small" };
    return { kind: "open", isLong, baseSizeX18: size, slippageBps: params.slippageBps, reason: "hft entry" };
  },
};
