import { describe, it, expect } from "vitest";
import {
  checkSiteHealth,
  type SiteHealthDeps, type SiteConfig, type GatewayWindow, type ProbeResult,
} from "./alerting/sitehealth";

const CFG: SiteConfig = {
  windowMin: 15, minSample: 50,
  err5xxWarnPct: 2, err5xxCritPct: 10, err5xxAbsFloor: 5,
  rlWarnPct: 40, rlCritPct: 70,
  authFailIpWarn: 10, authFailIpCrit: 30,
};

function deps(gw: GatewayWindow | null, probes: Record<string, ProbeResult> = {}, targets: { label: string; url: string }[] = []): SiteHealthDeps {
  return {
    gateway: async () => gw,
    probe: async (url) => probes[url] ?? { url, ok: true, status: 200, ms: 5 },
    uptimeTargets: targets,
  };
}
const emptyGw = (over: Partial<GatewayWindow> = {}): GatewayWindow => ({ total: 1000, err5xx: 0, rl: 0, authFailByIp: [], ...over });

describe("checkSiteHealth", () => {
  it("is quiet on a healthy window", async () => {
    const sig = await checkSiteHealth(deps(emptyGw({ rl: 100 })), CFG); // 10% 429, under 40%
    expect(sig).toHaveLength(0);
  });

  it("warns then criticals on 5xx rate", async () => {
    const warn = await checkSiteHealth(deps(emptyGw({ total: 1000, err5xx: 30 })), CFG); // 3%
    expect(warn[0]).toMatchObject({ key: "gw-error-rate", severity: "warning" });
    const crit = await checkSiteHealth(deps(emptyGw({ total: 1000, err5xx: 150 })), CFG); // 15%
    expect(crit[0]).toMatchObject({ key: "gw-error-rate", severity: "critical" });
  });

  it("fires 5xx on the absolute floor even at a low rate", async () => {
    // 6 errors in 5000 requests = 0.12%, under the warn %, but over the abs floor of 5
    const sig = await checkSiteHealth(deps(emptyGw({ total: 5000, err5xx: 6 })), CFG);
    expect(sig.map((s) => s.key)).toContain("gw-error-rate");
  });

  it("does not compute rates below the min sample", async () => {
    const sig = await checkSiteHealth(deps(emptyGw({ total: 10, err5xx: 5 })), CFG);
    expect(sig).toHaveLength(0);
  });

  it("warns when rate-limiting dominates traffic", async () => {
    const sig = await checkSiteHealth(deps(emptyGw({ total: 1000, rl: 450 })), CFG); // 45%
    const rl = sig.find((s) => s.key === "gw-429-rate");
    expect(rl).toMatchObject({ severity: "warning" });
    const crit = await checkSiteHealth(deps(emptyGw({ total: 1000, rl: 800 })), CFG); // 80%
    expect(crit.find((s) => s.key === "gw-429-rate")).toMatchObject({ severity: "critical" });
  });

  it("flags a single IP with repeated failed logins, each as its own condition", async () => {
    const gw = emptyGw({ authFailByIp: [{ ip: "1.2.3.4", fails: 12 }, { ip: "5.6.7.8", fails: 40 }, { ip: "9.9.9.9", fails: 3 }] });
    const sig = await checkSiteHealth(deps(gw), CFG);
    const keys = sig.map((s) => s.key);
    expect(keys).toContain("auth-fail-ip:1.2.3.4");   // 12 >= warn 10
    expect(keys).toContain("auth-fail-ip:5.6.7.8");   // 40 >= crit 30
    expect(keys).not.toContain("auth-fail-ip:9.9.9.9"); // 3 < warn
    expect(sig.find((s) => s.key === "auth-fail-ip:5.6.7.8")).toMatchObject({ severity: "critical" });
  });

  it("criticals when an uptime target is down (5xx or no response)", async () => {
    const targets = [{ label: "Website", url: "https://site" }, { label: "API gateway", url: "https://api" }];
    const probes = {
      "https://site": { url: "https://site", ok: false, status: 503, ms: 20 },
      "https://api": { url: "https://api", ok: true, status: 200, ms: 8 },
    };
    const sig = await checkSiteHealth(deps(emptyGw(), probes, targets), CFG);
    expect(sig.map((s) => s.key)).toContain("uptime-down:Website");
    expect(sig.map((s) => s.key)).not.toContain("uptime-down:API gateway");
    expect(sig.find((s) => s.key === "uptime-down:Website")).toMatchObject({ severity: "critical" });
  });

  it("degrades quietly when the gateway source is unavailable", async () => {
    const sig = await checkSiteHealth(deps(null), CFG); // Axiom down, no uptime targets
    expect(sig).toHaveLength(0);
  });

  it("still probes uptime when the gateway source is down", async () => {
    const targets = [{ label: "Website", url: "https://site" }];
    const probes = { "https://site": { url: "https://site", ok: false, status: null, ms: 8000 } };
    const sig = await checkSiteHealth(deps(null, probes, targets), CFG);
    expect(sig.map((s) => s.key)).toContain("uptime-down:Website");
  });
});
