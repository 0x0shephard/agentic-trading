import { agentAccount } from "../chain/clients";
import { ethBalance } from "../chain/native";
import { vaultBalance } from "../collateral/collateral";
import { getMarketSnapshot } from "../market/snapshot";
import { getPosition } from "../chain/market";
import { toNumberX18 } from "../preview/orderPreview";
import { USDC_DECIMALS, WAD } from "../config/constants";
import type { ArchetypeId } from "../config/archetypes";
import type { Assignment } from "../orchestrator/assignments";
import type { Knobs } from "../strategy/knobs";
import type { ControllerConfig } from "../controller/controller";
import type { Attribution, AgentStats } from "./attribution";
import { buildLabels } from "./labels";
import { regimeState } from "../llm/regime";
import { logger } from "../logging/logger";

export interface AgentReport {
  index: number;
  label: string;
  archetype: ArchetypeId;
  address: string;
  eth: number;
  vaultUsdc: number;
  side: "long" | "short" | "flat";
  sizeGpuHr: number;
  notionalUsd: number;
  entryUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  stats?: AgentStats;
}

export interface ArchetypeReport {
  archetype: ArchetypeId;
  agents: number;
  grossOiUsd: number;
  netOiUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  trades: number;
  volumeUsd: number;
  reverts: number;
  skips: number;
  gasCostEth: number;
}

export interface FleetReport {
  perAgent: AgentReport[];
  perArchetype: ArchetypeReport[];
  exchange: {
    oiUsd: number;
    tvlUsd: number;
    volumeUsd: number;
    gasCostEth: number;
    volOverOi: number;
    tvlOverOi: number;
    target?: { oiUsd: number; volUsd: number; tvlUsd: number };
  };
  knobs?: Knobs;
  regime: string;
}

