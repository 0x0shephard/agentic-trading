// Protocol health checks, read directly from chain state.
//
// Deliberately independent of the indexer and Supabase. Bad debt, InsuranceFund
// balance, oracle freshness and liquidatable positions are all on-chain facts, so
// these checks keep working during exactly the incident that would stall the
// indexer. Manipulation detection (which needs the trade feed) stays separate.
//
// Thresholds come from the RMF Appendix F stress runs:
//   - bad debt and InsuranceFund.totalPaid both have a verified baseline of ZERO,
//     so any non-zero value is unambiguous and worth paging on.
//   - a market freezes for ALL participants once its index exceeds maxAge
//     (12h on every deployed market), so approaching that is the leading signal.
//   - basis is judged against each market's own recent baseline, never an absolute
//     threshold: B200 trades at -1,986 bps in normal conditions and a fixed
//     trigger would fire permanently and be muted.
import { formatUnits, parseAbi } from "viem";
import type { Address, PublicClient } from "viem";
import { CONTRACTS } from "../../config/addresses";
import { MARKETS } from "../../config/markets";
import type { MarketDef } from "../../config/markets";
import type { Severity } from "./slack";
import { logger } from "../../logging/logger";

const CH = parseAbi([
  "function totalBadDebt() view returns (uint256)",
  "function isLiquidatable(address,bytes32) view returns (bool)",
  "function getPosition(address,bytes32) view returns ((int256 size, uint256 margin, uint256 entryPriceX18, uint256 lastFundingPayIndex, uint256 lastFundingReceiveIndex, int256 realizedPnL))",
]);
const IF = parseAbi([
  "function balance() view returns (uint256)",
  "function totalPaid() view returns (uint256)",
]);
const MR = parseAbi([
  "function getMarket(bytes32) view returns ((address vamm, uint16 feeBps, bool paused, address oracle, address feeRouter, address insuranceFund, address baseAsset, address quoteToken, uint256 baseUnit))",
]);
const ADAPTER = parseAbi([
  "function cuOracle() view returns (address)",
  "function assetId() view returns (bytes32)",
  "function maxAge() view returns (uint256)",
  "function getPrice() view returns (uint256)",
]);
const CU = parseAbi(["function getLatestPrice(bytes32) view returns ((uint256 price, uint256 lastUpdatedAt))"]);
const VAMM = parseAbi(["function getMarkPrice() view returns (uint256)"]);

/**
 * Known, accepted conditions that must NOT alert.
 *
 * Documented rather than silently skipped: each entry states what is suppressed
 * and why, so the suppression list is itself auditable. Anything not listed here
 * still alerts, so suppressing a known instance does not disable the check class.
 */
export const SUPPRESSED = {
  /** Positions that report liquidatable but revert NotLiquidatable (finding #2).
   *  Tracked separately; alerting on them would make the channel permanently noisy. */
  stuckLiquidatable: new Set<string>([
    "0xfcd71144a97adc78f3f74e7e8d77b2c9b3122e55|T4-PERP",
    "0x6330a8325ea1d80264178b1378694ad1522454ac|T4-PERP",
  ]),
  /** Markets whose index publisher runs on a slow cadence, so high staleness is
   *  normal operation rather than a fault. The CRITICAL threshold still applies:
   *  approaching the freeze boundary matters regardless of cadence. */
  slowFeedMarkets: new Set<string>(["T4-PERP"]),
} as const;

/** Fraction of maxAge at which staleness becomes critical (market freeze is near). */
const STALE_CRITICAL_FRAC = 0.9;
/** Fraction of maxAge at which staleness is worth an early warning. */
const STALE_WARNING_FRAC = 0.7;
/** Basis move, in bps, away from the market's own rolling baseline. */
const BASIS_DEVIATION_BPS = 500;

export interface HealthSignal {
  /** Stable identity for this condition; drives transition and cooldown logic. */
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  fields: Record<string, string | number>;
}

export interface HealthState {
  /** Rolling basis baseline per market, so deviation is measured not absolutes. */
  basisBaseline: Map<string, number>;
  lastBadDebt: bigint | null;
  lastTotalPaid: bigint | null;
}

export function newHealthState(): HealthState {
  return { basisBaseline: new Map(), lastBadDebt: null, lastTotalPaid: null };
}

