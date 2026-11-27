import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { CHAT_WRAP_KEY, type CandidatePanel, type ScreenTurn } from "@ros/contracts";
import { gapQuestion, namesCredential } from "@ros/agents";
import { aiRuns, applications, assessments, candidates, companies, events, notifications, screens } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { applicationForm, plantJob, seedCompany, usePlan } from "./test-helpers";

/**
 * Rules of the AI interview, proven over HTTP. A question gets at most one follow-up: the stand-in model is scripted
 * to keep asking for more, since its own handler would not, and the code still moves on. "I'd rather talk to a
 * person" leads to one plain choice that closes the AI interview as the candidate's own choice, tells the hiring team
 * once, sends them nothing the candidate typed, changes nothing when pressed again, and is rate-limited per link. And a
 * must-have the candidate answered No about on the application form is not asked about again, while a licence or a
 * certificate the chat does ask about is asked once, as yes or no, with the Yes and No buttons of a yes-or-no question.
 */
describe("AI interview rules: the follow-up cap, choosing a person instead, and what is not asked twice", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let slug = "";
  let roleId = "";
  const QUESTIONS = [
    { key: "license", question: "Do you hold an active California RDH license?", kind: "eligibility" as const },
    { key: "charting", question: "Tell me about the periodontal charting you do.", kind: "skills" as const },
    { key: "patient", question: "Tell me about a nervous patient and what you did.", kind: "behavioral" as const },
  ];

  const form = (path: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) });
  const screenOf = async (applicationId: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, applicationId)).orderBy(desc(screens.createdAt)))[0];
  const eventsFor = async (type: string, subjectId: string) => container.db.select().from(events).where(and(eq(events.type, type), eq(events.subjectId, subjectId)));
  /** The team's updates that this applicant chose a person instead of the AI interview. */
  const toldTheyChose = async (applicationId: string) => (await container.db.select().from(notifications).where(eq(notifications.kind, "screen.declined_by_candidate"))).filter((x) => (x.action?.href ?? "").includes(applicationId));
  const decodeEntities = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const pageOf = async (path: string) => decodeEntities(await (await app.request(path)).text());

  /** Someone applies (to `role`, with `resume`, where given), the team shortlists them, and they press Start: the job's first question is on the page. */
  async function interview(p: { first: string; last: string; email: string; role?: string; resume?: string }) {
    const role = p.role ?? roleId;
    expect((await app.request(`/careers/${slug}/jobs/${role}/apply`, { method: "POST", body: applicationForm({ firstName: p.first, lastName: p.last, email: p.email }, p.resume) })).status).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, p.email));
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, role), eq(applications.candidateId, cand.id)));
    expect(a.stage).toBe("triaged");
    expect((await app.request(`/api/v1/applications/${a.id}/actions`, { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ action: "shortlist" }) })).status).toBe(200);
    await container.drain();
    const scr = await screenOf(a.id);
    expect((await app.request(`/c/screen/${scr.token}`)).status).toBe(200);
    expect((await form(`/c/screen/${scr.token}/start`)).status).toBe(302);
    return { application: a, candidate: cand, token: scr.token, screenId: scr.id };
  }

  /** What a model that keeps asking for more would say: a follow-up, with no question key. */
  const followUp: ScreenTurn = { messageToCandidate: "Could you say a bit more about that? A sentence or two is plenty.", questionKey: null, followUpReason: "answer too short to establish anything", candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };

  beforeAll(async () => {
    // The per-link budget for "Tell the hiring team" is lowered so the test can trip it without thirty posts.
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", RATE_LIMIT_OVERRIDES: JSON.stringify({ "candidate.screen_human": 3 }) } });
    app = createApp(container);
    const company = await seedCompany(app, { email: "dana@rules.test", name: "Rules Dental Group" });
    ({ owner, slug } = company);
    await usePlan(container, company.companyId);
    roleId = await plantJob(container, { companyId: company.companyId, title: "Dental Hygienist", packet: (p) => { p.screening.questions = QUESTIONS.map((q) => ({ ...q })); } });
  });
  afterAll(async () => {
    await container.close();
  });

  it("a yes-or-no question takes its answer; an open one gets one push for specifics, then the chat moves on; the page shows all of it", async () => {
    const { application, token, screenId } = await interview({ first: "Maria", last: "Reyes", email: "maria.reyes@rules.test" });
    const opened = await screenOf(application.id);
    expect(opened.progress.currentQuestionKey).toBe("license");
    expect(opened.progress.chat?.section).toBe("required");
    const shown = opened.transcript.length;
    const runsOf = async () => (await container.db.select().from(aiRuns).where(eq(aiRuns.task, "screen.turn"))).filter((r) => (r.inputRef as { screenId?: string }).screenId === screenId).length;
    const runsBefore = await runsOf();
    // The model keeps asking for more every time. Each scripted turn still has to satisfy the ScreenTurn schema.
    const say = async (message: string) => {
      container.fake!.scriptNext("screen.turn", followUp);
      const r = await form(`/c/screen/${token}`, { message });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe(`/c/screen/${token}`);
      return screenOf(application.id);
    };
    // the license question is a yes-or-no one: "Yes" is its answer, and the chat moves on without asking for more
    let scr = await say("Yes");
    expect(scr.answers.license).toBe("Yes");
    expect(scr.progress.currentQuestionKey).toBe("charting");
    expect(scr.transcript.at(-1)).toMatchObject({ role: "assistant", content: QUESTIONS[1].question, questionKey: "charting" });
    // the open question: one push for specifics, in one question (the model's second sentence is left out)
    scr = await say("Yes");
    expect(scr.progress.currentQuestionKey).toBe("charting");
    expect(scr.transcript.at(-1)).toMatchObject({ role: "assistant", content: "Could you say a bit more about that?" });
    expect(scr.progress.chat?.items.find((i) => i.key === "charting")).toMatchObject({ state: "asking", pushes: 1 });
    // the page: the chat as a thread, the push the one to answer now, the reply box named after it, how far along in one line
    const page = await pageOf(`/c/screen/${token}`);
    expect(page).toContain('<li class="msg candidate"><span class="sr-only">You said: </span>Yes</li>');
    expect(page).toContain('<li class="msg assistant now" id="question"><span class="sr-only">The assistant said: </span>Could you say a bit more about that?</li>');
    expect(page).toContain("Your reply<span class=\"sr-only\"> to: Could you say a bit more about that?</span>");
    expect(page).toContain(`<p class="meta">Question 2 of ${QUESTIONS.length}</p>`);
    // a second push is not asked: the chat moves on, with the candidate's own words as the answer
    scr = await say("Yes.");
    expect(scr.progress.currentQuestionKey).toBe("patient");
    const since = scr.transcript.slice(shown);
    const assistant = since.filter((t) => t.role === "assistant");
    expect(assistant).toHaveLength(3); // the next question, one push, then the question after
    expect(assistant[2]).toMatchObject({ content: QUESTIONS[2].question, questionKey: "patient" });
    expect(since.filter((t) => t.role === "candidate").map((t) => t.content)).toEqual(["Yes", "Yes", "Yes."]);
    expect(scr.answers.charting).toBe("Yes Yes.");
    expect(scr.progress.askedKeys.slice(-3)).toEqual(["license", "charting", "patient"]);
    // every turn went through the model runner and was recorded
    expect(await runsOf()).toBe(runsBefore + 3);
    // the page counts both as done: the third is the one being asked
    const html = await pageOf(`/c/screen/${token}`);
    expect(html).toContain(`<p class="meta">Question 3 of ${QUESTIONS.length}</p>`);
    expect(html).toContain(`<li class="msg assistant now" id="question"><span class="sr-only">The assistant said: </span>${QUESTIONS[2].question}</li>`);
    // the next answer is read afresh: the push count of the last question is not carried over
    expect((await form(`/c/screen/${token}`, { message: "A nervous patient wanted to stop, so I slowed down and explained each step; she rebooked with me." })).status).toBe(302);
    const later = await screenOf(application.id);
    expect(later.answers.patient).toMatch(/nervous patient/);
    expect(later.progress.chat?.items.find((i) => i.key === "patient")?.pushes).toBe(0);
    // every question is closed and only the closing one is left: the line says so, in plain words
    expect(later.progress.currentQuestionKey).toBe(CHAT_WRAP_KEY);
    expect(await pageOf(`/c/screen/${token}`)).toContain(`<p class="meta">All ${QUESTIONS.length} questions done</p>`);
  });

  it("'I'd rather talk to a person' is one plain choice: it closes the AI interview as theirs, tells the team once with none of their words, changes nothing when pressed again, and is rate-limited per link", async () => {
    const { application, candidate, token, screenId } = await interview({ first: "Luis", last: "Ortega", email: "luis.ortega@rules.test" });
    const answer = "Yes, my RDH license is active in California, number RDH12345.";
    expect((await form(`/c/screen/${token}`, { message: answer })).status).toBe(302);
    const before = await screenOf(application.id);
    expect(before.status).toBe("in_progress");
    expect(before.answers.license).toBe(answer);

    // the way there is a link on the chat's page; opening the choice changes nothing
    expect(await pageOf(`/c/screen/${token}`)).toContain(`<a class="link-action" href="/c/screen/${token}/person">I'd rather talk to a person</a>`);
    const choice = await pageOf(`/c/screen/${token}/person`);
    expect(choice).toContain("<h1>Talk to a person instead</h1>");
    expect(choice).toContain("That is fine. Anything you have answered so far is not sent to the hiring team.");
    expect(choice).toContain("The hiring team at Rules Dental Group is told you would rather talk to a person than do the AI interview. Your application stays with them, and they decide the next step. This AI interview then closes.");
    expect(choice).toContain(`<form method="post" action="/c/screen/${token}/person"><button class="btn secondary" type="submit">Tell the hiring team</button></form>`);
    expect((await screenOf(application.id)).status).toBe("in_progress");
    expect(await toldTheyChose(application.id)).toHaveLength(0);

    const r = await form(`/c/screen/${token}/person`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/c/screen/${token}`);
    await container.drain();
    const after = await screenOf(application.id);
    expect(after.status).toBe("declined_by_candidate");
    expect(after.completedAt).toBeTruthy();
    // the candidate is told, in the chat and on the page, that the team knows: nobody is promised a call
    expect(after.transcript.at(-1)).toMatchObject({ role: "assistant", content: "Thanks, Luis. The hiring team at Rules Dental Group has been told that you would rather talk to a person than do the AI interview. Nothing you typed here was sent to them. People on the team make every decision." });
    const html = await pageOf(`/c/screen/${token}`);
    expect(html).toContain("<h1>The hiring team has been told</h1>");
    expect(html).toContain("The hiring team at Rules Dental Group has been told you would rather talk to a person than do the AI interview. They decide the next step.");
    expect(html).toContain("Anything you answered here was not sent to the hiring team. Nothing else is needed from you here.");
    expect(html).not.toContain('name="message"'); // the chat is closed
    // the team reads that he chose so, and none of the answers he never sent
    const detail = await (await app.request(`/api/v1/applications/${application.id}`, { headers: { cookie: owner } })).text();
    expect((JSON.parse(detail) as CandidatePanel).aiInterview).toMatchObject({ status: "opted_out", answers: [], review: null });
    expect(detail).not.toContain("RDH12345");
    // the fact and the team's update, which never carries the candidate's words
    expect(await eventsFor("screen.declined_by_candidate", screenId)).toHaveLength(1);
    const notes = await toldTheyChose(application.id);
    expect(notes.map((x) => x.title)).toEqual(["Luis Ortega chose not to do the AI interview"]);
    expect(notes[0].body).not.toContain("RDH12345");
    // nothing is decided: the application stays where it was, and the person is who they were
    expect((await container.db.select().from(applications).where(eq(applications.id, application.id)))[0].stage).toBe("screening");
    const [row] = await container.db.select().from(candidates).where(eq(candidates.id, candidate.id));
    expect(row).toMatchObject({ firstName: "Luis", lastName: "Ortega", email: "luis.ortega@rules.test" });

    // pressing again changes nothing: one fact, one update, the same time stamp; the choice's page leads back to the closed one
    expect((await form(`/c/screen/${token}/person`)).status).toBe(302);
    await container.drain();
    expect((await screenOf(application.id)).completedAt).toBe(after.completedAt);
    expect(await eventsFor("screen.declined_by_candidate", screenId)).toHaveLength(1);
    expect(await toldTheyChose(application.id)).toHaveLength(1);
    expect((await app.request(`/c/screen/${token}/person`)).headers.get("location")).toBe(`/c/screen/${token}`);
    // a further message is no answer: the AI interview stays closed with what it had
    expect((await form(`/c/screen/${token}`, { message: "Hello?" })).status).toBe(302);
    const still = await screenOf(application.id);
    expect(still.status).toBe("declined_by_candidate");
    expect(still.answers).toEqual(after.answers);

    // the link's own budget (three an hour here, thirty in production): the next press is refused plainly, nothing breaks
    expect((await form(`/c/screen/${token}/person`)).status).toBe(302);
    const fourth = await form(`/c/screen/${token}/person`, {}, { accept: "text/html" });
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await fourth.text()).toContain("Please try again in");
    expect(await toldTheyChose(application.id)).toHaveLength(1);
  });

  it("a dead link and a closed AI interview are refused without creating anything", async () => {
    // another address: the lowered budget above is per address as well as per link
    const elsewhere = { "x-forwarded-for": "203.0.113.77" };
    expect((await form(`/c/screen/${"x".repeat(32)}/person`, {}, elsewhere)).status).toBe(404);
    expect((await app.request(`/c/screen/${"x".repeat(32)}/person`)).status).toBe(404);
    const { application, token } = await interview({ first: "Ana", last: "Silva", email: "ana.silva@rules.test" });
    const scr = await screenOf(application.id);
    await container.db.update(screens).set({ status: "expired" }).where(eq(screens.id, scr.id));
    const r = await form(`/c/screen/${token}/person`, {}, elsewhere);
    expect(r.status).toBe(302);
    expect((await screenOf(application.id)).status).toBe("expired");
    expect(await toldTheyChose(application.id)).toHaveLength(0);
    // the closed page says the link has closed and what was not passed on, and offers nothing to press
    const html = await pageOf(`/c/screen/${token}`);
    expect(html).toContain("<h1>This link has closed</h1>");
    expect(html).toContain("The link to this AI interview has closed. The answers you did not send were not passed on. If you would still like to do it, reply to any of our emails: the hiring team at Rules Dental Group can send you a new link.");
    expect(html).not.toContain('action="/c/screen/');
  });

  // The code check of 25 November 2026: the form asked "Do you hold a radiography certificate?", they answered No, and
  // the AI interview asked them about that certificate again.
  it("someone who answered No on the application form about a certificate the job needs is not asked about it again; someone the form's question went unanswered for is asked once, as yes or no", async () => {
    const [company] = await container.db.select({ id: companies.id }).from(companies).where(eq(companies.slug, slug));
    const QUESTION = "Do you hold a radiography certificate?";
    const job = await plantJob(container, { companyId: company.id, title: "Dental Assistant", packet: (p) => { p.formQuestions = [{ kind: "yes_no", key: "fq_certificate", question: QUESTION, required: false }]; } });
    // a resume that says nothing about the certificate, so the reading has only the form's answer to go on
    const RESUME = "Dental Assistant at Park Dental 2018 - present\nChairside assisting daily with two dentists\nDentrix";
    /** Applies with these answers on the form, is shortlisted, and presses Start: the chat's plan as it was fixed. */
    const planOf = async (p: { first: string; email: string }, answers: Record<string, string>, role = job) => {
      expect((await app.request(`/careers/${slug}/jobs/${role}/apply`, { method: "POST", body: applicationForm({ firstName: p.first, lastName: "Tester", email: p.email, ...answers }, RESUME) })).status).toBe(302);
      await container.drain();
      const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, p.email));
      const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, role), eq(applications.candidateId, cand.id)));
      expect((await app.request(`/api/v1/applications/${a.id}/actions`, { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ action: "shortlist" }) })).status).toBe(200);
      await container.drain();
      const invited = await screenOf(a.id);
      expect((await form(`/c/screen/${invited.token}/start`)).status).toBe(302);
      return { application: a, token: invited.token, items: (await screenOf(a.id)).progress.chat?.items.map((i) => [i.key, i.kind]) };
    };
    const own = [["recent", "question"], ["nervous", "question"], ["available", "question"]];

    // answered No on the form: the reading found the certificate not met on that answer, and the chat does not ask again
    const no = await planOf({ first: "Nell", email: "nell.tester@rules.test" }, { q_fq_certificate: "no" });
    const [reading] = await container.db.select().from(assessments).where(and(eq(assessments.applicationId, no.application.id), eq(assessments.kind, "triage")));
    expect((reading.result as { requirementFindings: unknown[] }).requirementFindings).toEqual([{ requirementKey: "mh_xray", met: "no", evidence: { source: "application", quote: `${QUESTION} No.` } }]);
    expect(no.items).toEqual(own);
    expect(await pageOf(`/c/screen/${no.token}`)).toContain(`<p class="meta">Question 1 of ${own.length}</p>`);

    // The live site, 25 November 2026: a job's own form mostly asks for a *current* (or active, or valid) certificate.
    // The licence rule stores a "no" to that as not known, because a lapsed one is not current either, and the plan kept
    // the certificate: the counter said one question more than the chat asked. The form asked what the chat would ask and
    // they answered it, so it is not in the plan whichever way the form worded it.
    const CURRENT = "Do you hold a current radiography certificate?";
    const worded = await plantJob(container, { companyId: company.id, title: "Dental Assistant, afternoons", packet: (p) => { p.formQuestions = [{ kind: "yes_no", key: "fq_certificate", question: CURRENT, required: false }]; } });
    const lapsed = await planOf({ first: "Petra", email: "petra.tester@rules.test" }, { q_fq_certificate: "no" }, worded);
    const [notKnown] = await container.db.select().from(assessments).where(and(eq(assessments.applicationId, lapsed.application.id), eq(assessments.kind, "triage")));
    expect((notKnown.result as { requirementFindings: unknown[] }).requirementFindings).toEqual([{ requirementKey: "mh_xray", met: "unknown", evidence: { source: "application", quote: `${CURRENT} No.` } }]);
    expect(lapsed.items).toEqual(own);
    expect(await pageOf(`/c/screen/${lapsed.token}`)).toContain(`<p class="meta">Question 1 of ${own.length}</p>`);
    // a "yes" to it is shown, and was never asked about
    const held = await planOf({ first: "Quinn", email: "quinn.tester@rules.test" }, { q_fq_certificate: "yes" }, worded);
    expect(held.items).toEqual(own);

    // the form's question left unanswered: nothing shows the certificate, so the chat asks, once and as yes or no
    const blank = await planOf({ first: "Olga", email: "olga.tester@rules.test" }, {});
    expect(blank.items).toEqual([...own, ["mh_xray", "gap"]]);
    for (const answer of ["I assist chairside every day and keep the rooms ready.", "I calmed a nervous patient by explaining each step before I did it.", "Monday to Friday, any hours, and I can start in two weeks."]) expect((await form(`/c/screen/${blank.token}`, { message: answer })).status).toBe(302);
    let scr = await screenOf(blank.application.id);
    expect(scr.progress.currentQuestionKey).toBe("mh_xray");
    expect(scr.transcript.at(-1)?.content).toContain("This is one of the things the job needs: Radiography certificate. Do you have it?");
    expect((await form(`/c/screen/${blank.token}`, { message: "No" })).status).toBe(302);
    scr = await screenOf(blank.application.id);
    expect(scr.answers.mh_xray).toBe("No");
    expect(scr.progress.currentQuestionKey).toBe(CHAT_WRAP_KEY);
    expect(scr.transcript.filter((t) => t.role === "assistant").map((t) => t.content).join("\n")).not.toMatch(/something similar|small moment/);
  });

  /**
   * 27 November 2026: the chat asked "… Do you have it?" about a certificate the job needs and took a typed "Yes" or "No"
   * as the whole answer, but the page offered only the reply box. It now offers the two buttons a yes-or-no question of
   * the job's has, on the chat's page and on "Check your answers", and a tap is taken as a tap on that question is.
   */
  describe("the chat's own question about a certificate the job needs has the Yes and No buttons of a yes-or-no question", () => {
    // a resume that shows neither of this job's two must-haves: a certificate, and a skill
    const RESUME = "Dental Assistant at Park Dental 2018 - present\nChairside assisting daily with two dentists\nDentrix";
    // the chat's question about each, as the app's own rule words it: only the certificate is held or not
    const CERTIFICATE = gapQuestion("Radiography certificate");
    const CHARTING = gapQuestion("Periodontal charting");
    let job = "";
    /** The Yes and No buttons as a page draws them for the question `about`, posting to `action`; `skip`: with the chat's own "Skip this question". */
    const yesNo = (action: string, about: string, skip = false) => `<form method="post" action="${action}"><input type="hidden" name="tap" value="yes_no"/><fieldset class="actions" aria-label="Your answer to: ${about}"><button class="btn secondary" type="submit" name="choice" value="yes">Yes</button><button class="btn secondary" type="submit" name="choice" value="no">No</button>${skip ? '<button class="link-action" type="submit" name="action" value="skip" formnovalidate="">Skip this question</button>' : ""}</fieldset></form>`;
    /** The box for their own words, one click away beside the buttons, as beside every tap answer. */
    const OWN_WORDS = '<details class="own-words"><summary>Answer in your own words instead</summary>';
    /** Someone whose chat is on the certificate: they applied with that resume, were shortlisted, pressed Start and skipped the job's own three questions. */
    const atTheCertificate = async (first: string) => {
      const who = await interview({ first, last: "Tester", email: `${first.toLowerCase()}.tester@rules.test`, role: job, resume: RESUME });
      const base = `/c/screen/${who.token}`;
      for (let n = 0; n < QUESTIONS.length; n++) expect((await form(base, { action: "skip" })).status).toBe(302);
      expect((await screenOf(who.application.id)).progress.currentQuestionKey).toBe("mh_xray");
      return { ...who, base };
    };

    beforeAll(async () => {
      const [company] = await container.db.select({ id: companies.id }).from(companies).where(eq(companies.slug, slug));
      job = await plantJob(container, { companyId: company.id, title: "Dental Assistant, charting", packet: (p) => { p.screening.questions = QUESTIONS.map((q) => ({ ...q })); p.requirements.mustHaves = [...p.requirements.mustHaves, { key: "mh_perio", text: "Periodontal charting" }]; } });
    });

    it("on the chat's page it has the two buttons of the job's own yes-or-no question, with their own words one click away, and a typed answer is still taken; a must-have asked about from their own work has only the box", async () => {
      expect([namesCredential("Radiography certificate"), namesCredential("Periodontal charting")]).toEqual([true, false]);
      expect(CERTIFICATE).toBe("This is one of the things the job needs: Radiography certificate. Do you have it?");
      const { application, token } = await interview({ first: "Tess", last: "Tester", email: "tess.tester@rules.test", role: job, resume: RESUME });
      const base = `/c/screen/${token}`;
      let scr = await screenOf(application.id);
      expect(scr.progress.chat?.items.map((i) => [i.key, i.kind])).toEqual([["license", "question"], ["charting", "question"], ["patient", "question"], ["mh_xray", "gap"], ["mh_perio", "gap"]]);
      // the job's own yes-or-no question, as it was: its two buttons, and a tap is its answer
      expect(await pageOf(base)).toContain(yesNo(base, QUESTIONS[0].question, true));
      expect((await form(base, { tap: "yes_no", choice: "yes" })).headers.get("location")).toBe(base);
      expect((await screenOf(application.id)).answers).toEqual({ license: "Yes" });
      // two open questions answered in their own words: the stand-in model's turn moves the chat on to the certificate
      for (const answer of ["I probe six points a tooth on every adult patient and note bleeding and recession.", "A nervous patient wanted to stop, so I slowed down and explained each step; she rebooked with me."]) expect((await form(base, { message: answer })).status).toBe(302);
      scr = await screenOf(application.id);
      expect(scr.progress.currentQuestionKey).toBe("mh_xray");
      expect(scr.transcript.at(-1)).toMatchObject({ role: "assistant", questionKey: "mh_xray" });
      expect(scr.transcript.at(-1)?.content.endsWith(`\n\n${CERTIFICATE}`)).toBe(true);
      // the page: the same two buttons, and the box for their own words one click away
      const asked = await pageOf(base);
      expect(asked).toContain('<p class="meta">Question 4 of 5</p>');
      expect(asked).toContain(yesNo(base, CERTIFICATE, true));
      expect(asked).toContain(`${OWN_WORDS}<form method="post" action="${base}" class="reply"><label for="message">Your reply<span class="sr-only"> to: ${CERTIFICATE}</span></label><textarea id="message" name="message"`);
      // typed in that box, "No" is its whole answer as it was, and the chat moves on
      expect((await form(base, { message: "No" })).headers.get("location")).toBe(base);
      scr = await screenOf(application.id);
      expect(scr.answers.mh_xray).toBe("No");
      expect(scr.progress.currentQuestionKey).toBe("mh_perio");
      // the other must-have names no licence or certificate: asked about from their own work, with the reply box and no buttons
      const open = await pageOf(base);
      expect(open).toContain('<p class="meta">Question 5 of 5</p>');
      expect(open).toContain(`Your reply<span class="sr-only"> to: ${CHARTING}</span>`);
      expect(open).not.toContain('name="tap"');
      expect(open).not.toContain('name="choice"');
      expect(open).not.toContain(OWN_WORDS);
    });

    it("a No tapped on it is recorded as the candidate's own word and is the whole answer, taken in code, and the chat moves on; a Yes likewise; a tap posted for the other must-have saves nothing", async () => {
      const { application, screenId, base } = await atTheCertificate("Uma");
      const tapped = await form(base, { tap: "yes_no", choice: "no" });
      expect(tapped.status).toBe(302);
      expect(tapped.headers.get("location")).toBe(base);
      const scr = await screenOf(application.id);
      // the word a typed "No" is recorded as, so the scorecard reads the same answer either way
      expect(scr.answers).toEqual({ mh_xray: "No" });
      expect(scr.transcript.at(-2)).toMatchObject({ role: "candidate", content: "No", source: "tap", questionKey: "mh_xray" });
      // the next item in the job's own words after the tap's own line: nothing "similar" is asked for
      expect(scr.transcript.at(-1)).toMatchObject({ role: "assistant", content: `Noted: No.\n\n${CHARTING}`, questionKey: "mh_perio", source: "system" });
      expect(scr.progress.currentQuestionKey).toBe("mh_perio");
      expect(scr.progress.chat?.items.find((i) => i.key === "mh_xray")).toMatchObject({ state: "covered", step: "direct", pushes: 0 });
      expect(await pageOf(base)).toContain('<p class="meta">Question 5 of 5</p>');
      // a tap never reaches the model: this chat has asked it nothing
      expect((await container.db.select().from(aiRuns).where(eq(aiRuns.task, "screen.turn"))).filter((r) => (r.inputRef as { screenId?: string }).screenId === screenId)).toEqual([]);
      expect((await eventsFor("screen.answer_tapped", screenId)).map((e) => (e.payload as { questionKey?: string }).questionKey)).toEqual(["mh_xray"]);
      // a No posted for the must-have asked about from their own work (a page that went stale) fits nothing, and nothing is saved
      expect((await form(base, { tap: "yes_no", choice: "no" })).headers.get("location")).toBe(`${base}?error=tap`);
      const refused = await screenOf(application.id);
      expect(refused.answers).toEqual({ mh_xray: "No" });
      expect(refused.transcript).toHaveLength(scr.transcript.length);
      expect(refused.progress.currentQuestionKey).toBe("mh_perio");
      // Yes, tapped, likewise
      const other = await atTheCertificate("Vera");
      expect(await pageOf(other.base)).toContain(yesNo(other.base, CERTIFICATE, true));
      expect((await form(other.base, { tap: "yes_no", choice: "yes" })).headers.get("location")).toBe(other.base);
      const held = await screenOf(other.application.id);
      expect(held.answers).toEqual({ mh_xray: "Yes" });
      expect(held.transcript.at(-2)).toMatchObject({ role: "candidate", content: "Yes", source: "tap", questionKey: "mh_xray" });
      expect(held.transcript.at(-1)).toMatchObject({ role: "assistant", content: `Noted: Yes.\n\n${CHARTING}`, questionKey: "mh_perio", source: "system" });
      expect(held.progress.currentQuestionKey).toBe("mh_perio");
    });

    it("check-your-answers offers, to change its answer, the control the job's own yes-or-no question gets there, and a change tapped there is taken the same way", async () => {
      const { application, base } = await atTheCertificate("Wren");
      // answered in their own words, then the rest of the chat, to "Check your answers"
      for (const answer of ["No", "I charted pocket depths for the hygienist at Park Dental for about a year.", "Nothing more, thank you."]) expect((await form(base, { message: answer })).status).toBe(302);
      const review = await pageOf(base);
      expect(review).toContain("<h1>Check your answers</h1>");
      expect(review).toContain(`<li class="answer" id="a-mh_xray"><div class="answer-head"><p class="answer-q">4. ${CERTIFICATE}</p></div><p class="pre">No</p>`);
      // to change it: the two buttons, as for the job's own yes-or-no question, and the box one click away
      const change = `${base}/answers/mh_xray`;
      const edit = await pageOf(change);
      expect(edit).toContain(yesNo(change, CERTIFICATE));
      expect(edit).toContain(OWN_WORDS);
      expect(await pageOf(`${base}/answers/license`)).toContain(yesNo(`${base}/answers/license`, QUESTIONS[0].question));
      // the must-have answered from their own work keeps the box, with their words in it
      const own = await pageOf(`${base}/answers/mh_perio`);
      expect(own).not.toContain('name="tap"');
      expect(own).toContain(">I charted pocket depths for the hygienist at Park Dental for about a year.</textarea>");
      // a change tapped there: the new word, beside the earlier one in the record
      expect((await form(change, { tap: "yes_no", choice: "yes" })).headers.get("location")).toBe(`${base}?changed=mh_xray#a-mh_xray`);
      const scr = await screenOf(application.id);
      expect(scr.answers.mh_xray).toBe("Yes");
      expect(scr.transcript.at(-1)).toMatchObject({ role: "candidate", content: "Yes", source: "edit", questionKey: "mh_xray" });
      expect(scr.progress.edits).toEqual({ mh_xray: 1 });
      expect(await pageOf(`${base}?changed=mh_xray`)).toContain(`<p class="answer-q">4. ${CERTIFICATE}</p><span class="pill">Changed</span></div><p class="pre">Yes</p>`);
      // as a change tapped on the job's own yes-or-no question, which they had skipped, always was
      expect((await form(`${base}/answers/license`, { tap: "yes_no", choice: "no" })).headers.get("location")).toBe(`${base}?changed=license#a-license`);
      expect((await screenOf(application.id)).answers.license).toBe("No");
    });
  });
});
