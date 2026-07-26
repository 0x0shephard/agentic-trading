// Market-manipulation surveillance monitor. Reads canonical_pnl_events +
// vamm_price_history, runs the behavioral detector, writes manipulation_alerts.
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (and AGENT_MNEMONIC for labels).
//   npm run monitor         # continuous loop (the Railway service)
//   npm run monitor once    # single pass over the lookback window (test)
import { assertChain, WrongChainError } from "../src/chain/clients";
import { runMonitor, runMonitorOnce } from "../src/surveillance/monitor";
import { logger } from "../src/logging/logger";

const RPC_RETRY_MS = 30_000;

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** Railway workers should survive a transient RPC outage at boot. A confirmed
 * wrong chain remains fatal because retrying it would hide a bad deployment. */
async function waitForSepolia(): Promise<void> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await assertChain();
      if (attempt > 1) logger.info({ attempt }, "monitor: Sepolia RPC connection restored");
      return;
    } catch (e) {
      if (e instanceof WrongChainError) throw e;
      logger.error(
        { err: errMsg(e), attempt, retryInSec: RPC_RETRY_MS / 1000 },
        "monitor: Sepolia RPC unavailable at startup — retrying",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, RPC_RETRY_MS));
    }
  }
}

async function main(): Promise<void> {
  await waitForSepolia();
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
