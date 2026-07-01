import type { Strategy } from "../types";
import { baseSizeForNotionalX18, positionNotionalUsd } from "../helpers";

const REVERT_BAND_BPS = 30; // dev inside this with a position → flatten (took the revert)
const DEAD_BAND_BPS = 20; //  dev inside this with no position → no edge, hold
const STRESS_BPS = 1500; //   dev beyond this → back off / de-risk

/**
 * Archetype #5 — Market maker / liquidity. Counter-flow inventory mean-reverter:
 * fades the mark's deviation from index (buys cheap, sells rich), capped by an
 * inventory band, flattens when the deviation reverts, and backs off in stress.
 */
export const marketMakerStrategy: Strategy = {
  name: "market-maker",
  decide(ctx) {
    const { snapshot, account, params, knobs } = ctx;
    if (!snapshot.hasIndex) return { kind: "hold", reason: "no index — MM idle" };

    const dev = snapshot.markIndexDevBps; // + = mark rich
    const mark = snapshot.markPriceX18;
    const hasPos = account.sizeX18 !== 0n;
    const inv = positionNotionalUsd(account, mark); // signed inventory, USD

    if (hasPos && Math.abs(dev) <= REVERT_BAND_BPS) {
      return { kind: "close", fractionBps: 10000, slippageBps: params.slippageBps, reason: `reverted (${dev}bps) → flatten` };
    }
    if (Math.abs(dev) >= STRESS_BPS) {
      if (hasPos) return { kind: "close", fractionBps: 5000, slippageBps: params.slippageBps, reason: `stress ${dev}bps → de-risk` };
      return { kind: "hold", reason: `stress ${dev}bps → stand aside` };
    }
    if (Math.abs(dev) < DEAD_BAND_BPS) return { kind: "hold", reason: "no edge" };

    const band = params.clipNotionalUsd * 4; // inventory cap per side
    const clip = params.clipNotionalUsd * Math.max(0, Math.min(1, knobs.mmParticipation));
    if (clip <= 0) return { kind: "hold", reason: "participation 0" };

    const wantLong = dev < 0; // mark cheap → buy; mark rich → sell
    if (wantLong) {
      if (inv >= band) return { kind: "hold", reason: "inventory long-capped" };
      const size = baseSizeForNotionalX18(clip, mark);
      if (size <= 0n) return { kind: "hold", reason: "clip too small" };
      return { kind: "open", isLong: true, baseSizeX18: size, slippageBps: params.slippageBps, reason: `fade cheap ${dev}bps → buy` };
    }
    if (inv <= -band) return { kind: "hold", reason: "inventory short-capped" };
    const size = baseSizeForNotionalX18(clip, mark);
    if (size <= 0n) return { kind: "hold", reason: "clip too small" };
    return { kind: "open", isLong: false, baseSizeX18: size, slippageBps: params.slippageBps, reason: `fade rich +${dev}bps → sell` };
  },
};
