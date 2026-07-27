// 5-year log-retention export (RMF 1c). Pulls a complete UTC day of security/
// access logs and lands them as NDJSON in the immutable R2 archive.
//
//   npm run log:export -- --dry-run          # write the day's objects to a local
//                                            # folder instead of R2 (validate the
//                                            # pipeline without the bucket)
//   npm run log:export                        # live: write to R2 (needs R2_* env)
//   npm run log:export -- --date 2026-07-25   # a specific UTC day (default: yesterday)
//   npm run log:export -- --dry-run --out ./preview
//
// On a live run it also prints the bucket listing and the Object Lock config as
// the BMA evidence (first-batch listing + bucket immutability policy).
import { createSources, dryRunSink, r2Sink, runExport, previousUtcDay, type ExportOutcome } from "../src/observability/logexport";
import { R2Client, r2ConfigFromEnv } from "../src/observability/r2";
import { logger } from "../src/logging/logger";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

function printOutcomes(outcomes: ExportOutcome[]): void {
  console.log("\n  source    status          rows     bytes   key");
  console.log("  ────────  ──────────────  ──────  ────────  ─────────────────────────");
  for (const o of outcomes) {
    console.log(`  ${o.source.padEnd(8)}  ${o.status.padEnd(14)}  ${String(o.rows).padStart(6)}  ${String(o.bytes).padStart(8)}  ${o.key}${o.detail ? `  (${o.detail})` : ""}`);
  }
}

async function main(): Promise<void> {
  const dryRun = hasFlag("dry-run");
  const date = arg("date") ?? previousUtcDay();
  const only = arg("only"); // restrict to one source, e.g. --only gateway
  let sources = createSources();
  if (only) sources = sources.filter((s) => s.name === only);

  console.log(`\nlog-retention export — day ${date} (UTC)  [${dryRun ? "DRY RUN" : "LIVE → R2"}]${only ? `  (only: ${only})` : ""}`);
  console.log(`sources: ${sources.map((s) => `${s.name}${s.available ? "" : " (unavailable)"}`).join(", ") || "(none matched --only)"}`);

  if (dryRun) {
    const out = arg("out") ?? "./log-export-preview";
    console.log(`writing NDJSON preview under ${out}/`);
    const outcomes = await runExport(date, sources, dryRunSink(out));
    printOutcomes(outcomes);
    console.log("\n(dry run: nothing written to R2)\n");
    return;
  }

  // ── Live ─────────────────────────────────────────────────────────────────
  const cfg = r2ConfigFromEnv();
  if (!cfg) {
    console.error("\nLIVE export needs R2 env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.");
    console.error("Run with --dry-run to validate the pipeline without the bucket.\n");
    process.exit(1);
  }
  const client = new R2Client(cfg);
  const outcomes = await runExport(date, sources, r2Sink(client));
  printOutcomes(outcomes);

  // Evidence: the archive listing (the first-batch proof). The immutability
  // policy is an R2 "bucket lock", not S3 Object Lock, so it is captured
  // separately — see the note below.
  console.log("\n── evidence ─────────────────────────────────────────────");
  try {
    const objs = await client.list("");
    console.log(`bucket "${cfg.bucket}" now holds ${objs.length} object(s):`);
    for (const o of objs.slice(-12)) console.log(`  ${o.key}  (${o.size} bytes)`);
  } catch (e) {
    console.log(`  listing failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log("\nImmutability (retention lock) evidence — capture separately:");
  console.log(`  wrangler r2 bucket lock list ${cfg.bucket}`);
  console.log("  or Cloudflare dashboard → R2 → the bucket → Settings → Bucket lock rules");
  console.log("");
}

main().catch((e: unknown) => {
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "log-export fatal");
  process.exit(1);
});
