import type { Knobs } from "../strategy/knobs";
import type { Metrics } from "./metrics";

/**
 * Market-structure controller config. Holds OI : Volume : TVL = 1 : ratioVol :
 * ratioTvl by driving the knobs toward an OI anchor. Proportional control with a
 * deadband (don't chase noise) and a per-cycle step cap (don't oscillate).
 */
export interface ControllerConfig {
  targetOiUsd: number; // the OI anchor; Vol*/TVL* derive from the ratios
  ratioVol: number; // 1.20
  ratioTvl: number; // 0.55
  deadbandPct: number; // e.g. 0.05 — ignore errors smaller than this
  stepPct: number; // e.g. 0.20 — max fractional knob change per cycle
  minKnob: number;
  maxKnob: number;
}

export const DEFAULT_CONTROLLER: ControllerConfig = {
  targetOiUsd: 2000, // scaled for a small testnet fleet; raise with fleet/collateral
  ratioVol: 1.2,
  ratioTvl: 0.55,
  deadbandPct: 0.05,
  stepPct: 0.2,
  minKnob: 0.1,
  maxKnob: 5,
};

export interface ControlAction {
  metric: "OI" | "Vol";
  knob: "buildRate" | "churnRate";
  actual: number;
  target: number;
  errPct: number;
  from: number;
  to: number;
}

function clampN(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Proportional, deadbanded, rate-limited adjustment of one knob toward target. */
function adjust(current: number, actual: number, target: number, cfg: ControllerConfig): number {
  if (target <= 0) return current;
  const err = (target - actual) / target; // >0 → below target → raise the knob
  if (Math.abs(err) < cfg.deadbandPct) return current;
  const delta = Math.sign(err) * Math.min(Math.abs(err), cfg.stepPct);
  return clampN(current * (1 + delta), cfg.minKnob, cfg.maxKnob);
}

/**
 * One control cycle: OI drives buildRate (hedgers/macro), Volume drives
 * churnRate (MM/HFT/momentum/basis). TVL is reported but steered by provisioning
 * (collateral), not a fast knob. Returns the new knobs plus the actions taken.
 */
export function stepController(
  m: Metrics,
  knobs: Knobs,
  cfg: ControllerConfig,
): { knobs: Knobs; actions: ControlAction[] } {
  const oiTarget = cfg.targetOiUsd;
  const volTarget = cfg.ratioVol * cfg.targetOiUsd;

  const newBuild = adjust(knobs.buildRate, m.oiUsd, oiTarget, cfg);
  const newChurn = adjust(knobs.churnRate, m.volumeUsd, volTarget, cfg);

  const actions: ControlAction[] = [];
  if (newBuild !== knobs.buildRate) {
    actions.push({
      metric: "OI",
      knob: "buildRate",
      actual: m.oiUsd,
      target: oiTarget,
      errPct: ((oiTarget - m.oiUsd) / oiTarget) * 100,
      from: knobs.buildRate,
      to: newBuild,
    });
  }
  if (newChurn !== knobs.churnRate) {
    actions.push({
      metric: "Vol",
      knob: "churnRate",
      actual: m.volumeUsd,
      target: volTarget,
      errPct: ((volTarget - m.volumeUsd) / volTarget) * 100,
      from: knobs.churnRate,
      to: newChurn,
    });
  }

  return { knobs: { ...knobs, buildRate: newBuild, churnRate: newChurn }, actions };
}
