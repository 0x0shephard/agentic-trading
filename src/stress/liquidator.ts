// Liquidation keeper for the stress scenarios.
//
// WHY THIS EXISTS: ClearingHouse.liquidate() is gated by onlyWhitelistedLiquidator,
// so liquidation is NOT permissionless. Without a keeper actively calling it,
// underwater positions simply persist: a scenario would then report zero
// liquidations and inflated bad debt, understating cascade risk and overstating
// loss. Every Appendix F scenario therefore runs with this keeper alongside.
//
// The keeper is whitelisted on the fork via impersonated admin. That call cannot
// execute off-fork (see fork.ts safety model), so this module can never alter the
// live whitelist.
import { parseAbi, maxUint256 } from "viem";
import type { Address } from "viem";
import type { ForkClients } from "./fork";
import { impersonate } from "./fork";
import { CONTRACTS } from "../config/addresses";
import type { MarketDef } from "../config/markets";
import { logger } from "../logging/logger";

// Full deployed ABI, not a hand-written subset: it carries the contract's 49
// custom error definitions, without which viem cannot decode a revert and every
// failure reports only an undecoded selector.
import CH_ARTIFACT from "../../../overhaul/src/contracts/abis/ClearingHouse.json";
const CH_ABI = CH_ARTIFACT.abi as unknown as ReturnType<typeof parseAbi>;

/** Synthetic keeper. Impersonated, so no key is ever held for it.
 *  Lower-case: viem rejects mixed-case addresses that fail EIP-55 checksum. */
export const KEEPER_ADDRESS: Address = "0x000000000000000000000000000000000000beef";

export interface LiquidationTarget {
  account: Address;
  market: MarketDef;
  /** Absolute position size, base units x18. */
  size: bigint;
  isLong: boolean;
  marginRatioBps: number;
}

/** Whitelist the keeper by impersonating the ClearingHouse admin (fork only). */
export async function ensureKeeperWhitelisted(f: ForkClients, keeper: Address = KEEPER_ADDRESS): Promise<void> {
  const already = (await f.pub.readContract({
    address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "whitelistedLiquidators", args: [keeper],
  })) as boolean;
  if (already) { logger.info({ keeper }, "keeper already whitelisted"); return; }

  const owner = (await f.pub.readContract({
    address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "owner",
  })) as Address;
  const admin = await impersonate(f, owner);
  const hash = await admin.writeContract({
    address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "setWhitelistedLiquidator",
    args: [keeper, true], chain: null, account: owner,
  });
  await f.pub.waitForTransactionReceipt({ hash });

  const ok = (await f.pub.readContract({
    address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "whitelistedLiquidators", args: [keeper],
  })) as boolean;
  if (!ok) throw new Error("failed to whitelist keeper");
  logger.info({ keeper, admin: owner }, "keeper whitelisted via impersonated admin (fork only)");
}

/** Scan account x market for positions the protocol considers liquidatable. */
export async function findLiquidatable(
  f: ForkClients, accounts: readonly Address[], markets: readonly MarketDef[],
): Promise<LiquidationTarget[]> {
  const out: LiquidationTarget[] = [];
  for (const account of accounts) {
    for (const market of markets) {
      let liq = false;
      try {
        liq = (await f.pub.readContract({
          address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "isLiquidatable", args: [account, market.marketId],
        })) as boolean;
      } catch { continue; } // reverts when the oracle is down; not a liquidatable signal
      if (!liq) continue;

      const pos = (await f.pub.readContract({
        address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "getPosition", args: [account, market.marketId],
      })) as { size: bigint };
      if (!pos.size) continue;

      let mr = 0n;
      try {
        mr = (await f.pub.readContract({
          address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "getMarginRatio", args: [account, market.marketId],
        })) as bigint;
      } catch { /* ignore */ }

      out.push({
        account, market,
        size: pos.size > 0n ? pos.size : -pos.size,
        isLong: pos.size > 0n,
        // getMarginRatio returns WAD (1e18 == 100%), not bps. Converting here
        // keeps scenario notes comparable with mmrBps risk params (e.g. 500 = 5%).
        marginRatioBps: Number(mr) / 1e18 * 10_000,
      });
    }
  }
  return out;
}

