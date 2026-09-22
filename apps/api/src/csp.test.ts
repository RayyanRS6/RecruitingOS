import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { entitlements, normalizeCspReports } from "@ros/core";
import { applications, cspReports, screens } from "@ros/db";
import { safeJsonLd } from "./pages/layout";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAdmin } from "./test-helpers";

/**
 * Founder instruction of 21 September 2026, item 6: candidate pages and the application carry a strict content-security
 * policy with per-request nonces, no inline handlers, the fewest external origins, report-only until reviewed.
 */
describe("content-security policy on candidate pages", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let admin = "";
  let companySlug = "";
  let roleId = "";
  let statusToken = "";
  let screenToken = "";
  let applicationId = "";
  const baseEnv = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" };
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "csp test" }, body: body ? JSON.stringify(body) : undefined });
  const nonceOf = (csp: string) => csp.match(/script-src 'nonce-([^']+)'/)![1];

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: baseEnv });
    app = createApp(container);
    owner = await signIn("owner@csp.test");
    admin = await signInAdmin(app, container, "admin@its.test", "admin");
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "CSP Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companySlug = co.slug;
    await entitlements.applyPlan(container.db, co.id, "growth");
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's growth. Ceiling $58. I decide. Must-haves: RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" });
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    const fd = new FormData();
    fd.set("firstName", "Ivy"); fd.set("lastName", "Chen"); fd.set("email", "ivy.chen@example.com"); fd.set("phone", "(949) 555-0100"); fd.set("smsConsent", "no"); fd.set("locationText", "Tustin, CA");
    fd.set("resume", new File(["Ivy Chen, RDH"], "ivy.txt", { type: "text/plain" }));
    for (const rule of role.currentPacket.packet.requirements.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    statusToken = r.headers.get("location")!.split("/c/status/")[1].split("?")[0];
    await container.drain();
    const [appRow] = await container.db.select().from(applications).where(eq(applications.statusToken, statusToken));
    applicationId = appRow.id;
    await json(owner, "POST", `/api/v1/applications/${applicationId}/actions`, { action: "invite_screen", channel: "web" });
    await container.drain();
    const [screen] = await container.db.select().from(screens).where(eq(screens.applicationId, applicationId));
    screenToken = screen?.token ?? "";
  });

  /** Every style and script element on a candidate page carries this request's nonce; nothing inline is left unmarked. */
  function expectEveryTagNonced(html: string, nonce: string, path: string) {
    for (const m of html.matchAll(/<(style|script)\b([^>]*)>/g)) expect(m[2], `${path}: <${m[1]}${m[2]}>`).toContain(`nonce="${nonce}"`);
  }
  afterAll(async () => {
    await container.close();
  });

  it("every candidate page carries the strict policy in report-only mode by default, with a fresh nonce on the style and the structured data", async () => {
    expect(screenToken).toBeTruthy();
    const pages = [`/careers/${companySlug}`, `/careers/${companySlug}/jobs/${roleId}`, `/careers/${companySlug}/jobs/${roleId}/apply`, `/c/status/${statusToken}`, `/c/screen/${screenToken}`, "/privacy"];
    const nonces = new Set<string>();
    for (const path of pages) {
      const r = await app.request(path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("content-security-policy"), path).toBeNull();
      const csp = r.headers.get("content-security-policy-report-only")!;
      expect(csp, path).toBeTruthy();
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("report-uri /api/csp-report");
      expect(csp).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
      expect(csp.match(/script-src[^;]*/)![0]).not.toContain("unsafe-inline");
      expect(csp).not.toMatch(/https?:\/\//); // no external origin at all on candidate pages
      expect(csp).not.toMatch(/posthog|analytics|gtag|segment/);
      const nonce = nonceOf(csp);
      nonces.add(nonce);
      const html = await r.text();
      expect(html, path).toContain(`<style nonce="${nonce}">`);
      expectEveryTagNonced(html, nonce, path);
      expect(html, path).not.toMatch(/ on(submit|click|change|load|error)=/);
      if (path.endsWith(`/jobs/${roleId}`)) expect(html).toContain(`<script type="application/ld+json" nonce="${nonce}">`);
    }
    expect(nonces.size).toBe(pages.length); // one nonce per request, never reused
    // the API is not a document and carries no candidate policy
    expect((await app.request("/api/v1/auth/config")).headers.get("content-security-policy-report-only")).toBeNull();
  });

  it("CSP_MODE=enforce switches the header name and nothing else; the default anywhere else stays report-only", async () => {
    const enforcing = await createContainer({ memory: true, env: { ...baseEnv, CSP_MODE: "enforce" } });
    const app2 = createApp(enforcing);
    const r = await app2.request("/privacy");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("content-security-policy-report-only")).toBeNull();
    await enforcing.close();
    expect(container.env.CSP_MODE).toBe("report-only");
  });

  it("violation reports are accepted in both formats, de-duplicated, stripped of tokens and query strings, listed for review", async () => {
    const legacy = { "csp-report": { "document-uri": `http://localhost:3000/c/status/${statusToken}?request=abc`, "violated-directive": "script-src", "effective-directive": "script-src-elem", "blocked-uri": "https://evil.example/x.js?k=v", "source-file": `http://localhost:3000/c/status/${statusToken}`, "line-number": 12, disposition: "report" } };
    expect((await app.request("/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report", "user-agent": "TestBrowser/1.0" }, body: JSON.stringify(legacy) })).status).toBe(204);
    expect((await app.request("/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report" }, body: JSON.stringify(legacy) })).status).toBe(204);
    const modern = [{ type: "csp-violation", age: 10, url: "http://localhost:3000/roles", body: { documentURL: "http://localhost:3000/roles/123?x=1", violatedDirective: "style-src-elem", effectiveDirective: "style-src-elem", blockedURL: "inline", disposition: "report" } }];
    expect((await app.request("/api/csp-report", { method: "POST", headers: { "content-type": "application/reports+json" }, body: JSON.stringify(modern) })).status).toBe(204);
    expect((await app.request("/api/csp-report", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" })).status).toBe(204);
    const rows = await container.db.select().from(cspReports);
    expect(rows).toHaveLength(2);
    const candidate = rows.find((r) => r.surface === "candidate")!;
    expect(candidate.count).toBe(2);
    expect(candidate.documentPath).toBe("/c/status/[token]");
    expect(candidate.sourceFile).toBe("http://localhost:3000");
    expect(candidate.blockedOrigin).toBe("https://evil.example");
    expect(candidate.mode).toBe("report_only");
    expect(JSON.stringify(rows)).not.toContain(statusToken);
    expect(JSON.stringify(rows)).not.toContain("request=abc");
    const appRow = rows.find((r) => r.surface === "app")!;
    expect(appRow.documentPath).toBe("/roles/123");
    expect(appRow.blockedOrigin).toBe("inline");
    // administrators review; the review is recorded
    expect((await json(owner, "GET", "/api/v1/admin/csp-reports")).status).toBe(403);
    const list = (await (await json(admin, "GET", "/api/v1/admin/csp-reports")).json()) as { mode: string; reports: Array<{ id: string; reviewedAt: string | null }> };
    expect(list.mode).toBe("report-only");
    expect(list.reports).toHaveLength(2);
    expect((await json(admin, "POST", `/api/v1/admin/csp-reports/${candidate.id}/review`, { disposition: "expected: local test" })).status).toBe(200);
    const [reviewed] = await container.db.select().from(cspReports).where(eq(cspReports.id, candidate.id));
    expect(reviewed.reviewedAt).toBeTruthy();
    expect(reviewed.disposition).toBe("expected: local test");
  });

  it("structured data cannot close its own script element, whatever an owner types into a description", () => {
    const out = safeJsonLd({ "@type": "JobPosting", description: "Great role</script><script>alert(document.cookie)</script>", title: "A > B" });
    expect(out).not.toContain("</script");
    expect(out).not.toContain("<script");
    expect(out).toContain("\\u003c/script");
    expect(JSON.parse(out).description).toBe("Great role</script><script>alert(document.cookie)</script>"); // still exactly the text, once parsed
  });

  it("reports are bounded, reviews need a real id, and a recurrence keeps the reviewer's note while asking for another look", async () => {
    const longPath = "/" + "x".repeat(5000);
    expect((await app.request("/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report" }, body: JSON.stringify({ "csp-report": { "document-uri": `http://localhost:3000${longPath}`, "violated-directive": "img-src", "blocked-uri": "https://" + "h".repeat(600) + ".example", "line-number": 12.5 } }) })).status).toBe(204);
    const [long] = (await container.db.select().from(cspReports)).filter((r) => r.documentPath.startsWith("/xxx"));
    expect(long.documentPath.length).toBeLessThanOrEqual(300);
    expect((long.blockedOrigin ?? "").length).toBeLessThanOrEqual(200);
    expect(long.lineNumber).toBeNull();
    expect((await json(admin, "POST", "/api/v1/admin/csp-reports/not-a-uuid/review", { disposition: "whatever it is" })).status).toBe(404);
    const reviewed = (await container.db.select().from(cspReports)).find((r) => r.disposition === "expected: local test")!;
    expect(reviewed.reviewedAt).toBeTruthy();
    expect((await app.request("/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report" }, body: JSON.stringify({ "csp-report": { "document-uri": `http://localhost:3000/c/status/${statusToken}?request=abc`, "violated-directive": "script-src", "effective-directive": "script-src-elem", "blocked-uri": "https://evil.example/x.js?k=v", "source-file": `http://localhost:3000/c/status/${statusToken}`, "line-number": 12 } }) })).status).toBe(204);
    const [again] = await container.db.select().from(cspReports).where(eq(cspReports.id, reviewed.id));
    expect(again.count).toBe(reviewed.count + 1);
    expect(again.reviewedAt).toBeNull();
    expect(again.disposition).toBe("expected: local test");
  });

  it("the normalizer never keeps a query string, a token or a full source URL", () => {
    const out = normalizeCspReports({ "csp-report": { "document-uri": "https://recruiting.identifiedtalent.com/c/screen/AbCdEf0123456789abcdefghij?x=1", "violated-directive": "img-src", "blocked-uri": "data:image/png;base64,AAAA", "source-file": "https://recruiting.identifiedtalent.com/_next/static/chunks/app.js?v=1" } }, "UA");
    expect(out).toHaveLength(1);
    expect(out[0].documentPath).toBe("/c/screen/[token]");
    expect(out[0].blockedOrigin).toBe("data:");
    expect(out[0].sourceFile).toBe("https://recruiting.identifiedtalent.com");
    expect(normalizeCspReports({ nothing: true }, null)).toEqual([]);
  });
});
