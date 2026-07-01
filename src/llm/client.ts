import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { logger } from "../logging/logger";

let cached: Anthropic | null | undefined;

/**
 * Lazily construct the Anthropic client. Returns null when no ANTHROPIC_API_KEY
 * is configured, so LLM-backed features degrade gracefully (macro holds, the
 * supervisor is skipped) rather than crashing the swarm.
 */
export function getAnthropic(): Anthropic | null {
  if (cached !== undefined) return cached;
  if (!env.ANTHROPIC_API_KEY) {
    logger.warn("ANTHROPIC_API_KEY not set — LLM features (macro, supervisor) disabled");
    cached = null;
    return cached;
  }
  cached = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return cached;
}

export const LLM_MODEL = env.LLM_MODEL;

/** Pull the first tool-use block whose name matches from a message response. */
export function firstToolUse(
  content: Anthropic.Messages.ContentBlock[],
  name: string,
): Record<string, unknown> | null {
  for (const block of content) {
    if (block.type === "tool_use" && block.name === name) {
      return block.input as Record<string, unknown>;
    }
  }
  return null;
}
