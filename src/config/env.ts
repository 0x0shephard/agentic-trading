import "dotenv/config";
import { z } from "zod";
import { CHAIN_ID } from "./constants";

// Strict boolean parsing: env values must be the literal "true"/"false".
// (Avoids the classic Boolean("false") === true footgun.)
const boolEnv = (def: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(def)
    .transform((v) => v === "true");

const schema = z.object({
  SEPOLIA_RPC_URL: z.string().url().default("https://ethereum-sepolia-rpc.publicnode.com"),
  CHAIN_ID: z.coerce.number().int().default(CHAIN_ID),
  AGENT_MNEMONIC: z.string().trim().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  // LLM used by the macro archetype (#7) + regime supervisor. Low-frequency, so
  // cost is negligible; switch to claude-haiku-4-5 for the cheapest tier.
  LLM_MODEL: z.string().trim().min(1).default("claude-opus-4-8"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // "true" forces pretty logs, "false" forces JSON; unset = pretty on a terminal.
  LOG_PRETTY: z.enum(["true", "false"]).optional(),
  DRY_RUN: boolEnv("true"),
  KILL_SWITCH: boolEnv("false"),
  // ── Surveillance monitor (separate Railway service; unused by the swarm) ──
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1).optional(),
  MONITOR_POLL_MS: z.coerce.number().int().positive().default(45_000),
  MONITOR_LOOKBACK_MIN: z.coerce.number().int().positive().default(120),
  MONITOR_LABEL_WALLETS: z.coerce.number().int().positive().default(24),
  // ── Alerting (Slack) ──────────────────────────────────────────────────────
  // Webhook URLs are credentials: anyone holding one can post to the channel.
  // Set them in Railway secrets / a gitignored .env, never in a tracked file.
  SLACK_WEBHOOK_CRITICAL: z.string().url().optional(), // P1 -> #critical-alerts
  SLACK_WEBHOOK_ALERTS: z.string().url().optional(), //   P2 -> #bytestrike-alerts
  /** Minimum seconds between repeat notifications for the same condition. */
  ALERT_COOLDOWN_SEC: z.coerce.number().int().positive().default(1_800),
  /** Health poll cadence (chain state). Independent of the trade-flow poll. */
  HEALTH_POLL_MS: z.coerce.number().int().positive().default(60_000),
  /** Emit a heartbeat this often so silence is distinguishable from an outage. */
  HEARTBEAT_HOURS: z.coerce.number().int().positive().default(24),
  /** "true" to send a startup message confirming wiring. */
  ALERT_ON_START: z.enum(["true", "false"]).default("true"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// Hard safety rail #1: never run against anything but Sepolia.
if (env.CHAIN_ID !== CHAIN_ID) {
  // eslint-disable-next-line no-console
  console.error(`Refusing to start: CHAIN_ID=${env.CHAIN_ID} is not Sepolia (${CHAIN_ID}).`);
  process.exit(1);
}
