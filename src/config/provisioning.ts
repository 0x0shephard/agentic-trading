// Provisioning targets for the agent fleet. These are the ONLY knobs that need
// tuning as the Sepolia ETH budget changes — the provisioner itself is
// budget-aware and idempotent, so raising/lowering these just changes how many
// agents get activated, never whether provisioning works.
import { parseEther, parseUnits } from "viem";
import { USDC_DECIMALS } from "./constants";

function ethConfig(name: string, fallback: string): bigint {
  const raw = process.env[name]?.trim() || fallback;
  try {
    return parseEther(raw);
  } catch {
    throw new Error(`${name} must be an ETH amount string, got "${raw}"`);
  }
}

/** Wallet index 0 is the treasury/funder; agents are indices 1..N. */
export const TREASURY_INDEX = 0;

/** Default fleet size when a script is run without an explicit count. Keep small
 *  while ETH comes only from faucets; raise once ETH is bought in bulk. */
export const DEFAULT_FLEET_SIZE = 3;

// ── ETH (the only real constraint) ──────────────────────────────────────────
/** Target ETH each agent holds — must cover its own setup txns (mint/approve/
 *  deposit) plus trading runway. Agents pay their own gas from this. */
export const AGENT_ETH_TARGET = ethConfig("AGENT_ETH_TARGET", "0.05");
/** Only top an agent up when it drops below this (hysteresis — avoids dust
 *  top-ups every run). Also the minimum ETH an agent needs to self-provision. */
export const AGENT_ETH_REFILL_BELOW = ethConfig("AGENT_ETH_REFILL_BELOW", "0.02");
/** ETH the treasury always keeps back for its own transactions. */
export const TREASURY_ETH_RESERVE = ethConfig("TREASURY_ETH_RESERVE", "0.02");

// ── USDC / collateral (mock USDC is free to mint — not ETH-constrained) ──────
/** Mock USDC minted to an agent's wallet when it runs low. */
export const AGENT_USDC_MINT = parseUnits("5000", USDC_DECIMALS);
/** Collateral each agent keeps deposited in the vault. */
export const AGENT_COLLATERAL_TARGET = parseUnits("1000", USDC_DECIMALS);
