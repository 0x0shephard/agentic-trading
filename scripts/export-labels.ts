// Generate ../overhaul/src/config/agentLabels.json — the address → agent-name map
// the admin dashboard uses to show "mm-01" instead of raw wallet addresses.
// Re-run whenever the fleet size or composition changes.
//   npm run export:labels [count]
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAssignments } from "../src/orchestrator/assignments";
import { buildLabels } from "../src/observability/labels";
import { agentAccount } from "../src/chain/clients";
import { DEFAULT_FLEET_SIZE } from "../src/config/provisioning";

const count = Math.max(1, Number(process.argv[2] ?? DEFAULT_FLEET_SIZE));
const OUT = resolve(process.cwd(), "../overhaul/src/config/agentLabels.json");

const assignments = buildAssignments(count);
const labels = buildLabels(assignments);

const map: Record<string, string> = {
  [agentAccount(0).address.toLowerCase()]: "treasury",
};
for (const a of assignments) {
  map[agentAccount(a.index).address.toLowerCase()] = labels.get(a.index) ?? String(a.index);
}

writeFileSync(OUT, `${JSON.stringify(map, null, 2)}\n`);
console.log(`wrote ${Object.keys(map).length} agent labels → ${OUT}`);
