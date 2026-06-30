// READ-ONLY diagnosis of the close revert. Simulates closePosition with several
// amountLimit values against the currently-open position. Sends nothing.
import type { Account, Hex } from "viem";
import { publicClient, agentAccount } from "../src/chain/clients";
import { DEFAULT_MARKET } from "../src/config/markets";
import { CONTRACTS } from "../src/config/addresses";
import { clearingHouseAbi } from "../src/chain/abis";
import { getMarketConfig, getReserves, getPosition } from "../src/chain/market";
import { quoteMarket, amountLimitWithSlippage } from "../src/preview/sizing";
import { toNumberX18 } from "../src/preview/orderPreview";

const INDEX = Math.max(0, Number(process.argv[2] ?? 0));

async function trySim(
  account: Account,
  args: readonly [Hex, bigint, bigint],
  label: string,
): Promise<void> {
  try {
    await publicClient.simulateContract({
      account,
      address: CONTRACTS.clearingHouse,
      abi: clearingHouseAbi,
      functionName: "closePosition",
      args,
    });
    console.log(`  ${label.padEnd(22)} → SIMULATE OK`);
  } catch (e) {
    const msg =
      e && typeof e === "object" && "shortMessage" in e
        ? String((e as { shortMessage?: unknown }).shortMessage)
        : e instanceof Error
          ? e.message
          : String(e);
    console.log(`  ${label.padEnd(22)} → REVERT: ${msg.split("\n")[0]}`);
  }
}

async function main(): Promise<void> {
  const account = agentAccount(INDEX);
  const cfg = await getMarketConfig(DEFAULT_MARKET.marketId);
  const pos = await getPosition(account.address, DEFAULT_MARKET.marketId);
  console.log(
    `\naccount[${INDEX}] ${account.address} on ${DEFAULT_MARKET.name}`,
    `\nposition size=${toNumberX18(pos.size)} margin=$${toNumberX18(pos.margin).toFixed(4)} entry=$${toNumberX18(pos.entryPriceX18).toFixed(4)}\n`,
  );
  if (pos.size === 0n) {
    console.log("no open position — nothing to diagnose");
    return;
  }

  const closeSize = pos.size < 0n ? -pos.size : pos.size;
  const isLongPos = pos.size > 0n;
  const fresh = await getReserves(cfg.vamm);
  const q = quoteMarket({
    isLong: !isLongPos,
    baseSize: closeSize,
    reserveBase: fresh.base,
    reserveQuote: fresh.quote,
    feeBps: BigInt(cfg.feeBps),
  });
  const tight = amountLimitWithSlippage(!isLongPos, q.quoteAmount, 100);
  const loose = amountLimitWithSlippage(!isLongPos, q.quoteAmount, 5000);
  console.log(
    `close quoteOut=$${toNumberX18(q.quoteAmount).toFixed(4)}  tight(1%)=$${toNumberX18(tight).toFixed(4)}  loose(50%)=$${toNumberX18(loose).toFixed(4)}\n`,
  );

  await trySim(account, [DEFAULT_MARKET.marketId, closeSize, tight], "amountLimit tight(1%)");
  await trySim(account, [DEFAULT_MARKET.marketId, closeSize, loose], "amountLimit loose(50%)");
  await trySim(account, [DEFAULT_MARKET.marketId, closeSize, 1n], "amountLimit = 1");
  await trySim(account, [DEFAULT_MARKET.marketId, closeSize, 0n], "amountLimit = 0");
  console.log();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
