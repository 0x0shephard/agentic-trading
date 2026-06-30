// READ-ONLY: replay a mined tx at its own block to recover the on-chain revert
// reason (viem decodes the revert when re-running via eth_call). Sends nothing.
import type { Hex } from "viem";
import { publicClient } from "../src/chain/clients";

const hash = process.argv[2] as Hex;
if (!hash) {
  console.error("usage: tsx scripts/diag-tx.ts <txHash>");
  process.exit(1);
}

function reasonOf(e: unknown): string {
  if (e && typeof e === "object" && "shortMessage" in e) {
    return String((e as { shortMessage?: unknown }).shortMessage);
  }
  return e instanceof Error ? e.message : String(e);
}

async function replayAt(
  from: Hex,
  to: Hex,
  data: Hex,
  value: bigint,
  blockNumber: bigint,
  label: string,
): Promise<void> {
  try {
    await publicClient.call({ account: from, to, data, value, blockNumber });
    console.log(`  replay @ ${label}: NO REVERT`);
  } catch (e) {
    console.log(`  replay @ ${label}: REVERT → ${reasonOf(e)}`);
  }
}

async function main(): Promise<void> {
  const tx = await publicClient.getTransaction({ hash });
  const receipt = await publicClient.getTransactionReceipt({ hash });
  console.log(
    `\ntx ${hash}\nstatus=${receipt.status} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}\nto=${tx.to} from=${tx.from}\n`,
  );
  if (!tx.to) {
    console.log("contract-creation tx — nothing to replay");
    return;
  }
  await replayAt(tx.from, tx.to, tx.input, tx.value, receipt.blockNumber, `block ${receipt.blockNumber}`);
  await replayAt(tx.from, tx.to, tx.input, tx.value, receipt.blockNumber - 1n, `block ${receipt.blockNumber - 1n} (pre)`);
  console.log();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
