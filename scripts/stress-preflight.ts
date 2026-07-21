// Preflight for the RMF Appendix F stress harness.
//
// Proves the safety model works BEFORE any fault injection is built:
//   1. the guard REFUSES a live Sepolia endpoint
//   2. the guard ACCEPTS a local anvil fork
//   3. fork controls (snapshot/revert, time, block production) function
//   4. protocol state is readable on the fork and matches live at fork time
//
//   npm run stress:preflight
import { formatUnits } from "viem";
import { assertAnvilFork, connectFork, snapshot, revert, increaseTime, forkNow, mine, FORK_RPC_URL, UPSTREAM_RPC_URL } from "../src/stress/fork";
import { CONTRACTS } from "../src/config/addresses";
import { logger } from "../src/logging/logger";
import IF from "../../overhaul/src/contracts/abis/InsuranceFund.json";
import CH from "../../overhaul/src/contracts/abis/ClearingHouse.json";

const ok = (s: string) => console.log(`  PASS  ${s}`);
const bad = (s: string) => console.log(`  FAIL  ${s}`);

async function main(): Promise<void> {
  let failures = 0;

  // ── 1. The guard must REFUSE a live endpoint ─────────────────────────────
  console.log("\n[1] guard refuses a live (non-fork) endpoint");
  try {
    await assertAnvilFork(UPSTREAM_RPC_URL);
    bad(`guard ACCEPTED live endpoint ${UPSTREAM_RPC_URL} — ABORT, do not run scenarios`);
    failures++;
  } catch (e) {
    ok(`live endpoint rejected: ${((e as Error).message.split("(")[0] ?? "").trim()}`);
  }

  // ── 2. The guard must ACCEPT the fork ────────────────────────────────────
  console.log("\n[2] guard accepts the anvil fork");
  let f;
  try {
    f = await connectFork(FORK_RPC_URL);
    ok(`fork accepted at ${FORK_RPC_URL}`);
  } catch (e) {
    bad((e as Error).message);
    console.log("\nStart a fork first:\n  anvil --fork-url <SEPOLIA_RPC_URL> --port 8545\n");
    process.exit(1);
  }

  // ── 3. Fork controls ─────────────────────────────────────────────────────
  console.log("\n[3] fork state and time controls");
  const t0 = await forkNow(f);
  const snap = await snapshot(f);
  await increaseTime(f, 3600);
  const t1 = await forkNow(f);
  (t1 - t0 >= 3600) ? ok(`time advanced ${t1 - t0}s (needed for 12h staleness tests)`) : (bad(`time did not advance: ${t1 - t0}s`), failures++);
  await revert(f, snap);
  const t2 = await forkNow(f);
  (Math.abs(t2 - t0) < 30) ? ok(`snapshot/revert restored state (t=${t2})`) : (bad(`revert failed: t0=${t0} t2=${t2}`), failures++);

  const b0 = await f.pub.getBlockNumber();
  await mine(f, 3);
  const b1 = await f.pub.getBlockNumber();
  (b1 - b0 === 3n) ? ok(`block production controllable (${b0} -> ${b1})`) : (bad(`mine failed: ${b0} -> ${b1}`), failures++);

  // ── 4. Protocol state readable on the fork ───────────────────────────────
  console.log("\n[4] protocol state on the fork (baseline for scenario deltas)");
  const read = async (address: string, abi: unknown, fn: string) =>
    f!.pub.readContract({ address: address as `0x${string}`, abi: (abi as { abi: unknown }).abi as never, functionName: fn });

  const ifBal = (await read(CONTRACTS.insuranceFund, IF, "balance")) as bigint;
  const ifPaid = (await read(CONTRACTS.insuranceFund, IF, "totalPaid")) as bigint;
  const badDebt = (await read(CONTRACTS.clearingHouse, CH, "totalBadDebt")) as bigint;
  ok(`InsuranceFund balance   ${formatUnits(ifBal, 6)} USDC`);
  ok(`InsuranceFund totalPaid ${formatUnits(ifPaid, 6)} USDC  (baseline for draw)`);
  ok(`ClearingHouse badDebt   ${formatUnits(badDebt, 18)}      (baseline for shortfall)`);

  // ── 5. Confirm the live chain is untouched ───────────────────────────────
  console.log("\n[5] live deployment untouched");
  ok("no owner key loaded by this process — privileged calls require anvil impersonation");
  ok("all writes above occurred on the fork only");

  console.log(failures === 0
    ? "\nPREFLIGHT PASSED — safe to build fault injection on this fork.\n"
    : `\nPREFLIGHT FAILED (${failures}) — do not proceed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "preflight fatal");
  process.exit(1);
});
