import type { Account, Address } from "viem";
import type { MarketDef } from "../config/markets";
import { getMarketConfig, getReserves, getMarkPrice, getIndexPrice, getPosition } from "../chain/market";
import { vaultBalance } from "../collateral/collateral";
import { USDC_DECIMALS, WAD_DECIMALS, ZERO_ADDRESS } from "../config/constants";

/** Everything a strategy needs to know about a market at a point in time. */
export interface MarketSnapshot {
  def: MarketDef;
  vamm: Address;
  oracle: Address;
  feeBps: number;
  paused: boolean;
  reserveBase: bigint;
  reserveQuote: bigint;
  markPriceX18: bigint;
  /** Index/oracle price (x18). Falls back to mark when no oracle is available. */
  indexPriceX18: bigint;
  /** True when indexPriceX18 came from the oracle (not the mark fallback). */
  hasIndex: boolean;
  /** (mark - index) / index, in basis points. Positive = mark rich vs index. */
  markIndexDevBps: number;
}

export async function getMarketSnapshot(def: MarketDef): Promise<MarketSnapshot> {
  const cfg = await getMarketConfig(def.marketId);
  const [{ base, quote }, mark] = await Promise.all([getReserves(cfg.vamm), getMarkPrice(cfg.vamm)]);

  let indexPriceX18 = mark;
  let hasIndex = false;
  if (cfg.oracle && cfg.oracle !== ZERO_ADDRESS) {
    try {
      indexPriceX18 = await getIndexPrice(cfg.oracle);
      hasIndex = true;
    } catch {
      // Oracle unreadable → fall back to mark (deviation becomes 0 = no signal).
      indexPriceX18 = mark;
    }
  }

  const markIndexDevBps =
    indexPriceX18 > 0n ? Number(((mark - indexPriceX18) * 10000n) / indexPriceX18) : 0;

  return {
    def,
    vamm: cfg.vamm,
    oracle: cfg.oracle,
    feeBps: cfg.feeBps,
    paused: cfg.paused,
    reserveBase: base,
    reserveQuote: quote,
    markPriceX18: mark,
    indexPriceX18,
    hasIndex,
    markIndexDevBps,
  };
}

/** An agent's own state in one market. */
export interface AccountMarketState {
  address: Address;
  sizeX18: bigint; // signed: >0 long, <0 short, 0 flat
  marginX18: bigint;
  entryPriceX18: bigint;
  realizedPnLX18: bigint;
  vaultUsdc6: bigint;
  /**
   * Vault balance scaled to x18. NOTE: this is an UPPER-BOUND estimate of
   * deployable collateral — depending on how the protocol reserves margin it may
   * overstate what's actually free. The simulate-gate in executeWrite is the
   * real guard against over-leverage; strategies use this only for coarse sizing.
   */
  freeCollateralX18: bigint;
}

const USDC_TO_WAD = 10n ** BigInt(WAD_DECIMALS - USDC_DECIMALS); // 1e12

export async function getAccountMarketState(account: Account, def: MarketDef): Promise<AccountMarketState> {
  const [pos, vault] = await Promise.all([
    getPosition(account.address, def.marketId),
    vaultBalance(account.address),
  ]);
  return {
    address: account.address,
    sizeX18: pos.size,
    marginX18: pos.margin,
    entryPriceX18: pos.entryPriceX18,
    realizedPnLX18: pos.realizedPnL,
    vaultUsdc6: vault,
    freeCollateralX18: vault * USDC_TO_WAD,
  };
}
