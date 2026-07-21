// Shared metric sampler for the RMF Appendix F stress scenarios.
//
// Every scenario emits the SAME schema so the four runs are directly comparable
// and each headline metric traces to one on-chain source:
//
//   volatility       <- realised stdev of vAMM mark returns over the sample series
//   OI / OI flow     <- ClearingHouse.totalLongOI / totalShortOI (level and delta)
//   liquidations     <- LiquidationExecuted events
//   InsuranceFund    <- InsuranceFund.totalPaid delta  (the draw) + balance
//   basis            <- (mark - index) / index, in bps
//
// Bad debt (ClearingHouse.totalBadDebt + BadDebtRecorded) is sampled alongside
// the fund because the liquidate() waterfall is collateral -> fund -> bad debt;
// reporting the draw without the uncovered remainder would understate losses.
import { formatUnits, parseAbi } from "viem";
import type { Address } from "viem";
import type { ForkClients } from "./fork";
import { CONTRACTS } from "../config/addresses";
import { MARKETS } from "../config/markets";
import type { MarketDef } from "../config/markets";

const CH_ABI = parseAbi([
  "function totalLongOI(bytes32) view returns (uint256)",
  "function totalShortOI(bytes32) view returns (uint256)",
  "function totalBadDebt() view returns (uint256)",
  "function isLiquidatable(address,bytes32) view returns (bool)",
  "function getMarginRatio(address,bytes32) view returns (uint256)",
  "function getPosition(address,bytes32) view returns ((int256 size, uint256 margin, uint256 entryPriceX18, uint256 lastFundingPayIndex, uint256 lastFundingReceiveIndex, int256 realizedPnL))",
]);
const IF_ABI = parseAbi([
  "function balance() view returns (uint256)",
  "function totalPaid() view returns (uint256)",
  "function totalReceived() view returns (uint256)",
]);
const VAMM_ABI = parseAbi(["function getMarkPrice() view returns (uint256)"]);
const ORACLE_ABI = parseAbi(["function getPrice() view returns (uint256)"]);
// Field ORDER matters: viem decodes tuples positionally, so this must mirror
// IMarketRegistry.Market exactly (vamm, feeBps, paused, oracle, ...) or every
// read silently returns the wrong addresses.
const MR_ABI = parseAbi([
  "function getMarket(bytes32) view returns ((address vamm, uint16 feeBps, bool paused, address oracle, address feeRouter, address insuranceFund, address baseAsset, address quoteToken, uint256 baseUnit))",
]);

export const LIQUIDATION_EVENT = parseAbi([
  "event LiquidationExecuted(bytes32 indexed marketId, address indexed liquidator, address indexed account, uint128 size, uint256 notional, uint256 penalty, uint256 liquidatorReward, uint256 protocolFee, uint256 insurancePayout)",
])[0];
export const BAD_DEBT_EVENT = parseAbi([
  "event BadDebtRecorded(address indexed account, bytes32 indexed marketId, uint256 shortfall)",
])[0];

export interface MarketSample {
  market: string;
  /** vAMM mark price. null when the read reverted (e.g. paused market). */
  mark: number | null;
  /** Oracle index price. null when the oracle reverted — the F-5 fail-closed signal. */
  index: number | null;
  /** (mark-index)/index in bps. null if either leg is unavailable. */
  basisBps: number | null;
  longOi: number;
  shortOi: number;
  netOi: number;
  /** True when the index read reverted; distinguishes "stale guard tripped" from "market quiet". */
  oracleReverted: boolean;
  paused: boolean;
}

export interface Sample {
  t: number;            // fork block timestamp (seconds)
  block: number;
  markets: MarketSample[];
  ifBalance: number;    // USDC
  ifTotalPaid: number;  // USDC — cumulative; the draw is the delta across a run
  badDebt: number;      // x18 notional
}

export interface LiquidationRecord {
  block: number;
  account: Address;
  marketId: string;
  liquidator: Address;
  size: number;
  notional: number;
  penalty: number;
  /** USDC drawn from the InsuranceFund to cover this liquidation's shortfall. */
  insurancePayout: number;
  txHash: string;
}

