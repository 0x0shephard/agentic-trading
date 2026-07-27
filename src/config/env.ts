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
  /** Admin-action watch cadence (on-chain admin events + admin-key txs). */
  ADMIN_POLL_MS: z.coerce.number().int().positive().default(60_000),
  // ── Network / RPC health monitor ──────────────────────────────────────────
  /** Network-health poll cadence (primary RPC liveness, head advance, lag). */
  NET_POLL_MS: z.coerce.number().int().positive().default(60_000),
  /** Optional second RPC endpoint to cross-check the primary (down vs lag). */
  NET_FALLBACK_RPC_URL: z.string().url().optional(),
  /** Warn if the chain head has not advanced for this long (ms). Default 3 min. */
  NET_STALL_WARN_MS: z.coerce.number().int().positive().default(180_000),
  /** Critical if the head has not advanced for this long (ms). Default 10 min. */
  NET_STALL_CRIT_MS: z.coerce.number().int().positive().default(600_000),
  /** Warn if the primary trails the fallback by at least this many blocks. */
  NET_LAG_BLOCKS: z.coerce.number().int().positive().default(20),
  // ── Login / site health monitor (gateway logs via Axiom + uptime probes) ──
  /** Axiom API token with QUERY permission on the gateway-log dataset (secret). */
  AXIOM_API_TOKEN: z.string().trim().min(1).optional(),
  /** Axiom dataset the Cloudflare gateway ships request logs to. */
  AXIOM_DATASET: z.string().trim().min(1).optional(),
  /** Site-health poll cadence (Axiom queries + uptime probes). Default 5 min. */
  SITE_POLL_MS: z.coerce.number().int().positive().default(300_000),
  /** Lookback window for gateway-log rates (minutes). */
  SITE_WINDOW_MIN: z.coerce.number().int().positive().default(15),
  /** Skip rate checks below this many requests in the window (small-sample noise). */
  SITE_MIN_SAMPLE: z.coerce.number().int().positive().default(50),
  /** 5xx error-rate warn/critical thresholds (percent of requests). */
  SITE_ERR5XX_WARN_PCT: z.coerce.number().positive().default(2),
  SITE_ERR5XX_CRIT_PCT: z.coerce.number().positive().default(10),
  /** Absolute 5xx count that alerts regardless of rate (baseline is ~0). */
  SITE_ERR5XX_ABS_FLOOR: z.coerce.number().int().positive().default(5),
  /** Rate-limit (429) share warn/critical thresholds (percent of requests).
   *  The agents drive a high 429 baseline (observed ~13% over a week, ~30% in a
   *  busy 15-min window), so these sit well above that: they fire only when the
   *  gateway is rejecting a majority of traffic (abuse, a runaway client, a DoS). */
  SITE_RL_WARN_PCT: z.coerce.number().positive().default(60),
  SITE_RL_CRIT_PCT: z.coerce.number().positive().default(85),
  /** Failed auth attempts from one IP in the window: warn / critical. */
  SITE_AUTHFAIL_IP_WARN: z.coerce.number().int().positive().default(10),
  SITE_AUTHFAIL_IP_CRIT: z.coerce.number().int().positive().default(30),
  /** Uptime-probe targets (optional; probed only if set). */
  SITE_URL: z.string().url().optional(),
  SITE_API_HEALTH_URL: z.string().url().optional(),
  // ── Log-retention export (RMF 1c): immutable R2 archive ───────────────────
  /** Cloudflare account id (the R2 S3 endpoint host prefix). */
  R2_ACCOUNT_ID: z.string().trim().min(1).optional(),
  /** R2 access key id + secret, scoped to the archive bucket (secrets). */
  R2_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
  /** The Object-Locked archive bucket name. */
  R2_BUCKET: z.string().trim().min(1).optional(),
  /** Extra admin addresses to watch, comma-separated (owners are auto-included). */
  ADMIN_WATCH_ADDRESSES: z.string().optional(),
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
