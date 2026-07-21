// F-5: Index provider failure.
//
// The index feed is consumed through CuOracleAdapter, which fails CLOSED:
//   getPrice() reverts on a zero price, and reverts once the price is older than
//   the adapter's immutable maxAge (43,200s = 12h on every deployed market).
//
// Failing closed is the safe choice, but it raises the question this scenario
// exists to answer: what does a market DO once its oracle refuses to serve?
// Three phases, in increasing severity:
//
//   Phase 1  staleness INSIDE the window  - the exposure window. The feed is
//            frozen but still served, so trading, funding and liquidation all
//            proceed against a price that is up to 12 hours old.
//   Phase 2  staleness BEYOND the window  - the guard trips. We then check
//            whether users can still EXIT. A guard that also blocks position
//            closure converts a safety mechanism into a liveness trap.
//   Phase 3  recovery                     - the feed returns; does the market
//            resume cleanly?
import { parseAbi } from "viem";
import type { Address } from "viem";
import type { ScenarioDef, ScenarioContext } from "../scenario";
import { resolveIndex, readIndex, indexServes, findPriceSlot, forcePriceData } from "../inject";
import { forkNow } from "../fork";
import type { IndexHandle } from "../inject";
import CH_ARTIFACT from "../../../../overhaul/src/contracts/abis/ClearingHouse.json";
import { CONTRACTS } from "../../config/addresses";
import { MARKETS } from "../../config/markets";

const MR = parseAbi([
  "function getMarket(bytes32) view returns ((address vamm, uint16 feeBps, bool paused, address oracle, address feeRouter, address insuranceFund, address baseAsset, address quoteToken, uint256 baseUnit))",
]);
const CH_ABI = CH_ARTIFACT.abi as unknown as ReturnType<typeof parseAbi>;

/** Can this account still close its position? The critical Phase 2 question. */
async function canExit(
  ctx: ScenarioContext, account: Address, marketId: `0x${string}`, size: bigint, isLong: boolean,
): Promise<{ ok: boolean; reason: string }> {
  try {
    await ctx.f.pub.simulateContract({
      address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "closePosition",
      args: [marketId, size, isLong ? 0n : (2n ** 256n - 1n)], account,
    });
    return { ok: true, reason: "" };
  } catch (e) {
    const err = e as { cause?: { data?: { errorName?: string }; signature?: string }; shortMessage?: string };
    return { ok: false, reason: err?.cause?.data?.errorName ?? err?.cause?.signature ?? err?.shortMessage?.split("\n")[0] ?? "unknown" };
  }
}

export function indexFailureScenario(marketNames: string[], accounts: readonly Address[]): ScenarioDef {
  const markets = MARKETS.filter((m) => marketNames.includes(m.name));
  return {
    id: "f5-index-provider-failure",
    title: "F-5: Index Provider Failure",
    objective:
      "Freeze the index feed and observe protocol behaviour across three regimes: while the stale price is still " +
      "inside the adapter's 12-hour tolerance and therefore still served; once staleness exceeds that tolerance and " +
      "the adapter fails closed; and on recovery. The central question is whether a market whose oracle has stopped " +
      "serving still permits users to exit existing positions, or whether the safety guard also traps them.",
    markets,
    accounts,
    run: async (ctx: ScenarioContext) => {
      const handles = new Map<string, { h: IndexHandle; market: typeof markets[number] }>();
      for (const m of markets) {
        const cfg = (await ctx.f.pub.readContract({
          address: CONTRACTS.marketRegistry, abi: MR, functionName: "getMarket", args: [m.marketId],
        })) as { oracle: Address };
        const h = await resolveIndex(ctx.f, cfg.oracle);
        await findPriceSlot(ctx.f, h); // discover while a valid price is readable
        const { price, lastUpdatedAt } = await readIndex(ctx.f, h);
        handles.set(m.name, { h, market: m });
        await ctx.note(`index resolved: ${m.name}`, {
          price: price.toString(),
          ageMin: Math.round((Date.now() / 1000 - Number(lastUpdatedAt)) / 60),
          maxAgeHours: Number(h.maxAge) / 3600,
        });
      }

      const pre = await ctx.runKeeper();
      await ctx.note("pre-scenario keeper sweep", { detected: pre.attempted, executed: pre.executed });
      await ctx.observe();

      // Pick a market with open positions to probe exit-ability against.
      const probe = markets[0]!;
      const probeHandle = handles.get(probe.name)!.h;

      // ── PHASE 1: stale but INSIDE the tolerance window ────────────────────
      for (const hours of [3, 6, 11]) {
        for (const [, { h }] of handles) {
          await forcePriceData(ctx.f, h, { lastUpdatedAt: BigInt(await forkNow(ctx.f) - hours * 3600) });
        }
        const serving = await indexServes(ctx.f, probeHandle);
        const s = await ctx.observe();
        const k = await ctx.runKeeper();
        await ctx.note(`phase 1: index frozen ${hours}h (inside ${Number(probeHandle.maxAge) / 3600}h tolerance)`, {
          adapterServing: serving,
          liquidatableDetected: k.attempted,
          liquidationsExecuted: k.executed,
          ifBalance: s.ifBalance,
          badDebt: s.badDebt,
        });
      }

      // ── PHASE 2: staleness BEYOND tolerance — the guard trips ─────────────
      for (const [, { h }] of handles) {
        await forcePriceData(ctx.f, h, { lastUpdatedAt: BigInt(await forkNow(ctx.f) - 13 * 3600) });
      }
      const servingAfter = await indexServes(ctx.f, probeHandle);
      await ctx.note("phase 2: index aged to 13h (BEYOND tolerance)", { adapterServing: servingAfter });
      const s2 = await ctx.observe();

      // Can the keeper still liquidate when the oracle is down?
      const k2 = await ctx.runKeeper();
      await ctx.note("phase 2: liquidation path with oracle down", {
        detected: k2.attempted, executed: k2.executed, reasons: JSON.stringify(k2.revertReasons),
        ifBalance: s2.ifBalance,
      });

      // THE KEY TEST: can holders still exit?
      let exitable = 0, trapped = 0;
      const trapReasons: Record<string, number> = {};
      for (const account of ctx.accounts) {
        for (const m of markets) {
          const pos = (await ctx.f.pub.readContract({
            address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "getPosition", args: [account, m.marketId],
          }).catch(() => null)) as { size: bigint } | null;
          if (!pos?.size) continue;
          const abs = pos.size > 0n ? pos.size : -pos.size;
          const r = await canExit(ctx, account, m.marketId, abs, pos.size > 0n);
          if (r.ok) exitable++;
          else { trapped++; trapReasons[r.reason] = (trapReasons[r.reason] ?? 0) + 1; }
        }
      }
      await ctx.note("phase 2: CAN USERS EXIT with the oracle failing closed?", {
        exitable, trapped, reasons: JSON.stringify(trapReasons),
      });

      // ── PHASE 3: recovery ────────────────────────────────────────────────
      for (const [, { h }] of handles) {
        await forcePriceData(ctx.f, h, { lastUpdatedAt: BigInt(await forkNow(ctx.f)) });
      }
      const servingRecovered = await indexServes(ctx.f, probeHandle);
      await ctx.note("phase 3: feed restored", { adapterServing: servingRecovered });
      await ctx.observe();
      const k3 = await ctx.runKeeper();
      await ctx.note("phase 3: post-recovery keeper sweep", { detected: k3.attempted, executed: k3.executed });
      await ctx.observe();
    },
  };
}