export interface BadDebtRecord {
  block: number;
  account: Address;
  marketId: string;
  shortfall: number;
  txHash: string;
}

const x18 = (v: bigint) => Number(formatUnits(v, 18));
const usdc = (v: bigint) => Number(formatUnits(v, 6));

/** Read one market's live state. Reverts are captured, not thrown: an oracle that
 *  fails closed is a RESULT of the scenario, not an error in the harness. */
async function sampleMarket(f: ForkClients, m: MarketDef): Promise<MarketSample> {
  let vamm: Address | undefined, oracle: Address | undefined, paused = false;
  try {
    const cfg = (await f.pub.readContract({
      address: CONTRACTS.marketRegistry, abi: MR_ABI, functionName: "getMarket", args: [m.marketId],
    })) as { vamm: Address; oracle: Address; paused: boolean };
    vamm = cfg.vamm; oracle = cfg.oracle; paused = cfg.paused;
  } catch { /* registry unreadable; leave undefined */ }

  let mark: number | null = null;
  if (vamm) {
    try { mark = x18((await f.pub.readContract({ address: vamm, abi: VAMM_ABI, functionName: "getMarkPrice" })) as bigint); }
    catch { mark = null; }
  }

  let index: number | null = null;
  let oracleReverted = false;
  if (oracle) {
    try { index = x18((await f.pub.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "getPrice" })) as bigint); }
    catch { oracleReverted = true; }
  }

  const [longOi, shortOi] = await Promise.all([
    f.pub.readContract({ address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "totalLongOI", args: [m.marketId] }).catch(() => 0n),
    f.pub.readContract({ address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "totalShortOI", args: [m.marketId] }).catch(() => 0n),
  ]) as [bigint, bigint];

  const basisBps = mark !== null && index !== null && index > 0 ? ((mark - index) / index) * 10_000 : null;
  return {
    market: m.name, mark, index, basisBps,
    longOi: x18(longOi), shortOi: x18(shortOi), netOi: x18(longOi) - x18(shortOi),
    oracleReverted, paused,
  };
}

/** One full protocol snapshot across the tracked markets. */
export async function sample(f: ForkClients, markets: readonly MarketDef[] = MARKETS): Promise<Sample> {
  const blk = await f.pub.getBlock({ blockTag: "latest" });
  const [ifBalance, ifTotalPaid, badDebt] = await Promise.all([
    f.pub.readContract({ address: CONTRACTS.insuranceFund, abi: IF_ABI, functionName: "balance" }).catch(() => 0n),
    f.pub.readContract({ address: CONTRACTS.insuranceFund, abi: IF_ABI, functionName: "totalPaid" }).catch(() => 0n),
    f.pub.readContract({ address: CONTRACTS.clearingHouse, abi: CH_ABI, functionName: "totalBadDebt" }).catch(() => 0n),
  ]) as [bigint, bigint, bigint];

  const rows: MarketSample[] = [];
  for (const m of markets) rows.push(await sampleMarket(f, m));

  return {
    t: Number(blk.timestamp), block: Number(blk.number),
    markets: rows,
    ifBalance: usdc(ifBalance), ifTotalPaid: usdc(ifTotalPaid), badDebt: x18(badDebt),
  };
}

/** Liquidations settled in a block range. */
export async function collectLiquidations(f: ForkClients, fromBlock: bigint, toBlock: bigint): Promise<LiquidationRecord[]> {
  const logs = await f.pub.getLogs({ address: CONTRACTS.clearingHouse, event: LIQUIDATION_EVENT, fromBlock, toBlock }).catch(() => []);
  return (logs as unknown as { blockNumber: bigint; transactionHash: string; args: Record<string, unknown> }[]).map((l) => ({
    block: Number(l.blockNumber),
    account: l.args.account as Address,
    marketId: String(l.args.marketId),
    liquidator: l.args.liquidator as Address,
    size: x18((l.args.size as bigint) ?? 0n),
    notional: x18((l.args.notional as bigint) ?? 0n),
    penalty: x18((l.args.penalty as bigint) ?? 0n),
    insurancePayout: usdc((l.args.insurancePayout as bigint) ?? 0n), // quote units (6dp)
    txHash: l.transactionHash,
  }));
}

