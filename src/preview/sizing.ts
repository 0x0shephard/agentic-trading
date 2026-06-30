import { quoteBuy, quoteSell, type QuoteResult } from "./orderPreview";

/** Quote a market order of `baseSize` (x18 base) against current reserves. */
export function quoteMarket(p: {
  isLong: boolean;
  baseSize: bigint;
  reserveBase: bigint;
  reserveQuote: bigint;
  feeBps: bigint;
  minReserveBase?: bigint;
  minReserveQuote?: bigint;
}): QuoteResult {
  return p.isLong
    ? quoteBuy({
        baseAmount: p.baseSize,
        reserveBase: p.reserveBase,
        reserveQuote: p.reserveQuote,
        minReserveBase: p.minReserveBase ?? 0n,
        feeBps: p.feeBps,
      })
    : quoteSell({
        baseAmount: p.baseSize,
        reserveBase: p.reserveBase,
        reserveQuote: p.reserveQuote,
        minReserveQuote: p.minReserveQuote ?? 0n,
        feeBps: p.feeBps,
      });
}

/**
 * amountLimit (slippage bound) for a MARKET order, matching the contract's semantics:
 *   long  → max quote willing to PAY     → must be >= quoteAmount → add slippage.
 *   short → min quote willing to RECEIVE → must be <= quoteAmount → subtract slippage.
 */
export function amountLimitWithSlippage(
  isLong: boolean,
  quoteAmount: bigint,
  slippageBps: number,
): bigint {
  const bps = BigInt(Math.max(0, Math.round(slippageBps)));
  const delta = (quoteAmount * bps) / 10000n;
  return isLong ? quoteAmount + delta : quoteAmount - delta;
}
