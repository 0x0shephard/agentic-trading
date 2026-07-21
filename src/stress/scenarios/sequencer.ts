// F-2: Sequencer outage during a volatile period.
//
// IMPORTANT SCOPE NOTE. The protocol is deployed on Ethereum Sepolia, an L1 with
// no sequencer, so a literal sequencer outage cannot occur today. The scenario is
// therefore run in two parts that together cover the underlying risk:
//
//   PART A  the guard. Oracle.sol implements the Chainlink L2 uptime pattern
//           (answer != 0 -> SequencerDown; a 1h grace period after recovery;
//           a reverting feed also treated as down). It is present but INACTIVE
//           on the live deployment: sequencerUptimeFeed is address(0), so the
//           check is skipped entirely. We wire a mock feed and exercise it,
//           which validates the mechanism that would protect an L2 deployment.
//
//   PART B  chain liveness. Block production is halted while the index moves,
//           then resumed. This models the part that actually causes damage: the
//           market repricing while users cannot act, and the backlog landing at
//           once on recovery.
//
// Note the guard sits on the COLLATERAL oracle only. The index adapters
// (CuOracleAdapter) have no sequencer check, so the two price paths degrade
// differently. That asymmetry is measured here.
import { parseAbi } from "viem";
import type { Address } from "viem";
import type { ScenarioDef, ScenarioContext } from "../scenario";
import { impersonate, forkNow, haltBlockProduction, resumeBlockProduction, mine } from "../fork";
import { deployMockUptimeFeed, MOCK_UPTIME_ABI } from "../mocks";
import { resolveCollateral, readCollateralValue, resolveIndex, findPriceSlot, forcePriceData, readIndex, indexServes } from "../inject";
import CH_ARTIFACT from "../../../../overhaul/src/contracts/abis/ClearingHouse.json";
import { CONTRACTS } from "../../config/addresses";
import { MARKETS } from "../../config/markets";

const CH_ABI = CH_ARTIFACT.abi as unknown as ReturnType<typeof parseAbi>;
const MR = parseAbi([
  "function getMarket(bytes32) view returns ((address vamm, uint16 feeBps, bool paused, address oracle, address feeRouter, address insuranceFund, address baseAsset, address quoteToken, uint256 baseUnit))",
]);
const ORACLE_ABI = parseAbi([
  "function owner() view returns (address)",
  "function sequencerUptimeFeed() view returns (address)",
  "function setSequencerUptimeFeed(address)",
  "function getPrice(string) view returns (uint256)",
]);

const GRACE_PERIOD_SEC = 3600; // Oracle.SEQUENCER_GRACE_PERIOD

/** Does collateral valuation still work? Reverts once the guard trips. */
async function collateralPrices(ctx: ScenarioContext, oracle: Address, symbol: string): Promise<{ ok: boolean; reason: string }> {
  try {
    await ctx.f.pub.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "getPrice", args: [symbol] });
    return { ok: true, reason: "" };
  } catch (e) {
    const err = e as { cause?: { data?: { errorName?: string }; signature?: string }; shortMessage?: string };
    return { ok: false, reason: err?.cause?.data?.errorName ?? err?.cause?.signature ?? err?.shortMessage?.split("\n")[0] ?? "unknown" };
  }
}

/** How many open positions can still be closed right now? */
async function exitability(ctx: ScenarioContext): Promise<{ exitable: number; trapped: number; reasons: Record<string, number> }> {
  let exitable = 0, trapped = 0;
  const reasons: Record<string, number> = {};
  for (const account of ctx.accounts) {
    for (const m of ctx.markets) {
      const pos = (await ctx.f.pub.readContract({
        address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "getPosition", args: [account, m.marketId],
      }).catch(() => null)) as { size: bigint } | null;
      if (!pos?.size) continue;
      const abs = pos.size > 0n ? pos.size : -pos.size;
      try {
        await ctx.f.pub.simulateContract({
          address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "closePosition",
          args: [m.marketId, abs, pos.size > 0n ? 0n : 2n ** 256n - 1n], account,
        });
        exitable++;
      } catch (e) {
        trapped++;
        const err = e as { cause?: { data?: { errorName?: string }; signature?: string } };
        const r = err?.cause?.data?.errorName ?? err?.cause?.signature ?? "unknown";
        reasons[r] = (reasons[r] ?? 0) + 1;
      }
    }
  }
  return { exitable, trapped, reasons };
}

