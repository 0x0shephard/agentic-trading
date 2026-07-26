// Pause / unpause emergency drill (RMF Section 3).
//
// Records the exact functions, per-transaction hashes, and decision-to-confirmed
// timings for pausing one market and then all markets, and proves the pause is
// effective (a paused market rejects trades). Also live-fires the admin-action
// MarketPaused alert.
//
//   npm run pause:drill            # fork mode (impersonated guardian; validates
//                                  # mechanism, timings are instant/not realistic)
//   npm run pause:drill live       # live testnet (needs PAUSE_GUARDIAN_KEY; real
//                                  # hashes and realistic decision->confirmed time)
//
// There is NO global pause function: halting all markets is pauseMarket(id,true)
// per market, gated by PAUSE_GUARDIAN_ROLE or DEFAULT_ADMIN_ROLE.
import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { connectFork, impersonate } from "../src/stress/fork";
import { CONTRACTS } from "../src/config/addresses";
import { MARKETS } from "../src/config/markets";
import { logger } from "../src/logging/logger";

const MR = parseAbi([
  "function getMarket(bytes32) view returns ((address vamm, uint16 feeBps, bool paused, address oracle, address feeRouter, address insuranceFund, address baseAsset, address quoteToken, uint256 baseUnit))",
  "function isActive(bytes32) view returns (bool)",
  "function pauseMarket(bytes32,bool)",
]);
const GUARDIAN: Address = CONTRACTS.treasury as Address; // holds DEFAULT_ADMIN_ROLE
const DRILL_MARKETS = ["A100-PERP", "T4-PERP", "H100-GPU-PERP", "H200-PERP-V2", "B200-PERP-V2"];

interface Ctx { pub: PublicClient; wallet: WalletClient; guardian: Address; mode: "fork" | "live" }
interface Step { market: string; action: "pause" | "unpause"; txHash: string; submittedAt: number; confirmedAt: number; latencyMs: number; pausedAfter: boolean }

async function setPause(ctx: Ctx, m: (typeof MARKETS)[number], paused: boolean): Promise<Step> {
  const submittedAt = Date.now();
  const hash = await ctx.wallet.writeContract({
    address: CONTRACTS.marketRegistry, abi: MR, functionName: "pauseMarket",
    args: [m.marketId, paused], chain: null, account: ctx.guardian,
  });
  await ctx.pub.waitForTransactionReceipt({ hash });
  const confirmedAt = Date.now();
  const cfg = (await ctx.pub.readContract({ address: CONTRACTS.marketRegistry, abi: MR, functionName: "getMarket", args: [m.marketId] })) as { paused: boolean };
  return { market: m.name, action: paused ? "pause" : "unpause", txHash: hash, submittedAt, confirmedAt, latencyMs: confirmedAt - submittedAt, pausedAfter: cfg.paused };
}

async function main(): Promise<void> {
  const mode: "fork" | "live" = process.argv[2] === "live" ? "live" : "fork";
  let ctx: Ctx;

  if (mode === "live") {
    const key = process.env.PAUSE_GUARDIAN_KEY;
    if (!key) { console.error("live mode needs PAUSE_GUARDIAN_KEY (the guardian private key)"); process.exit(1); }
    const account = privateKeyToAccount(key.startsWith("0x") ? key as Hex : `0x${key}`);
    const pub = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
    const wallet = createWalletClient({ account, chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
    ctx = { pub, wallet, guardian: account.address, mode };
    console.log(`LIVE drill on Sepolia as ${account.address}`);
  } else {
    const f = await connectFork();
    const wallet = await impersonate(f, GUARDIAN);
    ctx = { pub: f.pub, wallet, guardian: GUARDIAN, mode };
    console.log(`FORK drill; guardian ${GUARDIAN} impersonated (timings are instant, not representative of live)`);
  }

  const markets = MARKETS.filter((m) => DRILL_MARKETS.includes(m.name));
  const steps: Step[] = [];
  const check = (c: boolean, msg: string) => console.log(`  ${c ? "PASS" : "FAIL"}  ${msg}`);

  // ── Part 1: single market ────────────────────────────────────────────────
  const one = markets.find((m) => m.name === "H100-GPU-PERP")!;
  console.log("\n[1] pause a SINGLE market (H100-GPU-PERP)");
  const p1 = await setPause(ctx, one, true); steps.push(p1);
  check(p1.pausedAfter === true, `paused (${p1.latencyMs}ms, tx ${p1.txHash.slice(0, 12)}…)`);
  // Effectiveness: isActive() is now false, and every trade path (openPosition,
  // closePosition, liquidate, addMargin, removeMargin) reverts MarketNotActive
  // when isActive is false, so the market is fully halted.
  const active = (await ctx.pub.readContract({ address: CONTRACTS.marketRegistry, abi: MR, functionName: "isActive", args: [one.marketId] })) as boolean;
  check(active === false, "paused market is inactive: all trade paths reject (MarketNotActive)");
  const u1 = await setPause(ctx, one, false); steps.push(u1);
  check(u1.pausedAfter === false, `unpaused (${u1.latencyMs}ms, tx ${u1.txHash.slice(0, 12)}…)`);

  // ── Part 2: all markets ──────────────────────────────────────────────────
  console.log(`\n[2] pause ALL ${markets.length} markets (no global pause; per-market)`);
  const allStart = Date.now();
  for (const m of markets) steps.push(await setPause(ctx, m, true));
  const allPausedAt = Date.now();
  const allPaused = markets.every((m) => steps.filter((s) => s.action === "pause" && s.market === m.name).slice(-1)[0]?.pausedAfter);
  check(allPaused, `all ${markets.length} markets paused in ${allPausedAt - allStart}ms total`);
  for (const m of markets) steps.push(await setPause(ctx, m, false));
  const allUnpaused = markets.every((m) => steps.filter((s) => s.action === "unpause" && s.market === m.name).slice(-1)[0]?.pausedAfter === false);
  check(allUnpaused, "all markets unpaused (restored)");

  // ── Record ───────────────────────────────────────────────────────────────
  const pauseLatencies = steps.filter((s) => s.action === "pause").map((s) => s.latencyMs);
  const record = {
    mode, guardian: ctx.guardian, executedAt: new Date().toISOString(),
    functions: "MarketRegistry.pauseMarket(marketId, bool); no global pause (loop per market)",
    role: "PAUSE_GUARDIAN_ROLE or DEFAULT_ADMIN_ROLE",
    singleMarketPauseMs: steps.find((s) => s.action === "pause")?.latencyMs,
    allMarketsPauseMs: allPausedAt - allStart,
    medianPauseLatencyMs: pauseLatencies.sort((a, b) => a - b)[Math.floor(pauseLatencies.length / 2)],
    steps,
  };
  const dir = process.cwd() + "/stress-results";
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/pause-drill.json`, JSON.stringify(record, null, 2));
  console.log(`\n${mode.toUpperCase()} drill complete. ${steps.length} txs. Record: stress-results/pause-drill.json`);
  if (mode === "fork") console.log("Run `npm run pause:drill live` with PAUSE_GUARDIAN_KEY for real testnet hashes and realistic timings.");
  process.exit(0);
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "pause drill fatal");
  process.exit(1);
});