export interface ReportOpts {
  attribution?: Attribution;
  knobs?: Knobs;
  controller?: ControllerConfig;
  /** Session volume (USD); if omitted, taken from attribution. */
  volumeUsd?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const ETH = Number(WAD); // 1e18 as a number, for wei→ETH display

/**
 * Build a fleet report from on-chain state (balances, positions, mark prices),
 * enriched with in-memory session attribution when provided. Read-only.
 */
export async function buildFleetReport(assignments: Assignment[], opts: ReportOpts = {}): Promise<FleetReport> {
  const labels = buildLabels(assignments);
  const markets = [...new Map(assignments.map((a) => [a.market.marketId, a.market])).values()];
  const marks = new Map<string, number>();
  for (const m of markets) {
    marks.set(m.marketId, toNumberX18((await getMarketSnapshot(m)).markPriceX18));
  }

  const perAgent: AgentReport[] = [];
  for (const a of assignments) {
    const acct = agentAccount(a.index);
    const [eth, vault, pos] = await Promise.all([
      ethBalance(acct.address),
      vaultBalance(acct.address),
      getPosition(acct.address, a.market.marketId),
    ]);
    const mark = marks.get(a.market.marketId) ?? 0;
    const sizeSigned = toNumberX18(pos.size);
    const entry = toNumberX18(pos.entryPriceX18);
    const notional = Math.abs(sizeSigned) * mark;
    perAgent.push({
      index: a.index,
      label: labels.get(a.index) ?? String(a.index),
      archetype: a.archetype,
      address: acct.address,
      eth: Number(eth) / ETH,
      vaultUsdc: Number(vault) / 10 ** USDC_DECIMALS,
      side: sizeSigned > 0 ? "long" : sizeSigned < 0 ? "short" : "flat",
      sizeGpuHr: Math.abs(sizeSigned),
      notionalUsd: notional,
      entryUsd: entry,
      realizedPnlUsd: toNumberX18(pos.realizedPnL),
      unrealizedPnlUsd: sizeSigned * (mark - entry),
      stats: opts.attribution?.get(a.index),
    });
  }

  const byArch = new Map<ArchetypeId, ArchetypeReport>();
  for (const r of perAgent) {
    const g =
      byArch.get(r.archetype) ??
      {
        archetype: r.archetype,
        agents: 0,
        grossOiUsd: 0,
        netOiUsd: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        trades: 0,
        volumeUsd: 0,
        reverts: 0,
        skips: 0,
        gasCostEth: 0,
      };
    g.agents += 1;
    g.grossOiUsd += r.notionalUsd;
    g.netOiUsd += (r.side === "long" ? 1 : r.side === "short" ? -1 : 0) * r.notionalUsd;
    g.realizedPnlUsd += r.realizedPnlUsd;
    g.unrealizedPnlUsd += r.unrealizedPnlUsd;
    if (r.stats) {
      g.trades += r.stats.trades;
      g.volumeUsd += r.stats.volumeUsd;
      g.reverts += r.stats.reverts;
      g.skips += r.stats.skips;
      g.gasCostEth += Number(r.stats.gasCostWei) / ETH;
    }
    byArch.set(r.archetype, g);
  }

  const oiUsd = perAgent.reduce((s, r) => s + r.notionalUsd, 0);
  const tvlUsd = perAgent.reduce((s, r) => s + r.vaultUsdc, 0);
  const volumeUsd = opts.volumeUsd ?? opts.attribution?.totalVolumeUsd() ?? 0;
  const gasCostEth = opts.attribution ? Number(opts.attribution.totalGasCostWei()) / ETH : 0;

  return {
    perAgent,
    perArchetype: [...byArch.values()],
    exchange: {
      oiUsd,
      tvlUsd,
      volumeUsd,
      gasCostEth,
      volOverOi: oiUsd > 0 ? volumeUsd / oiUsd : 0,
      tvlOverOi: oiUsd > 0 ? tvlUsd / oiUsd : 0,
      target: opts.controller
        ? {
            oiUsd: opts.controller.targetOiUsd,
            volUsd: opts.controller.ratioVol * opts.controller.targetOiUsd,
            tvlUsd: opts.controller.ratioTvl * opts.controller.targetOiUsd,
          }
        : undefined,
    },
    knobs: opts.knobs,
    regime: regimeState.current.stance,
  };
}

/** Print the agent roster: label ↔ strategy ↔ full wallet address (for
 *  cross-referencing addresses seen in the dashboard against agents). */
export function printRoster(assignments: Assignment[]): void {
  const labels = buildLabels(assignments);
  console.log("\n=== AGENT ROSTER ===");
  for (const a of assignments) {
    const label = labels.get(a.index) ?? String(a.index);
    const addr = agentAccount(a.index).address;
    console.log(`  ${label.padEnd(12)} ${a.archetype.padEnd(14)} wallet#${String(a.index).padStart(2)}  ${addr}`);
  }
  console.log("");
  logger.info(
    { roster: assignments.map((a) => `${labels.get(a.index)}=${agentAccount(a.index).address}`) },
    "agent roster",
  );
}

/** Compact structured log line — machine-readable heartbeat (used on Railway). */
export function logFleetReport(r: FleetReport): void {
  logger.info(
    {
      oiUsd: round2(r.exchange.oiUsd),
      tvlUsd: round2(r.exchange.tvlUsd),
      volumeUsd: round2(r.exchange.volumeUsd),
      gasCostEth: r.exchange.gasCostEth,
      volOverOi: round2(r.exchange.volOverOi),
      tvlOverOi: round2(r.exchange.tvlOverOi),
      regime: r.regime,
      buildRate: r.knobs ? round2(r.knobs.buildRate) : undefined,
      churnRate: r.knobs ? round2(r.knobs.churnRate) : undefined,
      byArchetype: r.perArchetype.map(
        (a) =>
          `${a.archetype}: OI $${round2(a.grossOiUsd)} vol $${round2(a.volumeUsd)} trades ${a.trades} gas ${a.gasCostEth.toFixed(6)} ETH rPnL $${round2(a.realizedPnlUsd)}`,
      ),
    },
    "fleet report",
  );
}

/** Human-friendly table — used by the standalone `npm run report`. */
export function printFleetReport(r: FleetReport): void {
  const line = (...xs: unknown[]): void => console.log(...xs);
  line("\n=== PER AGENT ===");
  for (const a of r.perAgent) {
    const posStr =
      a.side === "flat"
        ? "flat"
        : `${a.side} ${a.sizeGpuHr.toFixed(2)}gpu $${a.notionalUsd.toFixed(2)} @${a.entryUsd.toFixed(4)} uPnL $${a.unrealizedPnlUsd.toFixed(2)} rPnL $${a.realizedPnlUsd.toFixed(2)}`;
    const s = a.stats;
    const statStr = s
      ? `  [${s.trades} tx, vol $${s.volumeUsd.toFixed(2)}, gas ${(Number(s.gasCostWei) / ETH).toFixed(6)} ETH${s.reverts ? `, ${s.reverts} rvt` : ""}${s.skips ? `, ${s.skips} skip` : ""}]`
      : "";
    line(
      `${a.label.padEnd(11)} ${a.archetype.padEnd(13)} ${a.address.slice(0, 10)}… eth ${a.eth.toFixed(4)} vault $${a.vaultUsdc.toFixed(0).padStart(4)}  ${posStr}${statStr}`,
    );
  }
  line("\n=== PER ARCHETYPE ===");
  for (const a of r.perArchetype) {
    line(
      `${a.archetype.padEnd(13)} agents ${a.agents}  grossOI $${a.grossOiUsd.toFixed(2)}  netOI $${a.netOiUsd.toFixed(2)}  rPnL $${a.realizedPnlUsd.toFixed(2)}  uPnL $${a.unrealizedPnlUsd.toFixed(2)}  trades ${a.trades}  vol $${a.volumeUsd.toFixed(2)}`,
    );
    line(`  gas ${a.gasCostEth.toFixed(6)} ETH`);
  }
  const e = r.exchange;
  line("\n=== EXCHANGE  (target OI:Vol:TVL = 1 : 1.20 : 0.55) ===");
  line(`OI $${e.oiUsd.toFixed(2)}   Vol $${e.volumeUsd.toFixed(2)}   TVL $${e.tvlUsd.toFixed(2)}`);
  line(`session gas ${e.gasCostEth.toFixed(6)} ETH`);
  line(`ratios  Vol/OI ${e.volOverOi.toFixed(2)} (target 1.20)   TVL/OI ${e.tvlOverOi.toFixed(2)} (target 0.55)`);
  if (e.target) {
    line(`targets OI $${e.target.oiUsd}   Vol $${e.target.volUsd.toFixed(0)}   TVL $${e.target.tvlUsd.toFixed(0)}`);
  }
  if (r.knobs) line(`knobs   buildRate ${r.knobs.buildRate.toFixed(2)}   churnRate ${r.knobs.churnRate.toFixed(2)}`);
  line(`regime  ${r.regime}\n`);
}
