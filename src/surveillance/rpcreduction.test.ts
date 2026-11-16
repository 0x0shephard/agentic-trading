import { describe, expect, it } from "vitest";
import { encodeAbiParameters, toEventSelector, pad } from "viem";
import type { Address, PublicClient } from "viem";
import { CONTRACTS } from "../config/addresses";
import type { MarketDef } from "../config/markets";
import { ADMIN_EVENTS, adminWatchPass, newAdminWatchState } from "./alerting/adminwatch";
import { checkHealth, newHealthState } from "./alerting/health";
import { newPriceGuardState, priceGuardPass } from "./alerting/priceguard";
import type { ChainSnapshot, MarketSnap } from "./alerting/chainsnapshot";

const MKT: MarketDef = { name: "TEST-PERP", displayName: "Test", marketId: `0x${"11".repeat(32)}` };
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const E18 = 10n ** 18n;

function snap(ms: Partial<MarketSnap>): ChainSnapshot {
  return {
    takenAt: Date.now(),
    badDebt: 0n,
    ifBalance: 0n,
    ifTotalPaid: 0n,
    markets: new Map([[MKT.name, {
      cfg: { vamm: A(1), oracle: A(2), paused: false },
      adapter: { cuOracle: A(3), assetId: `0x${"22".repeat(32)}`, maxAge: 43_200n },
      latest: { price: 2n * E18, lastUpdatedAt: BigInt(Math.floor(Date.now() / 1000)) },
      indexPriceX18: 2n * E18,
      markPriceX18: 2n * E18,
      ...ms,
    }]]),
  };
}

/** A client that fails the test if any RPC is used. */
const noRpc = new Proxy({}, { get: () => () => { throw new Error("unexpected RPC"); } }) as unknown as PublicClient;

describe("checkHealth on a shared snapshot", () => {
  it("makes no RPC calls when given a snapshot and no accounts", async () => {
    expect(await checkHealth(noRpc, newHealthState(), [], [MKT], snap({}))).toEqual([]);
  });

  it("flags an adapter that refuses to serve as oracle-down", async () => {
    const out = await checkHealth(noRpc, newHealthState(), [], [MKT], snap({ indexPriceX18: null }));
    expect(out.map((s) => s.key)).toEqual(["oracle-down:TEST-PERP"]);
  });

  it("skips a market whose getMarket read failed (no false oracle-down)", async () => {
    const out = await checkHealth(noRpc, newHealthState(), [], [MKT], snap({ cfg: null, indexPriceX18: null }));
    expect(out).toEqual([]);
  });

  it("reports pause and staleness from the snapshot", async () => {
    const old = BigInt(Math.floor(Date.now() / 1000) - 10 * 3600);
    const out = await checkHealth(noRpc, newHealthState(), [], [MKT], snap({
      cfg: { vamm: A(1), oracle: A(2), paused: true },
      latest: { price: 2n * E18, lastUpdatedAt: old },
    }));
    expect(out.map((s) => s.key)).toEqual(["paused:TEST-PERP", "stale-critical:TEST-PERP"]);
  });
});

describe("priceGuardPass on a shared snapshot", () => {
  it("uses the snapshot price without RPC reads", async () => {
    const st = newPriceGuardState();
    await priceGuardPass(noRpc, st, { send: false, markets: [MKT], snapshot: snap({}) });
    const out = await priceGuardPass(noRpc, st, { send: false, markets: [MKT], snapshot: snap({ indexPriceX18: 3n * E18 }) });
    expect(out).toHaveLength(1);
    expect(st.lastAccepted.get(MKT.name)).toBe(2);
  });
});

describe("adminWatchPass RPC use", () => {
  function mockClient(o: { head: bigint; nonceAt: (b: bigint) => number; logs?: unknown[]; blocks?: Record<string, unknown[]> }) {
    const calls: string[] = [];
    const pc = {
      getBlockNumber: async () => { calls.push("blockNumber"); return o.head; },
      request: async () => { calls.push("getLogs"); return o.logs ?? []; },
      getTransactionCount: async ({ blockNumber }: { blockNumber: bigint }) => { calls.push("nonce"); return o.nonceAt(blockNumber); },
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        calls.push(`block:${blockNumber}`);
        return { transactions: o.blocks?.[blockNumber.toString()] ?? [] };
      },
    } as unknown as PublicClient;
    return { pc, calls };
  }

  it("does not download blocks when the admin nonce is unchanged", async () => {
    const { pc, calls } = mockClient({ head: 110n, nonceAt: () => 7 });
    const st = newAdminWatchState(100n);
    expect(await adminWatchPass(pc, st, { send: false })).toEqual([]);
    expect(calls.filter((c) => c.startsWith("block:"))).toEqual([]);
    expect(calls.filter((c) => c === "getLogs")).toHaveLength(1);
    expect(st.cursorBlock).toBe(110n);
  });

  it("scans only until every new nonce is matched, and alerts non-routine txs", async () => {
    const tx = { hash: `0x${"ab".repeat(32)}`, from: CONTRACTS.treasury, to: A(9), input: "0xdeadbeef", value: 0n };
    const { pc, calls } = mockClient({ head: 110n, nonceAt: (b) => (b >= 103n ? 8 : 7), blocks: { "103": [tx] } });
    const out = await adminWatchPass(pc, newAdminWatchState(100n), { send: false });
    expect(out.map((a) => a.title)).toEqual(["Admin key transaction"]);
    expect(calls.filter((c) => c.startsWith("block:"))).toEqual(["block:101", "block:102", "block:103"]);
  });

  it("decodes admin events from the combined getLogs and ignores unwatched (address, topic) pairs", async () => {
    const def = ADMIN_EVENTS.find((d) => d.title === "Market pause changed")!;
    const topic0 = toEventSelector(def.event as never);
    const log = (address: Address) => ({
      address, topics: [topic0, pad(`0x${"33".repeat(32)}`)], data: encodeAbiParameters([{ type: "bool" }], [true]),
      transactionHash: `0x${"cd".repeat(32)}`, logIndex: "0x1", blockNumber: "0x66",
    });
    const { pc } = mockClient({ head: 110n, nonceAt: () => 7, logs: [log(CONTRACTS.marketRegistry), log(CONTRACTS.clearingHouse)] });
    const out = await adminWatchPass(pc, newAdminWatchState(100n), { send: false });
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("Admin action: Market pause changed");
    expect(out[0]!.detail).toContain("PAUSED");
    expect(out[0]!.fields).toEqual({ Contract: "MarketRegistry", Block: 102 });
  });

  it("keeps the cursor when getLogs fails so the window is retried", async () => {
    const pc = { getBlockNumber: async () => 110n, request: async () => { throw new Error("boom"); } } as unknown as PublicClient;
    const st = newAdminWatchState(100n);
    await adminWatchPass(pc, st, { send: false });
    expect(st.cursorBlock).toBe(100n);
  });
});
