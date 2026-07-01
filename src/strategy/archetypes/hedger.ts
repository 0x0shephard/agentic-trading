import type { Strategy } from "../types";
import { baseSizeForNotionalX18, positionNotionalUsd } from "../helpers";

/**
 * Archetypes #1 (Datacenter hedger, short) and #2 (Compute buyer, long) — one
 * module, direction chosen by params.sideBias. Builds a structural position
 * toward a target notional at the controller's build-rate, price-insensitive,
 * and trims if it drifts above target. Slow and sticky.
 */
export const hedgerStrategy: Strategy = {
  name: "hedger",
  decide(ctx) {
    const { snapshot, account, params, knobs } = ctx;
    const desiredSign = params.sideBias;
    if (desiredSign === 0) return { kind: "hold", reason: "hedger needs a side bias" };

    const mark = snapshot.markPriceX18;
    const target = params.targetNotionalUsd * knobs.buildRate;
    const posNotional = positionNotionalUsd(account, mark); // signed
    const dirNotional = desiredSign > 0 ? posNotional : -posNotional; // held in desired dir
    const deadband = params.clipNotionalUsd * 0.5;

    if (dirNotional < target - deadband) {
      const want = Math.min(params.clipNotionalUsd, target - dirNotional);
      const size = baseSizeForNotionalX18(want, mark);
      if (size <= 0n) return { kind: "hold", reason: "clip too small" };
      return {
        kind: "open",
        isLong: desiredSign > 0,
        baseSizeX18: size,
        slippageBps: params.slippageBps,
        reason: `build toward ${desiredSign > 0 ? "long" : "short"} target`,
      };
    }
    if (dirNotional > target * 1.15) {
      const excess = dirNotional - target;
      const frac = Math.round((excess / dirNotional) * 10000);
      return { kind: "close", fractionBps: frac, slippageBps: params.slippageBps, reason: "trim above target" };
    }
    return { kind: "hold", reason: "at hedge target" };
  },
};
