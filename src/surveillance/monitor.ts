import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { env } from "../config/env";
import { CONTRACTS } from "../config/addresses";
import { logger } from "../logging/logger";
import { MARKETS } from "../config/markets";
import type { MarketDef } from "../config/markets";
import { getMarketSnapshot } from "../market/snapshot";
import { toNumberX18 } from "../preview/orderPreview";
import { agentAccount } from "../chain/clients";
import { buildAssignments } from "../orchestrator/assignments";
import { buildLabels } from "../observability/labels";
import { sleepUntil } from "../runtime/cadence";
import { ManipulationDetector } from "./detector";
import { createHealthMonitor, healthPass } from "./health-monitor";
import { dispatchManipulation } from "./alerting/dispatcher";
import { adminWatchPass, newAdminWatchState } from "./alerting/adminwatch";
import { priceGuardPass, newPriceGuardState } from "./alerting/priceguard";
import { createNetMonitor, netHealthPass } from "./alerting/nethealth";
import { createSiteMonitor, siteHealthPass, siteHealthEnabled } from "./alerting/sitehealth";
import { leveragePass, leverageConfigFromEnv } from "./leverage";
import type { TradeEvent, Alert } from "./types";

// canonical_pnl_events accounting types that represent an actual trade.
const TRADE_TYPES = ["open", "increase", "close", "reduce", "decrease", "flip"];
const OPEN_TYPES = new Set(["open", "increase"]); // add exposure; others reduce it

interface RawTrade {
  user_address: string;
  market_name: string;
  accounting_type: string;
  side: string | null;
  notional: number | string | null;
  execution_price: number | string | null;
  tx_hash: string;
  block_timestamp: string;
  block_number: number | null;
  transaction_index: number | null;
  primary_log_index: number | null;
}

// Chain order within a market: timestamp (sec res) then block/tx/log index.
function cmpTrade(a: RawTrade, b: RawTrade): number {
  const ta = Date.parse(a.block_timestamp);
  const tb = Date.parse(b.block_timestamp);
  if (ta !== tb) return ta - tb;
  if ((a.block_number ?? 0) !== (b.block_number ?? 0)) return (a.block_number ?? 0) - (b.block_number ?? 0);
  if ((a.transaction_index ?? 0) !== (b.transaction_index ?? 0)) return (a.transaction_index ?? 0) - (b.transaction_index ?? 0);
  return (a.primary_log_index ?? 0) - (b.primary_log_index ?? 0);
}

function marketByName(name: string): MarketDef | undefined {
  return MARKETS.find((m) => m.name === name);
}

/** Service-role Supabase client (reads market data, writes alerts). */
export function makeSupabase(): SupabaseClient {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Surveillance monitor needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

/** Map agent wallet address (lowercase) → label, derived from the mnemonic. */
export function buildLabelMap(count: number): Map<string, string> {
  const map = new Map<string, string>();
  if (!env.AGENT_MNEMONIC) return map;
  try {
    map.set(agentAccount(0).address.toLowerCase(), "treasury");
    const labels = buildLabels(buildAssignments(count));
    for (let i = 1; i <= count; i++) map.set(agentAccount(i).address.toLowerCase(), labels.get(i) ?? `#${i}`);
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "monitor: label derivation failed");
  }
  return map;
}

function alertToRow(a: Alert, labels: Map<string, string>): Record<string, unknown> {
  return {
    detected_at: new Date(a.detectedAt).toISOString(),
    severity: a.severity,
    kind: a.kind,
    wallet: a.wallet,
    agent_label: labels.get(a.wallet.toLowerCase()) ?? null,
    market: a.market,
    dev_bps: a.devBps,
    impact_bps: a.impactBps,
    widened_bps: a.widenedBps,
    notional_usd: a.notionalUsd,
    tx_hashes: a.txHashes,
    detail: a.detail,
  };
}

// An alert's identity for dedup: kind + the primary (first) tx hash it cites.
function alertKey(kind: unknown, txHashes: unknown): string {
  const first = Array.isArray(txHashes) ? String(txHashes[0] ?? "") : "";
  return `${String(kind)}|${first}`;
}

