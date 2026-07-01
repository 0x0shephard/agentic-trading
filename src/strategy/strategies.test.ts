import { describe, it, expect } from "vitest";
import { parseUnits } from "viem";
import pino from "pino";
import type { Logger } from "pino";
import type { StrategyContext } from "./types";
import type { Knobs } from "./knobs";
import { DEFAULT_KNOBS } from "./knobs";
import type { ArchetypeId, ArchetypeParams } from "../config/archetypes";
import { DEFAULT_ARCHETYPES } from "../config/archetypes";
import { MarketHistory } from "../market/history";
import { mulberry32 } from "../runtime/rng";
import { strategyFor } from "./registry";
import { DEFAULT_MARKET } from "../config/markets";

const silent: Logger = pino({ level: "silent" });
const ZERO = "0x0000000000000000000000000000000000000000" as const;

interface CtxOverrides {
  params: ArchetypeParams;
  markX18?: bigint;
  indexX18?: bigint;
  sizeX18?: bigint;
  freeCollateralX18?: bigint;
  history?: MarketHistory;
  knobs?: Knobs;
  hasIndex?: boolean;
  rngSeed?: number;
}

function makeCtx(o: CtxOverrides): StrategyContext {
  const markX18 = o.markX18 ?? parseUnits("4", 18);
  const indexX18 = o.indexX18 ?? markX18;
  const hasIndex = o.hasIndex ?? true;
  const devBps = indexX18 > 0n ? Number(((markX18 - indexX18) * 10000n) / indexX18) : 0;
  return {
    now: 0,
    rng: mulberry32(o.rngSeed ?? 1),
    snapshot: {
      def: DEFAULT_MARKET,
      vamm: ZERO,
      oracle: ZERO,
      feeBps: 30,
      paused: false,
      reserveBase: parseUnits("1000", 18),
      reserveQuote: parseUnits("4000", 18),
      markPriceX18: markX18,
      indexPriceX18: indexX18,
      hasIndex,
      markIndexDevBps: devBps,
    },
    account: {
      address: ZERO,
      sizeX18: o.sizeX18 ?? 0n,
      marginX18: 0n,
      entryPriceX18: 0n,
      realizedPnLX18: 0n,
      vaultUsdc6: 1_000_000_000n,
      freeCollateralX18: o.freeCollateralX18 ?? parseUnits("1000", 18),
    },
    history: o.history ?? new MarketHistory(),
    knobs: o.knobs ?? DEFAULT_KNOBS,
    params: o.params,
    logger: silent,
  };
}

function trendHistory(n: number, start: number, step: number): MarketHistory {
  const h = new MarketHistory();
  for (let i = 0; i < n; i++) {
    h.push({ t: i, markX18: parseUnits((start + i * step).toFixed(6), 18), indexX18: parseUnits(String(start), 18) });
  }
  return h;
}

describe("hedger (#1/#2)", () => {
  const short = DEFAULT_ARCHETYPES["hedger-short"];
  const long = DEFAULT_ARCHETYPES["hedger-long"];

  it("flat short-hedger opens a short", async () => {
    const i = await strategyFor("hedger-short").decide(makeCtx({ params: short }));
    expect(i.kind).toBe("open");
    if (i.kind === "open") expect(i.isLong).toBe(false);
  });
  it("flat long-hedger opens a long", async () => {
    const i = await strategyFor("hedger-long").decide(makeCtx({ params: long }));
    expect(i.kind).toBe("open");
    if (i.kind === "open") expect(i.isLong).toBe(true);
  });
  it("holds at target", async () => {
    const size = parseUnits("75", 18) * -1n; // 75 @ $4 = $300 short = target
    const i = await strategyFor("hedger-short").decide(makeCtx({ params: short, sizeX18: size }));
    expect(i.kind).toBe("hold");
  });
  it("trims above target", async () => {
    const size = parseUnits("120", 18) * -1n; // $480 > 300*1.15
    const i = await strategyFor("hedger-short").decide(makeCtx({ params: short, sizeX18: size }));
    expect(i.kind).toBe("close");
  });
});

describe("basis-arb (#3)", () => {
  const p = DEFAULT_ARCHETYPES["basis-arb"]; // threshold 150 bps (DEFAULT_KNOBS)

  it("shorts when mark rich beyond threshold", async () => {
    const i = await strategyFor("basis-arb").decide(
      makeCtx({ params: p, markX18: parseUnits("4.2", 18), indexX18: parseUnits("4", 18) }),
    );
    expect(i.kind).toBe("open");
    if (i.kind === "open") expect(i.isLong).toBe(false);
  });
  it("longs when mark cheap beyond threshold", async () => {
    const i = await strategyFor("basis-arb").decide(
      makeCtx({ params: p, markX18: parseUnits("3.8", 18), indexX18: parseUnits("4", 18) }),
    );
    expect(i.kind).toBe("open");
    if (i.kind === "open") expect(i.isLong).toBe(true);
  });
  it("holds within threshold", async () => {
    const i = await strategyFor("basis-arb").decide(
      makeCtx({ params: p, markX18: parseUnits("4.01", 18), indexX18: parseUnits("4", 18) }),
    );
    expect(i.kind).toBe("hold");
  });
  it("unwinds on convergence when in position", async () => {
    const i = await strategyFor("basis-arb").decide(
      makeCtx({ params: p, markX18: parseUnits("4", 18), indexX18: parseUnits("4", 18), sizeX18: parseUnits("10", 18) * -1n }),
    );
    expect(i.kind).toBe("close");
  });
  it("holds when no index", async () => {
    const i = await strategyFor("basis-arb").decide(
      makeCtx({ params: p, hasIndex: false, markX18: parseUnits("4.2", 18), indexX18: parseUnits("4", 18) }),
    );
    expect(i.kind).toBe("hold");
  });
});

