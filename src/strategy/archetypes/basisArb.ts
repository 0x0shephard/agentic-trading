import type { Strategy } from "../types";
import { baseSizeForNotionalX18, isLongPos } from "../helpers";

/**
 * Archetype #3 — Basis / cash-and-carry arb. Trades the mark-vs-index deviation:
 * when mark is rich (dev > +threshold) it shorts, when cheap it longs, sized to
 * the edge; unwinds on convergence and cuts if the deviation flips against it.
 * Pure mean-reversion — the truth test for the funding/peg mechanism.
 */
export const basisArbStrategy: Strategy = {
  name: "basis-arb",
  decide(ctx) {
    const { snapshot, account, params, knobs } = ctx;
    if (!snapshot.hasIndex) return { kind: "hold", reason: "no index — no basis signal" };

    const dev = snapshot.markIndexDevBps; // + = mark rich vs index
    const threshold = knobs.basisThresholdBps;
    const mark = snapshot.markPriceX18;

    if (account.sizeX18 === 0n) {
      if (Math.abs(dev) <= threshold) return { kind: "hold", reason: `dev ${dev}bps within threshold` };
      const mult = Math.min(3, Math.abs(dev) / threshold);
      const size = baseSizeForNotionalX18(params.clipNotionalUsd * mult, mark);
      if (size <= 0n) return { kind: "hold", reason: "clip too small" };
      const richShort = dev > 0; // mark rich → short
      return {
        kind: "open",
        isLong: !richShort,
        baseSizeX18: size,
        slippageBps: params.slippageBps,
        reason: `mark ${richShort ? "rich" : "cheap"} ${dev}bps → ${richShort ? "short" : "long"}`,
      };
    }

    const long = isLongPos(account);
    const convergeBand = Math.max(1, Math.round(threshold * 0.3));
    if (Math.abs(dev) <= convergeBand) {
      return { kind: "close", fractionBps: 10000, slippageBps: params.slippageBps, reason: `converged (${dev}bps) → unwind` };
    }
    if ((long && dev > threshold) || (!long && dev < -threshold)) {
      return { kind: "close", fractionBps: 10000, slippageBps: params.slippageBps, reason: "dev flipped against position → cut" };
    }
    return { kind: "hold", reason: `holding basis (dev ${dev}bps)` };
  },
};
