// Close every open position across a range of wallets and all markets.
// Operational "flatten-all"; also cleans up after a swarm run. Respects DRY_RUN.
//   npm run flatten 1        # just wallet 1
//   npm run flatten 1 3      # wallets 1..3 (the whole fleet)
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

const START = Math.max(0, Number(process.argv[2] ?? 0));
const END = Math.max(START, Number(process.argv[3] ?? START));
const SLIPPAGE_BPS = 100;

async function flattenAccount(index: number): Promise<number> {
  const account = agentAccount(index);
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
      { index, market: market.name, side: isLongPos ? "long" : "short", size: toNumberX18(pos.size) },
      "closing position",
    );
    const res = await executeWrite({
      account,
      address: CONTRACTS.clearingHouse,
      abi: clearingHouseAbi,
      functionName: "closePosition",
      args: [market.marketId, closeSize, limit],
      label: `close #${index} ${market.name}`,
    });
    if (res.reverted || res.skipped) {
      logger.error({ index, market: market.name, reason: res.reason }, "close not completed");
      continue;
    }
    if (!env.DRY_RUN) {
      const after = await getPosition(account.address, market.marketId);
      logger.info({ index, market: market.name, sizeAfter: toNumberX18(after.size) }, "closed");
    }
    closed += 1;
  }
  return closed;
}

async function main(): Promise<void> {
  logger.info({ start: START, end: END, dryRun: env.DRY_RUN }, "flatten start");
  let total = 0;
  for (let i = START; i <= END; i++) total += await flattenAccount(i);
  logger.info({ closed: total }, "flatten done");
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "flatten fatal");
  process.exit(1);
});
