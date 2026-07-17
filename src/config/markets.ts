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
  {
    name: "COREWEAVE-H200-PERPETUAL",
    displayName: "CoreWeave H200 Hour",
    marketId: "0xf8444beb26f5f34e8d5ec6c988b1023100cd68287fa48066b54e428188ffa447",
  },
  {
    name: "GCP-H200-PERPETUAL",
    displayName: "GCP H200 Hour",
    marketId: "0xb654d9eedc69b55e0fe883d03cae37d13fdacc319a5a1f507bb33875e0e14201",
  },
  {
    name: "AZURE-H200-PERPETUAL",
    displayName: "Azure H200 Hour",
    marketId: "0xc845b4b5cdd753d1ad772bc105e5c4ddddff19c3da674c69da5c9f1a810bb872",
  },
  {
    name: "H200-PERP-V2",
    displayName: "H200 GPU",
    marketId: "0x44830e9eceb656b494dfe3cff6e46a6774961143bd28655e8232777def9ba92c",
  },
  {
    name: "B200-PERP-V2",
    displayName: "B200 GPU",
    marketId: "0x02164b06b5fff171a87dbb519e6d639871a0cfbc0e44d411313256d0168b60fe",
  },
  {
    name: "AWS-B200-PERP",
    displayName: "AWS B200 GPU",
    marketId: "0xb7269b1b771cba59419ca55da90b293f89e72d986f7f50cb542e22797ad46f14",
  },
  {
    name: "ORACLE-B200-PERP",
    displayName: "Oracle B200 GPU",
    marketId: "0x409078466c3ce47594bb7591497b09163aae7262d949015e19a7c4c947434d80",
  },
  {
    name: "COREWEAVE-B200-PERP",
    displayName: "CoreWeave B200 GPU",
    marketId: "0x75da99206b1151e67ba75b25d99b3e2609e1d80b86bb0339fe90a7c4e64930f0",
  },
  {
    name: "GCP-B200-PERP",
    displayName: "GCP B200 GPU",
    marketId: "0xcf1ddf7c363a1165e075f2c8ddcb837d0a5417ee0c7209660c101c804fb1dd97",
  },
] as const;

export const DEFAULT_MARKET: MarketDef = MARKETS[0]!;
