// F-1: USDC depeg.
//
// Method: step the USDC price feed down in stages and observe how the loss
// waterfall responds at each level.
//
// Why this propagates: collateral is oracle-priced, not assumed 1:1. The vault
// values deposits through getTokenValueX18 (oracle price less a 100 bps haircut),
// and ClearingHouse._isLiquidatable recomputes margin from real-time collateral
// value expressly so "a depeg of the quote token triggers liquidation instead of
// being masked by a stale nominal position.margin value". A depeg therefore
// reduces every account's margin simultaneously, which is what makes it a
// correlated, system-wide stress rather than an idiosyncratic one.
import { parseAbi, parseUnits, formatUnits } from "viem";
import type { Address } from "viem";
import type { ScenarioDef, ScenarioContext } from "../scenario";
import { impersonate } from "../fork";
import { deployMockPriceFeed, MOCK_FEED_ABI } from "../mocks";
import { resolveCollateral, readCollateralValue } from "../inject";
import CH_ARTIFACT from "../../../../overhaul/src/contracts/abis/ClearingHouse.json";
import { CONTRACTS } from "../../config/addresses";
import { MARKETS } from "../../config/markets";

const FEED_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const VAULT_ABI = parseAbi(["function balanceOf(address,address) view returns (uint256)"]);
const COLL_ORACLE_ABI = parseAbi([
  "function owner() view returns (address)",
  "function priceFeeds(string) view returns (address)",
  "function setPriceFeed(string,address)",
]);

/** Depeg path, as a fraction of $1. Ends below the 100 bps haircut buffer by a
 *  wide margin so we can locate the point at which the book actually breaks. */
const CH_ABI = CH_ARTIFACT.abi as unknown as ReturnType<typeof parseAbi>;

// Extends well past a plausible depeg deliberately: the object is to LOCATE the
// level at which the book actually breaks, not merely to confirm it survives a
// mild one. Stopping at $0.75 showed resilience but never found the boundary.
const PEG_STEPS = [0.99, 0.97, 0.95, 0.90, 0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25];

