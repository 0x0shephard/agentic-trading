import { parseUnits } from "viem";
import type { Strategy } from "./types";

const PROBE_SIZE = parseUnits("0.5", 18); // 0.5 GPU-hour — deliberately tiny

/**
 * Validation-only strategy: if flat, open a tiny position (random side); if in a
 * position, close it fully. Exercises the full runtime → executor → chain path.
 * Real archetypes replace this in Phase 3b.
 */
export const probeStrategy: Strategy = {
  name: "probe",
  decide(ctx) {
    if (ctx.account.sizeX18 === 0n) {
      const isLong = ctx.rng() < 0.5;
      return { kind: "open", isLong, baseSizeX18: PROBE_SIZE, slippageBps: 100, reason: "flat → open probe" };
    }
    return { kind: "close", fractionBps: 10000, slippageBps: 100, reason: "in position → close" };
  },
};
