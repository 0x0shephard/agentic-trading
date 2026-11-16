// RPC call accounting.
//
// Wraps a viem transport so every JSON-RPC request is counted by method and by
// label (which client issued it), and counts the underlying HTTP requests
// separately (retries included), which is what the RPC provider bills. A
// periodic `RPC_STATS` log line reports the counts since the previous line, so
// the RPC budget can be checked from the service logs.
import type { Transport } from "viem";
import { logger } from "../logging/logger";

interface Counters {
  /** JSON-RPC requests by "label:method". */
  calls: Map<string, number>;
  /** Failed JSON-RPC requests (after the transport's own retries). */
  errors: number;
  /** HTTP requests actually sent, retries included. */
  http: number;
}

const fresh = (): Counters => ({ calls: new Map(), errors: 0, http: 0 });
let window: Counters = fresh();
let windowStart = Date.now();
const lifetime: Counters = fresh();

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Hook for viem's http({ onFetchRequest }): counts each HTTP request sent. */
export function countHttpRequest(): void {
  window.http++;
  lifetime.http++;
}

/** Wrap a transport so each request is counted under `label`. */
export function countedTransport(transport: Transport, label: string): Transport {
  return ((params: Parameters<Transport>[0]) => {
    const t = transport(params);
    const request = (async (args: { method: string; params?: unknown }, opts?: unknown) => {
      const key = `${label}:${args.method}`;
      bump(window.calls, key);
      bump(lifetime.calls, key);
      try {
        return await (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, opts);
      } catch (e) {
        window.errors++;
        lifetime.errors++;
        throw e;
      }
    }) as typeof t.request;
    return { ...t, request };
  }) as Transport;
}

function total(m: Map<string, number>): number {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}

/** Log the counts since the previous call and start a new window. */
export function logRpcStats(): void {
  const now = Date.now();
  const mins = Math.max((now - windowStart) / 60_000, 1e-9);
  const calls = total(window.calls);
  logger.info(
    {
      windowMin: Number(mins.toFixed(1)),
      calls,
      http: window.http,
      errors: window.errors,
      perHour: Math.round((calls / mins) * 60),
      httpPerHour: Math.round((window.http / mins) * 60),
      byMethod: Object.fromEntries([...window.calls.entries()].sort((a, b) => b[1] - a[1])),
      lifetimeCalls: total(lifetime.calls),
      lifetimeHttp: lifetime.http,
    },
    "RPC_STATS",
  );
  window = fresh();
  windowStart = now;
}

/** Emit RPC_STATS every `intervalMs` (default 10 min). Returns a stop function. */
export function startRpcStatsLogger(intervalMs = 10 * 60_000): () => void {
  windowStart = Date.now();
  const timer = setInterval(logRpcStats, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
