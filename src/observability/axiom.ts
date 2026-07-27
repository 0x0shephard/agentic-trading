// Minimal Axiom query client (APL, tabular format).
//
// Reused by the login/site-health monitor (gateway logs) and, later, by the
// 5-year log-retention export (RMF 1c), which taps the same datasets. Read-only:
// this only issues APL queries, it never ingests.
//
// The token is a credential — it lives in the gitignored .env as AXIOM_API_TOKEN,
// never in a tracked file. A plain "read" Axiom token is not enough; the token
// must carry the Query capability on the dataset.
import { env } from "../config/env";

const APL_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";

/** One table from a tabular APL response: named fields + column-major values. */
export interface AxiomTable {
  fields: { name: string }[];
  columns: unknown[][];
}

export function axiomConfigured(): boolean {
  return Boolean(env.AXIOM_API_TOKEN && env.AXIOM_DATASET);
}

/** Turn a column-major table into row objects keyed by field name. */
export function tableRows(t: AxiomTable): Record<string, unknown>[] {
  const names = t.fields.map((f) => f.name);
  const cols = t.columns ?? [];
  const n = cols[0]?.length ?? 0;
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const row: Record<string, unknown> = {};
    names.forEach((nm, j) => { row[nm] = cols[j]?.[i]; });
    out.push(row);
  }
  return out;
}

/**
 * Run an APL query over [startIso, endIso] and return the first table's rows.
 * Throws on a non-2xx response (the caller decides whether that degrades a check
 * or fails it). Bounded by an abort timeout so a hung request can't stall a poll.
 */
export async function axiomQuery(
  apl: string, startIso: string, endIso: string, timeoutMs = 15_000,
): Promise<Record<string, unknown>[]> {
  if (!env.AXIOM_API_TOKEN) throw new Error("AXIOM_API_TOKEN not set");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(APL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.AXIOM_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apl, startTime: startIso, endTime: endIso }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Axiom query failed: HTTP ${res.status} ${body}`.slice(0, 300));
    }
    const json = (await res.json()) as { tables?: AxiomTable[] };
    const table = json.tables?.[0];
    return table ? tableRows(table) : [];
  } finally {
    clearTimeout(timer);
  }
}

/** The configured dataset name, for callers building APL query strings. */
export function axiomDataset(): string {
  return env.AXIOM_DATASET ?? "";
}
