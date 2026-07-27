// R2 connectivity / archive check for the log-retention store (RMF 1c).
//
//   npm run r2:check                 # verify creds, list buckets, list R2_BUCKET
//   npm run r2:check -- <bucketName> # also list objects in a specific bucket
//
// Uses the R2_* credentials in .env. Read-only.
import { AwsClient } from "aws4fetch";
import { env } from "../src/config/env";

function names(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1] ?? "");
}

async function main(): Promise<void> {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.error("Need R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env");
    process.exit(1);
  }
  const aws = new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, region: "auto", service: "s3" });
  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  console.log(`\nendpoint: ${endpoint}`);

  // List buckets (works only if the token is account-scoped; a bucket-scoped
  // token 403s here, which is fine — we still test the named bucket below).
  console.log("\n[1] list buckets:");
  try {
    const res = await aws.fetch(`${endpoint}/`, { method: "GET" });
    if (res.ok) {
      const buckets = names(await res.text(), "Name");
      console.log(buckets.length ? buckets.map((b) => `  - ${b}`).join("\n") : "  (none)");
    } else {
      console.log(`  HTTP ${res.status} (${res.status === 403 ? "token is bucket-scoped — expected; use the arg to test the bucket" : "unexpected"})`);
    }
  } catch (e) {
    console.log(`  error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // List objects in the target bucket (arg overrides R2_BUCKET).
  const target = process.argv[2] ?? R2_BUCKET;
  if (!target) {
    console.log("\n[2] no bucket to test (pass a name as an arg or set R2_BUCKET).\n");
    return;
  }
  console.log(`\n[2] list objects in "${target}":`);
  const res = await aws.fetch(`${endpoint}/${encodeURIComponent(target)}?list-type=2`, { method: "GET" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.log(`  HTTP ${res.status} — ${res.status === 404 ? "no such bucket (wrong name?)" : res.status === 403 ? "token has no access to this bucket" : body.slice(0, 200)}`);
    process.exit(1);
  }
  const xml = await res.text();
  const keys = names(xml, "Key");
  console.log(`  OK — bucket reachable, ${keys.length} object(s)${keys.length ? ":" : " (empty, ready for first export)"}`);
  for (const k of keys.slice(0, 20)) console.log(`    ${k}`);
  console.log("");
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