const x18 = (v: bigint) => Number(formatUnits(v, 18));

/** Run every health check once. Returns the conditions currently true. */
export async function checkHealth(
  pc: PublicClient,
  st: HealthState,
  accounts: readonly Address[],
  markets: readonly MarketDef[] = MARKETS,
): Promise<HealthSignal[]> {
  const out: HealthSignal[] = [];

  // ── Loss events: baseline is a verified zero, so any value is significant ──
  try {
    const badDebt = (await pc.readContract({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "totalBadDebt" })) as bigint;
    if (badDebt > 0n && (st.lastBadDebt === null || badDebt > st.lastBadDebt)) {
      out.push({
        key: "bad-debt",
        severity: "critical",
        title: "Bad debt recorded",
        detail: "Uncovered loss beyond the InsuranceFund. Baseline for this metric is zero, so any value indicates a liquidation shortfall the fund did not absorb.",
        fields: { "Total bad debt": x18(badDebt).toFixed(6), Previous: st.lastBadDebt === null ? "unknown" : x18(st.lastBadDebt).toFixed(6) },
      });
    }
    st.lastBadDebt = badDebt;
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "health: totalBadDebt read failed");
  }

  try {
    const [bal, paid] = (await Promise.all([
      pc.readContract({ address: CONTRACTS.insuranceFund, abi: IF, functionName: "balance" }),
      pc.readContract({ address: CONTRACTS.insuranceFund, abi: IF, functionName: "totalPaid" }),
    ])) as [bigint, bigint];
    if (paid > 0n && (st.lastTotalPaid === null || paid > st.lastTotalPaid)) {
      out.push({
        key: "if-draw",
        severity: "critical",
        title: "InsuranceFund paid out",
        detail: "The InsuranceFund covered a liquidation shortfall. It has never paid out before, so this is the first drawdown of protocol loss-absorbing capital.",
        fields: {
          "Total paid": `${Number(formatUnits(paid, 6)).toFixed(2)} USDC`,
          "Fund balance": `${Number(formatUnits(bal, 6)).toFixed(2)} USDC`,
          Previous: st.lastTotalPaid === null ? "unknown" : `${Number(formatUnits(st.lastTotalPaid, 6)).toFixed(2)} USDC`,
        },
      });
    }
    st.lastTotalPaid = paid;
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "health: InsuranceFund read failed");
  }

  // ── Per-market: oracle freshness, availability, pause, basis ──────────────
  for (const m of markets) {
    let cfg: { vamm: Address; oracle: Address; paused: boolean };
    try {
      cfg = (await pc.readContract({ address: CONTRACTS.marketRegistry, abi: MR, functionName: "getMarket", args: [m.marketId] })) as typeof cfg;
    } catch { continue; }

    if (cfg.paused) {
      out.push({
        key: `paused:${m.name}`,
        severity: "warning",
        title: `Market paused: ${m.name}`,
        detail: "Trading is halted on this market.",
        fields: { Market: m.name },
      });
    }

    // Index freshness. A market freezes entirely once age exceeds maxAge.
    try {
      const [cu, assetId, maxAge] = (await Promise.all([
        pc.readContract({ address: cfg.oracle, abi: ADAPTER, functionName: "cuOracle" }),
        pc.readContract({ address: cfg.oracle, abi: ADAPTER, functionName: "assetId" }),
        pc.readContract({ address: cfg.oracle, abi: ADAPTER, functionName: "maxAge" }),
      ])) as [Address, `0x${string}`, bigint];

      const pd = (await pc.readContract({ address: cu, abi: CU, functionName: "getLatestPrice", args: [assetId] })) as { price: bigint; lastUpdatedAt: bigint };
      const ageSec = Math.floor(Date.now() / 1000) - Number(pd.lastUpdatedAt);
      const frac = Number(maxAge) > 0 ? ageSec / Number(maxAge) : 0;
      const hrs = (ageSec / 3600).toFixed(1);
      const limitHrs = (Number(maxAge) / 3600).toFixed(1);

      if (frac >= STALE_CRITICAL_FRAC) {
        out.push({
          key: `stale-critical:${m.name}`,
          severity: "critical",
          title: `Index near freeze: ${m.name}`,
          detail: `Index price is ${hrs}h old against a ${limitHrs}h limit. When the limit is passed the market freezes: no position can be closed and no liquidation can occur, for every participant, until the feed is restored.`,
          fields: { Market: m.name, "Index age": `${hrs}h`, Limit: `${limitHrs}h`, "Time to freeze": `${((Number(maxAge) - ageSec) / 3600).toFixed(1)}h` },
        });
      } else if (frac >= STALE_WARNING_FRAC && !SUPPRESSED.slowFeedMarkets.has(m.name)) {
        out.push({
          key: `stale-warning:${m.name}`,
          severity: "warning",
          title: `Index ageing: ${m.name}`,
          detail: `Index price is ${hrs}h old against a ${limitHrs}h limit.`,
          fields: { Market: m.name, "Index age": `${hrs}h`, Limit: `${limitHrs}h` },
        });
      }
    } catch (e) {
      logger.warn({ market: m.name, err: e instanceof Error ? e.message : String(e) }, "health: index freshness read failed");
    }

    // Oracle availability and basis.
    let indexPrice: number | null = null;
    try {
      indexPrice = x18((await pc.readContract({ address: cfg.oracle, abi: ADAPTER, functionName: "getPrice" })) as bigint);
    } catch {
      out.push({
        key: `oracle-down:${m.name}`,
        severity: "critical",
        title: `Market frozen: ${m.name}`,
        detail: "The index oracle is refusing to serve a price. All positions in this market are currently impossible to close and liquidation is disabled.",
        fields: { Market: m.name },
      });
    }

    if (indexPrice !== null && indexPrice > 0) {
      try {
        const mark = x18((await pc.readContract({ address: cfg.vamm, abi: VAMM, functionName: "getMarkPrice" })) as bigint);
        const basis = ((mark - indexPrice) / indexPrice) * 10_000;
        const base = st.basisBaseline.get(m.name);
        if (base !== undefined && Math.abs(basis - base) >= BASIS_DEVIATION_BPS) {
          out.push({
            key: `basis:${m.name}`,
            severity: "warning",
            title: `Basis moved sharply: ${m.name}`,
            detail: `Mark-to-index basis moved ${(basis - base).toFixed(0)} bps from its recent level. Measured as deviation from this market's own baseline, not an absolute threshold.`,
            fields: { Market: m.name, Mark: mark.toFixed(4), Index: indexPrice.toFixed(4), "Basis now": `${basis.toFixed(0)} bps`, "Baseline": `${base.toFixed(0)} bps` },
          });
        }
        // Slow-moving baseline so a genuine step change registers but drift does not.
        st.basisBaseline.set(m.name, base === undefined ? basis : base * 0.9 + basis * 0.1);
      } catch { /* mark unreadable; skip basis this cycle */ }
    }
  }

  // ── Liquidatable positions that are not being cleared ────────────────────
  // Batched via multicall: scanning accounts x markets sequentially is hundreds
  // of round trips per pass, which is far too slow for a 60s poll and needlessly
  // heavy on the RPC endpoint.
  let stuck = 0;
  const stuckDetail: string[] = [];
  if (accounts.length > 0) {
    const calls = accounts.flatMap((a) =>
      markets.map((m) => ({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "isLiquidatable" as const, args: [a, m.marketId] })));
    try {
      const res = (await pc.multicall({ contracts: calls as never, allowFailure: true })) as unknown as
        { status: string; result: unknown }[];
      res.forEach((r, i) => {
        if (r.status !== "success" || r.result !== true) return;
        const account = accounts[Math.floor(i / markets.length)]!;
        const m = markets[i % markets.length]!;
        if (SUPPRESSED.stuckLiquidatable.has(`${account.toLowerCase()}|${m.name}`)) return;
        stuck++;
        if (stuckDetail.length < 5) stuckDetail.push(`${account.slice(0, 10)} ${m.name}`);
      });
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : String(e) }, "health: liquidatable scan failed");
    }
  }
  if (stuck > 0) {
    out.push({
      key: "liquidatable-backlog",
      severity: "warning",
      title: `${stuck} liquidatable position(s) not cleared`,
      detail: "Positions are below maintenance margin and have not been liquidated. Liquidation is permissioned, so this may indicate the whitelisted keeper is not running.",
      fields: { Count: stuck, Positions: stuckDetail.join(", ") || "n/a" },
    });
  }

  return out;
}