describe("momentum (#4)", () => {
  const p = DEFAULT_ARCHETYPES.momentum;

  it("holds while warming up", async () => {
    const i = await strategyFor("momentum").decide(makeCtx({ params: p, history: new MarketHistory() }));
    expect(i.kind).toBe("hold");
  });
  it("goes long in an uptrend when flat", async () => {
    const i = await strategyFor("momentum").decide(makeCtx({ params: p, history: trendHistory(25, 4, 0.02) }));
    expect(i.kind).toBe("open");
    if (i.kind === "open") expect(i.isLong).toBe(true);
  });
  it("cuts a long on reversal (downtrend)", async () => {
    const i = await strategyFor("momentum").decide(
      makeCtx({ params: p, history: trendHistory(25, 8, -0.02), sizeX18: parseUnits("5", 18) }),
    );
    expect(i.kind).toBe("close");
  });
});

describe("market-maker (#5)", () => {
  const p = DEFAULT_ARCHETYPES["market-maker"];

  it("sells when mark rich", async () => {
    const i = await strategyFor("market-maker").decide(
      makeCtx({ params: p, markX18: parseUnits("4.2", 18), indexX18: parseUnits("4", 18) }),
    );
    expect(i.kind).toBe("open");
    if (i.kind === "open") expect(i.isLong).toBe(false);
  });
  it("buys when mark cheap", async () => {
    const i = await strategyFor("market-maker").decide(
      makeCtx({ params: p, markX18: parseUnits("3.8", 18), indexX18: parseUnits("4", 18) }),
    );
    expect(i.kind).toBe("open");
    if (i.kind === "open") expect(i.isLong).toBe(true);
  });
  it("flattens when reverted with a position", async () => {
    const i = await strategyFor("market-maker").decide(
      makeCtx({ params: p, markX18: parseUnits("4", 18), indexX18: parseUnits("4", 18), sizeX18: parseUnits("2", 18) * -1n }),
    );
    expect(i.kind).toBe("close");
  });
  it("stands aside in stress when flat", async () => {
    const i = await strategyFor("market-maker").decide(
      makeCtx({ params: p, markX18: parseUnits("5", 18), indexX18: parseUnits("4", 18) }),
    );
    expect(i.kind).toBe("hold");
  });
});

describe("hft-taker (#6)", () => {
  const p = DEFAULT_ARCHETYPES["hft-taker"];

  it("opens when flat", async () => {
    const i = await strategyFor("hft-taker").decide(makeCtx({ params: p }));
    expect(i.kind).toBe("open");
  });
  it("closes when in a position", async () => {
    const i = await strategyFor("hft-taker").decide(makeCtx({ params: p, sizeX18: parseUnits("1", 18) }));
    expect(i.kind).toBe("close");
  });
});

describe("degen (#8)", () => {
  const p = DEFAULT_ARCHETYPES.degen;

  it("opens a leveraged position when flat", async () => {
    const i = await strategyFor("degen").decide(makeCtx({ params: p }));
    expect(i.kind).toBe("open");
  });
  it("holds once in a position", async () => {
    const i = await strategyFor("degen").decide(makeCtx({ params: p, sizeX18: parseUnits("50", 18) }));
    expect(i.kind).toBe("hold");
  });
  it("respects the $500 notional safety cap", async () => {
    const i = await strategyFor("degen").decide(
      makeCtx({ params: p, freeCollateralX18: parseUnits("100000", 18), markX18: parseUnits("4", 18) }),
    );
    expect(i.kind).toBe("open");
    if (i.kind === "open") {
      const expected = parseUnits("125", 18); // $500 / $4
      const diff = i.baseSizeX18 > expected ? i.baseSizeX18 - expected : expected - i.baseSizeX18;
      expect(diff < parseUnits("0.01", 18)).toBe(true);
    }
  });
});

describe("registry", () => {
  it("maps all 8 archetypes (incl. LLM macro)", () => {
    const ids: ArchetypeId[] = [
      "hedger-short",
      "hedger-long",
      "basis-arb",
      "momentum",
      "market-maker",
      "hft-taker",
      "degen",
      "macro",
    ];
    for (const id of ids) expect(strategyFor(id)).toBeTruthy();
  });
});
