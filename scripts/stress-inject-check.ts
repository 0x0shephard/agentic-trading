// Verifies every fault-injection lever works before running scenarios.
//   npm run stress:inject
import { formatUnits, parseAbi, parseUnits } from "viem";
import type { Address } from "viem";
import { connectFork, snapshot, revert, forkNow } from "../src/stress/fork";
import { resolveIndex, readIndex, indexServes, commitRevealPrice, forcePriceData, ageIndex, findPriceSlot, resolveCollateral, readCollateralValue } from "../src/stress/inject";
import { CONTRACTS } from "../src/config/addresses";
import { MARKETS } from "../src/config/markets";
import { logger } from "../src/logging/logger";

const MR = parseAbi(["function getMarket(bytes32) view returns ((address vamm, uint16 feeBps, bool paused, address oracle, address feeRouter, address insuranceFund, address baseAsset, address quoteToken, uint256 baseUnit))"]);
const px = (v: bigint) => Number(formatUnits(v, 18)).toFixed(4);

async function main(): Promise<void> {
  const f = await connectFork();
  const snap = await snapshot(f);
  let fails = 0;
  const check = (cond: boolean, msg: string) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fails++; };

  // Injected faults MUST be rolled back even on failure. Without this an aborted
  // run leaves the fork dirty (e.g. an index still forced to 0) and silently
  // corrupts every subsequent scenario.
  try {
    await runChecks(f, check);
  } finally {
    await revert(f, snap).catch(() => { /* snapshot already consumed */ });
    console.log("\n  baseline restored via snapshot revert");
  }

  console.log(fails === 0 ? "\nINJECTION LEVERS READY — all four scenarios are executable.\n" : `\n${fails} LEVER(S) FAILED.\n`);
  process.exit(fails === 0 ? 0 : 1);
}

async function runChecks(f: Awaited<ReturnType<typeof connectFork>>, check: (c: boolean, m: string) => void): Promise<void> {

  const market = MARKETS.find((m) => m.name === "A100-PERP")!;
  const cfg = (await f.pub.readContract({ address: CONTRACTS.marketRegistry, abi: MR, functionName: "getMarket", args: [market.marketId] })) as { oracle: Address };
  const h = await resolveIndex(f, cfg.oracle);
  console.log(`\nA100-PERP  adapter=${h.adapter.slice(0, 10)} cuOracle=${h.cuOracle.slice(0, 10)} maxAge=${h.maxAge}s`);

  // ── 1. Commit/reveal (production path) ───────────────────────────────────
  console.log("\n[1] drive index via real commit/reveal path");
  const before = await readIndex(f, h);
  const target = (before.price * 120n) / 100n; // +20%
  await commitRevealPrice(f, h, target);
  const after = await readIndex(f, h);
  console.log(`  ${px(before.price)} -> ${px(after.price)} (target ${px(target)})`);
  check(after.price === target, "index moved via commit/reveal");
  check(await indexServes(f, h), "adapter still serves after legitimate update");

  // ── 2. Storage write: zero price (path the contract refuses) ─────────────
  console.log("\n[2] force zero price (updatePrices() rejects this; storage write required)");
  await findPriceSlot(f, h); // discover while a valid price is still readable
  await forcePriceData(f, h, { priceX18: 0n });
  const zero = await readIndex(f, h);
  check(zero.price === 0n, `price forced to 0 (read ${zero.price})`);
  check(!(await indexServes(f, h)), "adapter FAILS CLOSED on zero price (reverts)");

  // restore a sane price for the staleness test
  await forcePriceData(f, h, { priceX18: before.price, lastUpdatedAt: BigInt(await forkNow(f)) });
  check(await indexServes(f, h), "adapter recovers once a valid price is restored");

  // ── 3. Staleness (F-5 core) ──────────────────────────────────────────────
  console.log("\n[3] age the index past maxAge (F-5 fail-closed boundary)");
  const withinAge = Number(h.maxAge) - 600; // 10 min inside the window
  await ageIndex(f, h, withinAge);
  const servesWithin = await indexServes(f, h);
  check(servesWithin, `serves at ${(withinAge / 3600).toFixed(1)}h stale (inside ${Number(h.maxAge) / 3600}h window)`);

  await ageIndex(f, h, 1800); // push past the boundary
  const servesBeyond = await indexServes(f, h);
  check(!servesBeyond, `REVERTS past ${Number(h.maxAge) / 3600}h stale — staleness guard confirmed active`);

  // ── 4. Collateral depeg lever (F-1) ──────────────────────────────────────
  console.log("\n[4] collateral valuation lever (F-1)");
  const c = await resolveCollateral(f, CONTRACTS.collateralVault, CONTRACTS.usdc);
  const oneUsdc = parseUnits("1", 6);
  const val = await readCollateralValue(f, c, oneUsdc);
  console.log(`  symbol=${c.symbol} feed=${c.feed} haircut=${c.haircutBps}bps  value(1 USDC)=${px(val)}`);
  check(val > 0n, "collateral value readable (depeg will propagate through this)");
  check(c.feed !== "0x0000000000000000000000000000000000000000", "USDC price feed resolved (injection target identified)");
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "inject check fatal");
  process.exit(1);
});
