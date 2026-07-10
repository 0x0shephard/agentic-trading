import { describe, it, expect } from "vitest";
import { ManipulationDetector } from "./detector";
import type { TradeEvent } from "./types";

// Baseline: index $4.00, mark structurally cheap at ~$3.80 (dev ≈ -500 bps) —
// mirrors this testnet's loose peg, so the detector must key on deltas not level.
const t = (over: Partial<TradeEvent>): TradeEvent => ({
  wallet: "0xwallet",
  market: "H100-GPU-PERP",
  side: "short",
  isOpen: true,
  notionalUsd: 200,
  txHash: "0xtx",
  timestamp: 0,
  markBefore: 3.8,
  markAfter: 3.8,
  indexPrice: 4.0,
  ...over,
});

describe("ManipulationDetector", () => {
  it("flags a manipulator: push (widens the gap) then a round-trip unwind", () => {
    const d = new ManipulationDetector();

    // Push: short moves mark 3.80 → 3.75 (~132 bps impact), widening -500 → -625.
    const a1 = d.ingest(t({ wallet: "0xM", isOpen: true, side: "short", notionalUsd: 200, markBefore: 3.8, markAfter: 3.75, timestamp: 0, txHash: "0xpush" }));
    expect(a1.map((a) => a.kind)).toContain("peg_push");
    expect(a1[0]!.severity).toBe("medium"); // impact ~132 < 150

    // Unwind 5 min later: close 3.75 → 3.80.
    const a2 = d.ingest(t({ wallet: "0xM", isOpen: false, side: "long", notionalUsd: 200, markBefore: 3.75, markAfter: 3.8, timestamp: 5 * 60_000, txHash: "0xunwind" }));
    const rt = a2.find((a) => a.kind === "manipulation_round_trip");
    expect(rt).toBeTruthy();
    expect(rt!.severity).toBe("high");
    expect(rt!.txHashes).toEqual(["0xpush", "0xunwind"]);
  });

  it("does NOT flag an arbitrageur that narrows the gap (buys the cheap mark)", () => {
    const d = new ManipulationDetector();
    // Long: mark 3.80 → 3.85 (toward index) → narrows -500 → -375.
    const a1 = d.ingest(t({ wallet: "0xARB", isOpen: true, side: "long", notionalUsd: 150, markBefore: 3.8, markAfter: 3.85, timestamp: 0, txHash: "0xa1" }));
    expect(a1).toEqual([]);
    // Later unwind on convergence — no prior push → no round-trip.
    const a2 = d.ingest(t({ wallet: "0xARB", isOpen: false, side: "short", notionalUsd: 150, markBefore: 3.9, markAfter: 3.88, timestamp: 3 * 60_000, txHash: "0xa2" }));
    expect(a2).toEqual([]);
  });

  it("does NOT flag small-clip churn (impact below threshold)", () => {
    const d = new ManipulationDetector();
    // MM / momentum tiny clip: mark barely moves (~8 bps).
    const a = d.ingest(t({ wallet: "0xMM", isOpen: true, side: "short", notionalUsd: 20, markBefore: 3.8, markAfter: 3.797, timestamp: 0 }));
    expect(a).toEqual([]);
  });

  it("escalates a very large single-trade footprint to HIGH on its own", () => {
    const d = new ManipulationDetector();
    // Short pushes mark 3.80 → 3.71 (~237 bps impact) → severe.
    const a = d.ingest(t({ wallet: "0xBIG", isOpen: true, side: "short", notionalUsd: 400, markBefore: 3.8, markAfter: 3.71, timestamp: 0, txHash: "0xbig" }));
    const push = a.find((x) => x.kind === "peg_push");
    expect(push).toBeTruthy();
    expect(push!.severity).toBe("high");
  });

  it("does not fire a round-trip when a close has no prior push", () => {
    const d = new ManipulationDetector();
    const a = d.ingest(t({ wallet: "0xX", isOpen: false, side: "long", notionalUsd: 300, markBefore: 3.8, markAfter: 3.82, timestamp: 0 }));
    expect(a).toEqual([]);
  });

  it("ignores a push that is older than the round-trip window", () => {
    const d = new ManipulationDetector();
    d.ingest(t({ wallet: "0xM2", isOpen: true, side: "short", notionalUsd: 200, markBefore: 3.8, markAfter: 3.75, timestamp: 0, txHash: "0xp" }));
    // Unwind 30 min later (> 20 min window) → push expired.
    const a = d.ingest(t({ wallet: "0xM2", isOpen: false, side: "long", notionalUsd: 200, markBefore: 3.75, markAfter: 3.8, timestamp: 30 * 60_000, txHash: "0xu" }));
    expect(a.map((x) => x.kind)).not.toContain("manipulation_round_trip");
  });
});
