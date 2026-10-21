import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { entitlements } from "@ros/core";
import { applications, candidates, communications, documents, events, jobs, notifications, postings, roles, users, withTenant } from "@ros/db";
import type { FakeEmailAdapter, MemoryStorageAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { RECEIPT_COOKIE, maskEmail } from "./pages/candidate";
import { LINK_REQUEST_JOB_KIND, createApplication } from "./services/applications";
import { noThanksRequested } from "./services/replies";
import { pastTheWaitingRoom, useLaterApplyFlow } from "./test-helpers";

/**
 * Wave 0 items 0.1 and 0.11, over HTTP. A repeat application looks exactly like a new one and changes nothing on the
 * person the company already has; the status link only ever travels by email to the address on file; "Lost your
 * link?" answers the same whether or not an address is known; an emailed repeat changes nothing either; only an open
 * role that takes applications admits one. And the talent-pool opt-out works, from a "no thanks" reply and from the
 * status page.
 */
describe("repeat applications, lost links and the talent-pool opt-out", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  let otherRoleId = "";
  let eligibility: string[] = [];
  let otherEligibility: string[] = [];
  const env = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", SMS_PROVIDER: "fake", SMS_ENABLED: "true", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", JOBS_BASE_URL: "https://jobs.example.test", RATE_LIMIT_OVERRIDES: JSON.stringify({ "candidate.link_request": 4 }) };
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(devLink).searchParams.get("token") }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body ? JSON.stringify(body) : undefined });
  const outbox = () => (container.integrations.email as FakeEmailAdapter).sent;
  const storage = () => container.integrations.storage as MemoryStorageAdapter;
  const decodeEntities = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  /** The page without the per-request nonce, so two renders of the same page compare equal. */
  // the nonce and the form's sealed opening time (plan D7) change with every render, whoever applies
  const stable = (html: string) => html.replace(/nonce="[^"]*"/g, "").replace(/name="formOpened" value="[^"]*"/g, "");
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
  const inbound = (payload: Record<string, unknown>) => app.request("/webhooks/postmark/inbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

  const openRole = async (message: string) => {
    const s = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: message })).json()) as { session: { id: string } };
    const id = ((await (await json("POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json("POST", `/api/v1/roles/${id}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    const role = (await (await json("GET", `/api/v1/roles/${id}`)).json()) as { status: string; currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    expect(role.status).toBe("open");
    return { id, eligibility: role.currentPacket.packet.requirements.eligibility.map((r) => r.key) };
  };
  /** The apply form as a browser posts it; every field can be overridden or dropped. */
  const applyTo = async (role: { id: string; eligibility: string[] }, fields: Record<string, string | null>, extra?: (fd: FormData) => void, ip = "198.51.100.40") => {
    const fd = new FormData();
    const base: Record<string, string> = { firstName: "Maria", lastName: "Reyes", email: "maria.reyes@example.com", locationText: "Tustin, CA", noResume: "Registered Dental Hygienist at Coastal Family Dentistry since 2019; active CA RDH license.", noticeVersionsShown: "ai_use@2026-09-01,privacy@2026-09-01", acknowledged: "yes" };
    for (const k of role.eligibility) base[`elig_${k}`] = "yes";
    for (const [k, v] of Object.entries({ ...base, ...fields })) if (v !== null) fd.set(k, v);
    extra?.(fd);
    const r = await app.request(`/careers/${slug}/jobs/${role.id}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": ip } });
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

  beforeAll(async () => {
    container = await createContainer({ memory: true, env });
    app = createApp(container);
    owner = await signIn("owner@repeat.test");
    const co = (await (await json("POST", "/api/v1/companies", { name: "Repeat Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    slug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
    // The ITS switch is ignored since 20 October (R20-12): set to "later", every applicant still gets the AI interview.
    await useLaterApplyFlow(container, companyId);
    const first = await openRole("I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.");
    roleId = first.id;
    eligibility = first.eligibility;
    const second = await openRole("I need a front desk coordinator in Irvine, $22 to $26 an hour, full time. It's growth. Ceiling $27. I decide. Must-haves: Dentrix scheduling. Just draft it.");
    otherRoleId = second.id;
    otherEligibility = second.eligibility;
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

  it("a repeat submission gets the same waiting room as a first application (Q14, kept in full on 21 Oct), changes nothing on the existing person, discards its upload, and the address on file gets its link once a day", async () => {
    const role = { id: roleId, eligibility };
    const r1 = await applyTo(role, { phone: "(949) 555-0100", smsConsent: "yes" }, (fd) => fd.set("resume", new File(["Maria Reyes, RDH\nRegistered Dental Hygienist 2019 - present"], "maria.txt", { type: "text/plain" })));
    expect(r1.status).toBe(302);
    expect(r1.headers.get("location")).toBe(`/careers/${slug}/jobs/${roleId}/applied`);
    const maria = await person("maria.reyes@example.com");
    const mariaApp = await applicationOf(maria.id);
    expect(mariaApp.resumeDocumentId).toBeTruthy();
    // the receipt cookie is sealed, short-lived, limited to the receipt page, and carries only the masked address (and,
    // sealed, the application its waiting room waits for)
    const setCookie = r1.headers.get("set-cookie") ?? "";
    const receiptCookie = setCookie.slice(setCookie.indexOf(`${RECEIPT_COOKIE}=`));
    expect(receiptCookie).toMatch(new RegExp(`^${RECEIPT_COOKIE}=v1\\.`));
    for (const part of ["Max-Age=1800", `Path=/careers/${slug}/jobs/${roleId}/applied`, "HttpOnly", "SameSite=Lax"]) expect(receiptCookie).toContain(part);
    expect(setCookie).not.toContain("maria");
    expect(setCookie).not.toContain(mariaApp.id);
    // a first application's waiting room opens her own AI interview (the inline worker made it already) once its first
    // 40 to 90 seconds are over, as every waiting room's are (Q14, 21 Oct)
    const room = await pastTheWaitingRoom(container, async () => app.request(r1.headers.get("location")!, { headers: { cookie: setCookie.match(new RegExp(`${RECEIPT_COOKIE}=[^;,]+`))![0] } }));
    expect(room.status).toBe(302);
    expect(room.headers.get("location")).toMatch(/^\/c\/screen\//);
    // the status link went by email, in the one email with the interview's link
    const ack = outbox().find((m) => m.to === "maria.reyes@example.com" && /^Thank you for applying: your next step/.test(m.subject))!;
    expect(ack.text).toContain(`https://jobs.example.test/c/status/${mariaApp.statusToken}`);
    const before = { candidate: maria, app: mariaApp, docs: (await container.db.select().from(documents).where(eq(documents.candidateId, maria.id))).length, consentEvents: (await container.db.select().from(events).where(eq(events.type, "consent.granted"))).length, sent: outbox().length };

    // a stranger sends the form with Maria's address (another case), their own phone, place, text consent and résumé uploaded straight to storage
    const intent = await app.request(`/careers/${slug}/jobs/${roleId}/upload-intent`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.90" }, body: JSON.stringify({ filename: "mine.txt", size: 18, type: "text/plain" }) });
    const grant = (await intent.json()) as { url: string; method: string; headers: Record<string, string>; grant: string };
    expect((await app.request(new URL(grant.url).pathname, { method: grant.method, headers: grant.headers, body: new TextEncoder().encode("A different person").buffer as ArrayBuffer })).status).toBe(200);
    const uploadKey = container.uploadGrants.open(grant.grant)!.key;
    expect(storage().has(uploadKey)).toBe(true);
    const r2 = await applyTo(role, { firstName: "Mallory", lastName: "Stranger", email: "MARIA.REYES@example.com", phone: "(714) 555-0199", smsConsent: "yes", locationText: "Reno, NV", noResume: "Somebody else entirely." }, (fd) => fd.set("uploadGrant", grant.grant), "203.0.113.90");
    expect(r2.status).toBe(302);
    expect(r2.headers.get("location")).toBe(r1.headers.get("location"));
    const second = await receiptOf(r2);
    // the same waiting room a first application gets (Q14): never Maria's link on the page, since anyone can type anyone's
    // address; what it opens later is a detached interview whose answers wait for Maria to confirm (repeat-conversation.test.ts)
    expect(decodeEntities(second.html)).toContain("We're preparing your AI interview…");
    expect(second.html).toContain('<input type="hidden" name="grant" value="v1.');
    expect(second.html).toContain("M***@example.com");
    // true for a repeat, whose reminder goes at most once a day
    expect(decodeEntities(second.html)).toContain("If you applied for this job before, look in our earlier emails too: we send the link again at most once a day.");
    expect(second.html).toContain('href="/c/link-request"');
    expect(second.html).not.toContain("/c/screen/");
    // a hidden-field bot with the same address lands on the very same page
    const sealed = (html: string) => stable(html).replace(/name="grant" value="[^"]*"/g, "");
    expect(sealed(second.html)).toBe(sealed((await receiptOf(await applyTo({ id: roleId, eligibility }, { website: "https://spam.example", email: "MARIA.REYES@example.com" }))).html));
    for (const text of [r2.headers.get("location") ?? "", second.setCookie, second.html]) expect(text).not.toContain(mariaApp.statusToken);

    // nothing about Maria changed, and nothing new was created
    const after = await person("maria.reyes@example.com");
    expect(after).toEqual(before.candidate);
    expect(await applicationOf(maria.id)).toEqual(before.app);
    expect((await container.db.select().from(applications).where(eq(applications.roleId, roleId))).length).toBe(1);
    expect((await container.db.select().from(documents).where(eq(documents.candidateId, maria.id))).length).toBe(before.docs);
    expect((await container.db.select().from(events).where(eq(events.type, "consent.granted"))).length).toBe(before.consentEvents);
    expect(await person("mallory.stranger@example.com")).toBeUndefined();
    // the stranger's upload is gone; Maria's own file is untouched
    expect(storage().has(uploadKey)).toBe(false);
    const [mariaDoc] = await container.db.select().from(documents).where(eq(documents.id, mariaApp.resumeDocumentId!));
    expect(storage().has(mariaDoc.storageKey)).toBe(true);
    // the team sees the repeat; the address on file (never a typed one) gets its own link
    expect((await container.db.select().from(events).where(and(eq(events.type, "application.duplicate_detected"), eq(events.subjectId, mariaApp.id)))).length).toBe(1);
    const notices = outbox().slice(before.sent);
    expect(notices.map((m) => m.to)).toEqual(["maria.reyes@example.com"]);
    expect(notices[0].subject).toMatch(/^Your application for .+ at Repeat Dental$/);
    expect(notices[0].text).toContain(`https://jobs.example.test/c/status/${mariaApp.statusToken}`);
    expect(notices[0].text).toContain("If you did not send the second application, you do not need to do anything.");
    expect(notices[0].text).not.toMatch(/Mallory|Reno|714/);

    // a third try the same day: the same receipt, no second email
    const r3 = await applyTo(role, { email: "maria.reyes@example.com" }, undefined, "203.0.113.91");
    expect(r3.headers.get("location")).toBe(r1.headers.get("location"));
    expect(outbox().slice(before.sent).filter((m) => m.to === "maria.reyes@example.com")).toHaveLength(1);
    expect((await container.db.select().from(communications).where(and(eq(communications.applicationId, mariaApp.id), eq(communications.templateKey, "status_link_repeat")))).length).toBe(1);
  });

  it("a hidden-field bot gets the same receipt and nothing is recorded", async () => {
    const applicationsBefore = (await container.db.select().from(applications)).length;
    const r = await applyTo({ id: roleId, eligibility }, { firstName: "Bot", email: "bot@example.com", website: "https://spam.example" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/careers/${slug}/jobs/${roleId}/applied`);
    expect((await receiptOf(r)).html).toContain("b***@example.com");
    expect((await container.db.select().from(applications)).length).toBe(applicationsBefore);
  });

  it("an upload grant attaches its file to one submission: used again, it is refused the same way whether the first was new or a repeat", async () => {
    const role = { id: roleId, eligibility };
    const upload = async (ip: string) => {
      const intent = await app.request(`/careers/${slug}/jobs/${roleId}/upload-intent`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ filename: "cv.txt", size: 19, type: "text/plain" }) });
      const g = (await intent.json()) as { url: string; method: string; headers: Record<string, string>; grant: string };
      expect((await app.request(new URL(g.url).pathname, { method: g.method, headers: g.headers, body: new TextEncoder().encode("A short resume text").buffer as ArrayBuffer })).status).toBe(200);
      return g.grant;
    };
    // first use: a new application, and a repeat with Maria's address (whose upload is discarded at once)
    const fresh = await upload("203.0.113.120");
    expect((await applyTo(role, { firstName: "Ola", lastName: "Newman", email: "ola.newman@example.com" }, (fd) => fd.set("uploadGrant", fresh), "203.0.113.120")).status).toBe(302);
    const repeat = await upload("203.0.113.121");
    expect((await applyTo(role, { email: "maria.reyes@example.com" }, (fd) => fd.set("uploadGrant", repeat), "203.0.113.121")).status).toBe(302);
    // each grant again, with the same other address: the very same refusal, before the file is looked at
    const reuse = async (grant: string) => {
      const r = await applyTo(role, { firstName: "Eve", lastName: "Probe", email: "eve.probe@example.com" }, (fd) => fd.set("uploadGrant", grant), "203.0.113.122");
      return { status: r.status, html: stable(decodeEntities(await r.text())) };
    };
    const afterNew = await reuse(fresh);
    const afterRepeat = await reuse(repeat);
    expect(afterNew.status).toBe(400);
    expect(afterNew.html).toContain("Your uploaded resume could not be attached (the upload expired).");
    expect(afterNew.html).not.toContain("did not arrive");
    expect(afterRepeat).toEqual(afterNew);
    expect(await person("eve.probe@example.com")).toBeUndefined();
    expect((await container.db.select().from(events).where(and(eq(events.type, "document.upload_used"), eq(events.subjectId, roleId)))).length).toBeGreaterThanOrEqual(3);
  });

  it("an existing person applying to another role gets the new application, but their record stays exactly as it was", async () => {
    const maria = await person("maria.reyes@example.com");
    const r = await applyTo({ id: otherRoleId, eligibility: otherEligibility }, { phone: "(714) 555-0177", smsConsent: "yes", locationText: "Reno, NV", noResume: "Front desk at Smile Bright since 2021; Dentrix scheduling." });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/careers/${slug}/jobs/${otherRoleId}/applied`);
    const other = await applicationOf(maria.id, otherRoleId);
    expect(other).toBeTruthy();
    expect(other.answers.acknowledgment).toBeTruthy(); // what this submission acknowledged is kept on its own application
    expect(await person("maria.reyes@example.com")).toEqual(maria);
    // a repeat for this second role the same day still gets this role's own link: the daily limit is per application
    const sentBefore = outbox().length;
    await applyTo({ id: otherRoleId, eligibility: otherEligibility }, { email: "maria.reyes@example.com" }, undefined, "203.0.113.95");
    const notices = outbox().slice(sentBefore).filter((m) => m.to === "maria.reyes@example.com");
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain(`https://jobs.example.test/c/status/${other.statusToken}`);
  });

  it("an emailed repeat changes nothing either, and the address on file hears about it", async () => {
    const [emailIn] = await container.db.select().from(postings).where(and(eq(postings.roleId, roleId), eq(postings.channel, "email_in")));
    const maria = await person("maria.reyes@example.com");
    const mariaApp = await applicationOf(maria.id);
    const repeatsBefore = (await container.db.select().from(communications).where(and(eq(communications.applicationId, mariaApp.id), eq(communications.templateKey, "status_link_repeat")))).length;
    const r = await inbound({ From: "noreply@indeed.com", FromName: "Indeed", To: `apply-${emailIn.intakeToken}@${container.integrations.env.intakeDomain}`, Subject: "New applicant: Maria Reyes - Registered Dental Hygienist", TextBody: "Maria Reyes applied via Indeed.\nEmail: maria.reyes@example.com\nPhone: 702-555-0123", Attachments: [{ Name: "other.txt", ContentType: "text/plain", Content: Buffer.from("Somebody else's résumé").toString("base64"), ContentLength: 24 }] });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, matched: true, applicationId: mariaApp.id, duplicate: true });
    await container.drain();
    expect(await person("maria.reyes@example.com")).toEqual(maria);
    expect(await applicationOf(maria.id)).toEqual(mariaApp);
    expect((await container.db.select().from(documents).where(eq(documents.applicationId, mariaApp.id))).length).toBe(1);
    // already told today by the form test above: the daily limit holds across both ways in
    expect((await container.db.select().from(communications).where(and(eq(communications.applicationId, mariaApp.id), eq(communications.templateKey, "status_link_repeat")))).length).toBe(repeatsBefore);
  });

  it("only an open role that is taking applications admits an application, the same rule as the form (email held while paused is replayed later)", async () => {
    const input = { companyId, roleId, source: "email_in", firstName: "Held", lastName: "Person", email: "held.person@example.com", phone: null, smsConsent: false, consentSource: "email_in", noticeVersionsShown: [], eligibilityAnswers: {}, noResumeAnswers: { summary: "Hygienist." } };
    const actor = { kind: "system" as const, id: "email_in" };
    await container.db.update(roles).set({ status: "paused", pausedAt: new Date().toISOString() }).where(eq(roles.id, roleId));
    await expect(withTenant(container.db, companyId, (tx) => createApplication(tx, container, input, actor))).rejects.toThrow(/not accepting applications/);
    await container.db.update(roles).set({ status: "open", pausedAt: null, acceptingApplications: false }).where(eq(roles.id, roleId));
    await expect(withTenant(container.db, companyId, (tx) => createApplication(tx, container, input, actor))).rejects.toThrow(/not accepting applications/);
    await container.db.update(roles).set({ acceptingApplications: true }).where(eq(roles.id, roleId));
    expect(await person("held.person@example.com")).toBeUndefined();
  });

  it("'Lost your link?' answers the same for a known and an unknown address; only the address on file gets the links, at most once an hour", async () => {
    const page = await app.request("/c/link-request");
    expect(page.status).toBe(200);
    expect(decodeEntities(await page.text())).toContain("Lost your link?");
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

  it("\"no thanks\" as a reply keeps the person out of the talent pool, confirmed once; a longer sentence is just a message", () => {
    expect(noThanksRequested("No thanks")).toBe(true);
    expect(noThanksRequested("no, thank you.\n\nI found another job.")).toBe(true);
    expect(noThanksRequested("  NO THANKS!  ")).toBe(true);
    expect(noThanksRequested("No thanks, but I am still interested in this role")).toBe(false);
    expect(noThanksRequested("Thanks!")).toBe(false);
  });

  it("a \"no thanks\" reply to the decline and the status-page button each opt the person out of future roles, once, with one confirmation", async () => {
    // by reply: before any decline, "no thanks" turns down a step more likely than future roles, so it goes to the team as it is
    await applyTo({ id: roleId, eligibility }, { firstName: "Noor", lastName: "Haddad", email: "noor.haddad@example.com" });
    const noor = await person("noor.haddad@example.com");
    const noorApp = await applicationOf(noor.id);
    const to = `reply-${noorApp.replyToken}@${container.integrations.env.intakeDomain}`;
    const early = await inbound({ From: "noor.haddad@example.com", To: to, Subject: "Re: Next step", TextBody: "No thanks", MessageID: "msg-noor-0" });
    expect(await early.json()).toMatchObject({ matched: true, reply: true, humanRequested: false, talentPoolOptOut: false });
    await container.drain();
    expect((await person("noor.haddad@example.com")).preferences.talentPoolOptOut).toBeUndefined();
    const [ownerUser] = await container.db.select().from(users).where(eq(users.email, "owner@repeat.test"));
    const told = await container.db.select().from(notifications).where(and(eq(notifications.userId, ownerUser.id), eq(notifications.kind, "message.received")));
    expect(told.some((n) => n.body.includes("\"No thanks\". This may mean they do not want to go ahead with this step. Nothing was changed"))).toBe(true);
    // the decline email (sent when a person sends the decision message) makes the offer; a "no thanks" to it is the opt-out
    expect((await json("POST", `/api/v1/applications/${noorApp.id}/actions`, { action: "reject", reason: "not_a_match_experience" })).status).toBe(200);
    expect((await json("POST", `/api/v1/applications/${noorApp.id}/actions`, { action: "send_decision" })).status).toBe(200);
    await container.drain();
    const decline = outbox().find((m) => m.to === "noor.haddad@example.com" && m.subject === "Your application to Repeat Dental")!;
    expect(decline.text).toContain("reply \"no thanks\"");
    const declined = await applicationOf(noor.id);
    await container.db.update(candidates).set({ inTalentPool: true }).where(eq(candidates.id, noor.id));
    const sentBefore = outbox().length;
    const r = await inbound({ From: "noor.haddad@example.com", To: to, Subject: "Re: Your application to Repeat Dental", TextBody: "No thanks\n\nI took another job.", MessageID: "msg-noor-1" });
    expect(await r.json()).toMatchObject({ matched: true, reply: true, humanRequested: false, talentPoolOptOut: true });
    await container.drain();
    const optedOut = await person("noor.haddad@example.com");
    expect(optedOut.preferences.talentPoolOptOut).toBe(true);
    expect(optedOut.inTalentPool).toBe(false);
    expect((await applicationOf(noor.id)).stage).toBe(declined.stage);
    const revoked = (await container.db.select().from(events).where(and(eq(events.type, "consent.revoked"), eq(events.subjectId, noor.id))))[0];
    expect(revoked.payload).toMatchObject({ purpose: "talent_pool", source: "email_reply" });
    const confirmations = () => outbox().slice(sentBefore).filter((m) => m.to === "noor.haddad@example.com" && /will not be contacted about future roles/.test(m.subject));
    expect(confirmations()).toHaveLength(1);
    expect(confirmations()[0].text).toContain("This does not change an application you have open right now");
    // the way back it names is real: the status page and its button
    expect(confirmations()[0].text).toContain(`https://jobs.example.test/c/status/${noorApp.statusToken}`);
    expect(confirmations()[0].text).not.toMatch(/reply to this email and a person will help/);
    // saying it again changes and sends nothing more
    await inbound({ From: "noor.haddad@example.com", To: to, Subject: "Re: Your application", TextBody: "no thank you", MessageID: "msg-noor-2" });
    await container.drain();
    expect(confirmations()).toHaveLength(1);
    // the status page says so, offers no opt-out button, and offers the way back
    const noorStatus = decodeEntities(await (await app.request(`/c/status/${noorApp.statusToken}`)).text());
    expect(noorStatus).toContain("you asked us not to keep your details for future roles");
    expect(noorStatus).not.toContain("Don't keep me for future roles");
    expect(noorStatus).toContain("Keep me for future roles again");

    // by the button on the status page
    await applyTo({ id: roleId, eligibility }, { firstName: "Tess", lastName: "Ward", email: "tess.ward@example.com" });
    const tess = await person("tess.ward@example.com");
    const tessApp = await applicationOf(tess.id);
    const before = decodeEntities(await (await app.request(`/c/status/${tessApp.statusToken}`)).text());
    expect(before).toContain("Don't keep me for future roles");
    expect(before).toContain(`action="/c/status/${tessApp.statusToken}/talent-pool"`);
    const pressed = await form(`/c/status/${tessApp.statusToken}/talent-pool`, {});
    expect(pressed.status).toBe(302);
    // back at the choice itself, which says it was saved (the decision and closing messages link there too, Q30)
    expect(pressed.headers.get("location")).toBe(`/c/status/${tessApp.statusToken}?pool=out#future-roles`);
    await container.drain();
    expect((await person("tess.ward@example.com")).preferences.talentPoolOptOut).toBe(true);
    expect((await container.db.select().from(events).where(and(eq(events.type, "consent.revoked"), eq(events.subjectId, tess.id))))[0].payload).toMatchObject({ purpose: "talent_pool", source: "status_page" });
    expect((await form(`/c/status/${tessApp.statusToken}/talent-pool`, {})).status).toBe(302);
    await container.drain();
    expect(outbox().filter((m) => m.to === "tess.ward@example.com" && /will not be contacted about future roles/.test(m.subject))).toHaveLength(1);
    // the application itself is untouched, and a forged link is a 404
    expect((await applicationOf(tess.id)).stage).not.toBe("withdrawn");
    expect((await form(`/c/status/${tessApp.statusToken.slice(0, -2)}zz/talent-pool`, {})).status).toBe(404);

    // a decline after the opt-out does not offer the talent pool again: it says the choice stands
    expect((await json("POST", `/api/v1/applications/${tessApp.id}/actions`, { action: "reject", reason: "not_a_match_experience" })).status).toBe(200);
    expect((await json("POST", `/api/v1/applications/${tessApp.id}/actions`, { action: "send_decision" })).status).toBe(200);
    await container.drain();
    const tessDecline = outbox().find((m) => m.to === "tess.ward@example.com" && m.subject === "Your application to Repeat Dental")!;
    expect(tessDecline.text).toContain("As you asked, we will not keep your details for future roles.");
    expect(tessDecline.text).not.toContain("no thanks");

    // and the way back: one click takes the choice back, recorded, with nothing sent
    const sentBeforeBack = outbox().length;
    expect((await form(`/c/status/${tessApp.statusToken}/talent-pool`, { pref: "in" })).status).toBe(302);
    await container.drain();
    expect((await person("tess.ward@example.com")).preferences.talentPoolOptOut).toBe(false);
    expect((await container.db.select().from(events).where(and(eq(events.type, "consent.granted"), eq(events.subjectId, tess.id))))[0].payload).toMatchObject({ purpose: "talent_pool", source: "status_page" });
    expect(outbox().slice(sentBeforeBack).filter((m) => m.to === "tess.ward@example.com")).toHaveLength(0);
    expect(decodeEntities(await (await app.request(`/c/status/${tessApp.statusToken}`)).text())).toContain("Don't keep me for future roles");
  });
});
