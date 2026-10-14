import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { IntakeSessionView, JobPreview } from "@ros/contracts";
import { entitlements } from "@ros/core";
import { companies } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { jobUrls } from "./services/job-urls";
import { signInAs } from "./test-helpers";

/**
 * The authenticated preview of the job page (plan D1): the page and the apply form candidates get, drawn by the same
 * components, for a saved version or the job builder's draft. A browser tab gets the page at the plan's address while
 * the app's own requests keep getting the data; it needs role.read and compensation.read, is marked "not public yet",
 * is kept out of search engines, carries no structured data, no share tags and no form that sends anything, and is
 * served from the app's address, never under /careers.
 */
describe("the job-page preview (plan D1)", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let manager = "";
  let interviewer = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  let draftId = "";
  const MESSAGE = "I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  /** What a browser tab sends when the person opens the preview link. */
  const tab = (cookie: string | null, path: string) => app.request(path, { headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", ...(cookie ? { cookie } : {}) } });
  const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const setSettings = async (change: (s: Record<string, unknown>) => void) => {
    const [co] = await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    const next = { ...co.settings } as Record<string, unknown>;
    change(next);
    await container.db.update(companies).set({ settings: next as typeof co.settings }).where(eq(companies.id, companyId));
  };
  /** Everything a preview must never carry, and the note it must. */
  const expectPreview = (r: Response, html: string) => {
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"/>');
    expect(html).toContain('<div class="preview-note" role="note">');
    expect(html).not.toContain("application/ld+json");
    expect(html).not.toContain("og:");
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toMatch(/<form[\s>]/);
    expect(html).not.toMatch(/href="\/careers\//);
    // the candidate pages' strict policy, with this request's nonce on the stylesheet
    const csp = r.headers.get("content-security-policy-report-only") ?? "";
    expect(csp).toContain("img-src 'self' data:");
    expect(html).toContain(`<style nonce="${csp.match(/'nonce-([^']+)'/)![1]}">`);
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@preview.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Preview Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    slug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
    manager = await signInAs(container, app, { companyId, role: "hiring_manager", name: "Hank Manager" });
    interviewer = await signInAs(container, app, { companyId, role: "interviewer", name: "Ivy Interviewer" });
    // a draft beside the conversation, and a role waiting for its first approval
    draftId = ((await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: MESSAGE })).json()) as { session: IntakeSessionView }).session.id;
    expect((await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/draft`)).status).toBe(200);
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: MESSAGE })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
  });
  afterAll(async () => {
    await container.close();
  });

  it("at the plan's address a browser tab gets the page and the app's own request the data; the page is always at /preview/page too", async () => {
    const r = await tab(owner, `/api/v1/roles/${roleId}/preview?version=1`);
    expect(r.status).toBe(200);
    const html = decode(await r.text());
    expectPreview(r, html);
    expect(html).toContain("<strong>Not public yet.</strong> Preview of version 1: not public.");
    // what the page could still show about the company (plan D10)
    // the staff glossary (14 October 2026): Setup is called Settings on screen
    expect(html).toContain("<li>There is no text about your company yet. Draft and approve it in Settings, and it shows on every job page.</li>");
    expect(html).toContain("<li>There is no logo yet. Upload one in Settings; until then the page shows your initials.</li>");
    expect(html).toContain("<title>Preview: ");
    expect(html).toContain("Careers at Preview Dental");
    expect(html).toMatch(/<a class="btn go head-apply" href="\/api\/v1\/roles\/[^"]+\/preview\?version=1&view=apply"><span class="go-fill" aria-hidden="true"><\/span><span class="go-icon"><svg class="icon"[^>]*>.*?<\/svg><\/span><span class="go-text">Apply now<\/span><\/a>/);
    // the sliding fill is CSS only: the preview's job page carries no script
    expect(html).not.toContain("<script");
    expect(html).toContain("<h2>What we're looking for</h2>");
    expect(html).toContain('<span class="sr-only">Pay: </span><span class="fact-text">$45–$55 an hour</span>');
    // the data, as the job builder and the role page read it
    const data = await json(owner, "GET", `/api/v1/roles/${roleId}/preview?version=1`);
    expect(data.headers.get("content-type")).toContain("application/json");
    expect(((await data.json()) as JobPreview).source).toMatchObject({ kind: "version", roleId, version: 1 });
    // the same page at /preview/page, whatever the request asks for
    const page = await app.request(`/api/v1/roles/${roleId}/preview/page`, { headers: { cookie: owner } });
    expect(page.status).toBe(200);
    expectPreview(page, decode(await page.text()));
  });

  it("the apply form in a preview sends nothing: no form element, every field disabled, no script, no sealed opening time", async () => {
    const r = await tab(owner, `/api/v1/roles/${roleId}/preview?version=1&view=apply`);
    expect(r.status).toBe(200);
    const html = decode(await r.text());
    expectPreview(r, html);
    expect(html).toContain('<div class="form-preview"><fieldset disabled="">');
    expect(html).toContain('<button class="btn" type="button" disabled="">Send my application</button>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain('name="formOpened"');
    expect(html).not.toContain('name="uploadGrant"');
    expect(html).toContain("<summary>No resume? Answer four short questions instead</summary>");
    expect(html).toMatch(/<p class="back"><a href="\/api\/v1\/roles\/[^"]+\/preview\?version=1">/);
  });

  it("needs the role and its pay: an interviewer, someone signed out, an unknown version or role each get a plain page", async () => {
    const asInterviewer = await tab(interviewer, `/api/v1/roles/${roleId}/preview`);
    expect(asInterviewer.status).toBe(403);
    expect(decode(await asInterviewer.text())).toContain("Seeing the job page before it is public needs access to the role and its pay.");
    expect((await json(interviewer, "GET", `/api/v1/roles/${roleId}/preview/page`)).status).toBe(403);
    const signedOut = await tab(null, `/api/v1/roles/${roleId}/preview`);
    expect(signedOut.status).toBe(401);
    expect(await signedOut.text()).toContain("Sign in to see this preview, then open it again.");
    expect((await tab(owner, `/api/v1/roles/${roleId}/preview?version=99`)).status).toBe(404);
    expect((await tab(owner, "/api/v1/roles/not-a-role/preview")).status).toBe(404);
    // a hiring manager may see the role and its pay
    expect((await tab(manager, `/api/v1/roles/${roleId}/preview`)).status).toBe(200);
  });

  it("the job builder's draft has the same page before the role exists, only for the person drafting it", async () => {
    const r = await tab(owner, `/api/v1/intake/sessions/${draftId}/preview`);
    expect(r.status).toBe(200);
    const html = decode(await r.text());
    expectPreview(r, html);
    expect(html).toContain("Preview of your draft: this is what candidates would see. Nothing is public until the role is approved.");
    expect(html).toMatch(/href="\/api\/v1\/intake\/sessions\/[^"]+\/preview\?view=apply"/);
    const form = await tab(owner, `/api/v1/intake/sessions/${draftId}/preview?view=apply`);
    expect(decode(await form.text())).toContain("<fieldset disabled=\"\">");
    // the data stays at the same address for the builder
    expect(((await (await json(owner, "GET", `/api/v1/intake/sessions/${draftId}/preview`)).json()) as JobPreview).source).toEqual({ kind: "draft", sessionId: draftId });
    // someone else's draft is theirs
    const other = await tab(manager, `/api/v1/intake/sessions/${draftId}/preview/page`);
    expect(other.status).toBe(403);
    expect(await other.text()).toContain("This preview cannot be shown");
  });

  it("works before the company is public (and says so), with the logo from the team's own address; the public page stays a 404", async () => {
    await setSettings((s) => { s.verifiedAtSaved = s.verifiedAt; delete s.verifiedAt; });
    try {
      const file = "0192f0c4-1c2d-7a3b-8c4d-5e6f708192a3.png";
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
      await container.integrations.storage.put(`logos/${companyId}/${file}`, bytes, "image/png");
      await setSettings((s) => { s.logo = { file, key: `logos/${companyId}/${file}`, contentType: "image/png", sizeBytes: bytes.length, width: 100, height: 40, uploadedAt: new Date().toISOString(), uploadedBy: { kind: "user", id: "u" } }; });
      const r = await tab(owner, `/api/v1/roles/${roleId}/preview`);
      const html = decode(await r.text());
      expect(html).toContain("Your company is waiting for its one-time check by ITS. Job pages go public after that.");
      expect(html).toContain(`<img src="/api/v1/companies/current/logo?v=${file}" alt=""`);
      expect(html).not.toContain("There is no logo yet.");
      // the builder's data names the same address, not the public one that answers only once the company is public
      expect(((await (await json(owner, "GET", `/api/v1/roles/${roleId}/preview`)).json()) as JobPreview).company.logoUrl).toBe(`/api/v1/companies/current/logo?v=${file}`);
      const logo = await app.request(`/api/v1/companies/current/logo?v=${file}`, { headers: { cookie: owner } });
      expect(logo.status).toBe(200);
      expect(logo.headers.get("content-type")).toBe("image/png");
      expect(logo.headers.get("cache-control")).toBe("private, max-age=300");
      expect((await app.request(`/api/v1/companies/current/logo?v=${file}`)).status).toBe(401);
      expect((await app.request(`/careers/${slug}/jobs/${roleId}`)).status).toBe(404);
      expect((await app.request(`/careers/${slug}/logo/${file}`)).status).toBe(404);
    } finally {
      await setSettings((s) => { s.verifiedAt = s.verifiedAtSaved; delete s.verifiedAtSaved; delete s.logo; });
    }
  });

  it("the live version of an open role says it is live and links to the public page", async () => {
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    const html = decode(await (await tab(owner, `/api/v1/roles/${roleId}/preview`)).text());
    expect(html).toContain("<strong>Preview.</strong> This is the live version of the job page.");
    expect(html).toContain(`<a href="${jobUrls(container.env, { slug, roleId }).job}">Open the public page</a>`);
    expect(html).toMatch(/<span class="fact-text">Posted /);
  });
});
