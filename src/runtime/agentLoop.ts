import type { Account } from "viem";
import type { MarketDef } from "../config/markets";
import type { Strategy } from "../strategy/types";
import type { Rng } from "./rng";
import type { Knobs } from "../strategy/knobs";
import type { ArchetypeParams } from "../config/archetypes";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import { getMarketSnapshot, getAccountMarketState } from "../market/snapshot";
import { executeIntent } from "../execution/act";
import { poissonDelayMs, sleepUntil, clamp } from "./cadence";
import { MarketHistory } from "../market/history";
import { DEFAULT_KNOBS } from "../strategy/knobs";
import { toNumberX18 } from "../preview/orderPreview";

export interface RunAgentOpts {
  market: MarketDef;
  /** This agent's archetype parameters. */
  params: ArchetypeParams;
  /** Number of ticks to run; 0 = run until KILL_SWITCH. */
  iterations: number;
  /** Poisson action rate (events/hour). A function is re-read each tick so the
   *  controller's live knob changes take effect on cadence. */
  ratePerHour: number | (() => number);
  rng: Rng;
  /** Controller knobs; defaults to DEFAULT_KNOBS. */
  knobs?: Knobs;
  historyCap?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Global rate-limit gate acquired before each actionable (non-hold) tx. */
  gate?: () => Promise<void>;
  /** External stop signal, checked each tick alongside KILL_SWITCH. */
  shouldStop?: () => boolean;
  /** Called with the traded notional (USD) after each successfully sent tx. */
  onTrade?: (notionalUsd: number) => void;
}

/**
 * One agent's decision/action loop: wait a Poisson-distributed delay → snapshot
 * the market + own state → ask the strategy for an intent → execute it. Every
 * tick is wrapped so a single failure logs and the loop continues rather than
 * killing the agent. Honours DRY_RUN (via executeWrite) and the KILL_SWITCH.
 */
export async function runAgent(account: Account, strategy: Strategy, opts: RunAgentOpts): Promise<void> {
  const log = logger.child({ agent: account.address, strategy: strategy.name, market: opts.market.name });
  const minDelay = opts.minDelayMs ?? 0;
  const maxDelay = opts.maxDelayMs ?? 3_600_000;
  const knobs = opts.knobs ?? DEFAULT_KNOBS;
  const history = new MarketHistory(opts.historyCap ?? 240);
  const abort = () => env.KILL_SWITCH || (opts.shouldStop?.() ?? false);
  log.info(
    { iterations: opts.iterations, ratePerHour: opts.ratePerHour, archetype: opts.params.id, dryRun: env.DRY_RUN },
    "agent loop start",
  );

  let tick = 0;
  while (opts.iterations === 0 || tick < opts.iterations) {
    if (env.KILL_SWITCH) {
      log.warn("KILL_SWITCH set — stopping loop");
      break;
    }
    if (abort()) {
      log.info("stop signal — exiting loop");
      break;
    }
    const rate = typeof opts.ratePerHour === "function" ? opts.ratePerHour() : opts.ratePerHour;
    const delay = clamp(poissonDelayMs(rate, opts.rng), minDelay, maxDelay);
    await sleepUntil(delay, abort); // interruptible so shutdown stays prompt
    if (abort()) break;
    tick += 1;

    try {
      const snapshot = await getMarketSnapshot(opts.market);
      if (snapshot.paused) {
        log.warn({ tick }, "market paused — skipping tick");
        continue;
      }
      history.push({ t: Date.now(), markX18: snapshot.markPriceX18, indexX18: snapshot.indexPriceX18 });
      const acct = await getAccountMarketState(account, opts.market);
      const intent = await strategy.decide({
        now: Date.now(),
        rng: opts.rng,
        snapshot,
        account: acct,
        history,
        knobs,
        params: opts.params,
        logger: log,
      });
      log.info(
        {
          tick,
          delayMs: Math.round(delay),
          markUsd: toNumberX18(snapshot.markPriceX18).toFixed(4),
          sizeX18: toNumberX18(acct.sizeX18),
          intent: intent.kind,
          reason: intent.reason,
        },
        "decided",
      );
      // Consume a global-TPS token only when we're about to actually transact.
      if (intent.kind !== "hold" && opts.gate) await opts.gate();
      const res = await executeIntent(account, opts.market, intent);
      if (!res.acted) {
        log.info({ tick, intent: res.intent, reason: res.reason }, "no-op");
      } else if (res.write.skipped) {
        log.warn({ tick, intent: res.intent, reason: res.write.reason }, "skipped — gas");
      } else {
        if (!res.write.reverted) opts.onTrade?.(res.notionalUsd);
        log.info(
          {
            tick,
            intent: res.intent,
            reverted: res.write.reverted,
            notionalUsd: res.notionalUsd.toFixed(2),
            hash: res.write.hash,
            gasUsed: res.write.gasUsed?.toString(),
          },
          "acted",
        );
      }
    } catch (e) {
      log.error({ tick, err: e instanceof Error ? e.message : String(e) }, "tick failed — continuing");
    }
  }

  log.info({ ticks: tick }, "agent loop done");
}
