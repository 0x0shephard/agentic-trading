import type { Strategy } from "../types";
import { baseSizeForNotionalX18 } from "../helpers";
import { toNumberX18 } from "../../preview/orderPreview";

// Safety cap so a degen can't nuke a thin vAMM during testing. Genuine
// liquidation feedstock comes from provisioning degens with SMALL collateral
// (per-archetype funding, Phase 3d) so this deploys most of their tiny balance.
const DEGEN_MAX_NOTIONAL_USD = 500;

/**
 * Archetype #8 — Overleveraged degen. Deploys most of its free collateral at
 * max leverage into a single position and then just holds it (into liquidation
 * if the market moves against it). Liquidation / ADL / neg-balance feedstock.
 */
export const degenStrategy: Strategy = {
  name: "degen",
  decide(ctx) {
    const { snapshot, account, params, knobs, rng } = ctx;
    if (account.sizeX18 !== 0n) return { kind: "hold", reason: "holding into liquidation (degen)" };

    const freeUsd = toNumberX18(account.freeCollateralX18);
    const notionalUsd = Math.min(
      freeUsd * params.targetLeverage * knobs.degenIntensity * 0.9,
      DEGEN_MAX_NOTIONAL_USD,
    );
    const size = baseSizeForNotionalX18(notionalUsd, snapshot.markPriceX18);
    if (size <= 0n) return { kind: "hold", reason: "no collateral" };
    return {
      kind: "open",
      isLong: rng() < 0.5,
      baseSizeX18: size,
      slippageBps: params.slippageBps,
      reason: `max-lev ${params.targetLeverage}x degen entry`,
    };
  },
};
