// Minimal Cloudflare R2 client over the S3-compatible API (SigV4 via aws4fetch).
//
// Used by the 5-year log-retention export (RMF 1c). Immutability is enforced at
// the BUCKET level by an R2 "bucket lock" rule (prefix "", ~5-year retention), so
// a plain PutObject is retained automatically — there is no per-object retention
// header to get wrong. Note: an R2 bucket lock protects objects from deletion/
// overwrite for the retention window, but the rule itself is admin-removable, so
// ultimate protection also depends on restricted, MFA-gated console access.
//
// Credentials (R2 access key id + secret) are secrets: Railway/.env only.
import { AwsClient } from "aws4fetch";
import { env } from "../config/env";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function r2ConfigFromEnv(): R2Config | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null;
  return { accountId: R2_ACCOUNT_ID, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, bucket: R2_BUCKET };
}

export interface R2Object { key: string; size: number }

/** Encode a key's path segments while preserving "/" as separators. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/** Extract objects from an S3 ListObjectsV2 XML response (regex is enough for
 *  the flat <Contents><Key/><Size/></Contents> shape). */
export function parseListXml(xml: string): R2Object[] {
  const out: R2Object[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1] ?? "";
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(block)?.[1];
    if (key) out.push({ key, size: Number(size ?? 0) });
  }
  return out;
}

export class R2Client {
  private aws: AwsClient;
  private base: string;

  constructor(cfg: R2Config) {
    this.aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: "auto", service: "s3" });
    this.base = `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`;
  }

  /** True if the object exists. Used to skip a day already archived (idempotent,
   *  so the job never tries to overwrite a locked object). */
  async exists(key: string): Promise<boolean> {
    const res = await this.aws.fetch(`${this.base}/${encodeKey(key)}`, { method: "HEAD" });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw new Error(`R2 HEAD ${key} -> HTTP ${res.status}`);
  }

  async put(key: string, body: string | Uint8Array, contentType = "application/x-ndjson"): Promise<void> {
    const res = await this.aws.fetch(`${this.base}/${encodeKey(key)}`, {
      method: "PUT",
      body,
      headers: { "content-type": contentType },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`R2 PUT ${key} -> HTTP ${res.status} ${t}`.slice(0, 300));
    }
  }

  async list(prefix = ""): Promise<R2Object[]> {
    const res = await this.aws.fetch(`${this.base}?list-type=2&prefix=${encodeURIComponent(prefix)}`, { method: "GET" });
    if (!res.ok) throw new Error(`R2 LIST (${prefix}) -> HTTP ${res.status}`);
    return parseListXml(await res.text());
  }

  /** Attempt a delete. Returns the HTTP status; a bucket lock makes this fail
   *  (used to prove immutability, never to remove real archive data). */
  async tryDelete(key: string): Promise<number> {
    const res = await this.aws.fetch(`${this.base}/${encodeKey(key)}`, { method: "DELETE" });
    return res.status;
  }
}
