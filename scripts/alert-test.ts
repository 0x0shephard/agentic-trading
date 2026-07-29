// Verify the alerting path end to end without waiting for a real incident.
//
//   npm run alert:test          send one message to each channel
//   npm run alert:test health   run the REAL health checks against live chain
//                               and report what would fire (sends nothing)
//   npm run alert:test net      probe the RPC endpoint(s): head, latency, lag,
//                               and what the network monitor would fire (sends nothing)
//   npm run alert:test site     query the gateway window (Axiom) + probe uptime,
//                               and what the site/login monitor would fire (sends nothing)
//   npm run alert:test classes  SEND one clearly-marked test alert per monitor class
//                               to the live Slack channels (for evidence screenshots)
//   npm run alert:test recovery SEND recovery notices (a cleared condition) to Slack
//   npm run alert:test leverage compute the account-leverage distribution + 80%-of-cap
//                               share against live chain (sends nothing)
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { env } from "../src/config/env";
import { sendAlert } from "../src/surveillance/alerting/slack";
import { checkHealth, newHealthState, SUPPRESSED } from "../src/surveillance/alerting/health";
import { createHealthMonitor } from "../src/surveillance/health-monitor";
import { adminWatchPass, newAdminWatchState, adminAddresses } from "../src/surveillance/alerting/adminwatch";
import { checkNetHealth, createNetClients, newNetHealthState, netConfigFromEnv } from "../src/surveillance/alerting/nethealth";
import { checkSiteHealth, createSiteDeps, siteConfigFromEnv, siteHealthEnabled } from "../src/surveillance/alerting/sitehealth";
import { readAccountLeverage, computeLeverageReport } from "../src/surveillance/leverage";
import { MARKETS } from "../src/config/markets";
import { logger } from "../src/logging/logger";

