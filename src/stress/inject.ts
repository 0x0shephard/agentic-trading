// Fault injection primitives for the RMF Appendix F scenarios.
//
// Two levers, deliberately:
//
//   1. commitRevealPrice() drives the index through the REAL commit/reveal path
//      the production feed uses. Preferred wherever it works, because the
//      protocol experiences exactly what it would in production.
//
//   2. forcePriceData() writes CuOracle storage directly. Required for states the
//      real path refuses to produce — updatePrices() reverts on price == 0, and
//      lastUpdatedAt is always set to commit time, so arbitrary staleness cannot
//      be reached by committing. F-5 needs both of those.
//
// Both require anvil (impersonation / anvil_setStorageAt) and therefore cannot
// run against a live deployment.
import { encodeAbiParameters, encodePacked, keccak256, pad, parseAbi, toHex } from "viem";
import type { Address, Hex } from "viem";
import type { ForkClients } from "./fork";
import { impersonate, mine } from "./fork";
import { logger } from "../logging/logger";

const CU_ABI = parseAbi([
  "function owner() view returns (address)",
  "function allowedRoles(address) view returns (bool)",
  "function grantRole(address)",
  "function commitPrice(bytes32,bytes32)",
  "function updatePrices(bytes32,uint256,bytes32)",
  "function getLatestPrice(bytes32) view returns ((uint256 price, uint256 lastUpdatedAt))",
  "function minCommitRevealDelay() view returns (uint256)",
  "function maxCommitAge() view returns (uint256)",
  "function minTimeInterval() view returns (uint256)",
]);

const ADAPTER_ABI = parseAbi([
  "function cuOracle() view returns (address)",
  "function assetId() view returns (bytes32)",
  "function maxAge() view returns (uint256)",
  "function getPrice() view returns (uint256)",
]);

export interface IndexHandle {
  adapter: Address;
  cuOracle: Address;
  assetId: Hex;
  maxAge: bigint;
}

/** Resolve the oracle chain (adapter -> CuOracle -> assetId) for a market. */
export async function resolveIndex(f: ForkClients, adapter: Address): Promise<IndexHandle> {
  const [cuOracle, assetId, maxAge] = await Promise.all([
    f.pub.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: "cuOracle" }),
    f.pub.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: "assetId" }),
    f.pub.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: "maxAge" }).catch(() => 0n),
  ]) as [Address, Hex, bigint];
  return { adapter, cuOracle, assetId, maxAge };
}

export async function readIndex(f: ForkClients, h: IndexHandle): Promise<{ price: bigint; lastUpdatedAt: bigint }> {
  const d = (await f.pub.readContract({
    address: h.cuOracle, abi: CU_ABI, functionName: "getLatestPrice", args: [h.assetId],
  })) as { price: bigint; lastUpdatedAt: bigint };
  return { price: d.price, lastUpdatedAt: d.lastUpdatedAt };
}

/** True when the adapter currently serves a price (false = fail-closed tripped). */
export async function indexServes(f: ForkClients, h: IndexHandle): Promise<boolean> {
  try { await f.pub.readContract({ address: h.adapter, abi: ADAPTER_ABI, functionName: "getPrice" }); return true; }
  catch { return false; }
}

/**
 * Drive the index via the production commit/reveal flow.
 * Advances fork time by minCommitRevealDelay between commit and reveal, which is
 * unavoidable: the contract enforces it.
 */
export async function commitRevealPrice(f: ForkClients, h: IndexHandle, priceX18: bigint): Promise<void> {
  if (priceX18 === 0n) throw new Error("updatePrices() rejects price 0 — use forcePriceData() instead");
  const owner = (await f.pub.readContract({ address: h.cuOracle, abi: CU_ABI, functionName: "owner" })) as Address;
  const w = await impersonate(f, owner);

  const hasRole = (await f.pub.readContract({ address: h.cuOracle, abi: CU_ABI, functionName: "allowedRoles", args: [owner] })) as boolean;
  if (!hasRole) {
    const g = await w.writeContract({ address: h.cuOracle, abi: CU_ABI, functionName: "grantRole", args: [owner], chain: null, account: owner });
    await f.pub.waitForTransactionReceipt({ hash: g });
  }

  const nonce = pad(toHex(BigInt(Date.now())), { size: 32 });
  const commit = keccak256(encodePacked(["uint256", "bytes32"], [priceX18, nonce]));

  const c = await w.writeContract({ address: h.cuOracle, abi: CU_ABI, functionName: "commitPrice", args: [h.assetId, commit], chain: null, account: owner });
  await f.pub.waitForTransactionReceipt({ hash: c });

  const delay = (await f.pub.readContract({ address: h.cuOracle, abi: CU_ABI, functionName: "minCommitRevealDelay" }).catch(() => 0n)) as bigint;
  if (delay > 0n) {
    await f.test.request({ method: "evm_increaseTime", params: [Number(delay) + 1] } as never);
    await mine(f, 1);
  }

  const r = await w.writeContract({ address: h.cuOracle, abi: CU_ABI, functionName: "updatePrices", args: [h.assetId, priceX18, nonce], chain: null, account: owner });
  await f.pub.waitForTransactionReceipt({ hash: r });
}

