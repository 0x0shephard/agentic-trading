// Run the LLM regime supervisor once against the live markets and print the
// regime it sets. Needs ANTHROPIC_API_KEY (does nothing without one).
//   npm run supervisor
import { assertChain } from "../src/chain/clients";
import { MARKETS } from "../src/config/markets";
import { runSupervisorOnce } from "../src/llm/supervisor";
import { regimeState } from "../src/llm/regime";
import { getAnthropic } from "../src/llm/client";
import { logger } from "../src/logging/logger";

async function main(): Promise<void> {
  await assertChain();
  if (!getAnthropic()) {
    logger.warn("no ANTHROPIC_API_KEY — supervisor cannot run; regime stays neutral");
    return;
  }
  const regime = await runSupervisorOnce(MARKETS);
  logger.info({ regime: regime ?? regimeState.current }, "supervisor done");
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "run-supervisor fatal");
  process.exit(1);
});
