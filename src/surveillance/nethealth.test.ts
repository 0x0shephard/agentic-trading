import { describe, it, expect } from "vitest";
import type { PublicClient } from "viem";
import {
  checkNetHealth, newNetHealthState,
  type NetClients, type NetConfig,
} from "./alerting/nethealth";

// Minimal fake client: only getBlockNumber is exercised by checkNetHealth.
function fakeClient(head: bigint | (() => Promise<bigint>)): PublicClient {
  const getBlockNumber = typeof head === "function" ? head : async () => head;
  return { getBlockNumber } as unknown as PublicClient;
}
function clients(primaryHead: bigint | (() => Promise<bigint>), fallbackHead?: bigint | (() => Promise<bigint>)): NetClients {
  return {
    primary: { ep: { label: "primary", url: "http://primary" }, client: fakeClient(primaryHead) },
    fallback: fallbackHead === undefined ? undefined : { ep: { label: "fallback", url: "http://fallback" }, client: fakeClient(fallbackHead) },
  };
}

const CFG: NetConfig = { stallWarnMs: 180_000, stallCritMs: 600_000, lagBlocks: 20, downConsecutive: 2 };
const throws = async (): Promise<bigint> => { throw new Error("ECONNREFUSED"); };

describe("checkNetHealth", () => {
  it("is quiet while the head advances", async () => {
    const st = newNetHealthState(0);
    expect(await checkNetHealth(clients(100n), st, CFG, 0)).toHaveLength(0);
    expect(await checkNetHealth(clients(101n), st, CFG, 60_000)).toHaveLength(0);
    expect(await checkNetHealth(clients(102n), st, CFG, 120_000)).toHaveLength(0);
    expect(st.lastHead).toBe(102n);
  });

  it("warns then criticals when the head stops advancing", async () => {
    const st = newNetHealthState(0);
    await checkNetHealth(clients(100n), st, CFG, 0); // establish baseline

    // still stuck at 100, under the warn window -> quiet
    expect(await checkNetHealth(clients(100n), st, CFG, 120_000)).toHaveLength(0);

    // past warn window -> warning
    const warn = await checkNetHealth(clients(100n), st, CFG, 200_000);
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ key: "rpc-stalled", severity: "warning" });

    // past crit window -> critical
    const crit = await checkNetHealth(clients(100n), st, CFG, 700_000);
    expect(crit[0]).toMatchObject({ key: "rpc-stalled", severity: "critical" });
  });

  it("clears the stall once the head advances again", async () => {
    const st = newNetHealthState(0);
    await checkNetHealth(clients(100n), st, CFG, 0);
    expect(await checkNetHealth(clients(100n), st, CFG, 700_000)).toHaveLength(1); // stalled
    // new block arrives — clock resets, no signal
    expect(await checkNetHealth(clients(101n), st, CFG, 760_000)).toHaveLength(0);
    expect(st.lastHeadChangedAt).toBe(760_000);
  });

  it("rides out a single failed poll but pages on the second", async () => {
    const st = newNetHealthState(0);
    await checkNetHealth(clients(100n), st, CFG, 0);
    // first failure: under downConsecutive, stays quiet
    expect(await checkNetHealth(clients(throws), st, CFG, 60_000)).toHaveLength(0);
    expect(st.downCount).toBe(1);
    // second consecutive failure: rpc-down
    const down = await checkNetHealth(clients(throws), st, CFG, 120_000);
    expect(down[0]).toMatchObject({ key: "rpc-down", severity: "critical" });
    expect(st.downCount).toBe(2);
  });

  it("a successful poll resets the down counter", async () => {
    const st = newNetHealthState(0);
    await checkNetHealth(clients(throws), st, CFG, 0);
    expect(st.downCount).toBe(1);
    await checkNetHealth(clients(100n), st, CFG, 60_000);
    expect(st.downCount).toBe(0);
  });

  it("attributes a down primary to the provider when the fallback is up", async () => {
    const st = newNetHealthState(0);
    st.downCount = 1; // one prior miss, so this one crosses the gate
    const down = await checkNetHealth(clients(throws, 500n), st, CFG, 0);
    const d = down[0]!;
    expect(d.key).toBe("rpc-down");
    expect(d.detail).toContain("fallback endpoint is responding");
    expect(String(d.fields.Fallback)).toContain("500");
  });

  it("warns when the primary lags the fallback by the threshold", async () => {
    const st = newNetHealthState(0);
    const sig = await checkNetHealth(clients(100n, 125n), st, CFG, 0); // 25-block gap >= 20
    expect(sig.map((s) => s.key)).toContain("rpc-lag");
    const lag = sig.find((s) => s.key === "rpc-lag")!;
    expect(lag.fields["Lag (blocks)"]).toBe("25");
  });

  it("does not warn on a small primary/fallback gap", async () => {
    const st = newNetHealthState(0);
    const sig = await checkNetHealth(clients(100n, 105n), st, CFG, 0); // 5-block gap < 20
    expect(sig.map((s) => s.key)).not.toContain("rpc-lag");
  });
});
