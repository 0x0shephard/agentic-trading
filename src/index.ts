import { env } from "./config/env";
import { ZERO_ADDRESS } from "./config/constants";
import { MARKETS } from "./config/markets";
import { CONTRACTS } from "./config/addresses";
import { publicClient, assertChain } from "./chain/clients";
import { marketRegistryAbi, vammAbi } from "./chain/abis";
import { logger } from "./logging/logger";

/**
 * Phase 0 — foundation boot / healthcheck.
 * Read-only. Proves: env is valid, the RPC is really Sepolia, and every market in
 * config resolves against the on-chain MarketRegistry (catching marketId typos
 * and paused/dead markets before any trading code exists).
 */
async function main(): Promise<void> {
  let rpcOrigin = "(unparseable)";
  try {
    rpcOrigin = new URL(env.SEPOLIA_RPC_URL).origin; // hide any API key in the path
  } catch {
    /* leave default */
  }

  logger.info(
    { dryRun: env.DRY_RUN, killSwitch: env.KILL_SWITCH, rpc: rpcOrigin, markets: MARKETS.length },
    "agent runner booting (foundation)",
  );

  if (env.KILL_SWITCH) {
    logger.warn("KILL_SWITCH is on — exiting before doing anything.");
    return;
  }

  await assertChain();
  const block = await publicClient.getBlockNumber();
  logger.info({ block: block.toString() }, "connected to Sepolia");

  // Validate every configured market against the on-chain registry.
  let ok = 0;
  for (const m of MARKETS) {
    const market = await publicClient.readContract({
      address: CONTRACTS.marketRegistry,
      abi: marketRegistryAbi,
      functionName: "getMarket",
      args: [m.marketId],
    });

    if (market.vamm === ZERO_ADDRESS) {
      throw new Error(`Market "${m.name}" resolved to a zero vAMM — bad marketId (${m.marketId})?`);
    }

    const markX18 = await publicClient.readContract({
      address: market.vamm,
      abi: vammAbi,
      functionName: "getMarkPrice",
    });

    logger.info(
      {
        market: m.name,
        vamm: market.vamm,
        feeBps: Number(market.feeBps),
        paused: market.paused,
        baseUnit: market.baseUnit.toString(),
        markX18: markX18.toString(),
      },
      market.paused ? "market validated (PAUSED)" : "market validated",
    );
    ok += 1;
  }

  logger.info({ validated: ok, total: MARKETS.length }, "foundation OK — config, chain, and markets validated");
}

main().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "fatal");
  process.exit(1);
});
