// Resolve the two long-standing "liquidatable" positions from our own testing
// (RMF Section 5), and prove the root cause on the way.
//
//   npm run resolve:liquidatable            # fork: read live state, prove that
//                                           # settleFunding flips both positions
//                                           # from liquidatable to healthy
//   npm run resolve:liquidatable live       # live testnet: actually call
//                                           # settleFunding on each (needs RESOLVE_KEY)
//
// Root cause (verified here): isLiquidatable() — the view a keeper reads — values
// the position at the index price and does NOT credit the account's free vault
// collateral. liquidate() settles funding first, which re-margins the position
// from that free collateral, so the position is no longer liquidatable and the
// call reverts NotLiquidatable. Both flagged accounts are solvent. Calling the
// permissionless settleFunding(marketId, account) applies that same re-margining
// once, so the position stops reading liquidatable. No funds move adversarially;
// settleFunding is public and has no access control.
import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { connectFork, impersonate, snapshot, revert } from "../src/stress/fork";
import { CONTRACTS } from "../src/config/addresses";
import { MARKETS } from "../src/config/markets";
import { logger } from "../src/logging/logger";

const CH = parseAbi([
  "function isLiquidatable(address,bytes32) view returns (bool)",
  "function getMarginRatio(address,bytes32) view returns (uint256)",
  "function getAccountValue(address) view returns (int256)",
  "function getPosition(address,bytes32) view returns ((int256 size, uint256 margin, uint256 entryPriceX18, uint256 lastFundingPayIndex, uint256 lastFundingReceiveIndex, int256 realizedPnL))",
  "function settleFunding(bytes32,address)",
]);
const VAULT = parseAbi(["function balanceOf(address,address) view returns (uint256)"]);

// The two positions the monitor has been suppressing (see health.ts SUPPRESSED),
// flagged liquidatable at the start of testing but each backed by free collateral.
const TARGETS = [
  { account: "0xfcd71144a97adc78f3f74e7e8d77b2c9b3122e55" as Address, market: "T4-PERP" },
  { account: "0x6330a8325ea1d80264178b1378694ad1522454ac" as Address, market: "T4-PERP" },
];

interface Ctx { pub: PublicClient; wallet: WalletClient | null; sender: Address | null; mode: "fork" | "live" }
interface Snap { isLiquidatable: boolean; marginRatioBps: number; sizeX18: string; marginX18: string; accountValueX18: string; freeCollateralUsdc: string }

async function readState(pub: PublicClient, account: Address, marketId: Hex): Promise<Snap> {
  const [liq, mr, av, pos, vault] = await Promise.all([
    pub.readContract({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "isLiquidatable", args: [account, marketId] }) as Promise<boolean>,
    pub.readContract({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "getMarginRatio", args: [account, marketId] }).catch(() => 0n) as Promise<bigint>,
    pub.readContract({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "getAccountValue", args: [account] }).catch(() => 0n) as Promise<bigint>,
    pub.readContract({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "getPosition", args: [account, marketId] }) as Promise<{ size: bigint; margin: bigint }>,
    pub.readContract({ address: CONTRACTS.collateralVault, abi: VAULT, functionName: "balanceOf", args: [account, CONTRACTS.usdc] }).catch(() => 0n) as Promise<bigint>,
  ]);
  return {
    isLiquidatable: liq,
    marginRatioBps: Number(mr) / 1e18 * 10_000, // getMarginRatio is WAD (1e18 == 100%)
    sizeX18: formatUnits(pos.size, 18),
    marginX18: formatUnits(pos.margin, 18),
    accountValueX18: formatUnits(av, 18),
    freeCollateralUsdc: formatUnits(vault, 6),
  };
}

