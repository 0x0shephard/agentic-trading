// Sequencer outage WITH real liquidation pressure (redo of F-2 Part B).
//
// The first Part B was null: it moved a short-heavy market's price down (which
// helps shorts), so nothing was near maintenance, and it moved the price with a
// storage write, so there was no real backlog. This redo fixes both.
//
// Design:
//   1. Setup (blocks flowing): slide the LONG markets' indices down so those
//      positions sit close to maintenance -- accounts near their limits at halt.
//   2. Outage: halt block production. The external price gaps further down
//      (a storage write; the market moving is not a user action). Positions are
//      now underwater but nobody can transact.
//   3. Race: while halted, queue REAL transactions -- each underwater user's
//      closePosition, and the keeper's liquidate for the same accounts. anvil
//      orders the mempool by priority fee, so users are split into two cohorts,
//      BOTH submitted before the keeper: FAIR bids above the keeper, ADVERSE
//      below. This isolates whether being queued first in TIME protects a user,
//      or whether only fee decides.
//   4. Resume: mine. Reconstruct execution order from receipts and determine per
//      account whether the close or the liquidation landed first.
//
// Pre-registered expectations are in stress-notes/scenario-b-expectations.md.
import { parseAbi, formatUnits } from "viem";
import type { Address, Hex } from "viem";
import type { ScenarioDef, ScenarioContext } from "../scenario";
import { impersonate, forkNow, haltBlockProduction, resumeBlockProduction, mine } from "../fork";
import { resolveIndex, readIndex, findPriceSlot, forcePriceData } from "../inject";
import type { IndexHandle } from "../inject";
import { KEEPER_ADDRESS } from "../liquidator";
import { checkHealth, newHealthState } from "../../surveillance/alerting/health";
import CH_ARTIFACT from "../../../../overhaul/src/contracts/abis/ClearingHouse.json";
import { CONTRACTS } from "../../config/addresses";
import { MARKETS } from "../../config/markets";

const CH = CH_ARTIFACT.abi as never;
const MR = parseAbi([
  "function getMarket(bytes32) view returns ((address vamm, uint16 feeBps, bool paused, address oracle, address feeRouter, address insuranceFund, address baseAsset, address quoteToken, uint256 baseUnit))",
]);
const VAMM = parseAbi(["function getMarkPrice() view returns (uint256)"]);

const GWEI = 1_000_000_000n;
const MAX_FEE = 300n * GWEI;
const KEEPER_PRIORITY = 2n * GWEI;
const FAIR_PRIORITY = 5n * GWEI; // user outbids keeper -> user's close lands first
const ADVERSE_PRIORITY = 1n * GWEI; // user underbids keeper -> keeper wins the race

// Long-heavy markets: a price fall pushes these toward liquidation.
const LONG_MARKETS = ["H100-GPU-PERP", "H200-PERP-V2", "B200-PERP-V2"];

const n18 = (v: bigint) => Number(formatUnits(v, 18));

interface Target {
  account: Address;
  market: (typeof MARKETS)[number];
  size: bigint; // absolute, x18
  cohort: "fair" | "adverse";
  closeHash?: Hex;
  liqHash?: Hex;
}

