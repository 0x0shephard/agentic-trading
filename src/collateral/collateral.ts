import type { Account, Address } from "viem";
import { publicClient } from "../chain/clients";
import { executeWrite } from "../chain/tx";
import { CONTRACTS } from "../config/addresses";
import { erc20Abi, collateralVaultAbi, clearingHouseAbi } from "../chain/abis";
import { logger } from "../logging/logger";

const MAX_UINT256 = (1n << 256n) - 1n;

// All amounts here are in USDC's native 6-decimal units (NOT x18).
export async function usdcBalance(addr: Address): Promise<bigint> {
  return publicClient.readContract({
    address: CONTRACTS.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [addr],
  });
}

export async function usdcAllowance(owner: Address): Promise<bigint> {
  return publicClient.readContract({
    address: CONTRACTS.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, CONTRACTS.collateralVault],
  });
}

export async function vaultBalance(user: Address): Promise<bigint> {
  return publicClient.readContract({
    address: CONTRACTS.collateralVault,
    abi: collateralVaultAbi,
    functionName: "balanceOf",
    args: [user, CONTRACTS.usdc],
  });
}

/** Mint mock USDC (6dp) to the account if wallet balance is below `min6`. */
export async function ensureUsdc(account: Account, min6: bigint, mint6: bigint): Promise<void> {
  const bal = await usdcBalance(account.address);
  if (bal >= min6) {
    logger.info({ have: bal.toString() }, "usdc: balance sufficient, skip mint");
    return;
  }
  await executeWrite({
    account,
    address: CONTRACTS.usdc,
    abi: erc20Abi,
    functionName: "mint",
    args: [account.address, mint6],
    label: "mint USDC",
  });
}

/** Approve the vault to pull USDC (max allowance, once). */
export async function ensureApproval(account: Account, min6: bigint): Promise<void> {
  const allowance = await usdcAllowance(account.address);
  if (allowance >= min6) {
    logger.info("usdc: allowance sufficient, skip approve");
    return;
  }
  await executeWrite({
    account,
    address: CONTRACTS.usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [CONTRACTS.collateralVault, MAX_UINT256],
    label: "approve USDC",
  });
}

/**
 * Deposit USDC (6dp) into the vault via the ClearingHouse (the vault's own
 * deposit is CH-only). Approval must already be granted to the vault, which the
 * CH uses to pull the tokens.
 */
export async function deposit(account: Account, amount6: bigint): Promise<void> {
  await executeWrite({
    account,
    address: CONTRACTS.clearingHouse,
    abi: clearingHouseAbi,
    functionName: "deposit",
    args: [CONTRACTS.usdc, amount6],
    label: "deposit collateral",
  });
}
