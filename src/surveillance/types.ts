// Types for the market-manipulation surveillance detector. Identity-agnostic:
// the detector flags wallets by behaviour, not by who they are.

export type AlertSeverity = "low" | "medium" | "high";
export type AlertKind = "peg_push" | "manipulation_round_trip";

/**
 * A normalized trade the detector consumes. The Railway monitor builds these
 * from canonical_pnl_events (who/side/notional/tx/time) joined against
 * vamm_price_history (mark before/after) and the index price at trade time.
 */
export interface TradeEvent {
  wallet: string; // address (any case)
  market: string; // market name, e.g. "H100-GPU-PERP"
  side: "long" | "short";
  isOpen: boolean; // true = open/increase (adds exposure); false = close/reduce
  notionalUsd: number;
  txHash: string;
  timestamp: number; // ms epoch
  markBefore: number; // vAMM mark just before the trade
  markAfter: number; // vAMM mark just after the trade
  indexPrice: number; // oracle index at trade time
}

export interface Alert {
  severity: AlertSeverity;
  kind: AlertKind;
  wallet: string;
  market: string;
  devBps: number; // resulting mark-index deviation
  impactBps: number; // single-trade mark footprint
  widenedBps: number; // how much this trade widened |dev| (away from the peg)
  notionalUsd: number;
  txHashes: string[]; // evidence (push [+ unwind])
  detectedAt: number; // ms epoch of the triggering trade
  detail: string; // human-readable explanation
}

export interface DetectorConfig {
  /** A trade must widen |mark-index| by at least this to count as a push. */
  widenMinBps: number;
  /** …and move the mark by at least this (single-trade footprint). */
  impactMinBps: number;
  /** Impact at/above this makes the push HIGH severity on its own. */
  severeImpactBps: number;
  /** Ignore trades below this notional (dust can't manipulate a market). */
  minPushNotionalUsd: number;
  /** A close within this window of a push counts as a round-trip. */
  roundTripWindowMs: number;
  /** …and must unwind at least this fraction of the pushed notional. */
  roundTripUnwindFrac: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  widenMinBps: 40,
  impactMinBps: 50,
  severeImpactBps: 150,
  minPushNotionalUsd: 100,
  roundTripWindowMs: 20 * 60 * 1000,
  roundTripUnwindFrac: 0.6,
};
