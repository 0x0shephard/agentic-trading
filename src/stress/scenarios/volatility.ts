// High-volatility stress on a low timeframe.
//
// Method: drive the index through the production commit/reveal path in a rapid
// sequence of large steps, sampling protocol state after each and running the
// liquidation keeper between steps.
//
// Rationale for driving the INDEX rather than the mark: liquidation uses a
// conservative price, min(riskPrice, markPrice) for longs and max(...) for
// shorts, where riskPrice derives from the oracle. Moving the index therefore
// exercises the margin and liquidation path directly, and simultaneously opens a
// mark-to-index basis, which is the second thing we want to observe.
import type { Address } from "viem";
import { parseAbi } from "viem";
import type { ScenarioDef, ScenarioContext } from "../scenario";
import { resolveIndex, readIndex, commitRevealPrice, findPriceSlot } from "../inject";
import type { IndexHandle } from "../inject";
import { CONTRACTS } from "../../config/addresses";
import { MARKETS } from "../../config/markets";
import type { MarketDef } from "../../config/markets";

const MR = parseAbi([
  "function getMarket(bytes32) view returns ((address vamm, uint16 feeBps, bool paused, address oracle, address feeRouter, address insuranceFund, address baseAsset, address quoteToken, uint256 baseUnit))",
]);

/** Step sequence as multipliers on the starting index, applied in order.
 *  Deliberately asymmetric and sharp: a smooth walk would not stress margin. */
const STEPS = [0.92, 0.85, 0.95, 0.78, 0.70, 0.82, 0.95, 1.05];

export function volatilityScenario(marketNames: string[], accounts: readonly Address[]): ScenarioDef {
  const markets = MARKETS.filter((m) => marketNames.includes(m.name));
  return {
    id: "volatility-lowtf",
    title: "High-Volatility Stress (Low Timeframe)",
    objective:
      "Drive the index price through a rapid sequence of large adverse steps and observe protocol behaviour: " +
      "whether margin and liquidation engage correctly under fast repricing, whether liquidations cluster into a " +
      "cascade, how far the mark-to-index basis dislocates, and whether losses are absorbed by the InsuranceFund " +
      "or recorded as bad debt.",
    markets,
    accounts,
    run: async (ctx: ScenarioContext) => {
      // Resolve each market's oracle chain up front, and discover the storage slot
      // while prices are still valid (discovery matches on the live price).
      const handles = new Map<string, { h: IndexHandle; start: bigint; market: MarketDef }>();
      for (const m of markets) {
        const cfg = (await ctx.f.pub.readContract({
          address: CONTRACTS.marketRegistry, abi: MR, functionName: "getMarket", args: [m.marketId],
        })) as { oracle: Address };
        const h = await resolveIndex(ctx.f, cfg.oracle);
        await findPriceSlot(ctx.f, h).catch(() => 0n);
        const { price } = await readIndex(ctx.f, h);
        handles.set(m.name, { h, start: price, market: m });
        await ctx.note(`resolved index for ${m.name}`, { startPrice: price.toString(), maxAgeSec: h.maxAge.toString() });
      }

      // Clear any pre-existing liquidatable positions so the scenario measures
      // what IT caused, not a backlog inherited from live state.
      const pre = await ctx.runKeeper();
      await ctx.note("pre-scenario keeper sweep (clears inherited liquidatable positions)", {
        detected: pre.attempted, executed: pre.executed,
      });
      await ctx.observe();

      for (const [i, mult] of STEPS.entries()) {
        for (const [name, { h, start }] of handles) {
          const target = (start * BigInt(Math.round(mult * 10_000))) / 10_000n;
          try {
            await commitRevealPrice(ctx.f, h, target);
            await ctx.note(`step ${i + 1}/${STEPS.length}: ${name} index -> ${(mult * 100).toFixed(0)}% of start`, {
              price: target.toString(),
            });
          } catch (e) {
            await ctx.note(`step ${i + 1}: ${name} index update FAILED`, {
              err: e instanceof Error ? e.message.split("\n")[0] : String(e),
            });
          }
        }

        const s = await ctx.observe();
        const k = await ctx.runKeeper();
        if (k.attempted > 0) {
          await ctx.note(`step ${i + 1}: keeper found ${k.attempted} liquidatable, executed ${k.executed}`, {
            ifBalance: s.ifBalance, badDebt: s.badDebt,
          });
        }
      }

      // Recovery leg: return the index to its starting level and observe whether
      // the book stabilises and the basis re-converges.
      for (const [name, { h, start }] of handles) {
        await commitRevealPrice(ctx.f, h, start).catch(() => { /* recorded below */ });
        await ctx.note(`recovery: ${name} index restored to start`);
      }
      await ctx.observe();
      const post = await ctx.runKeeper();
      await ctx.note("post-recovery keeper sweep", { detected: post.attempted, executed: post.executed });
      await ctx.observe();
    },
  };
}
