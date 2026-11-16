// Batched chain reads shared by the health check, the price guard and the
// trade-flow surveillance.
//
// Two tiers:
//   - STATIC  values that only change with an admin action (each market's vAMM
//     and oracle adapter addresses, and the adapter's cuOracle, assetId and
//     maxAge). Loaded with two multicalls and refreshed every STATIC_REFRESH_MS,
//     or sooner when a market is incomplete or its addresses change.
//   - DYNAMIC everything a pass evaluates (protocol loss counters, getMarket for
//     the pause flag and address-change detection, CuOracle.getLatestPrice,
//     adapter getPrice, vAMM getMarkPrice). One multicall per snapshot.
//
// Every read uses allowFailure, so a reverting call is reported per-item exactly
// as the old one-call-at-a-time code saw it (a revert on getPrice is still an
// unavailable oracle). If the whole multicall fails (RPC down), every item is
// reported as failed, which matches the old behaviour of each read throwing.
import { parseAbi } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { CONTRACTS } from "../../config/addresses";
import { MARKETS } from "../../config/markets";
import type { MarketDef } from "../../config/markets";
import { logger } from "../../logging/logger";

export const CH_ABI = parseAbi([
  "function totalBadDebt() view returns (uint256)",
  "function isLiquidatable(address,bytes32) view returns (bool)",
]);
const IF_ABI = parseAbi([
  "function balance() view returns (uint256)",
  "function totalPaid() view returns (uint256)",
]);
const MR_ABI = parseAbi([
  "function getMarket(bytes32) view returns ((address vamm, uint16 feeBps, bool paused, address oracle, address feeRouter, address insuranceFund, address baseAsset, address quoteToken, uint256 baseUnit))",
]);
const ADAPTER_ABI = parseAbi([
  "function cuOracle() view returns (address)",
  "function assetId() view returns (bytes32)",
  "function maxAge() view returns (uint256)",
  "function getPrice() view returns (uint256)",
]);
const CU_ABI = parseAbi(["function getLatestPrice(bytes32) view returns ((uint256 price, uint256 lastUpdatedAt))"]);
const VAMM_ABI = parseAbi(["function getMarkPrice() view returns (uint256)"]);

/** Calldata bytes per eth_call chunk. Large enough that a full pass is one
 *  eth_call (viem's default of 1 KiB would split it into many). */
export const MULTICALL_BATCH_BYTES = 64 * 1024;

const ZERO: Address = "0x0000000000000000000000000000000000000000";

type Call = { address: Address; abi: unknown; functionName: string; args?: readonly unknown[] };
type CallResult = { ok: true; value: unknown } | { ok: false };

/** Run calls in one multicall with per-item failure. A transport error marks every item failed. */
export async function multicallAll(pc: PublicClient, calls: Call[], batchSize = MULTICALL_BATCH_BYTES): Promise<CallResult[]> {
  if (calls.length === 0) return [];
  try {
    const res = (await pc.multicall({ contracts: calls as never, allowFailure: true, batchSize })) as unknown as
      { status: string; result: unknown }[];
    return res.map((r) => (r.status === "success" ? { ok: true as const, value: r.result } : { ok: false as const }));
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message.split("\n")[0] : String(e), calls: calls.length }, "chain: multicall failed");
    return calls.map(() => ({ ok: false as const }));
  }
}

export interface MarketStatic {
  vamm: Address;
  oracle: Address;
  /** Adapter values; undefined when the adapter read failed (retried next pass). */
  adapter?: { cuOracle: Address; assetId: Hex; maxAge: bigint };
}

export interface StaticCache {
  loadedAt: number;
  /** Keyed by market name; absent when getMarket failed (retried next pass). */
  markets: Map<string, MarketStatic>;
}

export interface MarketSnap {
  /** getMarket at snapshot time; null when the read failed (market skipped). */
  cfg: { vamm: Address; oracle: Address; paused: boolean } | null;
  /** Adapter static values; null when unavailable (freshness check cannot run). */
  adapter: { cuOracle: Address; assetId: Hex; maxAge: bigint } | null;
  /** CuOracle.getLatestPrice; null when unavailable. */
  latest: { price: bigint; lastUpdatedAt: bigint } | null;
  /** Adapter getPrice() (x18); null when the adapter refused to serve. */
  indexPriceX18: bigint | null;
  /** vAMM getMarkPrice() (x18); null when unreadable. */
  markPriceX18: bigint | null;
}

export interface ChainSnapshot {
  takenAt: number;
  badDebt: bigint | null;
  ifBalance: bigint | null;
  ifTotalPaid: bigint | null;
  /** Keyed by market name. */
  markets: Map<string, MarketSnap>;
}

/** Holds the static cache and the latest dynamic snapshot. */
export class ChainReader {
  private cache: StaticCache | null = null;
  private last: ChainSnapshot | null = null;

  constructor(
    private readonly pc: PublicClient,
    private readonly markets: readonly MarketDef[] = MARKETS,
    private readonly staticRefreshMs = 3_600_000,
  ) {}

  /** Latest snapshot, if taken within `maxAgeMs`. */
  latest(maxAgeMs = Number.POSITIVE_INFINITY): ChainSnapshot | null {
    if (!this.last || Date.now() - this.last.takenAt > maxAgeMs) return null;
    return this.last;
  }

  private staticStale(): boolean {
    if (!this.cache) return true;
    if (Date.now() - this.cache.loadedAt >= this.staticRefreshMs) return true;
    // Incomplete entries are retried on the next pass rather than after an hour.
    return this.markets.some((m) => {
      const s = this.cache!.markets.get(m.name);
      return !s || (!s.adapter && s.oracle !== ZERO);
    });
  }

