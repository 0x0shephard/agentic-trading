// Run an RMF Appendix F stress scenario against the fork.
//
//   npm run stress:run volatility
import type { Address } from "viem";
import { connectFork } from "../src/stress/fork";
import { runScenario } from "../src/stress/scenario";
import { volatilityScenario } from "../src/stress/scenarios/volatility";
import { depegScenario } from "../src/stress/scenarios/depeg";
import { indexFailureScenario } from "../src/stress/scenarios/indexfail";
import { sequencerScenario } from "../src/stress/scenarios/sequencer";
import { sequencerPressureScenario } from "../src/stress/scenarios/sequencerPressure";
import { agentAccount } from "../src/chain/clients";
import { logger } from "../src/logging/logger";

// Markets carrying real positions, so scenarios act on a genuine book.
const MARKETS = ["A100-PERP", "T4-PERP", "H100-GPU-PERP", "H200-PERP-V2", "B200-PERP-V2"];

function agentAccounts(n = 16): Address[] {
  const out: Address[] = [];
  for (let i = 0; i <= n; i++) out.push(agentAccount(i).address as Address);
  return out;
}

async function main(): Promise<void> {
  const which = (process.argv[2] || "volatility").toLowerCase();
  const f = await connectFork();
  const accounts = agentAccounts();

  const defs: Record<string, () => ReturnType<typeof volatilityScenario>> = {
    volatility: () => volatilityScenario(MARKETS, accounts),
    depeg: () => depegScenario(MARKETS, accounts),
    indexfail: () => indexFailureScenario(MARKETS, accounts),
    sequencer: () => sequencerScenario(MARKETS, accounts),
    seqpressure: () => sequencerPressureScenario(MARKETS, accounts),
  };
  const make = defs[which];
  if (!make) {
    console.error(`unknown scenario "${which}". available: ${Object.keys(defs).join(", ")}`);
    process.exit(1);
  }

  const res = await runScenario(f, make());
  const s = res.summary;

  console.log(`\n=== ${res.title} ===`);
  console.log(`samples=${s.samples} simulated=${s.durationSec}s blocks ${res.forkBlockStart}-${res.forkBlockEnd}`);
  console.log(`liquidations=${s.liquidations.count} accounts=${s.liquidations.accounts} notional=${s.liquidations.totalNotional.toFixed(2)}`);
  console.log(`IF draw=${s.insuranceFund.draw.toFixed(2)} USDC (${s.insuranceFund.startBalance.toFixed(2)} -> ${s.insuranceFund.endBalance.toFixed(2)})`);
  console.log(`bad debt increase=${s.badDebt.increase} (events: ${res.badDebtEvents.length})`);
  console.log("\nmarket           mark start ->   end    move%    vol(bps)  basis start -> end   OI flow");
  for (const m of s.perMarket) {
    console.log(
      `${m.market.padEnd(16)} ${String(m.markStart?.toFixed(4) ?? "-").padStart(9)} -> ${String(m.markEnd?.toFixed(4) ?? "-").padStart(8)} ` +
      `${String(m.markMovePct?.toFixed(1) ?? "-").padStart(7)} ${String(m.volBps.toFixed(1)).padStart(10)}  ` +
      `${String(m.basisStartBps?.toFixed(0) ?? "-").padStart(6)} -> ${String(m.basisEndBps?.toFixed(0) ?? "-").padStart(6)}  ${m.oiFlow.toFixed(2).padStart(9)}`,
    );
  }
  console.log(`\nrecord written to stress-results/${res.id}.{json,md}\n`);
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "scenario run fatal");
  process.exit(1);
});
