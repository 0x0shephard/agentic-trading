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
//
// NOTE: this is intentionally a curated subset to start; expand once validated.
export const MARKETS: readonly MarketDef[] = [
  {
    name: "H100-GPU-PERP",
    displayName: "H100 GPU",
    marketId: "0xa583a10b2c0991c6f416501cbea19895d7becde9398eff1b7f60ef1120547d53",
  },
  {
    name: "B200-PERP-V2",
    displayName: "B200 GPU",
    marketId: "0x02164b06b5fff171a87dbb519e6d639871a0cfbc0e44d411313256d0168b60fe",
  },
  {
    name: "H200-PERP-V2",
    displayName: "H200 GPU",
    marketId: "0x44830e9eceb656b494dfe3cff6e46a6774961143bd28655e8232777def9ba92c",
  },
  {
    name: "T4-PERP",
    displayName: "T4 GPU",
    marketId: "0xb1bae2ea6c465ce4acb7d8a4a16a8899c9cc94ac35b5a82403875c6b2aa34f3e",
  },
  {
    name: "A100-PERP",
    displayName: "A100 GPU",
    marketId: "0x7c611d543b87d4eecced3a16f8db373340d784390882ad3e2fd76f257a51cf55",
  },
] as const;

export const DEFAULT_MARKET: MarketDef = MARKETS[0]!;