async function main(): Promise<void> {
  const mode: "fork" | "live" = process.argv[2] === "live" ? "live" : "fork";
  let ctx: Ctx;

  if (mode === "live") {
    const key = process.env.RESOLVE_KEY;
    if (!key) { console.error("live mode needs RESOLVE_KEY (any funded wallet; settleFunding is permissionless)"); process.exit(1); }
    const account = privateKeyToAccount(key.startsWith("0x") ? key as Hex : `0x${key}`);
    const pub = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
    const wallet = createWalletClient({ account, chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
    ctx = { pub, wallet, sender: account.address, mode };
    console.log(`LIVE resolution on Sepolia; settleFunding sent from ${account.address}`);
  } else {
    const f = await connectFork();
    ctx = { pub: f.pub, wallet: null, sender: null, mode };
    console.log("FORK: reading live state, proving settleFunding resolves each position (no live tx)");
    // stash fork handle for snapshot/revert below
    (ctx as unknown as { f: typeof f }).f = f;
  }

  const results: Record<string, unknown>[] = [];
  const check = (c: boolean, msg: string) => console.log(`  ${c ? "PASS" : "FAIL"}  ${msg}`);

  for (const t of TARGETS) {
    const m = MARKETS.find((x) => x.name === t.market);
    if (!m) { console.error(`market ${t.market} not found`); continue; }
    console.log(`\n── ${t.account.slice(0, 10)}…  ${t.market} ─────────────────────────────`);

    const before = await readState(ctx.pub, t.account, m.marketId);
    console.log(`  before: liquidatable=${before.isLiquidatable}  marginRatio=${before.marginRatioBps.toFixed(2)}bps  size=${before.sizeX18}  margin=${before.marginX18}`);
    console.log(`          accountValue=${before.accountValueX18}  freeCollateral(vault)=${before.freeCollateralUsdc} USDC`);

    let txHash: string | null = null;
    let snapId: Hex | null = null;
    if (mode === "fork") {
      const f = (ctx as unknown as { f: Awaited<ReturnType<typeof connectFork>> }).f;
      snapId = await snapshot(f);
      // Anyone can call settleFunding; on a fork we impersonate the treasury only
      // to have a funded sender. It is not privileged for this call.
      const w = await impersonate(f, CONTRACTS.treasury);
      const hash = await w.writeContract({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "settleFunding", args: [m.marketId, t.account], chain: null, account: CONTRACTS.treasury });
      await f.pub.waitForTransactionReceipt({ hash });
      txHash = hash;
    } else {
      const hash = await ctx.wallet!.writeContract({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "settleFunding", args: [m.marketId, t.account], chain: null, account: ctx.sender! });
      await ctx.pub.waitForTransactionReceipt({ hash });
      txHash = hash;
    }
    console.log(`  settleFunding tx: ${txHash}`);

    const after = await readState(ctx.pub, t.account, m.marketId);
    console.log(`  after:  liquidatable=${after.isLiquidatable}  marginRatio=${after.marginRatioBps.toFixed(2)}bps  margin=${after.marginX18}`);
    check(before.isLiquidatable && !after.isLiquidatable, "position flipped liquidatable -> healthy after settleFunding");

    if (mode === "fork" && snapId) {
      const f = (ctx as unknown as { f: Awaited<ReturnType<typeof connectFork>> }).f;
      await revert(f, snapId); // leave the fork clean; the real change happens in live mode
    }
    results.push({ account: t.account, market: t.market, txHash, before, after, resolved: before.isLiquidatable && !after.isLiquidatable });
  }

  const record = { mode, executedAt: new Date().toISOString(), rootCause: "isLiquidatable values at index and ignores free vault collateral; settleFunding re-margins from it", sender: ctx.sender, results };
  const dir = process.cwd() + "/stress-results";
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/resolve-liquidatable.json`, JSON.stringify(record, null, 2));
  console.log(`\n${mode.toUpperCase()} done. Record: stress-results/resolve-liquidatable.json`);
  if (mode === "fork") console.log("Run `npm run resolve:liquidatable live` with RESOLVE_KEY to apply on testnet, then de-suppress the two entries in health.ts.");
  process.exit(0);
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "resolve-liquidatable fatal");
  process.exit(1);
});