/** Drop candidate alerts already persisted (survives monitor restarts / lookback overlap). */
async function dropDuplicates(sb: SupabaseClient, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const primaryHashes = [...new Set(rows.map((r) => alertKey(r.kind, r.tx_hashes).split("|")[1]).filter(Boolean))];
  if (primaryHashes.length === 0) return rows;
  const { data, error } = await sb.from("manipulation_alerts").select("kind, tx_hashes").overlaps("tx_hashes", primaryHashes);
  if (error) {
    logger.warn({ err: error.message }, "monitor: dedup lookup failed; inserting without dedup");
    return rows;
  }
  const seen = new Set((data ?? []).map((e) => alertKey(e.kind, e.tx_hashes)));
  return rows.filter((r) => !seen.has(alertKey(r.kind, r.tx_hashes)));
}

export interface MonitorState {
  detector: ManipulationDetector;
  labels: Map<string, string>;
  cursorIso: string; // only process trades with block_timestamp > cursor
  lastExec: Map<string, number>; // running vAMM mark per market (last exec price)
}

// Read a trade's fill price (the vAMM mark it executed at), or NaN if absent.
function execOf(r: RawTrade): number {
  const p = Number(r.execution_price ?? NaN);
  return Number.isFinite(p) && p > 0 ? p : NaN;
}

/** Seed the running mark for a market from the last trade before this batch. */
async function seedMark(sb: SupabaseClient, market: string, beforeIso: string): Promise<number | undefined> {
  const { data } = await sb
    .from("canonical_pnl_events")
    .select("execution_price, block_timestamp")
    .eq("market_name", market)
    .lt("block_timestamp", beforeIso)
    .not("execution_price", "is", null)
    .order("block_timestamp", { ascending: false })
    .limit(1);
  const p = data && data[0] ? Number(data[0].execution_price) : NaN;
  return Number.isFinite(p) && p > 0 ? p : undefined;
}

/**
 * One pass: fetch new trades → derive per-trade mark move from execution_price
 * (a running last-fill per market) + current index from chain → detect → write.
 * The vAMM fill price IS the mark, so consecutive fills trace mark impact — no
 * dependency on the (sparsely populated) vamm_price_history table.
 */
export async function monitorPass(sb: SupabaseClient, st: MonitorState): Promise<number> {
  const { data, error } = await sb
    .from("canonical_pnl_events")
    .select(
      "user_address, market_name, accounting_type, side, notional, execution_price, tx_hash, block_timestamp, block_number, transaction_index, primary_log_index",
    )
    .in("accounting_type", TRADE_TYPES)
    .gt("block_timestamp", st.cursorIso)
    .order("block_timestamp", { ascending: true })
    .limit(1000);
  if (error) {
    logger.error({ err: error.message }, "monitor: fetch trades failed");
    return 0;
  }
  const rows = (data ?? []) as RawTrade[];
  if (rows.length === 0) return 0;

  const byMarket = new Map<string, RawTrade[]>();
  for (const r of rows) {
    const arr = byMarket.get(r.market_name) ?? [];
    arr.push(r);
    byMarket.set(r.market_name, arr);
  }

  const events: TradeEvent[] = [];
  for (const [mname, mrows] of byMarket) {
    const def = marketByName(mname);
    if (!def) continue; // market we don't track
    let indexPrice = 0;
    try {
      indexPrice = toNumberX18((await getMarketSnapshot(def)).indexPriceX18);
    } catch (e) {
      logger.warn({ market: mname, err: e instanceof Error ? e.message : String(e) }, "monitor: index read failed");
      continue;
    }
    if (!indexPrice) continue;

    mrows.sort(cmpTrade);
    // Continuity across polls: reuse the persisted running mark; on a cold market
    // seed it from the last trade before this batch so the first trade is scored.
    if (!st.lastExec.has(mname)) {
      const seed = await seedMark(sb, mname, mrows[0]!.block_timestamp);
      if (seed !== undefined) st.lastExec.set(mname, seed);
    }

    for (const r of mrows) {
      const exec = execOf(r);
      if (Number.isNaN(exec)) continue; // no fill price → can't measure impact
      const markBefore = st.lastExec.get(mname) ?? exec;
      const markAfter = exec;
      st.lastExec.set(mname, exec);
      events.push({
        wallet: r.user_address,
        market: mname,
        side: (r.side ?? "").toLowerCase() === "short" ? "short" : "long",
        isOpen: OPEN_TYPES.has(r.accounting_type),
        notionalUsd: Math.abs(Number(r.notional ?? 0)),
        txHash: r.tx_hash,
        timestamp: Date.parse(r.block_timestamp),
        markBefore,
        markAfter,
        indexPrice,
      });
    }
  }

  events.sort((a, b) => a.timestamp - b.timestamp); // process in time order across markets

  const alertRows: Record<string, unknown>[] = [];
  for (const ev of events) {
    for (const alert of st.detector.ingest(ev)) alertRows.push(alertToRow(alert, st.labels));
  }

  const fresh = alertRows.length > 0 ? await dropDuplicates(sb, alertRows) : [];
  if (fresh.length > 0) {
    const { error: insErr } = await sb.from("manipulation_alerts").insert(fresh);
    if (insErr) logger.error({ err: insErr.message }, "monitor: insert alerts failed");
    else logger.warn({ alerts: fresh.length }, "monitor: manipulation alerts raised");

    // Escalate to Slack. Persisted first so the audit record survives even if
    // delivery fails; delivery failures are logged and never abort the pass.
    for (const r of fresh) {
      await dispatchManipulation({
        severity: String(r.severity), kind: String(r.kind), wallet: String(r.wallet), market: String(r.market),
        devBps: Number(r.dev_bps ?? 0), impactBps: Number(r.impact_bps ?? 0),
        notionalUsd: Number(r.notional_usd ?? 0), detail: String(r.detail),
        txHashes: Array.isArray(r.tx_hashes) ? (r.tx_hashes as string[]) : [],
      }).catch((e: unknown) => logger.error({ err: e instanceof Error ? e.message : String(e) }, "manipulation escalation failed"));
    }
  }

  st.cursorIso = rows[rows.length - 1]!.block_timestamp;
  return fresh.length;
}

