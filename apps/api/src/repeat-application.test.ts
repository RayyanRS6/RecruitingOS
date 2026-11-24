import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { applications, candidates, communications, documents, events, jobs, roles, screens, withTenant } from "@ros/db";
import type { FakeEmailAdapter, MemoryStorageAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { RECEIPT_COOKIE, maskEmail } from "./pages/candidate";
import { LINK_REQUEST_JOB_KIND, createApplication, type NewApplication } from "./services/applications";
import { applicationForm, plantJob, seedCompany, usePlan } from "./test-helpers";

/**
 * A second application and a lost link, over HTTP. A repeat application looks exactly like a new one, creates nothing
 * and changes nothing on the person the company already has; the status link only ever travels by email to the address
 * on file; "Lost your link?" answers the same whether or not an address is known; only an open job that takes
 * applications admits one.
 */
describe("repeat applications and lost links", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let companyId = "";
  let slug = "";
  let roleId = "";
  let otherRoleId = "";
  const env = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", JOBS_BASE_URL: "https://jobs.example.test", RATE_LIMIT_OVERRIDES: JSON.stringify({ "candidate.link_request": 4 }) };
  const outbox = () => (container.integrations.email as FakeEmailAdapter).sent;
  const storage = () => container.integrations.storage as MemoryStorageAdapter;
  const decodeEntities = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  /** The page without the per-request nonce, so two renders of the same page compare equal. */
  const stable = (html: string) => html.replace(/nonce="[^"]*"/g, "");
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
  /** The application form as a browser posts it to a job; `resume: null` posts no file (a direct upload's grant goes in `fields`). */
  const applyTo = async (job: string, fields: Record<string, string | null> = {}, resume?: string | null, ip = "198.51.100.40") => {
    const r = await app.request(`/careers/${slug}/jobs/${job}/apply`, { method: "POST", body: applicationForm(fields, resume), headers: { "x-forwarded-for": ip } });
    await container.drain();
    return r;
  };
  const receiptOf = async (r: Response) => {
    const cookie = (r.headers.get("set-cookie") ?? "").match(new RegExp(`${RECEIPT_COOKIE}=[^;,]+`))![0];
    const page = await app.request(r.headers.get("location")!, { headers: { cookie } });
    expect(page.status).toBe(200);
    return { html: await page.text(), setCookie: r.headers.get("set-cookie") ?? "" };
  };
  const person = async (email: string) => (await container.db.select().from(candidates).where(and(eq(candidates.companyId, companyId), eq(candidates.email, email))))[0];
  const applicationOf = async (candidateId: string, forRole = roleId) => (await container.db.select().from(applications).where(and(eq(applications.roleId, forRole), eq(applications.candidateId, candidateId))))[0];
  /** A file the browser put straight into storage for this job, and the grant the form then carries. */
  const upload = async (ip: string, text = "A short resume text") => {
    const intent = await app.request(`/careers/${slug}/jobs/${roleId}/upload-intent`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ filename: "cv.txt", size: text.length, type: "text/plain" }) });
    const g = (await intent.json()) as { url: string; method: string; headers: Record<string, string>; grant: string };
    expect((await app.request(new URL(g.url).pathname, { method: g.method, headers: g.headers, body: new TextEncoder().encode(text).buffer as ArrayBuffer })).status).toBe(200);
    return g.grant;
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env });
    app = createApp(container);
    ({ companyId, slug } = await seedCompany(app, { email: "owner@repeat.test", name: "Repeat Dental" }));
    await usePlan(container, companyId);
    roleId = await plantJob(container, { companyId, title: "Dental Hygienist" });
    otherRoleId = await plantJob(container, { companyId, title: "Front Desk Coordinator" });
  });
  afterAll(async () => {
    await container.close();
  });

  it("masks an address to its first letter and its domain, and never shows a malformed one", () => {
    expect(maskEmail("maria.reyes@example.com")).toBe("m***@example.com");
    expect(maskEmail("  Q@x.org ")).toBe("Q***@x.org");
    expect(maskEmail("not-an-address")).toBe("the email address you gave");
    expect(maskEmail("@example.com")).toBe("the email address you gave");
  });

  it("a second application gets the same receipt as a first one, creates nothing, changes nothing on the existing person, discards its upload, and the address on file gets its status link again, once a day", async () => {
    const r1 = await applyTo(roleId, { phone: "(949) 555-0100" });
    expect(r1.status).toBe(302);
    expect(r1.headers.get("location")).toBe(`/careers/${slug}/jobs/${roleId}/applied`);
    const maria = await person("maria.reyes@example.com");
    const mariaApp = await applicationOf(maria.id);
    expect(mariaApp.resumeDocumentId).toBeTruthy();
    // the receipt cookie is sealed, short-lived, limited to the receipt page, and carries only the masked address
    const setCookie = r1.headers.get("set-cookie") ?? "";
    const receiptCookie = setCookie.slice(setCookie.indexOf(`${RECEIPT_COOKIE}=`));
    expect(receiptCookie).toMatch(new RegExp(`^${RECEIPT_COOKIE}=v1\\.`));
    for (const part of ["Max-Age=1800", `Path=/careers/${slug}/jobs/${roleId}/applied`, "HttpOnly", "SameSite=Lax"]) expect(receiptCookie).toContain(part);
    expect(setCookie).not.toContain("maria");
    expect(setCookie).not.toContain(mariaApp.id);
    // the receipt is a page, never a way into anything: no status link, and no AI interview (nobody is shortlisted by applying)
    const first = await receiptOf(r1);
    expect(first.html).toContain("<h1>Thanks, we have your application</h1>");
    expect(first.html).toContain("m***@example.com");
    expect(first.html).not.toMatch(/\/c\/status\/|\/c\/screen\//);
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, mariaApp.id))).toHaveLength(0);
    // the status link went by email, in the one email every applicant gets
    const ack = outbox().find((m) => m.to === "maria.reyes@example.com" && m.subject === "Thank you for applying: Dental Hygienist at Repeat Dental")!;
    expect(ack.text).toContain(`https://jobs.example.test/c/status/${mariaApp.statusToken}`);
    const before = { candidate: maria, app: mariaApp, docs: (await container.db.select().from(documents).where(eq(documents.candidateId, maria.id))).length, consentEvents: (await container.db.select().from(events).where(eq(events.type, "consent.granted"))).length, sent: outbox().length };

    // a stranger sends the form with Maria's address (another case), their own name and phone, and a resume uploaded straight to storage
    const grant = await upload("203.0.113.90", "A different person");
    const uploadKey = container.uploadGrants.open(grant)!.key;
    expect(storage().has(uploadKey)).toBe(true);
    const r2 = await applyTo(roleId, { firstName: "Mallory", lastName: "Stranger", email: "MARIA.REYES@example.com", phone: "(714) 555-0199", uploadGrant: grant }, null, "203.0.113.90");
    expect(r2.status).toBe(302);
    expect(r2.headers.get("location")).toBe(r1.headers.get("location"));
    const second = await receiptOf(r2);
    // the very receipt a first application gets, never Maria's link on the page: anyone can type anyone's address
    expect(second.html).toContain("<h1>Thanks, we have your application</h1>");
    expect(second.html).toContain("M***@example.com");
    expect(stable(second.html).replace("M***@", "m***@")).toBe(stable(first.html));
    // true for a repeat, whose reminder goes at most once a day
    expect(decodeEntities(second.html)).toContain("If you applied for this job before, look in our earlier emails too: we send the link again at most once a day.");
    expect(second.html).toContain('href="/c/link-request"');
    // a hidden-field bot with the same address lands on the very same page
    expect(stable(second.html)).toBe(stable((await receiptOf(await applyTo(roleId, { website: "https://spam.example", email: "MARIA.REYES@example.com" }))).html));
    for (const text of [r2.headers.get("location") ?? "", second.setCookie, second.html]) expect(text).not.toContain(mariaApp.statusToken);

    // nothing about Maria changed, and nothing new was created
    expect(await person("maria.reyes@example.com")).toEqual(before.candidate);
    expect(await applicationOf(maria.id)).toEqual(before.app);
    expect((await container.db.select().from(applications).where(eq(applications.roleId, roleId))).length).toBe(1);
    expect((await container.db.select().from(documents).where(eq(documents.candidateId, maria.id))).length).toBe(before.docs);
    expect((await container.db.select().from(events).where(eq(events.type, "consent.granted"))).length).toBe(before.consentEvents);
    expect(await person("mallory.stranger@example.com")).toBeUndefined();
    // the stranger's upload is gone; Maria's own file is untouched
    expect(storage().has(uploadKey)).toBe(false);
    const [mariaDoc] = await container.db.select().from(documents).where(eq(documents.id, mariaApp.resumeDocumentId!));
    expect(storage().has(mariaDoc.storageKey)).toBe(true);
    // the repeat is recorded; the address on file (never a typed one) gets its own link
    expect((await container.db.select().from(events).where(and(eq(events.type, "application.duplicate_detected"), eq(events.subjectId, mariaApp.id)))).length).toBe(1);
    const notices = outbox().slice(before.sent);
    expect(notices.map((m) => m.to)).toEqual(["maria.reyes@example.com"]);
    expect(notices[0].subject).toBe("Your application for Dental Hygienist at Repeat Dental");
    expect(notices[0].text).toContain(`https://jobs.example.test/c/status/${mariaApp.statusToken}`);
    expect(notices[0].text).toContain("If you did not send the second application, you do not need to do anything.");
    expect(notices[0].text).not.toMatch(/Mallory|Stranger|714|\/c\/screen\//);
    // it signs in the code's own words, as every candidate email does, never with the sign-off the job record stores
    // ("The team" in this job's record, which a model would have written): the code check of 25 November 2026
    expect(notices[0].text.trimEnd().endsWith("\n\nThe hiring team at Repeat Dental")).toBe(true);
    expect(notices[0].text).not.toMatch(/\nThe team\s*$/);

    // a third try the same day: the same receipt, no second email
    const r3 = await applyTo(roleId, {}, undefined, "203.0.113.91");
    expect(r3.headers.get("location")).toBe(r1.headers.get("location"));
    expect(outbox().slice(before.sent).filter((m) => m.to === "maria.reyes@example.com")).toHaveLength(1);
    expect((await container.db.select().from(communications).where(and(eq(communications.applicationId, mariaApp.id), eq(communications.templateKey, "status_link_repeat")))).length).toBe(1);
  });

  it("a hidden-field bot gets the same receipt and nothing is recorded", async () => {
    const applicationsBefore = (await container.db.select().from(applications)).length;
    const r = await applyTo(roleId, { firstName: "Bot", email: "bot@example.com", website: "https://spam.example" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/careers/${slug}/jobs/${roleId}/applied`);
    expect((await receiptOf(r)).html).toContain("b***@example.com");
    expect((await container.db.select().from(applications)).length).toBe(applicationsBefore);
    expect(await person("bot@example.com")).toBeUndefined();
  });

  it("an upload grant attaches its file to one submission: used again, it is refused the same way whether the first was new or a repeat", async () => {
    // first use: a new application, and a repeat with Maria's address (whose upload is discarded at once)
    const fresh = await upload("203.0.113.120");
    expect((await applyTo(roleId, { firstName: "Ola", lastName: "Newman", email: "ola.newman@example.com", uploadGrant: fresh }, null, "203.0.113.120")).status).toBe(302);
    const repeat = await upload("203.0.113.121");
    expect((await applyTo(roleId, { uploadGrant: repeat }, null, "203.0.113.121")).status).toBe(302);
    // each grant again, with the same other address: the very same refusal, before the file is looked at
    const reuse = async (grant: string) => {
      const r = await applyTo(roleId, { firstName: "Eve", lastName: "Probe", email: "eve.probe@example.com", uploadGrant: grant }, null, "203.0.113.122");
      return { status: r.status, html: stable(decodeEntities(await r.text())).replace(/name="formOpened" value="[^"]*"/g, "") };
    };
    const afterNew = await reuse(fresh);
    const afterRepeat = await reuse(repeat);
    expect(afterNew.status).toBe(400);
    expect(afterNew.html).toContain("Your uploaded resume could not be attached (the upload expired). Everything you typed is still here, but please attach your resume again.");
    expect(afterNew.html).not.toContain("did not arrive");
    // the spent upload is not kept in the form, which asks for the file again
    expect(afterNew.html).toContain('name="uploadGrant" value=""');
    expect(afterNew.html).toContain("Your resume is not attached any more. Please choose the file again.");
    expect(afterRepeat).toEqual(afterNew);
    expect(await person("eve.probe@example.com")).toBeUndefined();
    expect((await container.db.select().from(events).where(and(eq(events.type, "document.upload_used"), eq(events.subjectId, roleId)))).length).toBeGreaterThanOrEqual(3);
  });

  it("an existing person applying to another job gets the new application, but their record stays exactly as it was", async () => {
    const maria = await person("maria.reyes@example.com");
    const r = await applyTo(otherRoleId, { firstName: "Mariah", phone: "(714) 555-0177" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/careers/${slug}/jobs/${otherRoleId}/applied`);
    const other = await applicationOf(maria.id, otherRoleId);
    expect(other).toBeTruthy();
    expect(other.answers.acknowledgment).toBeTruthy(); // what this submission acknowledged is kept on its own application
    expect(await person("maria.reyes@example.com")).toEqual(maria);
    // a repeat for this second job the same day still gets this job's own link: the daily limit is per application
    const sentBefore = outbox().length;
    await applyTo(otherRoleId, {}, undefined, "203.0.113.95");
    const notices = outbox().slice(sentBefore).filter((m) => m.to === "maria.reyes@example.com");
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain(`https://jobs.example.test/c/status/${other.statusToken}`);
  });

  it("only an open job that is taking applications admits an application, the same rule as the form", async () => {
    const input: NewApplication = { companyId, roleId, source: "careers_page", firstName: "Held", lastName: "Person", email: "held.person@example.com", phone: null, consentSource: "careers_page_apply", noticeVersionsShown: [], acknowledgment: { at: new Date().toISOString(), noticeVersions: [] }, answers: {} };
    const actor = { kind: "candidate" as const, id: "applicant" };
    await container.db.update(roles).set({ status: "paused", pausedAt: new Date().toISOString() }).where(eq(roles.id, roleId));
    await expect(withTenant(container.db, companyId, (tx) => createApplication(tx, container, input, actor))).rejects.toThrow(/not accepting applications/);
    expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`)).status).toBe(404);
    expect((await applyTo(roleId, { email: "held.person@example.com" })).status).toBe(404);
    await container.db.update(roles).set({ status: "open", pausedAt: null, acceptingApplications: false }).where(eq(roles.id, roleId));
    await expect(withTenant(container.db, companyId, (tx) => createApplication(tx, container, input, actor))).rejects.toThrow(/not accepting applications/);
    await container.db.update(roles).set({ acceptingApplications: true }).where(eq(roles.id, roleId));
    expect(await person("held.person@example.com")).toBeUndefined();
  });

  it("'Lost your link?' answers the same for a known and an unknown address; only the address on file gets the links, at most once an hour", async () => {
    const page = await app.request("/c/link-request");
    expect(page.status).toBe(200);
    expect(decodeEntities(await page.text())).toContain("<h1>Lost your link?</h1>");
    const maria = await person("maria.reyes@example.com");
    const apps = await container.db.select().from(applications).where(eq(applications.candidateId, maria.id));
    expect(apps).toHaveLength(2);
    const sentBefore = outbox().length;
    const queuedBefore = (await container.db.select().from(jobs).where(eq(jobs.kind, LINK_REQUEST_JOB_KIND)).orderBy(jobs.id)).length;
    const known = await form("/c/link-request", { email: "Maria.Reyes@Example.com" }, { "x-forwarded-for": "198.51.100.61" });
    const unknown = await form("/c/link-request", { email: "nobody.here@example.com" }, { "x-forwarded-for": "198.51.100.62" });
    for (const r of [known, unknown]) {
      expect(r.status).toBe(303);
      expect(r.headers.get("location")).toBe("/c/link-request?sent=1");
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    expect(await known.text()).toBe(await unknown.text());
    // the page does the same single thing for both, queueing the request; the lookup runs in the worker, not before the answer
    const queued = (await container.db.select().from(jobs).where(eq(jobs.kind, LINK_REQUEST_JOB_KIND)).orderBy(jobs.id)).slice(queuedBefore);
    expect(queued.map((j) => j.payload)).toEqual([{ email: "maria.reyes@example.com" }, { email: "nobody.here@example.com" }]);
    await container.drain();
    const sent = decodeEntities(await (await app.request("/c/link-request?sent=1")).text());
    expect(sent).toContain("If we have an application from that address, your link is on its way.");
    expect(sent).toContain("this page looks the same whether or not we found anything");
    // one email, to the address on file, with both of Maria's links; nothing to the unknown address
    const mail = outbox().slice(sentBefore);
    expect(mail.map((m) => m.to)).toEqual(["maria.reyes@example.com"]);
    expect(mail[0].subject).toBe("Your application links: Repeat Dental");
    for (const a of apps) expect(mail[0].text).toContain(`https://jobs.example.test/c/status/${a.statusToken}`);
    const [row] = await container.db.select().from(communications).where(and(eq(communications.candidateId, maria.id), eq(communications.templateKey, "status_link_request")));
    expect(row).toMatchObject({ status: "sent", direction: "outbound" });
    // asking again within the hour: the same answer, no second email
    const again = await form("/c/link-request", { email: "maria.reyes@example.com" }, { "x-forwarded-for": "198.51.100.63" });
    expect(again.headers.get("location")).toBe("/c/link-request?sent=1");
    await container.drain();
    expect(outbox().slice(sentBefore)).toHaveLength(1);
    // a malformed address is asked for again; the hidden field is answered like everyone else and sends nothing
    const bad = await form("/c/link-request", { email: "not an address" }, { "x-forwarded-for": "198.51.100.64" });
    expect(bad.status).toBe(400);
    expect(decodeEntities(await bad.text())).toContain("Please check the email address");
    const bot = await form("/c/link-request", { email: "maria.reyes@example.com", website: "x" }, { "x-forwarded-for": "198.51.100.65" });
    expect(bot.headers.get("location")).toBe("/c/link-request?sent=1");
    expect(outbox().slice(sentBefore)).toHaveLength(1);
  });

  it("'Lost your link?' is rate-limited per address with a plain 429", async () => {
    const ip = { "x-forwarded-for": "198.51.100.70", accept: "text/html" };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await form("/c/link-request", { email: `someone${i}@example.com` }, ip)).status);
    expect(statuses.slice(0, 4)).toEqual([303, 303, 303, 303]);
    expect(statuses[4]).toBe(429);
  });
});
