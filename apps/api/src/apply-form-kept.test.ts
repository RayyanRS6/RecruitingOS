import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applications, documents } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * Two promises the apply form makes (docs/readiness/20 section D): "Who can see it" points to a privacy page that really
 * names the kinds of service providers and what each does; and a form shown again after a failed check keeps what it
 * says it keeps. A resume the browser already uploaded stays attached (its grant goes back into the form); a file sent
 * inside the form cannot be put back by any browser, so the page asks for it again instead of claiming it is still there.
 */
describe("the apply form: who can see it, and what a re-shown form keeps", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let slug = "";
  let roleId = "";
  let eligibilityKeys: string[] = [];
  const decodeEntities = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const form = (fields: Record<string, string | Blob | null>) => {
    const fd = new FormData();
    const base: Record<string, string> = { firstName: "Dana", lastName: "Kept", email: "dana.kept@example.com", locationText: "Irvine, CA", noticeVersionsShown: "ai_use@2026-09-01,privacy@2026-09-01", acknowledged: "yes" };
    for (const k of eligibilityKeys) base[`elig_${k}`] = "yes";
    for (const [k, v] of Object.entries({ ...base, ...fields })) if (v !== null) fd.set(k, v);
    return fd;
  };
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
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", SMS_ENABLED: "false" } });
    app = createApp(container);
    owner = await signIn("owner@kept.test");
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Kept Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { slug: string };
    slug = co.slug;
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's growth. Ceiling $58. I decide. Must-haves: RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    eligibilityKeys = role.currentPacket.packet.requirements.eligibility.map((r) => r.key);
  });
  afterAll(async () => {
    await container.close();
  });

  it("the form names who can see an application, and the privacy page it points to lists each kind of provider and its job", async () => {
    const page = decodeEntities(await (await app.request(`/careers/${slug}/jobs/${roleId}/apply`)).text());
    const who = page.match(/<strong>Who can see it:<\/strong>([^<]*)<\/p>/)![1];
    expect(who).not.toContain("listed in the privacy notice");
    for (const kind of ["hosting", "file storage", "email delivery", "AI service"]) expect(who).toContain(kind);
    const privacy = decodeEntities(await (await app.request("/privacy")).text());
    expect(privacy).toContain("Who can see your information");
    for (const line of ["Hosting:", "Database and file storage:", "Email delivery:", "An AI service:", "Calendars (Google or Microsoft):"]) expect(privacy).toContain(line);
    expect(privacy).toContain("We do not sell your information.");
    // texting is off here, so the page does not name a texting provider
    expect(privacy).not.toContain("Text messages:");
  });

  it("a resume already uploaded stays attached when the form comes back, and the second send uses it", async () => {
    const grant = await directUpload("dana-resume.txt", "Dana Kept\nRegistered dental hygienist, 6 years.\n");
    const again = await apply(form({ uploadGrant: grant, acknowledged: null }));
    expect(again.status).toBe(400);
    const html = decodeEntities(await again.text());
    expect(grantIn(html)).toBe(grant);
    expect(html).toContain("Your resume dana-resume.txt is still attached.");
    expect(html).toContain("Everything you entered is still here.");
    const sent = await apply(form({ uploadGrant: grant }));
    expect(sent.status).toBe(302);
    await container.drain();
    const [app0] = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    const [doc] = await container.db.select().from(documents).where(eq(documents.id, app0.resumeDocumentId!));
    expect(doc).toMatchObject({ filename: "dana-resume.txt", uploadedVia: "direct" });
  });

  it("a file sent inside the form, or a grant that no longer opens, is asked for again, never claimed as kept", async () => {
    const withFile = await apply(form({ email: "lee.file@example.com", resume: new File(["Lee File, dental hygienist"], "lee.txt", { type: "text/plain" }), acknowledged: null }));
    expect(withFile.status).toBe(400);
    const a = decodeEntities(await withFile.text());
    expect(a).toContain("Everything you typed is still here, but please attach your resume again.");
    expect(a).not.toContain("Everything you entered is still here.");
    expect(a).toContain("Your resume is not attached any more. Please choose the file again.");
    expect(grantIn(a)).toBe("");
    const forged = await apply(form({ email: "sam.forged@example.com", uploadGrant: "not-a-real-grant", acknowledged: null }));
    expect(forged.status).toBe(400);
    const b = decodeEntities(await forged.text());
    expect(b).toContain("please attach your resume again");
    expect(grantIn(b)).toBe("");
    // without any resume, the promise stands as it was
    const plain = await apply(form({ email: "kim.plain@example.com", noResume: "Hygienist for five years.", acknowledged: null }));
    expect(decodeEntities(await plain.text())).toContain("Everything you entered is still here.");
  });
});
