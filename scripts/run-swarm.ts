// Run the whole agent fleet under the orchestrator + market-structure controller.
// Respects DRY_RUN.
//   DRY_RUN=true npm run swarm 3 20 300 5   # 3 agents, 20s, 300x cadence, ctrl every 5s
//   npm run swarm 3 0                        # 3 agents, until Ctrl-C (live)
//   npm run swarm                            # DEFAULT_FLEET_SIZE agents, until Ctrl-C
import { assertChain } from "../src/chain/clients";
import { buildAssignments } from "../src/orchestrator/assignments";
import { runOrchestrator } from "../src/orchestrator/orchestrator";
import { DEFAULT_CONTROLLER } from "../src/controller/controller";
import { DEFAULT_FLEET_SIZE } from "../src/config/provisioning";
import { logger } from "../src/logging/logger";

const count = Math.max(1, Number(process.argv[2] ?? DEFAULT_FLEET_SIZE));
const durationSec = Math.max(0, Number(process.argv[3] ?? 0));
const rateMultiplier = Math.max(0.01, Number(process.argv[4] ?? 1));
const controllerSec = Math.max(1, Number(process.argv[5] ?? 30));
const reportSec = Math.max(0, Number(process.argv[6] ?? 60));

async function main(): Promise<void> {
  await assertChain();
  const assignments = buildAssignments(count);
  await runOrchestrator({
    assignments,
    durationMs: durationSec * 1000,
    rateMultiplier,
    globalTps: 3,
    refillIntervalMs: 300_000,
    controller: DEFAULT_CONTROLLER,
    controllerIntervalMs: controllerSec * 1000,
    reportIntervalMs: reportSec * 1000,
    volumeWindowMs: 3_600_000,
  });
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "run-swarm fatal");
  process.exit(1);
});
