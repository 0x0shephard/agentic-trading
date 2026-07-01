import { agentAccount } from "../chain/clients";
import { runAgent } from "../runtime/agentLoop";
import { strategyFor } from "../strategy/registry";
import { DEFAULT_ARCHETYPES } from "../config/archetypes";
import type { ArchetypeParams } from "../config/archetypes";
import type { Knobs } from "../strategy/knobs";
import { DEFAULT_KNOBS } from "../strategy/knobs";
import { mulberry32, seedFromString } from "../runtime/rng";
import { provision } from "../treasury/treasury";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import { TokenBucket } from "./rateLimiter";
import { VolumeTracker } from "./volumeTracker";
import type { Assignment } from "./assignments";
import type { ControllerConfig } from "../controller/controller";
import { stepController } from "../controller/controller";
import { measureMetrics } from "../controller/metrics";
import { getAnthropic } from "../llm/client";
import { regimeState, regimeRateMultiplier } from "../llm/regime";
import { runSupervisorOnce } from "../llm/supervisor";

export interface OrchestratorOpts {
  assignments: Assignment[];
  knobs?: Knobs;
  /** Global transaction rate cap across the whole fleet (tx/sec). */
  globalTps?: number;
  /** Multiply every agent's cadence — for fast dry-run validation. Default 1. */
  rateMultiplier?: number;
  /** Run for this long then stop gracefully; 0 = until KILL_SWITCH / SIGINT. */
  durationMs?: number;
  /** How often to top up the fleet from the treasury. Default 5 min. */
  refillIntervalMs?: number;
  /** Enable the market-structure controller (omit to run open-loop). */
  controller?: ControllerConfig;
  controllerIntervalMs?: number;
  volumeWindowMs?: number;
  /** Run the LLM regime supervisor (defaults on when an API key is present). */
  supervisor?: boolean;
  supervisorIntervalMs?: number;
}

/** Effective action rate = base × rateMultiplier × regime × (relevant knob). */
function effectiveRate(params: ArchetypeParams, knobs: Knobs, mult: number): number {
  const base = params.baseRatePerHour * mult * regimeRateMultiplier(regimeState.current);
  switch (params.id) {
    case "hedger-short":
    case "hedger-long":
    case "macro":
      return base * knobs.buildRate;
    case "degen":
      return base * knobs.degenIntensity;
    default: // basis-arb, momentum, market-maker, hft-taker
      return base * knobs.churnRate;
  }
}

