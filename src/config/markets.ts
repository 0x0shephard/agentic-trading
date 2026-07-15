import type { Hex } from "viem";

export interface MarketDef {
  /** Canonical market key (matches overhaul MARKET_IDS). */
  name: string;
  displayName: string;
  /** bytes32 market id passed to ClearingHouse / MarketRegistry. */
  marketId: Hex;
}

// The live GPU-index markets we trade against. Everything else about each market
// (vAMM, oracle, feeBps, baseUnit, quoteToken, paused) is resolved at runtime via
// MarketRegistry.getMarket(). The boot validator (src/index.ts) checks every id
// here against the chain, so a mistyped marketId fails fast and loudly.
export const MARKETS: readonly MarketDef[] = [
  {
    name: "A100-PERP",
    displayName: "A100 GPU",
    marketId: "0x7c611d543b87d4eecced3a16f8db373340d784390882ad3e2fd76f257a51cf55",
  },
  {
    name: "AWS-H100-PERP",
    displayName: "AWS H100 GPU",
    marketId: "0x69df00e859e1b007896c59653bb3ca35622fdf2bf46c2fd9fea7ffa7d88b6378",
  },
  {
    name: "AZURE-H100-PERP",
    displayName: "Azure H100 GPU",
    marketId: "0x2492e86fcfe9b174434dfca2c27205159a34cf4e90f0ec7a1605fae91a7e7bbd",
  },
  {
    name: "GCP-H100-PERP",
    displayName: "GCP H100 GPU",
    marketId: "0x8c78c8c17cc7712fe1b17592a2c0a7f814f8ec784de0fbb4ae6573e3457e11dd",
  },
  {
    name: "T4-PERP",
    displayName: "T4 GPU",
    marketId: "0xb1bae2ea6c465ce4acb7d8a4a16a8899c9cc94ac35b5a82403875c6b2aa34f3e",
  },
  {
    name: "H100-GPU-PERP",
    displayName: "H100 GPU",
    marketId: "0xa583a10b2c0991c6f416501cbea19895d7becde9398eff1b7f60ef1120547d53",
  },
  {
    name: "H100-HyperScalers-PERP",
    displayName: "H100 Hyperscalers",
    marketId: "0xf4aa47cc83b0d01511ca8025a996421dda6fbab1764466da4b0de6408d3db2e2",
  },
  {
    name: "H100-non-HyperScalers-PERP-V2",
    displayName: "H100 non-Hyperscalers",
    marketId: "0x477dc2e232406bbfce22f7ed7abfde0177a869d41729ed1f3e169f1014716ce8",
  },
  {
    name: "ORACLE-H200-PERPETUAL",
    displayName: "Oracle H200 Hour",
    marketId: "0x61f05fafb6842941c9a7d6839378de32d97a2de181b4db0e276b8d2093b61866",
  },
  {
    name: "AWS-H200-PERPETUAL",
    displayName: "AWS H200 Hour",
    marketId: "0x12aa394c59dbf446e7ba1d3ab66f4629761c27d0dbacf484da0f4b205260c8fc",
  },
] as const;

export const DEFAULT_MARKET: MarketDef = MARKETS[0]!;