// ── Direct storage control (states the real path cannot produce) ────────────

/**
 * Locate the storage slot of `latestPrices[assetId]` empirically, by scanning
 * candidate mapping slots and matching the known current price.
 *
 * Discovery rather than a hardcoded index: the layout is an implementation
 * detail we must not silently assume. If it moves, this fails loudly instead of
 * writing to the wrong slot.
 */
const slotCache = new Map<string, bigint>();

export async function findPriceSlot(f: ForkClients, h: IndexHandle, maxSlot = 24): Promise<bigint> {
  // Cache per (oracle, asset): discovery matches against the CURRENT price, so it
  // stops working once we have forced the price to 0 — which is exactly the state
  // a zero-price scenario leaves behind. Discover once, reuse thereafter.
  const key = `${h.cuOracle.toLowerCase()}:${h.assetId.toLowerCase()}`;
  const hit = slotCache.get(key);
  if (hit !== undefined) return hit;

  const { price } = await readIndex(f, h);
  if (price === 0n) {
    throw new Error("cannot discover latestPrices slot while price is 0 — call findPriceSlot() before forcing a zero price");
  }
  for (let n = 0n; n <= BigInt(maxSlot); n++) {
    const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [h.assetId, n])));
    const raw = await f.pub.getStorageAt({ address: h.cuOracle, slot: toHex(base, { size: 32 }) });
    if (raw && BigInt(raw) === price) {
      logger.info({ cuOracle: h.cuOracle, mappingSlot: n.toString() }, "located latestPrices storage slot");
      slotCache.set(key, base);
      return base;
    }
  }
  throw new Error(`could not locate latestPrices slot for ${h.cuOracle} (scanned 0..${maxSlot})`);
}

/**
 * Write price and/or lastUpdatedAt directly.
 * Used for: zero-price oracle failure, and arbitrary staleness (F-5), neither of
 * which the commit/reveal path can express.
 */
export async function forcePriceData(
  f: ForkClients, h: IndexHandle, opts: { priceX18?: bigint; lastUpdatedAt?: bigint; mine?: boolean },
): Promise<void> {
  const base = await findPriceSlot(f, h);
  if (opts.priceX18 !== undefined) {
    await f.test.request({ method: "anvil_setStorageAt", params: [h.cuOracle, toHex(base, { size: 32 }), pad(toHex(opts.priceX18), { size: 32 })] } as never);
  }
  if (opts.lastUpdatedAt !== undefined) {
    await f.test.request({ method: "anvil_setStorageAt", params: [h.cuOracle, toHex(base + 1n, { size: 32 }), pad(toHex(opts.lastUpdatedAt), { size: 32 })] } as never);
  }
  // mine defaults true. Pass mine:false to change the price WITHOUT producing a
  // block, e.g. while block production is halted and queued transactions must
  // not be processed yet (the sequencer-outage race).
  if (opts.mine !== false) await mine(f, 1);
}

/** Age the index by `seconds` without changing its value (F-5 staleness). */
export async function ageIndex(f: ForkClients, h: IndexHandle, seconds: number): Promise<void> {
  const { lastUpdatedAt } = await readIndex(f, h);
  await forcePriceData(f, h, { lastUpdatedAt: lastUpdatedAt - BigInt(seconds) });
}

// ── Collateral (F-1 depeg) ─────────────────────────────────────────────────

const VAULT_ABI = parseAbi([
  "function oracle() view returns (address)",
  "function getTokenValueX18(address,uint256) view returns (uint256)",
  "function getConfig(address) view returns ((address token, uint256 baseUnit, uint16 haircutBps, uint16 liqIncentiveBps, uint256 cap, uint256 accountCap, bool enabled, bool depositPaused, bool withdrawPaused, string oracleSymbol))",
]);
const COLL_ORACLE_ABI = parseAbi([
  "function priceFeeds(string) view returns (address)",
  "function setPriceFeed(string,address)",
  "function owner() view returns (address)",
  "function getPrice(string) view returns (uint256)",
]);

export interface CollateralHandle {
  vault: Address;
  oracle: Address;
  token: Address;
  symbol: string;
  feed: Address;
  haircutBps: number;
}

export async function resolveCollateral(f: ForkClients, vault: Address, token: Address): Promise<CollateralHandle> {
  const oracle = (await f.pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "oracle" })) as Address;
  const cfg = (await f.pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "getConfig", args: [token] })) as
    { oracleSymbol: string; haircutBps: number };
  const feed = (await f.pub.readContract({ address: oracle, abi: COLL_ORACLE_ABI, functionName: "priceFeeds", args: [cfg.oracleSymbol] })) as Address;
  return { vault, oracle, token, symbol: cfg.oracleSymbol, feed, haircutBps: Number(cfg.haircutBps) };
}

/** Current collateral value of one whole token, x18 (includes the haircut). */
export async function readCollateralValue(f: ForkClients, c: CollateralHandle, oneUnit: bigint): Promise<bigint> {
  return (await f.pub.readContract({ address: c.vault, abi: VAULT_ABI, functionName: "getTokenValueX18", args: [c.token, oneUnit] })) as bigint;
}
