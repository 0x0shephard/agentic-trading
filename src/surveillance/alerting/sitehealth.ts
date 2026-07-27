// Login & site-health monitor (RMF Section 2, "Login and site health").
//
// Off-chain surveillance of the customer-facing surface, three sources:
//
//   1. Gateway logs in Axiom (shipped by the Cloudflare worker per request):
//        - gw-error-rate   : 5xx server-error rate over the window
//        - gw-429-rate      : share of requests being rate-limited (abuse / DoS)
//        - auth-fail-ip:<ip> : repeated failed logins from one source IP
//   2. External uptime probes of the site and the API gateway.
//
// Calibration notes from live traffic (see build): 5xx is ~0 under normal load,
// so any sustained 5xx is a real signal; 429s are HIGH at baseline (~13% over a
// week, ~30% in a busy 15-min window) because the trading agents hammer the write
// tier, so the 429 alert sits well above that and fires only when a MAJORITY of
// traffic is rejected, not on an absolute count; auth-tier 4xx is low-volume, so a
// single IP racking up failures in a 15-minute window is a credible brute-force
// signal.
//
// NOT covered here, and tracked as follow-ups: failed logins per ACCOUNT and
// service-role-key anomaly, both of which need Supabase's auth.audit_log_entries
// (the gateway logs carry the IP but not the account identity).
import { env } from "../../config/env";
import { logger } from "../../logging/logger";
import { AlertDispatcher } from "./dispatcher";
import type { HealthSignal } from "./health";
import { axiomQuery, axiomConfigured, axiomDataset } from "../../observability/axiom";

/** Aggregated gateway activity over a lookback window. */
export interface GatewayWindow {
  total: number;
  err5xx: number;
  rl: number; // rate-limited (HTTP 429) count
  authFailByIp: { ip: string; fails: number }[];
}

export interface ProbeResult { url: string; ok: boolean; status: number | null; ms: number }

export interface UptimeTarget { label: string; url: string }

/** IO the check depends on, injected so the evaluation logic is unit-testable. */
export interface SiteHealthDeps {
  /** Aggregated gateway window, or null if the log source is unavailable. */
  gateway: (windowMin: number) => Promise<GatewayWindow | null>;
  probe: (url: string) => Promise<ProbeResult>;
  uptimeTargets: UptimeTarget[];
}

export interface SiteConfig {
  windowMin: number;
  minSample: number;        // don't compute a rate on a tiny sample
  err5xxWarnPct: number;
  err5xxCritPct: number;
  err5xxAbsFloor: number;   // absolute 5xx count that alerts regardless of rate
  rlWarnPct: number;
  rlCritPct: number;
  authFailIpWarn: number;
  authFailIpCrit: number;
}

export function siteConfigFromEnv(): SiteConfig {
  return {
    windowMin: env.SITE_WINDOW_MIN,
    minSample: env.SITE_MIN_SAMPLE,
    err5xxWarnPct: env.SITE_ERR5XX_WARN_PCT,
    err5xxCritPct: env.SITE_ERR5XX_CRIT_PCT,
    err5xxAbsFloor: env.SITE_ERR5XX_ABS_FLOOR,
    rlWarnPct: env.SITE_RL_WARN_PCT,
    rlCritPct: env.SITE_RL_CRIT_PCT,
    authFailIpWarn: env.SITE_AUTHFAIL_IP_WARN,
    authFailIpCrit: env.SITE_AUTHFAIL_IP_CRIT,
  };
}

/** Evaluate current site conditions. Pure given deps + cfg. */
export async function checkSiteHealth(deps: SiteHealthDeps, cfg: SiteConfig): Promise<HealthSignal[]> {
  const out: HealthSignal[] = [];

  // ── Gateway logs (Axiom) ──────────────────────────────────────────────────
  const gw = await deps.gateway(cfg.windowMin).catch((e: unknown) => {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "site: gateway window query failed");
    return null;
  });

  if (gw && gw.total >= cfg.minSample) {
    // 5xx server-error rate.
    const err5xxPct = (gw.err5xx / gw.total) * 100;
    if (gw.err5xx >= cfg.err5xxAbsFloor || err5xxPct >= cfg.err5xxWarnPct) {
      const critical = err5xxPct >= cfg.err5xxCritPct;
      out.push({
        key: "gw-error-rate",
        severity: critical ? "critical" : "warning",
        title: `Gateway 5xx error rate ${err5xxPct.toFixed(1)}%`,
        detail: `The API gateway returned ${gw.err5xx} server error(s) (5xx) out of ${gw.total} requests in the last ${cfg.windowMin} minutes. Server errors are near zero in normal operation, so a sustained rate points at a backend or gateway fault.`,
        fields: { "5xx": gw.err5xx, Requests: gw.total, Rate: `${err5xxPct.toFixed(1)}%`, Window: `${cfg.windowMin} min` },
      });
    }

    // Rate-limit saturation. Baseline is high (agents), so this alerts on the
    // gateway rejecting a large SHARE of traffic — abuse, a loop, or a DoS.
    const rlPct = (gw.rl / gw.total) * 100;
    if (rlPct >= cfg.rlWarnPct) {
      const critical = rlPct >= cfg.rlCritPct;
      out.push({
        key: "gw-429-rate",
        severity: critical ? "critical" : "warning",
        title: `Gateway rate-limiting ${rlPct.toFixed(0)}% of requests`,
        detail: `${gw.rl} of ${gw.total} requests in the last ${cfg.windowMin} minutes were rate-limited (HTTP 429). A high share of rejected traffic can indicate abuse, a runaway client, or a denial-of-service attempt.`,
        fields: { "429s": gw.rl, Requests: gw.total, Rate: `${rlPct.toFixed(0)}%`, Window: `${cfg.windowMin} min` },
      });
    }
  }

  // Repeated failed logins from a single IP (independent of sample size).
  if (gw) {
    for (const { ip, fails } of gw.authFailByIp) {
      if (fails < cfg.authFailIpWarn) continue;
      const critical = fails >= cfg.authFailIpCrit;
      out.push({
        key: `auth-fail-ip:${ip}`,
        severity: critical ? "critical" : "warning",
        title: "Repeated failed logins from one IP",
        detail: `A single source IP produced ${fails} failed authentication attempts in the last ${cfg.windowMin} minutes. This pattern is consistent with credential stuffing or a brute-force attempt.`,
        fields: { IP: ip, Failures: fails, Window: `${cfg.windowMin} min` },
      });
    }
  }

  // ── External uptime probes ────────────────────────────────────────────────
  for (const t of deps.uptimeTargets) {
    const r = await deps.probe(t.url).catch(() => ({ url: t.url, ok: false, status: null, ms: 0 }));
    if (!r.ok) {
      out.push({
        key: `uptime-down:${t.label}`,
        severity: "critical",
        title: `${t.label} not responding`,
        detail: `An external probe of ${t.label} (${t.url}) did not get a healthy response. Users may be unable to reach the ${t.label.toLowerCase()}.`,
        fields: { URL: t.url, Response: r.status !== null ? `HTTP ${r.status}` : "no response / timeout" },
      });
    }
  }

  return out;
}

