import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type HttpTransportConfig,
  type Transport,
  type PublicClient,
  type WalletClient,
} from "viem";
import { sepolia } from "viem/chains";
import { mnemonicToAccount } from "viem/accounts";
import { env } from "../config/env";
import { CHAIN_ID } from "../config/constants";
import { countHttpRequest, countedTransport } from "./rpcstats";

/** HTTP transport whose JSON-RPC calls and HTTP requests are counted for RPC_STATS. */
export function countedHttp(url: string, label: string, opts: HttpTransportConfig = {}): Transport {
  return countedTransport(http(url, { ...opts, onFetchRequest: () => countHttpRequest() }), label);
}

/** Shared read client. Contract-level multicalls are requested explicitly by the
 * callers that need them; JSON-RPC batching stays off because several hosted RPC
 * endpoints return a single object for a one-item batch, which violates the RPC
 * batch shape and causes viem to fail while decoding the response. */
export const publicClient: PublicClient = createPublicClient({
  chain: sepolia,
  transport: countedHttp(env.SEPOLIA_RPC_URL, "shared"),
});

export class WrongChainError extends Error {
  constructor(readonly actualChainId: number) {
    super(`Connected chainId ${actualChainId} is not Sepolia (${CHAIN_ID}). Aborting.`);
    this.name = "WrongChainError";
  }
}

/**
 * Hard safety rail #2: confirm the RPC is actually Sepolia before anything else.
 * Call once at startup.
 */
export async function assertChain(): Promise<void> {
  const id = await publicClient.getChainId();
  if (id !== CHAIN_ID) {
    throw new WrongChainError(id);
  }
}

/** Derive agent account #index from the HD mnemonic (index 0 = treasury). */
export function agentAccount(index: number): Account {
  if (!env.AGENT_MNEMONIC) {
    throw new Error("AGENT_MNEMONIC is not set — cannot derive agent accounts.");
  }
  return mnemonicToAccount(env.AGENT_MNEMONIC, { addressIndex: index });
}

/** A write client bound to a specific account. */
export function walletFor(account: Account): WalletClient {
  return createWalletClient({
    account,
    chain: sepolia,
    transport: http(env.SEPOLIA_RPC_URL),
  });
}
