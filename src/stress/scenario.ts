// Scenario runner for the RMF Appendix F stress tests.
//
// Every scenario follows the same shape so the four runs are comparable and each
// produces an auditable record:
//
//   snapshot -> baseline sample -> [phases: inject, advance, sample, sweep] -> summarise -> ALWAYS revert
//
// The revert is in a finally block by design. A scenario that throws must still
// restore the baseline, otherwise its injected faults leak into every subsequent
// run (an aborted run once left an index pinned at 0 and silently poisoned the
// next scenario).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Address } from "viem";
import type { ForkClients } from "./fork";
import { snapshot, revert, forkNow, mine } from "./fork";
import { sample, collectLiquidations, collectBadDebt, summarise } from "./metrics";
import type { Sample, LiquidationRecord, BadDebtRecord, ScenarioSummary } from "./metrics";
import { ensureKeeperWhitelisted, sweep } from "./liquidator";
import type { SweepResult } from "./liquidator";
import type { MarketDef } from "../config/markets";
import { logger } from "../logging/logger";

export interface ScenarioContext {
  f: ForkClients;
  markets: readonly MarketDef[];
  accounts: readonly Address[];
  /** Record an observation in the scenario timeline (appears in the note).
   *  Async because each entry is stamped with fork time AT THE MOMENT it is
   *  recorded; stamping in bulk at the end collapses the whole timeline onto one
   *  timestamp and destroys the sequence. */
  note: (msg: string, data?: Record<string, unknown>) => Promise<void>;
  /** Take a metric sample now. */
  observe: () => Promise<Sample>;
  /** Run the liquidation keeper once. */
  runKeeper: () => Promise<SweepResult>;
  /** Advance fork time and mine. */
  advance: (seconds: number) => Promise<void>;
}

export interface ScenarioDef {
  id: string;
  title: string;
  /** What this scenario is testing, for the written note. */
  objective: string;
  markets: readonly MarketDef[];
  accounts: readonly Address[];
  run: (ctx: ScenarioContext) => Promise<void>;
}

export interface TimelineEntry { t: number; block: number; msg: string; data?: Record<string, unknown> }

export interface ScenarioResult {
  id: string;
  title: string;
  objective: string;
  startedAt: string;
  forkBlockStart: number;
  forkBlockEnd: number;
  timeline: TimelineEntry[];
  samples: Sample[];
  liquidations: LiquidationRecord[];
  badDebtEvents: BadDebtRecord[];
  keeperSweeps: SweepResult[];
  summary: ScenarioSummary;
}

const OUT_DIR = join(process.cwd(), "stress-results");

/** Execute a scenario against the fork, always restoring the baseline afterwards. */
export async function runScenario(f: ForkClients, def: ScenarioDef): Promise<ScenarioResult> {
  await ensureKeeperWhitelisted(f);

  const snap = await snapshot(f);
  const samples: Sample[] = [];
  const timeline: TimelineEntry[] = [];
  const keeperSweeps: SweepResult[] = [];
  const startBlock = Number(await f.pub.getBlockNumber());
  const startedAt = new Date().toISOString();

  const ctx: ScenarioContext = {
    f,
    markets: def.markets,
    accounts: def.accounts,
    note: async (msg, data) => {
      const [t, b] = await Promise.all([forkNow(f), f.pub.getBlockNumber()]);
      timeline.push({ t, block: Number(b), msg, ...(data ? { data } : {}) });
      logger.info({ scenario: def.id, ...data }, msg);
    },
    observe: async () => {
      const s = await sample(f, def.markets);
      samples.push(s);
      return s;
    },
    runKeeper: async () => {
      const r = await sweep(f, def.accounts, def.markets);
      keeperSweeps.push(r);
      if (r.executed > 0) logger.warn({ scenario: def.id, executed: r.executed }, "keeper liquidated positions");
      return r;
    },
    advance: async (seconds: number) => {
      await f.test.request({ method: "evm_increaseTime", params: [seconds] } as never);
      await mine(f, 1);
    },
  };

  let failure: unknown = null;
  try {
    await ctx.note(`scenario start: ${def.title}`);
    await ctx.observe(); // baseline
    await def.run(ctx);
    await ctx.note("scenario complete");
  } catch (e) {
    failure = e;
    await ctx.note(`scenario ABORTED: ${e instanceof Error ? e.message : String(e)}`).catch(() => { /* best effort */ });
    logger.error({ scenario: def.id, err: e instanceof Error ? e.message : String(e) }, "scenario failed");
  }

  const endBlock = Number(await f.pub.getBlockNumber());
  const liquidations = await collectLiquidations(f, BigInt(startBlock), BigInt(endBlock)).catch(() => []);
  const badDebtEvents = await collectBadDebt(f, BigInt(startBlock), BigInt(endBlock)).catch(() => []);

  const result: ScenarioResult = {
    id: def.id, title: def.title, objective: def.objective, startedAt,
    forkBlockStart: startBlock, forkBlockEnd: endBlock,
    timeline, samples, liquidations, badDebtEvents, keeperSweeps,
    summary: samples.length >= 1
      ? summarise(def.id, samples, liquidations)
      : ({ scenario: def.id, samples: 0, durationSec: 0, perMarket: [], liquidations: { count: 0, totalNotional: 0, accounts: 0, totalInsurancePayout: 0, totalBadDebt: 0 }, insuranceFund: { startBalance: 0, endBalance: 0, draw: 0 }, badDebt: { start: 0, end: 0, increase: 0 } } as ScenarioSummary),
  };

  // ALWAYS restore, success or failure. See header note.
  try {
    await revert(f, snap);
    logger.info({ scenario: def.id }, "baseline restored");
  } catch (e) {
    logger.error({ scenario: def.id, err: e instanceof Error ? e.message : String(e) }, "REVERT FAILED — fork state is dirty, restart anvil before the next scenario");
  }

  persist(result);
  if (failure) throw failure;
  return result;
}

