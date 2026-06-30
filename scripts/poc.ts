// Phase-0/1 PoC: one wallet does fund → mint → approve → deposit → open → close
// on a single market. DRY_RUN-safe: with DRY_RUN=true it reads + sizes + simulates
// (no sends); with DRY_RUN=false it executes for real and reports tx hashes.
//
//   npm run poc           # uses wallet index 0 (treasury)
//   npm run poc 1         # uses agent-1 (must be funded with ETH)
import { parseUnits, formatUnits } from "viem";
import { env } from "../src/config/env";
import { agentAccount } from "../src/chain/clients";
import { DEFAULT_MARKET } from "../src/config/markets";
import { CONTRACTS } from "../src/config/addresses";
import { clearingHouseAbi } from "../src/chain/abis";
import { getMarketConfig, getReserves, getMarkPrice, getPosition } from "../src/chain/market";
import { executeWrite } from "../src/chain/tx";
import { ensureUsdc, ensureApproval, deposit, usdcBalance, vaultBalance } from "../src/collateral/collateral";
import { quoteMarket, amountLimitWithSlippage } from "../src/preview/sizing";
import { toNumberX18 } from "../src/preview/orderPreview";
import { USDC_DECIMALS } from "../src/config/constants";
import { logger } from "../src/logging/logger";

// Conservative PoC parameters.
const ACCOUNT_INDEX = Math.max(0, Number(process.argv[2] ?? 0));
const MINT_USDC = parseUnits("1000", USDC_DECIMALS);
const DEPOSIT_USDC = parseUnits("100", USDC_DECIMALS);
const BASE_SIZE = parseUnits("1", 18); // 1 GPU-hour
const SLIPPAGE_BPS = 100; // 1%
const IS_LONG = true;

async function main(): Promise<void> {
  const account = agentAccount(ACCOUNT_INDEX);
  logger.info(
    { account: account.address, index: ACCOUNT_INDEX, dryRun: env.DRY_RUN, market: DEFAULT_MARKET.name },
    "PoC start",
  );

  const cfg = await getMarketConfig(DEFAULT_MARKET.marketId);
  if (cfg.paused) throw new Error(`Market ${DEFAULT_MARKET.name} is paused`);
  const feeBps = BigInt(cfg.feeBps);

  // ── 1) Collateral: mint → approve → deposit ────────────────────────────────
  await ensureUsdc(account, DEPOSIT_USDC, MINT_USDC);
  await ensureApproval(account, DEPOSIT_USDC);
  await deposit(account, DEPOSIT_USDC);
  if (!env.DRY_RUN) {
    logger.info(
      {
        wallet: formatUnits(await usdcBalance(account.address), USDC_DECIMALS),
        vault: formatUnits(await vaultBalance(account.address), USDC_DECIMALS),
      },
      "balances after deposit",
    );
  }

  // ── 2) Size + amountLimit from live reserves ───────────────────────────────
  const { base, quote } = await getReserves(cfg.vamm);
  const mark = await getMarkPrice(cfg.vamm);
  const q = quoteMarket({ isLong: IS_LONG, baseSize: BASE_SIZE, reserveBase: base, reserveQuote: quote, feeBps });
  const amountLimit = amountLimitWithSlippage(IS_LONG, q.quoteAmount, SLIPPAGE_BPS);
  logger.info(
    {
      markUsd: toNumberX18(mark).toFixed(4),
      baseSize: toNumberX18(BASE_SIZE),
      avgPriceUsd: toNumberX18(q.avgPrice).toFixed(4),
      costUsd: toNumberX18(q.quoteAmount).toFixed(4),
      amountLimitUsd: toNumberX18(amountLimit).toFixed(4),
      postMarkUsd: toNumberX18(q.postTradeMark).toFixed(4),
    },
    "computed order",
  );

  // ── 3) Open ────────────────────────────────────────────────────────────────
  await executeWrite({
    account,
    address: CONTRACTS.clearingHouse,
    abi: clearingHouseAbi,
    functionName: "openPosition",
    args: [DEFAULT_MARKET.marketId, IS_LONG, BASE_SIZE, amountLimit],
    label: "openPosition",
  });

  // ── 4) Read position + 5) close (live only — needs persisted state) ────────
  if (!env.DRY_RUN) {
    const pos = await getPosition(account.address, DEFAULT_MARKET.marketId);
    logger.info(
      { size: toNumberX18(pos.size), marginUsd: toNumberX18(pos.margin), entryUsd: toNumberX18(pos.entryPriceX18) },
      "position after open",
    );

    const closeSize = pos.size < 0n ? -pos.size : pos.size;
    if (closeSize > 0n) {
      const fresh = await getReserves(cfg.vamm);
      const closeQ = quoteMarket({
        isLong: !IS_LONG,
        baseSize: closeSize,
        reserveBase: fresh.base,
        reserveQuote: fresh.quote,
        feeBps,
      });
      const closeLimit = amountLimitWithSlippage(!IS_LONG, closeQ.quoteAmount, SLIPPAGE_BPS);
      await executeWrite({
        account,
        address: CONTRACTS.clearingHouse,
        abi: clearingHouseAbi,
        functionName: "closePosition",
        args: [DEFAULT_MARKET.marketId, closeSize, closeLimit],
        label: "closePosition",
      });
      const after = await getPosition(account.address, DEFAULT_MARKET.marketId);
      logger.info({ size: toNumberX18(after.size) }, "position after close");
    }
  }

  logger.info("PoC done");
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "PoC fatal");
  process.exit(1);
});
