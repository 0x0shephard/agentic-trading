import type { Abi, Account, Address, Hex } from "viem";
import { formatEther, formatGwei } from "viem";
import { publicClient, walletFor } from "./clients";
import { env } from "../config/env";
import { logger } from "../logging/logger";

export interface WriteParams {
  account: Account;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  label: string;
}

export interface WriteResult {
  label: string;
  dryRun: boolean;
  simulated: boolean;
  reverted: boolean;
  /** True when the tx was NOT sent because the wallet couldn't afford the gas. */
  skipped?: boolean;
  hash?: `0x${string}`;
  gasUsed?: bigint;
  reason?: string;
}

// Headroom applied over eth_estimateGas. Critical: estimateGas runs a binary
// search that nets out end-of-tx storage-clearing refunds (e.g. closePosition
// deletes the position struct), so its result can be LOWER than the gas the EVM
// actually needs to *reach* that refund — causing an out-of-gas revert on send
// even though simulate (eth_call, run at the block gas limit) passed. A 1.25x
// buffer covers the observed close shortfall (~7%) with margin. Kept modest on
// purpose: the node reserves gasLimit*maxFeePerGas up front, so an over-large
// buffer can make an otherwise-affordable tx unspendable during a gas spike.
const GAS_BUFFER_NUM = 125n;
const GAS_BUFFER_DEN = 100n;

function errMsg(e: unknown): string {
  if (e && typeof e === "object") {
    const anyE = e as { shortMessage?: unknown; message?: unknown };
    if (typeof anyE.shortMessage === "string") return anyE.shortMessage;
    if (typeof anyE.message === "string") return anyE.message;
  }
  return String(e);
}

/**
 * Recover a human reason for a reverted, already-mined tx by replaying its
 * calldata via eth_call at the block it was mined in. A logic revert replays
 * with the decoded reason; an out-of-gas failure replays cleanly (eth_call uses
 * the block gas limit), which we report as such.
 */
async function onChainRevertReason(hash: Hex, blockNumber: bigint): Promise<string> {
  try {
    const tx = await publicClient.getTransaction({ hash });
    if (!tx.to) return "reverted on-chain (contract-creation tx)";
    await publicClient.call({
      account: tx.from,
      to: tx.to,
      data: tx.input,
      value: tx.value,
      blockNumber,
    });
    // Replay did NOT revert → the on-chain failure was gas/state-dependent,
    // overwhelmingly out-of-gas given a clean simulate beforehand.
    return "out-of-gas or state-dependent revert (replay at block did not revert)";
  } catch (e) {
    return errMsg(e);
  }
}

/**
 * The single chokepoint for every state-changing call.
 *   1. eth_call simulate (hard gate — a revert here means we never send).
 *   2. DRY_RUN → log intent and stop (nothing is signed/sent).
 *   3. live → estimate gas (+buffer), send, wait for receipt, verify status.
 * One in-flight tx per wallet is assumed (callers await sequentially); a nonce
 * pool for concurrent agents is added in a later phase.
 */
export async function executeWrite(p: WriteParams): Promise<WriteResult> {
  const { account, address, abi, functionName, args, label } = p;

  let request: unknown;
  try {
    // viem's simulateContract is heavily generic; this wrapper is intentionally
    // generic, so we cast the params/return once here. Runtime is abi-validated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sim = await publicClient.simulateContract({ account, address, abi, functionName, args } as any);
    request = sim.request;
  } catch (e) {
    const reason = errMsg(e);
    if (env.DRY_RUN) {
      logger.warn({ label, reason }, "dry-run: simulate reverted (may be due to un-persisted prior steps)");
      return { label, dryRun: true, simulated: false, reverted: true, reason };
    }
    throw new Error(`${label}: simulate reverted — ${reason}`);
  }

  if (env.DRY_RUN) {
    logger.info({ label }, "dry-run: simulate ok — would send (skipped)");
    return { label, dryRun: true, simulated: true, reverted: false };
  }

  // Explicit gas limit with buffer (see GAS_BUFFER_* above). We already
  // simulated OK, so a failure here is unexpected — surface it rather than fall
  // back to an under-estimated limit.
  let gas: bigint;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const est = await publicClient.estimateContractGas({ account, address, abi, functionName, args } as any);
    gas = (est * GAS_BUFFER_NUM) / GAS_BUFFER_DEN;
  } catch (e) {
    throw new Error(`${label}: gas estimation failed — ${errMsg(e)}`);
  }

  // Affordability pre-flight. The node reserves gasLimit*maxFeePerGas up front,
  // so a gas spike or an under-funded wallet would otherwise throw mid-run. Skip
  // cleanly and signal a refill instead of crashing the agent loop.
  const fees = await publicClient.estimateFeesPerGas();
  const required = gas * fees.maxFeePerGas;
  const balance = await publicClient.getBalance({ address: account.address });
  if (balance < required) {
    logger.warn(
      {
        label,
        needEth: formatEther(required),
        haveEth: formatEther(balance),
        gas: gas.toString(),
        maxFeeGwei: formatGwei(fees.maxFeePerGas),
      },
      "insufficient gas funds — skipping (wallet needs a refill)",
    );
    return { label, dryRun: false, simulated: true, reverted: false, skipped: true, reason: "insufficient gas funds" };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hash = await walletFor(account).writeContract({
    ...(request as any),
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  logger.info({ label, hash, gasLimit: gas.toString(), maxFeeGwei: formatGwei(fees.maxFeePerGas) }, "tx sent");
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    const reason = await onChainRevertReason(hash, receipt.blockNumber);
    logger.error(
      { label, hash, gasUsed: receipt.gasUsed.toString(), gasLimit: gas.toString(), reason },
      "tx reverted on-chain",
    );
    return { label, dryRun: false, simulated: true, reverted: true, hash, gasUsed: receipt.gasUsed, reason };
  }
  logger.info(
    { label, hash, gasUsed: receipt.gasUsed.toString(), block: receipt.blockNumber.toString() },
    "tx confirmed",
  );
  return { label, dryRun: false, simulated: true, reverted: false, hash, gasUsed: receipt.gasUsed };
}
