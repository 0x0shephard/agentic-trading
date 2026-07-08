import { describe, it, expect } from "vitest";
import { buildLabels } from "./labels";
import { Attribution } from "./attribution";
import { buildAssignments } from "../orchestrator/assignments";

describe("labels", () => {
  it("numbers agents per archetype in assignment order", () => {
    // composition starts: market-maker, basis-arb, momentum, hft-taker, ...
    const labels = buildLabels(buildAssignments(5));
    expect(labels.get(1)).toBe("mm-01");
    expect(labels.get(2)).toBe("basis-01");
    expect(labels.get(3)).toBe("mom-01");
    expect(labels.get(4)).toBe("hft-01");
    expect(labels.get(5)).toBe("hs-01");
  });

  it("increments the sequence for repeats of the same archetype", () => {
    // index 7 is the composition's 2nd market-maker
    const labels = buildLabels(buildAssignments(9));
    expect(labels.get(7)).toBe("mm-02");
    expect(labels.get(8)).toBe("hft-02");
  });
});

describe("attribution", () => {
  it("accumulates trades, volume, reverts and skips", () => {
    const a = new Attribution();
    a.record(1, { intent: "open", notionalUsd: 100, gasUsed: 500n, gasCostWei: 1000n, reverted: false, skipped: false });
    a.record(1, { intent: "close", notionalUsd: 50, gasUsed: 400n, gasCostWei: 800n, reverted: false, skipped: false });
    a.record(1, { intent: "open", notionalUsd: 999, gasUsed: 300n, gasCostWei: 600n, reverted: true, skipped: false }); // reverted → not counted in volume
    a.record(1, { intent: "open", notionalUsd: 999, reverted: false, skipped: true }); // skipped → not counted

    const s = a.get(1)!;
    expect(s.trades).toBe(2);
    expect(s.volumeUsd).toBe(150);
    expect(s.opens).toBe(1);
    expect(s.closes).toBe(1);
    expect(s.reverts).toBe(1);
    expect(s.skips).toBe(1);
    expect(s.gasUsed).toBe(1200n);
    expect(s.gasCostWei).toBe(2400n);
    expect(a.totalVolumeUsd()).toBe(150);
    expect(a.totalGasCostWei()).toBe(2400n);
  });
});
