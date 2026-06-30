// Close every open position for one wallet across all configured markets.
// Operational "flatten-all" tool; also used to clean up after a failed close.
// Respects DRY_RUN (simulate-only when true). Usage: tsx scripts/flatten.ts [walletIndex]
import { env } from "../src/config/env";
import { agentAccount } from "../src/chain/clients";
import { MARKETS } from "../src/config/markets";
import { CONTRACTS } from "../src/config/addresses";
import { clearingHouseAbi } from "../src/chain/abis";
import { executeWrite } from "../src/chain/tx";
import { getMarketConfig, getReserves, getPosition } from "../src/chain/market";
import { quoteMarket, amountLimitWithSlippage } from "../src/preview/sizing";
import { toNumberX18 } from "../src/preview/orderPreview";
import { logger } from "../src/logging/logger";

const INDEX = Math.max(0, Number(process.argv[2] ?? 0));
const SLIPPAGE_BPS = 100; // 1% floor on close output

async function main(): Promise<void> {
  const account = agentAccount(INDEX);
  logger.info({ account: account.address, index: INDEX, dryRun: env.DRY_RUN }, "flatten start");

  let closed = 0;
  for (const market of MARKETS) {
    const pos = await getPosition(account.address, market.marketId);
    if (pos.size === 0n) continue;

    const isLongPos = pos.size > 0n;
    const closeSize = isLongPos ? pos.size : -pos.size;
    const cfg = await getMarketConfig(market.marketId);
    const fresh = await getReserves(cfg.vamm);
    const q = quoteMarket({
      isLong: !isLongPos,
      baseSize: closeSize,
      reserveBase: fresh.base,
      reserveQuote: fresh.quote,
      feeBps: BigInt(cfg.feeBps),
    });
    const limit = amountLimitWithSlippage(!isLongPos, q.quoteAmount, SLIPPAGE_BPS);

    logger.info(
      {
        market: market.name,
        side: isLongPos ? "long" : "short",
        size: toNumberX18(pos.size),
        expectOutUsd: toNumberX18(q.quoteAmount),
      },
      "closing position",
    );

    const res = await executeWrite({
      account,
      address: CONTRACTS.clearingHouse,
      abi: clearingHouseAbi,
      functionName: "closePosition",
      args: [market.marketId, closeSize, limit],
      label: `close ${market.name}`,
    });

    if (res.reverted) {
      logger.error({ market: market.name, reason: res.reason }, "close reverted — leaving position open");
      continue;
    }
    if (!env.DRY_RUN) {
      const after = await getPosition(account.address, market.marketId);
      logger.info({ market: market.name, sizeAfter: toNumberX18(after.size) }, "closed");
    }
    closed += 1;
  }

  logger.info({ closed }, "flatten done");
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "flatten fatal");
  process.exit(1);
});
