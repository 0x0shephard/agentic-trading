// Fork harness for RMF Appendix F stress scenarios.
//
// SAFETY MODEL — read before changing anything in this file.
//
// The single failure mode that could damage the live deployment is a fault
// injection (oracle freeze, depeg, pause) landing on real Sepolia contracts.
// Two independent mechanisms prevent that, either of which alone suffices:
//
//   1. POSITIVE FORK PROOF. Every entry point calls assertAnvilFork(), which
//      invokes `anvil_nodeInfo` — an RPC method that exists ONLY on anvil and
//      fails on any real node. We refuse to proceed unless it succeeds.
//      NOTE: the swarm's CHAIN_ID === 11155111 guard does NOT help here, because
//      an anvil fork reports the same chain id as live Sepolia. Chain id cannot
//      distinguish fork from live. This can.
//
//   2. NO OWNER KEY. Privileged calls (setOracle, updatePrice, setPause, ...) are
//      made via anvil_impersonateAccount, which only works on a fork. This module
//      never loads or holds a private key for any protocol owner, so even a total
//      misconfiguration cannot sign an owner transaction against the live chain.
import { createPublicClient, createTestClient, createWalletClient, http, publicActions, walletActions } from "viem";
import type { Address, Hex, PublicClient, TestClient, WalletClient } from "viem";
import { sepolia } from "viem/chains";
import { logger } from "../logging/logger";

/** Fork RPC. Defaults to a local anvil. Never point this at a public endpoint. */
export const FORK_RPC_URL = process.env.FORK_RPC_URL?.trim() || "http://127.0.0.1:8545";

/** Upstream chain the fork is taken from (read-only use: pinning a block). */
export const UPSTREAM_RPC_URL =
  process.env.SEPOLIA_RPC_URL?.trim() || "https://ethereum-sepolia-rpc.publicnode.com";

export interface ForkClients {
  pub: PublicClient;
  test: TestClient;
  rpcUrl: string;
}

/**
 * Proof-of-fork. Throws unless the endpoint is an anvil instance.
 *
 * `anvil_nodeInfo` is not implemented by geth/reth/erigon or by any hosted
 * provider, so a successful response is affirmative evidence we are on a fork
 * rather than an assumption based on the URL.
 */
export async function assertAnvilFork(rpcUrl: string): Promise<void> {
  const probe = createTestClient({ mode: "anvil", chain: sepolia, transport: http(rpcUrl) });
  let info: unknown;
  try {
    info = await probe.request({ method: "anvil_nodeInfo" } as never);
  } catch (e) {
    throw new Error(
      `REFUSING TO RUN: ${rpcUrl} is not an anvil fork (anvil_nodeInfo failed: ` +
        `${e instanceof Error ? e.message.split("\n")[0] : String(e)}). ` +
        `Stress scenarios inject faults and must never touch a live deployment. ` +
        `Start a fork with: anvil --fork-url <SEPOLIA_RPC> --port 8545`,
    );
  }
  // Belt and braces: a fork must also be loopback. Guards against someone
  // exposing an anvil instance publicly and pointing this at it by mistake.
  const host = new URL(rpcUrl).hostname;
  if (!["127.0.0.1", "localhost", "0.0.0.0", "::1"].includes(host)) {
    throw new Error(`REFUSING TO RUN: fork RPC host "${host}" is not loopback.`);
  }
  const forkCfg = (info as { forkConfig?: { forkUrl?: string; forkBlockNumber?: string } })?.forkConfig;
  logger.info(
    { rpcUrl, forkedFrom: forkCfg?.forkUrl ? "configured" : "none", forkBlock: forkCfg?.forkBlockNumber },
    "fork verified (anvil_nodeInfo ok)",
  );
}