export function depegScenario(marketNames: string[], accounts: readonly Address[]): ScenarioDef {
  const markets = MARKETS.filter((m) => marketNames.includes(m.name));
  return {
    id: "f1-usdc-depeg",
    title: "F-1: USDC Depeg",
    objective:
      "Step the USDC collateral price down from parity to $0.75 and observe the protocol's response at each level: " +
      "the depeg depth at which the collateral haircut is exhausted and positions become liquidatable, whether the " +
      "liquidation engine keeps pace with a correlated system-wide margin reduction, and whether resulting losses " +
      "are absorbed by the InsuranceFund or recorded as uncovered bad debt.",
    markets,
    accounts,
    run: async (ctx: ScenarioContext) => {
      const c = await resolveCollateral(ctx.f, CONTRACTS.collateralVault, CONTRACTS.usdc);
      const oneUsdc = parseUnits("1", 6);

      // The live USDC feed is a real Chainlink aggregator proxy with no settable
      // answer, so we substitute a Chainlink-compatible mock seeded to the CURRENT
      // live price and repoint the oracle through its own setPriceFeed admin
      // function. The protocol reads it through exactly the same code path.
      const feedDecimals = Number(await ctx.f.pub.readContract({ address: c.feed, abi: FEED_ABI, functionName: "decimals" }));
      const round = (await ctx.f.pub.readContract({ address: c.feed, abi: FEED_ABI, functionName: "latestRoundData" })) as readonly [bigint, bigint, bigint, bigint, bigint];
      const startPrice = round[1];
      const parity = 10n ** BigInt(feedDecimals);

      await ctx.note("resolved live collateral feed", {
        feed: c.feed, symbol: c.symbol, decimals: feedDecimals,
        livePrice: startPrice.toString(), haircutBps: c.haircutBps,
        collateralValuePerUsdc: formatUnits(await readCollateralValue(ctx.f, c, oneUsdc), 18),
      });

      const mock = await deployMockPriceFeed(ctx.f, feedDecimals, startPrice, "USDC / USD (stress mock)");
      const oracleOwner = (await ctx.f.pub.readContract({ address: c.oracle, abi: COLL_ORACLE_ABI, functionName: "owner" })) as Address;
      const oracleAdmin = await impersonate(ctx.f, oracleOwner);
      const swap = await oracleAdmin.writeContract({
        address: c.oracle, abi: COLL_ORACLE_ABI, functionName: "setPriceFeed",
        args: [c.symbol, mock], chain: null, account: oracleOwner,
      });
      await ctx.f.pub.waitForTransactionReceipt({ hash: swap });
      await ctx.note("substituted controllable feed via Oracle.setPriceFeed", {
        mock, seededAt: startPrice.toString(),
        collateralValuePerUsdc: formatUnits(await readCollateralValue(ctx.f, c, oneUsdc), 18),
      });

      // Clear inherited liquidatable positions so the scenario measures its own effect.
      const pre = await ctx.runKeeper();
      await ctx.note("pre-scenario keeper sweep", { detected: pre.attempted, executed: pre.executed, reasons: JSON.stringify(pre.revertReasons) });
      await ctx.observe();

      // PHASE SETUP: bring accounts to a realistic collateralisation ratio.
      //
      // The depeg only reduces margin when an account's WHOLE vault balance is
      // worth less than its reserved margin:
      //     if (vaultValueX18 < reserved) margin *= vaultValueX18 / reserved
      // The simulated agents hold ~1,000 USDC against margins of ~5-45 USDC, so
      // they are 20-200x over-collateralised and the path never activates. Real
      // users do not park 100x their margin in the vault, so we withdraw the
      // excess from a subset of accounts to obtain a realistically-margined book.
      // Both regimes are then measured, and reported separately.
      const tightened: string[] = [];
      const blocked: string[] = [];
      for (const account of ctx.accounts) {
        const reserved = (await ctx.f.pub.readContract({
          address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "_totalReservedMargin", args: [account],
        }).catch(() => 0n)) as bigint;
        if (reserved === 0n) continue;

        const bal = (await ctx.f.pub.readContract({
          address: CONTRACTS.collateralVault, abi: VAULT_ABI, functionName: "balanceOf", args: [account, CONTRACTS.usdc],
        }).catch(() => 0n)) as bigint;
        if (bal === 0n) continue;

        // Target vault balance ~= 1.05x reserved margin (reserved is x18, USDC is 6dp).
        const targetBal = (reserved / 10n ** 12n) * 105n / 100n;
        if (bal <= targetBal) continue;

        const w2 = await impersonate(ctx.f, account as Address);
        try {
          const h = await w2.writeContract({
            address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "withdraw",
            args: [CONTRACTS.usdc, bal - targetBal], chain: null, account: account as Address,
          });
          const rcpt = await ctx.f.pub.waitForTransactionReceipt({ hash: h });
          // Verify by reading the balance back. A mined-but-reverted withdrawal
          // would otherwise be recorded as success and the whole scenario would
          // silently run against an over-collateralised book.
          const after = (await ctx.f.pub.readContract({
            address: CONTRACTS.collateralVault, abi: VAULT_ABI, functionName: "balanceOf", args: [account, CONTRACTS.usdc],
          })) as bigint;
          if (rcpt.status === "success" && after < bal) {
            tightened.push(`${account.slice(0, 10)}:${formatUnits(bal, 6)}->${formatUnits(after, 6)}`);
          } else {
            blocked.push(`${account.slice(0, 10)}:status=${rcpt.status},bal=${formatUnits(after, 6)}`);
          }
        } catch (e) {
          blocked.push(`${account.slice(0, 10)}:${e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message.split("\n")[0] : "err"}`);
        }
      }
      await ctx.note("collateral tightened to realistic ratios", {
        tightened: tightened.length, blocked: blocked.length,
        detail: tightened.join(" "), blockedDetail: blocked.slice(0, 6).join(" "),
      });
      const tight = await ctx.runKeeper();
      await ctx.note("post-tightening keeper sweep (pre-depeg baseline)", {
        detected: tight.attempted, executed: tight.executed,
      });
      await ctx.observe();

      const feedAdmin = CONTRACTS.treasury as Address;
      const w = await impersonate(ctx.f, feedAdmin);

      for (const [i, frac] of PEG_STEPS.entries()) {
        const target = (parity * BigInt(Math.round(frac * 10_000))) / 10_000n;
        const hash = await w.writeContract({
          address: mock, abi: MOCK_FEED_ABI, functionName: "setAnswer", args: [target],
          chain: null, account: feedAdmin,
        });
        await ctx.f.pub.waitForTransactionReceipt({ hash });

        const value = await readCollateralValue(ctx.f, c, oneUsdc);
        await ctx.note(`step ${i + 1}/${PEG_STEPS.length}: USDC peg -> $${frac.toFixed(2)}`, {
          feedPrice: target.toString(),
          collateralValuePerUsdc: formatUnits(value, 18),
        });

        const s = await ctx.observe();
        const k = await ctx.runKeeper();
        await ctx.note(`step ${i + 1}: keeper detected ${k.attempted}, executed ${k.executed}`, {
          peg: frac,
          ifBalance: s.ifBalance,
          ifTotalPaid: s.ifTotalPaid,
          badDebt: s.badDebt,
          reasons: JSON.stringify(k.revertReasons),
        });
      }

      // Repeg: restore parity and observe whether the system returns to a stable state.
      const restore = await w.writeContract({
        address: mock, abi: MOCK_FEED_ABI, functionName: "setAnswer", args: [startPrice],
        chain: null, account: feedAdmin,
      });
      await ctx.f.pub.waitForTransactionReceipt({ hash: restore });
      await ctx.note("repeg: USDC restored to starting price", {
        collateralValuePerUsdc: formatUnits(await readCollateralValue(ctx.f, c, oneUsdc), 18),
      });
      await ctx.observe();
      const post = await ctx.runKeeper();
      await ctx.note("post-repeg keeper sweep", { detected: post.attempted, executed: post.executed });
      await ctx.observe();
    },
  };
}
