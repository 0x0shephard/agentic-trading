// 5-year log-retention export (RMF 1c).
//
// A scheduled job pulls each complete UTC day of security/access logs from the
// sources whose provider retention is far short of five years, and lands them as
// newline-delimited JSON in an immutable, Object-Locked R2 bucket. Provider
// retention is the reason this exists; the archive is the system of record.
//
// Sources (v1): gateway request logs (Axiom) and auth events (Supabase). Admin
// actions are exported from chain for completeness, though the chain is itself a
// permanent immutable record. Third-party provider audit logs (Cloudflare,
// GitHub, Sentry) are a documented follow-up — each is a separate, lower-frequency
// export.
//
// Layout: one object per source per day, `<source>/YYYY-MM-DD.ndjson`, plus a
// per-day `_manifest/YYYY-MM-DD.json` proving the run happened even when a source
// was empty. The job exports the PREVIOUS complete day and skips any object that
// already exists, so it never tries to overwrite a locked object.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import type { PublicClient } from "viem";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import { axiomQuery, axiomConfigured, axiomDataset } from "./axiom";
import { R2Client } from "./r2";
import { ADMIN_EVENTS, getLogsChunked } from "../surveillance/alerting/adminwatch";

export const LOG_EXPORT_VERSION = "1";

// ── Day math ─────────────────────────────────────────────────────────────────

export interface DayBounds { date: string; startIso: string; endIso: string; startSec: number; endSec: number }

/** [00:00:00, next 00:00:00) for a UTC calendar day. endSec/endIso are exclusive. */
export function dayBounds(date: string): DayBounds {
  const start = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`invalid date "${date}" (want YYYY-MM-DD)`);
  const end = new Date(start.getTime() + 86_400_000);
  return {
    date,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    startSec: Math.floor(start.getTime() / 1000),
    endSec: Math.floor(end.getTime() / 1000),
  };
}

/** The previous complete UTC day, e.g. "2026-07-25". */
export function previousUtcDay(now = new Date()): string {
  const midnightToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnightToday - 86_400_000).toISOString().slice(0, 10);
}

// ── NDJSON ───────────────────────────────────────────────────────────────────

const bigintReplacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);

export function toNdjson(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  return rows.map((r) => JSON.stringify(r, bigintReplacer)).join("\n") + "\n";
}

// ── Sources ──────────────────────────────────────────────────────────────────

export interface LogSource {
  name: string;
  available: boolean;
  fetch: (b: DayBounds) => Promise<Record<string, unknown>[]>;
}

const GATEWAY_ROW_LIMIT = 500_000;

async function fetchGateway(b: DayBounds): Promise<Record<string, unknown>[]> {
  const rows = await axiomQuery(
    `['${axiomDataset()}'] | sort by _time asc | limit ${GATEWAY_ROW_LIMIT}`,
    b.startIso, b.endIso,
  );
  if (rows.length >= GATEWAY_ROW_LIMIT) {
    logger.warn({ date: b.date, rows: rows.length }, "logexport: gateway row limit hit — day may be truncated");
  }
  return rows;
}

async function fetchAuth(sb: SupabaseClient, b: DayBounds): Promise<Record<string, unknown>[]> {
  // auth.audit_log_entries is not in the public schema, so it is read via a
  // security-definer RPC (see migration add_auth_audit_export.sql).
  const { data, error } = await sb.rpc("admin_export_auth_audit", { from_ts: b.startIso, to_ts: b.endIso });
  if (error) throw new Error(`auth audit rpc: ${error.message}`);
  return (data ?? []) as Record<string, unknown>[];
}

const SEPOLIA_AVG_BLOCK_SEC = 12;

/** Admin-key actions in the day, decoded from chain. The block range is
 *  approximated from average block time, then each hit is filtered precisely by
 *  its block timestamp — admin events are rare, so the per-hit getBlock is cheap. */
