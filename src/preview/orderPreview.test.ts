import { describe, it, expect } from "vitest";
import { quoteBuy, quoteSell, buildOpenOrderPreview } from "./orderPreview";
import { amountLimitWithSlippage } from "./sizing";

const WAD = 10n ** 18n;
// Simple balanced book: 1000 base / 4000 quote → spot mark = 4.00.
const reserveBase = 1000n * WAD;
const reserveQuote = 4000n * WAD;
const SPOT = 4n * WAD;
const feeBps = 10n; // 0.10%

describe("quoteBuy", () => {
  const q = quoteBuy({ baseAmount: WAD, reserveBase, reserveQuote, minReserveBase: 0n, feeBps });
  it("returns a positive cost and consumes the requested base", () => {
    expect(q.quoteAmount > 0n).toBe(true);
    expect(q.actualBase).toBe(WAD);
  });
  it("avg price is at or above spot (impact + fee push it up)", () => {
    expect(q.avgPrice >= SPOT).toBe(true);
  });
  it("buying pushes the mark up", () => {
    expect(q.postTradeMark > SPOT).toBe(true);
  });
});

describe("quoteSell", () => {
  const q = quoteSell({ baseAmount: WAD, reserveBase, reserveQuote, minReserveQuote: 0n, feeBps });
  it("returns positive output", () => {
    expect(q.quoteAmount > 0n).toBe(true);
  });
  it("avg price is at or below spot (impact + fee push it down)", () => {
    expect(q.avgPrice <= SPOT).toBe(true);
  });
  it("selling pushes the mark down", () => {
    expect(q.postTradeMark < SPOT).toBe(true);
  });
});

describe("buildOpenOrderPreview (long, well-collateralized)", () => {
  const preview = buildOpenOrderPreview({
    isLong: true,
    sizeX18: WAD,
    reserveBase,
    reserveQuote,
    feeBps,
    imrBps: 1000n, // 10%
    mmrBps: 500n, // 5%
    oraclePrice: SPOT,
    quoteFreeCollateral: 100n * WAD,
  });
  it("is executable", () => {
    expect(preview.ok).toBe(true);
    expect(preview.reason).toBeNull();
  });
  it("produces sane notional / fee / margin", () => {
    expect(preview.notional > 0n).toBe(true);
    expect(preview.fee > 0n).toBe(true);
    expect(preview.initialMargin > 0n).toBe(true);
    expect(preview.resultingSize).toBe(WAD); // opened ~1 base from flat
  });
  it("fee ≈ notional * 0.10%", () => {
    const expectedFee = (preview.notional * feeBps) / 10000n;
    // mulDivRoundUp may add at most 1 wei vs floor.
    expect(preview.fee - expectedFee <= 1n).toBe(true);
  });
  it("amountLimit is 0 when no limit price is supplied", () => {
    expect(preview.amountLimit).toBe(0n);
  });
});

describe("buildOpenOrderPreview rejects under-collateralized orders", () => {
  const preview = buildOpenOrderPreview({
    isLong: true,
    sizeX18: 500n * WAD, // huge relative to collateral
    reserveBase,
    reserveQuote,
    feeBps,
    imrBps: 1000n,
    mmrBps: 500n,
    oraclePrice: SPOT,
    quoteFreeCollateral: 1n * WAD, // only $1
  });
  it("is not ok and explains why", () => {
    expect(preview.ok).toBe(false);
    expect(typeof preview.reason).toBe("string");
  });
});

describe("amountLimitWithSlippage direction", () => {
  it("long adds slippage (ceiling on cost)", () => {
    expect(amountLimitWithSlippage(true, 10000n, 100)).toBe(10100n); // +1%
  });
  it("short subtracts slippage (floor on output)", () => {
    expect(amountLimitWithSlippage(false, 10000n, 100)).toBe(9900n); // -1%
  });
});