// ── Production IO implementations ────────────────────────────────────────────

/** Aggregate the gateway window from Axiom (two APL queries: rates + per-IP). */
async function gatewayFromAxiom(windowMin: number): Promise<GatewayWindow> {
  const end = new Date();
  const start = new Date(end.getTime() - windowMin * 60_000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const base = `['${axiomDataset()}'] | where service == 'cf-gateway'`;

  const [rateRows, ipRows] = await Promise.all([
    axiomQuery(
      `${base} | summarize total=count(), err5xx=countif(status >= 500), rl=countif(rateLimited == true)`,
      startIso, endIso,
    ),
    axiomQuery(
      `${base} and tier == 'auth' and status >= 400 | summarize fails=count() by ip | sort by fails desc | limit 20`,
      startIso, endIso,
    ),
  ]);

  const r = rateRows[0] ?? {};
  return {
    total: Number(r.total ?? 0),
    err5xx: Number(r.err5xx ?? 0),
    rl: Number(r.rl ?? 0),
    authFailByIp: ipRows
      .map((x) => ({ ip: String(x.ip ?? ""), fails: Number(x.fails ?? 0) }))
      .filter((x) => x.ip !== ""),
  };
}

/** HTTP liveness probe. <500 (incl. 4xx) means the server is up; 5xx/no-response
 *  means down. Two quick attempts ride out a transient blip. */
async function httpProbe(url: string): Promise<ProbeResult> {
  let last: ProbeResult = { url, ok: false, status: null, ms: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8_000);
    try {
      const res = await fetch(url, { method: "GET", signal: ctl.signal, redirect: "follow" });
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (res.status < 500) return { url, ok: true, status: res.status, ms };
      last = { url, ok: false, status: res.status, ms };
    } catch {
      clearTimeout(timer);
      last = { url, ok: false, status: null, ms: Date.now() - t0 };
    }
  }
  return last;
}

export function uptimeTargetsFromEnv(): UptimeTarget[] {
  const out: UptimeTarget[] = [];
  if (env.SITE_URL) out.push({ label: "Website", url: env.SITE_URL });
  if (env.SITE_API_HEALTH_URL) out.push({ label: "API gateway", url: env.SITE_API_HEALTH_URL });
  return out;
}

export function createSiteDeps(): SiteHealthDeps {
  return {
    gateway: axiomConfigured() ? gatewayFromAxiom : async () => null,
    probe: httpProbe,
    uptimeTargets: uptimeTargetsFromEnv(),
  };
}

/** Is any source configured? Used to decide whether to run the pass at all. */
export function siteHealthEnabled(): boolean {
  return axiomConfigured() || uptimeTargetsFromEnv().length > 0;
}

// ── Monitor wrapper ──────────────────────────────────────────────────────────

export interface SiteMonitor { deps: SiteHealthDeps; dispatcher: AlertDispatcher; cfg: SiteConfig }

export function createSiteMonitor(): SiteMonitor {
  return { deps: createSiteDeps(), dispatcher: new AlertDispatcher(), cfg: siteConfigFromEnv() };
}

/** One site-health pass: evaluate, dispatch transitions and recoveries. No
 *  heartbeat here — the main health monitor's heartbeat covers the process. */
export async function siteHealthPass(sm: SiteMonitor): Promise<void> {
  let signals: HealthSignal[];
  try {
    signals = await checkSiteHealth(sm.deps, sm.cfg);
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "site health check failed");
    return;
  }
  const { fired, recovered } = await sm.dispatcher.dispatch(signals);
  if (fired || recovered) {
    logger.warn({ fired, recovered, active: sm.dispatcher.activeKeys() }, "site health alerts dispatched");
  }
}
