import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { IntakeSessionView, PublishResult } from "@ros/contracts";
import { entitlements } from "@ros/core";
import { roles } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { jobUrls } from "./services/job-urls";
import { signInAs } from "./test-helpers";

/**
 * The team's preview of a job page: the page and the apply form candidates get, drawn by the same components, for a
 * job's version or the job builder's written draft. It says whether candidates see the page now, is kept out of search
 * engines, carries no structured data, no share tags and no form that sends anything, is served from the app's address
 * (never under /careers), and answers every refusal with a plain page.
 */
describe("the job-page preview", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let member = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  let draftId = "";
  const WORDS = "I need a registered dental hygienist in Tustin, CA, on site, full time, Monday to Friday, $45 to $55 an hour. Must-haves: active CA RDH license, periodontal charting.";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const page = (cookie: string | null, path: string) => app.request(path, { headers: cookie ? { cookie } : {} });
  const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
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
  const writtenDraft = async (): Promise<string> => {
    const id = ((await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: WORDS })).json()) as { session: IntakeSessionView }).session.id;
    expect((await json(owner, "POST", `/api/v1/intake/sessions/${id}/draft`)).status).toBe(200);
    return id;
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test", CSP_MODE: "report-only" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@preview.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Preview Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    companyId = co.id;
    slug = ((await (await json(owner, "GET", "/api/v1/companies/current")).json()) as { slug: string }).slug;
    await entitlements.applyPlan(container.db, companyId, "ultra");
    member = await signInAs(container, app, { companyId, role: "hiring_manager", name: "Hank Member" });
    // a written draft in the job builder, and a published job
    draftId = await writtenDraft();
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${await writtenDraft()}/publish`)).json()) as PublishResult).roleId;
  });
  afterAll(async () => {
    await container.close();
  });

  it("shows an open job's page as candidates see it now, with a link to the public page", async () => {
    const r = await page(owner, `/api/v1/roles/${roleId}/preview/page`);
    expect(r.status).toBe(200);
    const html = decode(await r.text());
    expectPreview(r, html);
    expect(html).toContain("This is the job page as candidates see it now.");
    expect(html).toContain(`<a href="${jobUrls(container.env, { slug, roleId }).job}">Open the public page</a>`);
    expect(html).toContain("<title>Preview: ");
    // what the page could still show about the company
    expect(html).toContain("<li>There is no text about your company yet. Write it in Settings, and it shows on every job page.</li>");
    expect(html).toContain("<li>There is no logo yet. Upload one in Settings; until then the page shows your initials.</li>");
    // its own links stay on the preview
    expect(html).toMatch(/href="\/api\/v1\/roles\/[^"]+\/preview\/page\?version=1&view=apply"/);
    // anyone on the team sees it, pay and all
    expect((await page(member, `/api/v1/roles/${roleId}/preview/page`)).status).toBe(200);
  });

  it("shows the apply form in a preview with nothing to send: no form element, every field disabled, no script", async () => {
    const r = await page(owner, `/api/v1/roles/${roleId}/preview/page?version=1&view=apply`);
    expect(r.status).toBe(200);
    const html = decode(await r.text());
    expectPreview(r, html);
    expect(html).toContain("<fieldset disabled=\"\">");
    expect(html).toContain("Send my application");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('name="formOpened"');
    expect(html).not.toContain('name="uploadGrant"');
    expect(html).toMatch(/<a href="\/api\/v1\/roles\/[^"]+\/preview\/page\?version=1">/);
  });

  /**
   * A closed job's page is not gone: it stays up and says the position is closed (public-job-surfaces.test.ts). The
   * preview used to tell the team the page was "no longer public" under the words "Not public yet." (the code check of
   * 25 November 2026); it now says where the page really stands and links to it.
   */
  it("says where a job's page stands: not published yet, and closed with its page still up", async () => {
    await container.db.update(roles).set({ status: "draft", currentPacketVersion: null }).where(eq(roles.id, roleId));
    try {
      expect(decode(await (await page(owner, `/api/v1/roles/${roleId}/preview/page`)).text())).toContain("<strong>Not public yet.</strong> Preview: this job is not published yet.");
      await container.db.update(roles).set({ status: "closed", currentPacketVersion: 1 }).where(eq(roles.id, roleId));
      const closed = decode(await (await page(owner, `/api/v1/roles/${roleId}/preview/page`)).text());
      expect(closed).toContain("<strong>Closed.</strong> This is a preview. The job's own page says the position is closed and takes no applications.");
      expect(closed).not.toContain("no longer public");
      expect(closed).not.toContain("Not public yet.");
      expect(closed).toContain(">Open the public page</a>");
    } finally {
      await container.db.update(roles).set({ status: "open", currentPacketVersion: 1 }).where(eq(roles.id, roleId));
    }
  });

  it("answers someone signed out, an unknown job or version with a plain page, and the old addresses with nothing", async () => {
    const noSuchJob = "00000000-0000-4000-8000-000000000000";
    const missing = await page(owner, `/api/v1/roles/${noSuchJob}/preview/page`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("text/html");
    const html = decode(await missing.text());
    expect(html.slice(html.indexOf("<main>"))).toMatch(/^<main><h1>This preview cannot be shown<\/h1>/);
    expect(html).toContain("Job not found.");
    const signedOut = await page(null, `/api/v1/roles/${roleId}/preview/page`);
    expect(signedOut.status).toBe(401);
    expect(await signedOut.text()).toContain("Sign in to see this preview, then open it again.");
    expect((await page(owner, `/api/v1/roles/${roleId}/preview/page?version=99`)).status).toBe(404);
    expect((await page(owner, "/api/v1/roles/not-a-job/preview/page")).status).toBe(404);
    // one rendering of the candidate's view: the data answers are gone
    for (const path of [`/api/v1/roles/${roleId}/preview`, `/api/v1/intake/sessions/${draftId}/preview`]) expect((await json(owner, "GET", path)).status, path).toBe(404);
  });

  it("shows the job builder's written draft before the job exists, only to the person drafting it", async () => {
    const r = await page(owner, `/api/v1/intake/sessions/${draftId}/preview/page`);
    expect(r.status).toBe(200);
    const html = decode(await r.text());
    expectPreview(r, html);
    expect(html).toContain("<strong>Not public yet.</strong> Preview of your draft: this is what candidates will see. Nothing is public until you publish the job.");
    expect(html).toMatch(/href="\/api\/v1\/intake\/sessions\/[^"]+\/preview\/page\?view=apply"/);
    const form = await page(owner, `/api/v1/intake/sessions/${draftId}/preview/page?view=apply`);
    expect(decode(await form.text())).toContain("<fieldset disabled=\"\">");
    // someone else's draft is theirs
    const other = await page(member, `/api/v1/intake/sessions/${draftId}/preview/page`);
    expect(other.status).toBe(403);
    expect(await other.text()).toContain("This preview cannot be shown");
    // nothing to preview before the job is written
    const unwritten = ((await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "Office manager in Irvine, CA" })).json()) as { session: IntakeSessionView }).session.id;
    const early = await page(owner, `/api/v1/intake/sessions/${unwritten}/preview/page`);
    expect(early.status).toBe(409);
    expect(await early.text()).toContain("Write the job first; then you can preview it.");
  });
});
