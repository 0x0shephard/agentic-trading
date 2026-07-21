// Slack delivery for surveillance and protocol-health alerts.
//
// Two channels, routed by severity:
//   P1 critical -> #critical-alerts     (loss events, market freeze, cascade)
//   P2 warning  -> #bytestrike-alerts   (early warning, degradation)
//
// Webhook URLs come from env and are treated as credentials.
import { env } from "../../config/env";
import { logger } from "../../logging/logger";

export type Severity = "critical" | "warning" | "info";

export interface AlertMessage {
  severity: Severity;
  /** Short headline, e.g. "Bad debt recorded". */
  title: string;
  /** One sentence of what happened and why it matters. */
  detail: string;
  /** Structured context rendered as fields. */
  fields?: Record<string, string | number>;
  /** Optional links (block explorer, dashboard). */
  links?: { label: string; url: string }[];
  /** Set when this message reports a previously-alerted condition clearing. */
  recovery?: boolean;
}

const COLOR: Record<Severity, string> = {
  critical: "#d93025", // red
  warning: "#f9ab00", // amber
  info: "#1a73e8", // blue
};
const ICON: Record<Severity, string> = { critical: ":rotating_light:", warning: ":warning:", info: ":information_source:" };

function webhookFor(sev: Severity): string | undefined {
  // Critical goes to its own channel so it stays loud; everything else to the
  // general alerts channel. Falls back to the other webhook if only one is set.
  if (sev === "critical") return env.SLACK_WEBHOOK_CRITICAL ?? env.SLACK_WEBHOOK_ALERTS;
  return env.SLACK_WEBHOOK_ALERTS ?? env.SLACK_WEBHOOK_CRITICAL;
}

function render(m: AlertMessage): unknown {
  const icon = m.recovery ? ":white_check_mark:" : ICON[m.severity];
  const prefix = m.recovery ? "RECOVERED" : m.severity.toUpperCase();
  const headline = `${icon} *[${prefix}] ${m.title}*`;

  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `${headline}\n${m.detail}` } },
  ];

  if (m.fields && Object.keys(m.fields).length > 0) {
    // Slack caps a section at 10 fields.
    const entries = Object.entries(m.fields).slice(0, 10);
    blocks.push({
      type: "section",
      fields: entries.map(([k, v]) => ({ type: "mrkdwn", text: `*${k}*\n${String(v)}` })),
    });
  }

  if (m.links?.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: m.links.map((l) => `<${l.url}|${l.label}>`).join("  |  ") }],
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `ByteStrike surveillance | ${new Date().toISOString()}` }],
  });

  return {
    text: `[${prefix}] ${m.title}: ${m.detail}`, // notification fallback text
    attachments: [{ color: m.recovery ? "#188038" : COLOR[m.severity], blocks }],
  };
}

/** Post an alert. Returns true if Slack accepted it. Never throws. */
export async function sendAlert(m: AlertMessage): Promise<boolean> {
  const url = webhookFor(m.severity);
  if (!url) {
    logger.warn({ title: m.title, severity: m.severity }, "no Slack webhook configured; alert not delivered");
    return false;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(render(m)),
    });
    if (!res.ok) {
      logger.error({ status: res.status, body: (await res.text()).slice(0, 200), title: m.title }, "Slack delivery failed");
      return false;
    }
    logger.info({ severity: m.severity, title: m.title, recovery: !!m.recovery }, "alert delivered to Slack");
    return true;
  } catch (e) {
    // Delivery failure must never take down the monitor: a crashed monitor is a
    // silent failure, which is worse than a dropped message.
    logger.error({ err: e instanceof Error ? e.message : String(e), title: m.title }, "Slack delivery threw");
    return false;
  }
}
