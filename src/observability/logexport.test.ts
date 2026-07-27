import { describe, it, expect } from "vitest";
import {
  dayBounds, previousUtcDay, toNdjson, runExport,
  type LogSource, type ExportSink,
} from "./logexport";
import { parseListXml } from "./r2";

describe("dayBounds", () => {
  it("gives an exclusive [00:00, next 00:00) UTC window", () => {
    const b = dayBounds("2026-07-25");
    expect(b.startIso).toBe("2026-07-25T00:00:00.000Z");
    expect(b.endIso).toBe("2026-07-26T00:00:00.000Z");
    expect(b.endSec - b.startSec).toBe(86_400);
  });
  it("rejects a bad date", () => {
    expect(() => dayBounds("nope")).toThrow();
  });
});

describe("previousUtcDay", () => {
  it("returns the calendar day before", () => {
    expect(previousUtcDay(new Date("2026-07-27T04:00:00Z"))).toBe("2026-07-26");
    expect(previousUtcDay(new Date("2026-03-01T00:30:00Z"))).toBe("2026-02-28");
  });
});

describe("toNdjson", () => {
  it("emits one JSON object per line with a trailing newline", () => {
    expect(toNdjson([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
  });
  it("is empty for no rows", () => {
    expect(toNdjson([])).toBe("");
  });
  it("serializes bigints as strings (chain data would otherwise throw)", () => {
    expect(toNdjson([{ blockNumber: 123n }])).toBe('{"blockNumber":"123"}\n');
  });
});

describe("parseListXml", () => {
  it("extracts keys and sizes from a ListObjectsV2 response", () => {
    const xml = `<?xml version="1.0"?><ListBucketResult>
      <Contents><Key>gateway/2026-07-25.ndjson</Key><Size>2048</Size></Contents>
      <Contents><Key>auth/2026-07-25.ndjson</Key><Size>512</Size></Contents>
    </ListBucketResult>`;
    expect(parseListXml(xml)).toEqual([
      { key: "gateway/2026-07-25.ndjson", size: 2048 },
      { key: "auth/2026-07-25.ndjson", size: 512 },
    ]);
  });
  it("returns [] for an empty bucket", () => {
    expect(parseListXml("<ListBucketResult></ListBucketResult>")).toEqual([]);
  });
});

// ── Orchestration with fake sources + sink ──────────────────────────────────

function fakeSink(existing: Set<string> = new Set()): { sink: ExportSink; writes: Map<string, string> } {
  const writes = new Map<string, string>();
  const sink: ExportSink = {
    kind: "dryrun",
    exists: async (k) => existing.has(k),
    write: async (k, b) => { writes.set(k, b); },
  };
  return { sink, writes };
}
const src = (name: string, rows: Record<string, unknown>[], available = true): LogSource =>
  ({ name, available, fetch: async () => rows });

describe("runExport", () => {
  it("writes one object per non-empty source plus a manifest", async () => {
    const { sink, writes } = fakeSink();
    const outcomes = await runExport("2026-07-25", [src("gateway", [{ status: 200 }, { status: 404 }]), src("auth", [{ id: "x" }])], sink);
    expect(outcomes.find((o) => o.source === "gateway")).toMatchObject({ status: "written", rows: 2 });
    expect(outcomes.find((o) => o.source === "auth")).toMatchObject({ status: "written", rows: 1 });
    expect(writes.has("gateway/2026-07-25.ndjson")).toBe(true);
    expect(writes.has("_manifest/2026-07-25.json")).toBe(true);
  });

  it("marks an empty source and writes nothing for it", async () => {
    const { sink, writes } = fakeSink();
    const outcomes = await runExport("2026-07-25", [src("admin", [])], sink);
    expect(outcomes[0]).toMatchObject({ source: "admin", status: "empty", rows: 0 });
    expect(writes.has("admin/2026-07-25.ndjson")).toBe(false);
    expect(writes.has("_manifest/2026-07-25.json")).toBe(true); // manifest still proves the run
  });

  it("skips an object that already exists (never overwrites a locked object)", async () => {
    const { sink, writes } = fakeSink(new Set(["gateway/2026-07-25.ndjson"]));
    const outcomes = await runExport("2026-07-25", [src("gateway", [{ status: 200 }])], sink);
    expect(outcomes[0]).toMatchObject({ status: "skipped-exists" });
    expect(writes.has("gateway/2026-07-25.ndjson")).toBe(false);
  });

  it("reports an unavailable source without failing the run", async () => {
    const { sink } = fakeSink();
    const outcomes = await runExport("2026-07-25", [src("auth", [], false), src("gateway", [{ x: 1 }])], sink);
    expect(outcomes.find((o) => o.source === "auth")).toMatchObject({ status: "unavailable" });
    expect(outcomes.find((o) => o.source === "gateway")).toMatchObject({ status: "written" });
  });

  it("captures a source error without aborting other sources", async () => {
    const { sink } = fakeSink();
    const boom: LogSource = { name: "gateway", available: true, fetch: async () => { throw new Error("axiom 500"); } };
    const outcomes = await runExport("2026-07-25", [boom, src("auth", [{ x: 1 }])], sink);
    expect(outcomes.find((o) => o.source === "gateway")).toMatchObject({ status: "error", detail: "axiom 500" });
    expect(outcomes.find((o) => o.source === "auth")).toMatchObject({ status: "written" });
  });
});
