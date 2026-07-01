import type { Account, Address } from "viem";
import { formatEther } from "viem";
import { sepolia } from "viem/chains";
import { publicClient, walletFor } from "./clients";
import { env } from "../config/env";
import { logger } from "../logging/logger";

/** Native ETH balance (wei). */
export async function ethBalance(addr: Address): Promise<bigint> {
  return publicClient.getBalance({ address: addr });
}

export interface SendEthResult {
  sent: boolean;
  dryRun: boolean;
  hash?: `0x${string}`;
}

/**
 * Native ETH transfer with the same DRY_RUN discipline as executeWrite: in
 * dry-run it logs intent and sends nothing; live, it sends and waits for the
 * receipt. A plain transfer to an EOA is a fixed 21k gas (viem estimates).
 */
export async function sendEth(
  from: Account,
  to: Address,
  wei: bigint,
  label: string,
): Promise<SendEthResult> {
  if (wei <= 0n) return { sent: false, dryRun: env.DRY_RUN };

  if (env.DRY_RUN) {
    logger.info({ label, to, eth: formatEther(wei) }, "dry-run: would send ETH (skipped)");
    return { sent: false, dryRun: true };
  }

  const hash = await walletFor(from).sendTransaction({
    account: from,
    chain: sepolia,
    to,
    value: wei,
  });
  logger.info({ label, to, eth: formatEther(wei), hash }, "ETH sent");
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    logger.error({ label, to, hash }, "ETH transfer reverted");
    return { sent: false, dryRun: false, hash };
  }
  return { sent: true, dryRun: false, hash };
}
