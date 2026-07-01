// Run ONE agent for a few ticks — validates the runtime (snapshot → strategy →
// intent → executor → chain) end-to-end. Respects DRY_RUN.
//   DRY_RUN=true npm run agent market-maker 1 3   # archetype market-maker, agent-1
//   npm run agent probe 1 2                        # probe strategy (open/close)
//   npm run agent basis-arb 2 5
import { assertChain, agentAccount } from "../src/chain/clients";
import { runAgent } from "../src/runtime/agentLoop";
import { probeStrategy } from "../src/strategy/probe";
import { strategyFor } from "../src/strategy/registry";
import { DEFAULT_MARKET } from "../src/config/markets";
import { DEFAULT_ARCHETYPES } from "../src/config/archetypes";
import type { ArchetypeId, ArchetypeParams } from "../src/config/archetypes";
import type { Strategy } from "../src/strategy/types";
import { mulberry32, seedFromString } from "../src/runtime/rng";
import { logger } from "../src/logging/logger";

const arche = process.argv[2] ?? "probe";
const index = Math.max(1, Number(process.argv[3] ?? 1));
const iterations = Math.max(1, Number(process.argv[4] ?? 3));

function resolve(): { strategy: Strategy; params: ArchetypeParams } {
  if (arche === "probe") {
    return { strategy: probeStrategy, params: DEFAULT_ARCHETYPES["hft-taker"] };
  }
  if (!(arche in DEFAULT_ARCHETYPES)) {
    throw new Error(
      `unknown archetype "${arche}" (use one of: ${Object.keys(DEFAULT_ARCHETYPES).join(", ")}, or "probe")`,
    );
  }
  const id = arche as ArchetypeId;
  return { strategy: strategyFor(id), params: DEFAULT_ARCHETYPES[id] };
}

async function main(): Promise<void> {
  await assertChain();
  const account = agentAccount(index);
  const { strategy, params } = resolve();
  const rng = mulberry32(seedFromString(`${arche}-${index}`));
  await runAgent(account, strategy, {
    market: DEFAULT_MARKET,
    params,
    iterations,
    ratePerHour: 3600, // fast, for testing only
    rng,
    maxDelayMs: 2000,
  });
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "run-agent fatal");
  process.exit(1);
});
