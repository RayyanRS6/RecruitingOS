import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { normalizeCspReports } from "@ros/core";
import { applications, cspReports, screens } from "@ros/db";
import { safeJsonLd } from "./pages/layout";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { applicationForm, plantJob, seedCompany, signInAdmin, statusTokenFor, usePlan } from "./test-helpers";

/**
 * Candidate pages and the application carry a strict content-security policy with per-request nonces, no inline
 * handlers, the fewest external origins, report-only until reviewed.
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
  const baseEnv = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "csp test" }, body: body ? JSON.stringify(body) : undefined });
  const nonceOf = (csp: string) => csp.match(/script-src 'nonce-([^']+)'/)![1];

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: baseEnv });
    app = createApp(container);
    const company = await seedCompany(app, { email: "owner@csp.test", name: "CSP Dental" });
    ({ owner, slug: companySlug } = company);
    admin = await signInAdmin(app, container, "admin@its.test", "admin");
    await usePlan(container, company.companyId);
    roleId = await plantJob(container, { companyId: company.companyId, title: "Dental Hygienist" });
    // one person applies and is shortlisted, so every candidate page exists: the status page, and the AI interview
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: applicationForm({ firstName: "Ivy", lastName: "Chen", email: "ivy.chen@example.com", phone: "(949) 555-0100" }) });
    expect(r.status).toBe(302);
    statusToken = await statusTokenFor(container, { roleId, email: "ivy.chen@example.com" });
    await container.drain();
    const [appRow] = await container.db.select().from(applications).where(eq(applications.statusToken, statusToken));
    expect((await json(owner, "POST", `/api/v1/applications/${appRow.id}/actions`, { action: "shortlist" })).status).toBe(200);
    await container.drain();
    const [screen] = await container.db.select().from(screens).where(eq(screens.applicationId, appRow.id));
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
    const pages = [`/careers/${companySlug}`, `/careers/${companySlug}/jobs/${roleId}`, `/careers/${companySlug}/jobs/${roleId}/apply`, `/careers/${companySlug}/jobs/${roleId}/applied`, `/c/status/${statusToken}`, `/c/screen/${screenToken}`, "/c/link-request", "/privacy"];
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

  it("the job-page preview carries the same strict policy and nonce; the logo loads from our own address under a policy that runs nothing", async () => {
    const bytes = new Uint8Array(40);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(bytes.buffer).setUint32(16, 120);
    new DataView(bytes.buffer).setUint32(20, 60);
    const logoForm = new FormData();
    logoForm.set("file", new File([bytes.slice().buffer as ArrayBuffer], "logo.png", { type: "image/png" }));
    expect((await app.request("/api/v1/companies/current/logo", { method: "POST", headers: { cookie: owner }, body: logoForm })).status).toBe(201);
    for (const path of [`/api/v1/roles/${roleId}/preview/page`, `/api/v1/roles/${roleId}/preview/page?view=apply`, `/careers/${companySlug}`, `/careers/${companySlug}/jobs/${roleId}`]) {
      const r = await app.request(path, { headers: { cookie: owner } });
      expect(r.status, path).toBe(200);
      const csp = r.headers.get("content-security-policy-report-only")!;
      expect(csp, path).toContain("img-src 'self' data:");
      expect(csp, path).not.toMatch(/https?:\/\//);
      const html = await r.text();
      expectEveryTagNonced(html, nonceOf(csp), path);
      expect(html, path).not.toMatch(/ on(submit|click|change|load|error)=/);
      // every image on the page, the logo included, comes from our own address
      const images = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
      expect(images.length, path).toBe(path.includes("view=apply") ? 0 : 1);
      for (const src of images) expect(src, path).toMatch(/^\/(careers|api\/v1\/companies\/current)\/[^/]/);
    }
    // the job's own data stays data, without the candidate policy
    expect((await app.request(`/api/v1/roles/${roleId}`, { headers: { cookie: owner } })).headers.get("content-security-policy-report-only")).toBeNull();
    // the image itself can only ever be an image
    const src = (await (await app.request(`/careers/${companySlug}`)).text()).match(/<img\b[^>]*\bsrc="([^"]+)"/)![1];
    const logo = await app.request(src);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect(logo.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(logo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(logo.headers.get("content-security-policy-report-only")).toBeNull();
  });

  it("the API's own pages are drawn with the nonce their policy names, though two mounts match them ('/x' and '/x/*')", async () => {
    for (const path of ["/api/v1/auth/invite?token=not-a-real-invitation", "/api/v1/auth/consume?token=not-a-real-link"]) {
      const r = await app.request(path);
      expect(r.status, path).toBe(200);
      const csp = r.headers.get("content-security-policy-report-only")!;
      expect(csp, path).toBeTruthy();
      const html = await r.text();
      expect(html, path).toContain(`<style nonce="${nonceOf(csp)}">`);
      expectEveryTagNonced(html, nonceOf(csp), path);
    }
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
    const longPath = `/${"x".repeat(5000)}`;
    expect((await app.request("/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report" }, body: JSON.stringify({ "csp-report": { "document-uri": `http://localhost:3000${longPath}`, "violated-directive": "img-src", "blocked-uri": `https://${"h".repeat(600)}.example`, "line-number": 12.5 } }) })).status).toBe(204);
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
