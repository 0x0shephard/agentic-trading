import { describe, it, expect } from "vitest";
import { computeLeverageReport, type AccountLeverageInput } from "./leverage";

// Helper: an account with a single position. marginRatio is a fraction (0.05 = 5%).
const acct = (account: string, freeCollateral: number, notional: number, marginRatio: number, imrBps = 500): AccountLeverageInput =>
  ({ account, freeCollateral, positions: [{ market: "M", notional, marginRatio, imrBps }] });

describe("computeLeverageReport", () => {
  it("excludes accounts with no open positions", () => {
    const r = computeLeverageReport([{ account: "a", freeCollateral: 100, positions: [] }]);
    expect(r.accountsWithPositions).toBe(0);
    expect(r.shareAbove80PctCap).toBe(0);
  });

  it("computes account effective leverage = notional / equity (equity = collateral + uPnL)", () => {
    // free collateral 0, one position notional 1000, marginRatio 0.10 → equity = 0.10*1000 = 100
    // leverage = 1000 / 100 = 10x
    const r = computeLeverageReport([acct("a", 0, 1000, 0.10)]);
    expect(r.accounts[0]!.leverage).toBeCloseTo(10, 5);
  });

  it("adds free collateral to equity", () => {
    // free collateral 100, position notional 1000 marginRatio 0.10 → equity = 100 + 100 = 200
    // leverage = 1000/200 = 5x
    const r = computeLeverageReport([acct("a", 100, 1000, 0.10)]);
    expect(r.accounts[0]!.leverage).toBeCloseTo(5, 5);
  });

  it("flags a position above 80% of cap (margin ratio < IMR/0.8)", () => {
    // IMR 5% (500 bps): cap = 20x, 80% of cap = 16x → threshold margin ratio = 0.05/0.8 = 0.0625
    const atMax = computeLeverageReport([acct("a", 0, 1000, 0.05)]);   // opened at cap → flagged
    expect(atMax.accounts[0]!.aboveCap80).toBe(true);
    const below = computeLeverageReport([acct("b", 0, 1000, 0.07)]);   // 0.07 > 0.0625 → not flagged
    expect(below.accounts[0]!.aboveCap80).toBe(false);
    const boundary = computeLeverageReport([acct("c", 0, 1000, 0.0625)]); // exactly 80% → not flagged
    expect(boundary.accounts[0]!.aboveCap80).toBe(false);
  });

  it("flags the account if ANY position is above 80% of cap", () => {
    const multi: AccountLeverageInput = {
      account: "a", freeCollateral: 0,
      positions: [
        { market: "M1", notional: 500, marginRatio: 0.20, imrBps: 500 }, // safe
        { market: "M2", notional: 500, marginRatio: 0.05, imrBps: 500 }, // at cap → flags account
      ],
    };
    expect(computeLeverageReport([multi]).accounts[0]!.aboveCap80).toBe(true);
  });

  it("treats an insolvent account (equity ≤ 0) as flagged + infinite leverage", () => {
    // free collateral -200, position marginRatio 0.10 notional 1000 → equity = -200 + 100 = -100 ≤ 0
    const r = computeLeverageReport([acct("a", -200, 1000, 0.10)]);
    expect(r.accounts[0]!.leverage).toBe(Infinity);
    expect(r.accounts[0]!.aboveCap80).toBe(true);
    expect(r.insolventAccounts).toBe(1);
  });

  it("computes the share above 80% of cap over accounts with positions", () => {
    const r = computeLeverageReport([
      acct("a", 0, 1000, 0.05),  // flagged
      acct("b", 0, 1000, 0.05),  // flagged
      acct("c", 0, 1000, 0.20),  // safe
      acct("d", 0, 1000, 0.20),  // safe
      { account: "e", freeCollateral: 100, positions: [] }, // excluded (no positions)
    ]);
    expect(r.accountsWithPositions).toBe(4);
    expect(r.flaggedAccounts).toBe(2);
    expect(r.shareAbove80PctCap).toBeCloseTo(0.5, 5);
  });

  it("buckets the distribution, with insolvent accounts in the open-ended top bucket", () => {
    const r = computeLeverageReport([
      acct("a", 0, 100, 1.0),     // equity 100, lev 1x → bucket 1-2x
      acct("b", 0, 1000, 0.10),   // lev 10x → 10-15x
      acct("c", 0, 1000, 0.04),   // lev 25x → 20x+
      acct("d", -50, 1000, 0.04), // equity -10 → insolvent → 20x+
    ]);
    const byBucket = Object.fromEntries(r.distribution.map((b) => [b.bucket, b.count]));
    expect(byBucket["1-2x"]).toBe(1);
    expect(byBucket["10-15x"]).toBe(1);
    expect(byBucket["20x+"]).toBe(2); // the 25x and the insolvent
  });
});
