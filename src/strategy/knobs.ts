// Controller-tunable knobs. Phase 3c's market-structure controller writes these
// each cycle to steer OI:Vol:TVL; until then they hold sane static defaults.
// Each strategy reads only the knobs relevant to it (see the archetype table).
export interface Knobs {
  /** Net position build-rate multiplier for hedgers/macro. 1 = baseline. */
  buildRate: number;
  /** Churn multiplier for HFT / MM / momentum / basis-arb. 1 = baseline. */
  churnRate: number;
  /** Market-maker participation (0..1): how much of its inventory band it works. */
  mmParticipation: number;
  /** Basis-arb entry threshold, in bps of mark-index deviation. */
  basisThresholdBps: number;
  /** Degen intensity (0..N) — how eagerly degens open into liquidation risk. */
  degenIntensity: number;
}

export const DEFAULT_KNOBS: Knobs = {
  buildRate: 1,
  churnRate: 1,
  mmParticipation: 0.5,
  basisThresholdBps: 150,
  degenIntensity: 1,
};
