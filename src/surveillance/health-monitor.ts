// Protocol-health monitor loop.
//
// Runs alongside the existing trade-flow surveillance. Reads chain state directly
// so it keeps working during an indexer outage, which is precisely when the
// underlying incident is most likely.
import type { Address, PublicClient } from "viem";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import { agentAccount } from "../chain/clients";
import { checkHealth, newHealthState } from "./alerting/health";
import type { HealthState } from "./alerting/health";
import { readerFor } from "./alerting/chainsnapshot";
import type { ChainSnapshot } from "./alerting/chainsnapshot";
import { AlertDispatcher } from "./alerting/dispatcher";

export interface HealthMonitor {
  state: HealthState;
  dispatcher: AlertDispatcher;
  accounts: Address[];
}

/** Wallets to scan for liquidatable positions (derived, so attribution is exact). */
function watchedAccounts(count: number): Address[] {
  const out: Address[] = [];
  if (!env.AGENT_MNEMONIC) return out;
  try {
    for (let i = 0; i <= count; i++) out.push(agentAccount(i).address as Address);
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "health: account derivation failed");
  }
  return out;
}

export function createHealthMonitor(): HealthMonitor {
  return {
    state: newHealthState(),
    dispatcher: new AlertDispatcher(),
    accounts: watchedAccounts(env.MONITOR_LABEL_WALLETS),
  };
}

/** One health pass: evaluate conditions, dispatch changes, maintain heartbeat.
 *  Returns the chain snapshot it evaluated so the price guard and trade-flow
 *  check can reuse it (null if the snapshot could not be taken). */
export async function healthPass(pc: PublicClient, hm: HealthMonitor): Promise<ChainSnapshot | null> {
  let signals;
  let snap: ChainSnapshot | null = null;
  try {
    snap = await readerFor(pc).snapshot();
    signals = await checkHealth(pc, hm.state, hm.accounts, undefined, snap);
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "health check failed");
    return snap;
  }

  const { fired, recovered } = await hm.dispatcher.dispatch(signals);
  if (fired || recovered) {
    logger.warn({ fired, recovered, active: hm.dispatcher.activeKeys() }, "health alerts dispatched");
  }

  await hm.dispatcher.maybeHeartbeat({
    "Watched accounts": hm.accounts.length,
    "Poll interval": `${env.HEALTH_POLL_MS / 1000}s`,
  });
  return snap;
}
