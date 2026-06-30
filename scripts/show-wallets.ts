// Derives the first N wallets from AGENT_MNEMONIC and prints address + balances.
// Index 0 = treasury (fund this one with Sepolia ETH). Usage: `npm run wallets [count]`.
import { formatEther, formatUnits } from "viem";
import { env } from "../src/config/env";
import { publicClient, agentAccount } from "../src/chain/clients";
import { CONTRACTS } from "../src/config/addresses";
import { erc20Abi } from "../src/chain/abis";
import { USDC_DECIMALS } from "../src/config/constants";

const COUNT = Math.max(1, Number(process.argv[2] ?? 6));

async function main(): Promise<void> {
  if (!env.AGENT_MNEMONIC) {
    console.error("AGENT_MNEMONIC is not set in .env — run `npm run gen:mnemonic` and paste it in first.");
    process.exit(1);
  }

  console.log("\nDerived wallets (index 0 = treasury):\n");
  for (let i = 0; i < COUNT; i += 1) {
    const account = agentAccount(i);
    const [wei, usdc] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.readContract({
        address: CONTRACTS.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      }),
    ]);
    const label = (i === 0 ? "treasury" : `agent-${i}`).padEnd(9);
    console.log(
      `  [${i}] ${label} ${account.address}  ` +
        `${Number(formatEther(wei)).toFixed(4)} ETH  ` +
        `${Number(formatUnits(usdc, USDC_DECIMALS)).toFixed(2)} USDC`,
    );
  }
  console.log();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
