import type Anthropic from "@anthropic-ai/sdk";
import type { Strategy, StrategyContext, Intent } from "../types";
import type { MarketSnapshot } from "../../market/snapshot";
import type { ArchetypeParams } from "../../config/archetypes";
import type { Regime } from "../../llm/regime";
import { regimeState, regimeConvictionMultiplier } from "../../llm/regime";
import { getAnthropic, LLM_MODEL, firstToolUse } from "../../llm/client";
import { baseSizeForNotionalX18 } from "../helpers";
import { toNumberX18 } from "../../preview/orderPreview";

/**
 * Archetype #7 — Macro / directional (LLM-driven). Claude reasons over the market
 * snapshot + the agent's own position + the current regime and returns a decision
 * via the `submit_macro_decision` tool. The model is NEVER trusted to bypass
 * limits: `macroDecisionToIntent` clamps the notional to the conviction cap and
 * free collateral, and the resulting Intent still flows through the normal
 * simulate-gated executor. No API key → the agent holds.
 */

export interface MacroDecision {
  action: "open" | "close" | "hold";
  side?: "long" | "short";
  notionalUsd?: number;
  closeFractionBps?: number;
  rationale?: string;
}

const DECISION_TOOL: Anthropic.Tool = {
  name: "submit_macro_decision",
  description: "Record your macro trading decision for this market. Call this exactly once.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["open", "close", "hold"],
        description: "Open a new position, close the existing one, or hold.",
      },
      side: { type: "string", enum: ["long", "short"], description: "Required for action=open." },
      notionalUsd: {
        type: "number",
        description: "For action=open: desired position notional in USD. Will be capped by risk limits.",
      },
      closeFractionBps: {
        type: "integer",
        description: "For action=close: fraction of the position to close, in bps (10000 = full).",
      },
      rationale: { type: "string", description: "One sentence explaining the decision." },
    },
    required: ["action", "rationale"],
  },
};

const MACRO_SYSTEM = [
  "You are a discretionary macro trader on a GPU-compute perpetual-futures exchange (testnet).",
  "Your persona: strong directional conviction, large concentrated positions, slow to enter, patient to hold.",
  "You are NOT a scalper — most ticks you should HOLD. Only open when there is a clear directional thesis",
  "(e.g. mark far from index with a view on which way it resolves, or a strong regime signal). Respect the",
  "current regime: lean in when risk-on, size down or stand aside when risk-off. Notional you request will be",
  "capped by risk limits, so state your genuine conviction size. Always call submit_macro_decision exactly once.",
].join(" ");

/** Pure, testable mapping from an LLM decision to a clamped, executable Intent. */
export function macroDecisionToIntent(
  d: MacroDecision,
  snapshot: MarketSnapshot,
  params: ArchetypeParams,
  freeCollateralUsd: number,
  regime: Regime,
): Intent {
  if (d.action === "close") {
    const frac = Math.min(10000, Math.max(1, Math.round(d.closeFractionBps ?? 10000)));
    return { kind: "close", fractionBps: frac, slippageBps: params.slippageBps, reason: d.rationale ?? "macro close" };
  }
  if (d.action === "open") {
    const convictionCap = params.targetNotionalUsd * regimeConvictionMultiplier(regime);
    const collateralCap = Math.max(0, freeCollateralUsd) * params.targetLeverage;
    const requested = Math.max(0, d.notionalUsd ?? 0);
    const notional = Math.min(requested, convictionCap, collateralCap);
    const size = baseSizeForNotionalX18(notional, snapshot.markPriceX18);
    if (size <= 0n) return { kind: "hold", reason: "macro: sized to 0 after caps" };
    return {
      kind: "open",
      isLong: d.side !== "short",
      baseSizeX18: size,
      slippageBps: params.slippageBps,
      reason: d.rationale ?? "macro open",
    };
  }
  return { kind: "hold", reason: d.rationale ?? "macro hold" };
}

function parseDecision(input: Record<string, unknown>): MacroDecision {
  const action = input.action === "open" || input.action === "close" ? input.action : "hold";
  const side = input.side === "short" ? "short" : input.side === "long" ? "long" : undefined;
  const notionalUsd = typeof input.notionalUsd === "number" ? input.notionalUsd : undefined;
  const closeFractionBps = typeof input.closeFractionBps === "number" ? input.closeFractionBps : undefined;
  const rationale = typeof input.rationale === "string" ? input.rationale : undefined;
  return { action, side, notionalUsd, closeFractionBps, rationale };
}

function buildMacroPrompt(ctx: StrategyContext, regime: Regime): string {
  const s = ctx.snapshot;
  const a = ctx.account;
  const sizeX18 = toNumberX18(a.sizeX18);
  const posLine =
    a.sizeX18 === 0n
      ? "Position: FLAT."
      : `Position: ${sizeX18 > 0 ? "LONG" : "SHORT"} ${Math.abs(sizeX18)} GPU-hr, entry $${toNumberX18(a.entryPriceX18).toFixed(4)}, margin $${toNumberX18(a.marginX18).toFixed(2)}.`;
  return [
    `Market: ${s.def.name}`,
    `Mark price: $${toNumberX18(s.markPriceX18).toFixed(4)}`,
    `Index price: $${toNumberX18(s.indexPriceX18).toFixed(4)} (mark-vs-index deviation: ${s.markIndexDevBps} bps)`,
    posLine,
    `Free collateral: $${toNumberX18(a.freeCollateralX18).toFixed(2)}`,
    `Regime: ${regime.stance}, volatility expectation ${regime.volExpectation}. (${regime.note})`,
    `Your conviction notional cap this regime: ~$${(ctx.params.targetNotionalUsd * regimeConvictionMultiplier(regime)).toFixed(0)}.`,
    "",
    "Decide: open (with side + notionalUsd), close (with closeFractionBps), or hold. Call submit_macro_decision.",
  ].join("\n");
}

async function requestMacroDecision(
  client: Anthropic,
  ctx: StrategyContext,
  regime: Regime,
): Promise<MacroDecision> {
  const msg = await client.messages.create({
    model: LLM_MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: MACRO_SYSTEM,
    tools: [DECISION_TOOL],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: buildMacroPrompt(ctx, regime) }],
  });
  const input = firstToolUse(msg.content, "submit_macro_decision");
  if (!input) return { action: "hold", rationale: "no tool call returned" };
  return parseDecision(input);
}

export const macroStrategy: Strategy = {
  name: "macro",
  async decide(ctx: StrategyContext): Promise<Intent> {
    const client = getAnthropic();
    if (!client) return { kind: "hold", reason: "no ANTHROPIC_API_KEY — macro idle" };
    const regime = regimeState.current;
    try {
      const decision = await requestMacroDecision(client, ctx, regime);
      return macroDecisionToIntent(
        decision,
        ctx.snapshot,
        ctx.params,
        toNumberX18(ctx.account.freeCollateralX18),
        regime,
      );
    } catch (e) {
      ctx.logger.error({ err: e instanceof Error ? e.message : String(e) }, "macro LLM decision failed — holding");
      return { kind: "hold", reason: "macro LLM error" };
    }
  },
};
