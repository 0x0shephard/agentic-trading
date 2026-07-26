// Injected-wrong-price evidence test for the bad-published-price guard.
//
// Runs on a fork of live Sepolia:
//   1. baseline: record the current index as accepted
//   2. inject a wildly wrong price and confirm the guard flags it out-of-band
//   3. trip the circuit breaker: pause the market via an impersonated guardian
//      and confirm the market is halted (the "held pending corroboration" action)
//   4. control: a within-band move is NOT flagged
//
//   npm run priceguard:test
import { parseAbi, formatUnits } from "viem";
import type { Address } from "viem";
import { connectFork, impersonate, forkNow } from "../src/stress/fork";
import { resolveIndex, readIndex, findPriceSlot, forcePriceData } from "../src/stress/inject";
import { priceGuardPass, newPriceGuardState } from "../src/surveillance/alerting/priceguard";
import { CONTRACTS } from "../src/config/addresses";
import { MARKETS } from "../src/config/markets";
import { logger } from "../src/logging/logger";

const MR = parseAbi([
  "function getMarket(bytes32) view returns ((address vamm, uint16 feeBps, bool paused, address oracle, address feeRouter, address insuranceFund, address baseAsset, address quoteToken, uint256 baseUnit))",
  "function pauseMarket(bytes32,bool)",
]);

async function main(): Promise<void> {
  const f = await connectFork();
  let fails = 0;
  const check = (c: boolean, m: string) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fails++; };

  const badMkt = MARKETS.find((m) => m.name === "H100-GPU-PERP")!;
  const ctlMkt = MARKETS.find((m) => m.name === "A100-PERP")!;
  const cfg = (await f.pub.readContract({ address: CONTRACTS.marketRegistry, abi: MR, functionName: "getMarket", args: [badMkt.marketId] })) as { oracle: Address; paused: boolean };
  const h = await resolveIndex(f, cfg.oracle);
  await findPriceSlot(f, h);
  const start = (await readIndex(f, h)).price;
  console.log(`\nH100 index baseline: ${formatUnits(start, 18)}  (market paused=${cfg.paused})`);

  const st = newPriceGuardState();

  // ── 1. Baseline pass: establishes accepted price, fires nothing ──────────
  const a0 = await priceGuardPass(f.pub, st, { send: false });
  check(a0.length === 0, `baseline pass fires nothing (${a0.length} alerts)`);

  // ── 2. Inject a wildly wrong price (3x) and re-check ─────────────────────
  const wild = (start * 300n) / 100n;
  await forcePriceData(f, h, { priceX18: wild, lastUpdatedAt: BigInt(await forkNow(f)) });
  console.log(`\ninjected wrong price: ${formatUnits(start, 18)} -> ${formatUnits(wild, 18)} (+200%)`);
  const a1 = await priceGuardPass(f.pub, st, { send: false });
  const h100Alert = a1.find((a) => a.title.includes("H100-GPU-PERP"));
  check(!!h100Alert, "out-of-band price detected and flagged critical");
  if (h100Alert) {
    console.log(`    -> ${h100Alert.title}`);
    console.log(`       ${h100Alert.detail}`);
  }
  // The bad print must NOT become the accepted baseline (it should still equal
  // the original baseline, not the injected wild value).
  const startNum = Number(formatUnits(start, 18));
  const wildNum = Number(formatUnits(wild, 18));
  const accepted = st.lastAccepted.get("H100-GPU-PERP");
  check(Math.abs((accepted ?? 0) - startNum) < 1e-9 && accepted !== wildNum, "bad print not adopted as the accepted baseline");

  // ── 3. Trip the circuit breaker: pause the market via guardian ───────────
  const guardian = CONTRACTS.treasury as Address; // holds DEFAULT_ADMIN_ROLE
  const w = await impersonate(f, guardian);
  try {
    const hash = await w.writeContract({ address: CONTRACTS.marketRegistry, abi: MR, functionName: "pauseMarket", args: [badMkt.marketId, true], chain: null, account: guardian });
    await f.pub.waitForTransactionReceipt({ hash });
  } catch (e) {
    console.log(`    pause failed: ${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message.split("\n")[0]}`);
  }
  const after = (await f.pub.readContract({ address: CONTRACTS.marketRegistry, abi: MR, functionName: "getMarket", args: [badMkt.marketId] })) as { paused: boolean };
  check(after.paused === true, "circuit breaker halted the market (trading held pending corroboration)");

  // ── 4. Control: a within-band move must NOT be flagged ───────────────────
  const cCfg = (await f.pub.readContract({ address: CONTRACTS.marketRegistry, abi: MR, functionName: "getMarket", args: [ctlMkt.marketId] })) as { oracle: Address };
  const ch = await resolveIndex(f, cCfg.oracle);
  await findPriceSlot(f, ch);
  const cStart = (await readIndex(f, ch)).price;
  await priceGuardPass(f.pub, st, { send: false }); // establish A100 baseline
  const small = (cStart * 105n) / 100n; // +5%, within the 20% band
  await forcePriceData(f, ch, { priceX18: small, lastUpdatedAt: BigInt(await forkNow(f)) });
  const a2 = await priceGuardPass(f.pub, st, { send: false });
  check(!a2.find((a) => a.title.includes("A100-PERP")), "within-band +5% move is NOT flagged (no false positive)");

  console.log(fails === 0
    ? "\nPRICE GUARD OK — bad price detected, market pauseable, no false positives.\n"
    : `\n${fails} CHECK(S) FAILED.\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "priceguard test fatal");
  process.exit(1);
});
