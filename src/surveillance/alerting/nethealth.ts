// Network / RPC health monitor (RMF Section 2, "Network status").
//
// "We should learn about an outage from our own systems before users tell us."
// This watches the chain endpoint the platform depends on and answers three
// questions every poll:
//
//   1. Is the primary RPC responding at all?           -> rpc-down (critical)
//   2. Is the chain head actually advancing?           -> rpc-stalled (warn/crit)
//   3. Is the primary keeping up with the real tip?    -> rpc-lag (warning)
//
// A second (fallback) endpoint, if configured, disambiguates the failure: if the
// primary is dead but the fallback still returns a head, the CHAIN is fine and
// the PROVIDER is degraded — a different remediation. Without a fallback the
// monitor still detects a dead or frozen primary, just with less attribution.
//
// Deliberately uses its own clients with retryCount:0 and a tight timeout: the
// job is to SURFACE an outage quickly, not to paper over it with retries. A
// single transient blip is ridden out by the consecutive-failure gate, not by
// the transport.
//
// The L2 sequencer-uptime piece the brief mentions ("Arbitrum sequencer status
// once we deploy there") is handled by the existing Section 3 outage guard, which
// activates when the uptime feed address is set at launch; it is not duplicated
// here.
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import type { PublicClient } from "viem";
import { env } from "../../config/env";
import { logger } from "../../logging/logger";
import { AlertDispatcher } from "./dispatcher";
import type { HealthSignal } from "./health";

export interface NetEndpoint { label: string; url: string }
export interface NetClient { ep: NetEndpoint; client: PublicClient }
export interface NetClients { primary: NetClient; fallback?: NetClient }

export interface NetConfig {
  /** Warn once the head has not advanced for this long. */
  stallWarnMs: number;
  /** Escalate to critical once the head has not advanced for this long. */
  stallCritMs: number;
  /** Warn if the primary trails the fallback by at least this many blocks. */
  lagBlocks: number;
  /** Consecutive failed polls before paging (rides out a single transient blip). */
  downConsecutive: number;
}

export interface NetHealthState {
  /** Highest head block seen from the primary (null until the first success). */
  lastHead: bigint | null;
  /** When the head last advanced (ms); the stall clock counts from here. */
  lastHeadChangedAt: number;
  /** Consecutive primary read failures. */
  downCount: number;
  startedAt: number;
}

export function newNetHealthState(now = Date.now()): NetHealthState {
  return { lastHead: null, lastHeadChangedAt: now, downCount: 0, startedAt: now };
}

export function netConfigFromEnv(): NetConfig {
  return {
    stallWarnMs: env.NET_STALL_WARN_MS,
    stallCritMs: env.NET_STALL_CRIT_MS,
    lagBlocks: env.NET_LAG_BLOCKS,
    downConsecutive: 2,
  };
}

/** Bounded client: one attempt, tight timeout, no block-number caching. */
function makeClient(url: string): PublicClient {
  return createPublicClient({
    chain: sepolia,
    transport: http(url, { timeout: 8_000, retryCount: 0 }),
    cacheTime: 0,
  });
}

export function createNetClients(): NetClients {
  const primary: NetClient = { ep: { label: "primary", url: env.SEPOLIA_RPC_URL }, client: makeClient(env.SEPOLIA_RPC_URL) };
  const fb = env.NET_FALLBACK_RPC_URL;
  return { primary, fallback: fb ? { ep: { label: "fallback", url: fb }, client: makeClient(fb) } : undefined };
}

async function headOrNull(nc: NetClient): Promise<bigint | null> {
  try {
    return await nc.client.getBlockNumber();
  } catch {
    return null;
  }
}