/** Bad debt recorded in a block range: the loss left uncovered after the fund. */
export async function collectBadDebt(f: ForkClients, fromBlock: bigint, toBlock: bigint): Promise<BadDebtRecord[]> {
  const logs = await f.pub.getLogs({ address: CONTRACTS.clearingHouse, event: BAD_DEBT_EVENT, fromBlock, toBlock }).catch(() => []);
  return (logs as unknown as { blockNumber: bigint; transactionHash: string; args: Record<string, unknown> }[]).map((l) => ({
    block: Number(l.blockNumber),
    account: l.args.account as Address,
    marketId: String(l.args.marketId),
    shortfall: x18((l.args.shortfall as bigint) ?? 0n),
    txHash: l.transactionHash,
  }));
}

// ── Derived measures ───────────────────────────────────────────────────────

/** Realised volatility of a mark series: stdev of log returns, in bps. */
export function realisedVolBps(series: (number | null)[]): number {
  const px = series.filter((p): p is number => p !== null && p > 0);
  if (px.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < px.length; i++) rets.push(Math.log(px[i]! / px[i - 1]!));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(varr) * 10_000;
}

export interface ScenarioSummary {
  scenario: string;
  samples: number;
  durationSec: number;
  /** Per market: vol, basis range, OI flow. */
  perMarket: {
    market: string;
    volBps: number;
    basisStartBps: number | null;
    basisEndBps: number | null;
    basisMaxAbsBps: number | null;
    markStart: number | null;
    markEnd: number | null;
    markMovePct: number | null;
    oiStart: number;
    oiEnd: number;
    oiFlow: number;
    oracleRevertedSamples: number;
  }[];
  liquidations: { count: number; totalNotional: number; accounts: number; totalInsurancePayout: number; totalBadDebt: number };
  insuranceFund: { startBalance: number; endBalance: number; draw: number };
  badDebt: { start: number; end: number; increase: number };
}

/** Reduce a sample series plus liquidation log into the headline metrics. */
export function summarise(scenario: string, samples: Sample[], liqs: LiquidationRecord[]): ScenarioSummary {
  const first = samples[0]!, last = samples[samples.length - 1]!;
  const names = first.markets.map((m) => m.market);

  const perMarket = names.map((name) => {
    const series = samples.map((s) => s.markets.find((m) => m.market === name)!);
    const marks = series.map((m) => m.mark);
    const bases = series.map((m) => m.basisBps).filter((b): b is number => b !== null);
    const s0 = series[0]!, s1 = series[series.length - 1]!;
    const oiStart = s0.longOi + s0.shortOi, oiEnd = s1.longOi + s1.shortOi;
    return {
      market: name,
      volBps: realisedVolBps(marks),
      basisStartBps: s0.basisBps, basisEndBps: s1.basisBps,
      basisMaxAbsBps: bases.length ? Math.max(...bases.map(Math.abs)) : null,
      markStart: s0.mark, markEnd: s1.mark,
      markMovePct: s0.mark && s1.mark ? ((s1.mark - s0.mark) / s0.mark) * 100 : null,
      oiStart, oiEnd, oiFlow: oiEnd - oiStart,
      oracleRevertedSamples: series.filter((m) => m.oracleReverted).length,
    };
  });

  return {
    scenario,
    samples: samples.length,
    durationSec: last.t - first.t,
    perMarket,
    liquidations: {
      count: liqs.length,
      totalNotional: liqs.reduce((a, l) => a + l.notional, 0),
      accounts: new Set(liqs.map((l) => l.account.toLowerCase())).size,
      totalInsurancePayout: liqs.reduce((a, l) => a + l.insurancePayout, 0),
      // Uncovered loss is tracked via totalBadDebt (below), not on this event.
      totalBadDebt: 0,
    },
    insuranceFund: {
      startBalance: first.ifBalance, endBalance: last.ifBalance,
      draw: last.ifTotalPaid - first.ifTotalPaid, // cumulative counter delta = the actual draw
    },
    badDebt: { start: first.badDebt, end: last.badDebt, increase: last.badDebt - first.badDebt },
  };
}
