import { describe, it, expect } from "vitest";
import { stepController, DEFAULT_CONTROLLER } from "./controller";
import { DEFAULT_KNOBS } from "../strategy/knobs";
import type { Metrics } from "./metrics";

const base = (o: Partial<Metrics> = {}): Metrics => ({
  oiUsd: 0,
  longOiUsd: 0,
  shortOiUsd: 0,
  tvlUsd: 0,
  volumeUsd: 0,
  ...o,
});

describe("controller", () => {
  it("raises buildRate when OI is below target", () => {
    const { knobs } = stepController(base({ oiUsd: 0 }), DEFAULT_KNOBS, DEFAULT_CONTROLLER);
    expect(knobs.buildRate).toBeGreaterThan(DEFAULT_KNOBS.buildRate);
  });

  it("lowers buildRate when OI is above target", () => {
    const m = base({ oiUsd: DEFAULT_CONTROLLER.targetOiUsd * 2 });
    const { knobs } = stepController(m, DEFAULT_KNOBS, DEFAULT_CONTROLLER);
    expect(knobs.buildRate).toBeLessThan(DEFAULT_KNOBS.buildRate);
  });

  it("raises churnRate when volume is below target", () => {
    const { knobs } = stepController(base({ volumeUsd: 0 }), DEFAULT_KNOBS, DEFAULT_CONTROLLER);
    expect(knobs.churnRate).toBeGreaterThan(DEFAULT_KNOBS.churnRate);
  });

  it("does nothing inside the deadband", () => {
    const oi = DEFAULT_CONTROLLER.targetOiUsd * 0.98; // 2% < 5% deadband
    const vol = DEFAULT_CONTROLLER.ratioVol * DEFAULT_CONTROLLER.targetOiUsd * 0.98;
    const { knobs, actions } = stepController(base({ oiUsd: oi, volumeUsd: vol }), DEFAULT_KNOBS, DEFAULT_CONTROLLER);
    expect(actions.length).toBe(0);
    expect(knobs.buildRate).toBe(DEFAULT_KNOBS.buildRate);
    expect(knobs.churnRate).toBe(DEFAULT_KNOBS.churnRate);
  });

  it("rate-limits the step (no more than stepPct per cycle)", () => {
    const { knobs } = stepController(base({ oiUsd: 0 }), DEFAULT_KNOBS, DEFAULT_CONTROLLER);
    const maxExpected = DEFAULT_KNOBS.buildRate * (1 + DEFAULT_CONTROLLER.stepPct);
    expect(knobs.buildRate).toBeLessThanOrEqual(maxExpected + 1e-9);
  });

  it("clamps to maxKnob", () => {
    const hot = { ...DEFAULT_KNOBS, buildRate: DEFAULT_CONTROLLER.maxKnob };
    const { knobs } = stepController(base({ oiUsd: 0 }), hot, DEFAULT_CONTROLLER);
    expect(knobs.buildRate).toBeLessThanOrEqual(DEFAULT_CONTROLLER.maxKnob);
  });
});
