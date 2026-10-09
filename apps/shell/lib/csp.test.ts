import { describe, expect, it } from "vitest";
import { buildAppCsp, cspHeaderName, cspMode, makeNonce } from "./csp";

describe("application content-security policy", () => {
  it("uses a per-request nonce, strict-dynamic, no outside origin at all, and no unsafe-inline for scripts", () => {
    const nonce = makeNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]{20,}$/);
    expect(makeNonce()).not.toBe(nonce);
    const csp = buildAppCsp({ nonce, dev: false, reportPath: "/api/csp-report" });
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp.match(/script-src[^;]*/)![0]).not.toContain("unsafe-inline");
    // the fonts are served from this deployment (app/fonts.css, public/fonts): no font host learns who opened the app
    expect(csp).toContain("font-src 'self';");
    expect(csp).toContain(`style-src 'self' 'nonce-${nonce}';`);
    expect(csp).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(csp).toContain("frame-ancestors 'none'");
    // the résumé in the candidate panel is framed from this origin only (plan H5); no outside document is ever framed
    expect(csp).toContain("frame-src 'self';");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("report-uri /api/csp-report");
    expect(csp).toContain("upgrade-insecure-requests");
    // no analytics or tag-manager origin, ever
    expect(csp).not.toMatch(/posthog|googletagmanager|google-analytics|segment|hotjar/);
    expect(csp.match(/https?:\/\/[^\s;']+/g) ?? []).toEqual([]);
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
