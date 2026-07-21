// Verifies the liquidation keeper before any scenario runs.
//   npm run stress:keeper
import { parseAbi, formatUnits } from "viem";
import type { Address } from "viem";
import { connectFork } from "../src/stress/fork";
import { ensureKeeperWhitelisted, findLiquidatable, KEEPER_ADDRESS } from "../src/stress/liquidator";
import { agentAccount } from "../src/chain/clients";
import { MARKETS } from "../src/config/markets";
import { CONTRACTS } from "../src/config/addresses";
import { logger } from "../src/logging/logger";

const CH = parseAbi([
  "function whitelistedLiquidators(address) view returns (bool)",
  "function getPosition(address,bytes32) view returns ((int256 size, uint256 margin, uint256 entryPriceX18, uint256 lastFundingPayIndex, uint256 lastFundingReceiveIndex, int256 realizedPnL))",
]);

// The markets that carry real activity; scanning all 19 on a cold fork is slow
// and adds nothing, since the idle ones hold no positions.
const ACTIVE = ["H100-GPU-PERP", "H200-PERP-V2", "T4-PERP", "A100-PERP", "B200-PERP-V2", "GCP-H100-PERP", "H100-non-HyperScalers-PERP-V2", "COREWEAVE-B200-PERP"];

async function main(): Promise<void> {
  const f = await connectFork();

  console.log("\n[1] whitelist keeper via impersonated admin");
  await ensureKeeperWhitelisted(f);
  const after = (await f.pub.readContract({
    address: CONTRACTS.clearingHouse, abi: CH, functionName: "whitelistedLiquidators", args: [KEEPER_ADDRESS],
  })) as boolean;
  console.log(`  keeper ${KEEPER_ADDRESS} whitelisted: ${after}  ${after ? "PASS" : "FAIL"}`);

  const markets = MARKETS.filter((m) => ACTIVE.includes(m.name));
  const accounts: Address[] = [];
  for (let i = 0; i <= 16; i++) accounts.push(agentAccount(i).address as Address);

  console.log(`\n[2] scanning ${accounts.length} accounts x ${markets.length} markets via multicall`);
  const calls = accounts.flatMap((a) =>
    markets.map((m) => ({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "getPosition" as const, args: [a, m.marketId] })));
  const res = (await f.pub.multicall({ contracts: calls as never, allowFailure: true })) as unknown as
    { status: string; result: unknown }[];

  let open = 0;
  res.forEach((r, i) => {
    if (r.status !== "success") return;
    const p = r.result as unknown as { size: bigint; margin: bigint };
    if (!p?.size) return;
    open++;
    const a = accounts[Math.floor(i / markets.length)]!;
    const m = markets[i % markets.length]!;
    console.log(`  ${a.slice(0, 10)} ${m.name.padEnd(30)} ${p.size > 0n ? "LONG " : "SHORT"} size=${formatUnits(p.size < 0n ? -p.size : p.size, 18).padStart(11)} margin=${formatUnits(p.margin, 18).padStart(10)}`);
  });
  console.log(`  open positions: ${open}`);

  console.log("\n[3] scan for currently-liquidatable positions");
  const targets = await findLiquidatable(f, accounts, markets);
  console.log(`  liquidatable now: ${targets.length}`);
  for (const t of targets) console.log(`    ${t.account.slice(0, 10)} ${t.market.name} size=${formatUnits(t.size, 18)} mrBps=${t.marginRatioBps}`);

  console.log(after
    ? "\nKEEPER READY — whitelisted and scanning. Cascades will execute during scenarios.\n"
    : "\nKEEPER NOT READY.\n");
  process.exit(after ? 0 : 1);
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "keeper check fatal");
  process.exit(1);
});
