import type { Account } from "viem";
import { formatEther, formatUnits } from "viem";
import { publicClient } from "../chain/clients";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import { USDC_DECIMALS } from "../config/constants";
import { treasury as treasuryAccount, agentMembers } from "../wallet/fleet";
import { ethBalance, sendEth } from "../chain/native";
import { usdcBalance, vaultBalance, ensureUsdc, ensureApproval, deposit } from "../collateral/collateral";
import {
  AGENT_ETH_TARGET,
  AGENT_ETH_REFILL_BELOW,
  TREASURY_ETH_RESERVE,
  AGENT_USDC_MINT,
  AGENT_COLLATERAL_TARGET,
} from "../config/provisioning";

const GAS_PER_ETH_TRANSFER = 21_000n;

export interface WalletStatus {
  index: number;
  role: "treasury" | "agent";
  address: string;
  ethWei: bigint;
  walletUsdc: bigint;
  vaultUsdc: bigint;
}

async function readWalletStatus(
  index: number,
  role: "treasury" | "agent",
  account: Account,
): Promise<WalletStatus> {
  const [ethWei, wu, vu] = await Promise.all([
    ethBalance(account.address),
    usdcBalance(account.address),
    vaultBalance(account.address),
  ]);
  return { index, role, address: account.address, ethWei, walletUsdc: wu, vaultUsdc: vu };
}

/** Read-only overview of the treasury + every agent wallet. Sends nothing. */
export async function treasuryStatus(count: number): Promise<WalletStatus[]> {
  const rows: WalletStatus[] = [];
  rows.push(await readWalletStatus(0, "treasury", treasuryAccount()));
  for (const m of agentMembers(count)) {
    rows.push(await readWalletStatus(m.index, "agent", m.account));
  }

  logger.info({ count, dryRun: env.DRY_RUN }, "treasury status");
  for (const s of rows) {
    logger.info(
      {
        idx: s.index,
        role: s.role,
        addr: s.address,
        eth: formatEther(s.ethWei),
        walletUsdc: formatUnits(s.walletUsdc, USDC_DECIMALS),
        vaultUsdc: formatUnits(s.vaultUsdc, USDC_DECIMALS),
      },
      "wallet",
    );
  }
  return rows;
}

/**
 * Budget-aware, idempotent fleet provisioning. For each agent it:
 *   1. tops its ETH up to AGENT_ETH_TARGET (from the treasury) — but ONLY while
 *      the treasury has ETH to spare beyond its reserve. When ETH runs out it
 *      stops funding and reports the shortfall; re-run once more ETH arrives.
 *   2. self-mints mock USDC, approves the vault, and deposits collateral (the
 *      agent pays its own gas from the ETH funded in step 1).
 * Re-running only tops up what's missing, so it's safe to run repeatedly and it
 * scales unchanged from 1 wallet (faucet-era) to hundreds (bulk-ETH era).
 */
export async function provision(count: number): Promise<void> {
  const t = treasuryAccount();
  const gasPrice = await publicClient.getGasPrice();
  const transferGasCost = GAS_PER_ETH_TRANSFER * gasPrice;

  const treasuryEth = await ethBalance(t.address);
  let available = treasuryEth > TREASURY_ETH_RESERVE ? treasuryEth - TREASURY_ETH_RESERVE : 0n;
  const perAgentSpend = AGENT_ETH_TARGET + transferGasCost;
  const estFundable = perAgentSpend > 0n ? Number(available / perAgentSpend) : 0;

  logger.info(
    {
      requested: count,
      dryRun: env.DRY_RUN,
      treasuryEth: formatEther(treasuryEth),
      reserve: formatEther(TREASURY_ETH_RESERVE),
      availableForFunding: formatEther(available),
      perAgentEthTarget: formatEther(AGENT_ETH_TARGET),
      estFundableFromScratch: estFundable,
    },
    "provision start",
  );

  let ethFunded = 0;
  let ethShort = 0;
  let ready = 0;

  for (const m of agentMembers(count)) {
    const agentEth = await ethBalance(m.account.address);

    // ── 1) ETH top-up (budget-gated) ──────────────────────────────────────────
    let canOperate = agentEth >= AGENT_ETH_REFILL_BELOW;
    if (agentEth < AGENT_ETH_REFILL_BELOW) {
      const need = AGENT_ETH_TARGET - agentEth;
      const cost = need + transferGasCost;
      if (env.DRY_RUN) {
        await sendEth(t, m.account.address, need, `fund agent-${m.index}`); // logs intent only
        canOperate = true; // proceed to validate the setup wiring in dry-run
      } else if (available >= cost) {
        const res = await sendEth(t, m.account.address, need, `fund agent-${m.index}`);
        if (!res.sent) {
          logger.error({ idx: m.index }, "ETH funding failed — skipping agent");
          continue;
        }
        available -= cost;
        ethFunded += 1;
        canOperate = true;
      } else {
        ethShort += 1;
        logger.warn(
          { idx: m.index, need: formatEther(need), available: formatEther(available) },
          "insufficient treasury ETH — agent left unprovisioned (re-run when funded)",
        );
        continue;
      }
    }

    if (!canOperate) continue;

    // ── 2) Self-provision collateral (agent pays its own gas) ─────────────────
    try {
      await ensureUsdc(m.account, AGENT_COLLATERAL_TARGET, AGENT_USDC_MINT);
      await ensureApproval(m.account, AGENT_COLLATERAL_TARGET);
      const vu = await vaultBalance(m.account.address);
      if (vu < AGENT_COLLATERAL_TARGET) {
        await deposit(m.account, AGENT_COLLATERAL_TARGET - vu);
      }
      ready += 1;
    } catch (e) {
      logger.error(
        { idx: m.index, err: e instanceof Error ? e.message : String(e) },
        "agent collateral setup failed",
      );
    }
  }

  logger.info(
    { requested: count, ethFunded, ethShort, ready, treasuryEthLeft: formatEther(available) },
    "provision done",
  );
}
