import type { Account } from "viem";
import type { MarketDef } from "../config/markets";
import type { Intent } from "../strategy/types";
import type { WriteResult } from "../chain/tx";
import { executeWrite } from "../chain/tx";
import { CONTRACTS } from "../config/addresses";
import { clearingHouseAbi } from "../chain/abis";
import { getMarketConfig, getReserves, getPosition } from "../chain/market";
import { quoteMarket, amountLimitWithSlippage } from "../preview/sizing";
import { toNumberX18 } from "../preview/orderPreview";

export type ActResult =
  | { acted: true; intent: Intent["kind"]; write: WriteResult; notionalUsd: number }
  | { acted: false; intent: Intent["kind"]; reason: string };

/**
 * Turn a strategy Intent into a real (or dry-run) transaction. Prices from live
 * reserves, applies the slippage bound, and routes through executeWrite (which
 * simulates first, buffers gas, and verifies the receipt). Never assumes the
 * strategy's view of the position — always re-reads before closing.
 */
export async function executeIntent(
  account: Account,
  market: MarketDef,
  intent: Intent,
): Promise<ActResult> {
  if (intent.kind === "hold") {
    return { acted: false, intent: "hold", reason: intent.reason ?? "hold" };
  }

  const cfg = await getMarketConfig(market.marketId);
  if (cfg.paused) return { acted: false, intent: intent.kind, reason: "market paused" };
  const feeBps = BigInt(cfg.feeBps);

  if (intent.kind === "open") {
    if (intent.baseSizeX18 <= 0n) return { acted: false, intent: "open", reason: "non-positive size" };
    const { base, quote } = await getReserves(cfg.vamm);
    const q = quoteMarket({
      isLong: intent.isLong,
      baseSize: intent.baseSizeX18,
      reserveBase: base,
      reserveQuote: quote,
      feeBps,
    });
    const amountLimit = amountLimitWithSlippage(intent.isLong, q.quoteAmount, intent.slippageBps);
    const write = await executeWrite({
      account,
      address: CONTRACTS.clearingHouse,
      abi: clearingHouseAbi,
      functionName: "openPosition",
      args: [market.marketId, intent.isLong, intent.baseSizeX18, amountLimit],
      label: `open ${market.name} ${intent.isLong ? "long" : "short"}`,
    });
    return { acted: true, intent: "open", write, notionalUsd: toNumberX18(q.quoteAmount) };
  }

  // close
  const pos = await getPosition(account.address, market.marketId);
  if (pos.size === 0n) return { acted: false, intent: "close", reason: "no position" };
  const isLongPos = pos.size > 0n;
  const full = isLongPos ? pos.size : -pos.size;
  const frac = BigInt(Math.max(0, Math.min(10000, Math.round(intent.fractionBps))));
  let closeSize = (full * frac) / 10000n;
  if (closeSize <= 0n) return { acted: false, intent: "close", reason: "computed close size 0" };
  if (closeSize > full) closeSize = full;

  const { base, quote } = await getReserves(cfg.vamm);
  const q = quoteMarket({
    isLong: !isLongPos,
    baseSize: closeSize,
    reserveBase: base,
    reserveQuote: quote,
    feeBps,
  });
  const amountLimit = amountLimitWithSlippage(!isLongPos, q.quoteAmount, intent.slippageBps);
  const write = await executeWrite({
    account,
    address: CONTRACTS.clearingHouse,
    abi: clearingHouseAbi,
    functionName: "closePosition",
    args: [market.marketId, closeSize, amountLimit],
    label: `close ${market.name}`,
  });
  return { acted: true, intent: "close", write, notionalUsd: toNumberX18(q.quoteAmount) };
}
