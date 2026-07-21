// Deploy mock oracle contracts onto the fork.
//
// Needed because the live feeds cannot be driven directly: the USDC feed is a real
// Chainlink aggregator proxy with no settable answer, and no sequencer uptime feed
// is wired at all. Rather than poke opaque Chainlink storage, we deploy a
// Chainlink-compatible mock and repoint the protocol at it through its own admin
// function (Oracle.setPriceFeed / Oracle.setSequencerUptimeFeed).
//
// Deployment happens on the fork via impersonation, so this cannot affect live.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeDeployData, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import type { ForkClients } from "./fork";
import { impersonate } from "./fork";
import { logger } from "../logging/logger";

const ARTIFACTS = join(process.cwd(), "stress-mocks", "out", "Mocks.sol");

/** Address used to deploy mocks; impersonated, never a held key. */
export const DEPLOYER: Address = "0x00000000000000000000000000000000000d3910";

export const MOCK_FEED_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function answer() view returns (int256)",
  "function updatedAt() view returns (uint256)",
  "function setAnswer(int256)",
  "function setUpdatedAt(uint256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

export const MOCK_UPTIME_ABI = parseAbi([
  "function answer() view returns (int256)",
  "function startedAt() view returns (uint256)",
  "function setStatus(int256,uint256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

function bytecodeOf(name: string): Hex {
  const raw = JSON.parse(readFileSync(join(ARTIFACTS, `${name}.json`), "utf8")) as
    { bytecode: { object: string } };
  const obj = raw.bytecode.object;
  return (obj.startsWith("0x") ? obj : `0x${obj}`) as Hex;
}

async function deploy(f: ForkClients, data: Hex): Promise<Address> {
  const w = await impersonate(f, DEPLOYER);
  const hash = await w.sendTransaction({ account: DEPLOYER, chain: null, data, to: null });
  const rcpt = await f.pub.waitForTransactionReceipt({ hash });
  if (!rcpt.contractAddress) throw new Error("mock deployment produced no contract address");
  return rcpt.contractAddress;
}

/** Deploy a Chainlink-compatible price feed with a settable answer. */
export async function deployMockPriceFeed(
  f: ForkClients, decimals: number, answer: bigint, description: string,
): Promise<Address> {
  const data = encodeDeployData({
    abi: [{ type: "constructor", inputs: [{ type: "uint8" }, { type: "int256" }, { type: "string" }], stateMutability: "nonpayable" }],
    bytecode: bytecodeOf("MockPriceFeed"),
    args: [decimals, answer, description],
  });
  const addr = await deploy(f, data);
  logger.info({ addr, decimals, answer: answer.toString(), description }, "deployed MockPriceFeed on fork");
  return addr;
}

/** Deploy a Chainlink L2 sequencer uptime feed mock (0 = up, 1 = down). */
export async function deployMockUptimeFeed(f: ForkClients): Promise<Address> {
  const data = encodeDeployData({
    abi: [{ type: "constructor", inputs: [], stateMutability: "nonpayable" }],
    bytecode: bytecodeOf("MockSequencerUptimeFeed"),
    args: [],
  });
  const addr = await deploy(f, data);
  logger.info({ addr }, "deployed MockSequencerUptimeFeed on fork");
  return addr;
}

// Suppress unused-import lint while keeping the helper available for callers that
// need to encode custom constructor args.
export { encodeAbiParameters };
