import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { QuickQuestionView, ResumeExtraction } from "@ros/contracts";
import { entitlements } from "@ros/core";
import { aiRuns, applications, candidates, documents, rolePackets, roles, screens } from "@ros/db";
import { EICAR_TEST_STRING, type MemoryStorageAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { CSS } from "./pages/layout";
import { APPLY_CSS, FROM_RESUME_TAG, RESUME_READ_NOTICE, SUGGESTED_FROM_RESUME_TAG, formQuestions, postedApplyForm, reusedState, withResumeReading } from "./pages/apply-form";
import { JOURNEY_CSS } from "./pages/journey";
import { RESUME_READING_JOB_KIND, detailsFrom, expireResumeReading, factsFrom, readingFor, readingKey, splitName, suggestQuickAnswer, workSummaryFrom, type ResumeReading } from "./services/apply-details";
import { useOneVisitApplyFlow } from "./test-helpers";

/**
 * Wave S7, slice S7-B (spec steps 2 to 5): the résumé first, read at once by the worker (checked, scanned, then
 * `resume.extract`), the form back as "Check your details" with every filled field marked, the company's quick questions
 * numbered with a count and a suggestion from the résumé, and the steps header on top. The form still takes the old
 * one-page post, works without script, and the reading goes with the application so it is not read twice.
 */

const extraction = (over: Partial<ResumeExtraction> = {}): ResumeExtraction => ({
  fullName: "Dana Kept, RDH",
  email: "Dana.Kept@example.com",
  phone: "(949) 555-0142",
  locationText: "Irvine, CA",
  headline: "Registered dental hygienist",
  positions: [{ title: "Dental hygienist", employer: "Coastal Dental", startDate: "2019", current: true, quote: "Dental hygienist at Coastal Dental 2019 - present" }],
  education: [],
  licenses: [{ name: "RDH", jurisdiction: "CA", quote: "Active CA RDH license 12345" }],
  certifications: [{ name: "BLS", quote: "BLS certified" }],
  skills: ["dentrix", "x-ray"],
  languages: ["Spanish"],
  yearsOfExperienceEstimate: 7,
  anomalies: [],
  confidence: "medium",
  ...over,
});

const view = (over: Partial<QuickQuestionView>): QuickQuestionView => ({ source: "company", key: "cq_x", field: "q_cq_x", kind: "choice", question: "Which one?", help: null, required: true, options: [], unit: null, min: null, max: null, ...over });

describe("reading a résumé for the form: what it fills in and suggests (pure)", () => {
  it("splits the name, keeps a real address and phone, and writes a short summary from what the résumé says", () => {
    expect(splitName("Dana Kept, RDH")).toEqual({ firstName: "Dana", lastName: "Kept" });
    expect(splitName("Maria de la Cruz")).toEqual({ firstName: "Maria", lastName: "de la Cruz" });
    expect(splitName("Prince")).toEqual({ firstName: "Prince", lastName: "" });
    expect(splitName("dana@example.com")).toEqual({ firstName: "", lastName: "" });
    const d = detailsFrom(extraction());
    expect(d).toMatchObject({ firstName: "Dana", lastName: "Kept", email: "dana.kept@example.com", phone: "(949) 555-0142", locationText: "Irvine, CA" });
    expect(d.workSummary).toBe("Registered dental hygienist\nDental hygienist at Coastal Dental (2019–present)\nLicenses and certificates: RDH, CA; BLS\nSkills: dentrix, x-ray");
    expect(detailsFrom(extraction({ email: "not an address", phone: "12" }))).toMatchObject({ email: "", phone: "" });
    // nothing invented: an empty reading fills in nothing
    expect(workSummaryFrom(extraction({ headline: undefined, positions: [], licenses: [], certifications: [], skills: [] }))).toBe("");
  });

  it("suggests only what the résumé states plainly: yes to a current credential in the state asked, never a no, one fitting choice, the years", () => {
    const facts = factsFrom(extraction());
    const now = new Date("2026-10-15T12:00:00Z");
    const yesNo = (question: string) => view({ source: "eligibility", key: "q", field: "elig_q", kind: "yes_no", question, options: ["Yes", "No"] });
    expect(suggestQuickAnswer(yesNo("Do you hold an active dental hygiene (RDH) license in CA?"), facts, now)).toBe("yes");
    expect(suggestQuickAnswer(yesNo("Do you hold current CPR/BLS certification?"), facts, now)).toBe("yes");
    // another state's licence, a credential the résumé does not name, work authorization: no suggestion at all
    expect(suggestQuickAnswer(yesNo("Do you hold an active RDH license in AZ?"), facts, now)).toBeNull();
    expect(suggestQuickAnswer(yesNo("Do you hold an RDA permit?"), facts, now)).toBeNull();
    expect(suggestQuickAnswer(yesNo("Are you legally authorized to work in the US for any employer?"), facts, now)).toBeNull();
    // a lapsed, pending or expired credential is not known (spec-s5): never suggested as yes
    for (const lic of [{ name: "RDH", jurisdiction: "CA", quote: "RDH license (expired 2024)" }, { name: "RDH", jurisdiction: "CA", quote: "RDH license pending" }, { name: "RDH", jurisdiction: "CA", expires: "2025-01-31", quote: "RDH CA 12345" }]) {
      expect(suggestQuickAnswer(yesNo("Do you hold an active RDH license in CA?"), factsFrom(extraction({ licenses: [lic] })), now), lic.quote).toBeNull();
    }
    expect(suggestQuickAnswer(view({ options: ["Dentrix", "Eaglesoft", "Open Dental"] }), facts, now)).toBe("Dentrix");
    expect(suggestQuickAnswer(view({ options: ["Irvine", "Tustin"] }), facts, now)).toBe("Irvine");
    // two options fit: no suggestion
    expect(suggestQuickAnswer(view({ options: ["Dentrix", "Spanish"] }), facts, now)).toBeNull();
    const years = view({ kind: "number", question: "How many years of experience do you have as a hygienist?", unit: "years" });
    expect(suggestQuickAnswer(years, facts, now)).toBe("7");
    expect(suggestQuickAnswer({ ...years, max: 5 }, facts, now)).toBeNull();
    expect(suggestQuickAnswer(view({ kind: "number", question: "What hourly pay are you looking for?", unit: "an hour" }), facts, now)).toBeNull();
    expect(suggestQuickAnswer(view({ source: "eligibility", kind: "days", options: ["Mon"] }), facts, now)).toBeNull();
    expect(suggestQuickAnswer(years, null, now)).toBeNull();
  });

  it("fills only what the candidate left empty, marks what is still the résumé's, and at Send only compares", () => {
    const reading: ResumeReading = { v: 1, uploadId: "u1", outcome: "read", aiRunId: "r1", readAt: "2026-10-15T00:00:00Z", details: detailsFrom(extraction()), facts: factsFrom(extraction()) };
    const questions: QuickQuestionView[] = [view({ key: "cq_software", field: "q_cq_software", options: ["Dentrix", "Eaglesoft"] }), view({ source: "eligibility", key: "bls", field: "elig_bls", kind: "yes_no", question: "Do you hold current BLS certification?", options: ["Yes", "No"] })];
    const filled = withResumeReading({ values: { firstName: "", lastName: "Kept-Lopez", email: "", phone: "", locationText: "", workSummary: "" }, answers: { bls: "no" } }, reading, questions, { fill: true, now: new Date("2026-10-15T00:00:00Z") });
    expect(filled.values).toMatchObject({ firstName: "Dana", lastName: "Kept-Lopez", email: "dana.kept@example.com", phone: "(949) 555-0142", locationText: "Irvine, CA" });
    expect(filled.fromResume).toEqual(["firstName", "email", "phone", "locationText", "workSummary"]);
    // the candidate's own "no" stands; the software question takes the suggestion
    expect(filled.answers).toEqual({ bls: "no", cq_software: "Dentrix" });
    expect(filled.suggested).toEqual(["q_cq_software"]);
    // at Send: an edited value is no longer the résumé's, nothing is filled
    const sent = withResumeReading({ values: { ...filled.values, firstName: "Danielle" }, answers: filled.answers }, reading, questions, { fill: false });
    expect(sent.fromResume).toEqual(["email", "phone", "locationText", "workSummary"]);
    expect(sent.suggested).toEqual(["q_cq_software"]);
    expect(withResumeReading({ values: {}, answers: {} }, { ...reading, outcome: "unreadable", details: null, facts: null }, questions, { fill: true }).fromResume).toEqual([]);
  });

  it("reads the quick answers the questions take: an offered option, a number within its limits; days and yes/no as before", () => {
    const questions: QuickQuestionView[] = [
      view({ source: "eligibility", key: "lic", field: "elig_lic", kind: "yes_no", options: ["Yes", "No"] }),
      view({ source: "eligibility", key: "schedule", field: "elig_schedule", kind: "days", required: false, options: ["Mon", "Tue"] }),
      view({ key: "cq_city", field: "q_cq_city", options: ["Irvine", "Tustin"] }),
      view({ key: "cq_years", field: "q_cq_years", kind: "number", question: "Years?", min: 0, max: 50 }),
      view({ key: "cq_pay", field: "q_cq_pay", kind: "number", question: "Pay?" }),
    ];
    const posted = postedApplyForm({ elig_lic: "yes", elig_schedule: ["Mon", "Tue"], q_cq_city: "Somewhere else", q_cq_years: "60", q_cq_pay: "1,200", smsConsent: "yes" }, questions, false);
    expect(posted.eligibilityAnswers).toEqual({ lic: "yes", schedule: ["Mon", "Tue"] });
    expect(posted.quickAnswers).toEqual({ cq_pay: "1,200" });
    expect(posted.quickProblems).toEqual([{ field: "q_cq_years", question: "Years?", problem: "a number from 0 to 50" }]);
    expect(posted.answers.cq_years).toBe("60");
    expect(posted.answers.cq_city).toBeUndefined();
    expect(posted.smsConsent).toBe(false);
    expect(postedApplyForm({ q_cq_years: "ten" }, questions, false).quickProblems[0].problem).toBe("a number");
    // a text box's line breaks arrive as CRLF and are kept as plain ones
    expect(postedApplyForm({ workSummary: "One\r\nTwo" }, questions, false).values.workSummary).toBe("One\nTwo");
  });

  it("an earlier application's details (S7-F's emailed link) fill the form, each marked as from that application", () => {
    const state = reusedState({ firstName: "Dana", lastName: "Kept", email: "dana.kept@example.com", phone: null, locationText: "Irvine, CA", workSummary: null, facts: [] });
    expect(state.values).toEqual({ firstName: "Dana", lastName: "Kept", email: "dana.kept@example.com", phone: "", locationText: "Irvine, CA", workSummary: "" });
    expect(state.marks?.reused).toEqual(["firstName", "lastName", "email", "locationText"]);
  });

  it("the form's own styles and the steps header use only the page's tokens, no colours of their own, no button rules and no motion", () => {
    const declared = new Set([...CSS.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
    for (const css of [APPLY_CSS, JOURNEY_CSS]) {
      for (const m of css.matchAll(/var\((--[a-z0-9-]+)\)/g)) expect(declared.has(m[1]), m[1]).toBe(true);
      expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(css).not.toContain(".btn");
      expect(css).not.toMatch(/transition|animation|https?:/);
    }
  });
});

describe("the apply form: résumé first, check your details, questions from the company", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let slug = "";
  let roleId = "";
  let companyId = "";
  let eligibility: Array<{ key: string; type: string; question: string; days: boolean }> = [];
  const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const RESUME = "Dana Kept\ndana.kept@example.com\n(949) 555-0142\nDental hygienist at Coastal Dental 2019 - present\nActive CA RDH license 12345\nBLS certified\nDentrix, x-ray\n";
  let ip = 10;
  const post = (path: string, fd: FormData) => app.request(`/careers/${slug}/jobs/${roleId}${path}`, { method: "POST", body: fd, headers: { "x-forwarded-for": `198.51.100.${ip++}` } });
  const fields = (extra: Record<string, string | Blob | null> = {}) => {
    const fd = new FormData();
    const base: Record<string, string> = { noticeVersionsShown: "ai_use@2026-09-01" };
    for (const [k, v] of Object.entries({ ...base, ...extra })) if (v !== null) fd.set(k, v);
    return fd;
  };
  const valueOf = (html: string, name: string) => html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`))?.[1] ?? html.match(new RegExp(`value="([^"]*)"[^>]*name="${name}"`))?.[1] ?? null;
  const textareaOf = (html: string, name: string) => html.match(new RegExp(`<textarea[^>]*name="${name}"[^>]*>([^<]*)</textarea>`))?.[1] ?? null;
  const grantOf = (html: string) => html.match(/name="uploadGrant" value="([^"]*)"/)?.[1] ?? "";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", SMS_ENABLED: "false", APP_BASE_URL: "http://localhost:3000" } });
    // The reading's jobs are registered by container.ts itself, in every process (the web process and the worker).
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@details.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Details Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    slug = co.slug;
    companyId = co.id;
    await entitlements.applyPlan(container.db, co.id, "growth");
    await useOneVisitApplyFlow(container, co.id);
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's growth. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    // The company's own quick questions (S7-A builds the setup; here they go straight into the saved version).
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    await container.db.update(rolePackets).set({ packet: { ...pv.packet, companyQuestions: { quick: [
      { kind: "choice", key: "cq_software", question: "Which dental software have you used most?", required: true, options: ["Dentrix", "Eaglesoft", "Open Dental"] },
      { kind: "number", key: "cq_years", question: "How many years of experience do you have as a hygienist?", required: false, unit: "years", min: 0, max: 50 },
    ], written: [] } } }).where(eq(rolePackets.id, pv.id));
    eligibility = pv.packet.requirements.eligibility.map((r) => ({ key: r.key, type: r.type, question: r.question, days: Array.isArray((r.expectation as { days?: unknown }).days) && ((r.expectation as { days?: unknown[] }).days ?? []).length > 0 }));
  });
  afterAll(async () => {
    await container.close();
  });

  it("starts with the résumé and the steps header; the company's questions are numbered, with big Yes/No buttons and a count", async () => {
    const r = await app.request(`/careers/${slug}/jobs/${roleId}/apply`);
    expect(r.status).toBe(200);
    const html = decode(await r.text());
    const main = html.slice(html.indexOf("<main>"));
    // the steps header comes first, the details step current
    expect(main.startsWith('<main><nav class="journey" aria-label="Your application"><ol aria-label="Your application steps"><li class="current" aria-current="step">Details</li><li>Chat</li><li>Review & send</li></ol></nav>')).toBe(true);
    // the résumé card comes before every detail, with the line about software reading it and the reading button
    expect(html.indexOf("<h2 id=\"resume-title\">Start with your resume</h2>")).toBeLessThan(html.indexOf('name="firstName"'));
    expect(html).toContain("Software reads your resume and fills in this form for you, usually in about 20 seconds. You check every detail before you send, and people at Details Dental make every hiring decision.");
    expect(html).toContain(`<button class="btn secondary" type="submit" formaction="/careers/${slug}/jobs/${roleId}/apply/read" formnovalidate="" data-read="yes">Read my resume</button>`);
    // the notice at collection is on the card itself, before the file is chosen: the AI reads it, the privacy page, a
    // person instead, and what happens to an unsent reading
    const card = html.slice(html.indexOf('<h2 id="resume-title">'), html.indexOf('name="resume"'));
    expect(card).toContain(`<p class="notice" id="resume-notice">${RESUME_READ_NOTICE} See <a href="/privacy">how we handle your information</a>. Rather not? Fill in the form below yourself, or email `);
    expect(card).toContain("and a person will help. If you do not send your application, the file and what was read from it are deleted within a day.</p>");
    expect(html).toContain(`<form method="post" action="/careers/${slug}/jobs/${roleId}/apply" enctype="multipart/form-data"`);
    // the Send button is still the one near-black button, and Enter before a file is chosen is handled by the server
    expect(html).toContain('<button class="btn" type="submit">Send my application</button>');
    // Questions from the company: the eligibility questions first, then the company's own; numbered; counted
    expect(html).toContain('<h2 id="questions-title">Questions from Details Dental</h2>');
    const total = eligibility.length + 2;
    const required = eligibility.filter((e) => !e.days).length + 1;
    expect(html).toContain(`<p class="q-count" id="q-count" aria-live="polite" data-suffix=" · ${required} required">0 of ${total} answered · ${required} required</p>`);
    const yesNo = eligibility.find((e) => !e.days)!;
    expect(html).toContain(`<label class="check slot"><input type="radio" name="elig_${yesNo.key}" value="yes" required=""/><span>Yes</span></label>`);
    expect(html).not.toContain(`<select id="elig_${yesNo.key}"`);
    expect(html).toContain('<span class="q-num" aria-hidden="true">01</span>');
    expect(html).toContain("Which dental software have you used most?<span class=\"req\"> (required)</span>");
    expect(html).toContain('<label class="check slot"><input type="radio" name="q_cq_software" value="Eaglesoft" required=""/><span>Eaglesoft</span></label>');
    expect(html).toMatch(/<label class="question-label" for="q_cq_years"><span class="q-num" aria-hidden="true">\d\d<\/span>How many years of experience do you have as a hygienist\?<\/label>/);
    expect(html).toMatch(/<input id="q_cq_years" type="number" name="q_cq_years" inputmode="decimal" step="any" min="0" max="50" value=""\/><span>years<\/span>/);
    // "Applied here before?" asks for the emailed link (S7-F), outside the application form
    expect(html).toContain(`<form method="post" action="/careers/${slug}/jobs/${roleId}/apply/reuse">`);
    // nothing is marked before anything was read
    expect(html).not.toContain(FROM_RESUME_TAG);
    expect(html).not.toContain(SUGGESTED_FROM_RESUME_TAG);
  });

  it("without script: Read my resume posts the form with the file; the worker checks, scans and reads it; the form comes back as Check your details", async () => {
    const runsBefore = (await container.db.select().from(aiRuns).where(eq(aiRuns.task, "resume.extract"))).length;
    const r = await post("/apply/read", fields({ firstName: "", lastName: "Kept-Lopez", resume: new File([RESUME], "dana-resume.txt", { type: "text/plain" }) }));
    expect(r.status).toBe(200);
    const html = decode(await r.text());
    expect(html).toContain('<h2 id="resume-title">Your resume</h2>');
    expect(html).toContain("We read dana-resume.txt and filled in your details below. It stays attached to your application.");
    expect(html).toContain('<h2 id="details-title">Check your details</h2>');
    // the empty fields are filled and marked; what the candidate typed stays as typed, unmarked
    expect(valueOf(html, "firstName")).toBe("Dana");
    expect(valueOf(html, "lastName")).toBe("Kept-Lopez");
    expect(valueOf(html, "email")).toBe("dana.kept@example.com");
    expect(html).toContain(`<label for="firstName">First name</label><p class="tag" id="firstName-tag">${FROM_RESUME_TAG}</p><input id="firstName"`);
    expect(html).toContain('aria-describedby="firstName-tag"');
    expect(html).not.toContain('id="lastName-tag"');
    expect(textareaOf(html, "workSummary")).toContain("Dental hygienist at Coastal Dental (2019–present)");
    // the quick questions: suggested from the résumé and marked; a credential the résumé names, the software it lists
    const rdh = eligibility.find((e) => /RDH/.test(e.question));
    if (rdh) expect(html).toContain(`<input type="radio" name="elig_${rdh.key}" value="yes" required="" checked=""/>`);
    expect(html).toContain('<input type="radio" name="q_cq_software" value="Dentrix" required="" checked=""/>');
    expect(html).toContain(`<p class="tag" id="q_cq_software-tag">${SUGGESTED_FROM_RESUME_TAG}</p>`);
    // never a suggested "no", and nothing for work authorization or the schedule
    expect(html).not.toMatch(/value="no"[^>]*checked/);
    const work = eligibility.find((e) => e.type === "work_authorization");
    if (work) expect(html).not.toMatch(new RegExp(`name="elig_${work.key}" value="yes"[^>]*checked`));
    // the résumé travels with a grant for the app's own quarantined copy; the reading is beside it, and the run is the form's
    const grant = container.uploadGrants.open(grantOf(html))!;
    expect(grant).toMatchObject({ companyId, roleId, filename: "dana-resume.txt", via: "server" });
    expect(grant.key).toBe(`quarantine/${companyId}/${roleId}/${grant.uploadId}.txt`);
    const reading = (await readingFor(container.integrations.storage, grant))!;
    expect(reading).toMatchObject({ outcome: "read", uploadId: grant.uploadId });
    const runs = await container.db.select().from(aiRuns).where(eq(aiRuns.task, "resume.extract"));
    expect(runs.length).toBe(runsBefore + 1);
    expect(runs.find((x) => x.id === reading.aiRunId)!.inputRef).toMatchObject({ uploadId: grant.uploadId, purpose: "apply_form" });
    // after a reading the résumé field sits below the button, so Enter in a field sends the form
    expect(html.indexOf('<button class="btn" type="submit">Send my application</button>')).toBeLessThan(html.indexOf("Read this resume instead"));
    expect(html).toContain("<summary>Use a different resume</summary>");
    expect(html).not.toContain("Start with your resume");
  });

  it("Send keeps what came from the résumé (answers.fromCv), the quick answers and the summary, and the intake reuses the reading instead of reading again", async () => {
    const read = decode(await (await post("/apply/read", fields({ resume: new File([RESUME.replace("Dana Kept", "Lee Reuse").replace("dana.kept", "lee.reuse")], "lee.txt", { type: "text/plain" }) }))).text());
    const grant = grantOf(read);
    const opened = container.uploadGrants.open(grant)!;
    const reading = (await readingFor(container.integrations.storage, opened))!;
    const fd = fields({ firstName: "Lee", lastName: "Reuse", email: "lee.reuse@example.com", phone: "(949) 555-0199", locationText: "", workSummary: textareaOf(read, "workSummary")!, uploadGrant: grant, formOpened: valueOf(read, "formOpened")!, acknowledged: "yes", q_cq_software: "Dentrix", q_cq_years: "7" });
    for (const e of eligibility) {
      if (e.days) { fd.append(`elig_${e.key}`, "Mon"); fd.append(`elig_${e.key}`, "Tue"); } else fd.set(`elig_${e.key}`, "yes");
    }
    const runsBefore = (await container.db.select().from(aiRuns).where(eq(aiRuns.task, "resume.extract"))).length;
    const sent = await post("/apply", fd);
    expect(sent.status).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, "lee.reuse@example.com"));
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id)));
    // the phone was changed by hand: not from the résumé any more
    expect(a.answers.fromCv).toEqual(expect.arrayContaining(["firstName", "lastName", "email", "workSummary", "q_cq_software", "q_cq_years"]));
    expect(a.answers.fromCv).not.toContain("phone");
    expect(a.answers.quick).toEqual({ cq_software: "Dentrix", cq_years: "7" });
    expect(a.answers.workSummary).toContain("Dental hygienist at Coastal Dental");
    const [doc] = await container.db.select().from(documents).where(eq(documents.id, a.resumeDocumentId!));
    expect(doc).toMatchObject({ filename: "lee.txt", uploadedVia: "server", status: "clean", extractedByAiRunId: reading.aiRunId });
    // the reading belongs to the application now (a deletion request finds it), and the intake did not ask the model again
    const [run] = await container.db.select().from(aiRuns).where(eq(aiRuns.id, reading.aiRunId!));
    expect(run.inputRef).toMatchObject({ applicationId: a.id, documentId: doc.id, purpose: "apply_form" });
    expect((await container.db.select().from(aiRuns).where(eq(aiRuns.task, "resume.extract"))).length).toBe(runsBefore);
    expect(a.extraction).toMatchObject({ fullName: "Lee Reuse" });
    // a day later the clean-up leaves a reading that is part of an application alone
    await expireResumeReading(container.db, { companyId, aiRunId: reading.aiRunId });
    expect((await container.db.select().from(aiRuns).where(eq(aiRuns.id, reading.aiRunId!)))[0].structuredOutput).toMatchObject({ fullName: "Lee Reuse" });
  });

  it("the old one-page post still works, a quick answer outside its limits comes back marked, and a choice that is not offered is dropped", async () => {
    const fd = fields({ firstName: "Ola", lastName: "Old", email: "ola.old@example.com", nr_recentWork: "Hygienist for five years.", acknowledged: "yes", q_cq_years: "75", q_cq_software: "Notepad" });
    for (const e of eligibility) if (!e.days) fd.set(`elig_${e.key}`, "yes");
    const back = await post("/apply", fd);
    expect(back.status).toBe(400);
    const html = decode(await back.text());
    expect(html).toContain('Please check your answer: "How many years of experience do you have as a hygienist?" needs a number from 0 to 50. Everything you entered is still here.');
    expect(html).toMatch(/<input id="q_cq_years" type="number"[^>]*value="75" aria-invalid="true"/);
    expect(html).not.toMatch(/value="Notepad"/);
    fd.set("q_cq_years", "5");
    expect((await post("/apply", fd)).status).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, "ola.old@example.com"));
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id)));
    expect(a.answers.quick).toEqual({ cq_years: "5" });
    expect(a.answers.fromCv).toBeUndefined();
    // an older form without any of the company's questions is taken exactly as before
    const plain = fields({ firstName: "Pat", lastName: "Plain", email: "pat.plain@example.com", nr_recentWork: "Dental assistant.", acknowledged: "yes" });
    expect((await post("/apply", plain)).status).toBe(302);
    await container.drain();
    const [pat] = await container.db.select().from(candidates).where(eq(candidates.email, "pat.plain@example.com"));
    const [pa] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, pat.id)));
    expect(pa.answers.quick).toBeUndefined();
  });

  it("with script: a direct upload's grant is read the same way; the waiting page carries everything, asks, and Continue or 'Fill it in myself' goes on", async () => {
    const bytes = new TextEncoder().encode(RESUME.replace("Dana Kept", "Max Wait"));
    const ir = await app.request(`/careers/${slug}/jobs/${roleId}/upload-intent`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.200" }, body: JSON.stringify({ filename: "max.txt", size: bytes.byteLength, type: "text/plain" }) });
    const j = (await ir.json()) as { url: string; method: string; headers: Record<string, string>; grant: string };
    expect((await app.request(new URL(j.url).pathname, { method: j.method, headers: j.headers, body: bytes.slice().buffer as ArrayBuffer })).status).toBe(200);
    const g = container.uploadGrants.open(j.grant)!;
    const status = (grant: string) => app.request(`/careers/${slug}/jobs/${roleId}/apply/read-status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant }) });
    // nothing asked for it yet: the waiting page, with everything typed carried along and both ways on
    expect(await (await status(j.grant)).json()).toEqual({ state: "reading" });
    const wait = await post("/apply/details", fields({ uploadGrant: j.grant, firstName: "Max", acknowledged: "yes", q_cq_years: "3" }));
    expect(wait.status).toBe(200);
    const page = decode(await wait.text());
    expect(page).toContain("<h1>Reading your resume</h1>");
    expect(page).toContain("Still reading max.txt…");
    expect(page).toContain(`<form method="post" action="/careers/${slug}/jobs/${roleId}/apply/details" data-read-status="/careers/${slug}/jobs/${roleId}/apply/read-status">`);
    for (const hidden of ['<input type="hidden" name="firstName" value="Max"/>', '<input type="hidden" name="q_cq_years" value="3"/>', '<input type="hidden" name="acknowledged" value="yes"/>']) expect(page).toContain(hidden);
    expect(page).toContain('<button class="btn secondary" type="submit" name="skip" value="yes">Fill it in myself instead</button>');
    expect(page).toMatch(/<script nonce="[^"]+">/);
    const skipped = decode(await (await post("/apply/details", fields({ uploadGrant: j.grant, firstName: "Max", skip: "yes" }))).text());
    expect(skipped).toContain("max.txt is attached to your application. Fill in your details below.");
    expect(grantOf(skipped)).toBe(j.grant);
    expect(skipped).not.toContain(FROM_RESUME_TAG);
    // the browser's own path: the grant goes to Read my resume (no file in the form); the reading fills in the rest
    const read = decode(await (await post("/apply/read", fields({ uploadGrant: j.grant, lastName: "" }))).text());
    expect(valueOf(read, "firstName")).toBe("Max");
    expect(read).toContain("We read max.txt and filled in your details below.");
    expect(await (await status(j.grant)).json()).toEqual({ state: "done" });
    // the grant the form carries from here lasts longer, for the same file
    const longer = container.uploadGrants.open(grantOf(read))!;
    expect(longer).toMatchObject({ uploadId: g.uploadId, key: g.key });
    expect(longer.exp).toBeGreaterThan(g.exp);
    expect((await status("not-a-grant")).status).toBe(404);
  });

  it("nothing to read, a refused file, or a spent grant: the form comes back with a plain line and nothing is read", async () => {
    // nothing to read (Enter pressed in a field of a fresh form, whose first button is Read my resume): it is sent as
    // "Send my application" sends it, under the same checks, so what is missing is named and nothing typed is lost
    const nothing = await post("/apply/read", fields({ firstName: "Nia" }));
    expect(nothing.status).toBe(400);
    const a = decode(await nothing.text());
    expect(a).toContain("Please check the highlighted fields");
    expect(valueOf(a, "firstName")).toBe("Nia");
    const typed = fields({ firstName: "Nia", lastName: "Enter", email: "nia.enter@example.com", nr_recentWork: "Hygienist for six years.", acknowledged: "yes", q_cq_software: "Dentrix" });
    for (const e of eligibility) {
      if (e.days) { typed.append(`elig_${e.key}`, "Mon"); } else typed.set(`elig_${e.key}`, "yes");
    }
    const sentByEnter = await post("/apply/read", typed);
    expect(sentByEnter.status).toBe(302);
    await container.drain();
    expect((await container.db.select().from(candidates).where(eq(candidates.email, "nia.enter@example.com"))).length).toBe(1);
    const wrongType = await post("/apply/read", fields({ resume: new File([new Uint8Array([0x4d, 0x5a, 0x90, 0x00, ...new Array(64).fill(0)])], "cv.pdf", { type: "application/pdf" }) }));
    expect(wrongType.status).toBe(400);
    expect(decode(await wrongType.text())).toContain("That file cannot be used: the file is a program, not a document.");
    // the scanner flags it: the reading says refused, and the form asks for another file without keeping this one
    const flagged = decode(await (await post("/apply/read", fields({ resume: new File([EICAR_TEST_STRING], "flagged.txt", { type: "text/plain" }) }))).text());
    expect(flagged).toContain("We could not use flagged.txt. Please choose a different file, or answer the four short questions instead.");
    expect(grantOf(flagged)).toBe("");
    expect(flagged).toContain("Start with your resume");
  });

  it("a reading nobody sent keeps only its bookkeeping after a day; the job does nothing twice", async () => {
    const html = decode(await (await post("/apply/read", fields({ resume: new File([RESUME.replace("Dana Kept", "Una Sent")], "una.txt", { type: "text/plain" }) }))).text());
    const g = container.uploadGrants.open(grantOf(html))!;
    const reading = (await readingFor(container.integrations.storage, g))!;
    // the clean-up was queued with it: the record and the file go after a day unless an application holds the file
    const stored = container.integrations.storage as MemoryStorageAdapter;
    expect(stored.has(readingKey(g))).toBe(true);
    // asking again for the same upload reads nothing new
    const runs = (await container.db.select().from(aiRuns).where(eq(aiRuns.task, "resume.extract"))).length;
    await container.engine.enqueue(container.db, { kind: RESUME_READING_JOB_KIND, payload: { companyId, roleId, uploadId: g.uploadId, key: g.key, filename: g.filename, mime: g.mime } });
    await container.drain();
    expect((await container.db.select().from(aiRuns).where(eq(aiRuns.task, "resume.extract"))).length).toBe(runs);
    await expireResumeReading(container.db, { companyId, aiRunId: reading.aiRunId });
    const [run] = await container.db.select().from(aiRuns).where(eq(aiRuns.id, reading.aiRunId!));
    expect(JSON.stringify(run.structuredOutput)).not.toContain("Una Sent");
    expect(run.task).toBe("resume.extract");
  });

  it("the questions are the readers' own (formQuestions): eligibility first, then the company's, with their plain lines", async () => {
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    const qs = formQuestions(pv.packet);
    expect(qs.map((q) => q.field)).toEqual([...eligibility.map((e) => `elig_${e.key}`), "q_cq_software", "q_cq_years"]);
    // a draft from the job builder has no company questions yet: the eligibility ones only
    expect(formQuestions({ ...pv.packet, companyQuestions: undefined }).length).toBe(eligibility.length);
  });

  it("the résumé read on the form goes to the chat: it opens on a position from the CV and asks first about a must-have the CV does not show (review of Wave S7)", async () => {
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    const nitrous = { key: "nitrous", text: "Nitrous oxide sedation monitoring permit", rationale: "r", evidencedBy: ["resume" as const, "screen" as const] };
    await container.db.update(rolePackets).set({ packet: { ...pv.packet, requirements: { ...pv.packet.requirements, mustHaves: [...pv.packet.requirements.mustHaves, nitrous] } } }).where(eq(rolePackets.id, pv.id));
    try {
      const read = decode(await (await post("/apply/read", fields({ resume: new File([RESUME.replace("Dana Kept", "Gia Gap").replace("dana.kept", "gia.gap")], "gia.txt", { type: "text/plain" }) }))).text());
      const fd = fields({ firstName: "Gia", lastName: "Gap", email: "gia.gap@example.com", workSummary: textareaOf(read, "workSummary")!, uploadGrant: grantOf(read), formOpened: valueOf(read, "formOpened")!, acknowledged: "yes", q_cq_software: "Dentrix" });
      for (const e of eligibility) {
        if (e.days) { fd.append(`elig_${e.key}`, "Mon"); fd.append(`elig_${e.key}`, "Tue"); } else fd.set(`elig_${e.key}`, "yes");
      }
      const sent = await post("/apply", fd);
      expect(sent.status).toBe(302);
      const token = (sent.headers.get("location") ?? "").replace("/c/screen/", "");
      await container.drain();
      // what the visit typed is the chat's: the CV's lines from the reading, and every form answer as a sentence
      const [scr] = await container.db.select().from(screens).where(eq(screens.token, token));
      expect(scr.progress.typedFacts?.cv[0]).toBe("Dental hygienist at Coastal Dental (2019 to now)");
      expect(scr.progress.typedFacts?.formAnswers).toEqual(expect.arrayContaining(["Which dental software have you used most? Dentrix."]));
      await app.request(`/c/screen/${token}/start`, { method: "POST" });
      const html = decode(await (await app.request(`/c/screen/${token}`)).text());
      const now = html.match(/<li class="msg assistant now" id="question">([\s\S]*?)<\/li>/)?.[1] ?? "";
      expect(now).toContain("Hi Gia. Your resume shows your work as Dental hygienist at Coastal Dental (2019 to now).");
      expect(now).toContain("This is one of the things the job needs:");
      expect(html).toContain("· About your experience<");
      const [started] = await container.db.select().from(screens).where(eq(screens.token, token));
      expect(started.progress.chat?.items.find((i) => i.key === "nitrous")).toMatchObject({ kind: "gap" });
    } finally {
      await container.db.update(rolePackets).set({ packet: pv.packet }).where(eq(rolePackets.id, pv.id));
    }
  });
});
