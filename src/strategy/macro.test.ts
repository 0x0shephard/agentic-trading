import { describe, it, expect } from "vitest";
import { parseUnits } from "viem";
import { macroDecisionToIntent } from "./archetypes/macro";
import type { MacroDecision } from "./archetypes/macro";
import type { MarketSnapshot } from "../market/snapshot";
import { DEFAULT_ARCHETYPES } from "../config/archetypes";
import { DEFAULT_REGIME } from "../llm/regime";
import type { Regime } from "../llm/regime";
import { DEFAULT_MARKET } from "../config/markets";
import { toNumberX18 } from "../preview/orderPreview";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const MACRO = DEFAULT_ARCHETYPES.macro;
const RISK_ON: Regime = { stance: "risk_on", volExpectation: "normal", note: "", updatedAt: 0 };

function snap(markUsd = 4): MarketSnapshot {
  const markX18 = parseUnits(String(markUsd), 18);
  return {
    def: DEFAULT_MARKET,
    vamm: ZERO,
    oracle: ZERO,
    feeBps: 30,
    paused: false,
    reserveBase: parseUnits("1000", 18),
    reserveQuote: parseUnits("4000", 18),
    markPriceX18: markX18,
    indexPriceX18: markX18,
    hasIndex: true,
    markIndexDevBps: 0,
  };
}

describe("macroDecisionToIntent", () => {
  it("hold → hold", () => {
    const i = macroDecisionToIntent({ action: "hold" }, snap(), MACRO, 1000, DEFAULT_REGIME);
    expect(i.kind).toBe("hold");
  });

  it("close → close with clamped fraction", () => {
    const d: MacroDecision = { action: "close", closeFractionBps: 5000 };
    const i = macroDecisionToIntent(d, snap(), MACRO, 1000, DEFAULT_REGIME);
    expect(i.kind).toBe("close");
    if (i.kind === "close") expect(i.fractionBps).toBe(5000);
  });

  it("close with no fraction defaults to full", () => {
    const i = macroDecisionToIntent({ action: "close" }, snap(), MACRO, 1000, DEFAULT_REGIME);
    expect(i.kind).toBe("close");
    if (i.kind === "close") expect(i.fractionBps).toBe(10000);
  });

  it("open within caps → open with correct side and size", () => {
    // neutral conviction cap = 500 * 0.7 = 350; requested 200 < cap; mark $4 → 50 GPU-hr
    const d: MacroDecision = { action: "open", side: "long", notionalUsd: 200 };
    const i = macroDecisionToIntent(d, snap(4), MACRO, 1000, DEFAULT_REGIME);
    expect(i.kind).toBe("open");
    if (i.kind === "open") {
      expect(i.isLong).toBe(true);
      expect(Math.abs(toNumberX18(i.baseSizeX18) - 50)).toBeLessThan(0.01);
    }
  });

  it("open over the conviction cap is clamped", () => {
    // neutral cap = 350; requested 10000 → clamp to 350; $4 → 87.5 GPU-hr
    const d: MacroDecision = { action: "open", side: "short", notionalUsd: 10000 };
    const i = macroDecisionToIntent(d, snap(4), MACRO, 100000, DEFAULT_REGIME);
    expect(i.kind).toBe("open");
    if (i.kind === "open") {
      expect(i.isLong).toBe(false);
      expect(Math.abs(toNumberX18(i.baseSizeX18) - 87.5)).toBeLessThan(0.01);
    }
  });

  it("risk-on lifts the conviction cap", () => {
    // risk_on cap = 500 * 1.0 = 500; requested 10000 → 500; $4 → 125 GPU-hr
    const d: MacroDecision = { action: "open", side: "long", notionalUsd: 10000 };
    const i = macroDecisionToIntent(d, snap(4), MACRO, 100000, RISK_ON);
    expect(i.kind).toBe("open");
    if (i.kind === "open") expect(Math.abs(toNumberX18(i.baseSizeX18) - 125)).toBeLessThan(0.01);
  });

  it("open with no free collateral → hold", () => {
    const d: MacroDecision = { action: "open", side: "long", notionalUsd: 200 };
    const i = macroDecisionToIntent(d, snap(4), MACRO, 0, DEFAULT_REGIME);
    expect(i.kind).toBe("hold");
  });
});