async function refillSafe(count: number): Promise<void> {
  try {
    await provision(count);
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "refill failed (continuing)");
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Runs the whole fleet: one Poisson-cadenced loop per assigned wallet, all
 * sharing a global-TPS bucket and a live, mutable Knobs object. The controller
 * loop (if enabled) measures OI/Vol/TVL and mutates those knobs in place, which
 * every agent reads on its next tick (both for decisions and cadence). Periodic
 * treasury refills and graceful shutdown (duration / SIGINT / KILL_SWITCH).
 */
export async function runOrchestrator(opts: OrchestratorOpts): Promise<void> {
  const knobs: Knobs = { ...(opts.knobs ?? DEFAULT_KNOBS) }; // mutable copy (controller edits in place)
  const mult = opts.rateMultiplier ?? 1;
  const globalTps = opts.globalTps ?? 3;
  const bucket = new TokenBucket(globalTps, Math.max(1, Math.ceil(globalTps)));
  const gate = () => bucket.acquire();
  const volume = new VolumeTracker(opts.volumeWindowMs ?? 3_600_000);

  let stopping = false;
  const shouldStop = () => stopping || env.KILL_SWITCH;
  const onSignal = () => {
    logger.warn("shutdown signal received — stopping orchestrator");
    stopping = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const durTimer =
    opts.durationMs && opts.durationMs > 0
      ? setTimeout(() => {
          logger.info({ durationMs: opts.durationMs }, "duration elapsed — stopping");
          stopping = true;
        }, opts.durationMs)
      : undefined;

  const indices = [...new Set(opts.assignments.map((a) => a.index))];
  const markets = [...new Map(opts.assignments.map((a) => [a.market.marketId, a.market])).values()];
  const maxIndex = indices.reduce((m, i) => Math.max(m, i), 0);

  const refillMs = opts.refillIntervalMs ?? 300_000;
  const refillTimer = setInterval(() => {
    if (!shouldStop()) void refillSafe(maxIndex);
  }, refillMs);

  // Controller loop — measures actuals and mutates the shared knobs in place.
  let controllerTimer: ReturnType<typeof setInterval> | undefined;
  if (opts.controller) {
    const cfg = opts.controller;
    const controllerMs = opts.controllerIntervalMs ?? 30_000;
    const tick = async (): Promise<void> => {
      try {
        const m = await measureMetrics(indices, markets, volume);
        const { knobs: next, actions } = stepController(m, knobs, cfg);
        // apply in place so running agents see the new knobs on their next tick
        knobs.buildRate = next.buildRate;
        knobs.churnRate = next.churnRate;
        logger.info(
          {
            oiUsd: round2(m.oiUsd),
            oiTarget: cfg.targetOiUsd,
            volUsd: round2(m.volumeUsd),
            volTarget: round2(cfg.ratioVol * cfg.targetOiUsd),
            tvlUsd: round2(m.tvlUsd),
            tvlTarget: round2(cfg.ratioTvl * cfg.targetOiUsd),
            buildRate: round2(knobs.buildRate),
            churnRate: round2(knobs.churnRate),
            actions: actions.map((a) => `${a.knob} ${round2(a.from)}→${round2(a.to)} (${a.metric} ${a.errPct.toFixed(0)}%)`),
          },
          "controller tick",
        );
      } catch (e) {
        logger.error({ err: e instanceof Error ? e.message : String(e) }, "controller tick failed");
      }
    };
    controllerTimer = setInterval(() => {
      if (!shouldStop()) void tick();
    }, controllerMs);
  }

  // LLM regime supervisor — updates the shared regime periodically (needs a key).
  let supervisorTimer: ReturnType<typeof setInterval> | undefined;
  const supervisorEnabled = (opts.supervisor ?? true) && getAnthropic() !== null;
  if (supervisorEnabled) {
    const supMs = opts.supervisorIntervalMs ?? 1_200_000; // 20 min
    void runSupervisorOnce(markets); // prime the regime once at startup
    supervisorTimer = setInterval(() => {
      if (!shouldStop()) void runSupervisorOnce(markets);
    }, supMs);
  }

  logger.info(
    {
      agents: opts.assignments.length,
      globalTps,
      rateMultiplier: mult,
      durationMs: opts.durationMs ?? 0,
      controller: opts.controller ? "on" : "off",
      supervisor: supervisorEnabled ? "on" : "off",
      regime: regimeState.current.stance,
      dryRun: env.DRY_RUN,
      assignments: opts.assignments.map((a) => `#${a.index}:${a.archetype}@${a.market.name}`),
    },
    "orchestrator start",
  );

  const runs = opts.assignments.map((a) => {
    const params = DEFAULT_ARCHETYPES[a.archetype];
    const strategy = strategyFor(a.archetype);
    const rng = mulberry32(seedFromString(`${a.archetype}-${a.index}`));
    return runAgent(agentAccount(a.index), strategy, {
      market: a.market,
      params,
      iterations: 0,
      ratePerHour: () => effectiveRate(params, knobs, mult), // live: re-read each tick
      rng,
      knobs, // shared mutable ref — controller edits are visible to decide()
      gate,
      shouldStop,
      onTrade: (n) => volume.record(n),
      maxDelayMs: 60_000,
    }).catch((e: unknown) => {
      logger.error({ index: a.index, err: e instanceof Error ? e.message : String(e) }, "agent loop crashed");
    });
  });

  try {
    await Promise.allSettled(runs);
  } finally {
    clearInterval(refillTimer);
    if (controllerTimer) clearInterval(controllerTimer);
    if (supervisorTimer) clearInterval(supervisorTimer);
    if (durTimer) clearTimeout(durTimer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  logger.info("orchestrator stopped");
}
