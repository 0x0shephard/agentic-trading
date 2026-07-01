// READ-ONLY: print mark vs index (and their deviation) for every market. Useful
// for eyeballing the signals the basis-arb / market-maker archetypes trade on.
import { assertChain } from "../src/chain/clients";
import { MARKETS } from "../src/config/markets";
import { getMarketSnapshot } from "../src/market/snapshot";
import { toNumberX18 } from "../src/preview/orderPreview";

async function main(): Promise<void> {
  await assertChain();
  for (const m of MARKETS) {
    const s = await getMarketSnapshot(m);
    console.log(
      `${m.name.padEnd(14)} mark=$${toNumberX18(s.markPriceX18).toFixed(4).padStart(9)}  ` +
        `index=$${toNumberX18(s.indexPriceX18).toFixed(4).padStart(9)}  ` +
        `dev=${s.markIndexDevBps.toString().padStart(6)}bps  ` +
        `hasIndex=${s.hasIndex}  paused=${s.paused}`,
    );
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
