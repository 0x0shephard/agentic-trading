import type { ArchetypeId } from "../config/archetypes";
import type { MarketDef } from "../config/markets";
import { MARKETS } from "../config/markets";

export interface Assignment {
  index: number; // wallet index (1..N)
  archetype: ArchetypeId;
  market: MarketDef;
}

// Composition cycled across the available wallets. Ordered so small fleets get a
// useful mix (churn + signal first), growing toward the doc's target proportions
// as the fleet scales. `macro` (#7, LLM) is intentionally excluded here — it's
// wired in Phase 4. Adjust freely; this is just the default distribution.
const COMPOSITION: readonly ArchetypeId[] = [
  "market-maker",
  "basis-arb",
  "momentum",
  "hft-taker",
  "hedger-short",
  "hedger-long",
  "market-maker",
  "hft-taker",
  "degen",
  "mark-manipulator",
];

/** Assign archetypes and markets to wallets 1..count by cycling both lists. */
export function buildAssignments(count: number, markets: readonly MarketDef[] = MARKETS): Assignment[] {
  if (markets.length === 0) throw new Error("buildAssignments requires at least one market");
  const out: Assignment[] = [];
  for (let i = 1; i <= count; i++) {
    const archetype = COMPOSITION[(i - 1) % COMPOSITION.length]!;
    const market = markets[(i - 1) % markets.length]!;
    out.push({ index: i, archetype, market });
  }
  return out;
}
