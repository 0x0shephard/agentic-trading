// Railway worker entrypoint for the long-running swarm.
//
// Configure with Railway variables instead of CLI args:
//   RAILWAY_AGENT_COUNT=3
//   RAILWAY_DURATION_SEC=0
//   RAILWAY_RATE_MULTIPLIER=1
//   RAILWAY_CONTROLLER_SEC=30
//   RAILWAY_REPORT_SEC=60
//   RAILWAY_GLOBAL_TPS=3
//   RAILWAY_PROVISION_ON_START=false
//
// The usual safety env vars still apply: DRY_RUN, KILL_SWITCH, CHAIN_ID,
// SEPOLIA_RPC_URL, AGENT_MNEMONIC.
import { assertChain } from "../src/chain/clients";
import { DEFAULT_FLEET_SIZE } from "../src/config/provisioning";
import { DEFAULT_CONTROLLER } from "../src/controller/controller";
import { logger } from "../src/logging/logger";
import { buildAssignments } from "../src/orchestrator/assignments";
import { runOrchestrator } from "../src/orchestrator/orchestrator";
import { provision } from "../src/treasury/treasury";

function numEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got "${raw}"`);
  return Math.max(min, n);
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be "true" or "false", got "${raw}"`);
}

const count = Math.floor(numEnv("RAILWAY_AGENT_COUNT", DEFAULT_FLEET_SIZE, 1));
const durationSec = numEnv("RAILWAY_DURATION_SEC", 0, 0);
const rateMultiplier = numEnv("RAILWAY_RATE_MULTIPLIER", 1, 0.01);
const controllerSec = numEnv("RAILWAY_CONTROLLER_SEC", 30, 1);
const reportSec = numEnv("RAILWAY_REPORT_SEC", 60, 0);
const globalTps = numEnv("RAILWAY_GLOBAL_TPS", 3, 0.01);
const provisionOnStart = boolEnv("RAILWAY_PROVISION_ON_START", false);

async function main(): Promise<void> {
  await assertChain();

  if (provisionOnStart) {
    logger.info({ count }, "Railway provisioning enabled — provisioning fleet before swarm start");
    await provision(count);
  }

  const assignments = buildAssignments(count);
  await runOrchestrator({
    assignments,
    durationMs: durationSec * 1000,
    rateMultiplier,
    globalTps,
    refillIntervalMs: 300_000,
    controller: DEFAULT_CONTROLLER,
    controllerIntervalMs: controllerSec * 1000,
    reportIntervalMs: reportSec * 1000,
    volumeWindowMs: 3_600_000,
  });
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "railway swarm fatal");
  process.exit(1);
});
