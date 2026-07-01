// Read-only snapshot of the treasury + agent wallets (ETH / wallet-USDC /
// vault-USDC). Sends nothing.
//   npm run treasury         # DEFAULT_FLEET_SIZE agents
//   npm run treasury 5       # treasury + agents 1..5
import { assertChain } from "../src/chain/clients";
import { treasuryStatus } from "../src/treasury/treasury";
import { DEFAULT_FLEET_SIZE } from "../src/config/provisioning";
import { logger } from "../src/logging/logger";

const count = Math.max(0, Number(process.argv[2] ?? DEFAULT_FLEET_SIZE));

async function main(): Promise<void> {
  await assertChain();
  await treasuryStatus(count);
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "treasury-status fatal");
  process.exit(1);
});
