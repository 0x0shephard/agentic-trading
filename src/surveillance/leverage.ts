// Account-level effective-leverage distribution monitor (RMF Section 11 reporting).
//
// Produces, across all accounts holding open positions, the two figures the
// monthly report to the Authority requires:
//   1. the DISTRIBUTION of account-level effective leverage, and
//   2. the SHARE of accounts operating above 80% of the applicable cap.
//
// Definitions (the agreed sensible default — confirm/adjust with compliance):
//   equity              = free collateral + Σ(marginRatio × notional) over positions
//                         = collateral + unrealized PnL, derived from on-chain getters
//                         (getAccountValue returns free/unreserved collateral; adding
//                          each position's effective margin recovers total equity).
//   effective leverage  = Σ notional / equity  (account level).
//   applicable cap      = 1 / IMR per market (e.g. IMR 5% → 20×).
//   above 80% of cap    = a position whose current leverage exceeds 0.8 × its market
//                         cap, i.e. its margin ratio < IMR / 0.8. An ACCOUNT is flagged
//                         if ANY of its positions is above 80% of that market's cap.
//
// Each run writes a snapshot to leverage_distribution_snapshots so the monthly report
// reads a real series; an alert fires if the flagged share crosses a threshold.
import { formatUnits, parseAbi } from "viem";
import type { Address, PublicClient } from "viem";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONTRACTS } from "../config/addresses";
import { MARKETS } from "../config/markets";
import type { MarketDef } from "../config/markets";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import { sendAlert } from "./alerting/slack";

const CH = parseAbi([
  "function getAccountValue(address) view returns (int256)",
  "function getNotional(address,bytes32) view returns (uint256)",
  "function getMarginRatio(address,bytes32) view returns (uint256)",
  "function marketRiskParams(bytes32) view returns (uint256 imrBps, uint256 mmrBps, uint256 liquidationPenaltyBps, uint256 penaltyCap, uint256 maxPositionSize, uint256 minPositionSize)",
]);

/** An account is above 80% of cap if a position's leverage exceeds this × cap. */
const ABOVE_CAP_FACTOR = 0.8;
/** Guard: margin ratio is bounded so a stray huge value can't distort equity. */
const MAX_MARGIN_RATIO = 100; // 10,000% margin (≈0.01× leverage) — absurd, just a clamp

// Distribution buckets over account-level effective leverage (×). The final bucket
// is open-ended and also captures insolvent accounts (infinite leverage).
const BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: "0-1x", lo: 0, hi: 1 },
  { label: "1-2x", lo: 1, hi: 2 },
  { label: "2-5x", lo: 2, hi: 5 },
  { label: "5-10x", lo: 5, hi: 10 },
  { label: "10-15x", lo: 10, hi: 15 },
  { label: "15-20x", lo: 15, hi: 20 },
  { label: "20x+", lo: 20, hi: Infinity },
];

export interface PositionInput { market: string; notional: number; marginRatio: number; imrBps: number }
export interface AccountLeverageInput { account: string; freeCollateral: number; positions: PositionInput[] }

export interface LeverageReport {
  capturedAt: string;
  accountsWithPositions: number;
  shareAbove80PctCap: number; // 0..1
  flaggedAccounts: number;
  insolventAccounts: number;
  medianLeverage: number;
  maxLeverage: number;
  distribution: { bucket: string; count: number }[];
  accounts: { account: string; leverage: number; aboveCap80: boolean }[];
}

/** Pure evaluation: distribution + 80%-of-cap share from per-account inputs. */
export function computeLeverageReport(inputs: AccountLeverageInput[], now = new Date()): LeverageReport {
  const perAccount: { account: string; leverage: number; aboveCap80: boolean }[] = [];
  for (const a of inputs) {
    const open = a.positions.filter((p) => p.notional > 0);
    if (open.length === 0) continue; // no open positions → not part of the book
    const totalNotional = open.reduce((s, p) => s + p.notional, 0);
    const equity = a.freeCollateral + open.reduce((s, p) => s + p.marginRatio * p.notional, 0);
    const leverage = equity > 0 ? totalNotional / equity : Infinity;
    // Above 80% of cap: any position with margin ratio below IMR/0.8, or the whole
    // account insolvent (equity ≤ 0 ⇒ effectively unbounded leverage).
    const aboveCap80 = equity <= 0 || open.some((p) => p.imrBps > 0 && p.marginRatio < (p.imrBps / 10_000) / ABOVE_CAP_FACTOR);
    perAccount.push({ account: a.account, leverage, aboveCap80 });
  }

  const n = perAccount.length;
  const flagged = perAccount.filter((x) => x.aboveCap80).length;
  const insolvent = perAccount.filter((x) => !Number.isFinite(x.leverage)).length;
  const finite = perAccount.map((x) => x.leverage).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  const median = finite.length ? finite[Math.floor(finite.length / 2)]! : 0;
  const max = finite.length ? finite[finite.length - 1]! : 0;

  const distribution = BUCKETS.map((b) => ({
    bucket: b.label,
    count: perAccount.filter((x) => x.leverage >= b.lo && (b.hi === Infinity ? true : x.leverage < b.hi)).length,
  }));

  return {
    capturedAt: now.toISOString(),
    accountsWithPositions: n,
    shareAbove80PctCap: n === 0 ? 0 : flagged / n,
    flaggedAccounts: flagged,
    insolventAccounts: insolvent,
    medianLeverage: median,
    maxLeverage: max,
    distribution,
    accounts: perAccount,
  };
}

// ── On-chain reads ───────────────────────────────────────────────────────────

type Mc = { status: string; result: unknown }[];