function freshState(): MonitorState {
  return {
    detector: new ManipulationDetector(),
    labels: buildLabelMap(env.MONITOR_LABEL_WALLETS),
    cursorIso: new Date(Date.now() - env.MONITOR_LOOKBACK_MIN * 60_000).toISOString(),
    lastExec: new Map<string, number>(),
  };
}

/** One-shot pass over the recent lookback window (for testing / cron-style runs). */
export async function runMonitorOnce(): Promise<number> {
  return monitorPass(makeSupabase(), freshState());
}

/** Continuous loop until SIGINT/SIGTERM (the Railway service entrypoint).
 *  Runs two independent checks on their own cadences:
 *    - trade-flow surveillance (Supabase) for market abuse
 *    - protocol health (chain state) for loss events, freezes and stuck liquidations
 *  Health reads chain directly so it survives an indexer outage. */
export async function runMonitor(): Promise<void> {
  // Health monitoring must NOT depend on Supabase being reachable. It reads chain
  // state precisely so it keeps working when the indexer or database is down,
  // which is when an incident is most likely. Treat trade-flow surveillance as
  // optional and degrade to health-only rather than exiting.
  let sb: SupabaseClient | null = null;
  try {
    sb = makeSupabase();
  } catch (e) {
    logger.error(
      { err: e instanceof Error ? e.message : String(e) },
      "monitor: trade-flow surveillance unavailable (no Supabase credentials) — continuing in health-only mode",
    );
  }
  const st = freshState();
  const routineFundingRecipients = new Set(
    [...st.labels.keys()].filter((address) => address !== CONTRACTS.treasury.toLowerCase()),
  );
  const hm = createHealthMonitor();
  const pc = createPublicClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
  const adminState = newAdminWatchState(await pc.getBlockNumber().catch(() => 0n));
  const priceGuard = newPriceGuardState();
  const netMonitor = createNetMonitor();
  const siteMonitor = siteHealthEnabled() ? createSiteMonitor() : null;
  const levConfig = leverageConfigFromEnv();
  let lastHealth = 0;
  let lastAdmin = 0;
  let lastNet = 0;
  let lastSite = 0;
  let lastLeverage = 0;
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  logger.info(
    { pollMs: env.MONITOR_POLL_MS, lookbackMin: env.MONITOR_LOOKBACK_MIN, labeledWallets: st.labels.size },
    "surveillance monitor start",
  );
  await hm.dispatcher.announceStart({
    "Watched accounts": hm.accounts.length,
    "Trade surveillance": sb ? `every ${env.MONITOR_POLL_MS / 1000}s` : "UNAVAILABLE (no DB credentials)",
    "Health poll": `${env.HEALTH_POLL_MS / 1000}s`,
    "Network health poll": `${env.NET_POLL_MS / 1000}s${env.NET_FALLBACK_RPC_URL ? " (+ fallback cross-check)" : ""}`,
    "Site/login health": siteMonitor ? `every ${env.SITE_POLL_MS / 1000}s` : "UNAVAILABLE (no Axiom token or uptime URLs)",
    "Leverage report": sb ? `every ${env.LEVERAGE_POLL_MS / 60000}min` : "UNAVAILABLE (no DB credentials)",
  });

  while (!stopping) {
    if (sb) {
      try {
        const n = await monitorPass(sb, st);
        logger.info({ cursor: st.cursorIso, alerts: n }, "monitor: pass done");
      } catch (e) {
        logger.error({ err: e instanceof Error ? e.message : String(e) }, "monitor: pass failed");
      }
    }

    // Health runs on its own cadence and must never be skipped because the
    // trade-flow pass threw: an indexer outage is exactly when it matters.
    if (Date.now() - lastHealth >= env.HEALTH_POLL_MS) {
      lastHealth = Date.now();
      await healthPass(pc, hm).catch((e: unknown) =>
        logger.error({ err: e instanceof Error ? e.message : String(e) }, "monitor: health pass failed"));
      // Bad-published-price circuit breaker shares the health cadence.
      await priceGuardPass(pc, priceGuard)
        .then((alerts) => { if (alerts.length) logger.warn({ priceAlerts: alerts.length }, "monitor: suspected bad price"); })
        .catch((e: unknown) => logger.error({ err: e instanceof Error ? e.message : String(e) }, "monitor: price guard failed"));
    }

    // Admin-action watch on its own cadence (chain reads; indexer-independent).
    if (Date.now() - lastAdmin >= env.ADMIN_POLL_MS) {
      lastAdmin = Date.now();
      await adminWatchPass(pc, adminState, { routineRecipients: routineFundingRecipients })
        .then((alerts) => { if (alerts.length) logger.warn({ adminAlerts: alerts.length }, "monitor: admin actions alerted"); })
        .catch((e: unknown) => logger.error({ err: e instanceof Error ? e.message : String(e) }, "monitor: admin watch failed"));
    }

    // Network / RPC health on its own cadence. Uses its own bounded clients so a
    // dead or frozen primary endpoint is the signal, not a swallowed exception.
    if (Date.now() - lastNet >= env.NET_POLL_MS) {
      lastNet = Date.now();
      await netHealthPass(netMonitor)
        .catch((e: unknown) => logger.error({ err: e instanceof Error ? e.message : String(e) }, "monitor: net health failed"));
    }

    // Login / site health on its own (slower) cadence: gateway-log rates from
    // Axiom plus external uptime probes. Off-chain, so it degrades independently.
    if (siteMonitor && Date.now() - lastSite >= env.SITE_POLL_MS) {
      lastSite = Date.now();
      await siteHealthPass(siteMonitor)
        .catch((e: unknown) => logger.error({ err: e instanceof Error ? e.message : String(e) }, "monitor: site health failed"));
    }

    // Account-leverage distribution snapshot (RMF Section 11). Needs the DB to
    // enumerate accounts and store the snapshot the monthly report reads.
    if (sb && Date.now() - lastLeverage >= env.LEVERAGE_POLL_MS) {
      lastLeverage = Date.now();
      await leveragePass(pc, sb, levConfig)
        .then((r) => { if (r) logger.info({ share: r.shareAbove80PctCap, accounts: r.accountsWithPositions }, "monitor: leverage snapshot"); })
        .catch((e: unknown) => logger.error({ err: e instanceof Error ? e.message : String(e) }, "monitor: leverage pass failed"));
    }

    await sleepUntil(env.MONITOR_POLL_MS, () => stopping);
  }
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  logger.info("surveillance monitor stopped");
}
