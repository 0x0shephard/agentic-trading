// Railway scheduled worker.
//
// Default behavior:
//   - start one swarm run immediately
//   - run it for RAILWAY_DURATION_SEC seconds (default 600 = 10 minutes)
//   - wait until RAILWAY_RUN_INTERVAL_SEC seconds have elapsed from run start
//     (default 43200 = 12 hours)
//   - repeat forever
//
// This gives two runs per 24h, spaced as far apart as possible.
import { assertChain } from "../src/chain/clients";
import { ethBalance } from "../src/chain/native";
import { DEFAULT_FLEET_SIZE } from "../src/config/provisioning";
import { DEFAULT_CONTROLLER } from "../src/controller/controller";
import { logger } from "../src/logging/logger";
import { buildAssignments } from "../src/orchestrator/assignments";
import { runOrchestrator } from "../src/orchestrator/orchestrator";
import { provision } from "../src/treasury/treasury";
import { agentMembers, treasury } from "../src/wallet/fleet";
import { formatEther } from "viem";

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

function sleep(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || shouldStop()) {
      resolve();
      return;
    }

    const step = Math.min(ms, 60_000);
    const timer = setTimeout(() => {
      void sleep(ms - step, shouldStop).then(resolve);
    }, step);

    if (shouldStop()) {
      clearTimeout(timer);
      resolve();
    }
  });
}

const count = Math.floor(numEnv("RAILWAY_AGENT_COUNT", DEFAULT_FLEET_SIZE, 1));
const durationSec = numEnv("RAILWAY_DURATION_SEC", 600, 1);
const runIntervalSec = numEnv("RAILWAY_RUN_INTERVAL_SEC", 43_200, durationSec);
const rateMultiplier = numEnv("RAILWAY_RATE_MULTIPLIER", 1, 0.01);
const controllerSec = numEnv("RAILWAY_CONTROLLER_SEC", 30, 1);
const reportSec = numEnv("RAILWAY_REPORT_SEC", 60, 0);
const globalTps = numEnv("RAILWAY_GLOBAL_TPS", 3, 0.01);
const provisionOnStart = boolEnv("RAILWAY_PROVISION_ON_START", false);

let stopping = false;
const stop = () => {
  logger.warn("shutdown signal received — stopping scheduled worker");
  stopping = true;
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function fleetEthBalance(count: number): Promise<bigint> {
  const members = [treasury(), ...agentMembers(count).map((m) => m.account)];
  const balances = await Promise.all(members.map((m) => ethBalance(m.address)));
  return balances.reduce((sum, x) => sum + x, 0n);
}

async function runOnce(cycle: number): Promise<void> {
  const fleetEthBefore = await fleetEthBalance(count);

  if (provisionOnStart) {
    logger.info({ cycle, count }, "scheduled provisioning enabled — provisioning fleet before swarm run");
    await provision(count);
  }

  logger.info(
    {
      cycle,
      count,
      durationSec,
      runIntervalSec,
      rateMultiplier,
      nextRunInSec: runIntervalSec,
    },
    "scheduled swarm run starting",
  );

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

  const fleetEthAfter = await fleetEthBalance(count);
  const spentWei = fleetEthBefore > fleetEthAfter ? fleetEthBefore - fleetEthAfter : 0n;
  logger.info(
    {
      cycle,
      fleetEthBefore: formatEther(fleetEthBefore),
      fleetEthAfter: formatEther(fleetEthAfter),
      sessionCostEth: formatEther(spentWei),
    },
    "scheduled session ETH cost",
  );
}

async function main(): Promise<void> {
  await assertChain();

  let cycle = 0;
  while (!stopping) {
    cycle += 1;
    const startedAt = Date.now();
    await runOnce(cycle);

    const elapsedMs = Date.now() - startedAt;
    const waitMs = Math.max(0, runIntervalSec * 1000 - elapsedMs);
    if (waitMs > 0 && !stopping) {
      logger.info({ cycle, waitSec: Math.round(waitMs / 1000) }, "scheduled swarm run complete — waiting");
      await sleep(waitMs, () => stopping);
    }
  }

  logger.info("scheduled worker stopped");
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "railway scheduled worker fatal");
  process.exit(1);
});
