import type { ArchetypeId } from "../config/archetypes";
import type { Assignment } from "../orchestrator/assignments";

// Short, human-readable prefixes per archetype (mm-01, hft-02, basis-01, …).
const ABBREV: Record<ArchetypeId, string> = {
  "hedger-short": "hs",
  "hedger-long": "hl",
  "basis-arb": "basis",
  momentum: "mom",
  "market-maker": "mm",
  "hft-taker": "hft",
  macro: "macro",
  degen: "degen",
};

/** Map wallet index → readable label, numbering per archetype in assignment order. */
export function buildLabels(assignments: Assignment[]): Map<number, string> {
  const seq = new Map<ArchetypeId, number>();
  const labels = new Map<number, string>();
  for (const a of assignments) {
    const n = (seq.get(a.archetype) ?? 0) + 1;
    seq.set(a.archetype, n);
    labels.set(a.index, `${ABBREV[a.archetype]}-${String(n).padStart(2, "0")}`);
  }
  return labels;
}
