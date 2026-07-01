// Provision the agent fleet: fund ETH from the treasury (budget-aware) + set up
// each agent's collateral. Idempotent — safe to re-run as more ETH becomes
// available. Respects DRY_RUN (simulate/log only when true).
//   npm run provision        # DEFAULT_FLEET_SIZE agents
//   npm run provision 5      # 5 agents
import { assertChain } from "../src/chain/clients";
import { provision } from "../src/treasury/treasury";
import { DEFAULT_FLEET_SIZE } from "../src/config/provisioning";
import { logger } from "../src/logging/logger";

const count = Math.max(1, Number(process.argv[2] ?? DEFAULT_FLEET_SIZE));

async function main(): Promise<void> {
  await assertChain();
  await provision(count);
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "provision fatal");
  process.exit(1);
});
