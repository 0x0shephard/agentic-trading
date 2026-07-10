// Market-manipulation surveillance monitor. Reads canonical_pnl_events +
// vamm_price_history, runs the behavioral detector, writes manipulation_alerts.
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (and AGENT_MNEMONIC for labels).
//   npm run monitor         # continuous loop (the Railway service)
//   npm run monitor once    # single pass over the lookback window (test)
import { assertChain } from "../src/chain/clients";
import { runMonitor, runMonitorOnce } from "../src/surveillance/monitor";
import { logger } from "../src/logging/logger";

async function main(): Promise<void> {
  await assertChain();
  if (process.argv[2] === "once") {
    const n = await runMonitorOnce();
    logger.info({ alerts: n }, "monitor: single pass done");
    return;
  }
  await runMonitor();
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "monitor fatal");
  process.exit(1);
});
