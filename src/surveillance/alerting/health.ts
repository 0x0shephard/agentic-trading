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
  /** Two T4 positions whose accounts hold ample free vault collateral, so the
   *  protocol correctly declines to liquidate them. They are solvent and carry no
   *  loss exposure; alerting on them would make the channel permanently noisy. */
  stuckLiquidatable: new Set<string>([
    "0xfcd71144a97adc78f3f74e7e8d77b2c9b3122e55|T4-PERP",
    "0x6330a8325ea1d80264178b1378694ad1522454ac|T4-PERP",
  ]),
  /** Markets whose index publisher runs on a slow cadence, so high staleness is
   *  normal operation rather than a fault. The CRITICAL threshold still applies:
   *  approaching the freeze boundary matters regardless of cadence. */
  slowFeedMarkets: new Set<string>(["T4-PERP"]),
} as const;

// Freshness thresholds, as fractions of each market's 12h maxAge, per the doc's
// "warn at half the ceiling, urgent at three quarters" (6h warn, 9h critical).
const STALE_CRITICAL_FRAC = 0.75; // 9h
const STALE_WARNING_FRAC = 0.5; //   6h
/** Basis MOVE, in bps, away from the market's own rolling baseline (catches moves). */
const BASIS_DEVIATION_BPS = 500;
/** Absolute basis (bps) that, if SUSTAINED, is a large-dislocation alert. Set
 *  above the known structural discounts (~13-20%) so those do not fire; a market
 *  blowing out past this is genuinely new. */
const SUSTAINED_BASIS_BPS = 2500; // 25%
/** Consecutive samples the absolute basis must stay breached to count as sustained. */
const SUSTAINED_BASIS_SAMPLES = 3;
/** A position must be liquidatable this long before it alerts (the keeper has had
 *  time to act; a persistent one means the keeper missed it). */
const LIQUIDATABLE_DWELL_MS = 15 * 60_000;

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
  /** Consecutive samples each market's |basis| has exceeded SUSTAINED_BASIS_BPS. */
  basisBreachCount: Map<string, number>;
  /** First time each liquidatable position (account|market) was seen, for the dwell timer. */
  liquidatableSince: Map<string, number>;
  lastBadDebt: bigint | null;
  lastTotalPaid: bigint | null;
}

export function newHealthState(): HealthState {
  return { basisBaseline: new Map(), basisBreachCount: new Map(), liquidatableSince: new Map(), lastBadDebt: null, lastTotalPaid: null };
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
            key: `basis-move:${m.name}`,
            severity: "warning",
            title: `Basis moved sharply: ${m.name}`,
            detail: `Mark-to-index basis moved ${(basis - base).toFixed(0)} bps from its recent level. Measured as deviation from this market's own baseline, not an absolute threshold.`,
            fields: { Market: m.name, Mark: mark.toFixed(4), Index: indexPrice.toFixed(4), "Basis now": `${basis.toFixed(0)} bps`, "Baseline": `${base.toFixed(0)} bps` },
          });
        }
        // Slow-moving baseline so a genuine step change registers but drift does not.
        st.basisBaseline.set(m.name, base === undefined ? basis : base * 0.9 + basis * 0.1);

        // Sustained large gap: an absolute dislocation held over several samples.
        // Threshold is set above the known structural discounts so those do not
        // fire; only a genuinely new blow-out does. Counted in consecutive samples.
        const breached = Math.abs(basis) >= SUSTAINED_BASIS_BPS;
        const count = breached ? (st.basisBreachCount.get(m.name) ?? 0) + 1 : 0;
        st.basisBreachCount.set(m.name, count);
        if (count >= SUSTAINED_BASIS_SAMPLES) {
          out.push({
            key: `basis-sustained:${m.name}`,
            severity: "warning",
            title: `Sustained large basis: ${m.name}`,
            detail: `Mark-to-index basis has held at ${(basis / 100).toFixed(1)}% for ${count} consecutive samples, beyond the ${(SUSTAINED_BASIS_BPS / 100).toFixed(0)}% threshold. A persistent large gap distorts funding and marks positions against a price far from the traded one.`,
            fields: { Market: m.name, Basis: `${(basis / 100).toFixed(1)}%`, Mark: mark.toFixed(4), Index: indexPrice.toFixed(4), Samples: count },
          });
        }
      } catch { /* mark unreadable; skip basis this cycle */ }
    }
  }

  // ── Liquidatable positions not being cleared (dwell timer + keeper-miss) ──
  // Batched via multicall (scanning sequentially is hundreds of round trips per
  // poll). A position must stay liquidatable past LIQUIDATABLE_DWELL_MS before it
  // alerts: the keeper has had time to act, so a position still liquidatable after
  // the window means the keeper missed it. First-seen times are tracked in state.
  const now = Date.now();
  const currentlyLiquidatable = new Set<string>();
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
        const key = `${account.toLowerCase()}|${m.name}`;
        if (SUPPRESSED.stuckLiquidatable.has(key)) return;
        currentlyLiquidatable.add(key);
        if (!st.liquidatableSince.has(key)) st.liquidatableSince.set(key, now); // first seen
      });
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : String(e) }, "health: liquidatable scan failed");
    }
  }
  // Drop timers for positions that are no longer liquidatable (keeper cleared, or recovered).
  for (const key of [...st.liquidatableSince.keys()]) {
    if (!currentlyLiquidatable.has(key)) st.liquidatableSince.delete(key);
  }
  // Alert only positions past the dwell window.
  const overdue: { key: string; mins: number }[] = [];
  for (const key of currentlyLiquidatable) {
    const since = st.liquidatableSince.get(key)!;
    if (now - since >= LIQUIDATABLE_DWELL_MS) overdue.push({ key, mins: Math.round((now - since) / 60_000) });
  }
  if (overdue.length > 0) {
    const longest = Math.max(...overdue.map((o) => o.mins));
    out.push({
      key: "liquidatable-backlog",
      severity: "warning",
      title: `${overdue.length} position(s) liquidatable > ${LIQUIDATABLE_DWELL_MS / 60_000}min`,
      detail: `Positions have stayed below maintenance margin beyond the ${LIQUIDATABLE_DWELL_MS / 60_000}-minute window without being liquidated. Liquidation is permissioned, so this indicates the whitelisted keeper missed a run or is not running.`,
      fields: { Count: overdue.length, "Longest overdue": `${longest} min`, Positions: overdue.slice(0, 5).map((o) => o.key.split("|").map((p, i) => (i === 0 ? p.slice(0, 10) : p)).join(" ")).join(", ") },
    });
  }

  return out;
}
