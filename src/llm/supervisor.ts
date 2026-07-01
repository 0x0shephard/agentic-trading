import type Anthropic from "@anthropic-ai/sdk";
import type { MarketDef } from "../config/markets";
import type { Regime, RegimeStance, VolExpectation } from "./regime";
import { regimeState } from "./regime";
import { getAnthropic, LLM_MODEL, firstToolUse } from "./client";
import { getMarketSnapshot } from "../market/snapshot";
import { toNumberX18 } from "../preview/orderPreview";
import { logger } from "../logging/logger";

const REGIME_TOOL: Anthropic.Tool = {
  name: "set_regime",
  description: "Set the market regime for the trading swarm. Call this exactly once.",
  input_schema: {
    type: "object",
    properties: {
      stance: {
        type: "string",
        enum: ["risk_on", "neutral", "risk_off"],
        description: "Overall risk stance for the swarm.",
      },
      volExpectation: {
        type: "string",
        enum: ["low", "normal", "high"],
        description: "Expected near-term volatility.",
      },
      note: { type: "string", description: "One sentence rationale." },
    },
    required: ["stance", "volExpectation", "note"],
  },
};

const SUPERVISOR_SYSTEM = [
  "You are the regime supervisor for a GPU-compute perpetual-futures trading swarm (testnet).",
  "Given a snapshot of every market (mark vs index, deviation), set a single global regime that the swarm reads:",
  "stance (risk_on / neutral / risk_off) and volatility expectation (low / normal / high).",
  "Large mark-vs-index dislocations across markets suggest higher volatility; broadly rich marks vs index suggest",
  "risk-on froth, broadly cheap marks suggest risk-off. Be measured — default to neutral/normal unless the signal is clear.",
  "Always call set_regime exactly once.",
].join(" ");

function coerceStance(v: unknown): RegimeStance {
  return v === "risk_on" || v === "risk_off" ? v : "neutral";
}
function coerceVol(v: unknown): VolExpectation {
  return v === "low" || v === "high" ? v : "normal";
}

/** Read every market and format a compact summary for the supervisor prompt. */
export async function summarizeMarkets(markets: readonly MarketDef[]): Promise<string> {
  const lines: string[] = [];
  for (const m of markets) {
    const s = await getMarketSnapshot(m);
    lines.push(
      `${m.name}: mark $${toNumberX18(s.markPriceX18).toFixed(4)}, index $${toNumberX18(s.indexPriceX18).toFixed(4)}, dev ${s.markIndexDevBps} bps${s.paused ? " (paused)" : ""}`,
    );
  }
  return `Market snapshot:\n${lines.join("\n")}\n\nSet the swarm regime.`;
}

/**
 * One supervisor cycle: read markets, ask Claude for a regime, and update the
 * shared regime in place. Returns null (and leaves the regime unchanged) if there
 * is no API key or the call fails.
 */
export async function runSupervisorOnce(markets: readonly MarketDef[]): Promise<Regime | null> {
  const client = getAnthropic();
  if (!client) return null;
  try {
    const summary = await summarizeMarkets(markets);
    const msg = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      system: SUPERVISOR_SYSTEM,
      tools: [REGIME_TOOL],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: summary }],
    });
    const input = firstToolUse(msg.content, "set_regime");
    if (!input) return null;
    const regime: Regime = {
      stance: coerceStance(input.stance),
      volExpectation: coerceVol(input.volExpectation),
      note: typeof input.note === "string" ? input.note : "",
      updatedAt: Date.now(),
    };
    regimeState.current = regime;
    logger.info(
      { stance: regime.stance, vol: regime.volExpectation, note: regime.note },
      "supervisor set regime",
    );
    return regime;
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "supervisor run failed (regime unchanged)");
    return null;
  }
}