async function main(): Promise<void> {
  const mode = (process.argv[2] || "send").toLowerCase();

  console.log("\nwebhooks configured:");
  console.log(`  critical (#critical-alerts):   ${env.SLACK_WEBHOOK_CRITICAL ? "yes" : "NO"}`);
  console.log(`  warning  (#bytestrike-alerts): ${env.SLACK_WEBHOOK_ALERTS ? "yes" : "NO"}`);

  if (mode === "health") {
    // Dry run: evaluate the real conditions against live chain, print, send nothing.
    const pc = createPublicClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
    const hm = createHealthMonitor();
    console.log(`\nevaluating live protocol health across ${hm.accounts.length} accounts...`);
    const signals = await checkHealth(pc, newHealthState(), hm.accounts);
    console.log(`\nconditions currently TRUE: ${signals.length}`);
    for (const s of signals) {
      console.log(`\n  [${s.severity.toUpperCase()}] ${s.title}`);
      console.log(`     key: ${s.key}`);
      console.log(`     ${s.detail}`);
      for (const [k, v] of Object.entries(s.fields)) console.log(`     ${k}: ${v}`);
    }
    console.log(`\nsuppressed (documented known issues, will not alert):`);
    for (const k of SUPPRESSED.stuckLiquidatable) console.log(`  stuck-liquidatable: ${k}`);
    for (const k of SUPPRESSED.slowFeedMarkets) console.log(`  slow-feed warning:  ${k}`);
    console.log("\n(dry run: nothing was sent)\n");
    return;
  }

  if (mode === "admin") {
    // Dry run: scan recent chain history for admin actions and print what would
    // fire, without sending. `blocks` arg controls the window (default 2000).
    const pc = createPublicClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
    const window = BigInt(process.argv[3] || "2000");
    const head = await pc.getBlockNumber();
    const from = head - window > 0n ? head - window : 0n;
    console.log(`\nadmin addresses watched: ${adminAddresses().join(", ")}`);
    console.log(`scanning admin actions in blocks ${from}..${head} (${window} blocks)...`);
    const st = newAdminWatchState(from - 1n);
    const alerts = await adminWatchPass(pc, st, { send: false });
    console.log(`\nadmin actions that WOULD alert: ${alerts.length}`);
    for (const a of alerts) {
      console.log(`\n  [${a.severity.toUpperCase()}] ${a.title}`);
      console.log(`     ${a.detail}`);
      for (const [k, v] of Object.entries(a.fields ?? {})) console.log(`     ${k}: ${v}`);
      for (const l of a.links ?? []) console.log(`     ${l.url}`);
    }
    console.log("\n(dry run: nothing was sent)\n");
    return;
  }

  if (mode === "net") {
    // Dry run: probe the RPC endpoint(s) now and report status + what would fire.
    // A single snapshot can't observe a stall (that needs elapsed time), but it
    // proves the primary is reachable, shows the head, and cross-checks the
    // fallback for lag.
    const clients = createNetClients();
    const cfg = netConfigFromEnv();
    console.log(`\nprimary RPC:  ${clients.primary.ep.url}`);
    console.log(`fallback RPC: ${clients.fallback ? clients.fallback.ep.url : "(none configured — set NET_FALLBACK_RPC_URL for down-vs-lag disambiguation)"}`);
    console.log(`thresholds:   stall warn ${cfg.stallWarnMs / 60000}min / crit ${cfg.stallCritMs / 60000}min, lag ${cfg.lagBlocks} blocks, down after ${cfg.downConsecutive} misses`);

    const t0 = Date.now();
    let primaryHead: bigint | null = null;
    try { primaryHead = await clients.primary.client.getBlockNumber(); } catch { /* reported below */ }
    const primaryMs = Date.now() - t0;
    let fallbackHead: bigint | null = null;
    if (clients.fallback) { try { fallbackHead = await clients.fallback.client.getBlockNumber(); } catch { /* reported below */ } }

    console.log(`\nprimary head:  ${primaryHead === null ? "UNREACHABLE" : `${primaryHead} (${primaryMs}ms)`}`);
    if (clients.fallback) console.log(`fallback head: ${fallbackHead === null ? "UNREACHABLE" : fallbackHead}`);
    if (primaryHead !== null && fallbackHead !== null) console.log(`head delta:    ${fallbackHead - primaryHead} block(s) (fallback − primary)`);

    // Evaluate the real check once (down needs downConsecutive misses to fire, so
    // a healthy single probe correctly shows nothing).
    const signals = await checkNetHealth(clients, newNetHealthState(), cfg);
    console.log(`\nconditions currently TRUE: ${signals.length}`);
    for (const s of signals) {
      console.log(`\n  [${s.severity.toUpperCase()}] ${s.title}`);
      console.log(`     key: ${s.key}`);
      console.log(`     ${s.detail}`);
      for (const [k, v] of Object.entries(s.fields)) console.log(`     ${k}: ${v}`);
    }
    console.log("\n(dry run: nothing was sent)\n");
    return;
  }

  if (mode === "site") {
    // Dry run: query the real gateway window + probe uptime, print status and
    // what would fire. Sends nothing.
    if (!siteHealthEnabled()) {
      console.log("\nsite health DISABLED: set AXIOM_API_TOKEN + AXIOM_DATASET (gateway logs) and/or SITE_URL / SITE_API_HEALTH_URL (uptime).\n");
      return;
    }
    const deps = createSiteDeps();
    const cfg = siteConfigFromEnv();
    console.log(`\nwindow: last ${cfg.windowMin} min   min-sample: ${cfg.minSample}`);
    console.log(`thresholds: 5xx warn ${cfg.err5xxWarnPct}%/crit ${cfg.err5xxCritPct}% (floor ${cfg.err5xxAbsFloor}), 429 warn ${cfg.rlWarnPct}%/crit ${cfg.rlCritPct}%, auth-fail/IP warn ${cfg.authFailIpWarn}/crit ${cfg.authFailIpCrit}`);
    console.log(`uptime targets: ${deps.uptimeTargets.length ? deps.uptimeTargets.map((t) => `${t.label} ${t.url}`).join(", ") : "(none configured)"}`);

    const gw = await deps.gateway(cfg.windowMin).catch((e: unknown) => { console.log(`  gateway query error: ${e instanceof Error ? e.message : String(e)}`); return null; });
    if (gw) {
      const pct = (n: number) => gw.total ? `${(n / gw.total * 100).toFixed(1)}%` : "n/a";
      console.log(`\ngateway window: ${gw.total} requests   5xx=${gw.err5xx} (${pct(gw.err5xx)})   429=${gw.rl} (${pct(gw.rl)})`);
      console.log(`top failed-auth IPs: ${gw.authFailByIp.length ? gw.authFailByIp.slice(0, 5).map((x) => `${x.ip}=${x.fails}`).join(", ") : "none"}`);
    } else {
      console.log("\ngateway window: unavailable (Axiom not configured or query failed)");
    }

    const signals = await checkSiteHealth(deps, cfg);
    console.log(`\nconditions currently TRUE: ${signals.length}`);
    for (const s of signals) {
      console.log(`\n  [${s.severity.toUpperCase()}] ${s.title}`);
      console.log(`     key: ${s.key}`);
      console.log(`     ${s.detail}`);
      for (const [k, v] of Object.entries(s.fields)) console.log(`     ${k}: ${v}`);
    }
    console.log("\n(dry run: nothing was sent)\n");
    return;
  }

  if (mode === "classes") {
    // Send one representative, clearly-marked TEST alert per monitor class to the
    // live channels, so each can be screenshotted for the Section 2 evidence. The
    // content mirrors what each real monitor produces. Every message says it is a
    // test so teammates in the channel are not alarmed.
    const t = "test alert — no real incident";
    const examples: { severity: "critical" | "warning" | "info"; title: string; detail: string; fields: Record<string, string | number>; links?: { label: string; url: string }[] }[] = [
      { severity: "warning", title: "Index ageing: T4-PERP",
        detail: `Index price is 9.1h old against a 12.0h limit. (${t}; verifying the index-freshness monitor.)`,
        fields: { Market: "T4-PERP", "Index age": "9.1h", Limit: "12.0h", Class: "index freshness" } },
      { severity: "critical", title: "Insurance fund draw detected",
        detail: `The insurance fund paid out to cover a shortfall. Any draw is a P1 event. (${t}; verifying the insurance-fund watcher.)`,
        fields: { "Amount paid": "1,250.00 USDC", "Total paid": "1,250.00", Cause: "liquidation shortfall", Class: "insurance fund" } },
      { severity: "warning", title: "Sustained large basis: B200-PERP-V2",
        detail: `Mark has held 26.4% away from index for 3 consecutive samples. (${t}; verifying the mark-to-index basis monitor.)`,
        fields: { Market: "B200-PERP-V2", Basis: "-26.4%", Samples: 3, Class: "mark-to-index basis" } },
      { severity: "warning", title: "1 position(s) liquidatable > 15min",
        detail: `A position stayed below maintenance margin past the 15-minute window without being liquidated — the keeper-missed-a-run signal. (${t}; verifying the liquidation heartbeat.)`,
        fields: { Count: 1, "Longest overdue": "22 min", Positions: "0xabcd1234 T4-PERP", Class: "liquidation heartbeat" } },
      { severity: "critical", title: "Suspected bad published price: H100-GPU-PERP",
        detail: `A published index moved +212% in a single step, beyond the 20% guard band. The print was NOT adopted as the baseline. (${t}; verifying the bad-price circuit breaker.)`,
        fields: { Market: "H100-GPU-PERP", "Last accepted": "2.41", Rejected: "7.52", Move: "+212%", Class: "bad-price guard" } },
      { severity: "critical", title: "Market pause changed",
        detail: `MarketRegistry: market H100-GPU-PERP PAUSED by the admin key. (${t}; verifying the admin-action watch.)`,
        fields: { Contract: "MarketRegistry", Action: "MarketPaused", By: "0xCc624f…", Class: "admin action" },
        links: [{ label: "Etherscan", url: "https://sepolia.etherscan.io/address/0xCc624fFA5df1F3F4b30aa8abd30186a86254F406" }] },
      { severity: "critical", title: "Primary RPC endpoint not responding",
        detail: `The primary Sepolia RPC failed 2 consecutive checks; the fallback is responding, so the provider is degraded. (${t}; verifying the network-health monitor.)`,
        fields: { Endpoint: "ethereum-sepolia-rpc.publicnode.com", "Consecutive failures": 2, Fallback: "up @ block 11361058", Class: "network / RPC health" } },
      { severity: "warning", title: "Repeated failed logins from one IP",
        detail: `A single source IP produced 14 failed authentication attempts in 15 minutes, consistent with a brute-force attempt. (${t}; verifying the login/site-health monitor.)`,
        fields: { IP: "203.0.113.45", Failures: 14, Window: "15 min", Class: "login / site health" } },
    ];
    console.log(`\nsending ${examples.length} per-class TEST alerts to the live Slack channels...`);
    let ok = 0;
    for (const e of examples) {
      const delivered = await sendAlert(e);
      console.log(`  ${delivered ? "delivered" : "FAILED  "}  [${e.severity.toUpperCase()}] ${e.fields.Class}`);
      if (delivered) ok++;
      await new Promise((r) => setTimeout(r, 700)); // small gap so ordering is clean
    }
    console.log(`\n${ok}/${examples.length} delivered.${ok === examples.length ? " Screenshot each for the Section 2 evidence." : ""}\n`);
    process.exit(ok === examples.length ? 0 : 1);
  }

  if (mode === "recovery") {
    // Send representative RECOVERY notices (what the dispatcher posts when a
    // previously-firing condition clears), matching two of the class alerts so the
    // full alert -> resolved lifecycle can be screenshotted.
    const recoveries: { severity: "critical" | "warning"; title: string; mins: number; condition: string }[] = [
      { severity: "warning", title: "Index ageing: T4-PERP", mins: 34, condition: "stale-warning:T4-PERP" },
      { severity: "critical", title: "Primary RPC endpoint not responding", mins: 6, condition: "rpc-down" },
    ];
    console.log(`\nsending ${recoveries.length} recovery notice(s) to Slack...`);
    let ok = 0;
    for (const r of recoveries) {
      const delivered = await sendAlert({
        severity: r.severity,
        title: r.title,
        detail: `Condition cleared after ${r.mins} minute(s). (test — verifying the recovery-notice path.)`,
        fields: { Condition: r.condition },
        recovery: true,
      });
      console.log(`  ${delivered ? "delivered" : "FAILED  "}  [RECOVERED] ${r.title}`);
      if (delivered) ok++;
      await new Promise((res) => setTimeout(res, 700));
    }
    console.log(`\n${ok}/${recoveries.length} delivered.\n`);
    process.exit(ok === recoveries.length ? 0 : 1);
  }

  if (mode === "leverage") {
    // Dry run: compute the account-leverage distribution + 80%-of-cap share against
    // live chain, using the derived agent accounts as the universe (the real pass
    // enumerates all trading accounts from the DB). Writes nothing.
    const pc = createPublicClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
    const hm = createHealthMonitor();
    console.log(`\ncomputing leverage across ${hm.accounts.length} accounts × ${MARKETS.length} markets...`);
    const inputs = await readAccountLeverage(pc, hm.accounts, MARKETS);
    const report = computeLeverageReport(inputs);
    console.log(`\naccounts with open positions: ${report.accountsWithPositions}`);
    console.log(`above 80% of cap:            ${report.flaggedAccounts} (${(report.shareAbove80PctCap * 100).toFixed(1)}%)`);
    console.log(`insolvent (equity ≤ 0):      ${report.insolventAccounts}`);
    console.log(`median leverage:             ${report.medianLeverage.toFixed(2)}x   max: ${report.maxLeverage.toFixed(2)}x`);
    console.log(`\ndistribution:`);
    for (const b of report.distribution) console.log(`  ${b.bucket.padEnd(8)} ${"█".repeat(b.count)} ${b.count}`);
    if (report.accounts.length) {
      console.log(`\nper-account (open positions):`);
      for (const a of report.accounts.slice(0, 15)) console.log(`  ${a.account.slice(0, 12)}…  ${Number.isFinite(a.leverage) ? a.leverage.toFixed(2) + "x" : "∞ (insolvent)"}${a.aboveCap80 ? "  ⚑ >80% cap" : ""}`);
    }
    console.log("\n(dry run: nothing written or sent)\n");
    return;
  }

  // Live delivery test: one message per channel, plus a recovery example.
  console.log("\nsending test messages...");
  const ok1 = await sendAlert({
    severity: "warning",
    title: "Alert path test (warning)",
    detail: "This is a test of the #bytestrike-alerts route. Warnings are early-warning conditions that need attention but are not yet losses.",
    fields: { Example: "Index ageing", Market: "H100-GPU-PERP", "Index age": "9.1h", Limit: "12.0h" },
  });
  const ok2 = await sendAlert({
    severity: "critical",
    title: "Alert path test (critical)",
    detail: "This is a test of the #critical-alerts route. Critical conditions are loss events or a frozen market and warrant immediate attention.",
    fields: { Example: "Bad debt recorded", "Total bad debt": "0.000000", Note: "test message, no real incident" },
    links: [{ label: "Etherscan", url: "https://sepolia.etherscan.io/" }],
  });
  const ok3 = await sendAlert({
    severity: "warning",
    title: "Alert path test (warning)",
    detail: "Example of a recovery notice, sent when a previously alerted condition clears.",
    fields: { Condition: "stale-warning:H100-GPU-PERP" },
    recovery: true,
  });

  console.log(`  warning channel:  ${ok1 ? "delivered" : "FAILED"}`);
  console.log(`  critical channel: ${ok2 ? "delivered" : "FAILED"}`);
  console.log(`  recovery notice:  ${ok3 ? "delivered" : "FAILED"}`);
  console.log(ok1 && ok2 && ok3 ? "\nALERT PATH OK\n" : "\nALERT PATH INCOMPLETE\n");
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "alert test fatal");
  process.exit(1);
});
