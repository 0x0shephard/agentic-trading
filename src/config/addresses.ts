import type { Address } from "viem";

// ByteStrike contracts on Sepolia (mirrors overhaul/src/contracts/addresses.js).
// Per-market vAMM / oracle / fee params are NOT hardcoded here — they are read at
// runtime from MarketRegistry.getMarket(marketId), so the chain stays the single
// source of truth and a stale address can't silently route an order wrong.
export const CONTRACTS = {
  clearingHouse: "0xDf4DDD4019097B335dD507f916984A1A53E40a0d",
  collateralVault: "0x44345dFCD97973329A88aaE8c1432ea90525Ed13",
  marketRegistry: "0x236b75D39203506ee3180Ef2E1c7460a188C43c6",
  feeRouter: "0xBCEA366b30eb1dcAC6968AECcc215E8797553a5e",
  insuranceFund: "0x132Ba3d3073FDa7440fb0594210C47eC19087eaD",
  usdc: "0x947Cc17D8CbC0Fc1E64de138eE4947d3AF9C26EE",
  cuOracle: "0x97f557594bA32e51c0eA215B1886111F24E957af",
  treasury: "0xCc624fFA5df1F3F4b30aa8abd30186a86254F406",
} as const satisfies Record<string, Address>;
