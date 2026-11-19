import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applications, documents } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { applicationForm, plantJob, seedCompany } from "./test-helpers";

/**
 * Two promises the application form makes: "Who can see it" points to a privacy page that really names the kinds of
 * service providers and what each does, and nobody else; and a form shown again after a failed check keeps what it says
 * it keeps. A resume the browser already uploaded stays attached (its grant goes back into the form); a file sent inside
 * the form cannot be put back by any browser, so the page asks for it again instead of claiming it is still there.
 */
describe("the application form: who can see it, and what a re-shown form keeps", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let slug = "";
  let roleId = "";
  const decodeEntities = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const dana = (fields: Record<string, string | null>, resume: string | null = null) => applicationForm({ firstName: "Dana", lastName: "Kept", email: "dana.kept@example.com", ...fields }, resume);
  const apply = (fd: FormData) => app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": "198.51.100.23" } });
  /** The browser's direct upload: intent, then the PUT to the granted address; the form then carries only the grant. */
  const directUpload = async (name: string, text: string) => {
    const bytes = new TextEncoder().encode(text);
    const ir = await app.request(`/careers/${slug}/jobs/${roleId}/upload-intent`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.23" }, body: JSON.stringify({ filename: name, size: bytes.byteLength, type: "text/plain" }) });
    expect(ir.status).toBe(200);
    const j = (await ir.json()) as { url: string; method: string; headers: Record<string, string>; grant: string };
    expect((await app.request(new URL(j.url).pathname, { method: j.method, headers: j.headers, body: bytes.slice().buffer as ArrayBuffer })).status).toBe(200);
    return j.grant;
  };
  const grantIn = (html: string) => html.match(/name="uploadGrant" value="([^"]*)"/)?.[1] ?? null;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000" } });
    app = createApp(container);
    const company = await seedCompany(app, { email: "owner@kept.test", name: "Kept Dental" });
    slug = company.slug;
    roleId = await plantJob(container, { companyId: company.companyId, title: "Dental Hygienist" });
  });
  afterAll(async () => {
    await container.close();
  });

  it("the form names who can see an application, and the privacy page it points to lists each kind of provider and its job, and nobody who no longer sees anything", async () => {
    const page = decodeEntities(await (await app.request(`/careers/${slug}/jobs/${roleId}/apply`)).text());
    const who = page.match(/<strong>Who can see it:<\/strong>([^<]*)<\/p>/)![1];
    expect(who).not.toContain("listed in the privacy notice");
    for (const kind of ["the hiring team at Kept Dental", "hosting", "file storage", "email delivery", "AI service"]) expect(who).toContain(kind);
    expect(who).not.toMatch(/recruiter/i);
    const privacy = decodeEntities(await (await app.request("/privacy")).text());
    expect(privacy).toContain("Who can see your information");
    for (const line of ["Hosting: runs this website and the work behind it.", "Database and file storage: keeps your application and your resume, privately.", "Email delivery: sends the emails about your application.", "An AI service: reads applications and screening answers to help organize and summarize them for the hiring team. It does not decide anything."]) expect(privacy).toContain(`<li>${line}</li>`);
    expect(privacy).toContain("We do not sell your information.");
    // what the product no longer has is not named: a recruiter, calendars, texts, a talent pool, a reply keyword
    for (const gone of [/recruiter/i, /Calendars/, /Text messages|STOP/, /future roles|no thanks/i, /HUMAN/, /receives your replies/]) expect(privacy).not.toMatch(gone);
    // the choices that remain: a request about their information, a person instead of the AI assistant, their link again
    const choices = privacy.slice(privacy.indexOf("<h2>Your choices</h2>"), privacy.indexOf("<h2>Automated tools</h2>"));
    expect(choices.match(/<li>/g)).toHaveLength(3);
    expect(choices).toContain('<a href="/c/privacy-request">use the request form</a>');
    expect(choices).toContain("Talk to a person instead of the AI assistant: press \"I'd rather talk to a person\" on the conversation's page, or email the contact on the job page.");
    expect(choices).toContain('<a href="/c/link-request">We can email it to you again</a>');
  });

  it("a resume already uploaded stays attached when the form comes back, and the second send uses it", async () => {
    const grant = await directUpload("dana-resume.txt", "Dana Kept\nRegistered dental hygienist, 6 years.\n");
    const again = await apply(dana({ uploadGrant: grant, acknowledged: null }));
    expect(again.status).toBe(400);
    const html = decodeEntities(await again.text());
    expect(grantIn(html)).toBe(grant);
    expect(html).toContain("Your resume dana-resume.txt is still attached.");
    expect(html).toContain("Everything you entered is still here.");
    // the file field no longer asks for a file it already has
    expect(html.match(/<input id="resume"[^>]*>/)![0]).not.toContain("required");
    const sent = await apply(dana({ uploadGrant: grant }));
    expect(sent.status).toBe(302);
    await container.drain();
    const [app0] = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    const [doc] = await container.db.select().from(documents).where(eq(documents.id, app0.resumeDocumentId!));
    expect(doc).toMatchObject({ filename: "dana-resume.txt", uploadedVia: "direct" });
  });

  it("a file sent inside the form, or a grant that no longer opens, is asked for again, never claimed as kept", async () => {
    const withFile = await apply(dana({ email: "lee.file@example.com", acknowledged: null }, "Lee File, dental hygienist"));
    expect(withFile.status).toBe(400);
    const a = decodeEntities(await withFile.text());
    expect(a).toContain("Everything you typed is still here, but please attach your resume again.");
    expect(a).not.toContain("Everything you entered is still here.");
    expect(a).toContain("Your resume is not attached any more. Please choose the file again.");
    expect(grantIn(a)).toBe("");
    const forged = await apply(dana({ email: "sam.forged@example.com", uploadGrant: "not-a-real-grant", acknowledged: null }));
    expect(forged.status).toBe(400);
    const b = decodeEntities(await forged.text());
    expect(b).toContain("please attach your resume again");
    expect(grantIn(b)).toBe("");
    // with no resume sent at all, nothing was lost, and the page says so
    const plain = await apply(dana({ email: "kim.plain@example.com", acknowledged: null }));
    expect(decodeEntities(await plain.text())).toContain("Everything you entered is still here.");
  });
});
