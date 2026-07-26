// Verify the alerting path end to end without waiting for a real incident.
//
//   npm run alert:test          send one message to each channel
//   npm run alert:test health   run the REAL health checks against live chain
//                               and report what would fire (sends nothing)
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { env } from "../src/config/env";
import { sendAlert } from "../src/surveillance/alerting/slack";
import { checkHealth, newHealthState, SUPPRESSED } from "../src/surveillance/alerting/health";
import { createHealthMonitor } from "../src/surveillance/health-monitor";
import { adminWatchPass, newAdminWatchState, adminAddresses } from "../src/surveillance/alerting/adminwatch";
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
