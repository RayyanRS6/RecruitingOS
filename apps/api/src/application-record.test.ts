import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { ApplicationStage, RolePacket, ScreenProgress, ScreenTranscriptEntry, ToldState } from "@ros/contracts";
import { TRIAGE_READINGS } from "@ros/agents";
import { suppressAddress } from "@ros/core";
import { applications, assessments, auditRecords, communications, screens, withTenant, workflowRuns } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { decisionHeadline } from "./pages/application-record";
import { otherApplicationState, sentChatAnswers } from "./services/application-record";
import { createApplication } from "./services/applications";
import { signInStaff, statusTokenFor } from "./test-helpers";

/**
 * The candidate's application record after sending (Wave S7, slice S7-E; spec-s7-apply-flow.md steps 8, 9 and 11;
 * founder decisions S7-1 and S7-2): the match score with its breakdown behind the ITS switch (on by default), the live
 * "Working out your match score…" state with a plain "Check again" link, the answers they sent read back (never an
 * unsent one), the decision once they were told (never before, B6), and their other applications at the same company.
 */
describe("the application record's parts, in code", () => {
  it("names a decision only once the candidate knows it", () => {
    expect(decisionHeadline("under_review", "rejected")).toBeNull();
    expect(decisionHeadline("received", "applied")).toBeNull();
    expect(decisionHeadline("interview", "interview_scheduled")).toBe("Interview");
    expect(decisionHeadline("decision", "offer_sent")).toBe("Offer");
    expect(decisionHeadline("decision", "hired")).toBe("Hired");
    expect(decisionHeadline("decision", "rejected")).toBe("Not moving forward");
    expect(decisionHeadline("decision", "talent_pool")).toBe("Not moving forward");
    expect(decisionHeadline("decision", "withdrawn")).toBe("You withdrew");
  });

  it("puts another application in a pill without a hint of a private decision", () => {
    const pill = (stage: ApplicationStage, toldState: ToldState, open = false) => otherApplicationState({ stage, toldState }, open);
    expect(pill("triaged", "not_told")).toBe("waiting");
    expect(pill("screen_invited", "not_told", true)).toBe("needs_you");
    // decided and not told: still waiting, as the candidate knows it
    expect(pill("rejected", "not_told")).toBe("waiting");
    expect(pill("rejected", "queued")).toBe("waiting");
    expect(pill("rejected", "sent")).toBe("closed");
    expect(pill("withdrawn", "not_told")).toBe("closed");
    expect(pill("offer_sent", "not_told")).toBe("waiting");
  });

  it("reads the chat back from the write-up when there is one, the assistant's note kept apart; otherwise as recorded", () => {
    const packet = { screening: { questions: [{ key: "why", question: "Why this job?", kind: "motivation" as const }, { key: "hard", question: "A hard moment?", kind: "behavioral" as const }] }, companyQuestions: undefined } as Pick<RolePacket, "screening" | "companyQuestions">;
    const base: ScreenProgress = { askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 };
    expect(sentChatAnswers(packet, { answers: { why: "Close to home." }, progress: { ...base, declined: ["hard"] } })).toEqual([
      { key: "why", question: "Why this job?", answer: "Close to home.", mark: null, note: null },
      { key: "hard", question: "A hard moment?", answer: null, mark: "skipped", note: null },
    ]);
    const writeup = { v: 1 as const, writtenAt: "2026-10-15T10:00:00.000Z", aiRunId: null, promptVersion: 1, answers: [
      { questionKey: "why", answer: "I live nearby and love perio work.", status: "answered" as const, quotes: [], note: null, by: "candidate" as const, editedAt: "2026-10-15T10:01:00.000Z" },
      { questionKey: "hard", answer: "", status: "not_given" as const, quotes: [], note: "No example was given for a hard moment.", by: "writeup" as const },
    ] };
    const out = sentChatAnswers(packet, { answers: { why: "Close to home." }, progress: { ...base, writeup } });
    expect(out[0]).toEqual({ key: "why", question: "Why this job?", answer: "I live nearby and love perio work.", mark: "changed", note: null });
    // the note is never inside the answer
    expect(out[1]).toEqual({ key: "hard", question: "A hard moment?", answer: null, mark: "not_given", note: "No example was given for a hard moment." });
  });
});

