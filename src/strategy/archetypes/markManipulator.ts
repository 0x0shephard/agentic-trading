import type { Strategy } from "../types";
import { baseSizeForNotionalX18 } from "../helpers";

// Only attack from a reasonably tight peg — creating a fresh dislocation is the
// point; if the mark is already far from index, stay out (don't stack risk).
const ATTACK_MAX_DEV_BPS = 400;
// Once the mark has been arbed back to ~the peg, the dislocation is gone → escape.
const UNWIND_REVERT_BAND_BPS = 30;
// Per-tick probability of a timed "harvest window elapsed" unwind (≈ 1/p ticks held).
const UNWIND_PROB = 0.18;

/**
 * Archetype #9 — Mark / oracle manipulator (funding exploiter). The INVERSE of
 * basis-arb: rather than fading the mark-vs-index gap, it deliberately *opens* one
 * — a large one-directional clip pushes mark away from index, held briefly to
 * harvest funding / trigger others' liquidations, then round-tripped out. This is
 * intentionally anti-social flow: it's the pattern the surveillance / admin
 * notification layer must detect.
 *
 * Stateless, like the other archetypes: phases are inferred from the on-chain
 * position plus a probabilistic timed exit (no per-agent timer needed).
 */
export const markManipulatorStrategy: Strategy = {
  name: "mark-manipulator",
  decide(ctx) {
    const { snapshot, account, params, rng } = ctx;
    if (!snapshot.hasIndex) return { kind: "hold", reason: "no index — nothing to manipulate against" };

    const dev = snapshot.markIndexDevBps; // + = mark rich vs index
    const mark = snapshot.markPriceX18;

    // ── Flat: open a large clip to WIDEN the mark-index gap ──────────────────
    if (account.sizeX18 === 0n) {
      if (Math.abs(dev) >= ATTACK_MAX_DEV_BPS) {
        return { kind: "hold", reason: `already dislocated (${dev}bps) — stand aside` };
      }
      const size = baseSizeForNotionalX18(params.clipNotionalUsd, mark);
      if (size <= 0n) return { kind: "hold", reason: "clip too small" };
      const pushLong = dev >= 0; // push further in the current direction of the gap
      return {
        kind: "open",
        isLong: pushLong,
        baseSizeX18: size,
        slippageBps: params.slippageBps,
        reason: `push mark ${pushLong ? "up" : "down"} to dislocate from index (${dev}bps)`,
      };
    }

    // ── In position: hold the dislocation, then unwind ──────────────────────
    if (Math.abs(dev) <= UNWIND_REVERT_BAND_BPS) {
      return { kind: "close", fractionBps: 10000, slippageBps: params.slippageBps, reason: `dislocation faded (${dev}bps) → unwind` };
    }
    if (rng() < UNWIND_PROB) {
      return { kind: "close", fractionBps: 10000, slippageBps: params.slippageBps, reason: "harvest window elapsed → unwind & escape" };
    }
    return { kind: "hold", reason: `holding dislocation (${dev}bps) to harvest funding` };
  },
};
