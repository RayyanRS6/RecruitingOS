import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { candidateNotices, createApplicationLink, disableApplicationLink, findPostingLink, noticesFor, sealPayload } from "@ros/core";
import { applicationLinks, applications, candidates, communications, companies, events, inboundEmails, interviews, notifications, postings, randomToken, rolePackets, roles, screens, users, withTenant } from "@ros/db";
import { jobValidThrough, type FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { PUBLIC_FEED_CACHE_MS, resetPublicFeedCache } from "./pages/public-feeds";
import { jobUrls } from "./services/job-urls";
import { statusTokenFor, useLaterApplyFlow, useOneVisitApplyFlow } from "./test-helpers";

/**
 * The candidate-facing job surfaces (docs/spec/20 section 2 items 1 to 8, 19 and 20; docs/readiness/20 section D):
 * tracked links and the source they leave on an application without ever leaving the token anywhere a candidate could
 * see it; the apply form's transparency block and affirmative acknowledgment; texting off means no consent box and no
 * promise of texts; the recording notice never shown; paused roles and the accepting switch keeping the page up and the
 * form closed, with email-in applications held for the owner; the sitemap, robots and feeds; and the JobPosting data.
 */
describe("public job surfaces: tracked links, the apply form, feeds and structured data", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerActor: Actor;
  let companyId = "";
  let slug = "";
  let roleId = "";
  let eligibility: Array<{ key: string; type: string }> = [];
  const BASE = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return d.getTime(); })();
  let clockOffset = 0;
  const setClock = (offsetMs: number) => { clockOffset = offsetMs; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + clockOffset); };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const emails = () => (container.integrations.email as FakeEmailAdapter).sent;
  const eventsOf = async (type: string) => container.db.select().from(events).where(eq(events.type, type));
  const roleRow = async () => (await container.db.select().from(roles).where(eq(roles.id, roleId)))[0];
  const setAccepting = (accepting: boolean) => container.db.update(roles).set({ acceptingApplications: accepting, applicationsClosedAt: accepting ? null : new Date(BASE + clockOffset).toISOString() }).where(eq(roles.id, roleId));
  const decodeEntities = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const jsonLdOf = (html: string) => JSON.parse(html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)![1]) as Record<string, unknown>;
  const setCookieOf = (r: Response) => r.headers.get("set-cookie") ?? "";
  const cookieValue = (r: Response) => setCookieOf(r).match(/ros_src=([^;]+)/)?.[1] ?? "";

  const signIn = async (a: ReturnType<typeof createApp>, email: string) => {
    const r1 = await a.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await a.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  /** A company with an approved, open role, the way an owner makes one. */
  const seedRole = async (c: Container, a: ReturnType<typeof createApp>, cookie: string, name: string) => {
    const j = (method: string, path: string, body?: unknown) => a.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
    const co = (await (await j("POST", "/api/v1/companies", { name, vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    // A pilot company: ITS switched the one-visit flow on for it (plan Wave E).
    await useOneVisitApplyFlow(c, co.id);
    const s = (await (await j("POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    const id = ((await (await j("POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await j("POST", `/api/v1/roles/${id}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await c.drain();
    const role = (await (await j("GET", `/api/v1/roles/${id}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string; type: string }> } } } };
    return { companyId: co.id, slug: co.slug, roleId: id, eligibility: role.currentPacket.packet.requirements.eligibility };
  };
  /** The apply form as a browser posts it; every field can be overridden or dropped. */
  const applyForm = (fields: Record<string, string | null> = {}, elig: Array<{ key: string }> = eligibility) => {
    const fd = new FormData();
    const base: Record<string, string> = { firstName: "Ana", lastName: "Lopez", email: "ana.lopez@example.com", locationText: "Irvine, CA", noResume: "Registered Dental Hygienist at Coastal Family Dentistry since 2019; active CA RDH license; Dentrix.", noticeVersionsShown: "ai_use@2026-09-01,privacy@2026-09-01", acknowledged: "yes" };
    for (const r of elig) base[`elig_${r.key}`] = "yes";
    for (const [k, v] of Object.entries({ ...base, ...fields })) if (v !== null) fd.set(k, v);
    return fd;
  };
  const apply = (fd: FormData, headers: Record<string, string> = {}, a = app, path = `/careers/${slug}/jobs/${roleId}/apply`) => a.request(path, { method: "POST", body: fd, headers });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test", SMS_ENABLED: "false" } });
    app = createApp(container);
    setClock(0);
    owner = await signIn(app, "owner@ledger.test");
    const [user] = await container.db.select().from(users).where(eq(users.email, "owner@ledger.test"));
    ownerActor = { kind: "user", id: user.id, name: "Owner Olivia" };
    const seeded = await seedRole(container, app, owner, "Ledger Dental");
    companyId = seeded.companyId;
    slug = seeded.slug;
    roleId = seeded.roleId;
    eligibility = seeded.eligibility;
    // the employer's website and logo go into the structured data when the company set them (the rest of the settings,
    // the ITS confirmation among them, are kept: an unconfirmed company has no public pages)
    const [co] = await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    await container.db.update(companies).set({ settings: { ...co.settings, website: "https://ledgerdental.example", logoUrl: "https://ledgerdental.example/logo.png" } }).where(eq(companies.id, companyId));
  });
  afterAll(async () => {
    await container.close();
  });

  it("candidateNotices leaves the recording notice and the SMS consent text out of what a page renders and records", () => {
    const all = noticesFor(["US-CA"]);
    expect(all.map((n) => n.key)).toEqual(expect.arrayContaining(["recording", "sms_consent", "ai_use", "privacy", "pay_transparency"]));
    const shown = candidateNotices(all).map((n) => n.key);
    expect(shown).not.toContain("recording");
    expect(shown).not.toContain("sms_consent");
    expect(shown).toEqual(expect.arrayContaining(["ai_use", "privacy", "pay_transparency"]));
  });

  it("the apply form shows the transparency block and the privacy link, never the recording notice, and with texting off no SMS checkbox; the job page promises an online conversation only", async () => {
    const page = await app.request(`/careers/${slug}/jobs/${roleId}/apply`);
    expect(page.status).toBe(200);
    const html = decodeEntities(await page.text());
    expect(html).toContain("Before you send");
    expect(html).toContain("<strong>Ledger Dental</strong> runs this hiring process and is the employer");
    // the match score is said before anyone applies (founder decision B2): worked out from what they send, and a person decides
    expect(html).toContain("works out a match score from what you send, checked against the job's requirements; the team sees what the score is based on, and a person always decides.");
    expect(html).toContain("What we collect:");
    expect(html).toContain("Why:");
    expect(html).toContain("Who can see it:");
    expect(html).toContain("Identified Talent Solutions recruiter only if Ledger Dental brings one in");
    expect(html).toContain("Your choices:");
    expect(html).toContain(`mailto:${container.env.PRIVACY_EMAIL}`);
    expect(html).toContain('<a href="/privacy">Read how we handle your information</a>');
    expect(html).toContain("People make the hiring decisions");
    expect(html).toContain("The pay range for this position is shown above as required by law");
    // the acknowledgment: present, required, unchecked
    const box = html.match(/<input id="acknowledged"[^>]*>/)![0];
    expect(box).toContain('name="acknowledged"');
    expect(box).toContain("required");
    expect(box).not.toContain("checked");
    expect(html).toContain("I have read the notice above and I understand that people, not software, make the hiring decisions.");
    // never the recording notice, and with texting off no consent box and no promise of texts
    expect(html).not.toContain("may be recorded");
    expect(html).not.toContain('name="smsConsent"');
    expect(html).not.toMatch(/text message/i);
    const versions = html.match(/name="noticeVersionsShown" value="([^"]*)"/)![1];
    expect(versions.split(",")).toEqual(expect.arrayContaining(["ai_use@2026-10-08", "privacy@2026-09-01", "pay_transparency@2026-09-01"]));
    expect(versions).not.toContain("recording@");
    expect(versions).not.toContain("sms_consent@");
    expect(html).toContain("up to 4 MB without JavaScript");
    // the facts header (Wave 0 item 0.8): the job, the employer, where, how, the kind of job and the pay the notice says is "shown above"
    const role = await roleRow();
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    const header = html.slice(0, html.indexOf("<form"));
    expect(header).toContain(`Apply: ${pv.packet.identity.title}`);
    expect(header).toContain("Ledger Dental");
    const loc = pv.packet.identity.locations[0];
    expect(header).toContain(`<span class="fact-text">${[loc.city, loc.region].filter(Boolean).join(", ")}</span>`);
    expect(header).toContain(`<span class="fact-text">${({ onsite: "On site", hybrid: "Hybrid", remote: "Remote" } as Record<string, string>)[pv.packet.identity.remotePolicy]}</span>`);
    expect(header).toContain('<span class="fact-text">Full time</span>');
    expect(header).toMatch(/<span class="fact-text">\$45–\$55 an hour<\/span>/);
    // how long it really takes (plan E8): the form and the written conversation that follows it in the same visit
    expect(header).toMatch(/About \d+ minutes, including a short written conversation with Ledger Dental's AI assistant\. First this form: upload a resume, or answer four short questions about your work instead\. No cover letter needed\./);
    // the pre-apply line: help, or a change to how to apply because of a disability, from a person (here the ITS inbox)
    expect(header).toContain(`Need help applying, or a change to how you apply because of a disability? Email <a href="mailto:${container.env.EMAIL_REPLY_TO}">`);
    // the four short questions instead of one box, behind a disclosure that works without script; closed until used
    expect(html).toContain("<summary>No resume? Answer four short questions instead</summary>");
    expect(html).toMatch(/<details class="no-resume">/);
    for (const name of ["nr_recentWork", "nr_dayToDay", "nr_skills", "nr_lookingFor"]) expect(html).toContain(`name="${name}"`);
    expect(html).not.toContain('name="noResume"');
    // every one of the four boxes is named by its own question and described by its hint, inside one named group (polish list)
    expect(html).toContain('<fieldset aria-describedby="no-resume-note"><legend class="sr-only">Four short questions about your work, instead of a resume</legend>');
    for (const [key, label] of [["recentWork", "Your most recent job or work"], ["dayToDay", "What you did day to day"], ["skills", "Skills, licenses or tools that fit this job"], ["lookingFor", "What you are looking for in your next job"]]) {
      expect(html).toContain(`<label id="nr_${key}-label" for="nr_${key}">${label}</label><textarea id="nr_${key}" name="nr_${key}" rows="3" maxlength="1000" aria-labelledby="nr_${key}-label" aria-describedby="nr_${key}-hint">`);
      expect(html).toContain(`<small id="nr_${key}-hint">`);
    }
    // no label on the form points at nothing, and every field a person fills in has one (the honeypot is hidden from everyone)
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/<label[^>]* for="([^"]+)"/g)) expect(ids.has(m[1]), `label for="${m[1]}"`).toBe(true);
    const labelled = new Set([...html.matchAll(/<label[^>]* for="([^"]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/<(textarea|select|input)\b([^>]*)>/g)) {
      const attrs = m[2];
      if (/type="(hidden|checkbox|radio)"/.test(attrs) || /name="website"/.test(attrs)) continue;
      expect(labelled.has(attrs.match(/ id="([^"]+)"/)?.[1] ?? ""), `${m[1]} ${attrs.slice(0, 60)}`).toBe(true);
    }
    expect(html).toMatch(/<input type="hidden" name="formOpened" value="v1\.[^"]+"/);
    // the job page
    const job = decodeEntities(await (await app.request(`/careers/${slug}/jobs/${roleId}`)).text());
    expect(job).toMatch(/Apply in about \d+ minutes, including a short written conversation with Ledger Dental's AI assistant\./);
    expect(job).not.toContain("by text");
    expect(job).not.toContain("may be recorded");
    expect(job).toContain('href="/privacy"');
  });

  let anaStatusToken = "";

  it("the acknowledgment is required: without it the form comes back with every value, answer and checkbox kept and the box marked; with it the acknowledgment is recorded with the server's notice versions", async () => {
    const select = eligibility.find((r) => r.type !== "schedule_availability")!;
    const refused = await apply(applyForm({ acknowledged: null, phone: "(949) 555-0100", [`elig_${select.key}`]: "no" }));
    expect(refused.status).toBe(400);
    const html = decodeEntities(await refused.text());
    expect(html).toContain("please confirm you have read the notice at the bottom of the form. Everything you entered is still here.");
    expect(html).toContain('value="Ana"');
    expect(html).toContain('value="Lopez"');
    expect(html).toContain('value="ana.lopez@example.com"');
    expect(html).toContain('value="(949) 555-0100"');
    expect(html).toContain('value="Irvine, CA"');
    expect(html).toContain("Registered Dental Hygienist at Coastal Family Dentistry since 2019");
    // the eligibility answers survive the round trip, including the "no"
    const selectHtml = html.match(new RegExp(`<select id="elig_${select.key}"[\\s\\S]*?</select>`))![0];
    expect(selectHtml).toContain('<option value="no" selected');
    expect(selectHtml).not.toContain('<option value="yes" selected');
    // the missing field is marked for assistive technology and the box is still unchecked
    const box = html.match(/<input id="acknowledged"[^>]*>/)![0];
    expect(box).toContain('aria-invalid="true"');
    expect(box).toContain('aria-describedby="acknowledged-error"');
    expect(box).not.toContain("checked");
    expect(html).toContain('id="acknowledged-error"');
    expect(await container.db.select().from(applications).where(eq(applications.roleId, roleId))).toHaveLength(0);

    // with the box ticked: the application is in, the acknowledgment recorded, and the notice versions are the server's, not the browser's claim
    const accepted = await apply(applyForm({ noticeVersionsShown: "made-up@1", smsConsent: "yes", phone: "(949) 555-0100" }), { "x-forwarded-for": "203.0.113.7" });
    expect(accepted.status).toBe(302);
    // straight on to the conversation's introduction (plan E1), never the status page: the link travels by email only (Wave 0 item 0.1)
    const screenPath = accepted.headers.get("location")!;
    expect(screenPath).toMatch(/^\/c\/screen\/[A-Za-z0-9_-]+$/);
    expect(setCookieOf(accepted)).toMatch(new RegExp(`ros_applied_to=v1\\.[^;]+; Max-Age=1800; Path=${screenPath.replace(/[/]/g, "\\/")}; HttpOnly; SameSite=Lax`));
    expect(setCookieOf(accepted)).not.toContain("ana.lopez");
    const intro = decodeEntities(await (await app.request(screenPath, { headers: { cookie: setCookieOf(accepted).match(/ros_applied_to=[^;,]+/)![0] } })).text());
    expect(intro).toContain("<strong>Your application is sent.</strong><p>Your own link to it is on its way to a***@example.com.");
    expect(intro).not.toContain("/c/status/");
    anaStatusToken = await statusTokenFor(container, { roleId, email: "ana.lopez@example.com" });
    await container.drain();
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(a.answers.noticeVersionsShown).toEqual(expect.arrayContaining(["ai_use@2026-10-08", "privacy@2026-09-01", "pay_transparency@2026-09-01"]));
    expect(a.answers.noticeVersionsShown).not.toContain("made-up@1");
    expect(a.answers.noticeVersionsShown!.join(",")).not.toMatch(/recording|sms_consent/);
    expect(a.answers.acknowledgment).toMatchObject({ ip: "203.0.113.7", noticeVersions: a.answers.noticeVersionsShown });
    expect(Date.parse(a.answers.acknowledgment!.at)).toBe(BASE);
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.id, a.candidateId));
    expect(cand.consent.application_terms).toMatchObject({ granted: true, acknowledged: true, source: "careers_page_apply", ip: "203.0.113.7" });
    // texting is off: the posted consent is ignored, nothing recorded, no event, and the acknowledgment email promises an online conversation only
    expect(cand.consent.sms).toBeUndefined();
    expect(await eventsOf("consent.granted")).toHaveLength(0);
    const [scr] = await container.db.select().from(screens).where(eq(screens.applicationId, a.id));
    expect(scr).toMatchObject({ channel: "web", invitedVia: "apply" });
    expect(screenPath).toBe(`/c/screen/${scr.token}`);
    // the acknowledgment says honestly what comes next, with the conversation's link to come back to (plans E1, E8)
    const ack = emails().find((m) => m.to === "ana.lopez@example.com" && /received your application/.test(m.subject))!;
    expect(ack.text).toMatch(/1\. A short written conversation with Ledger Dental's AI assistant: \d+ questions, about \d+ minutes\. It is not a test, and you can skip a question or ask for a person instead\. If you have not finished it, pick it up here: https:\/\/jobs\.example\.test\/c\/screen\//);
    expect(ack.text).toContain(`https://jobs.example.test/c/screen/${scr.token}`);
    expect(ack.text).not.toMatch(/by text|looks like a fit/);
    // the status page and the screen page: no text-message choice, no recording notice
    const status = decodeEntities(await (await app.request(`/c/status/${anaStatusToken}`)).text());
    expect(status).not.toContain("Text messages");
    expect(status).not.toContain("may be recorded");
    const screen = decodeEntities(await (await app.request(`/c/screen/${scr.token}`)).text());
    expect(screen).not.toContain("may be recorded");
    expect(screen).toContain("artificial intelligence");
  });

  it("with texting on, the SMS checkbox is on the form, the consent is recorded, and on the later path the pages say by text or online", async () => {
    const c2 = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", SMS_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test", SMS_ENABLED: "true" } });
    try {
      const a2 = createApp(c2);
      const cookie = await signIn(a2, "owner@texting.test");
      const seeded = await seedRole(c2, a2, cookie, "Texting Dental");
      // a conversation offered with the application is always on the web; texts belong to "form now, conversation later" (plan Wave E)
      const sameVisit = decodeEntities(await (await a2.request(`/careers/${seeded.slug}/jobs/${seeded.roleId}`)).text());
      expect(sameVisit).toContain("including a short written conversation with Texting Dental's AI assistant");
      expect(sameVisit).not.toContain("by text");
      await useLaterApplyFlow(c2, seeded.companyId);
      const form = decodeEntities(await (await a2.request(`/careers/${seeded.slug}/jobs/${seeded.roleId}/apply`)).text());
      const box = form.match(/<input type="checkbox" name="smsConsent"[^>]*>/)?.[0];
      expect(box).toBeTruthy();
      expect(box).not.toContain("checked");
      expect(form).toContain("Yes, you may send me text messages about this application");
      expect(form.match(/name="noticeVersionsShown" value="([^"]*)"/)![1]).toContain("sms_consent@2026-09-01");
      expect(form).not.toContain("may be recorded");
      const job = decodeEntities(await (await a2.request(`/careers/${seeded.slug}/jobs/${seeded.roleId}`)).text());
      expect(job).toContain("Possibly a short written conversation with Texting Dental's AI assistant (by text or online, about");
      const r = await apply(applyForm({ smsConsent: "yes", phone: "(949) 555-0100" }, seeded.eligibility), {}, a2, `/careers/${seeded.slug}/jobs/${seeded.roleId}/apply`);
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe(`/careers/${seeded.slug}/jobs/${seeded.roleId}/applied`);
      await c2.drain();
      const [a] = await c2.db.select().from(applications).where(eq(applications.roleId, seeded.roleId));
      const [cand] = await c2.db.select().from(candidates).where(eq(candidates.id, a.candidateId));
      expect(cand.consent.sms).toMatchObject({ granted: true, source: "careers_page_apply" });
      expect(a.answers.noticeVersionsShown).toContain("sms_consent@2026-09-01");
      expect(await c2.db.select().from(events).where(eq(events.type, "consent.granted"))).toHaveLength(1);
      const ack = (c2.integrations.email as FakeEmailAdapter).sent.find((m) => m.to === "ana.lopez@example.com" && /received your application/.test(m.subject))!;
      expect(ack.text).toContain("1. Possibly a short written conversation with Texting Dental's AI assistant (by text or online, about");
      expect(ack.text).toContain("If so, we email you the link.");
      expect(ack.text).not.toMatch(/looks like a fit/);
      const status = decodeEntities(await (await a2.request(`/c/status/${await statusTokenFor(c2, { roleId: seeded.roleId, email: "ana.lopez@example.com" })}`)).text());
      expect(status).toContain("Text messages:");
      expect(status).toContain("on");
    } finally {
      await c2.close();
    }
  });

  let linkToken = "";
  let linkId = "";

  it("a tracked link counts the visit, seals the source into a cookie and opens the job page (a board's link opens the form); the application records the source, the detail and the link, the token appears nowhere, and the cookie is cleared", async () => {
    const link = await withTenant(container.db, companyId, (tx) => createApplicationLink(tx, { companyId, roleId, source: "referral", sourceDetail: "Dr. Patel", label: "Referral: Dr. Patel", actor: ownerActor, now: container.engine.clock() }));
    linkToken = link.token;
    linkId = link.id;
    const urls = jobUrls(container.env, { slug, roleId });
    const visit = await app.request(`/a/${link.token}`);
    expect(visit.status).toBe(302);
    // a shared link opens the job page first (plan D8)
    expect(visit.headers.get("location")).toBe(urls.job);
    const cookie = setCookieOf(visit);
    expect(cookie).toMatch(/^ros_src=v1\./);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain(link.token);
    const sealed = cookieValue(visit);
    expect(Buffer.from(sealed.split(".")[2] ?? "", "base64url").toString("utf8")).not.toContain(link.token);
    const [after] = await container.db.select().from(applicationLinks).where(eq(applicationLinks.id, link.id));
    expect(after.visits).toBe(1);
    expect(after.lastVisitedAt).toBeTruthy();
    // the form, posted with the cookie
    const before = (await container.db.select().from(applications).where(eq(applications.roleId, roleId))).length;
    const r = await apply(applyForm({ firstName: "Ben", lastName: "Osei", email: "ben.osei@example.com" }), { cookie: `ros_src=${sealed}` });
    expect(r.status).toBe(302);
    expect(setCookieOf(r)).toMatch(/ros_src=;.*Max-Age=0/);
    await container.drain();
    const rows = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(rows).toHaveLength(before + 1);
    const a = rows.find((x) => x.linkId === link.id)!;
    expect(a).toMatchObject({ source: "referral", sourceDetail: "Dr. Patel", linkId: link.id });
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.id, a.candidateId));
    expect(cand.firstSource).toBe("referral");
    const comms = await container.db.select().from(communications).where(eq(communications.applicationId, a.id));
    expect(comms.length).toBeGreaterThan(0);
    for (const record of [a, cand, ...comms]) expect(JSON.stringify(record)).not.toContain(link.token);
    const status = await app.request(`/c/status/${a.statusToken}`);
    expect(status.status).toBe(200);
    expect(await status.text()).not.toContain(link.token);
    const ack = emails().find((m) => m.to === "ben.osei@example.com" && /received your application/.test(m.subject))!;
    expect(`${ack.subject}\n${ack.text}`).not.toContain(link.token);
    expect((await eventsOf("application.received")).find((e) => e.subjectId === a.id)?.payload).toMatchObject({ source: "referral", linkId: link.id });
    // a board's own link works the same way and names the board
    const indeed = (await container.db.select().from(postings).where(and(eq(postings.roleId, roleId), eq(postings.channel, "indeed"))))[0];
    const board = (await findPostingLink(container.db, indeed.id))!;
    const boardVisit = await app.request(`/a/${board.token}`);
    expect(boardVisit.status).toBe(302);
    expect(boardVisit.headers.get("location")).toBe(urls.apply);
    const r2 = await apply(applyForm({ firstName: "Cara", lastName: "Diaz", email: "cara.diaz@example.com" }), { cookie: `ros_src=${cookieValue(boardVisit)}` });
    expect(r2.status).toBe(302);
    const cara = (await container.db.select().from(applications).where(eq(applications.roleId, roleId))).find((x) => x.linkId === board.id)!;
    expect(cara).toMatchObject({ source: "indeed", sourceDetail: null });
  });

  it("an unknown, malformed or disabled token answers a plain 404 and counts nothing; a cookie sealed for another role falls back to the careers page", async () => {
    for (const bad of ["zzzzzzzzzzzz", "nope", `${linkToken}x`, "../a/b"]) {
      const r = await app.request(`/a/${bad}`);
      expect(r.status, bad).toBe(404);
      expect(await r.text()).toContain("This link is not active");
      expect(setCookieOf(r)).not.toContain("ros_src");
    }
    const disabled = await withTenant(container.db, companyId, (tx) => disableApplicationLink(tx, { linkId, companyId, actor: ownerActor, now: container.engine.clock() }));
    expect(disabled?.disabledAt).toBeTruthy();
    const r = await app.request(`/a/${linkToken}`);
    expect(r.status).toBe(404);
    expect((await container.db.select().from(applicationLinks).where(eq(applicationLinks.id, linkId)))[0].visits).toBe(1);
    // a cookie that names another role is ignored: the application is a plain careers-page one
    const foreign = sealPayload("application-source", { v: 1, linkId, source: "referral", sourceDetail: "Dr. Patel", roleId: "00000000-0000-0000-0000-000000000000", exp: container.engine.clock().getTime() + 60_000 }, container.env.SESSION_SECRET);
    const applied = await apply(applyForm({ firstName: "Dee", lastName: "Fox", email: "dee.fox@example.com" }), { cookie: `ros_src=${foreign}` });
    expect(applied.status).toBe(302);
    const [cand] = await container.db.select().from(candidates).where(and(eq(candidates.companyId, companyId), eq(candidates.email, "dee.fox@example.com")));
    expect(cand.firstSource).toBe("careers_page");
    const [dee] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id)));
    expect(dee).toMatchObject({ source: "careers_page", sourceDetail: null, linkId: null });
  });

  it("without JavaScript a resume over 4 MB is refused with a plain message instead of a platform error", async () => {
    const big = new File([new Uint8Array(4 * 1024 * 1024 + 1).fill(97)], "big.txt", { type: "text/plain" });
    const fd = applyForm({ firstName: "Eve", lastName: "Long", email: "eve.long@example.com", noResume: null });
    fd.set("resume", big);
    const r = await apply(fd);
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain("Files over 4 MB can only be sent by the direct upload");
    expect(html).toContain('value="Eve"');
  });

  it("once an interview is booked the status page says what to prepare, from the round's purpose", async () => {
    const [a] = await container.db.select().from(applications).where(eq(applications.statusToken, anaStatusToken));
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, a.packetVersion)));
    const round = pv.packet.interviews.plan[0];
    const startsAt = new Date(BASE + 3 * 86_400_000).toISOString();
    await container.db.insert(interviews).values({ companyId, applicationId: a.id, roundKey: round.key, title: round.title, format: round.format, durationMinutes: round.durationMinutes, status: "scheduled", startsAt, endsAt: new Date(BASE + 3 * 86_400_000 + round.durationMinutes * 60_000).toISOString(), scheduleToken: randomToken(24), timezone: "America/Los_Angeles", createdBy: ownerActor });
    const html = decodeEntities(await (await app.request(`/c/status/${anaStatusToken}`)).text());
    expect(html).toContain(`Your interview: ${round.title}`);
    expect(html).toContain("What to prepare:");
    expect(html).toContain(round.purpose);
    expect(html).toContain("Details, calendar file, reschedule or cancel");
  });

  it("the accepting switch and a pause keep the job page up and say so, close the form, send tracked links to the job page, and hold an email-in application for the owner", async () => {
    const urls = jobUrls(container.env, { slug, roleId });
    const emailIn = (await container.db.select().from(postings).where(and(eq(postings.roleId, roleId), eq(postings.channel, "email_in"))))[0];
    const indeed = (await container.db.select().from(postings).where(and(eq(postings.roleId, roleId), eq(postings.channel, "indeed"))))[0];
    const board = (await findPostingLink(container.db, indeed.id))!;
    const inbound = (name: string, resumeText?: string) => app.request("/webhooks/postmark/inbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ From: "noreply@indeed.com", FromName: "Indeed", To: `apply-${emailIn.intakeToken}@${container.integrations.env.intakeDomain}`, Subject: `New applicant: ${name}`, TextBody: `${name} applied via Indeed.\nEmail: ${name.toLowerCase().replace(" ", ".")}@example.com`, Attachments: resumeText ? [{ Name: "resume.txt", ContentType: "text/plain", Content: Buffer.from(resumeText).toString("base64"), ContentLength: resumeText.length }] : [] }) });
    const closedChecks = async (label: string) => {
      const page = await app.request(urls.job.replace("https://jobs.example.test", ""));
      expect(page.status, label).toBe(200);
      const html = decodeEntities(await page.text());
      expect(html, label).toContain("This position is not taking new applications right now.");
      expect(html, label).not.toContain("Apply now");
      expect(html, label).toContain('"@type":"JobPosting"');
      expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`)).status, label).toBe(404);
      expect((await apply(applyForm({ firstName: "Gus", lastName: "Hale", email: `gus.${label}@example.com` }))).status, label).toBe(404);
      expect((await app.request(`/careers/${slug}/jobs/${roleId}/upload-intent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "a.txt", size: 10, type: "text/plain" }) })).status, label).toBe(404);
      const visit = await app.request(`/a/${board.token}`);
      expect(visit.status, label).toBe(302);
      expect(visit.headers.get("location"), label).toBe(urls.job);
      // the careers index keeps listing a role whose switch is off (with the plain note); a paused role is not listed there, as before
      const careers = await (await app.request(`/careers/${slug}`)).text();
      if (label === "switch") {
        expect(careers).toContain("View details");
        expect(careers).toContain("Not taking new applications right now.");
      } else {
        expect(careers).toContain("No open positions right now.");
      }
      // email-in: held, the owner told, nothing created; the second email carries a résumé, which is parked with the row
      const before = (await container.db.select().from(applications).where(eq(applications.roleId, roleId))).length;
      const notesBefore = (await container.db.select().from(notifications).where(eq(notifications.kind, "application.email_held"))).length;
      const r = await inbound(`Held ${label}`, label === "paused" ? "Held Paused, registered dental hygienist since 2018, active CA RDH license." : undefined);
      expect(r.status, label).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true, matched: true, held: true });
      const held = (await container.db.select().from(inboundEmails).where(eq(inboundEmails.status, "held"))).filter((m) => m.subject === `New applicant: Held ${label}`);
      expect(held, label).toHaveLength(1);
      expect(held[0].companyId, label).toBe(companyId);
      expect(held[0].applicationId, label).toBeNull();
      if (label === "paused") {
        expect(held[0].rawStorageKey, label).toMatch(new RegExp(`^inbound/${companyId}/`));
        expect(await container.integrations.storage.head(held[0].rawStorageKey!), label).toMatchObject({ contentType: "text/plain" });
        expect(held[0].parsed, label).toMatchObject({ fromName: "Indeed", resume: { filename: "resume.txt", contentType: "text/plain" } });
      } else {
        expect(held[0].rawStorageKey, label).toBeNull();
      }
      expect((await container.db.select().from(applications).where(eq(applications.roleId, roleId))).length, label).toBe(before);
      const notes = await container.db.select().from(notifications).where(eq(notifications.kind, "application.email_held"));
      if (label === "switch") {
        expect(notes.length, label).toBe(notesBefore + 1);
        expect(notes.at(-1)!.title).toBe("An application arrived by email while applications are closed");
        expect(notes.at(-1)!.body).toContain("It is held, not rejected.");
        expect(notes.at(-1)!.body).toContain("added to the role's applications on its own");
      } else {
        // a second email while the first notice is still unread updates that notice with the count instead of adding another
        expect(notes.length, label).toBe(notesBefore);
        expect(notes.at(-1)!.title).toBe("2 applications arrived by email while applications are closed");
        expect(notes.at(-1)!.body).toContain("2 people emailed applications");
        expect(notes.at(-1)!.body).toContain("the role is paused");
      }
      expect(notes.at(-1)!.readAt).toBeNull();
      expect(notes.at(-1)!.body).not.toContain("@example.com");
      expect(notes.at(-1)!.body).not.toContain("send it again");
    };
    await setAccepting(false);
    await closedChecks("switch");
    await setAccepting(true);
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/pause`, {})).status).toBe(200);
    expect((await roleRow()).status).toBe("paused");
    await closedChecks("paused");
    const fromEmailBefore = (await container.db.select().from(applications).where(eq(applications.roleId, roleId))).filter((x) => x.source === "email_in").length;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/resume`, {})).status).toBe(200);
    await container.drain();
    const open = decodeEntities(await (await app.request(urls.job.replace("https://jobs.example.test", ""))).text());
    expect(open).toContain("Apply now");
    expect(open).not.toContain("not taking new applications");
    // resuming replayed the two held emails: both are applications now, nobody had to send anything again, the parked
    // résumé travelled with its application and left storage, and the team's notice says what happened
    const replayed = (await container.db.select().from(inboundEmails).where(eq(inboundEmails.companyId, companyId))).filter((m) => m.subject?.startsWith("New applicant: Held "));
    expect(replayed.map((m) => m.status)).toEqual(["matched", "matched"]);
    expect(replayed.every((m) => !!m.applicationId && m.rawStorageKey === null)).toBe(true);
    expect(await container.integrations.storage.list("inbound/")).toEqual([]);
    const fromEmail = (await container.db.select().from(applications).where(eq(applications.roleId, roleId))).filter((x) => x.source === "email_in");
    expect(fromEmail.length).toBe(fromEmailBefore + 2);
    const withResume = fromEmail.find((x) => x.id === replayed.find((m) => m.subject === "New applicant: Held paused")!.applicationId)!;
    expect(withResume.resumeDocumentId).toBeTruthy();
    expect((await container.db.select().from(candidates).where(eq(candidates.id, withResume.candidateId)))[0].email).toBe("held.paused@example.com");
    expect((await container.db.select().from(inboundEmails).where(eq(inboundEmails.status, "held"))).length).toBe(0);
    const told = (await container.db.select().from(notifications).where(eq(notifications.kind, "application.email_held"))).at(-1)!;
    expect(told.title).toMatch(/^2 held email applications were added to /);
    expect(told.body).toContain("have been added to the role's applications");
    expect(told.body).not.toContain("@example.com");
    // a fresh email now becomes an application straight away
    const r = await inbound("Hana Ito");
    expect(await r.json()).toMatchObject({ ok: true, matched: true });
    expect((await container.db.select().from(applications).where(eq(applications.roleId, roleId))).filter((x) => x.source === "email_in").length).toBe(fromEmailBefore + 3);
  });

  it("the sitemap, robots and both feeds list only open roles that accept applications, escape text, carry the publisher and canonical URLs, and are rebuilt every five minutes", async () => {
    await container.db.update(companies).set({ name: "Ledger & Sons <Dental>" }).where(eq(companies.id, companyId));
    resetPublicFeedCache(container);
    const urls = jobUrls(container.env, { slug, roleId });
    const role = await roleRow();
    const datePosted = (role.openedAt ?? role.createdAt).slice(0, 10);
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    const loc = pv.packet.identity.locations[0]!;
    // sitemap
    const sitemap = await app.request("/sitemap.xml");
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("content-type")).toContain("application/xml");
    expect(sitemap.headers.get("cache-control")).toBe("public, max-age=300");
    const sitemapXml = await sitemap.text();
    expect(sitemapXml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemapXml.match(/<url>/g)).toHaveLength(2);
    expect(sitemapXml).toContain(`<loc>${urls.careers}</loc>`);
    expect(sitemapXml).toContain(`<loc>${urls.job}</loc>`);
    expect(sitemapXml).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T[^<]+<\/lastmod>/);
    expect(sitemapXml).not.toContain("/apply");
    expect(sitemapXml).not.toContain("/a/");
    // robots
    const robots = await (await app.request("/robots.txt")).text();
    expect(robots).toContain("Allow: /careers/");
    for (const d of ["/c/", "/api/", "/a/", "/files/", "/dev/", "/webhooks/"]) expect(robots).toContain(`Disallow: ${d}`);
    expect(robots).toContain("Sitemap: https://jobs.example.test/sitemap.xml");
    // the common job-board XML
    const xmlRes = await app.request("/feeds/jobs.xml");
    expect(xmlRes.headers.get("content-type")).toContain("application/xml");
    const xml = await xmlRes.text();
    expect(xml).toContain("<publisherurl><![CDATA[https://jobs.example.test]]></publisherurl>");
    expect(xml).toContain(`<publisher><![CDATA[${container.env.PRODUCT_NAME}]]></publisher>`);
    expect(xml.match(/<job>/g)).toHaveLength(1);
    expect(xml).toContain("<company><![CDATA[Ledger & Sons <Dental>]]></company>");
    expect(xml).toContain(`<url><![CDATA[${urls.job}]]></url>`);
    expect(xml).toContain(`<applyurl><![CDATA[${urls.apply}]]></applyurl>`);
    expect(xml).toContain(`<referencenumber><![CDATA[${roleId}]]></referencenumber>`);
    expect(xml).toContain(`<date><![CDATA[${datePosted}]]></date>`);
    // an open role with no closing date carries no invented end date (Wave 0 item 0.8)
    expect(xml).not.toContain("<expirationdate>");
    expect(xml).toContain("<jobtype><![CDATA[full-time]]></jobtype>");
    expect(xml).toContain(`<title><![CDATA[${pv.packet.identity.title}]]></title>`);
    expect(xml).toContain(`<city><![CDATA[${loc.city ?? ""}]]></city>`);
    expect(xml).toContain(`<state><![CDATA[${loc.region ?? ""}]]></state>`);
    expect(xml).toContain(`<country><![CDATA[${loc.country ?? "US"}]]></country>`);
    expect(xml).toContain("<category><![CDATA[dental]]></category>");
    expect(xml).toMatch(/<salary><!\[CDATA\[USD 45-55 per hour\]\]><\/salary>/);
    expect(xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")).not.toContain("<Dental>"); // nothing unescaped outside CDATA
    // the same as JSON
    const jsonRes = await app.request("/feeds/jobs.json");
    expect(jsonRes.headers.get("content-type")).toContain("application/json");
    const feed = (await jsonRes.json()) as { publisher: string; publisherUrl: string; lastBuildDate: string; jobs: Array<Record<string, unknown>> };
    expect(feed.publisherUrl).toBe("https://jobs.example.test");
    expect(feed.jobs).toHaveLength(1);
    expect(feed.jobs[0]).toMatchObject({ referenceNumber: roleId, title: pv.packet.identity.title, url: urls.job, applyUrl: urls.apply, company: "Ledger & Sons <Dental>", hiringOrganization: { name: "Ledger & Sons <Dental>" }, city: loc.city ?? null, state: loc.region ?? null, country: loc.country ?? "US", datePosted, employmentType: "FULL_TIME", jobType: "full-time", category: "dental", remote: false });
    expect(feed.jobs[0]).not.toHaveProperty("validThrough");
    expect(feed.jobs[0].salary).toMatchObject({ minValue: 45, maxValue: 55, currency: "USD", unitText: "HOUR" });
    expect(JSON.stringify(feed)).not.toMatch(/ana\.lopez|ben\.osei|ros_src/);
    // LinkedIn keeps working, with the publisher URL and each job's canonical page
    const linkedin = await (await app.request("/feeds/linkedin.xml")).text();
    expect(linkedin).toContain("<publisherUrl><![CDATA[https://jobs.example.test]]></publisherUrl>");
    expect(linkedin).toContain(`<applyUrl><![CDATA[${urls.job}]]></applyUrl>`);
    expect(linkedin).toContain(`<partnerJobId><![CDATA[${roleId}]]></partnerJobId>`);
    expect(linkedin).toContain("<company><![CDATA[Ledger & Sons <Dental>]]></company>");
    // the cache: a change shows up after five minutes, not before
    await setAccepting(false);
    expect((await (await app.request("/feeds/jobs.xml")).text()).match(/<job>/g)).toHaveLength(1);
    expect((await (await app.request("/sitemap.xml")).text()).match(/<url>/g)).toHaveLength(2);
    setClock(PUBLIC_FEED_CACHE_MS + 1000);
    expect((await (await app.request("/feeds/jobs.xml")).text()).match(/<job>/g)).toBeNull();
    expect(((await (await app.request("/feeds/jobs.json")).json()) as { jobs: unknown[] }).jobs).toHaveLength(0);
    expect((await (await app.request("/sitemap.xml")).text()).match(/<url>/g)).toBeNull();
    expect((await (await app.request("/feeds/linkedin.xml")).text()).match(/<job>/g)).toBeNull();
    await setAccepting(true);
    resetPublicFeedCache(container);
    expect((await (await app.request("/feeds/jobs.xml")).text()).match(/<job>/g)).toHaveLength(1);
    setClock(0);
    await container.db.update(companies).set({ name: "Ledger Dental" }).where(eq(companies.id, companyId));
    resetPublicFeedCache(container);
  });

  it("pay is shown wherever a pay transparency law covers the job, even if the packet says not to, on the job page, the form, the structured data and the feeds", async () => {
    const role = await roleRow();
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    const hidden = { ...pv.packet, compensation: { ...pv.packet.compensation, discloseRange: false } };
    await container.db.update(rolePackets).set({ packet: hidden }).where(eq(rolePackets.id, pv.id));
    resetPublicFeedCache(container);
    try {
      // Irvine, CA: the pay transparency notice applies and says the range is "shown above", so it is
      const page = decodeEntities(await (await app.request(`/careers/${slug}/jobs/${roleId}`)).text());
      expect(page).toContain("The pay range for this position is shown above as required by law");
      expect(page).toMatch(/<span class="fact-text">\$45–\$55 an hour<\/span>/);
      expect(jsonLdOf(page).baseSalary).toMatchObject({ currency: "USD", value: { minValue: 45, maxValue: 55, unitText: "HOUR" } });
      const form = decodeEntities(await (await app.request(`/careers/${slug}/jobs/${roleId}/apply`)).text());
      expect(form.slice(0, form.indexOf("<form"))).toMatch(/<span class="fact-text">\$45–\$55 an hour<\/span>/);
      expect(await (await app.request("/feeds/jobs.xml")).text()).toMatch(/<salary><!\[CDATA\[USD 45-55 per hour\]\]><\/salary>/);
      // and the owner's role page says the same, with the reason, instead of "not shown"
      const roleView = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { payShown: boolean; payRequiredByLaw: boolean; packet: { compensation: { discloseRange: boolean } } } };
      expect(roleView.currentPacket).toMatchObject({ payShown: true, payRequiredByLaw: true, packet: { compensation: { discloseRange: false } } });
    } finally {
      await container.db.update(rolePackets).set({ packet: pv.packet }).where(eq(rolePackets.id, pv.id));
      resetPublicFeedCache(container);
    }
  });

  it("the JobPosting data carries no invented end date while the role is open, the day it stopped while paused or switched off, names the employer's website and logo, and shows the closing day once the role is closed", async () => {
    const urls = jobUrls(container.env, { slug, roleId });
    const path = urls.job.replace("https://jobs.example.test", "");
    const role = await roleRow();
    const datePosted = (role.openedAt ?? role.createdAt).slice(0, 10);
    const open = jsonLdOf(await (await app.request(path)).text());
    expect(open).toMatchObject({ "@type": "JobPosting", datePosted, employmentType: "FULL_TIME", url: urls.job, directApply: true });
    expect(open).not.toHaveProperty("validThrough");
    expect(open.hiringOrganization).toMatchObject({ name: "Ledger Dental", sameAs: "https://ledgerdental.example", logo: "https://ledgerdental.example/logo.png" });
    // the accepting switch off: the day it was switched off
    await setAccepting(false);
    const switchedOff = await roleRow();
    expect(jsonLdOf(await (await app.request(path)).text()).validThrough).toBe(jobValidThrough({ stoppedAt: switchedOff.applicationsClosedAt }));
    await setAccepting(true);
    // paused: the block stays, ending the day the role was paused
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/pause`, {})).status).toBe(200);
    const pausedRole = await roleRow();
    const paused = jsonLdOf(await (await app.request(path)).text());
    expect(paused).toMatchObject({ "@type": "JobPosting", validThrough: new Date(pausedRole.pausedAt!).toISOString().slice(0, 10) });
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/resume`, {})).status).toBe(200);
    await container.drain();
    expect(jsonLdOf(await (await app.request(path)).text())).not.toHaveProperty("validThrough");
    // closed: the page stays up, says so, and the block carries the closing day
    setClock(2 * 86_400_000);
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/outcome`, { outcome: "role_cancelled", confirm: true, reason: "Budget pulled." })).status).toBe(200);
    const closedRole = await roleRow();
    expect(closedRole.status).toBe("closed");
    const page = await app.request(path);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("This position is closed and no longer taking applications.");
    expect(html).not.toContain("Apply now");
    const closed = jsonLdOf(html);
    expect(closed.validThrough).toBe(new Date(closedRole.closedAt ?? closedRole.updatedAt).toISOString().slice(0, 10));
    expect(closed.employmentType).toBe("FULL_TIME");
    expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`)).status).toBe(404);
    resetPublicFeedCache(container);
    expect((await (await app.request("/feeds/jobs.xml")).text()).match(/<job>/g)).toBeNull();
    expect((await (await app.request("/sitemap.xml")).text()).match(/<url>/g)).toBeNull();
    setClock(0);
  });
});
