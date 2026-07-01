import type { Address, Hex } from "viem";
import { publicClient } from "./clients";
import { CONTRACTS } from "../config/addresses";
import { marketRegistryAbi, vammAbi, clearingHouseAbi, oracleAbi } from "./abis";

export interface MarketConfig {
  vamm: Address;
  feeBps: number;
  paused: boolean;
  oracle: Address;
  feeRouter: Address;
  insuranceFund: Address;
  baseAsset: Address;
  quoteToken: Address;
  baseUnit: bigint;
}

export async function getMarketConfig(marketId: Hex): Promise<MarketConfig> {
  const m = await publicClient.readContract({
    address: CONTRACTS.marketRegistry,
    abi: marketRegistryAbi,
    functionName: "getMarket",
    args: [marketId],
  });
  return {
    vamm: m.vamm,
    feeBps: Number(m.feeBps),
    paused: m.paused,
    oracle: m.oracle,
    feeRouter: m.feeRouter,
    insuranceFund: m.insuranceFund,
    baseAsset: m.baseAsset,
    quoteToken: m.quoteToken,
    baseUnit: m.baseUnit,
  };
}

export async function getReserves(vamm: Address): Promise<{ base: bigint; quote: bigint }> {
  const [base, quote] = await publicClient.readContract({
    address: vamm,
    abi: vammAbi,
    functionName: "getReserves",
  });
  return { base, quote };
}

export async function getMarkPrice(vamm: Address): Promise<bigint> {
  return publicClient.readContract({ address: vamm, abi: vammAbi, functionName: "getMarkPrice" });
}

/** Index (oracle) price, x18. Reads the per-market oracle adapter's getPrice(). */
export async function getIndexPrice(oracle: Address): Promise<bigint> {
  return publicClient.readContract({ address: oracle, abi: oracleAbi, functionName: "getPrice" });
}

export interface Position {
  size: bigint; // signed: >0 long, <0 short
  margin: bigint;
  entryPriceX18: bigint;
  realizedPnL: bigint;
}

export async function getPosition(account: Address, marketId: Hex): Promise<Position> {
  const p = await publicClient.readContract({
    address: CONTRACTS.clearingHouse,
    abi: clearingHouseAbi,
    functionName: "getPosition",
    args: [account, marketId],
  });
  return { size: p.size, margin: p.margin, entryPriceX18: p.entryPriceX18, realizedPnL: p.realizedPnL };
}
