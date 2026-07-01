import type { MarketDef } from "../config/markets";
import { agentAccount } from "../chain/clients";
import { getMarketSnapshot } from "../market/snapshot";
import { getPosition } from "../chain/market";
import { vaultBalance } from "../collateral/collateral";
import { toNumberX18 } from "../preview/orderPreview";
import { USDC_DECIMALS } from "../config/constants";
import type { VolumeTracker } from "../orchestrator/volumeTracker";

export interface Metrics {
  oiUsd: number; // gross Σ|position notional| across the fleet
  longOiUsd: number;
  shortOiUsd: number;
  tvlUsd: number; // Σ vault balances
  volumeUsd: number; // windowed traded notional
}

/**
 * Measure exchange-wide OI / TVL / Volume for the fleet. OI and TVL are read
 * on-chain (positions × mark, and vault balances); Volume comes from the running
 * VolumeTracker the orchestrator feeds.
 */
export async function measureMetrics(
  indices: number[],
  markets: readonly MarketDef[],
  volume: VolumeTracker,
): Promise<Metrics> {
  const marks = new Map<string, number>();
  for (const m of markets) {
    const s = await getMarketSnapshot(m);
    marks.set(m.marketId, toNumberX18(s.markPriceX18));
  }

  let longOi = 0;
  let shortOi = 0;
  let tvl = 0;
  for (const idx of indices) {
    const acct = agentAccount(idx);
    const v = await vaultBalance(acct.address);
    tvl += Number(v) / 10 ** USDC_DECIMALS;
    for (const m of markets) {
      const pos = await getPosition(acct.address, m.marketId);
      if (pos.size === 0n) continue;
      const notional = Math.abs(toNumberX18(pos.size)) * (marks.get(m.marketId) ?? 0);
      if (pos.size > 0n) longOi += notional;
      else shortOi += notional;
    }
  }

  return {
    oiUsd: longOi + shortOi,
    longOiUsd: longOi,
    shortOiUsd: shortOi,
    tvlUsd: tvl,
    volumeUsd: volume.volumeUsd(),
  };
}
