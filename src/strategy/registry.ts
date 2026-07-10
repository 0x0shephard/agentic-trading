import type { ArchetypeId } from "../config/archetypes";
import type { Strategy } from "./types";
import { hedgerStrategy } from "./archetypes/hedger";
import { basisArbStrategy } from "./archetypes/basisArb";
import { momentumStrategy } from "./archetypes/momentum";
import { marketMakerStrategy } from "./archetypes/marketMaker";
import { hftTakerStrategy } from "./archetypes/hftTaker";
import { degenStrategy } from "./archetypes/degen";
import { macroStrategy } from "./archetypes/macro";
import { markManipulatorStrategy } from "./archetypes/markManipulator";

/** Strategy per archetype. `macro` (#7) is LLM-backed; the rest are deterministic. */
export const STRATEGY_BY_ARCHETYPE: Record<ArchetypeId, Strategy> = {
  "hedger-short": hedgerStrategy,
  "hedger-long": hedgerStrategy, // same module; direction from params.sideBias
  "basis-arb": basisArbStrategy,
  momentum: momentumStrategy,
  "market-maker": marketMakerStrategy,
  "hft-taker": hftTakerStrategy,
  degen: degenStrategy,
  macro: macroStrategy,
  "mark-manipulator": markManipulatorStrategy,
};

export function strategyFor(id: ArchetypeId): Strategy {
  return STRATEGY_BY_ARCHETYPE[id];
}