describe("the application record (status page) after sending", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let its = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  let secondRoleId = "";
  let packet: RolePacket;

  const json = (method: string, path: string, body?: unknown, cookie = owner, headers: Record<string, string> = {}) => app.request(path, { method, headers: { "content-type": "application/json", cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const page = async (path: string) => {
    const r = await app.request(path);
    expect(r.status, path).toBe(200);
    return { html: decode(await r.text()), refresh: r.headers.get("refresh") };
  };
  const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

  async function makeRole(message: string): Promise<string> {
    const started = await json("POST", "/api/v1/intake/sessions", { initialMessage: message });
    expect(started.status, await started.clone().text()).toBe(201);
    const s = (await started.json()) as { session: { id: string } };
    const id = ((await (await json("POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json("POST", `/api/v1/roles/${id}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    return id;
  }

  async function applyAs(first: string, email: string, role = roleId) {
    const p = ((await (await json("GET", `/api/v1/roles/${role}`)).json()) as { currentPacket: { packet: RolePacket } }).currentPacket.packet;
    const fd = new FormData();
    fd.set("firstName", first); fd.set("lastName", "Record"); fd.set("email", email); fd.set("locationText", "Irvine, CA");
    fd.set("resume", new File([`${first} Record, RDH\nRegistered Dental Hygienist at Coastal Family Dentistry 2019 - present`], "resume.txt", { type: "text/plain" }));
    for (const rule of p.requirements.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("acknowledged", "yes");
    expect((await app.request(`/careers/${slug}/jobs/${role}/apply`, { method: "POST", body: fd })).status).toBe(302);
    await container.drain();
    const token = await statusTokenFor(container, { roleId: role, email });
    const [a] = await container.db.select().from(applications).where(eq(applications.statusToken, token));
    return a;
  }

  /** A résumé reading as the triage writes one: the first must-have shown with a quote, the first skill evidenced, the rest unknown. */
  async function readingFor(a: typeof applications.$inferSelect, createdAt = at(60), kind: "triage" | "screen" = "triage") {
    const [must, ...rest] = packet.requirements.mustHaves;
    const skill = packet.competencies[0];
    const result = {
      overall: "strong", confidence: "high", summary: "Reads well.", strengths: [], concerns: [], unknowns: [], anomalies: [], recommendation: "screen", rationale: "PRIVATE RATIONALE never shown",
      requirementFindings: [{ requirementKey: must.key, met: "yes", evidence: { quote: "Registered Dental Hygienist at Coastal Family Dentistry", source: "resume" } }, ...rest.map((m) => ({ requirementKey: m.key, met: "unknown" }))],
      competencyFindings: skill ? [{ competencyKey: skill.key, finding: "partially_evidenced", evidence: { quote: "Registered Dental Hygienist", source: "resume" }, note: "PRIVATE NOTE" }] : [],
    };
    const [row] = await withTenant(container.db, companyId, (tx) => tx.insert(assessments).values({ companyId, applicationId: a.id, kind, packetVersion: a.packetVersion, result: result as never, overall: "strong", confidence: "high", createdAt }).returning());
    await container.db.update(applications).set({ latestAssessmentId: row.id }).where(eq(applications.id, a.id));
    return row;
  }

  /** The chat this company's applicants are invited to, sent without ("send my application as it is"): nothing waits for it. */
  const withoutChat = (a: typeof applications.$inferSelect) => container.db.update(screens).set({ status: "declined_by_candidate" }).where(eq(screens.applicationId, a.id));
  const progressOf = (extra: Partial<ScreenProgress> = {}): ScreenProgress => ({ askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0, ...extra });
  const addScreen = (a: typeof applications.$inferSelect, s: { status: string; answers?: Record<string, string>; progress?: ScreenProgress; transcript?: ScreenTranscriptEntry[]; completedAt?: string | null; assessmentId?: string | null; createdAt?: string }) =>
    withTenant(container.db, companyId, async (tx) => (await tx.insert(screens).values({ companyId, applicationId: a.id, channel: "web", status: s.status, token: `scr${Math.random().toString(36).slice(2, 14)}`, answers: s.answers ?? {}, progress: s.progress ?? progressOf(), transcript: s.transcript ?? [], completedAt: s.completedAt ?? null, startedAt: at(-600), assessmentId: s.assessmentId ?? null, createdAt: s.createdAt ?? at(30) }).returning())[0]);

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", JOBS_BASE_URL: "https://jobs.example.test", SMS_ENABLED: "false" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@record.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json("POST", "/api/v1/companies", { name: "Record Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    slug = co.slug;
    roleId = await makeRole("I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.");
    its = await signInStaff(app, container, "ops@its-record.test", "platform_admin");
    // room for a second job, so one person can apply to two jobs at the company
    const plan = await json("POST", `/api/v1/admin/customers/${companyId}/plan`, { planKey: "pro", reason: "Two jobs for this suite" }, its, { "x-admin-reason": "test" });
    expect(plan.status, await plan.clone().text()).toBe(200);
    secondRoleId = await makeRole("I need a dental assistant in Irvine, $25 to $30 an hour, part time. New role. I decide. Must-haves: x-ray certificate. Just draft it.");
    packet = ((await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: RolePacket } }).currentPacket.packet;
  });
  afterAll(async () => {
    await container.close();
  });

  it("S7-1: after sending, the match score and its breakdown: the job page's must-haves by name, everything else in one line, nothing private; the job and the jump pills; no inline style and no script", async () => {
    const a = await applyAs("Ada", "ada.record@example.com");
    // a chat still waiting holds the score back (below); this one went without it
    await withoutChat(a);
    await readingFor(a);
    const { html, refresh } = await page(`/c/status/${a.statusToken}`);
    expect(refresh).toBeNull();
    // the progress line still comes straight after the title, then the pills that jump to each part (redesign spec C8)
    const main = html.slice(html.indexOf("<main>"));
    expect(main.slice(main.indexOf("</h1>") + "</h1>".length).startsWith('<ol class="track" aria-label="Where your application is">')).toBe(true);
    expect(html).toMatch(/<\/ol><nav aria-label="On this page"><ul class="jump"><li><a href="#score">Your match score<\/a><\/li><li><a href="#answers">Your answers<\/a><\/li><li><a href="#learned">What your chats added<\/a><\/li><li><a href="#job">The job<\/a><\/li><li><a href="#choices">Your choices<\/a><\/li>(<li><a href="#messages">Messages<\/a><\/li>)?<li><a href="#help">Help<\/a><\/li><\/ul><\/nav>/);
    for (const id of ["score", "answers", "learned", "job", "choices", "help"]) expect(html).toContain(`id="${id}"`);
    // one way to correct what went with the form, the same words as Review & send
    expect(html).toContain("To correct something, use \"Ask for a copy, a fix, deletion, or a person's review\" on your application's page; its link is in the email we sent you when you applied.");
    const score = html.slice(html.indexOf('<section class="card" id="score"'), html.indexOf("</section>", html.indexOf('id="score"')));
    expect(score).toContain('<p class="eyebrow">Your match score is ready</p>');
    expect(score).toMatch(/<span class="score-num">\d{1,3}<small>\/100<\/small><\/span><span>(Very high|High|Medium|Low) match<\/span>/);
    const must = packet.requirements.mustHaves[0];
    expect(score).toContain(`<li class="strong"><div class="bar-head"><span>${must.text}</span><span>100% met · Shown</span></div><progress max="100" value="100" aria-label="${must.text}: 100% met">100%</progress></li>`);
    if (packet.competencies.length) {
      // the skills the team looks for are not on the job page: one line, never a skill's name, so bars and number agree. What
      // nothing showed counts there at no points, so the line says how much was shown, never "met" (the release review, 11
      // November 2026: "0% met" in red read as "you meet none of what they look for")
      const shown = Number(score.match(/<span class="score-num">(\d{1,3})</)?.[1]);
      expect(score).toMatch(/<span>Other things the team looks for<\/span><span>\d{1,3}% shown<\/span><\/div><progress max="100" value="\d{1,3}" aria-label="Other things the team looks for: \d{1,3}% shown">/);
      expect(score).not.toMatch(/Other things the team looks for(<\/span><span>|: )\d{1,3}% met/);
      if (shown === 100) expect(score).toContain("<span>Other things the team looks for</span><span>100% shown</span>");
      for (const c of packet.competencies) expect(score).not.toContain(c.name);
    }
    // a must-have nothing showed is listed as not shown yet; skills nothing showed are private and stay unnamed
    if (packet.requirements.mustHaves.length > 1) expect(score).toContain("Not shown yet:");
    for (const m of packet.requirements.mustHaves.slice(1)) expect(score).toContain(m.text);
    expect(score).toMatch(/Based on \d+ of \d+ requirements\. Anything the team could not see in what you sent earns no points yet, and is never read as a no\./);
    expect(score).not.toMatch(/left out|held against/);
    if (packet.requirements.mustHaves.length > 1) expect(score).toContain("Nothing you sent says either way, so these earn no points yet.");
    // she sent it without the AI interview: the number is her résumé's alone, and says so (R20-9)
    expect(score).toContain('<p class="meta">From your résumé only. Based on ');
    expect(score).toContain("The team sees what you sent; their private notes are never shared with you.");
    expect(score).toContain("A person makes every decision");
    expect(html).not.toMatch(/PRIVATE RATIONALE|PRIVATE NOTE/);
    // the job as they applied to it, with its public page; its facts follow the heading, without the title and employer
    // again (the page's heading is the job and the line on who decides names the employer; fewer words, 23 October 2026)
    const job = html.slice(html.indexOf('<section class="card" id="job"'));
    expect(job).toContain('<h2 id="job-h">The job</h2><ul class="facts small">');
    expect(job).not.toContain(`<strong>${packet.identity.title}</strong> at Record Dental`);
    expect(job).toContain(`<a href="/careers/${slug}/jobs/${roleId}">See the job page</a>`);
    // everything that was on the page stays (redesign spec C8)
    for (const kept of ["<h2>What happens next</h2>", '<div class="card status">', "No longer interested?", "Ask for a copy, a fix, deletion, or a person's review", "Shared this link by mistake?", "How AI is used", "make every decision about your application"]) expect(html).toContain(kept);
    expect(html).not.toMatch(/ style="/);
    expect(html).not.toContain("<script");
  });

  it("names a folded line nothing in it showed '0% shown', in the bar and to a screen reader, never '0% met' (the release review, 11 November 2026)", async () => {
    expect(packet.competencies.length).toBeGreaterThan(0);
    const a = await applyAs("Bea", "bea.record@example.com");
    await withoutChat(a);
    const [must, ...rest] = packet.requirements.mustHaves;
    const result = {
      overall: "potential", confidence: "high", summary: "Reads well.", strengths: [], concerns: [], unknowns: [], anomalies: [], recommendation: "screen", rationale: "r",
      requirementFindings: [{ requirementKey: must.key, met: "yes", evidence: { quote: "Registered Dental Hygienist at Coastal Family Dentistry", source: "resume" } }, ...rest.map((m) => ({ requirementKey: m.key, met: "unknown" }))],
      competencyFindings: packet.competencies.map((c) => ({ competencyKey: c.key, finding: "not_evidenced" })),
    };
    const [row] = await withTenant(container.db, companyId, (tx) => tx.insert(assessments).values({ companyId, applicationId: a.id, kind: "triage", packetVersion: a.packetVersion, result: result as never, overall: "potential", confidence: "high", createdAt: at(60) }).returning());
    await container.db.update(applications).set({ latestAssessmentId: row.id }).where(eq(applications.id, a.id));
    const { html } = await page(`/c/status/${a.statusToken}`);
    const score = html.slice(html.indexOf('<section class="card" id="score"'), html.indexOf("</section>", html.indexOf('id="score"')));
    expect(score).toContain('<span>Other things the team looks for</span><span>0% shown</span></div><progress max="100" value="0" aria-label="Other things the team looks for: 0% shown">0%</progress>');
    expect(score).not.toMatch(/(^|[^\d])0% met/);
    // the must-have their résumé shows still reads as met, with its finding
    expect(score).toContain(`<span>${must.text}</span><span>100% met · Shown</span>`);
  });

  it("while the reading is worked out: 'Working out your match score…' with a plain Check again link (never a timed reload, WCAG 2.2.1), then 'Not ready yet'", async () => {
    const a = await applyAs("Ben", "ben.record@example.com");
    await withoutChat(a);
    // the reading is not written yet: the fake reading the drain wrote is taken away
    await withTenant(container.db, companyId, async (tx) => {
      await tx.update(applications).set({ latestAssessmentId: null }).where(eq(applications.id, a.id));
      await tx.delete(assessments).where(eq(assessments.applicationId, a.id));
    });
    let r = await page(`/c/status/${a.statusToken}`);
    // draft wording pending counsel (register items 1 and 21): the block keeps every word, its eyebrow included, until
    // counsel signs off; the fewer-words pass of 23 October 2026 does not apply to it
    expect(r.html).toContain('<section class="card" id="score" aria-labelledby="score-h" role="status"><p class="eyebrow">Your match score</p><h2 id="score-h">Working out your match score…</h2>');
    expect(r.html).toContain(`<a href="/c/status/${a.statusToken}#score">Check again</a>`);
    // the page holds forms the candidate may be typing in: it never reloads itself
    expect(r.html).not.toContain("http-equiv");
    expect(r.refresh).toBeNull();
    expect(r.html).not.toContain("<script");
    // past the window it says so plainly
    await container.db.update(applications).set({ createdAt: at(-20 * 60) }).where(eq(applications.id, a.id));
    r = await page(`/c/status/${a.statusToken}`);
    // word for word as drafted for counsel: the eyebrow, the heading, and the line that says where the score will show
    expect(r.html).toContain('<p class="eyebrow">Your match score</p><h2 id="score-h">Not ready yet</h2><p>Your match score shows here once it is ready. The hiring team reads every application themselves either way.</p>');
    expect(r.html).not.toContain("http-equiv");
    expect(r.refresh).toBeNull();
    // a change to what the chats added says what happened, a refused one as an alert
    expect((await page(`/c/status/${a.statusToken}?facts=personal`)).html).toContain('<div class="err" role="alert"><p>Please keep it to your work');
    expect((await page(`/c/status/${a.statusToken}?facts=changed`)).html).toContain('<div class="card" role="status"><p>Saved.');
    // once the reading is there, the score shows
    await readingFor(a);
    expect((await page(`/c/status/${a.statusToken}`)).html).toContain("Your match score is ready");
  });

  it("while an AI interview they sent has no scorecard, never a résumé-only number: 'Working out…', then 'Not ready yet', for as long as it takes (6 November 2026); while that scorecard waits for the AI credit, nothing about a score at all", async () => {
    const a = await applyAs("Noor", "noor.record@example.com");
    await readingFor(a);
    // it was sent, and its scorecard is not written yet: the résumé's number would read low for someone who did what was asked
    const sent = await addScreen(a, { status: "completed", progress: progressOf({ submittedAt: at(1) }), completedAt: at(1) });
    const scoreOf = async () => (await page(`/c/status/${a.statusToken}`)).html;
    let html = await scoreOf();
    expect(html).toContain('<h2 id="score-h">Working out your match score…</h2>');
    expect(html).not.toContain("Your match score is ready");
    expect(html).not.toContain("From your résumé only");
    // past the window, however long it waits: never the number
    await container.db.update(screens).set({ completedAt: at(-30 * 60) }).where(eq(screens.id, sent.id));
    html = await scoreOf();
    expect(html).toContain('<p class="eyebrow">Your match score</p><h2 id="score-h">Not ready yet</h2>');
    expect(html).not.toContain("Your match score is ready");
    expect(html).not.toContain("From your résumé only");
    // and no word about a plan or AI credit in what it tells them
    const scoreCard = html.slice(html.indexOf('<section class="card" id="score"'), html.indexOf("</section>", html.indexOf('<section class="card" id="score"')));
    expect(scoreCard).toContain("Not ready yet");
    expect(scoreCard).not.toMatch(/\b(credit|upgrade|plan)\b/i);
    // the scorecard waits for the company's AI credit (PL-10): nothing will work it out for now, so "Working out…" would not be
    // true, and the résumé's number still never stands in for it. Nothing is said about a score, a moment after sending or long after.
    for (const completedAt of [at(1), at(-30 * 60)]) {
      await container.db.update(screens).set({ completedAt, progress: progressOf({ submittedAt: completedAt, scoreWaitsForCredit: completedAt }) }).where(eq(screens.id, sent.id));
      html = await scoreOf();
      expect(html).not.toContain('id="score"');
      expect(html).not.toMatch(/match score|Not ready yet/i);
      expect(html).not.toContain("From your résumé only");
    }
  });

  /**
   * The release review (11 November 2026, L1-4): someone who asked for a person in the AI interview has a recruiter's call to
   * come, whose notes write the scorecard, and so has an AI interview a recruiter finished on a call until that scorecard is
   * written. The team reads their number as still to come, so their own page never shows the résumé's alone as ready.
   */
  it("someone who asked for a person, or whose AI interview a recruiter finished on a call, reads 'Not ready yet' until its scorecard is in, never a résumé-only number", async () => {
    const a = await applyAs("Kai", "kai.record@example.com");
    await readingFor(a);
    const scr = await addScreen(a, { status: "human_requested" });
    const scoreOf = async () => (await page(`/c/status/${a.statusToken}`)).html;
    // a moment after applying and long after: the call is a person's, so never "under a minute", and never the résumé's number
    for (const createdAt of [at(0), at(-20 * 60)]) {
      await container.db.update(applications).set({ createdAt }).where(eq(applications.id, a.id));
      const html = await scoreOf();
      expect(html).toContain('<p class="eyebrow">Your match score</p><h2 id="score-h">Not ready yet</h2><p>Your match score shows here once it is ready. The hiring team reads every application themselves either way.</p>');
      expect(html).not.toContain("Your match score is ready");
      expect(html).not.toContain("From your résumé only");
    }
    // the team reads the same: their AI interview is still to come
    expect(((await (await json("GET", `/api/v1/applications/${a.id}`)).json()) as { matchScore: { interview: string } }).matchScore.interview).toBe("not_done_yet");
    // a recruiter called and finished it with their notes: its scorecard is being written, as after the candidate's own Send
    await container.db.update(screens).set({ status: "completed", completedAt: at(0), progress: progressOf({ completedBy: "recruiter_call" }) }).where(eq(screens.id, scr.id));
    let html = await scoreOf();
    expect(html).toContain('<h2 id="score-h">Working out your match score…</h2>');
    expect(html).not.toContain("From your résumé only");
    await container.db.update(screens).set({ completedAt: at(-30 * 60) }).where(eq(screens.id, scr.id));
    html = await scoreOf();
    expect(html).toContain('<p class="eyebrow">Your match score</p><h2 id="score-h">Not ready yet</h2>');
    expect(html).not.toContain("From your résumé only");
    // once that scorecard is in, the number shows, counting both
    await container.db.update(screens).set({ assessmentId: (await readingFor(a, at(90), "screen")).id }).where(eq(screens.id, scr.id));
    html = await scoreOf();
    expect(html).toContain("Your match score is ready");
    expect(html).toMatch(/<p class="meta">From your résumé and your AI interview\. Based on /);
  });

  /**
   * The lead's D2 (11 November 2026): an AI interview they sent whose scorecard could not be written, for good (the screen's run
   * gave up and asked ITS to look), read "Not ready yet" for ever, and the team's label said "being scored" beside a card that
   * said its review could not be written. Both are true now: fix A's words for the candidate, and a label that says so.
   */
  it("a sent AI interview whose scorecard could not be written says 'Could not be worked out' at once, and the team's label says it could not be scored", async () => {
    const a = await applyAs("Lou", "lou.record@example.com");
    await readingFor(a);
    const [run] = await container.db.insert(workflowRuns).values({ companyId, workflowKey: "screen", subject: { type: "application", id: a.id }, status: "running", currentStep: "assess", state: {} }).returning();
    const sent = await addScreen(a, { status: "completed", progress: progressOf({ submittedAt: at(-30 * 60) }), completedAt: at(-30 * 60) });
    await container.db.update(screens).set({ workflowRunId: run.id }).where(eq(screens.id, sent.id));
    await container.db.update(applications).set({ stage: "screen_complete" }).where(eq(applications.id, a.id));
    const scoreCard = async () => {
      const { html } = await page(`/c/status/${a.statusToken}`);
      const from = html.indexOf('<section class="card" id="score"');
      expect(from, "the score card").toBeGreaterThan(-1);
      return html.slice(from, html.indexOf("</section>", from));
    };
    const team = async () => (await (await json("GET", `/api/v1/applications/${a.id}`)).json()) as { matchScore: { interview: string; basis: string }; screens: Array<{ id: string; scorecard?: string }> };
    // while it is being written: "Not ready yet", and the team's "being scored"
    expect(await scoreCard()).toContain('<h2 id="score-h">Not ready yet</h2>');
    expect((await team()).matchScore).toMatchObject({ interview: "being_scored" });
    // the run gave up for good: nothing will write it by itself
    await container.db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, run.id));
    const card = await scoreCard();
    expect(card).toContain('<p class="eyebrow">Your match score</p><h2 id="score-h">Could not be worked out</h2><p>The hiring team reads your application themselves.</p>');
    expect(card).not.toMatch(/Not ready yet|Working out|once it is ready|From your résumé only/);
    expect(card).not.toMatch(/\b(credit|upgrade|plan)\b/i);
    // the page the chat closes on promises no score either
    expect((await page(`/c/screen/${sent.token}`)).html).not.toMatch(/match score/i);
    // the team: the scorecard card says it could not be written, and the label beside the number says the same, on the panel and the list
    const detail = await team();
    expect(detail.screens.find((s) => s.id === sent.id)?.scorecard).toBe("unavailable");
    expect(detail.matchScore).toMatchObject({ interview: "scoring_failed", basis: "Résumé only: AI interview could not be scored" });
    const rows = (await (await json("GET", `/api/v1/roles/${roleId}/applications`)).json()) as Array<{ id: string; interview: string | null; basis: string | null }>;
    expect(rows.find((r) => r.id === a.id)).toMatchObject({ interview: "scoring_failed", basis: "Résumé only: AI interview could not be scored" });
    // the board keeps them apart, in words that say so
    const board = (await (await json("GET", `/api/v1/roles/${roleId}/board`)).json()) as { noAiInterview: Array<{ applicationId: string; placement: { doneLabel: string | null } }> };
    expect(board.noAiInterview.find((c) => c.applicationId === a.id)?.placement.doneLabel).toBe("AI interview could not be scored");
  });

  it("S7-2: 'Your answers' reads back exactly what was sent: the form's questions in sentences and the sent chat, the assistant's note apart; an unsent chat shows nothing and holds the score back", async () => {
    const a = await applyAs("Cleo", "cleo.record@example.com");
    await readingFor(a);
    const [q1, q2] = packet.screening.questions;
    // a chat still open: none of it shows, and the score waits for it
    const open = await addScreen(a, { status: "in_progress", answers: { [q1.key]: "UNSENT ANSWER" }, transcript: [{ role: "candidate", content: "UNSENT ANSWER", at: at(0) }] });
    let { html } = await page(`/c/status/${a.statusToken}`);
    expect(html).not.toContain("UNSENT ANSWER");
    expect(html).toContain('<h2 id="score-h">Shown once your AI interview is sent</h2>');
    expect(html).not.toContain("Your match score is ready");
    const answers = html.slice(html.indexOf('<section id="answers"'), html.indexOf("</section>", html.indexOf('<section id="answers"')));
    expect(answers).toContain("<h3>Your details</h3>");
    // only enough to recognise them: the address masked, as everywhere on a page a link opens
    expect(answers).toContain('<dl class="details"><dt>Email</dt><dd>c***@example.com</dd><dt>Where you are</dt><dd>Irvine, CA</dd>');
    expect(answers).not.toContain("cleo.record@example.com");
    for (const rule of packet.requirements.eligibility) expect(answers).toContain(rule.question.trim());
    expect(answers).toMatch(/<li>[^<]+ Yes\.<\/li>/);
    expect(answers).not.toContain("From your chat");
    // sent: the answers, the write-up's note apart, and the chat word for word one click away
    await container.db.update(screens).set({ status: "completed", completedAt: at(-30 * 60), assessmentId: (await readingFor(a, at(90), "screen")).id, answers: { [q1.key]: "I love perio work." }, progress: progressOf({ submittedAt: at(-30 * 60), declined: q2 ? [q2.key] : [], writeup: { v: 1, writtenAt: at(-30 * 60), aiRunId: null, promptVersion: 1, answers: [{ questionKey: q1.key, answer: "I love perio work and live nearby.", status: "answered", quotes: ["I love perio work."], note: null, by: "writeup" }, ...(q2 ? [{ questionKey: q2.key, answer: "", status: "skipped" as const, quotes: [], note: "No example was given.", by: "writeup" as const }] : [])] } }), transcript: [{ role: "assistant", content: "First question. Reply HUMAN at any time to reach a person.", at: at(-40 * 60) }, { role: "candidate", content: "I love perio work.", at: at(-39 * 60) }, { role: "system", content: "SYSTEM LINE", at: at(-38 * 60) }, { role: "recruiter", content: "RECRUITER NOTE", at: at(-37 * 60) }] }).where(eq(screens.id, open.id));
    ({ html } = await page(`/c/status/${a.statusToken}`));
    const chat = html.slice(html.indexOf("<h3>From your chat</h3>"), html.indexOf("</section>", html.indexOf("<h3>From your chat</h3>")));
    expect(chat).toContain(`<p class="said-q">1. ${q1.question}</p><p class="pre">I love perio work and live nearby.</p>`);
    if (q2) {
      expect(chat).toContain(`<p class="said-q">2. ${q2.question}</p><p><span class="state">Skipped</span></p><p class="pre">You skipped this question.</p><p class="said-note"><strong>Note from the assistant:</strong> No example was given.</p>`);
    }
    expect(chat).toContain("<summary>Your chat, word for word</summary>");
    expect(chat).toContain('<li class="msg candidate"><span class="sr-only">You said: </span>I love perio work.</li>');
    expect(chat).toContain('<li class="msg assistant"><span class="sr-only">The assistant said: </span>First question.</li>');
    expect(chat).not.toMatch(/SYSTEM LINE|RECRUITER NOTE|Reply HUMAN/);
    expect(html).toContain("Your match score is ready");
    expect(html).toContain("sees this score with your application and your chat.");
    // what the number rests on, in their words (R20-9): their AI interview's scorecard is in it
    expect(html).toMatch(/<p class="meta">From your résumé and your AI interview\. Based on \d+ of \d+ requirements\./);
  });

  it("the ITS switch (on by default): ITS turns the score off for a company with a reason, recorded; the customer cannot; the record then says nothing about a score", async () => {
    const a = await applyAs("Dev", "dev.record@example.com");
    await withoutChat(a);
    await readingFor(a);
    expect((await page(`/c/status/${a.statusToken}`)).html).toContain('id="score"');
    const list = (await (await json("GET", "/api/v1/admin/customers", undefined, its, { "x-admin-reason": "test" })).json()) as Array<{ id: string; candidateScoreShown: boolean }>;
    expect(list.find((x) => x.id === companyId)?.candidateScoreShown).toBe(true);
    // a reason is required, the customer is refused, and a customer cannot set it through their own settings
    const path = `/api/v1/admin/customers/${companyId}/candidate-score`;
    expect((await json("POST", path, { shown: false, reason: "no" }, its, { "x-admin-reason": "test" })).status).toBe(400);
    expect((await json("POST", path, { shown: false, reason: "Customer asked to wait for counsel" }, owner)).status).toBe(403);
    const patch = await json("PATCH", "/api/v1/companies/current", { settings: { candidateScoreShown: false } });
    expect(patch.status).toBe(400);
    expect(((await patch.json()) as { error: { code: string } }).error.code).toBe("not_yours_to_change");
    const off = await json("POST", path, { shown: false, reason: "Customer asked to wait for counsel" }, its, { "x-admin-reason": "test" });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ ok: true, companyId, shown: false, changed: true });
    const { html } = await page(`/c/status/${a.statusToken}`);
    expect(html).not.toContain('id="score"');
    expect(html).not.toContain('href="#score"');
    expect(html).not.toMatch(/match score/i);
    // nor the page a sent chat closes on: no score is coming. Its scorecard is in, so the switch is all that holds the score
    // back (a sent chat with none never shows a number, switch or not: 6 November 2026).
    const sentChat = await addScreen(a, { status: "completed", completedAt: at(-30 * 60), progress: progressOf({ submittedAt: at(-30 * 60) }), assessmentId: (await readingFor(a, at(90), "screen")).id });
    const closed = (await page(`/c/screen/${sentChat.token}`)).html;
    expect(closed).toContain("<h1>Thanks, your answers are sent</h1>");
    expect(closed).not.toMatch(/match score/i);
    expect(closed).toContain("Everything you sent will be on your application page.");
    // recorded with who, when and why, as a change to the company's settings the customer's history lists
    const recorded = (await container.db.select().from(auditRecords).where(eq(auditRecords.companyId, companyId))).filter((r) => r.action === "company.updated" && (r.details as { fields?: string[] }).fields?.includes("candidateScoreShown"));
    expect(recorded.at(-1)).toMatchObject({ reason: "Customer asked to wait for counsel", details: { candidateScoreShown: { from: true, to: false } } });
    const again = (await (await json("GET", "/api/v1/admin/customers", undefined, its, { "x-admin-reason": "test" })).json()) as Array<{ id: string; candidateScoreShown: boolean; settings: { candidateScoreSetBy?: { reason: string } } }>;
    expect(again.find((x) => x.id === companyId)).toMatchObject({ candidateScoreShown: false, settings: { candidateScoreSetBy: { reason: "Customer asked to wait for counsel" } } });
    // and back on
    expect(await (await json("POST", path, { shown: true, reason: "Counsel reviewed the wording" }, its, { "x-admin-reason": "test" })).json()).toMatchObject({ shown: true, changed: true });
    expect((await page(`/c/status/${a.statusToken}`)).html).toContain("Your match score is ready");
  });

  it("B6, spec step 9: the decision shows on the record once they were told, never before", async () => {
    const a = await applyAs("Eve", "eve.record@example.com");
    await readingFor(a);
    await container.db.update(applications).set({ stage: "rejected", toldState: "not_told", stageChangedAt: at(-60), rejectedAt: at(-60) }).where(eq(applications.id, a.id));
    let { html } = await page(`/c/status/${a.statusToken}`);
    expect(html).not.toMatch(/not moving forward|id="decision"/i);
    await withTenant(container.db, companyId, (tx) => tx.insert(communications).values({ companyId, candidateId: a.candidateId, applicationId: a.id, direction: "outbound", channel: "email", subject: "Your application to Record Dental", bodyText: "This role did not work out.", templateKey: "disposition:human", status: "sent", sentBy: { kind: "system", id: "test" }, createdAt: at(5) }));
    await container.db.update(applications).set({ toldState: "sent" }).where(eq(applications.id, a.id));
    ({ html } = await page(`/c/status/${a.statusToken}`));
    expect(html).toContain('<section class="card" aria-labelledby="decision"><p class="eyebrow">Decision</p><h2 id="decision">Not moving forward</h2>');
    expect(html).toContain('<a href="#messages">Messages about your application</a>');
    // the decision card follows the status card, and the status card says Decision as before
    expect(html.indexOf('<div class="card status">')).toBeLessThan(html.indexOf('id="decision"'));
    expect(html).toMatch(/<span>Status<\/span><strong>Decision<\/strong>/);
  });

  it("spec step 11: the candidate's other applications at the same company, with their pills and no link into them; nothing about a private decision", async () => {
    const a = await applyAs("Fay", "fay.record@example.com");
    const b = await applyAs("Fay", "fay.record@example.com", secondRoleId);
    expect(b.candidateId).toBe(a.candidateId);
    let { html } = await page(`/c/status/${a.statusToken}`);
    expect(html).toContain('<li><a href="#applications">Your applications at Record Dental</a></li>');
    let apps = html.slice(html.indexOf('<section id="applications"'), html.indexOf("</section>", html.indexOf('<section id="applications"')));
    expect(apps).toContain('<h2 id="applications-h">Your applications at Record Dental</h2>');
    // one forwarded link opens only its own application: no other application's link, and no chat's
    expect(apps).not.toContain(b.statusToken);
    expect(apps).not.toContain(a.statusToken);
    expect(apps).toContain('<a href="/c/link-request">get your links again</a>');
    // a chat waiting for them: Needs you, still without its link
    await container.db.update(screens).set({ status: "cancelled" }).where(eq(screens.applicationId, b.id));
    const waiting = await addScreen(b, { status: "invited" });
    ({ html } = await page(`/c/status/${a.statusToken}`));
    apps = html.slice(html.indexOf('<section id="applications"'));
    expect(apps).toContain('<span class="state needs_you">Needs you</span>');
    expect(html).not.toContain(waiting.token);
    // a private decision on it (its chat closed with it) reads exactly as before: Needs you, never Waiting or Closed
    await container.db.update(screens).set({ status: "cancelled" }).where(eq(screens.id, waiting.id));
    await container.db.update(applications).set({ stage: "rejected", toldState: "not_told" }).where(eq(applications.id, b.id));
    ({ html } = await page(`/c/status/${a.statusToken}`));
    apps = html.slice(html.indexOf('<section id="applications"'));
    expect(apps).toContain('<span class="state needs_you">Needs you</span>');
    expect(apps).not.toMatch(/Closed|not moving forward|state waiting/i);
    await container.db.update(applications).set({ toldState: "sent" }).where(eq(applications.id, b.id));
    expect((await page(`/c/status/${a.statusToken}`)).html).toContain('<span class="state closed">Closed</span>');
    // the second application's own record lists the first, without its link
    const fromB = (await page(`/c/status/${b.statusToken}`)).html;
    expect(fromB).toContain('<section id="applications"');
    expect(fromB).not.toContain(a.statusToken);
  });

  it("spec step 9: the job page and the careers page lead a returning applicant to their application", async () => {
    const job = await page(`/careers/${slug}/jobs/${roleId}`);
    expect(job.html).toContain('<a href="/c/link-request">Already applied? See your application</a>');
    expect((await page(`/careers/${slug}`)).html).toContain('<a href="/c/link-request">Already applied? See your application</a>');
  });

  /**
   * A score that never comes (10 November 2026): once nothing will work a number out by itself, the record says so at once in
   * short true words, never "Working out…" or "Not ready yet" for ever. Two ways: the résumé reading could not be made (the
   * assistant's answer unusable every time), or AI never reads an emailed-in applicant's résumé because our email with the AI
   * notice did not reach them (known-bugs row 16). While their AI interview is open its scorecard can still give one, so that
   * line stays. The team's panel says it in its own words (`noReading`), instead of a review "a minute or two" away.
   */
  it("a score that will not come by itself says so at once: the reading could not be made, or AI does not read their résumé (row 16); the team's panel is told why", async () => {
    const scoreCard = async (token: string) => {
      const { html } = await page(`/c/status/${token}`);
      const from = html.indexOf('<section class="card" id="score"');
      expect(from, "the score card").toBeGreaterThan(-1);
      return html.slice(from, html.indexOf("</section>", from));
    };
    const panel = async (id: string) => (await (await json("GET", `/api/v1/applications/${id}`)).json()) as { noReading?: string | null; assessments: unknown[] };
    /** Their AI interview link closed unused: its run ended with it, as the run itself ends it. */
    const chatClosed = async (a: typeof applications.$inferSelect, status: string) => {
      await container.db.update(screens).set({ status }).where(eq(screens.applicationId, a.id));
      await container.db.update(workflowRuns).set({ status: "completed" }).where(and(eq(workflowRuns.workflowKey, "screen"), sql`${workflowRuns.subject}->>'id' = ${a.id}`));
    };
    const NO_SCORE = '<p class="eyebrow">Your match score</p><h2 id="score-h">Could not be worked out</h2><p>The hiring team reads your application themselves.</p>';

    // every résumé reading unusable (each with the runner's one retry): the reading cannot be made
    for (let i = 0; i < TRIAGE_READINGS * 2; i++) container.fake!.failNext("triage.assess", "invalid");
    const gil = await applyAs("Gil", "gil.record@example.com");
    expect(await container.db.select().from(assessments).where(eq(assessments.applicationId, gil.id))).toHaveLength(0);
    // their AI interview is open, and its scorecard can still give a number: the line stays as it was
    expect(await scoreCard(gil.statusToken)).toContain('<h2 id="score-h">Shown once your AI interview is sent</h2>');
    // they sent the application without it: nothing will work one out, so the record says so at once, a moment after applying too
    await chatClosed(gil, "declined_by_candidate");
    let card = await scoreCard(gil.statusToken);
    expect(card).toContain(NO_SCORE);
    expect(card).not.toMatch(/Not ready yet|Working out|once it is ready|Check again/);
    expect(card).not.toMatch(/\b(credit|upgrade|plan)\b/i);
    // the team's panel is told the review could not be made, never that one comes in a minute or two
    expect((await panel(gil.id)).noReading).toBe("could_not_read");

    // an emailed-in applicant whose email with the AI notice could not go: AI never reads their résumé (row 16)
    await suppressAddress(container.db, { address: "hal.record@example.com", reason: "hard_bounce", source: "admin", actor: { kind: "system", id: "test" } });
    const made = await withTenant(container.db, companyId, (tx) => createApplication(tx, container, { companyId, roleId, source: "email_in", firstName: "Hal", lastName: "Record", email: "hal.record@example.com", phone: null, smsConsent: false, consentSource: "email_in", noticeVersionsShown: [], eligibilityAnswers: Object.fromEntries(packet.requirements.eligibility.map((r) => [r.key, "yes"])), noResumeAnswers: { summary: "Registered dental hygienist, eight years of perio work." } }, { kind: "system", id: "email_in" }));
    await container.drain();
    const [hal] = await container.db.select().from(applications).where(eq(applications.id, made.application.id));
    expect(await container.db.select().from(assessments).where(eq(assessments.applicationId, hal.id))).toHaveLength(0);
    expect((await panel(hal.id)).noReading).toBe("no_ai_notice");
    // the link in that email closed unused: no reading and no AI interview will give a number
    await chatClosed(hal, "expired");
    card = await scoreCard(hal.statusToken);
    expect(card).toContain(NO_SCORE);
    expect(card).not.toMatch(/Not ready yet|Working out|once it is ready/);
    // the required notices stay on the page around it
    const { html } = await page(`/c/status/${hal.statusToken}`);
    for (const kept of ["How AI is used", "make every decision about your application"]) expect(html).toContain(kept);

    // a reading that is only late keeps the words that promise it: nothing has given up on it
    const ivy = await applyAs("Ivy", "ivy.record@example.com");
    await chatClosed(ivy, "declined_by_candidate");
    await withTenant(container.db, companyId, async (tx) => {
      await tx.update(applications).set({ latestAssessmentId: null, createdAt: at(-20 * 60) }).where(eq(applications.id, ivy.id));
      await tx.delete(assessments).where(eq(assessments.applicationId, ivy.id));
    });
    await container.db.update(workflowRuns).set({ status: "waiting" }).where(eq(workflowRuns.idempotencyKey, `application_intake:${ivy.id}`));
    expect(await scoreCard(ivy.statusToken)).toContain('<h2 id="score-h">Not ready yet</h2><p>Your match score shows here once it is ready.');
    expect((await panel(ivy.id)).noReading ?? null).toBeNull();
    // and one whose intake stopped for good, a request raised to ITS, says the reading could not be made
    await container.db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.idempotencyKey, `application_intake:${ivy.id}`));
    expect(await scoreCard(ivy.statusToken)).toContain(NO_SCORE);
    expect((await panel(ivy.id)).noReading).toBe("could_not_read");
  });
});
