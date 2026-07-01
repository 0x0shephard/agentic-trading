import type { ArchetypeId } from "../config/archetypes";
import type { Strategy } from "./types";
import { hedgerStrategy } from "./archetypes/hedger";
import { basisArbStrategy } from "./archetypes/basisArb";
import { momentumStrategy } from "./archetypes/momentum";
import { marketMakerStrategy } from "./archetypes/marketMaker";
import { hftTakerStrategy } from "./archetypes/hftTaker";
import { degenStrategy } from "./archetypes/degen";

/** Deterministic strategy per archetype. `macro` (#7) is LLM-driven (Phase 4). */
export const STRATEGY_BY_ARCHETYPE: Partial<Record<ArchetypeId, Strategy>> = {
  "hedger-short": hedgerStrategy,
  "hedger-long": hedgerStrategy, // same module; direction from params.sideBias
  "basis-arb": basisArbStrategy,
  momentum: momentumStrategy,
  "market-maker": marketMakerStrategy,
  "hft-taker": hftTakerStrategy,
  degen: degenStrategy,
};

export function strategyFor(id: ArchetypeId): Strategy {
  const s = STRATEGY_BY_ARCHETYPE[id];
  if (!s) throw new Error(`No deterministic strategy for archetype "${id}" (macro is LLM / Phase 4)`);
  return s;
}