function persist(r: ScenarioResult): void {
  const jsonPath = join(OUT_DIR, `${r.id}.json`);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  writeFileSync(join(OUT_DIR, `${r.id}.md`), renderNote(r));
  logger.info({ scenario: r.id, out: OUT_DIR }, "scenario record written");
}

const n2 = (v: number | null, d = 2) => (v === null || Number.isNaN(v) ? "n/a" : v.toFixed(d));

/** Render the per-scenario note that accompanies the submission. */
export function renderNote(r: ScenarioResult): string {
  const s = r.summary;
  const L: string[] = [];
  L.push(`# ${r.title}`, "");
  L.push(`**Scenario ID:** ${r.id}  `);
  L.push(`**Executed:** ${r.startedAt}  `);
  L.push(`**Environment:** forked Sepolia state, blocks ${r.forkBlockStart}–${r.forkBlockEnd}  `);
  L.push(`**Duration (simulated):** ${s.durationSec}s across ${s.samples} samples`, "");
  L.push(`## Objective`, "", r.objective, "");

  L.push(`## Headline metrics`, "");
  L.push(`| Metric | Result |`, `|---|---|`);
  L.push(`| Liquidations executed | ${s.liquidations.count} across ${s.liquidations.accounts} account(s) |`);
  L.push(`| Liquidated notional | ${n2(s.liquidations.totalNotional)} |`);
  L.push(`| InsuranceFund draw | ${n2(s.insuranceFund.draw)} USDC |`);
  L.push(`| InsuranceFund balance | ${n2(s.insuranceFund.startBalance)} -> ${n2(s.insuranceFund.endBalance)} USDC |`);
  L.push(`| Bad debt increase | ${n2(s.badDebt.increase, 6)} |`);
  L.push(`| Bad debt events | ${r.badDebtEvents.length} |`);
  L.push("");

  L.push(`## Per-market behaviour`, "");
  L.push(`| Market | Mark start | Mark end | Move % | Realised vol (bps) | Basis start | Basis end | Max abs basis | OI start | OI end | OI flow | Oracle reverts |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const m of s.perMarket) {
    L.push(`| ${m.market} | ${n2(m.markStart, 4)} | ${n2(m.markEnd, 4)} | ${n2(m.markMovePct)} | ${n2(m.volBps, 1)} | ${n2(m.basisStartBps, 0)} | ${n2(m.basisEndBps, 0)} | ${n2(m.basisMaxAbsBps, 0)} | ${n2(m.oiStart)} | ${n2(m.oiEnd)} | ${n2(m.oiFlow)} | ${m.oracleRevertedSamples}/${s.samples} |`);
  }
  L.push("");

  if (r.liquidations.length) {
    L.push(`## Liquidations`, "");
    L.push(`| Block | Account | Size | Notional | Penalty | IF payout |`, `|---|---|---|---|---|---|`);
    for (const l of r.liquidations) {
      L.push(`| ${l.block} | ${l.account.slice(0, 10)}… | ${n2(l.size, 4)} | ${n2(l.notional)} | ${n2(l.penalty)} | ${n2(l.insurancePayout)} |`);
    }
    L.push("");
  }

  if (r.badDebtEvents.length) {
    L.push(`## Bad debt recorded`, "");
    L.push(`| Block | Account | Shortfall |`, `|---|---|---|`);
    for (const b of r.badDebtEvents) L.push(`| ${b.block} | ${b.account.slice(0, 10)}… | ${n2(b.shortfall, 6)} |`);
    L.push("");
  }

  L.push(`## Timeline`, "");
  for (const e of r.timeline) {
    const extra = e.data ? ` — ${Object.entries(e.data).map(([k, v]) => `${k}=${String(v)}`).join(", ")}` : "";
    L.push(`- \`t=${e.t}\` (block ${e.block}) ${e.msg}${extra}`);
  }
  L.push("");
  L.push(`## Keeper activity`, "");
  const totAttempt = r.keeperSweeps.reduce((a, k) => a + k.attempted, 0);
  const totExec = r.keeperSweeps.reduce((a, k) => a + k.executed, 0);
  L.push(`${r.keeperSweeps.length} sweep(s); ${totAttempt} liquidatable position(s) detected, ${totExec} liquidation(s) executed.`, "");
  L.push(`---`, "", `_Data derived from forked on-chain state. No transaction in this record touched the live deployment._`);
  return L.join("\n");
}
