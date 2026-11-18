import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { candidateNotices, noticesFor } from "@ros/core";
import { applications, candidates, companies, events, rolePackets, roles, screens } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { jobValidThrough } from "./pages/job-structured-data";
import { SITEMAP_CACHE_MS, resetSitemapCache, robotsTxt } from "./pages/sitemap";
import { ASKED_OF_EVERYONE, questionHelp, withPlainQuestionHelp } from "./pages/question-help";
import { jobUrls } from "./services/job-urls";
import { pastTheWaitingRoom, statusTokenFor, useOneVisitApplyFlow, usePlan } from "./test-helpers";

/**
 * The candidate-facing job surfaces (docs/spec/20 section 2; docs/readiness/20 section D): the apply form's
 * transparency block and affirmative acknowledgment; no consent box and no promise of texts; the recording notice
 * never shown; the sitemap and robots; and the JobPosting data.
 */
describe("public job surfaces: the apply form, the sitemap and structured data", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
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
    // More people apply to one job here than Free's five, and these pages are about a job open to anyone: a plan with no candidate limit.
    await usePlan(c, co.id, "ultra");
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
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    setClock(0);
    owner = await signIn(app, "owner@ledger.test");
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

  it("the apply form's line under an eligibility question: the job's own reason when it reads well, else 'Asked of everyone applying for this job.'; the stored packet keeps its words", () => {
    expect(questionHelp("The owner stated the work model in the packet.")).toBe(ASKED_OF_EVERYONE);
    expect(ASKED_OF_EVERYONE).toBe("Asked of everyone applying for this job.");
    expect(questionHelp("The owner stated the work model and travel in the Role Packet.")).toBe(ASKED_OF_EVERYONE);
    expect(questionHelp("Taken from the dental playbook.")).toBe(ASKED_OF_EVERYONE);
    expect(questionHelp("  ")).toBe(ASKED_OF_EVERYONE);
    expect(questionHelp(null)).toBe(ASKED_OF_EVERYONE);
    expect(questionHelp("Coverage is the reason for the hire.")).toBe("The job needs someone for this schedule.");
    expect(questionHelp("Required for clinical staff; can be obtained before start if the owner allows.")).toBe("Required for clinical staff; can be obtained before start if the employer allows.");
    expect(questionHelp("The owner needs coverage by the target date.")).toBe("The employer needs coverage by the target date.");
    // a reason that reads well is shown as it was written
    for (const fine of ["Required by law to practice dental hygiene.", "Required for employment; asked of every candidate.", "The desk must be covered during clinic hours."]) expect(questionHelp(fine)).toBe(fine);
    const packet = { requirements: { mustHaves: [], niceToHaves: [], eligibility: [{ key: "schedule", type: "schedule_availability" as const, question: "Are you available?", expectation: {}, rationale: "The owner stated the work model in the packet.", knockout: true }] } };
    const shown = withPlainQuestionHelp(packet);
    expect(shown.requirements.eligibility[0]).toMatchObject({ key: "schedule", question: "Are you available?", rationale: ASKED_OF_EVERYONE, knockout: true });
    expect(packet.requirements.eligibility[0].rationale).toBe("The owner stated the work model in the packet.");
  });

  it("candidateNotices leaves the recording notice out of what a page renders and records", () => {
    const all = noticesFor(["US-CA"]);
    expect(all.map((n) => n.key)).toEqual(expect.arrayContaining(["recording", "ai_use", "privacy", "pay_transparency"]));
    const shown = candidateNotices(all).map((n) => n.key);
    expect(shown).not.toContain("recording");
    expect(shown).toEqual(expect.arrayContaining(["ai_use", "privacy", "pay_transparency"]));
  });

  it("the apply form shows the transparency block and the privacy link, never the recording notice, and no SMS checkbox; the job page promises an online conversation only", async () => {
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
    expect(html).toContain("I have read the full notice above and I understand that people, not software, make the hiring decisions.");
    // the first view is three short lines and the privacy link; every word of the notice, the notices included, sits under
    // "Read the full notice", above the box that says it was read (founder brief, 14 October 2026)
    const block = html.slice(html.indexOf('<h2 id="before-you-send">'), html.indexOf('<label class="check" for="acknowledged">'));
    expect(block).toContain("<ul class=\"steps\"><li>People at Ledger Dental make every hiring decision.</li><li>Software helps organize applications and works out a match score.</li><li>You can ask for a person at any time.</li></ul><p><a href=\"/privacy\">Read how we handle your information</a></p><details class=\"more\"><summary>Read the full notice</summary><p><strong>Ledger Dental</strong> runs this hiring process");
    const full = block.slice(block.indexOf("<summary>Read the full notice</summary>"));
    for (const words of ["What we collect:", "Why:", "Who can see it:", "Your choices:", "People make the hiring decisions", "The pay range for this position is shown above as required by law", '<a href="/privacy">Read how we handle your information</a>']) expect(full).toContain(words);
    expect(full.endsWith("</details>")).toBe(true);
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
    // how long it really takes (plan E8): the form and the AI interview that follows it (20 Oct 2026)
    expect(header).toMatch(/About \d+ minutes, including a short AI interview with Ledger Dental's AI assistant\. First, this form; no cover letter needed\./);
    // the pre-apply line: help, or a change to how to apply because of a disability, from a person (here the ITS inbox)
    expect(header).toContain(`Need help applying, or a change to how you apply because of a disability? Email <a href="mailto:${container.env.EMAIL_REPLY_TO}">`);
    // the four short questions instead of one box, behind a disclosure that works without script; closed until used
    expect(html).toContain("<summary>No resume? Answer four short questions instead</summary>");
    expect(html).toMatch(/<details class="no-resume">/);
    for (const name of ["nr_recentWork", "nr_dayToDay", "nr_skills", "nr_lookingFor"]) expect(html).toContain(`name="${name}"`);
    expect(html).not.toContain('name="noResume"');
    // every one of the four boxes is named by its own question and described by its hint, inside one named group (polish list)
    expect(html).toContain('<fieldset aria-describedby="no-resume-note"><legend class="sr-only">Four short questions about your work, instead of a resume</legend>');
    // the group's note says what is enough; "no cover letter" is said once, in the lead (fewer words, 23 October 2026)
    expect(html).toContain('<p class="meta" id="no-resume-note">Answer what you can; one answer is enough to apply.</p>');
    expect(html).not.toContain("Nobody expects a cover letter.");
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
    // the line under each eligibility question is in plain words (Wave S2, K4): the job's own reason when it reads well
    // to an applicant, never the team's words; each question still points at its line
    const why = [...html.matchAll(/<small id="elig_([^"]+)-why">([^<]*)<\/small>/g)];
    expect(why.map((m) => m[1]).sort()).toEqual(eligibility.map((r) => r.key).sort());
    for (const [, key, line] of why) {
      expect(line, key).not.toMatch(/packet|owner|intake|playbook|for the hire/i);
      expect(html).toContain(`aria-describedby="elig_${key}-why"`);
    }
    expect(why.map((m) => m[2])).toContain("The job needs someone for this schedule.");
    // the job page
    const job = decodeEntities(await (await app.request(`/careers/${slug}/jobs/${roleId}`)).text());
    expect(job).toMatch(/About \d+ minutes, including a short AI interview with Ledger Dental's AI assistant\./);
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
    // (Wave S7: a yes-or-no question is two big Yes and No buttons, radio inputs, no longer a select)
    expect(html).toMatch(new RegExp(`<input type="radio" name="elig_${select.key}" value="no"[^>]*checked`));
    expect(html).not.toMatch(new RegExp(`<input type="radio" name="elig_${select.key}" value="yes"[^>]*checked`));
    // the missing field is marked for assistive technology and the box is still unchecked
    const box = html.match(/<input id="acknowledged"[^>]*>/)![0];
    expect(box).toContain('aria-invalid="true"');
    expect(box).toContain('aria-describedby="acknowledged-error"');
    expect(box).not.toContain("checked");
    expect(html).toContain('id="acknowledged-error"');
    // sent back for the box: the full notice it confirms is open, not folded away
    expect(html).toMatch(/<details class="more" open[^>]*><summary>Read the full notice<\/summary>/);
    expect(await container.db.select().from(applications).where(eq(applications.roleId, roleId))).toHaveLength(0);

    // with the box ticked: the application is in, the acknowledgment recorded, and the notice versions are the server's, not the browser's claim
    const accepted = await apply(applyForm({ noticeVersionsShown: "made-up@1", smsConsent: "yes", phone: "(949) 555-0100" }), { "x-forwarded-for": "203.0.113.7" });
    expect(accepted.status).toBe(302);
    // the waiting room, which opens the AI interview's introduction once the résumé is read (20 Oct 2026, R20-12), never the
    // status page: the status link travels by email only (Wave 0 item 0.1)
    expect(accepted.headers.get("location")).toBe(`/careers/${slug}/jobs/${roleId}/applied`);
    await container.drain();
    // after the 40 to 90 seconds every waiting room says "preparing" first (Q14, 21 Oct)
    const room = await pastTheWaitingRoom(container, async () => app.request(accepted.headers.get("location")!, { headers: { cookie: setCookieOf(accepted).match(/ros_applied=[^;,]+/)![0] } }));
    const screenPath = room.headers.get("location")!;
    expect(screenPath).toMatch(/^\/c\/screen\/[A-Za-z0-9_-]+$/);
    expect(setCookieOf(room)).toMatch(new RegExp(`ros_applied_to=v1\\.[^;]+; Max-Age=1800; Path=${screenPath.replace(/[/]/g, "\\/")}; HttpOnly; SameSite=Lax`));
    expect(setCookieOf(room)).not.toContain("ana.lopez");
    const intro = decodeEntities(await (await app.request(screenPath, { headers: { cookie: setCookieOf(room).match(/ros_applied_to=[^;,]+/)![0] } })).text());
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
    // there is no texting: the posted consent is ignored, nothing recorded, no event, and the acknowledgment email promises an online conversation only
    expect(cand.consent.sms).toBeUndefined();
    expect(await eventsOf("consent.granted")).toHaveLength(0);
    const [scr] = await container.db.select().from(screens).where(eq(screens.applicationId, a.id));
    expect(scr).toMatchObject({ channel: "web", invitedVia: "with_application" });
    expect(screenPath).toBe(`/c/screen/${scr.token}`);
    // the one email says honestly what comes next, with the AI interview's link (R20-5, R20-6)
    const ack = emails().find((m) => m.to === "ana.lopez@example.com" && /^Thank you for applying: your next step/.test(m.subject))!;
    expect(ack.text).toMatch(/Your next step is a short interview with Ledger Dental's AI assistant\. Everyone who applies gets the same interview/);
    expect(ack.text).toContain(`Start your AI interview: https://jobs.example.test/c/screen/${scr.token}`);
    expect(ack.text).not.toMatch(/by text|looks like a fit|to qualify/);
    // the status page and the screen page: no text-message choice, no recording notice
    const status = decodeEntities(await (await app.request(`/c/status/${anaStatusToken}`)).text());
    expect(status).not.toContain("Text messages");
    expect(status).not.toContain("may be recorded");
    const screen = decodeEntities(await (await app.request(`/c/screen/${scr.token}`)).text());
    expect(screen).not.toContain("may be recorded");
    expect(screen).toContain("artificial intelligence");
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

  it("the sitemap lists only open roles that accept applications and is rebuilt every five minutes; robots keeps every crawler out except on the production deployment", async () => {
    await container.db.update(companies).set({ name: "Ledger & Sons <Dental>" }).where(eq(companies.id, companyId));
    resetSitemapCache(container);
    const urls = jobUrls(container.env, { slug, roleId });
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
    // robots: anything but the production deployment (staging, a person's machine, this test) keeps every crawler out
    // and names no sitemap (GAP3-3)
    const robots = await (await app.request("/robots.txt")).text();
    expect(robots).toBe("User-agent: *\nDisallow: /\n");
    expect(robotsTxt({ ...container.env, DEPLOY_ENV: "staging" })).toBe(robots);
    // the production deployment lets crawlers read the careers and job pages only, and names the sitemap on the job host
    const production = await (await createApp({ ...container, env: { ...container.env, DEPLOY_ENV: "production" } }).request("/robots.txt")).text();
    expect(production).toContain("Allow: /careers/");
    for (const d of ["/c/", "/api/", "/files/", "/dev/", "/webhooks/"]) expect(production).toContain(`Disallow: ${d}`);
    expect(production).not.toContain("Disallow: /\n");
    expect(production).toContain("Sitemap: https://jobs.example.test/sitemap.xml");
    // the cache: a change shows up after five minutes, not before
    await setAccepting(false);
    expect((await (await app.request("/sitemap.xml")).text()).match(/<url>/g)).toHaveLength(2);
    setClock(SITEMAP_CACHE_MS + 1000);
    expect((await (await app.request("/sitemap.xml")).text()).match(/<url>/g)).toBeNull();
    await setAccepting(true);
    resetSitemapCache(container);
    expect((await (await app.request("/sitemap.xml")).text()).match(/<url>/g)).toHaveLength(2);
    setClock(0);
    await container.db.update(companies).set({ name: "Ledger Dental" }).where(eq(companies.id, companyId));
    resetSitemapCache(container);
  });

  it("pay is shown wherever a pay transparency law covers the job, even if the packet says not to, on the job page, the form and the structured data", async () => {
    const role = await roleRow();
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    const hidden = { ...pv.packet, compensation: { ...pv.packet.compensation, discloseRange: false } };
    await container.db.update(rolePackets).set({ packet: hidden }).where(eq(rolePackets.id, pv.id));
    resetSitemapCache(container);
    try {
      // Irvine, CA: the pay transparency notice applies and says the range is "shown above", so it is
      const page = decodeEntities(await (await app.request(`/careers/${slug}/jobs/${roleId}`)).text());
      expect(page).toContain("The pay range for this position is shown above as required by law");
      expect(page).toMatch(/<span class="fact-text">\$45–\$55 an hour<\/span>/);
      expect(jsonLdOf(page).baseSalary).toMatchObject({ currency: "USD", value: { minValue: 45, maxValue: 55, unitText: "HOUR" } });
      const form = decodeEntities(await (await app.request(`/careers/${slug}/jobs/${roleId}/apply`)).text());
      expect(form.slice(0, form.indexOf("<form"))).toMatch(/<span class="fact-text">\$45–\$55 an hour<\/span>/);
      // and the owner's role page says the same, with the reason, instead of "not shown"
      const roleView = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { payShown: boolean; payRequiredByLaw: boolean; packet: { compensation: { discloseRange: boolean } } } };
      expect(roleView.currentPacket).toMatchObject({ payShown: true, payRequiredByLaw: true, packet: { compensation: { discloseRange: false } } });
    } finally {
      await container.db.update(rolePackets).set({ packet: pv.packet }).where(eq(rolePackets.id, pv.id));
      resetSitemapCache(container);
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
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/close`, { confirm: true })).status).toBe(200);
    const closedRole = await roleRow();
    expect(closedRole.status).toBe("closed");
    const page = await app.request(path);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("This position is closed and no longer taking applications.");
    expect(html).not.toContain(">Apply now<");
    const closed = jsonLdOf(html);
    expect(closed.validThrough).toBe(new Date(closedRole.closedAt ?? closedRole.updatedAt).toISOString().slice(0, 10));
    expect(closed.employmentType).toBe("FULL_TIME");
    expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`)).status).toBe(404);
    resetSitemapCache(container);
    expect((await (await app.request("/sitemap.xml")).text()).match(/<url>/g)).toBeNull();
    setClock(0);
  });
});
