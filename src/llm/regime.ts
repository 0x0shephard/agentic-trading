// Market regime, set by the LLM supervisor and read by the macro archetype and
// the orchestrator's cadence. A shared, mutable singleton (like the knobs) so the
// supervisor can update it in place and every reader sees the change immediately.

export type RegimeStance = "risk_on" | "neutral" | "risk_off";
export type VolExpectation = "low" | "normal" | "high";

export interface Regime {
  stance: RegimeStance;
  volExpectation: VolExpectation;
  note: string;
  updatedAt: number;
}

export const DEFAULT_REGIME: Regime = {
  stance: "neutral",
  volExpectation: "normal",
  note: "default (no supervisor run yet)",
  updatedAt: 0,
};

/** Shared, mutable regime. The supervisor writes `.current`; agents read it. */
export const regimeState: { current: Regime } = { current: DEFAULT_REGIME };

/** Scales overall swarm cadence: lean in when risk-on, pull back when risk-off. */
export function regimeRateMultiplier(r: Regime): number {
  const base = r.stance === "risk_on" ? 1.3 : r.stance === "risk_off" ? 0.6 : 1.0;
  const vol = r.volExpectation === "high" ? 1.15 : r.volExpectation === "low" ? 0.9 : 1.0;
  return base * vol;
}

/** Scales the macro archetype's conviction (position size) by regime. */
export function regimeConvictionMultiplier(r: Regime): number {
  return r.stance === "risk_on" ? 1.0 : r.stance === "risk_off" ? 0.3 : 0.7;
}