/** Read per-account equity inputs and open positions for the given accounts. */
export async function readAccountLeverage(pc: PublicClient, accounts: Address[], markets: readonly MarketDef[]): Promise<AccountLeverageInput[]> {
  if (accounts.length === 0) return [];

  // IMR per market (once).
  const imrRes = (await pc.multicall({
    contracts: markets.map((m) => ({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "marketRiskParams" as const, args: [m.marketId] })) as never,
    allowFailure: true,
  })) as Mc;
  const imrByMarket = new Map<string, number>();
  markets.forEach((m, i) => {
    if (imrRes[i]?.status === "success") imrByMarket.set(m.name, Number((imrRes[i]!.result as readonly bigint[])[0] ?? 0n));
  });

  const avCalls = accounts.map((a) => ({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "getAccountValue" as const, args: [a] }));
  const nCalls = accounts.flatMap((a) => markets.map((m) => ({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "getNotional" as const, args: [a, m.marketId] })));
  const mrCalls = accounts.flatMap((a) => markets.map((m) => ({ address: CONTRACTS.clearingHouse, abi: CH, functionName: "getMarginRatio" as const, args: [a, m.marketId] })));

  const [avRes, nRes, mrRes] = (await Promise.all([
    pc.multicall({ contracts: avCalls as never, allowFailure: true }),
    pc.multicall({ contracts: nCalls as never, allowFailure: true }),
    pc.multicall({ contracts: mrCalls as never, allowFailure: true }),
  ])) as [Mc, Mc, Mc];

  const out: AccountLeverageInput[] = [];
  accounts.forEach((a, ai) => {
    const freeCollateral = avRes[ai]?.status === "success" ? Number(formatUnits(avRes[ai]!.result as bigint, 18)) : 0;
    const positions: PositionInput[] = [];
    markets.forEach((m, mi) => {
      const idx = ai * markets.length + mi;
      if (nRes[idx]?.status !== "success") return;
      const notional = Number(formatUnits(nRes[idx]!.result as bigint, 18));
      if (notional <= 0) return; // no open position in this market
      const mrRaw = mrRes[idx]?.status === "success" ? (mrRes[idx]!.result as bigint) : 0n;
      const marginRatio = Math.min(Number(formatUnits(mrRaw, 18)), MAX_MARGIN_RATIO);
      positions.push({ market: m.name, notional, marginRatio, imrBps: imrByMarket.get(m.name) ?? 0 });
    });
    out.push({ account: a, freeCollateral, positions });
  });
  return out;
}

/** Candidate accounts to check on-chain: everyone who has ever traded (bounded). */
export async function enumerateAccounts(sb: SupabaseClient, max: number): Promise<Address[]> {
  const { data, error } = await sb.rpc("distinct_trading_accounts");
  if (error) { logger.warn({ err: error.message }, "leverage: account enumeration failed"); return []; }
  const rows = (data ?? []) as { user_address: string }[];
  return [...new Set(rows.map((r) => r.user_address).filter(Boolean))].slice(0, max) as Address[];
}

// ── Pass ─────────────────────────────────────────────────────────────────────

export interface LeverageConfig { pollMs: number; maxAccounts: number; alertSharePct: number }
export function leverageConfigFromEnv(): LeverageConfig {
  return { pollMs: env.LEVERAGE_POLL_MS, maxAccounts: env.LEVERAGE_MAX_ACCOUNTS, alertSharePct: env.LEVERAGE_ALERT_SHARE_PCT };
}

/** One leverage pass: enumerate → read chain → compute → snapshot → maybe alert. */
export async function leveragePass(pc: PublicClient, sb: SupabaseClient, cfg: LeverageConfig): Promise<LeverageReport | null> {
  const accounts = await enumerateAccounts(sb, cfg.maxAccounts);
  if (accounts.length === 0) { logger.info("leverage: no candidate accounts"); return null; }

  const inputs = await readAccountLeverage(pc, accounts, MARKETS);
  const report = computeLeverageReport(inputs);

  const { error } = await sb.from("leverage_distribution_snapshots").insert({
    captured_at: report.capturedAt,
    accounts_with_positions: report.accountsWithPositions,
    share_above_80pct_cap: report.shareAbove80PctCap,
    flagged_accounts: report.flaggedAccounts,
    insolvent_accounts: report.insolventAccounts,
    median_leverage: report.medianLeverage,
    max_leverage: report.maxLeverage,
    distribution: report.distribution,
  });
  if (error) logger.warn({ err: error.message }, "leverage: snapshot insert failed");

  const sharePct = report.shareAbove80PctCap * 100;
  if (report.accountsWithPositions > 0 && sharePct >= cfg.alertSharePct) {
    await sendAlert({
      severity: "warning",
      title: `Leverage: ${sharePct.toFixed(0)}% of accounts above 80% of cap`,
      detail: `${report.flaggedAccounts} of ${report.accountsWithPositions} accounts with open positions are operating above 80% of their market's leverage cap (threshold ${cfg.alertSharePct}%).`,
      fields: {
        "Accounts (open positions)": report.accountsWithPositions,
        "Above 80% of cap": `${report.flaggedAccounts} (${sharePct.toFixed(0)}%)`,
        Insolvent: report.insolventAccounts,
        "Median leverage": `${report.medianLeverage.toFixed(1)}x`,
        "Max leverage": `${report.maxLeverage.toFixed(1)}x`,
      },
    });
  }

  logger.info(
    { accounts: report.accountsWithPositions, sharePct: sharePct.toFixed(1), flagged: report.flaggedAccounts },
    "leverage: snapshot written",
  );
  return report;
}