  /** Load per-market static values (two multicalls). */
  async loadStatic(): Promise<StaticCache> {
    const cfgRes = await multicallAll(this.pc, this.markets.map((m) => ({
      address: CONTRACTS.marketRegistry, abi: MR_ABI, functionName: "getMarket", args: [m.marketId],
    })));
    const markets = new Map<string, MarketStatic>();
    const withOracle: { name: string; oracle: Address }[] = [];
    this.markets.forEach((m, i) => {
      const r = cfgRes[i]!;
      if (!r.ok) return;
      const cfg = r.value as { vamm: Address; oracle: Address };
      markets.set(m.name, { vamm: cfg.vamm, oracle: cfg.oracle });
      if (cfg.oracle && cfg.oracle !== ZERO) withOracle.push({ name: m.name, oracle: cfg.oracle });
    });

    const adRes = await multicallAll(this.pc, withOracle.flatMap(({ oracle }) => [
      { address: oracle, abi: ADAPTER_ABI, functionName: "cuOracle" },
      { address: oracle, abi: ADAPTER_ABI, functionName: "assetId" },
      { address: oracle, abi: ADAPTER_ABI, functionName: "maxAge" },
    ]));
    withOracle.forEach(({ name }, i) => {
      const [cu, id, age] = [adRes[i * 3]!, adRes[i * 3 + 1]!, adRes[i * 3 + 2]!];
      if (cu.ok && id.ok && age.ok) {
        markets.get(name)!.adapter = { cuOracle: cu.value as Address, assetId: id.value as Hex, maxAge: age.value as bigint };
      }
    });

    this.cache = { loadedAt: Date.now(), markets };
    logger.info({ markets: markets.size, of: this.markets.length }, "chain: static market cache loaded");
    return this.cache;
  }

  /** Take a fresh dynamic snapshot (one multicall; static values from the cache). */
  async snapshot(): Promise<ChainSnapshot> {
    if (this.staticStale()) await this.loadStatic();
    let snap = await this.takeDynamic(this.cache!);
    // A market's vAMM or oracle changed since the cache was loaded: reload and
    // read again so no check runs against a retired contract.
    if (this.addressesChanged(snap)) {
      logger.warn("chain: market addresses changed; reloading static cache");
      await this.loadStatic();
      snap = await this.takeDynamic(this.cache!);
    }
    this.last = snap;
    return snap;
  }

  private addressesChanged(snap: ChainSnapshot): boolean {
    for (const [name, ms] of snap.markets) {
      const s = this.cache!.markets.get(name);
      if (ms.cfg && s && (ms.cfg.vamm.toLowerCase() !== s.vamm.toLowerCase() || ms.cfg.oracle.toLowerCase() !== s.oracle.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  private async takeDynamic(cache: StaticCache): Promise<ChainSnapshot> {
    const calls: Call[] = [
      { address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "totalBadDebt" },
      { address: CONTRACTS.insuranceFund, abi: IF_ABI, functionName: "balance" },
      { address: CONTRACTS.insuranceFund, abi: IF_ABI, functionName: "totalPaid" },
    ];
    // Per market: index of each call in `calls` (-1 when not issued).
    const idx: { cfg: number; latest: number; price: number; mark: number }[] = [];
    for (const m of this.markets) {
      const s = cache.markets.get(m.name);
      const push = (c: Call) => calls.push(c) - 1;
      const cfg = push({ address: CONTRACTS.marketRegistry, abi: MR_ABI, functionName: "getMarket", args: [m.marketId] });
      if (!s) { idx.push({ cfg, latest: -1, price: -1, mark: -1 }); continue; }
      idx.push({
        cfg,
        latest: s.adapter ? push({ address: s.adapter.cuOracle, abi: CU_ABI, functionName: "getLatestPrice", args: [s.adapter.assetId] }) : -1,
        price: push({ address: s.oracle, abi: ADAPTER_ABI, functionName: "getPrice" }),
        mark: push({ address: s.vamm, abi: VAMM_ABI, functionName: "getMarkPrice" }),
      });
    }

    const res = await multicallAll(this.pc, calls);
    const val = <T>(i: number): T | null => (i >= 0 && res[i]!.ok ? ((res[i] as { value: unknown }).value as T) : null);

    const markets = new Map<string, MarketSnap>();
    this.markets.forEach((m, i) => {
      const k = idx[i]!;
      const cfg = val<{ vamm: Address; oracle: Address; paused: boolean }>(k.cfg);
      const s = cache.markets.get(m.name);
      markets.set(m.name, {
        cfg: cfg && s ? { vamm: cfg.vamm, oracle: cfg.oracle, paused: cfg.paused } : null,
        adapter: s?.adapter ?? null,
        latest: val<{ price: bigint; lastUpdatedAt: bigint }>(k.latest),
        indexPriceX18: val<bigint>(k.price),
        markPriceX18: val<bigint>(k.mark),
      });
    });

    return {
      takenAt: Date.now(),
      badDebt: val<bigint>(0),
      ifBalance: val<bigint>(1),
      ifTotalPaid: val<bigint>(2),
      markets,
    };
  }
}

/** Readers keyed by client, so callers that only have a PublicClient share one cache. */
const readers = new WeakMap<PublicClient, ChainReader>();

export function readerFor(pc: PublicClient, markets: readonly MarketDef[] = MARKETS, staticRefreshMs?: number): ChainReader {
  if (markets !== MARKETS) return new ChainReader(pc, markets, staticRefreshMs); // ad-hoc subsets are not shared
  let r = readers.get(pc);
  if (!r) {
    r = new ChainReader(pc, markets, staticRefreshMs);
    readers.set(pc, r);
  }
  return r;
}
