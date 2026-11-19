import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CandidateList, CandidatePanel, RoleDetail } from "@ros/contracts";
import { noticesFor } from "@ros/core";
import { applications, candidates, companies, events, rolePackets, roles, screens } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { jobValidThrough } from "./pages/job-structured-data";
import { questionHelp, withPlainQuestionHelp } from "./pages/question-help";
import { SITEMAP_CACHE_MS, resetSitemapCache, robotsTxt } from "./pages/sitemap";
import { jobUrls } from "./services/job-urls";
import { applicationForm, plantJob, seedCompany, usePlan } from "./test-helpers";

/**
 * The candidate-facing job surfaces: the application form (who they are, the resume, the job's screening questions, the
 * notice with its acknowledgment, and what each missing or wrong field answers), what an application records, the
 * sitemap and robots, and the JobPosting data.
 */
describe("public job surfaces: the application form, the sitemap and structured data", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  const BASE = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return d.getTime(); })();
  let clockOffset = 0;
  const setClock = (offsetMs: number) => { clockOffset = offsetMs; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + clockOffset); };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const emails = () => (container.integrations.email as FakeEmailAdapter).sent;
  const roleRow = async () => (await container.db.select().from(roles).where(eq(roles.id, roleId)))[0];
  const setAccepting = (accepting: boolean) => container.db.update(roles).set({ acceptingApplications: accepting, applicationsClosedAt: accepting ? null : new Date(BASE + clockOffset).toISOString() }).where(eq(roles.id, roleId));
  const decodeEntities = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const jsonLdOf = (html: string) => JSON.parse(html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)![1]) as Record<string, unknown>;
  const applyPath = () => `/careers/${slug}/jobs/${roleId}/apply`;
  const apply = (fd: FormData, headers: Record<string, string> = {}) => app.request(applyPath(), { method: "POST", body: fd, headers });
  /** Every question answered as someone who fits would. */
  const ANSWERS = { q_license: "yes", q_shift: "Mornings", q_patients: "9" };
  const applicationOf = async (email: string) => (await container.db.select({ a: applications }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(and(eq(applications.roleId, roleId), eq(candidates.email, email))))[0]?.a;
  /** A post the form refuses: its status, and the page it answers with. */
  const refused = async (fd: FormData) => {
    const r = await apply(fd);
    return { status: r.status, html: decodeEntities(await r.text()) };
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    setClock(0);
    ({ owner, companyId, slug } = await seedCompany(app, { email: "owner@ledger.test", name: "Ledger Dental" }));
    // More people apply to one job here than Free's five, and these pages are about a job open to anyone.
    await usePlan(container, companyId, "ultra");
    roleId = await plantJob(container, {
      companyId,
      title: "Registered Dental Hygienist",
      packet: (p) => {
        p.compensation = { ...p.compensation, min: 45, max: 55 };
        p.formQuestions = [
          { kind: "yes_no", key: "license", question: "Do you hold an active CA RDH license?", help: "The owner needs it by law.", required: true },
          { kind: "yes_no", key: "saturdays", question: "Can you work two Saturdays a month?", help: "The owner stated the schedule in the packet.", required: false },
          { kind: "choice", key: "shift", question: "Which shift suits you best?", options: ["Mornings", "Afternoons", "Either"], required: true },
          { kind: "number", key: "patients", question: "How many patients a day are you used to seeing?", unit: "patients", min: 0, max: 40, required: true },
        ];
      },
    });
    // the employer's website and logo go into the structured data when the company set them
    const [co] = await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    await container.db.update(companies).set({ settings: { ...co.settings, website: "https://ledgerdental.example", logoUrl: "https://ledgerdental.example/logo.png" } }).where(eq(companies.id, companyId));
  });
  afterAll(async () => {
    await container.close();
  });

  it("the line under a screening question: the job's own line when it reads well to an applicant, nothing when it is in the team's words; the stored job keeps its words", () => {
    for (const teams of ["The owner stated the work model in the packet.", "The owner stated the work model and travel in the Role Packet.", "Taken from the dental playbook.", "  ", null]) expect(questionHelp(teams)).toBeNull();
    expect(questionHelp("Coverage is the reason for the hire.")).toBe("The job needs someone for this schedule.");
    expect(questionHelp("Required for clinical staff; can be obtained before start if the owner allows.")).toBe("Required for clinical staff; can be obtained before start if the employer allows.");
    expect(questionHelp("The owner needs coverage by the target date.")).toBe("The employer needs coverage by the target date.");
    // a line that reads well is shown as it was written
    for (const fine of ["Required by law to practice dental hygiene.", "Required for employment; asked of every candidate.", "The desk must be covered during clinic hours."]) expect(questionHelp(fine)).toBe(fine);
    const packet = { formQuestions: [{ kind: "yes_no" as const, key: "schedule", question: "Are you available?", help: "The owner stated the work model in the packet.", required: true }, { kind: "yes_no" as const, key: "license", question: "Do you hold a license?", help: "The owner needs it by law.", required: true }] };
    const shown = withPlainQuestionHelp(packet);
    expect(shown.formQuestions.map((q) => q.help)).toEqual([undefined, "The employer needs it by law."]);
    expect(packet.formQuestions[0].help).toBe("The owner stated the work model in the packet.");
  });

  it("a job's notices are the ones a page renders and records: AI use, privacy and, where a law asks for it, the pay range; none is about a recording", () => {
    expect(noticesFor(["US-CA"]).map((n) => n.key)).toEqual(["ai_use", "privacy", "pay_transparency"]);
    expect(noticesFor(["US-TX"]).map((n) => n.key)).toEqual(["ai_use", "privacy"]);
  });

  it("the form asks who they are, then the resume, then the job's screening questions, then the notice with its tick; nothing else, and no AI before Send", async () => {
    const page = await app.request(applyPath());
    expect(page.status).toBe(200);
    const html = decodeEntities(await page.text());
    // the facts header: the job, where, how, the kind of job and the pay the notice says is "shown above"
    const header = html.slice(0, html.indexOf("<form"));
    expect(header).toContain("<h1>Apply: Registered Dental Hygienist</h1>");
    for (const fact of ["Irvine, CA", "On site", "Full time", "$45–$55 an hour"]) expect(header).toContain(`<span class="fact-text">${fact}</span>`);
    expect(header).toContain('<p class="lead">A short form for Ledger Dental, about 3 minutes. No cover letter needed.</p>');
    // the pre-apply line: help, or a change to how to apply because of a disability, from a person (here the ITS inbox)
    expect(header).toContain(`Need help applying, or a change to how you apply because of a disability? Email <a href="mailto:${container.env.EMAIL_REPLY_TO}">`);
    // the parts, in order
    const at = ['<h2 id="details-title">Your details</h2>', '<label for="firstName">First name</label>', '<label for="lastName">Last name</label>', '<label for="email">Email</label>', '<label for="phone">Phone (optional)</label>', '<h2 id="resume-title">Your resume</h2>', '<h2 id="questions-title">Questions from Ledger Dental</h2>', '<h2 id="before-you-send">Before you send</h2>', '<button class="btn" type="submit">Send my application</button>'].map((part) => html.indexOf(part));
    expect(at.every((i) => i > 0), at.join(",")).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // name and email are required, the phone is not, and the one file field is
    for (const id of ["firstName", "lastName", "email", "resume"]) expect(html.match(new RegExp(`<input id="${id}"[^>]*>`))![0]).toContain("required");
    expect(html.match(/<input id="phone"[^>]*>/)![0]).not.toContain("required");
    expect(html.match(/<input[^>]*type="file"[^>]*>/g)).toHaveLength(1);
    expect(html).toContain("up to 4 MB without JavaScript");
    // each question as the job has it: Yes and No, the job's own choices, or a number with its unit and limits
    expect(html).toContain('<legend class="question-legend"><span class="q-num" aria-hidden="true">01</span>Do you hold an active CA RDH license?<span class="req"> (required)</span></legend><small id="q_license-why">The employer needs it by law.</small>');
    for (const value of ["yes", "no"]) expect(html).toMatch(new RegExp(`<input type="radio" name="q_license" value="${value}" required[^>]*>`));
    // a line in the team's words is not shown, and a question that need not be answered says nothing of "required"
    expect(html).toContain('<legend class="question-legend"><span class="q-num" aria-hidden="true">02</span>Can you work two Saturdays a month?</legend><div class="choices pair">');
    expect(html.match(/<input type="radio" name="q_saturdays" value="yes"[^>]*>/)![0]).not.toContain("required");
    for (const option of ["Mornings", "Afternoons", "Either"]) expect(html).toMatch(new RegExp(`<input type="radio" name="q_shift" value="${option}" required[^>]*><span>${option}</span>`));
    const number = html.match(/<input id="q_patients"[^>]*>/)![0];
    for (const part of ['type="number"', 'name="q_patients"', 'min="0"', 'max="40"', "required"]) expect(number).toContain(part);
    expect(html).toContain("<span>patients</span>");
    // the notice: three short lines and the privacy link first; every word of it under "Read the full notice", above the tick
    const block = html.slice(html.indexOf('<h2 id="before-you-send">'), html.indexOf('<label class="check" for="acknowledged">'));
    expect(block).toContain("<ul class=\"steps\"><li>People at Ledger Dental make every hiring decision.</li><li>Software helps organize applications and works out a match score.</li><li>You can ask for a person at any time.</li></ul><p><a href=\"/privacy\">Read how we handle your information</a></p><details class=\"more\"><summary>Read the full notice</summary><p><strong>Ledger Dental</strong> runs this hiring process and is the employer.");
    const full = block.slice(block.indexOf("<summary>Read the full notice</summary>"));
    expect(full).toContain("works out a match score from what you send, checked against the job's requirements; the team sees what the score is based on, and a person always decides.");
    expect(full).toContain("<strong>What we collect:</strong> your name, your email, your phone number if you give one, your resume, and your answers to the questions above.");
    expect(full).toContain("<strong>Why:</strong> to consider you for this position and to contact you about it. Nothing else.");
    expect(full).toContain("<strong>Who can see it:</strong> the hiring team at Ledger Dental; and the companies that run this service for us: hosting, file storage, email delivery, and the AI service that helps organize applications.");
    expect(full).toContain("<strong>Your choices:</strong> after you apply, we email you a link to your own status page");
    expect(full).toContain(`mailto:${container.env.PRIVACY_EMAIL}`);
    expect(full).toContain('<a href="/privacy">Read how we handle your information</a>');
    // the notices themselves, word for word: AI use (how to reach a person without a reply keyword), privacy, pay
    expect(full).toContain("People make the hiring decisions. You can ask to talk to a person at any point: before you apply, use the contact on the job page; after you apply, write to that contact or use the link in any of our messages.");
    expect(full).toContain("The pay range for this position is shown above as required by law");
    expect(full.endsWith("</details>")).toBe(true);
    // the acknowledgment: present, required, never ticked for them
    const box = html.match(/<input id="acknowledged"[^>]*>/)![0];
    expect(box).toContain('name="acknowledged"');
    expect(box).toContain("required");
    expect(box).not.toContain("checked");
    expect(html).toContain("I have read the full notice above and I understand that people, not software, make the hiring decisions.");
    // nothing of what the form no longer asks or says: a place, a recruiter, texts, a recording, a reply keyword, a reading before Send
    for (const gone of [/where you are based/i, /Identified Talent Solutions recruiter|brings one in/i, /text message/i, /may be recorded/i, /HUMAN/, /Read my resume/i, /No resume\?/i, /saved details/i]) expect(html).not.toMatch(gone);
    for (const name of ["locationText", "smsConsent", "noticeVersionsShown", "workSummary"]) expect(html).not.toContain(`name="${name}"`);
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
    // the job page promises nothing by text and records nothing
    const job = decodeEntities(await (await app.request(`/careers/${slug}/jobs/${roleId}`)).text());
    expect(job).not.toMatch(/by text|may be recorded/);
    expect(job).toContain('href="/privacy"');
  });

  it("each field is checked on the server: a missing name, a bad address, a short phone, a missing resume, an unanswered or impossible answer each bring the form back saying which, with what was typed kept; nothing is stored", async () => {
    const who = { firstName: "Eve", lastName: "Long", email: "eve.long@example.com", ...ANSWERS };
    const missingName = await refused(applicationForm({ ...who, firstName: "" }));
    expect(missingName.status).toBe(400);
    expect(missingName.html).toContain('role="alert">Please check the highlighted field: your first name. Everything you typed is still here, but please attach your resume again.');
    expect(missingName.html.match(/<input id="firstName"[^>]*>/)![0]).toContain('aria-invalid="true"');
    expect(missingName.html).toContain('value="Long"');
    expect(missingName.html).toContain('value="eve.long@example.com"');
    const several = await refused(applicationForm({ ...who, lastName: "", email: "not-an-address", phone: "123" }));
    expect(several.status).toBe(400);
    expect(several.html).toContain("Please check the highlighted fields: your last name, a valid email address and a phone number of at least 7 digits, or leave it empty.");
    // the phone is optional: none at all is fine (this one goes through, below), and a real one is kept as typed on a form sent back
    const withoutFile = await refused(applicationForm({ ...who, phone: "(949) 555-0142" }, null));
    expect(withoutFile.status).toBe(400);
    expect(withoutFile.html).toContain("Please attach your resume to send your application. Everything you entered is still here.");
    expect(withoutFile.html.match(/<input id="resume"[^>]*>/)![0]).toContain('aria-invalid="true"');
    expect(withoutFile.html).toContain('value="(949) 555-0142"');
    // a required question left out, a choice the job does not offer, and a number outside its limits
    const unanswered = await refused(applicationForm({ ...who, q_shift: null }));
    expect(unanswered.status).toBe(400);
    expect(unanswered.html).toContain('Please answer this question: "Which shift suits you best?".');
    expect((await refused(applicationForm({ ...who, q_shift: "Nights" }))).html).toContain('Please answer this question: "Which shift suits you best?".');
    const impossible = await refused(applicationForm({ ...who, q_patients: "400" }));
    expect(impossible.status).toBe(400);
    expect(impossible.html).toContain('Please check your answer: "How many patients a day are you used to seeing?" needs a number from 0 to 40.');
    expect(impossible.html.match(/<input id="q_patients"[^>]*>/)![0]).toContain('value="400"');
    expect((await refused(applicationForm({ ...who, q_patients: "lots" }))).html).toContain("needs a number.");
    // the answers already given survive each round trip
    expect(impossible.html).toMatch(/<input type="radio" name="q_license" value="yes"[^>]*checked/);
    expect(impossible.html).toMatch(/<input type="radio" name="q_shift" value="Mornings"[^>]*checked/);
    expect(await applicationOf("eve.long@example.com")).toBeUndefined();
    // the question that need not be answered may be left out, and so may the phone
    const sent = await apply(applicationForm(who));
    expect(sent.status).toBe(302);
    await container.drain();
    const eve = (await applicationOf("eve.long@example.com"))!;
    expect(eve.answers.form).toEqual({ license: "yes", shift: "Mornings", patients: "9" });
    const [person] = await container.db.select().from(candidates).where(eq(candidates.id, eve.candidateId));
    expect(person).toMatchObject({ firstName: "Eve", lastName: "Long", phone: null });
  });

  it("the acknowledgment is required: without it the form comes back with every value and answer kept, the box unticked and marked, and the notice open", async () => {
    const r = await refused(applicationForm({ firstName: "Ana", lastName: "Lopez", email: "ana.lopez@example.com", phone: "(949) 555-0100", acknowledged: null, q_license: "no", q_saturdays: "yes", q_shift: "Either", q_patients: "9" }));
    expect(r.status).toBe(400);
    expect(r.html).toContain('role="alert">One more step: please confirm you have read the notice at the bottom of the form. Everything you typed is still here, but please attach your resume again.');
    for (const value of ["Ana", "Lopez", "ana.lopez@example.com", "(949) 555-0100"]) expect(r.html).toContain(`value="${value}"`);
    // the answers survive the round trip, the "No" included
    expect(r.html).toMatch(/<input type="radio" name="q_license" value="no"[^>]*checked/);
    expect(r.html).not.toMatch(/<input type="radio" name="q_license" value="yes"[^>]*checked/);
    expect(r.html).toMatch(/<input type="radio" name="q_saturdays" value="yes"[^>]*checked/);
    expect(r.html).toMatch(/<input type="radio" name="q_shift" value="Either"[^>]*checked/);
    expect(r.html.match(/<input id="q_patients"[^>]*>/)![0]).toContain('value="9"');
    // the missing box is marked for assistive technology and is still unticked; the notice it confirms is open
    const box = r.html.match(/<input id="acknowledged"[^>]*>/)![0];
    expect(box).toContain('aria-invalid="true"');
    expect(box).toContain('aria-describedby="acknowledged-error"');
    expect(box).not.toContain("checked");
    expect(r.html).toContain('id="acknowledged-error"');
    expect(r.html).toMatch(/<details class="more" open[^>]*><summary>Read the full notice<\/summary>/);
    expect(await applicationOf("ana.lopez@example.com")).toBeUndefined();
  });

  it("Send stores the application with its answers, where they came from, and the acknowledgment with the server's notice versions; the receipt and one email follow, and no AI interview; a No holds nobody and is flagged for the team", async () => {
    const before = emails().length;
    const fd = applicationForm({ firstName: "Ana", lastName: "Lopez", email: "ana.lopez@example.com", phone: "(949) 555-0100", src: "indeed", q_license: "no", q_shift: "Either", q_patients: "9", noticeVersionsShown: "made-up@1", smsConsent: "yes", locationText: "Irvine, CA" });
    const accepted = await apply(fd, { "x-forwarded-for": "203.0.113.7" });
    expect(accepted.status).toBe(302);
    // the receipt, never the status page: the status link travels by email only
    expect(accepted.headers.get("location")).toBe(`/careers/${slug}/jobs/${roleId}/applied`);
    const cookie = (accepted.headers.get("set-cookie") ?? "").match(/ros_applied=[^;,]+/)![0];
    const receipt = decodeEntities(await (await app.request(accepted.headers.get("location")!, { headers: { cookie } })).text());
    expect(receipt).toContain("<h1>Thanks, we have your application</h1>");
    expect(receipt).toContain("Your own link to this application goes to a***@example.com.");
    expect(receipt).toContain('<h2>What happens next</h2><ol class="steps"><li>The hiring team at Ledger Dental reviews your application.</li><li>If you are shortlisted, we email you a link to a short AI interview: a written chat you do at a time that suits you.</li><li>The team decides. People on the hiring team make every decision.</li></ol>');
    expect(receipt).not.toMatch(/\/c\/status\/|\/c\/screen\/|either way/);
    await container.drain();
    const a = (await applicationOf("ana.lopez@example.com"))!;
    expect(a.source).toBe("indeed");
    expect(a.answers.form).toEqual({ license: "no", shift: "Either", patients: "9" });
    // the notice versions are the server's, not the browser's claim
    expect(a.answers.noticeVersionsShown).toEqual(expect.arrayContaining(["ai_use@2026-11-18", "privacy@2026-09-01", "pay_transparency@2026-09-01"]));
    expect(a.answers.noticeVersionsShown!.join(",")).not.toMatch(/made-up|recording|sms_consent|on_file/);
    expect(a.answers.acknowledgment).toMatchObject({ ip: "203.0.113.7", noticeVersions: a.answers.noticeVersionsShown });
    expect(Date.parse(a.answers.acknowledgment!.at)).toBe(BASE);
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.id, a.candidateId));
    expect(cand.consent.application_terms).toMatchObject({ granted: true, acknowledged: true, source: "careers_page_apply", ip: "203.0.113.7" });
    // nothing the form does not ask is kept: no texting consent, no place
    expect(cand.consent.sms).toBeUndefined();
    expect(cand.locationText).toBeNull();
    expect(await container.db.select().from(events).where(eq(events.type, "consent.granted"))).toHaveLength(0);
    // the "No" held nobody: the resume was read and they are New like anyone else, with the answer flagged for the team
    expect(a.stage).toBe("triaged");
    const panel = (await (await json(owner, "GET", `/api/v1/applications/${a.id}`)).json()) as CandidatePanel;
    expect(panel).toMatchObject({ stage: "triaged", tab: "new", source: "indeed", sourceLabel: "Indeed" });
    expect(panel.screeningAnswers).toEqual([
      { key: "license", question: "Do you hold an active CA RDH license?", kind: "yes_no", answer: "No", flagged: true, flag: "Answered No: Do you hold an active CA RDH license?" },
      { key: "saturdays", question: "Can you work two Saturdays a month?", kind: "yes_no", answer: null, flagged: false, flag: null },
      { key: "shift", question: "Which shift suits you best?", kind: "choice", answer: "Either", flagged: false, flag: null },
      { key: "patients", question: "How many patients a day are you used to seeing?", kind: "number", answer: "9 patients", flagged: false, flag: null },
    ]);
    const list = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/applications?tab=new`)).json()) as CandidateList;
    expect(list.rows.find((row) => row.id === a.id)!.flags).toEqual(["Answered No: Do you hold an active CA RDH license?"]);
    // one email: received, with their own status link, and no AI interview; none was started
    const mail = emails().slice(before).filter((m) => m.to === "ana.lopez@example.com");
    expect(mail.map((m) => m.subject)).toEqual(["Thank you for applying: Registered Dental Hygienist at Ledger Dental"]);
    expect(mail[0].text).toContain(`https://jobs.example.test/c/status/${a.statusToken}`);
    expect(mail[0].text).toContain("2. If you are shortlisted, we email you a link to a short AI interview: a written chat you do at a time that suits you.");
    expect(mail[0].text).not.toMatch(/\/c\/screen\/|by text|HUMAN/);
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, a.id))).toHaveLength(0);
    // someone who came with no source is recorded as coming from the job page
    const direct = (await applicationOf("eve.long@example.com"))!;
    expect(direct.source).toBe("careers_page");
    expect(((await (await json(owner, "GET", `/api/v1/applications/${direct.id}`)).json()) as CandidatePanel).sourceLabel).toBe("Job page");
  });

  it("without JavaScript a resume over 4 MB is refused with a plain message instead of a platform error", async () => {
    const fd = applicationForm({ firstName: "Lee", lastName: "Large", email: "lee.large@example.com", ...ANSWERS }, null);
    fd.set("resume", new File([new Uint8Array(4 * 1024 * 1024 + 1).fill(97)], "big.txt", { type: "text/plain" }));
    const r = await refused(fd);
    expect(r.status).toBe(400);
    expect(r.html).toContain("Files over 4 MB can only be sent by the direct upload");
    expect(r.html).toContain('value="Lee"');
  });

  it("the sitemap lists only open jobs that take applications and is rebuilt every five minutes; robots keeps every crawler out except on the production deployment", async () => {
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
    // and names no sitemap
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

  it("pay is shown wherever a pay transparency law covers the job, even if the job says not to, on the job page, the form and the structured data", async () => {
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
      const form = decodeEntities(await (await app.request(applyPath())).text());
      expect(form.slice(0, form.indexOf("<form"))).toMatch(/<span class="fact-text">\$45–\$55 an hour<\/span>/);
      // and the job's own page in the app says the same, with the reason, instead of "not shown"
      const roleView = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as RoleDetail;
      expect(roleView).toMatchObject({ payShown: true, payRequiredByLaw: true, packet: { compensation: { discloseRange: false } } });
    } finally {
      await container.db.update(rolePackets).set({ packet: pv.packet }).where(eq(rolePackets.id, pv.id));
      resetSitemapCache(container);
    }
  });

  // Found on the live site on 19 November 2026: the application form of a job published before that day answered with an
  // error page. Its stored version has no list of the form's questions; they are kept where they were then.
  it("a job stored before the form had one list of questions shows its form with the questions it had, and reads an application against them", async () => {
    const role = await roleRow();
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    const older = { ...Object.fromEntries(Object.entries(pv.packet).filter(([k]) => k !== "formQuestions")), requirements: { ...pv.packet.requirements, eligibility: [{ key: "office_years", type: "experience", question: "Do you have two years of office experience?", rationale: "The job needs it." }] } };
    await container.db.update(rolePackets).set({ packet: older as never }).where(eq(rolePackets.id, pv.id));
    try {
      const shown = await app.request(applyPath());
      expect(shown.status).toBe(200);
      const form = decodeEntities(await shown.text());
      expect(form).toContain("Do you have two years of office experience?");
      expect(form).toContain("The job needs it.");
      expect(form).not.toContain("Which shift suits you best?");
      // a post is read against the same questions: the one left unanswered is named, and nothing fails
      const unanswered = await refused(applicationForm({ firstName: "Olive", lastName: "Older", email: "olive.older@example.com" }));
      expect(unanswered.status).toBe(400);
      expect(unanswered.html).toContain('Please answer this question: "Do you have two years of office experience?".');
    } finally {
      await container.db.update(rolePackets).set({ packet: pv.packet }).where(eq(rolePackets.id, pv.id));
    }
  });

  it("the JobPosting data carries no invented end date while the job is open, the day it stopped while paused or switched off, names the employer's website and logo, and shows the closing day once the job is closed", async () => {
    const urls = jobUrls(container.env, { slug, roleId });
    const path = urls.job.replace("https://jobs.example.test", "");
    const role = await roleRow();
    const datePosted = (role.openedAt ?? role.createdAt).slice(0, 10);
    const open = jsonLdOf(await (await app.request(path)).text());
    expect(open).toMatchObject({ "@type": "JobPosting", datePosted, employmentType: "FULL_TIME", url: urls.job, directApply: true });
    expect(open).not.toHaveProperty("validThrough");
    expect(open.hiringOrganization).toMatchObject({ name: "Ledger Dental", sameAs: "https://ledgerdental.example", logo: "https://ledgerdental.example/logo.png" });
    // taking no applications: the day that began
    await setAccepting(false);
    const switchedOff = await roleRow();
    expect(jsonLdOf(await (await app.request(path)).text()).validThrough).toBe(jobValidThrough({ stoppedAt: switchedOff.applicationsClosedAt }));
    await setAccepting(true);
    // paused: the block stays, ending the day the job was paused
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
    expect((await app.request(applyPath())).status).toBe(404);
    resetSitemapCache(container);
    expect((await (await app.request("/sitemap.xml")).text()).match(/<url>/g)).toBeNull();
    setClock(0);
  });
});