/** Evaluate the current network conditions. Pure given clients/state/cfg/now. */
export async function checkNetHealth(
  clients: NetClients, st: NetHealthState, cfg: NetConfig, now = Date.now(),
): Promise<HealthSignal[]> {
  const out: HealthSignal[] = [];

  // (1) Primary reachable?
  let head: bigint | null;
  try {
    head = await clients.primary.client.getBlockNumber();
  } catch (e) {
    head = null;
    logger.warn({ err: e instanceof Error ? e.message : String(e), downCount: st.downCount + 1 }, "net: primary RPC read failed");
  }

  if (head === null) {
    st.downCount++;
    // Is it the chain or just this provider? Ask the fallback.
    const fallbackHead = clients.fallback ? await headOrNull(clients.fallback) : null;
    if (st.downCount >= cfg.downConsecutive) {
      const providerOnly = fallbackHead !== null;
      out.push({
        key: "rpc-down",
        severity: "critical",
        title: "Primary RPC endpoint not responding",
        detail: providerOnly
          ? `The primary Sepolia RPC has failed ${st.downCount} consecutive checks, but the fallback endpoint is responding at block ${fallbackHead}. The chain is up; the primary provider is degraded — the monitor and anything reading through it are flying blind until it recovers or is repointed.`
          : `The primary Sepolia RPC has failed ${st.downCount} consecutive checks${clients.fallback ? " and the fallback endpoint is also unreachable, so the chain itself or our connectivity may be down." : " (no fallback is configured to cross-check whether the chain or just this provider is down)."}`,
        fields: {
          Endpoint: clients.primary.ep.url,
          "Consecutive failures": st.downCount,
          Fallback: clients.fallback ? (fallbackHead !== null ? `up @ block ${fallbackHead}` : "also unreachable") : "not configured",
        },
      });
    }
    return out; // no head → cannot evaluate stall or lag this pass
  }

  st.downCount = 0; // primary answered

  // (2) Is the head advancing?
  if (st.lastHead === null || head > st.lastHead) {
    st.lastHead = head;
    st.lastHeadChangedAt = now;
  } else {
    const stalledMs = now - st.lastHeadChangedAt;
    if (stalledMs >= cfg.stallWarnMs) {
      const critical = stalledMs >= cfg.stallCritMs;
      const mins = Math.round(stalledMs / 60_000);
      out.push({
        key: "rpc-stalled",
        severity: critical ? "critical" : "warning",
        title: `Chain head not advancing (${mins} min)`,
        detail: `The head block has been stuck at ${head} for ${mins} minute(s). On Sepolia (~12s block time) this means either the chain has stalled or the RPC provider has frozen. While blocks are not being produced, positions cannot be opened, closed, or liquidated.`,
        fields: { "Head block": head.toString(), "Stalled for": `${mins} min`, Endpoint: clients.primary.ep.url },
      });
    }
    // Deliberately do NOT touch lastHead/lastHeadChangedAt here, so the stall
    // clock keeps running from the last genuine advance.
  }

  // (3) Cross-check against the fallback: is the primary lagging the true tip?
  if (clients.fallback) {
    const fh = await headOrNull(clients.fallback); // fallback being down is not a primary-health signal
    if (fh !== null) {
      const lag = fh - head; // positive => primary is behind
      if (lag >= BigInt(cfg.lagBlocks)) {
        out.push({
          key: "rpc-lag",
          severity: "warning",
          title: "Primary RPC lagging behind chain head",
          detail: `The primary endpoint reports block ${head} while the fallback reports ${fh}, a gap of ${lag} blocks. The primary is serving stale state; reads through it may trail the true chain tip.`,
          fields: { "Primary head": head.toString(), "Fallback head": fh.toString(), "Lag (blocks)": lag.toString() },
        });
      }
    }
  }

  return out;
}

// ── Monitor wrapper (mirrors health-monitor.ts) ─────────────────────────────

export interface NetMonitor {
  clients: NetClients;
  state: NetHealthState;
  dispatcher: AlertDispatcher;
  cfg: NetConfig;
}

export function createNetMonitor(): NetMonitor {
  return { clients: createNetClients(), state: newNetHealthState(), dispatcher: new AlertDispatcher(), cfg: netConfigFromEnv() };
}

/** One network-health pass: evaluate, dispatch transitions and recoveries.
 *  No heartbeat here — the main health monitor's heartbeat covers the process. */
export async function netHealthPass(nm: NetMonitor): Promise<void> {
  let signals: HealthSignal[];
  try {
    signals = await checkNetHealth(nm.clients, nm.state, nm.cfg);
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "net health check failed");
    return;
  }
  const { fired, recovered } = await nm.dispatcher.dispatch(signals);
  if (fired || recovered) {
    logger.warn({ fired, recovered, active: nm.dispatcher.activeKeys() }, "net health alerts dispatched");
  }
}