async function fetchAdmin(pc: PublicClient, b: DayBounds): Promise<Record<string, unknown>[]> {
  const head = await pc.getBlockNumber();
  const headBlock = await pc.getBlock({ blockNumber: head });
  const headSec = Number(headBlock.timestamp);
  const blocksPerDay = BigInt(Math.ceil(86_400 / SEPOLIA_AVG_BLOCK_SEC)); // ~7200
  const pad = blocksPerDay / 10n; // widen 10% against block-time variance

  const behindEnd = Math.max(0, Math.floor((headSec - b.endSec) / SEPOLIA_AVG_BLOCK_SEC));
  let endBlock = head - BigInt(behindEnd) + pad;
  let startBlock = endBlock - blocksPerDay - 2n * pad;
  if (endBlock > head) endBlock = head;
  if (startBlock < 0n) startBlock = 0n;

  const records: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const tsCache = new Map<string, number>();

  for (const def of ADMIN_EVENTS) {
    const logs = await getLogsChunked(pc, def.contract, def.event, startBlock, endBlock);
    for (const lg of logs) {
      const id = `${lg.transactionHash}:${lg.logIndex}`;
      if (seen.has(id)) continue;
      const bnKey = lg.blockNumber.toString();
      let ts = tsCache.get(bnKey);
      if (ts === undefined) {
        ts = Number((await pc.getBlock({ blockNumber: lg.blockNumber })).timestamp);
        tsCache.set(bnKey, ts);
      }
      if (ts < b.startSec || ts >= b.endSec) continue; // precise day filter
      seen.add(id);
      records.push({
        _time: new Date(ts * 1000).toISOString(),
        contract: def.contract,
        contractLabel: def.label,
        event: def.title,
        severity: def.severity,
        description: def.describe(lg.args),
        txHash: lg.transactionHash,
        logIndex: lg.logIndex,
        blockNumber: lg.blockNumber,
        args: lg.args,
      });
    }
  }
  records.sort((x, y) => String(x._time).localeCompare(String(y._time)));
  return records;
}

function makeSupabaseOrNull(): SupabaseClient | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

export function createSources(): LogSource[] {
  const sb = makeSupabaseOrNull();
  const pc = createPublicClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
  return [
    { name: "gateway", available: axiomConfigured(), fetch: fetchGateway },
    { name: "auth", available: Boolean(sb), fetch: (b) => fetchAuth(sb as SupabaseClient, b) },
    { name: "admin", available: true, fetch: (b) => fetchAdmin(pc, b) },
  ];
}

// ── Sink ─────────────────────────────────────────────────────────────────────

export interface ExportSink {
  kind: "r2" | "dryrun";
  exists: (key: string) => Promise<boolean>;
  write: (key: string, body: string) => Promise<void>;
}

export function r2Sink(client: R2Client): ExportSink {
  return { kind: "r2", exists: (k) => client.exists(k), write: (k, b) => client.put(k, b) };
}

/** Local sink for the dry run: writes the same object tree to a directory and
 *  never skips, so re-running refreshes the preview. */
export function dryRunSink(dir: string): ExportSink {
  return {
    kind: "dryrun",
    exists: async () => false,
    write: async (key, body) => {
      const p = join(dir, key);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    },
  };
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface ExportOutcome {
  source: string;
  key: string;
  rows: number;
  bytes: number;
  status: "written" | "skipped-exists" | "empty" | "unavailable" | "error";
  detail?: string;
}

export async function runExport(date: string, sources: LogSource[], sink: ExportSink): Promise<ExportOutcome[]> {
  const b = dayBounds(date);
  const outcomes: ExportOutcome[] = [];

  for (const src of sources) {
    const key = `${src.name}/${date}.ndjson`;
    if (!src.available) {
      outcomes.push({ source: src.name, key, rows: 0, bytes: 0, status: "unavailable", detail: "source not configured" });
      continue;
    }
    try {
      if (await sink.exists(key)) {
        outcomes.push({ source: src.name, key, rows: 0, bytes: 0, status: "skipped-exists" });
        continue;
      }
      const rows = await src.fetch(b);
      if (rows.length === 0) {
        outcomes.push({ source: src.name, key, rows: 0, bytes: 0, status: "empty" });
        continue;
      }
      const body = toNdjson(rows);
      await sink.write(key, body);
      outcomes.push({ source: src.name, key, rows: rows.length, bytes: Buffer.byteLength(body), status: "written" });
    } catch (e) {
      outcomes.push({ source: src.name, key, rows: 0, bytes: 0, status: "error", detail: e instanceof Error ? e.message : String(e) });
    }
  }

  // Per-day manifest: proves the run happened and records coverage even when a
  // source was empty. Written once (skipped if the day was already archived).
  const manifestKey = `_manifest/${date}.json`;
  if (!(await sink.exists(manifestKey))) {
    const manifest = JSON.stringify({ date, version: LOG_EXPORT_VERSION, exportedAt: new Date().toISOString(), sink: sink.kind, outcomes }, null, 2);
    await sink.write(manifestKey, manifest);
  }

  return outcomes;
}
