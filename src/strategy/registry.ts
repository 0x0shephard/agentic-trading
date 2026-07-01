import type { ArchetypeId } from "../config/archetypes";
import type { Strategy } from "./types";
import { hedgerStrategy } from "./archetypes/hedger";
import { basisArbStrategy } from "./archetypes/basisArb";
import { momentumStrategy } from "./archetypes/momentum";
import { marketMakerStrategy } from "./archetypes/marketMaker";
import { hftTakerStrategy } from "./archetypes/hftTaker";
import { degenStrategy } from "./archetypes/degen";
import { macroStrategy } from "./archetypes/macro";

/** Strategy per archetype. All 8 are wired; `macro` (#7) is LLM-backed. */
export const STRATEGY_BY_ARCHETYPE: Record<ArchetypeId, Strategy> = {
  "hedger-short": hedgerStrategy,
  "hedger-long": hedgerStrategy, // same module; direction from params.sideBias
  "basis-arb": basisArbStrategy,
  momentum: momentumStrategy,
  "market-maker": marketMakerStrategy,
  "hft-taker": hftTakerStrategy,
  degen: degenStrategy,
  macro: macroStrategy,
};

export function strategyFor(id: ArchetypeId): Strategy {
  return STRATEGY_BY_ARCHETYPE[id];
}
