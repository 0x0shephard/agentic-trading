// Read-only fleet report: per-agent + per-archetype attribution and exchange-wide
// OI/Vol/TVL vs the target ratio. On-chain snapshot (session volume/trades are
// only populated inside a running swarm). Sends nothing.
//   npm run report [n]
import { assertChain } from "../src/chain/clients";
import { buildAssignments } from "../src/orchestrator/assignments";
import { DEFAULT_FLEET_SIZE } from "../src/config/provisioning";
import { DEFAULT_CONTROLLER } from "../src/controller/controller";
import { buildFleetReport, printFleetReport } from "../src/observability/report";
import { logger } from "../src/logging/logger";

const count = Math.max(1, Number(process.argv[2] ?? DEFAULT_FLEET_SIZE));

async function main(): Promise<void> {
  await assertChain();
  const assignments = buildAssignments(count);
  const report = await buildFleetReport(assignments, { controller: DEFAULT_CONTROLLER });
  printFleetReport(report);
  console.log("(note: session volume/trades are only tracked inside a running swarm)");
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "report fatal");
  process.exit(1);
});
