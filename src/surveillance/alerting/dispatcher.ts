// Alert dispatcher: turns a stream of "conditions currently true" into a stream
// of notifications a human will actually keep reading.
//
// An alert channel fails by being noisy, not by missing events. Four rules:
//
//   1. EDGE TRIGGERED. Fire when a condition becomes true, not on every poll for
//      as long as it stays true. A stale oracle would otherwise emit a message
//      every 60 seconds for hours.
//   2. COOLDOWN. A condition that flaps cannot re-notify more often than
//      ALERT_COOLDOWN_SEC.
//   3. RECOVERY. When a condition clears, say so. Knowing it is over is as
//      operationally useful as knowing it started, and it is what allows someone
//      to stop watching.
//   4. HEARTBEAT. If the monitor dies you get silence, which is indistinguishable
//      from "all clear". A periodic heartbeat makes that failure detectable.
import { env } from "../../config/env";
import { logger } from "../../logging/logger";
import { sendAlert } from "./slack";
import type { AlertMessage } from "./slack";
import type { HealthSignal } from "./health";

interface Tracked {
  firstSeen: number;
  lastNotified: number;
  signal: HealthSignal;
}

export class AlertDispatcher {
  private active = new Map<string, Tracked>();
  private lastHeartbeat = 0;
  private started = Date.now();

  /** Reconcile the currently-true conditions against what we have already sent. */
  async dispatch(signals: HealthSignal[]): Promise<{ fired: number; recovered: number }> {
    const now = Date.now();
    const cooldownMs = env.ALERT_COOLDOWN_SEC * 1000;
    const seen = new Set(signals.map((s) => s.key));
    let fired = 0;
    let recovered = 0;

    for (const s of signals) {
      const prev = this.active.get(s.key);
      const isNew = !prev;
      const coolededDown = prev !== undefined && now - prev.lastNotified >= cooldownMs;

      if (isNew || coolededDown) {
        const msg: AlertMessage = {
          severity: s.severity,
          title: s.title,
          detail: s.detail,
          fields: {
            ...s.fields,
            ...(isNew ? {} : { Ongoing: `since ${new Date(prev.firstSeen).toISOString()}` }),
          },
        };
        await sendAlert(msg);
        fired++;
        this.active.set(s.key, {
          firstSeen: prev?.firstSeen ?? now,
          lastNotified: now,
          signal: s,
        });
      } else if (prev) {
        // Still true, still inside cooldown: refresh the payload silently.
        prev.signal = s;
      }
    }

    // Anything previously firing that is no longer true has recovered.
    for (const [key, t] of [...this.active.entries()]) {
      if (seen.has(key)) continue;
      await sendAlert({
        severity: t.signal.severity,
        title: t.signal.title,
        detail: `Condition cleared after ${Math.round((now - t.firstSeen) / 60000)} minute(s).`,
        fields: { Condition: key },
        recovery: true,
      });
      recovered++;
      this.active.delete(key);
    }

    return { fired, recovered };
  }

  /** Periodic proof-of-life so an outage of the monitor itself is visible. */
  async maybeHeartbeat(context: Record<string, string | number>): Promise<boolean> {
    const now = Date.now();
    const intervalMs = env.HEARTBEAT_HOURS * 3600_000;
    if (this.lastHeartbeat !== 0 && now - this.lastHeartbeat < intervalMs) return false;
    this.lastHeartbeat = now;
    await sendAlert({
      severity: "info",
      title: "Surveillance heartbeat",
      detail: "Monitor is running. This message confirms the alert path is live; its absence means the monitor is down.",
      fields: {
        ...context,
        Uptime: `${((now - this.started) / 3600_000).toFixed(1)}h`,
        "Active conditions": this.active.size,
      },
    });
    return true;
  }

  /** One-off message on boot, confirming wiring end to end. */
  async announceStart(context: Record<string, string | number>): Promise<void> {
    if (env.ALERT_ON_START !== "true") return;
    this.lastHeartbeat = Date.now();
    await sendAlert({
      severity: "info",
      title: "Surveillance monitor started",
      detail: "Protocol health and market-abuse monitoring is now active.",
      fields: context,
    });
  }

  /** Conditions currently firing, for logging and the dashboard. */
  activeKeys(): string[] {
    return [...this.active.keys()];
  }
}

/** Escalate a manipulation alert raised by the behavioural detector. */
export async function dispatchManipulation(a: {
  severity: string; kind: string; wallet: string; market: string;
  devBps: number; impactBps: number; notionalUsd: number; detail: string; txHashes: string[];
}): Promise<void> {
  // Round-trips are confirmed abuse (push then unwind); a single push is a
  // suspicion. Escalate the former, report the latter.
  const severity = a.kind === "manipulation_round_trip" || a.severity === "high" ? "critical" : "warning";
  await sendAlert({
    severity,
    title: `Market abuse detected: ${a.kind.replace(/_/g, " ")}`,
    detail: a.detail,
    fields: {
      Market: a.market,
      Account: `${a.wallet.slice(0, 10)}…`,
      "Price impact": `${Math.round(a.impactBps)} bps`,
      "Index deviation": `${Math.round(a.devBps)} bps`,
      Notional: `$${a.notionalUsd.toFixed(2)}`,
    },
    links: a.txHashes.slice(0, 2).map((h, i) => ({
      label: i === 0 ? "Offending tx" : "Unwind tx",
      url: `https://sepolia.etherscan.io/tx/${h}`,
    })),
  });
  logger.warn({ kind: a.kind, wallet: a.wallet, market: a.market }, "manipulation alert escalated to Slack");
}