/** Create fork-bound clients. Refuses to return unless the endpoint is a fork. */
export async function connectFork(rpcUrl: string = FORK_RPC_URL): Promise<ForkClients> {
  await assertAnvilFork(rpcUrl);
  const transport = http(rpcUrl);
  // cacheTime: 0 is required, not cosmetic. viem caches getBlockNumber for its
  // polling interval (~4s) by default; during a scenario we sample state faster
  // than that and would otherwise record stale blocks, prices and OI.
  return {
    pub: createPublicClient({ chain: sepolia, transport, cacheTime: 0 }),
    test: createTestClient({ mode: "anvil", chain: sepolia, transport, cacheTime: 0 }).extend(publicActions) as TestClient,
    rpcUrl,
  };
}

/**
 * A wallet bound to an address we do NOT hold a key for, via anvil impersonation.
 * This is how every privileged action is performed. It cannot work off-fork.
 */
export async function impersonate(f: ForkClients, address: Address): Promise<WalletClient> {
  await f.test.request({ method: "anvil_impersonateAccount", params: [address] } as never);
  // Owners may hold no ETH on the fork; fund them so privileged calls can be sent.
  await f.test.request({
    method: "anvil_setBalance",
    params: [address, "0x56BC75E2D63100000"], // 100 ETH
  } as never);
  return createWalletClient({ account: address, chain: sepolia, transport: http(f.rpcUrl) }).extend(walletActions);
}

export async function stopImpersonating(f: ForkClients, address: Address): Promise<void> {
  await f.test.request({ method: "anvil_stopImpersonatingAccount", params: [address] } as never);
}

// ── State control ──────────────────────────────────────────────────────────

/** Snapshot chain state. Every scenario branches from one shared baseline. */
export async function snapshot(f: ForkClients): Promise<Hex> {
  return (await f.test.request({ method: "evm_snapshot" } as never)) as Hex;
}

/** Restore a snapshot. Note: a snapshot id is consumed once reverted. */
export async function revert(f: ForkClients, id: Hex): Promise<void> {
  const ok = await f.test.request({ method: "evm_revert", params: [id] } as never);
  if (ok !== true) throw new Error(`evm_revert(${id}) failed — snapshot may already be consumed`);
}

// ── Time control (staleness and funding scenarios) ─────────────────────────

export async function increaseTime(f: ForkClients, seconds: number): Promise<void> {
  await f.test.request({ method: "evm_increaseTime", params: [seconds] } as never);
  await mine(f, 1);
}

// ── Block production control (F-2 liveness interruption) ────────────────────

export async function mine(f: ForkClients, blocks = 1): Promise<void> {
  // Use viem's typed action rather than a raw request: anvil rejects a hex-string
  // block count, and a silently-unmined block would corrupt every scenario.
  await (f.test as unknown as { mine: (a: { blocks: number }) => Promise<void> }).mine({ blocks });
}

/**
 * Halt block production. Transactions submitted while halted queue in the
 * mempool rather than settling — this is how the "users cannot act while the
 * market moves" phase of F-2 is modelled.
 */
export async function haltBlockProduction(f: ForkClients): Promise<void> {
  await f.test.request({ method: "evm_setAutomine", params: [false] } as never);
  await f.test.request({ method: "anvil_setBlockTimestampInterval", params: [12] } as never);
  logger.warn("block production HALTED — transactions will queue");
}

/** Resume production and release the queued backlog in one burst. */
export async function resumeBlockProduction(f: ForkClients): Promise<{ released: number }> {
  const pending = await f.pub.getBlockTransactionCount({ blockTag: "pending" }).catch(() => 0);
  await f.test.request({ method: "evm_setAutomine", params: [true] } as never);
  await mine(f, 1);
  logger.warn({ released: pending }, "block production RESUMED — backlog released");
  return { released: Number(pending) };
}

/** Current fork block timestamp, seconds. */
export async function forkNow(f: ForkClients): Promise<number> {
  const b = await f.pub.getBlock({ blockTag: "latest" });
  return Number(b.timestamp);
}
