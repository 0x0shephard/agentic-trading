// READ-ONLY: current Sepolia gas/fee picture, and what a perp round-trip costs.
import { formatGwei, formatEther } from "viem";
import { publicClient } from "../src/chain/clients";

async function main(): Promise<void> {
  const [gasPrice, fees, block] = await Promise.all([
    publicClient.getGasPrice(),
    publicClient.estimateFeesPerGas(),
    publicClient.getBlock(),
  ]);
  const baseFee = block.baseFeePerGas ?? 0n;
  console.log("gasPrice          :", formatGwei(gasPrice), "gwei");
  console.log("baseFeePerGas     :", formatGwei(baseFee), "gwei");
  console.log("maxFeePerGas      :", formatGwei(fees.maxFeePerGas), "gwei");
  console.log("maxPriorityPerGas :", formatGwei(fees.maxPriorityFeePerGas), "gwei");

  // Rough per-op gas from observed receipts: open ~700k (buffered), close ~620k raw.
  const OPEN_GAS = 700_000n;
  const CLOSE_GAS = 620_000n;
  const maxFee = fees.maxFeePerGas;
  const openReserve = OPEN_GAS * maxFee;
  const closeReserve = CLOSE_GAS * maxFee;
  console.log("");
  console.log("reserve @ maxFee — open  :", formatEther(openReserve), "ETH");
  console.log("reserve @ maxFee — close :", formatEther(closeReserve), "ETH");
  console.log("reserve @ maxFee — round :", formatEther(openReserve + closeReserve), "ETH");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
