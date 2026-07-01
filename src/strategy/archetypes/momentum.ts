import type { Strategy } from "../types";
import { baseSizeForNotionalX18, isLongPos, positionNotionalUsd } from "../helpers";

const FAST = 5;
const SLOW = 20;
const MAX_PYRAMID_MULT = 3; // cap adds at 3 clips of notional

/**
 * Archetype #4 — Momentum / CTA. Fast/slow SMA cross defines the trend: enter
 * with it, pyramid on continuation up to a cap, and cut fully on reversal. Holds
 * while warming up (not enough history for the slow MA).
 */
export const momentumStrategy: Strategy = {
  name: "momentum",
  decide(ctx) {
    const { snapshot, account, history, params } = ctx;
    const fast = history.smaMark(FAST);
    const slow = history.smaMark(SLOW);
    if (fast === null || slow === null) return { kind: "hold", reason: "warming up (insufficient history)" };

    const trendUp = fast > slow;
    const trendDown = fast < slow;
    const mark = snapshot.markPriceX18;

    if (account.sizeX18 === 0n) {
      if (!trendUp && !trendDown) return { kind: "hold", reason: "no trend" };
      const size = baseSizeForNotionalX18(params.clipNotionalUsd, mark);
      if (size <= 0n) return { kind: "hold", reason: "clip too small" };
      return {
        kind: "open",
        isLong: trendUp,
        baseSizeX18: size,
        slippageBps: params.slippageBps,
        reason: trendUp ? "uptrend → long" : "downtrend → short",
      };
    }

    const long = isLongPos(account);
    if ((long && trendDown) || (!long && trendUp)) {
      return { kind: "close", fractionBps: 10000, slippageBps: params.slippageBps, reason: "trend reversed → cut" };
    }
    const notionalAbs = Math.abs(positionNotionalUsd(account, mark));
    if (notionalAbs < params.clipNotionalUsd * MAX_PYRAMID_MULT) {
      const size = baseSizeForNotionalX18(params.clipNotionalUsd, mark);
      if (size <= 0n) return { kind: "hold", reason: "clip too small" };
      return { kind: "open", isLong: long, baseSizeX18: size, slippageBps: params.slippageBps, reason: "continuation → add" };
    }
    return { kind: "hold", reason: "at max pyramid" };
  },
};
