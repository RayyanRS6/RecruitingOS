import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import type { CandidatePanel, ScreenTurn } from "@ros/contracts";
import { aiRuns, applications, candidates, events, notifications, screens } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { applicationForm, plantJob, seedCompany, usePlan } from "./test-helpers";

/**
 * Two rules of the AI interview, proven over HTTP. A question gets at most one follow-up: the stand-in model is scripted
 * to keep asking for more, since its own handler would not, and the code still moves on. And "I'd rather talk to a
 * person" leads to one plain choice that closes the AI interview as the candidate's own choice, tells the hiring team
 * once, sends them nothing the candidate typed, changes nothing when pressed again, and is rate-limited per link.
 */
describe("AI interview rules: the follow-up cap and choosing a person instead", () => {
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

  /** Someone applies, the team shortlists them, and they press Start: the job's first question is on the page. */
  async function interview(p: { first: string; last: string; email: string }) {
    expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: applicationForm({ firstName: p.first, lastName: p.last, email: p.email }) })).status).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, p.email));
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id)));
    expect(a.stage).toBe("triaged");
    expect((await app.request(`/api/v1/applications/${a.id}/actions`, { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ action: "shortlist" }) })).status).toBe(200);
    await container.drain();
    const scr = await screenOf(a.id);
    expect((await app.request(`/c/screen/${scr.token}`)).status).toBe(200);
    expect((await form(`/c/screen/${scr.token}/start`)).status).toBe(302);
    return { application: a, candidate: cand, token: scr.token, screenId: scr.id };
  }

  /** What a model that keeps asking for more would say: a follow-up, no question key, nothing recorded. */
  const followUp: ScreenTurn = { messageToCandidate: "Could you say a bit more about that? A sentence or two is plenty.", questionKey: null, answerRecorded: null, followUpReason: "answer too short to establish anything", candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };

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
    expect(page).toContain(`<p class="meta">1 of ${QUESTIONS.length} required · Required questions</p>`);
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
    // the page counts both as done
    const html = await pageOf(`/c/screen/${token}`);
    expect(html).toContain(`<p class="meta">2 of ${QUESTIONS.length} required · Required questions</p>`);
    expect(html).toContain(`<li class="msg assistant now" id="question"><span class="sr-only">The assistant said: </span>${QUESTIONS[2].question}</li>`);
    // the next answer is read afresh: the push count of the last question is not carried over
    expect((await form(`/c/screen/${token}`, { message: "A nervous patient wanted to stop, so I slowed down and explained each step; she rebooked with me." })).status).toBe(302);
    const later = await screenOf(application.id);
    expect(later.answers.patient).toMatch(/nervous patient/);
    expect(later.progress.chat?.items.find((i) => i.key === "patient")?.pushes).toBe(0);
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
});
