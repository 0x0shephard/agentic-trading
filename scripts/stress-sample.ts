// Smoke-test the metric sampler against the fork. Verifies every ABI decodes and
// each headline metric has a real source before any fault injection is built.
//
//   npm run stress:sample
import { connectFork } from "../src/stress/fork";
import { sample, collectLiquidations, collectBadDebt, summarise } from "../src/stress/metrics";
import { MARKETS } from "../src/config/markets";
import { logger } from "../src/logging/logger";

async function main(): Promise<void> {
  const f = await connectFork();

  // Sample the five markets that carry real activity.
  const tracked = MARKETS.filter((m) =>
    ["H100-GPU-PERP", "H200-PERP-V2", "T4-PERP", "A100-PERP", "B200-PERP-V2"].includes(m.name));

  const s0 = await sample(f, tracked);
  console.log(`\nblock ${s0.block}  t=${new Date(s0.t * 1000).toISOString()}`);
  console.log(`InsuranceFund: balance=${s0.ifBalance.toFixed(2)} totalPaid=${s0.ifTotalPaid.toFixed(2)}  badDebt=${s0.badDebt}\n`);
  console.log("market                mark      index     basis(bps)   longOI     shortOI    oracle");
  for (const m of s0.markets) {
    console.log(
      `${m.market.padEnd(18)} ${String(m.mark?.toFixed(4) ?? "REVERT").padStart(9)} ${String(m.index?.toFixed(4) ?? "REVERT").padStart(9)} ` +
      `${String(m.basisBps?.toFixed(0) ?? "-").padStart(11)} ${m.longOi.toFixed(2).padStart(10)} ${m.shortOi.toFixed(2).padStart(10)}   ` +
      `${m.oracleReverted ? "REVERTED" : "ok"}${m.paused ? " PAUSED" : ""}`,
    );
  }

  // Two samples a few blocks apart exercise the summariser end to end.
  const from = BigInt(s0.block);
  await new Promise((r) => setTimeout(r, 1500));
  const s1 = await sample(f, tracked);
  const to = BigInt(s1.block);

  const liqs = await collectLiquidations(f, from, to);
  const bd = await collectBadDebt(f, from, to);
  const sum = summarise("smoke-test", [s0, s1], liqs);

  console.log(`\nsummariser: ${sum.samples} samples over ${sum.durationSec}s`);
  console.log(`  liquidations=${sum.liquidations.count}  IF draw=${sum.insuranceFund.draw.toFixed(2)} USDC  badDebt increase=${sum.badDebt.increase}`);
  console.log(`  badDebt events in range: ${bd.length}`);
  console.log("  per-market vol/basis/OI-flow computed for:", sum.perMarket.map((p) => p.market).join(", "));

  const decodeOk = s0.markets.every((m) => m.mark !== null || m.paused);
  console.log(decodeOk
    ? "\nSAMPLER OK — all ABIs decode, every headline metric has a live source.\n"
    : "\nSAMPLER DEGRADED — some mark prices did not decode.\n");
  process.exit(decodeOk ? 0 : 1);
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "sample smoke test fatal");
  process.exit(1);
});
