import { parseUnits } from "viem";
import { toNumberX18 } from "../preview/orderPreview";
import type { AccountMarketState } from "../market/snapshot";

/** Convert a USD notional to a base size (GPU-hours, x18) at the given price. */
export function baseSizeForNotionalX18(notionalUsd: number, priceX18: bigint): bigint {
  const price = toNumberX18(priceX18);
  if (price <= 0 || notionalUsd <= 0) return 0n;
  const base = notionalUsd / price;
  if (!Number.isFinite(base) || base <= 0) return 0n;
  return parseUnits(base.toFixed(18), 18);
}

/** Signed position notional in USD (>0 long, <0 short) at a reference price. */
export function positionNotionalUsd(account: AccountMarketState, priceX18: bigint): number {
  return toNumberX18(account.sizeX18) * toNumberX18(priceX18);
}

export function isLongPos(account: AccountMarketState): boolean {
  return account.sizeX18 > 0n;
}
