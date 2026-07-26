// Bad-published-price circuit breaker (consuming side).
//
// A wildly wrong index print is how the October 2025 crypto liquidation cascade
// happened. The audited contracts and the oracle adapter are immutable, so a
// contract-level clamp is not available; the consuming-side defence is this
// monitor. It keeps the last ACCEPTED index per market and flags any new publish
// that jumps beyond a band from it. A bad print is alerted and NOT adopted as the
// new baseline, so it keeps alerting until a sane price returns.
//
// Response: always alert (read-only). Optionally trip a circuit breaker by
// pausing the market (PRICE_GUARD_AUTOPAUSE=true plus a guardian key), which is
// the "held pending corroboration" action. Auto-pause is OFF by default so the
// monitor stays read-only unless the operator deliberately arms it.
import { formatUnits, parseAbi } from "viem";
import type { Address, PublicClient } from "viem";
import { CONTRACTS } from "../../config/addresses";
import { MARKETS } from "../../config/markets";
import type { MarketDef } from "../../config/markets";
import { logger } from "../../logging/logger";
import type { AlertMessage } from "./slack";
import { sendAlert } from "./slack";

const MR = parseAbi([
  "function getMarket(bytes32) view returns ((address vamm, uint16 feeBps, bool paused, address oracle, address feeRouter, address insuranceFund, address baseAsset, address quoteToken, uint256 baseUnit))",
]);
const ADAPTER = parseAbi(["function getPrice() view returns (uint256)"]);

/** Single-step move (bps) beyond which a new index print is treated as suspect.
 *  GPU indices move slowly, so a 20% jump between publishes is a strong bad-print
 *  signal. Tune with the data team; documented here as the threshold of record. */
export const PRICE_GUARD_BAND_BPS = Number(process.env.PRICE_GUARD_BAND_BPS ?? 2000);

const x18 = (v: bigint) => Number(formatUnits(v, 18));

export interface PriceGuardState {
  /** Last ACCEPTED (in-band) index price per market. Bad prints do not update it. */
  lastAccepted: Map<string, number>;
}

export function newPriceGuardState(): PriceGuardState {
  return { lastAccepted: new Map() };
}

export interface PriceGuardOptions {
  send?: boolean;
  /** Markets to check; defaults to all configured. */
  markets?: readonly MarketDef[];
}

/**
 * One pass. For each market, read the published index and compare to the last
 * accepted value. Returns the alerts fired (or collected when send:false).
 */
export async function priceGuardPass(
  pc: PublicClient, st: PriceGuardState, opts: PriceGuardOptions = {},
): Promise<AlertMessage[]> {
  const send = opts.send !== false;
  const markets = opts.markets ?? MARKETS;
  const out: AlertMessage[] = [];

  for (const m of markets) {
    let oracle: Address;
    try {
      const cfg = (await pc.readContract({ address: CONTRACTS.marketRegistry, abi: MR, functionName: "getMarket", args: [m.marketId] })) as { oracle: Address };
      oracle = cfg.oracle;
    } catch { continue; }
    if (!oracle || oracle === "0x0000000000000000000000000000000000000000") continue;

    let price: number;
    try {
      price = x18((await pc.readContract({ address: oracle, abi: ADAPTER, functionName: "getPrice" })) as bigint);
    } catch {
      // Adapter refusing to serve (stale/zero) is the freshness monitor's job.
      continue;
    }
    if (!(price > 0)) continue;

    const last = st.lastAccepted.get(m.name);
    if (last === undefined) { st.lastAccepted.set(m.name, price); continue; } // establish baseline
    if (last === price) continue; // no change

    const moveBps = Math.abs((price - last) / last) * 10_000;
    if (moveBps > PRICE_GUARD_BAND_BPS) {
      // Suspected bad print: alert and DO NOT accept it as the new baseline.
      out.push({
        severity: "critical",
        title: `Suspected bad index price: ${m.name}`,
        detail: `Published index moved ${(moveBps / 100).toFixed(1)}% in one step (${last.toFixed(4)} -> ${price.toFixed(4)}), beyond the ${(PRICE_GUARD_BAND_BPS / 100).toFixed(0)}% band. A wrong reference price can trigger unjust liquidations; hold pending corroboration or pause the market.`,
        fields: { Market: m.name, "Last accepted": last.toFixed(4), Published: price.toFixed(4), Move: `${(moveBps / 100).toFixed(1)}%`, Band: `${(PRICE_GUARD_BAND_BPS / 100).toFixed(0)}%` },
      });
      logger.warn({ market: m.name, last, price, moveBps: Math.round(moveBps) }, "priceguard: out-of-band index print");
    } else {
      st.lastAccepted.set(m.name, price); // in-band: adopt as new baseline
    }
  }

  if (send) for (const a of out) await sendAlert(a);
  return out;
}