export function sequencerScenario(marketNames: string[], accounts: readonly Address[]): ScenarioDef {
  const markets = MARKETS.filter((m) => marketNames.includes(m.name));
  return {
    id: "f2-sequencer-outage",
    title: "F-2: Sequencer Outage During a Volatile Period",
    objective:
      "Exercise the protocol's sequencer-uptime guard and its behaviour under a chain-liveness interruption. " +
      "Part A wires a mock Chainlink uptime feed and drives it down, through the post-recovery grace period, and " +
      "back to healthy, measuring at each stage whether collateral valuation, liquidation and position exit remain " +
      "available. Part B halts block production while the index reprices, then resumes and measures the backlog " +
      "released and any liquidation burst. The deployment is on an L1 with no sequencer, so Part A validates a " +
      "mechanism that is currently inactive and would apply to an L2 deployment.",
    markets,
    accounts,
    run: async (ctx: ScenarioContext) => {
      const c = await resolveCollateral(ctx.f, CONTRACTS.collateralVault, CONTRACTS.usdc);
      const oneUsdc = 1_000_000n;

      const wiredBefore = (await ctx.f.pub.readContract({
        address: c.oracle, abi: ORACLE_ABI, functionName: "sequencerUptimeFeed",
      })) as Address;
      await ctx.note("baseline: sequencer guard configuration on the live deployment", {
        collateralOracle: c.oracle,
        sequencerUptimeFeed: wiredBefore,
        guardActive: wiredBefore !== "0x0000000000000000000000000000000000000000",
        collateralValuePerUsdc: (await readCollateralValue(ctx.f, c, oneUsdc)).toString(),
      });
      await ctx.observe();

      // ── PART A: the uptime guard ─────────────────────────────────────────
      const uptime = await deployMockUptimeFeed(ctx.f);
      const oracleOwner = (await ctx.f.pub.readContract({ address: c.oracle, abi: ORACLE_ABI, functionName: "owner" })) as Address;
      const admin = await impersonate(ctx.f, oracleOwner);
      const wire = await admin.writeContract({
        address: c.oracle, abi: ORACLE_ABI, functionName: "setSequencerUptimeFeed",
        args: [uptime], chain: null, account: oracleOwner,
      });
      await ctx.f.pub.waitForTransactionReceipt({ hash: wire });

      // Sequencer UP, and well past the grace period.
      const feedAdmin = await impersonate(ctx.f, CONTRACTS.treasury as Address);
      const setStatus = async (answer: bigint, startedAtOffsetSec: number): Promise<void> => {
        const h = await feedAdmin.writeContract({
          address: uptime, abi: MOCK_UPTIME_ABI, functionName: "setStatus",
          args: [answer, BigInt(await forkNow(ctx.f) - startedAtOffsetSec)],
          chain: null, account: CONTRACTS.treasury as Address,
        });
        await ctx.f.pub.waitForTransactionReceipt({ hash: h });
      };

      await setStatus(0n, GRACE_PERIOD_SEC * 2); // up, grace long expired
      const healthy = await collateralPrices(ctx, c.oracle, c.symbol);
      await ctx.note("A1: uptime feed wired, sequencer UP (grace expired)", {
        uptimeFeed: uptime, collateralPricing: healthy.ok ? "ok" : healthy.reason,
      });
      await ctx.observe();

      // Sequencer DOWN.
      await setStatus(1n, 60);
      const down = await collateralPrices(ctx, c.oracle, c.symbol);
      const downExit = await exitability(ctx);
      const downKeeper = await ctx.runKeeper();
      // Index path is separately checked: CuOracleAdapter has no sequencer guard.
      const idx = await resolveIndex(ctx.f, ((await ctx.f.pub.readContract({
        address: CONTRACTS.marketRegistry, abi: MR, functionName: "getMarket", args: [markets[0]!.marketId],
      })) as { oracle: Address }).oracle);
      await ctx.note("A2: sequencer DOWN", {
        collateralPricing: down.ok ? "ok" : down.reason,
        indexPricingStillServes: await indexServes(ctx.f, idx),
        exitable: downExit.exitable, trapped: downExit.trapped, exitReasons: JSON.stringify(downExit.reasons),
        liquidatableDetected: downKeeper.attempted, liquidationsExecuted: downKeeper.executed,
      });
      await ctx.observe();

      // Sequencer back UP but inside the 1h grace period.
      await setStatus(0n, 60);
      const grace = await collateralPrices(ctx, c.oracle, c.symbol);
      const graceExit = await exitability(ctx);
      await ctx.note("A3: sequencer recovered, INSIDE 1h grace period", {
        collateralPricing: grace.ok ? "ok" : grace.reason,
        exitable: graceExit.exitable, trapped: graceExit.trapped,
      });
      await ctx.observe();

      // Grace period elapsed.
      await setStatus(0n, GRACE_PERIOD_SEC + 120);
      const recovered = await collateralPrices(ctx, c.oracle, c.symbol);
      const recoveredExit = await exitability(ctx);
      await ctx.note("A4: grace period elapsed", {
        collateralPricing: recovered.ok ? "ok" : recovered.reason,
        exitable: recoveredExit.exitable, trapped: recoveredExit.trapped,
      });
      await ctx.observe();

      // Restore the deployment's original (unwired) configuration.
      const unwire = await admin.writeContract({
        address: c.oracle, abi: ORACLE_ABI, functionName: "setSequencerUptimeFeed",
        args: [wiredBefore], chain: null, account: oracleOwner,
      });
      await ctx.f.pub.waitForTransactionReceipt({ hash: unwire });
      await ctx.note("A5: uptime feed restored to original configuration", { restoredTo: wiredBefore });

      // ── PART B: chain liveness interruption during a repricing ───────────
      const idxHandle = idx;
      await findPriceSlot(ctx.f, idxHandle);
      const before = await readIndex(ctx.f, idxHandle);

      await haltBlockProduction(ctx.f);
      await ctx.note("B1: block production HALTED — users cannot transact");

      // The market reprices while nobody can act. Storage writes bypass the
      // mempool, which is precisely the point: price moves, users are stuck.
      const crashed = (before.price * 70n) / 100n; // -30%
      await forcePriceData(ctx.f, idxHandle, { priceX18: crashed, lastUpdatedAt: BigInt(await forkNow(ctx.f)) });
      await ctx.note("B2: index repriced -30% during the outage", {
        from: before.price.toString(), to: crashed.toString(),
      });

      const released = await resumeBlockProduction(ctx.f);
      await mine(ctx.f, 1);
      await ctx.note("B3: block production RESUMED", { queuedTransactionsReleased: released.released });
      const sAfter = await ctx.observe();

      const burst = await ctx.runKeeper();
      await ctx.note("B4: post-recovery keeper sweep (liquidation burst)", {
        detected: burst.attempted, executed: burst.executed,
        reasons: JSON.stringify(burst.revertReasons),
        ifBalance: sAfter.ifBalance, badDebt: sAfter.badDebt,
      });
      await ctx.observe();

      // Restore the index so the scenario leaves a comparable end state.
      await forcePriceData(ctx.f, idxHandle, { priceX18: before.price, lastUpdatedAt: BigInt(await forkNow(ctx.f)) });
      await ctx.observe();
    },
  };
}