export function sequencerPressureScenario(marketNames: string[], accounts: readonly Address[]): ScenarioDef {
  const markets = MARKETS.filter((m) => marketNames.includes(m.name));
  const stressMarkets = markets.filter((m) => LONG_MARKETS.includes(m.name));
  return {
    id: "f2b-sequencer-pressure",
    title: "F-2 Part B: Sequencer Outage with Real Liquidation Pressure",
    objective:
      "Drive the long markets to the edge of maintenance, halt block production, gap the price further during the " +
      "outage, and queue real user-exit and keeper-liquidation transactions that compete when blocks resume. " +
      "Measure what lands first in the first blocks back, whether a user who queued a close ahead of the keeper is " +
      "liquidated anyway, and whether the episode creates bad debt or draws the InsuranceFund.",
    markets,
    accounts,
    run: async (ctx: ScenarioContext) => {
      const { f } = ctx;

      // Resolve oracle handles + starting price for each stressed market.
      const handles = new Map<string, { h: IndexHandle; start: bigint; vamm: Address }>();
      for (const m of stressMarkets) {
        const cfg = (await f.pub.readContract({ address: CONTRACTS.marketRegistry, abi: MR, functionName: "getMarket", args: [m.marketId] })) as { oracle: Address; vamm: Address };
        const h = await resolveIndex(f, cfg.oracle);
        await findPriceSlot(f, h);
        const { price } = await readIndex(f, h);
        handles.set(m.name, { h, start: price, vamm: cfg.vamm });
      }
      await ctx.note("resolved stressed markets", { markets: [...handles.keys()].join(", ") });

      // Clear any inherited liquidatable positions so the scenario measures its own effect.
      const pre = await ctx.runKeeper();
      await ctx.note("pre-scenario keeper sweep", { detected: pre.attempted, executed: pre.executed });
      await ctx.observe();

      // ── 1. Setup: slide long indices down so positions sit near maintenance ─
      for (const [, hs] of handles) {
        await forcePriceData(f, hs.h, { priceX18: (hs.start * 90n) / 100n, lastUpdatedAt: BigInt(await forkNow(f)) });
      }
      const sSetup = await ctx.observe();
      await ctx.note("setup: long indices slid -10% (approaching maintenance)", {
        ifBalance: sSetup.ifBalance, badDebt: sSetup.badDebt,
      });

      // Identify long positions in the stressed markets.
      const targets: Target[] = [];
      for (const m of stressMarkets) {
        for (const account of ctx.accounts) {
          const pos = (await f.pub.readContract({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "getPosition", args: [account, m.marketId] }).catch(() => null)) as { size: bigint } | null;
          if (!pos || pos.size <= 0n) continue; // longs only
          targets.push({ account, market: m, size: pos.size, cohort: targets.length % 2 === 0 ? "fair" : "adverse" });
        }
      }
      await ctx.note("identified long positions to stress", {
        count: targets.length,
        fair: targets.filter((t) => t.cohort === "fair").length,
        adverse: targets.filter((t) => t.cohort === "adverse").length,
      });

      // ── 2. Outage: halt, then gap the price down during the halt ────────────
      await haltBlockProduction(f);
      await ctx.note("BLOCK PRODUCTION HALTED (outage begins)");

      for (const [, hs] of handles) {
        // -28% from the original start: a hard gap while nobody can act.
        await forcePriceData(f, hs.h, { priceX18: (hs.start * 72n) / 100n, lastUpdatedAt: BigInt(await forkNow(f)), mine: false });
      }
      await ctx.note("index gapped to -28% of start during the outage (no block produced)");

      // Confirm the targets are now liquidatable (reads work during a halt).
      let underwater = 0;
      for (const t of targets) {
        const liq = (await f.pub.readContract({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "isLiquidatable", args: [t.account, t.market.marketId] }).catch(() => false)) as boolean;
        if (liq) underwater++;
      }
      await ctx.note("post-gap: positions now underwater", { liquidatable: underwater, of: targets.length });

      // SAFEGUARD CHECK during the outage: with the chain halted the keeper cannot
      // clear these positions, so the health monitor should report the underwater
      // backlog. This is exactly the state operators need alerted to in real time.
      const outageSignals = await checkHealth(f.pub, newHealthState(), ctx.accounts, ctx.markets);
      await ctx.note("SAFEGUARD CHECK (during outage): health signals", {
        total: outageSignals.length,
        warnings: outageSignals.filter((s) => s.severity === "warning").map((s) => s.key).join(", ") || "none",
        critical: outageSignals.filter((s) => s.severity === "critical").map((s) => s.key).join(", ") || "none",
        liquidatableBacklog: outageSignals.find((s) => s.key === "liquidatable-backlog")?.fields.Count ?? 0,
      });

      // ── 3. Race: queue user closes FIRST (all before the keeper), then keeper ─
      // Users submit in time order ahead of the keeper; fee decides who wins.
      const closeRevertReasons: Record<string, number> = {};
      for (const t of targets) {
        const w = await impersonate(f, t.account);
        const nonce = await f.pub.getTransactionCount({ address: t.account, blockTag: "pending" });
        const priority = t.cohort === "fair" ? FAIR_PRIORITY : ADVERSE_PRIORITY;
        // Record WHY the close would fail (captured now, while the position still
        // exists; after the race it is gone and the reason is unrecoverable).
        try {
          await f.pub.simulateContract({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "closePosition", args: [t.market.marketId, t.size, 0n], account: t.account });
        } catch (e) {
          const x = e as { cause?: { data?: { errorName?: string }; signature?: string } };
          const r = x?.cause?.data?.errorName ?? x?.cause?.signature ?? "unknown";
          closeRevertReasons[r] = (closeRevertReasons[r] ?? 0) + 1;
        }
        try {
          t.closeHash = await w.writeContract({
            address: CONTRACTS.clearingHouse, abi: CH, functionName: "closePosition",
            args: [t.market.marketId, t.size, 0n], // long -> sellBase, min-out 0
            chain: null, account: t.account, nonce, gas: 3_000_000n, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: priority,
          });
        } catch (e) {
          await ctx.note(`queue close failed: ${t.account.slice(0, 10)} ${t.market.name}`, { err: (e as Error).message.split("\n")[0] });
        }
      }
      await ctx.note("queued user closePosition txs (all submitted before the keeper)", {
        submitted: targets.filter((t) => t.closeHash).length,
        closeWouldRevertWith: JSON.stringify(closeRevertReasons),
      });

      // Keeper submits liquidations AFTER every user close is already in the pool.
      const keeper = await impersonate(f, KEEPER_ADDRESS);
      let kNonce = await f.pub.getTransactionCount({ address: KEEPER_ADDRESS, blockTag: "pending" });
      for (const t of targets) {
        try {
          t.liqHash = await keeper.writeContract({
            address: CONTRACTS.clearingHouse, abi: CH, functionName: "liquidate",
            args: [t.account, t.market.marketId, t.size, 0n],
            chain: null, account: KEEPER_ADDRESS, nonce: kNonce, gas: 3_000_000n, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: KEEPER_PRIORITY,
          });
          kNonce++;
        } catch (e) {
          await ctx.note(`queue liquidate failed: ${t.account.slice(0, 10)} ${t.market.name}`, { err: (e as Error).message.split("\n")[0] });
        }
      }
      await ctx.note("queued keeper liquidate txs (submitted last, into the same pool)", {
        submitted: targets.filter((t) => t.liqHash).length,
        keeperPriorityGwei: Number(KEEPER_PRIORITY / GWEI),
        fairUserPriorityGwei: Number(FAIR_PRIORITY / GWEI),
        adverseUserPriorityGwei: Number(ADVERSE_PRIORITY / GWEI),
      });

      // ── 4. Resume: release the backlog ──────────────────────────────────────
      const released = await resumeBlockProduction(f);
      await ctx.note("BLOCK PRODUCTION RESUMED (outage ends)", { queuedTxReleased: released.released });
      const sResume = await ctx.observe();

      // Reconstruct execution order and per-account outcome from receipts.
      const rcpt = async (h?: Hex) => (h ? await f.pub.getTransactionReceipt({ hash: h }).catch(() => null) : null);
      const rows: string[] = [];
      let usersExited = 0, usersLiquidated = 0, fairLiquidated = 0, adverseLiquidated = 0;
      for (const t of targets) {
        const c = await rcpt(t.closeHash);
        const l = await rcpt(t.liqHash);
        const closeOk = c?.status === "success";
        const liqOk = l?.status === "success";
        const outcome = liqOk ? "LIQUIDATED" : closeOk ? "exited" : "neither";
        if (liqOk) { usersLiquidated++; if (t.cohort === "fair") fairLiquidated++; else adverseLiquidated++; }
        else if (closeOk) usersExited++;
        rows.push(
          `${t.cohort.padEnd(7)} ${t.account.slice(0, 10)} ${t.market.name.padEnd(14)} ` +
          `closeBlk=${c ? `${c.blockNumber}:${c.transactionIndex}(${c.status})` : "-"} ` +
          `liqBlk=${l ? `${l.blockNumber}:${l.transactionIndex}(${l.status})` : "-"} -> ${outcome}`,
        );
      }
      await ctx.note("RACE OUTCOME", {
        usersExited, usersLiquidated,
        fairCohortLiquidated: `${fairLiquidated}/${targets.filter((t) => t.cohort === "fair").length}`,
        adverseCohortLiquidated: `${adverseLiquidated}/${targets.filter((t) => t.cohort === "adverse").length}`,
      });
      for (const r of rows) await ctx.note(`  ${r}`);

      // ── Alert/safeguard demonstration against the stressed state ────────────
      const signals = await checkHealth(f.pub, newHealthState(), ctx.accounts, ctx.markets);
      await ctx.note("SAFEGUARD CHECK: health signals that would fire", {
        total: signals.length,
        critical: signals.filter((s) => s.severity === "critical").map((s) => s.key).join(", ") || "none",
        warning: signals.filter((s) => s.severity === "warning").map((s) => s.key).join(", ") || "none",
      });

      await ctx.note("post-resume state", {
        ifBalance: sResume.ifBalance, ifTotalPaid: sResume.ifTotalPaid, badDebt: sResume.badDebt,
      });

      // Mop-up: keeper clears anyone still liquidatable after the race.
      const mop = await ctx.runKeeper();
      await ctx.note("post-resume keeper mop-up sweep", { detected: mop.attempted, executed: mop.executed, reasons: JSON.stringify(mop.revertReasons) });
      await ctx.observe();
    },
  };
}
