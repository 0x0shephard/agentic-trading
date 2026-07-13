import type { TradeEvent, Alert, DetectorConfig } from "./types";
import { DEFAULT_DETECTOR_CONFIG } from "./types";

interface Push {
  t: number;
  devAfter: number;
  notionalUsd: number;
  side: "long" | "short";
  tx: string;
}
interface WalletMarketState {
  pushes: Push[];
}

function devBps(mark: number, index: number): number {
  return index > 0 ? ((mark - index) / index) * 10000 : 0;
}

function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/**
 * Behavioural market-manipulation detector for a vAMM. Identity-agnostic — it
 * flags wallets by what they do, so it catches anyone (our labelled manipulator
 * agent is just the test fixture).
 *
 * The discriminator is DIRECTION + FOOTPRINT + ROUND-TRIP:
 *   • peg_push — an open that WIDENS the mark-index gap (pushes AWAY from the
 *     peg — the opposite of an arb/MM, which narrows it) with real price impact.
 *   • manipulation_round_trip — a wallet that pushed, then UNWINDS shortly after
 *     (pump-and-escape). This is the strongest, manipulator-specific signal.
 *
 * It keys on per-trade DELTAS (widen/impact), never the absolute dislocation, so
 * it stays robust on a structurally loose peg (this testnet's mark and index
 * differ a lot by default). Stateful per (market, wallet) for round-trips.
 */
export class ManipulationDetector {
  private readonly state = new Map<string, WalletMarketState>();

  constructor(private readonly cfg: DetectorConfig = DEFAULT_DETECTOR_CONFIG) {}

  /** Process one trade in time order; returns any alerts it triggers (0..2). */
  ingest(tr: TradeEvent): Alert[] {
    const out: Alert[] = [];
    const key = `${tr.market}|${tr.wallet.toLowerCase()}`;
    let st = this.state.get(key);
    if (!st) {
      st = { pushes: [] };
      this.state.set(key, st);
    }

    const dBefore = devBps(tr.markBefore, tr.indexPrice);
    const dAfter = devBps(tr.markAfter, tr.indexPrice);
    const widenedBps = Math.abs(dAfter) - Math.abs(dBefore);
    const impactBps =
      tr.markBefore > 0 ? Math.abs((tr.markAfter - tr.markBefore) / tr.markBefore) * 10000 : 0;

    // Drop pushes older than the round-trip window.
    st.pushes = st.pushes.filter((p) => tr.timestamp - p.t <= this.cfg.roundTripWindowMs);

    // ── Peg push: an open that widens the gap with real footprint ────────────
    const isPush =
      tr.isOpen &&
      widenedBps >= this.cfg.widenMinBps &&
      impactBps >= this.cfg.impactMinBps &&
      tr.notionalUsd >= this.cfg.minPushNotionalUsd;

    if (isPush) {
      st.pushes.push({ t: tr.timestamp, devAfter: dAfter, notionalUsd: tr.notionalUsd, side: tr.side, tx: tr.txHash });
      out.push({
        severity: impactBps >= this.cfg.severeImpactBps ? "high" : "medium",
        kind: "peg_push",
        wallet: tr.wallet,
        market: tr.market,
        devBps: Math.round(dAfter),
        impactBps: Math.round(impactBps),
        widenedBps: Math.round(widenedBps),
        notionalUsd: tr.notionalUsd,
        txHashes: [tr.txHash],
        detectedAt: tr.timestamp,
        detail: `${shortAddr(tr.wallet)} pushed mark ${impactBps.toFixed(0)}bps (${tr.side}), widening the mark-index gap to ${Math.round(dAfter)}bps via a $${tr.notionalUsd.toFixed(0)} trade`,
      });
    }

    // ── Round-trip: a close/reduce shortly after that wallet pushed ──────────
    if (!tr.isOpen && st.pushes.length > 0) {
      const push = st.pushes[st.pushes.length - 1]!;
      if (tr.notionalUsd >= this.cfg.roundTripUnwindFrac * push.notionalUsd) {
        const heldMin = Math.max(0, Math.round((tr.timestamp - push.t) / 60000));
        out.push({
          severity: "high",
          kind: "manipulation_round_trip",
          wallet: tr.wallet,
          market: tr.market,
          devBps: Math.round(dAfter),
          impactBps: Math.round(impactBps),
          widenedBps: Math.round(widenedBps),
          notionalUsd: tr.notionalUsd,
          txHashes: [push.tx, tr.txHash],
          detectedAt: tr.timestamp,
          detail: `Manipulation round-trip: ${shortAddr(tr.wallet)} pushed the mark to ${Math.round(push.devAfter)}bps then unwound $${tr.notionalUsd.toFixed(0)} after ${heldMin}min`,
        });
        st.pushes.pop(); // consume the matched push
      }
    }

    return out;
  }
}
