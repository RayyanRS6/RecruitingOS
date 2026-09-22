import { describe, expect, it } from "vitest";
import { buildAppCsp, cspHeaderName, cspMode, makeNonce } from "./csp";

describe("application content-security policy", () => {
  it("uses a per-request nonce, strict-dynamic, only the font hosts, and no unsafe-inline for scripts", () => {
    const nonce = makeNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]{20,}$/);
    expect(makeNonce()).not.toBe(nonce);
    const csp = buildAppCsp({ nonce, dev: false, reportPath: "/api/csp-report" });
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp.match(/script-src[^;]*/)![0]).not.toContain("unsafe-inline");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("report-uri /api/csp-report");
    expect(csp).toContain("upgrade-insecure-requests");
    // no analytics or tag-manager origin, ever
    expect(csp).not.toMatch(/posthog|googletagmanager|google-analytics|segment|hotjar/);
    const origins = csp.match(/https?:\/\/[^\s;']+/g) ?? [];
    expect(new Set(origins)).toEqual(new Set(["https://fonts.gstatic.com", "https://fonts.googleapis.com"]));
  });
  it("development adds only what the dev server needs, and report-only is the default mode", () => {
    const dev = buildAppCsp({ nonce: "n", dev: true });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("ws: wss:");
    expect(dev).not.toContain("upgrade-insecure-requests");
    expect(cspMode(undefined)).toBe("report-only");
    expect(cspMode("anything")).toBe("report-only");
    expect(cspMode("enforce")).toBe("enforce");
    expect(cspHeaderName("report-only")).toBe("Content-Security-Policy-Report-Only");
    expect(cspHeaderName("enforce")).toBe("Content-Security-Policy");
  });
});