/**
 * Liquidate a target in full.
 *
 * amountLimit is directional and getting it backwards reverts every call:
 *   long  -> vamm.sellBase(size, amountLimit): amountLimit is the MINIMUM quote
 *            out, so 0 accepts any execution price.
 *   short -> vamm.buyBase(size, amountLimit):  amountLimit is the MAXIMUM quote
 *            in, so maxUint256 accepts any execution price.
 * Limits are deliberately permissive: we are measuring what the protocol does
 * under stress, not protecting the keeper's economics.
 */
export async function liquidateTarget(f: ForkClients, t: LiquidationTarget, keeper: Address = KEEPER_ADDRESS): Promise<`0x${string}` | null> {
  const r = await liquidateTargetDetailed(f, t, keeper);
  return r.status === "executed" ? r.hash : null;
}

export type LiquidationOutcome =
  | { status: "executed"; hash: `0x${string}` }
  | { status: "reverted"; reason: string };

/** Extract a contract error name from a viem revert, falling back to the message. */
function revertReason(e: unknown): string {
  const err = e as {
    cause?: { data?: { errorName?: string }; reason?: string; signature?: string; cause?: { data?: { errorName?: string }; signature?: string } };
    shortMessage?: string; message?: string;
  };
  return (
    err?.cause?.data?.errorName ??
    err?.cause?.cause?.data?.errorName ??
    err?.cause?.reason ??
    err?.cause?.signature ??
    err?.cause?.cause?.signature ??
    err?.shortMessage?.split("\n")[0] ??
    err?.message?.split("\n")[0] ??
    "unknown"
  );
}

/**
 * Liquidate with the revert reason captured.
 *
 * Simulates before sending. A position can read as liquidatable and still fail to
 * liquidate (liquidate() settles funding first, which moves the margin state), so
 * knowing WHY a call failed distinguishes a benign race from a position that is
 * permanently stuck liquidatable-but-unliquidatable.
 */
export async function liquidateTargetDetailed(
  f: ForkClients, t: LiquidationTarget, keeper: Address = KEEPER_ADDRESS,
): Promise<LiquidationOutcome> {
  const wallet = await impersonate(f, keeper);
  const amountLimit = t.isLong ? 0n : maxUint256;

  try {
    await f.pub.simulateContract({
      address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "liquidate",
      args: [t.account, t.market.marketId, t.size, amountLimit], account: keeper,
    });
  } catch (e) {
    const reason = revertReason(e);
    logger.info({ account: t.account, market: t.market.name, reason }, "liquidation would revert (not sent)");
    return { status: "reverted", reason };
  }

  try {
    const hash = await wallet.writeContract({
      address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "liquidate",
      args: [t.account, t.market.marketId, t.size, amountLimit], chain: null, account: keeper,
    });
    // A mined transaction can still have reverted. Without this check the keeper
    // reports failures as successes and the same position is re-detected every
    // sweep, inflating the apparent liquidation count.
    const rcpt = await f.pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") {
      logger.info({ account: t.account, market: t.market.name, hash }, "liquidation tx reverted on-chain");
      return { status: "reverted", reason: "tx reverted after successful simulation" };
    }
    logger.warn({ account: t.account, market: t.market.name, size: t.size.toString(), mrBps: t.marginRatioBps }, "liquidation executed");
    return { status: "executed", hash };
  } catch (e) {
    return { status: "reverted", reason: revertReason(e) };
  }
}

export interface SweepResult {
  scanned: number;
  attempted: number;
  executed: number;
  txHashes: string[];
  /** Revert reason -> count. Distinguishes benign races from stuck positions. */
  revertReasons: Record<string, number>;
}

/** One full keeper pass across every account and market. */
export async function sweep(
  f: ForkClients, accounts: readonly Address[], markets: readonly MarketDef[], keeper: Address = KEEPER_ADDRESS,
): Promise<SweepResult> {
  const targets = await findLiquidatable(f, accounts, markets);
  const txHashes: string[] = [];
  const revertReasons: Record<string, number> = {};
  for (const t of targets) {
    const r = await liquidateTargetDetailed(f, t, keeper);
    if (r.status === "executed") txHashes.push(r.hash);
    else revertReasons[r.reason] = (revertReasons[r.reason] ?? 0) + 1;
  }
  return {
    scanned: accounts.length * markets.length,
    attempted: targets.length,
    executed: txHashes.length,
    txHashes,
    revertReasons,
  };
}
