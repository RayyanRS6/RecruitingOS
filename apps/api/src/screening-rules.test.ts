import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { ScreenTurn } from "@ros/contracts";
import { aiRuns, applications, candidates, events, notifications, recruiterEscalations, screens, usageEvents } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { useOneVisitApplyFlow } from "./test-helpers";

/**
 * Two screening rules the real model is held to, proven over HTTP with the fake model scripted where the fake's own
 * heuristics cannot reach the rule (docs/spec/21 section 7, P0 rows "follow-up cap test" and the HUMAN hand-off):
 * a question gets at most two follow-ups, and "I'd rather talk to a person" leads to two equal choices (plan E3, Q16),
 * where "Have a person contact me" opens a request for a person with the whole conversation, tells the candidate when to
 * expect an answer, is idempotent, and is rate-limited per link. The conversations are the ones offered with the
 * application (plan E1): the introduction first, then Start.
 */
describe("screening rules: the follow-up cap and the web hand-off to a person", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let slug = "";
  let roleId = "";
  let elig: Array<{ key: string }> = [];
  let questions: Array<{ key: string; question: string }> = [];

  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const form = (path: string, fields: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  const screenOf = async (applicationId: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, applicationId))).sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))[0];
  const eventsFor = async (type: string, subjectId: string) => container.db.select().from(events).where(and(eq(events.type, type), eq(events.subjectId, subjectId)));
  const decodeEntities = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  async function apply(p: { first: string; last: string; email: string }) {
    const fd = new FormData();
    fd.set("firstName", p.first); fd.set("lastName", p.last); fd.set("email", p.email);
    fd.set("resume", new File([`${p.first} ${p.last}, RDH\n${p.email} | (949) 555-0100\n\nRegistered Dental Hygienist at Smile Bright Dental 2019 - present\nDental Hygienist at Coastal Family Dentistry 2015 - 2019\n\nLicenses: RDH license CA #RDH12345, active\nCertifications: BLS/CPR current\nSkills: Dentrix, periodontal charting, digital radiography, perio maintenance`], `${p.first.toLowerCase()}.txt`, { type: "text/plain" }));
    for (const r of elig) fd.set(`elig_${r.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    const res = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    expect(res.status).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, p.email.toLowerCase()));
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id)));
    expect(a.stage).toBe("screen_invited");
    const scr = await screenOf(a.id);
    // the introduction, then Start: the first question in the packet's own words
    expect((await app.request(`/c/screen/${scr.token}`)).status).toBe(200);
    expect((await form(`/c/screen/${scr.token}/start`)).status).toBe(302);
    return { application: a, candidate: cand, token: scr.token, screenId: scr.id };
  }

  /** What a model that keeps asking for more would say: a follow-up, no question key, nothing recorded. */
  const followUp: ScreenTurn = { messageToCandidate: "Could you say a bit more about that? A sentence or two is plenty.", questionKey: null, answerRecorded: null, followUpReason: "answer too short to establish anything", candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };

  beforeAll(async () => {
    // The per-link budget for "Talk to a person" is lowered so the test can trip it without thirty posts.
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", RATE_LIMIT_OVERRIDES: JSON.stringify({ "candidate.screen_human": 3 }) } });
    app = createApp(container);
    const { devLink } = (await (await json("POST", "/api/v1/auth/magic-link", { email: "dana@rules.test" })).json()) as { devLink: string };
    const consume = await json("POST", "/api/v1/auth/magic-link/consume", { token: new URL(devLink).searchParams.get("token") });
    cookie = consume.headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json("POST", "/api/v1/companies", { name: "Rules Dental Group", vertical: "dental", sizeBand: "50-99", ownerName: "Dana Whitfield", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    slug = co.slug;
    // A pilot company: the conversation is offered in the same visit as the form (plan E1).
    await useOneVisitApplyFlow(container, co.id);
    const c1 = (await (await json("POST", "/api/v1/intake/conversation/messages", { message: "I need a dental hygienist in Irvine. Full time. $45 to $55 an hour. I need someone who can start within 30 days." })).json()) as { intakeSessionId: string };
    await json("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/messages`, { message: "It's a replacement, our hygienist moved. Ceiling is $58. Interviewers: Dr. Chen and me. I decide. Must-haves: active CA RDH license, perio experience. Deal-breakers: can't work Saturdays." });
    const compiled = (await (await json("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/compile`)).json()) as { roleId: string };
    roleId = compiled.roleId;
    await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1 });
    await container.drain();
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { status: string; currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> }; screening: { questions: Array<{ key: string; question: string }> } } } };
    expect(role.status).toBe("open");
    elig = role.currentPacket.packet.requirements.eligibility;
    questions = role.currentPacket.packet.screening.questions;
    expect(questions.length).toBeGreaterThanOrEqual(2);
  });
  afterAll(async () => { await container.close(); });

  it("a question gets two follow-ups at most: the third becomes the next question, and the transcript shows all of it", async () => {
    const { application, token, screenId } = await apply({ first: "Maria", last: "Reyes", email: "maria.reyes@rules.test" });
    const opened = await screenOf(application.id);
    expect(opened.progress.currentQuestionKey).toBe(questions[0].key);
    // The model keeps asking for more, three times running. The fake's own screen handler asks one follow-up at most, so the turns are scripted; each still has to satisfy the ScreenTurn schema.
    for (let i = 0; i < 3; i++) {
      container.fake!.scriptNext("screen.turn", followUp);
      const r = await form(`/c/screen/${token}`, { message: i === 2 ? "Yes." : "Yes" });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe(`/c/screen/${token}`);
      const scr = await screenOf(application.id);
      expect(scr.status).toBe("in_progress");
      if (i < 2) {
        expect(scr.progress.followUps[questions[0].key]).toBe(i + 1);
        expect(scr.progress.currentQuestionKey).toBe(questions[0].key);
        expect(scr.transcript.at(-1)).toMatchObject({ role: "assistant", content: followUp.messageToCandidate });
      }
      if (i === 0) {
        // the page: still the first question, in large type, with the candidate's own words and the follow-up beneath it; the answer box names the follow-up
        const page = decodeEntities(await (await app.request(`/c/screen/${token}`)).text());
        expect(page).toContain(`<h1 class="question" id="question">${questions[0].question}</h1>`);
        expect(page).toContain(`Question 1 of ${questions.length}`);
        expect(page).toContain('<li class="msg candidate"><span class="sr-only">You said: </span>Yes</li>');
        expect(page).toContain(`<li class="msg assistant"><span class="sr-only">The assistant said: </span>${followUp.messageToCandidate}</li>`);
        expect(page).toContain(`Your answer<span class="sr-only"> to: ${followUp.messageToCandidate}</span>`);
      }
    }
    const scr = await screenOf(application.id);
    const assistant = scr.transcript.filter((t) => t.role === "assistant");
    expect(assistant).toHaveLength(4); // the first question, two follow-ups, then the next question
    expect(assistant[1].content).toBe(followUp.messageToCandidate);
    expect(assistant[2].content).toBe(followUp.messageToCandidate);
    expect(assistant[1].questionKey).toBeUndefined();
    expect(assistant[2].questionKey).toBeUndefined();
    expect(assistant[3].content).toBe(`Thanks, that helps. Next: ${questions[1].question}`);
    expect(assistant[3].questionKey).toBe(questions[1].key);
    expect(scr.transcript.filter((t) => t.role === "candidate").map((t) => t.content)).toEqual(["Yes", "Yes", "Yes."]);
    expect(scr.progress.followUps[questions[0].key]).toBe(2);
    expect(scr.progress.currentQuestionKey).toBe(questions[1].key);
    expect(scr.progress.askedKeys).toEqual([questions[0].key, questions[1].key]);
    // nothing was invented as an answer to the first question
    expect(scr.answers[questions[0].key]).toBeUndefined();
    // every turn went through the model runner and was recorded
    expect((await container.db.select().from(aiRuns).where(eq(aiRuns.task, "screen.turn"))).filter((r) => (r.inputRef as { screenId?: string }).screenId === screenId)).toHaveLength(3);
    // the page shows the conversation as recorded: the second question in large type, the first folded away above it
    const html = decodeEntities(await (await app.request(`/c/screen/${token}`)).text());
    expect(html).toContain('<p class="lead-in"><span class="sr-only">The assistant said: </span>Thanks, that helps.</p>');
    expect(html).toContain(`<h1 class="question" id="question">${questions[1].question}</h1>`);
    expect(html).toContain(`Question 2 of ${questions.length}`);
    expect(html).toContain('<details class="earlier"><summary>Earlier in the conversation</summary>');
    expect(html.slice(html.indexOf('<details class="earlier">'), html.indexOf("</details>"))).toContain(questions[0].question);
    // a fourth turn answers the second question normally: the follow-up count of the first question is not carried over
    const r = await form(`/c/screen/${token}`, { message: "At Smile Bright I see eight to ten patients a day, do full perio charting and radiographs, and chart everything in Dentrix." });
    expect(r.status).toBe(302);
    const later = await screenOf(application.id);
    expect(later.answers[questions[1].key]).toMatch(/Smile Bright/);
    expect(later.progress.followUps[questions[1].key] ?? 0).toBe(0);
  });

  it("'I'd rather talk to a person' offers two equal choices; 'Have a person contact me' opens a request for a person with the conversation, tells the candidate when to expect an answer, is idempotent, and is rate-limited per link", async () => {
    const { application, candidate, token, screenId } = await apply({ first: "Luis", last: "Ortega", email: "luis.ortega@rules.test" });
    const answer = "Yes, my RDH license is active in California, number RDH12345.";
    expect((await form(`/c/screen/${token}`, { message: answer })).status).toBe(302);
    const before = await screenOf(application.id);
    expect(before.status).toBe("in_progress");
    const notesBefore = (await container.db.select().from(notifications).where(eq(notifications.kind, "screen.human_requested"))).length;

    // the button on every page is a link to the choice; the older one-button route leads there too and changes nothing
    const question = decodeEntities(await (await app.request(`/c/screen/${token}`)).text());
    expect(question).toContain(`<a class="link-action" href="/c/screen/${token}/person">I'd rather talk to a person</a>`);
    const old = await form(`/c/screen/${token}/human`);
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe(`/c/screen/${token}/person`);
    expect((await screenOf(application.id)).status).toBe("in_progress");
    const choice = decodeEntities(await (await app.request(`/c/screen/${token}/person`)).text());
    expect(choice).toContain("<h1>Talk to a person instead</h1>");
    // two equal choices: the same button, side by side
    expect(choice).toContain('<input type="hidden" name="choice" value="send_without"/><button class="btn secondary" type="submit">Send without the conversation</button>');
    expect(choice).toContain('<input type="hidden" name="choice" value="contact_me"/><button class="btn secondary" type="submit">Have a person contact me</button>');
    expect(choice).toMatch(/will get in touch (within four business hours|on the next business day)/);

    const r = await form(`/c/screen/${token}/person`, { choice: "contact_me" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/c/screen/${token}`);
    const after = await screenOf(application.id);
    expect(after.status).toBe("human_requested");
    expect(after.humanRequestedAt).toBeTruthy();
    // the candidate is told, in the conversation and on the page, when a person will be in touch (business hours, never a wall-clock promise)
    const last = after.transcript.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.content).toMatch(/A person from Rules Dental Group will follow up with you (within four business hours|on the next business day)/);
    const html = decodeEntities(await (await app.request(`/c/screen/${token}`)).text());
    expect(html).toContain("<h1>A person will be in touch</h1>");
    expect(html).toMatch(/Someone working with the hiring team at Rules Dental Group will contact you (within four business hours|on the next business day)/);
    expect(html).not.toContain('name="message"'); // the conversation is closed to the assistant
    // counted, as ITS covers it (Q16), never against the company's recruiter requests
    expect((await container.db.select().from(usageEvents).where(eq(usageEvents.key, "screen_person_requests"))).filter((u) => u.ref.screenId === screenId)).toMatchObject([{ ref: { choice: "contact_me" } }]);
    // the request for a person carries the whole conversation and the candidate's answers so far
    const escs = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, application.id));
    expect(escs).toHaveLength(1);
    expect(escs[0]).toMatchObject({ kind: "candidate_issue", status: "open", roleId });
    expect(escs[0].question).toContain("Luis Ortega needs a person");
    expect(escs[0].question).toContain("chose 'Have a person contact me'");
    expect(Date.parse(escs[0].slaDueAt!)).toBeGreaterThan(Date.now());
    const snapshot = escs[0].contextSnapshot as { screens: Array<{ status: string; transcript: Array<{ role: string; content: string }>; answers: Record<string, string> }>; candidate: { name: string } };
    expect(snapshot.candidate.name).toBe("Luis Ortega");
    expect(snapshot.screens).toHaveLength(1);
    expect(snapshot.screens[0].transcript.some((t) => t.role === "candidate" && t.content === answer)).toBe(true);
    expect(Object.values(snapshot.screens[0].answers)).toContain(answer);
    // the facts and the owner's notification
    expect(await eventsFor("screen.human_requested", screenId)).toHaveLength(1);
    expect((await eventsFor("screen.human_requested", screenId))[0].payload).toMatchObject({ reason: "candidate chose 'Have a person contact me'" });
    const notes = await container.db.select().from(notifications).where(eq(notifications.kind, "screen.human_requested"));
    expect(notes.length).toBe(notesBefore + 1);
    expect(notes.at(-1)!.title).toBe("Luis asked for a person");
    expect(notes.at(-1)!.body).not.toContain(answer); // the owner's notice never carries the candidate's words
    const owner = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string; title: string }>;
    expect(owner.some((n) => n.kind === "screen.human_requested" && /Luis/.test(n.title))).toBe(true);
    expect((await container.db.select().from(applications).where(eq(applications.id, application.id)))[0].stage).toBe("screening"); // a person finishes it; nothing is decided
    // the candidate row is untouched: same person, same address
    const [row] = await container.db.select().from(candidates).where(eq(candidates.id, candidate.id));
    expect(row).toMatchObject({ firstName: "Luis", lastName: "Ortega", email: "luis.ortega@rules.test" });

    // pressing again, either way, changes nothing: one request, one event, one notification, the same time stamp; the choice page sends back to the conversation
    const again = await form(`/c/screen/${token}/person`, { choice: "send_without" });
    expect(again.status).toBe(302);
    expect((await screenOf(application.id)).status).toBe("human_requested");
    expect((await screenOf(application.id)).humanRequestedAt).toBe(after.humanRequestedAt);
    expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, application.id))).toHaveLength(1);
    expect(await eventsFor("screen.human_requested", screenId)).toHaveLength(1);
    expect((await container.db.select().from(notifications).where(eq(notifications.kind, "screen.human_requested"))).length).toBe(notesBefore + 1);
    expect((await app.request(`/c/screen/${token}/person`)).headers.get("location")).toBe(`/c/screen/${token}`);
    // a further message from the candidate gets the holding answer, not the assistant
    expect((await form(`/c/screen/${token}`, { message: "Hello?" })).status).toBe(302);
    expect((await screenOf(application.id)).status).toBe("human_requested");

    // the link's own budget (three an hour here, thirty in production): the fourth press is refused plainly, nothing breaks
    const fourth = await app.request(`/c/screen/${token}/person`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" }, body: new URLSearchParams({ choice: "contact_me" }) });
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await fourth.text()).toContain("Please try again in");
    expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, application.id))).toHaveLength(1);
  });

  it("a dead link and a closed conversation are refused without creating anything", async () => {
    // another address: the lowered budget above is per address as well as per link
    const press = (path: string) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.77" }, body: new URLSearchParams() });
    expect((await press(`/c/screen/${"x".repeat(32)}/human`)).status).toBe(404);
    expect((await press(`/c/screen/${"x".repeat(32)}/person`)).status).toBe(404);
    const { application, token } = await apply({ first: "Ana", last: "Silva", email: "ana.silva@rules.test" });
    const scr = await screenOf(application.id);
    await container.db.update(screens).set({ status: "expired" }).where(eq(screens.id, scr.id));
    const r = await app.request(`/c/screen/${token}/person`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.77" }, body: new URLSearchParams({ choice: "contact_me" }) });
    expect(r.status).toBe(302);
    expect((await screenOf(application.id)).status).toBe("expired");
    expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, application.id))).toHaveLength(0);
    // the closed page says the application went on without the conversation (it was offered with it, plan E4), and
    // offers nothing to press
    const html = (await (await app.request(`/c/screen/${token}`)).text()).replace(/&#39;/g, "'");
    expect(html).toContain("<h1>This conversation has closed</h1>");
    expect(html).toContain("Your application has gone to the hiring team at Rules Dental Group without it, and that is fine.");
    expect(html).not.toContain('action="/c/screen/');
  });
});
