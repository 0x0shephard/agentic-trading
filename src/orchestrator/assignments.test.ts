import { describe, expect, it } from "vitest";
import { MARKETS } from "../config/markets";
import { buildAssignments } from "./assignments";

describe("buildAssignments", () => {
  it("spreads default assignments across every configured market", () => {
    const assignments = buildAssignments(MARKETS.length);

    expect(assignments.map((a) => a.market.name)).toEqual(MARKETS.map((m) => m.name));
  });

  it("cycles markets when the fleet is larger than the market list", () => {
    const assignments = buildAssignments(MARKETS.length + 2);

    expect(assignments[MARKETS.length]?.market.name).toBe(MARKETS[0]?.name);
    expect(assignments[MARKETS.length + 1]?.market.name).toBe(MARKETS[1]?.name);
  });

  it("allows callers to restrict the market set", () => {
    const assignments = buildAssignments(3, [MARKETS[2]!]);

    expect(assignments.every((a) => a.market.name === MARKETS[2]?.name)).toBe(true);
  });
});
