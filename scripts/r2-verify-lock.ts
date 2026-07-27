// Prove the R2 bucket lock is active (RMF 1c immutability evidence).
//
//   npm run r2:verify-lock
//
// Writes a tiny probe object under _locktest/, then tries to delete it. If the
// bucket lock is active the delete is rejected and the archive is genuinely
// immutable; if the delete succeeds, the lock is NOT in effect and the retention
// requirement is unmet. Never touches real archive data.
import { R2Client, r2ConfigFromEnv } from "../src/observability/r2";

async function main(): Promise<void> {
  const cfg = r2ConfigFromEnv();
  if (!cfg) { console.error("Need R2_* env (account id, access key, secret, bucket)."); process.exit(1); }
  const client = new R2Client(cfg);
  const key = `_locktest/${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;

  console.log(`\nbucket: ${cfg.bucket}`);
  console.log(`[1] writing probe object ${key} ...`);
  await client.put(key, "bucket-lock immutability probe\n", "text/plain");
  console.log("    written.");

  console.log(`[2] attempting to DELETE the probe (a bucket lock must reject this) ...`);
  const status = await client.tryDelete(key);
  const stillThere = await client.exists(key);

  console.log(`    delete HTTP status: ${status}`);
  console.log(`    object still present after delete attempt: ${stillThere}`);

  if (stillThere) {
    console.log("\n✅ IMMUTABILITY CONFIRMED — the delete was rejected; the bucket lock is active.");
    console.log("   (The probe object remains, locked, as expected. That is the evidence.)\n");
    process.exit(0);
  } else {
    console.log("\n❌ NOT IMMUTABLE — the probe object was deleted, so NO bucket lock is in effect.");
    console.log("   Add a lock rule:  npx wrangler r2 bucket lock add " + cfg.bucket + ' --prefix "" --retention-days 1827');
    console.log("   The 5-year retention requirement is NOT met until this passes.\n");
    process.exit(1);
  }
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
