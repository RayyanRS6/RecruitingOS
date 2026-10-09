import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RolePacket, TapAnswer } from "@ros/contracts";
import { MOVED_ON_MESSAGE, REVIEW_MESSAGE, TURN_CAP_REVIEW_MESSAGE, answerWithdrawPrompt, conversationOverdue, detectStuckRoles, modelTurnCap } from "@ros/agents";
import { entitlements as allowance, grantStaffAccess } from "@ros/core";
import { adminAlerts, aiRuns, applications, assessments, candidates, companies, entitlements, events, notifications, recruiterEscalations, rolePackets, roles, screens, usageEvents, users, withPlatform, withTenant, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { createApplication } from "./services/applications";
import { conversationEdit, conversationPerson, conversationStart, conversationSubmit, conversationTurn, conversationView, findConversation, startApplyConversation, type ApplyVisitOutcome, type ConversationRef } from "./services/apply-conversation";
import { screenDeps } from "./services/screens";
import { signInAs, signInStaff, useOneVisitApplyFlow } from "./test-helpers";

/**
 * Wave E over the API and the workflows, through the functions the apply page and the conversation page call (the pages
 * themselves are wired by their own slice): the conversation offered in the same visit as the application (E1), its
 * fixed introduction (E2), the person route (E3), unfinished conversations (E4), the outage switch (E5), "still
 * applying" (E6), an eligibility mismatch (E7), the allowance counted at the first answer (E9, Q17), check your answers
 * (E10), skips (E11), taps (E12), the per-role figures (E13), and the ITS switch back to "form now, conversation later".
 */
describe("Wave E: applying and the conversation in one visit", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let companyId = "";
  let roleId = "";
  let elig: Array<{ key: string }> = [];
  let questions: Array<{ key: string; question: string; kind: string }> = [];
  const BASE = Math.floor(Date.now() / 60_000) * 60_000;
  let offset = 0;
  const setClock = (ms: number) => { offset = ms; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset); };
  const advance = async (ms: number) => { setClock(offset + ms); await container.drain(); };
  const HOUR = 3600_000;

  const json = (method: string, path: string, body?: unknown, as = cookie) => app.request(path, { method, headers: { "content-type": "application/json", cookie: as }, body: body ? JSON.stringify(body) : undefined });
  const mail = () => (container.integrations.email as FakeEmailAdapter).sent;
  const reload = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];
  const screenOf = async (applicationId: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, applicationId))).sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))[0];
  const turnsFor = async () => (await container.db.select().from(aiRuns).where(eq(aiRuns.task, "screen.turn"))).length;
  const notesAbout = async (name: string) => (await container.db.select().from(notifications).where(eq(notifications.companyId, companyId))).filter((n) => n.title.includes(name) || n.body.includes(name));
  const RESUME = (name: string) => `${name}, RDH\n\nRegistered Dental Hygienist at Smile Bright Dental 2019 - present\nLicenses: RDH license CA #RDH12345, active\nSkills: Dentrix, periodontal charting, perio maintenance`;

  /** What the apply POST does, minus the page: the application, then the next step, in one transaction. */
  async function applyNow(p: { first: string; last: string; email: string; answers?: Record<string, string> }): Promise<{ outcome: ApplyVisitOutcome; applicationId: string }> {
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    const [company] = await container.db.select().from(companies).where(eq(companies.id, role.companyId));
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    const eligibilityAnswers = Object.fromEntries(elig.map((r) => [r.key, p.answers?.[r.key] ?? "yes"]));
    const result = await withTenant(container.db, company.id, async (tx) => {
      const created = await createApplication(tx, container, { companyId: company.id, roleId, source: "careers_page", firstName: p.first, lastName: p.last, email: p.email, phone: null, smsConsent: false, consentSource: "careers_page_apply", noticeVersionsShown: ["ai_use@2026-10-08", "privacy@2026-09-01"], eligibilityAnswers, resume: { kind: "bytes", filename: `${p.first.toLowerCase()}.txt`, mime: "text/plain", bytes: new TextEncoder().encode(RESUME(`${p.first} ${p.last}`)), via: "server" } }, { kind: "candidate", id: "applicant" });
      const outcome = await startApplyConversation(tx, container, { ...created, role, company, packet: pv.packet as RolePacket, typedFirstName: p.first, eligibilityAnswers });
      return { outcome, applicationId: created.application.id };
    });
    await container.kick();
    await container.drain();
    return result;
  }
  const refOf = async (outcome: ApplyVisitOutcome): Promise<ConversationRef> => {
    if (outcome.kind !== "conversation") throw new Error(`expected a conversation, got ${outcome.reason}`);
    return (await findConversation(container.db, outcome.token))!;
  };
  /** Answers the current question: a tap where one fits and `tap` says so, otherwise words. */
  const answer = async (ref: ConversationRef, opts: { tap?: boolean; skipKind?: string } = {}) => {
    const view = (await conversationView(container.db, ref))!;
    const q = view.current!;
    const kind = questions.find((x) => x.key === q.key)?.kind;
    if (opts.skipKind && kind === opts.skipKind) return conversationTurn(container, ref, { skip: true });
    if (opts.tap && q.tap) {
      const tap: TapAnswer = q.tap.kind === "yes_no" ? { kind: "yes_no", choice: "yes" } : q.tap.kind === "pay_range" ? { kind: "pay_range", min: 50, max: 54 } : q.tap.kind === "days" ? { kind: "days", days: ["Monday", "Tuesday"] } : { kind: "start_date", date: new Date(BASE + 14 * 24 * HOUR).toISOString().slice(0, 10) };
      return conversationTurn(container, ref, { tap });
    }
    return conversationTurn(container, ref, { message: "At Smile Bright I see nine patients a day, chart in Dentrix and do perio maintenance; I like steady teams." });
  };

  const signIn = async () => {
    const r1 = await json("POST", "/api/v1/auth/magic-link", { email: "dana@onevisit.test" });
    const { devLink } = (await r1.json()) as { devLink: string };
    const consume = await json("POST", "/api/v1/auth/magic-link/consume", { token: new URL(devLink).searchParams.get("token") });
    cookie = consume.headers.get("set-cookie")!.split(";")[0];
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake" } });
    app = createApp(container);
    setClock(0);
    await signIn();
    const co = (await (await json("POST", "/api/v1/companies", { name: "One Visit Dental", vertical: "dental", sizeBand: "50-99", ownerName: "Dana Whitfield", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    companyId = co.id;
    // A pilot company: ITS switched the one-visit flow on for it (a company without a setting takes the later path).
    await useOneVisitApplyFlow(container, companyId);
    const c1 = (await (await json("POST", "/api/v1/intake/conversation/messages", { message: "I need a dental hygienist in Irvine. Full time. $45 to $55 an hour. I need someone who can start within 30 days." })).json()) as { intakeSessionId: string };
    await json("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/messages`, { message: "It's a replacement, our hygienist moved. Ceiling is $58. Interviewers: Dr. Chen and me. I decide. Must-haves: active CA RDH license, perio experience. Deal-breakers: can't work Saturdays." });
    const compiled = (await (await json("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/compile`)).json()) as { roleId: string };
    roleId = compiled.roleId;
    await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1 });
    await container.drain();
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { status: string; applyMode: string | null; currentPacket: { packet: RolePacket } };
    expect(role.status).toBe("open");
    // a role opened after this wave follows the company's default: here the pilot's one-visit flow
    expect(role.applyMode).toBeNull();
    elig = role.currentPacket.packet.requirements.eligibility;
    questions = role.currentPacket.packet.screening.questions;
  });
  afterAll(async () => { await container.close(); });

  let mariaId = "";
  let mariaRef: ConversationRef;

  it("E1: an eligible applicant is offered the conversation in the same visit: web, no invitation email, the résumé read beside it, nobody alerted yet", async () => {
    const { outcome, applicationId } = await applyNow({ first: "Maria", last: "Reyes", email: "maria@onevisit.test" });
    mariaId = applicationId;
    expect(outcome.kind).toBe("conversation");
    mariaRef = await refOf(outcome);
    expect(mariaRef.kind).toBe("screen");
    const scr = await screenOf(applicationId);
    expect(scr).toMatchObject({ invitedVia: "apply", channel: "web", status: "invited" });
    expect(scr.progress.flow).toBe("one_visit");
    expect(scr.workflowRunId).toBeTruthy();
    const a = await reload(applicationId);
    expect(a.stage).toBe("screen_invited");
    expect(a.eligibility?.passed).toBe(true);
    const moves = (await container.db.select().from(events).where(and(eq(events.subjectId, applicationId), eq(events.type, "application.stage_changed")))).map((e) => e.payload.to);
    expect(moves).toEqual(["received", "eligible", "screen_invited"]);
    // the acknowledgment once, and no separate invitation: the status page and the acknowledgment carry the link
    const mails = mail().filter((m) => m.to === "maria@onevisit.test");
    expect(mails.filter((m) => /We received your application/.test(m.subject))).toHaveLength(1);
    expect(mails.filter((m) => /screening conversation/i.test(m.subject))).toHaveLength(0);
    // the résumé is read beside the conversation, without moving it on or inviting anyone again
    const asmts = await container.db.select().from(assessments).where(eq(assessments.applicationId, applicationId));
    expect(asmts.map((x) => x.kind)).toEqual(["triage"]);
    expect(a.latestAssessmentId).toBe(asmts[0].id);
    expect((await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "screen"))).filter((r) => (r.state as { applicationId?: string }).applicationId === applicationId)).toHaveLength(1);
    // still applying (E6): nothing about Maria reaches the team's alerts yet, and the list shows her apart
    expect(await notesAbout("Maria")).toHaveLength(0);
    const list = (await (await json("GET", `/api/v1/roles/${roleId}/applications?counts=1`)).json()) as { applications: Array<{ id: string; stillApplying: boolean }>; counts: { stillApplying: number } };
    expect(list.applications.find((r) => r.id === applicationId)?.stillApplying).toBe(true);
    expect(list.counts.stillApplying).toBe(1);
    // nor Today: nobody invited her, so its screening card does not count her as "invited" or "answering now"
    const today = (await (await json("GET", "/api/v1/brief")).json()) as { cards: Array<{ kind: string; roleId?: string; title: string }> };
    expect(today.cards.some((c) => c.kind === "screening" && c.roleId === roleId)).toBe(false);
  });

  it("E2: a fixed introduction, then Start shows the first question in the packet's own words, with no model call", async () => {
    let view = (await conversationView(container.db, mariaRef))!;
    expect(view.phase).toBe("intro");
    expect(view.intro.disclosure).toContain("One Visit Dental's hiring assistant, a software program");
    expect(view.intro.questions).toBe(questions.length);
    expect(view.intro.aiNotice?.text).toMatch(/artificial intelligence/);
    expect(view.intro.humanAlternative.length).toBeGreaterThan(0);
    expect(view.transcript).toEqual([]);
    const before = await turnsFor();
    expect(await conversationStart(container, mariaRef)).toBe(true);
    expect(await conversationStart(container, mariaRef)).toBe(true); // a second press changes nothing
    view = (await conversationView(container.db, mariaRef))!;
    expect(view.phase).toBe("conversation");
    expect(view.transcript).toEqual([{ role: "assistant", content: questions[0].question, questionKey: questions[0].key }]);
    expect(view.current?.key).toBe(questions[0].key);
    expect(await turnsFor()).toBe(before);
    expect((await screenOf(mariaId)).status).toBe("in_progress");
    expect((await reload(mariaId)).stage).toBe("screening");
  });

  it("E9, E11, E12: taps are recorded word for word without the model, a skip is noted, and the allowance counts once, at the first answer", async () => {
    const [ent0] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "text_screens")));
    const before = await turnsFor();
    // the first question (the license) takes a yes or no tap
    expect((await conversationView(container.db, mariaRef))!.current?.tap).toEqual({ kind: "yes_no" });
    const r1 = await answer(mariaRef, { tap: true });
    expect(r1.kind).toBe("reply");
    let scr = await screenOf(mariaId);
    expect(scr.answers[questions[0].key]).toBe("Yes");
    expect(scr.transcript.find((t) => t.source === "tap")).toMatchObject({ role: "candidate", content: "Yes", questionKey: questions[0].key });
    expect(await turnsFor()).toBe(before);
    expect(scr.progress.countedAt).toBeTruthy();
    const [ent1] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "text_screens")));
    expect(ent1.used).toBe(ent0.used + 1);
    // the rest: words for the open questions, a skip for the example, a tap for pay
    for (let i = 0; i < 12; i++) {
      const v = (await conversationView(container.db, mariaRef))!;
      if (v.phase !== "conversation") break;
      await answer(mariaRef, { tap: true, skipKind: "behavioral" });
    }
    scr = await screenOf(mariaId);
    const behavioral = questions.find((q) => q.kind === "behavioral")!;
    const pay = questions.find((q) => q.kind === "compensation")!;
    expect(scr.progress.declined).toEqual([behavioral.key]);
    expect(scr.transcript.find((t) => t.source === "skip")).toMatchObject({ role: "system", questionKey: behavioral.key });
    expect(scr.answers[pay.key]).toBe("I'm looking for $50 to $54 an hour.");
    expect(scr.transcript.some((t) => t.role === "assistant" && t.content.startsWith("No problem. Next: "))).toBe(true);
    // only the typed answers went to the model, and the allowance did not count again
    const typed = questions.filter((q) => q.kind !== "behavioral" && q.kind !== "compensation" && q.kind !== "eligibility").length;
    expect(await turnsFor()).toBe(before + typed);
    const [ent2] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "text_screens")));
    expect(ent2.used).toBe(ent0.used + 1);
    // every question asked in the packet's own words
    for (const q of questions.filter((x) => x.key !== behavioral.key)) expect(scr.transcript.some((t) => t.role === "assistant" && t.content.includes(q.question))).toBe(true);
  });

  it("E10: the candidate checks their answers, changes one, answers the skipped one, and sends; only then does the team hear", async () => {
    let view = (await conversationView(container.db, mariaRef))!;
    expect(view.phase).toBe("review");
    expect(view.transcript.at(-1)?.content).toBe(REVIEW_MESSAGE);
    expect((await screenOf(mariaId)).status).toBe("in_progress");
    const behavioral = questions.find((q) => q.kind === "behavioral")!;
    const last = questions.at(-1)!;
    expect(view.review!.find((i) => i.key === behavioral.key)?.status).toBe("declined");
    expect(await conversationEdit(container, mariaRef, { questionKey: last.key, text: "A steady team that respects hygienists, and room to grow." })).toEqual({ ok: true, answer: "A steady team that respects hygienists, and room to grow." });
    expect((await conversationEdit(container, mariaRef, { questionKey: behavioral.key, text: "A nervous patient wanted to stop, so I slowed down and explained each step; she rebooked with me." })).ok).toBe(true);
    expect((await conversationEdit(container, mariaRef, { questionKey: "not_a_question", text: "x" })).ok).toBe(false);
    view = (await conversationView(container.db, mariaRef))!;
    expect(view.review!.find((i) => i.key === last.key)?.status).toBe("edited");
    expect(view.review!.find((i) => i.key === behavioral.key)?.status).toBe("edited");
    const scr = await screenOf(mariaId);
    expect(scr.progress.declined).toEqual([]);
    expect(scr.transcript.filter((t) => t.source === "edit").map((t) => t.questionKey)).toEqual([last.key, behavioral.key]);
    // nothing reached the team while she was still applying
    expect(await notesAbout("Maria")).toHaveLength(0);
    expect(await conversationSubmit(container, mariaRef)).toBe(true);
    expect(await conversationSubmit(container, mariaRef)).toBe(true); // twice is once
    await container.drain();
    const done = await screenOf(mariaId);
    expect(done.status).toBe("completed");
    expect(done.progress.submittedAt).toBeTruthy();
    const asmt = (await container.db.select().from(assessments).where(and(eq(assessments.applicationId, mariaId), eq(assessments.kind, "screen"))))[0];
    expect(asmt).toBeTruthy();
    // the edited words are the candidate's own: their quotes pass the check
    const said = done.transcript.filter((t) => t.role === "candidate").map((t) => t.content).join("\n").toLowerCase();
    for (const f of (asmt.result as { questionFindings: Array<{ evidence?: { quote?: string } }> }).questionFindings) if (f.evidence?.quote) expect(said + Object.values(done.answers).join("\n").toLowerCase()).toContain(f.evidence.quote.toLowerCase());
    expect(["screen_complete", "interview_recommended"]).toContain((await reload(mariaId)).stage);
    expect((await notesAbout("Maria")).length).toBeGreaterThan(0);
    const list = (await (await json("GET", `/api/v1/roles/${roleId}/applications`)).json()) as Array<{ id: string; stillApplying: boolean }>;
    expect(list.find((r) => r.id === mariaId)?.stillApplying).toBe(false);
    // Today hears about her now that she has finished
    const today = (await (await json("GET", "/api/v1/brief")).json()) as { cards: Array<{ kind: string; roleId?: string; title: string }> };
    expect(today.cards.find((c) => c.kind === "screening" && c.roleId === roleId)?.title).toMatch(/: 1 completed since yesterday$/);
  });

  it("E3: 'Send without the conversation' sends the application on to the team, is counted, and reads what was answered as not finished", async () => {
    const { outcome, applicationId } = await applyNow({ first: "Ana", last: "Silva", email: "ana@onevisit.test" });
    const ref = await refOf(outcome);
    await conversationStart(container, ref);
    await answer(ref, { tap: true });
    expect(await conversationPerson(container, ref, "send_without")).toMatchObject({ message: expect.stringMatching(/without the conversation/) });
    await container.drain();
    const scr = await screenOf(applicationId);
    expect(scr.status).toBe("declined_by_candidate");
    expect((await reload(applicationId)).stage).toBe("triaged");
    const counted = (await container.db.select().from(usageEvents).where(eq(usageEvents.key, "screen_person_requests"))).filter((u) => u.ref.screenId === scr.id);
    expect(counted).toMatchObject([{ ref: { choice: "send_without" } }]);
    const asmt = (await container.db.select().from(assessments).where(and(eq(assessments.applicationId, applicationId), eq(assessments.kind, "screen"))))[0];
    expect(asmt.result.anomalies.some((x) => x.kind === "incomplete_screen")).toBe(true);
    expect((asmt.result as { recommendation: string }).recommendation).not.toBe("strong_interview");
    const notes = await notesAbout("Ana Silva");
    expect(notes.some((n) => /part-way through the screening conversation/.test(n.title))).toBe(true);
    expect(notes.some((n) => n.kind === "candidate.recommended")).toBe(false);
    // never invited a second time
    expect(mail().filter((m) => m.to === "ana@onevisit.test" && /screening conversation/i.test(m.subject))).toHaveLength(0);
    expect(await conversationPerson(container, ref, "send_without")).toBeNull(); // closed now
  });

  it("E3: 'Have a person contact me' hands it to a recruiter and is counted; the recruiter's call notes finish it as notes, never as the candidate's words", async () => {
    const { outcome, applicationId } = await applyNow({ first: "Luis", last: "Ortega", email: "luis@onevisit.test" });
    const ref = await refOf(outcome);
    const r = await conversationPerson(container, ref, "contact_me");
    expect(r?.message).toMatch(/A person from One Visit Dental will follow up with you (within four business hours|on the next business day)/);
    const scr = await screenOf(applicationId);
    expect(scr.status).toBe("human_requested");
    expect((await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, applicationId)))).toHaveLength(1);
    expect((await container.db.select().from(usageEvents).where(eq(usageEvents.key, "screen_person_requests"))).filter((u) => u.ref.screenId === scr.id)).toMatchObject([{ ref: { choice: "contact_me" } }]);
    expect((await conversationView(container.db, ref))!).toMatchObject({ phase: "closed", status: "human_requested" });
    // the page keeps the time promised when he asked, however much later it is opened, and says so once it has passed
    const asked = (await conversationView(container.db, ref))!.personAsked!;
    expect(asked.overdue).toBe(false);
    expect(asked.dueWords).toMatch(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}/);
    const later = (await conversationView(container.db, ref, new Date(Date.now() + 10 * 24 * HOUR)))!;
    expect(later.personAsked).toEqual({ dueWords: asked.dueWords, overdue: true });
    // "Talk to a person" still offers a new request in the words true when it is read
    expect(later.personExpectation).toMatch(/^(within four business hours|on the next business day)/);
    // the owner does not work recruiter requests; a recruiter does
    const notes = { notes: [{ questionKey: questions[0].key, text: "Called him: license RDH54321 is active in California." }, { text: "Has done perio maintenance for six years; can start in two weeks." }] };
    expect((await json("POST", `/api/v1/applications/${applicationId}/screen/recruiter-notes`, notes)).status).toBe(403);
    const recruiter = await signInAs(container, app, { companyId, role: "recruiter" });
    const res = await json("POST", `/api/v1/applications/${applicationId}/screen/recruiter-notes`, notes, recruiter);
    expect(res.status, await res.clone().text()).toBe(200);
    await container.drain();
    const done = await screenOf(applicationId);
    expect(done.status).toBe("completed");
    expect(done.transcript.filter((t) => t.role === "recruiter").map((t) => [t.source, t.questionKey ?? null])).toEqual([["recruiter_call", questions[0].key], ["recruiter_call", null]]);
    expect((await reload(applicationId)).stage).toMatch(/screen_complete|interview_recommended/);
    const asmt = (await container.db.select().from(assessments).where(and(eq(assessments.applicationId, applicationId), eq(assessments.kind, "screen"))))[0];
    const result = asmt.result as { questionFindings: Array<{ evidence?: { source: string; quote?: string } }> };
    // the recruiter's words appear only as recruiter notes
    expect(result.questionFindings.filter((f) => f.evidence?.quote?.includes("Called him")).every((f) => f.evidence?.source === "recruiter_note")).toBe(true);
    expect(result.questionFindings.some((f) => f.evidence?.source === "recruiter_note")).toBe(true);
    // a finished conversation takes no more notes
    expect((await json("POST", `/api/v1/applications/${applicationId}/screen/recruiter-notes`, notes, recruiter)).status).toBe(409);
  });

  it("a conversation calls the model a limited number of times: messages that never answer a question stop at the cap and go to checking the answers", async () => {
    const { outcome, applicationId } = await applyNow({ first: "Cora", last: "Lane", email: "cora@onevisit.test" });
    const ref = await refOf(outcome);
    await conversationStart(container, ref);
    // the ask and two follow-ups for each question, and five more for the candidate's own questions
    const cap = modelTurnCap({ screening: { questions } } as unknown as Pick<RolePacket, "screening">);
    expect(cap).toBe(3 * questions.length + 5);
    const chat = { messageToCandidate: "The hiring team can tell you more about that.", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: "company", sentiment: "fine", done: false, humanRequested: false };
    for (let i = 0; i < cap + 2; i++) container.fake!.scriptNext("screen.turn", chat);
    const before = await turnsFor();
    for (let i = 0; i < cap + 2; i++) await conversationTurn(container, ref, { message: "Is there parking near the office?" });
    expect(await turnsFor()).toBe(before + cap);
    const view = (await conversationView(container.db, ref))!;
    expect(view.phase).toBe("review");
    expect(view.transcript.some((t) => t.role === "assistant" && t.content === TURN_CAP_REVIEW_MESSAGE)).toBe(true);
    expect(view.review!.every((i) => i.status === "unanswered")).toBe(true);
    // checking the answers calls nothing: she can still answer what is open and press Send
    expect(await conversationTurn(container, ref, { message: "One more question" })).toMatchObject({ kind: "reply", review: true });
    expect(await turnsFor()).toBe(before + cap);
    expect((await conversationEdit(container, ref, { questionKey: questions[0].key, text: "Yes, my RDH license is active." })).ok).toBe(true);
    expect(await conversationSubmit(container, ref)).toBe(true);
    const scr = await screenOf(applicationId);
    expect(scr.status).toBe("completed");
    const [capped] = await container.db.select().from(events).where(and(eq(events.type, "screen.turn_cap_reached"), eq(events.subjectId, scr.id)));
    expect(capped.payload).toMatchObject({ ending: "review", cap, modelTurns: cap, channel: "web" });
    container.fake!.clearScripts();
    await container.drain();
  });

  it("E5: the assistant failing twice pauses the conversation (no hand-off); the run tries again and emails the candidate once it answers", async () => {
    const { outcome, applicationId } = await applyNow({ first: "Omar", last: "Haddad", email: "omar@onevisit.test" });
    const ref = await refOf(outcome);
    await conversationStart(container, ref);
    await answer(ref, { tap: true });
    container.fake!.failNext("screen.turn", "throw");
    container.fake!.failNext("screen.turn", "throw");
    container.fake!.failNext("screen.turn", "throw");
    expect((await answer(ref)).kind).toBe("error"); // "please send that again"
    const paused = await answer(ref);
    expect(paused).toMatchObject({ kind: "reply", paused: true });
    await container.drain();
    let scr = await screenOf(applicationId);
    expect(scr.status).toBe("paused");
    expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, applicationId))).toHaveLength(0);
    expect((await conversationView(container.db, ref))!).toMatchObject({ phase: "closed", status: "paused" });
    // the first retry failed too (the third failure); half an hour on, it answers
    await advance(31 * 60_000);
    scr = await screenOf(applicationId);
    expect(scr.status).toBe("in_progress");
    expect(scr.transcript.at(-1)?.role).toBe("assistant");
    expect(mail().filter((m) => m.to === "omar@onevisit.test" && /You can finish your screening conversation/.test(m.subject))).toHaveLength(1);
    expect((await container.db.select().from(events).where(and(eq(events.subjectId, scr.id), eq(events.type, "screen.resumed"))))).toHaveLength(1);
    container.fake!.clearScripts();
  });

  it("E4: someone who stops part-way is reminded once, then the conversation closes with what they said, flagged not finished", async () => {
    const { outcome, applicationId } = await applyNow({ first: "Priya", last: "Shah", email: "priya@onevisit.test" });
    const ref = await refOf(outcome);
    await conversationStart(container, ref);
    await answer(ref, { tap: true });
    await container.drain();
    await advance(25 * HOUR);
    let scr = await screenOf(applicationId);
    expect(scr.idleRemindedAt).toBeTruthy();
    expect(scr.status).toBe("in_progress");
    expect(mail().filter((m) => m.to === "priya@onevisit.test" && /Pick up your screening conversation/.test(m.subject))).toHaveLength(1);
    await advance(49 * HOUR);
    scr = await screenOf(applicationId);
    expect(scr.status).toBe("unfinished");
    expect((await reload(applicationId)).stage).toBe("triaged");
    expect(mail().filter((m) => m.to === "priya@onevisit.test" && /^Your application for/.test(m.subject))).toHaveLength(1);
    const asmt = (await container.db.select().from(assessments).where(and(eq(assessments.applicationId, applicationId), eq(assessments.kind, "screen"))))[0];
    expect(asmt.result.anomalies.some((x) => x.kind === "incomplete_screen")).toBe(true);
    expect((await notesAbout("Priya Shah")).some((n) => /did not finish the screening conversation/.test(n.title))).toBe(true);
    // the run is over: no wait repeated for ever
    const run = (await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, scr.workflowRunId!)))[0];
    expect(run.status).toBe("completed");
    expect(mail().filter((m) => m.to === "priya@onevisit.test" && /Pick up your screening conversation/.test(m.subject))).toHaveLength(1);
  });

  it("E7: an eligibility answer that does not match: no conversation, a neutral receipt, and the hold for a person as before", async () => {
    const { outcome, applicationId } = await applyNow({ first: "Sam", last: "Nguyen", email: "sam@onevisit.test", answers: { [elig[0].key]: "no" } });
    expect(outcome).toEqual({ kind: "receipt", reason: "under_review" });
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, applicationId))).toHaveLength(0);
    expect((await reload(applicationId)).stage).toBe("ineligible");
  });

  it("'Ask me first' for screen invitations keeps the later path: the owner decides who is invited", async () => {
    await signIn(); // the clock has moved by days: a rule change needs a fresh sign-in (A12)
    expect((await json("PUT", "/api/v1/policies",{ actionType: "application.invite_screen", level: "approval", approverRoles: ["owner"] })).status).toBe(200);
    const { outcome, applicationId } = await applyNow({ first: "Vera", last: "Holt", email: "vera@onevisit.test" });
    expect(outcome).toEqual({ kind: "receipt", reason: "later_flow" });
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, applicationId))).toHaveLength(0);
    expect((await reload(applicationId)).stage).toBe("triaged");
    expect((await json("PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "auto_notify", approverRoles: [] })).status).toBe(200);
  });

  it("ITS alone switches a role, or a company, back to 'form now, conversation later'", async () => {
    expect((await json("PUT", `/api/v1/roles/${roleId}/apply-mode`, { applyMode: "form_then_screen", reason: "Pilot paused for this role" })).status).toBe(403);
    const its = await signInStaff(app, container, "ops@its.test", "platform_admin");
    expect((await json("PUT", `/api/v1/roles/${roleId}/apply-mode`, { applyMode: "form_then_screen" }, its)).status).toBe(400); // a reason is required
    const set = await json("PUT", `/api/v1/roles/${roleId}/apply-mode`, { applyMode: "form_then_screen", reason: "Pilot paused for this role" }, its);
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ roleId, applyMode: "form_then_screen", companyDefault: "one_visit", effective: "form_then_screen" });
    const { outcome } = await applyNow({ first: "Uma", last: "Reid", email: "uma@onevisit.test" });
    expect(outcome).toEqual({ kind: "receipt", reason: "later_flow" });
    // back to the company's default; then the company's default itself
    expect((await (await json("PUT", `/api/v1/roles/${roleId}/apply-mode`, { applyMode: null, reason: "Pilot back on" }, its)).json())).toMatchObject({ applyMode: null, effective: "one_visit" });
    expect((await json("POST", `/api/v1/admin/customers/${companyId}/apply-flow`, { applyFlow: "form_then_screen", reason: "Customer asked for the later path" }, cookie)).status).toBe(403);
    const flow = await app.request(`/api/v1/admin/customers/${companyId}/apply-flow`, { method: "POST", headers: { "content-type": "application/json", cookie: its, "x-admin-reason": "test" }, body: JSON.stringify({ applyFlow: "form_then_screen", reason: "Customer asked for the later path" }) });
    expect(flow.status).toBe(200);
    expect((await (await json("GET", `/api/v1/roles/${roleId}/apply-mode`, undefined, its)).json())).toMatchObject({ applyMode: null, companyDefault: "form_then_screen", effective: "form_then_screen" });
    expect((await applyNow({ first: "Wes", last: "Lund", email: "wes@onevisit.test" })).outcome).toEqual({ kind: "receipt", reason: "later_flow" });
    await app.request(`/api/v1/admin/customers/${companyId}/apply-flow`, { method: "POST", headers: { "content-type": "application/json", cookie: its, "x-admin-reason": "test" }, body: JSON.stringify({ applyFlow: "one_visit", reason: "Pilot back on for everyone" }) });
    const audits = (await container.db.select().from(events).where(eq(events.type, "role.apply_mode_changed"))).length;
    expect(audits).toBe(2);
  });

  it("E9: two first answers at the same moment count the conversation once; two conversations counted at once each count, and only one crosses the 80% line", async () => {
    const { outcome, applicationId } = await applyNow({ first: "Nia", last: "Ford", email: "nia@onevisit.test" });
    const ref = await refOf(outcome);
    await conversationStart(container, ref);
    const scr = await screenOf(applicationId);
    await Promise.all([answer(ref), answer(ref)]);
    const counted = (await container.db.select().from(usageEvents).where(eq(usageEvents.key, "text_screens"))).filter((u) => u.ref.screenId === scr.id);
    expect(counted).toHaveLength(1);
    // both answers are in the transcript: neither turn wrote over the other's
    expect((await screenOf(applicationId)).transcript.filter((t) => t.role === "candidate")).toHaveLength(2);
    // the count is added in the database, and the crossing read from the total it returns
    const [ent] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "text_screens")));
    await container.db.update(entitlements).set({ limit: 10, used: 7 }).where(eq(entitlements.id, ent.id));
    const both = await Promise.all([1, 2].map((n) => withTenant(container.db, companyId, (tx) => allowance.recordScreenStart(tx, companyId, { test: n }))));
    expect(both.map((c) => c.used).sort()).toEqual([8, 9]);
    expect(both.filter((c) => c.crossed === "warning")).toHaveLength(1);
    expect(both.filter((c) => c.crossed === "used_up")).toHaveLength(0);
    expect((await container.db.select().from(entitlements).where(eq(entitlements.id, ent.id)))[0].used).toBe(9);
    await container.db.update(entitlements).set({ limit: ent.limit, used: ent.used }).where(eq(entitlements.id, ent.id));
  });

  it("Q17: at 80% the owner and ITS are warned; used up, applications still come in and the link goes out by email once it is topped up", async () => {
    const [ent] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "text_screens")));
    await container.db.update(entitlements).set({ limit: 10, used: 7 }).where(eq(entitlements.id, ent.id));
    const first = await applyNow({ first: "Lena", last: "Park", email: "lena@onevisit.test" });
    const ref = await refOf(first.outcome);
    await conversationStart(container, ref);
    await answer(ref, { tap: true });
    expect((await container.db.select().from(notifications).where(eq(notifications.companyId, companyId))).some((n) => n.kind === "entitlement.text_screens" && /80%/.test(n.title))).toBe(true);
    expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "billing.screens_warning"))).filter((x) => x.companyId === companyId)).toHaveLength(1);
    // used up: the application is taken, the receipt says the link comes by email, and the run waits for more
    await container.db.update(entitlements).set({ used: 10 }).where(eq(entitlements.id, ent.id));
    const late = await applyNow({ first: "Rosa", last: "Diaz", email: "rosa@onevisit.test" });
    expect(late.outcome).toEqual({ kind: "receipt", reason: "conversation_by_email" });
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, late.applicationId))).toHaveLength(0);
    expect((await reload(late.applicationId)).stage).toBe("triaged");
    const waiting = (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "screen"))).find((r) => (r.state as { applicationId?: string }).applicationId === late.applicationId)!;
    expect(waiting.status).toBe("waiting");
    // on the web, as the receipt says, whatever the candidate agreed to about texts
    expect((waiting.state as { channel?: string }).channel).toBe("web");
    // the acknowledgment says the same as the receipt: the link comes by email, never "possibly"
    const ack = mail().find((m) => m.to === "rosa@onevisit.test" && /We received your application/.test(m.subject))!;
    expect(ack.text).toContain("1. We email you a link to a short written conversation with One Visit Dental's AI assistant");
    expect(ack.text).not.toMatch(/Possibly a short written conversation/);
    expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "billing.screens_used_up"))).filter((x) => x.companyId === companyId).length).toBeGreaterThanOrEqual(1);
    // topped up: the next look sends the link, and the conversation reads like everyone else's
    await container.db.update(entitlements).set({ limit: 100 }).where(eq(entitlements.id, ent.id));
    await advance(7 * HOUR);
    const scr = await screenOf(late.applicationId);
    expect(scr?.progress.flow).toBe("one_visit");
    expect(mail().filter((m) => m.to === "rosa@onevisit.test" && /screening conversation/i.test(m.subject))).toHaveLength(1);
    expect((await reload(late.applicationId)).stage).toBe("screen_invited");
  });

  it("E13: the role's figures: offered, started, finished, the median time, where people stopped, and who chose a person", async () => {
    const r = await json("GET", `/api/v1/roles/${roleId}/screening`);
    expect(r.status).toBe(200);
    const f = (await r.json()) as { offered: number; started: number; finished: number; unfinished: number; personChosen: { contactMe: number; sendWithout: number }; medianMinutes: number | null; skipped: unknown[] };
    expect(f.offered).toBeGreaterThanOrEqual(6);
    expect(f.finished).toBeGreaterThanOrEqual(2);
    expect(f.unfinished).toBe(2); // Priya, and Omar, who never came back after the outage while the clock moved on three days
    expect(f.personChosen).toEqual({ contactMe: 0, sendWithout: 1 }); // Luis's request was finished by the recruiter
    expect(f.medianMinutes).not.toBeNull();
  });

  /** The application and its next step in one transaction, as the apply page does, with nothing run after it yet. */
  async function applyWithoutRunning(p: { first: string; last: string; email: string }): Promise<{ applicationId: string; ref: ConversationRef }> {
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    const [company] = await container.db.select().from(companies).where(eq(companies.id, role.companyId));
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    const eligibilityAnswers = Object.fromEntries(elig.map((r) => [r.key, "yes"]));
    const out = await withTenant(container.db, company.id, async (tx) => {
      const created = await createApplication(tx, container, { companyId: company.id, roleId, source: "careers_page", firstName: p.first, lastName: p.last, email: p.email, phone: null, smsConsent: false, consentSource: "careers_page_apply", noticeVersionsShown: ["ai_use@2026-10-08", "privacy@2026-09-01"], eligibilityAnswers, resume: { kind: "bytes", filename: `${p.first.toLowerCase()}.txt`, mime: "text/plain", bytes: new TextEncoder().encode(RESUME(`${p.first} ${p.last}`)), via: "server" } }, { kind: "candidate", id: "applicant" });
      return { applicationId: created.application.id, outcome: await startApplyConversation(tx, container, { ...created, role, company, packet: pv.packet as RolePacket, typedFirstName: p.first, eligibilityAnswers }) };
    });
    return { applicationId: out.applicationId, ref: await refOf(out.outcome) };
  }

  it("E1: someone who withdraws in the conversation before their résumé is read: the intake completes quietly, and nobody is paged", async () => {
    const { applicationId, ref } = await applyWithoutRunning({ first: "Remy", last: "Clark", email: "remy@onevisit.test" });
    // WITHDRAW, confirmed with the page's button, before any job has run (a slow scanner or model)
    expect(await withTenant(container.db, companyId, (tx) => answerWithdrawPrompt(tx, screenDeps(container), { screenId: ref.id, confirm: true, channel: "web", actor: { kind: "candidate", id: "remy" } }))).toMatch(/withdrawn your application/);
    expect((await reload(applicationId)).stage).toBe("withdrawn");
    await container.kick();
    await container.drain();
    const intake = (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "application_intake"))).find((r) => (r.state as { applicationId?: string }).applicationId === applicationId)!;
    expect(intake.status).toBe("completed");
    expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, applicationId))).toHaveLength(0);
    expect(await container.db.select().from(assessments).where(eq(assessments.applicationId, applicationId))).toHaveLength(0);
  });

  it("E8: the acknowledgment never says 'possibly a conversation' to someone who already sent their application without it", async () => {
    const { ref } = await applyWithoutRunning({ first: "Sol", last: "Reyna", email: "sol@onevisit.test" });
    expect(await conversationPerson(container, ref, "send_without")).toMatchObject({ message: expect.stringMatching(/without the conversation/) });
    await container.drain();
    const ack = mail().find((m) => m.to === "sol@onevisit.test" && /We received your application/.test(m.subject))!;
    expect(ack.text).toContain("1. The hiring team at One Visit Dental reviews your application, with anything you answered in the short written conversation.");
    expect(ack.text).not.toMatch(/Possibly a short written conversation|pick it up here/);
  });

  it("E11: 'Skip' while the assistant follows up on an answer already given moves on and keeps that answer for the scorecard", async () => {
    const { outcome, applicationId } = await applyNow({ first: "Nina", last: "Park", email: "nina@onevisit.test" });
    const ref = await refOf(outcome);
    await conversationStart(container, ref);
    await answer(ref, { tap: true });
    let view = (await conversationView(container.db, ref))!;
    const key = view.current!.key;
    expect(view.current).toMatchObject({ tap: null, answered: false });
    // the assistant records the first, thin answer and asks a follow-up
    container.fake!.scriptNext("screen.turn", { messageToCandidate: "You mentioned cleanings. Could you give one example of how that went?", questionKey: null, answerRecorded: { questionKey: key, answer: "Cleanings and charting", complete: false }, followUpReason: "answer has no example yet", candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false });
    await conversationTurn(container, ref, { message: "Cleanings and charting" });
    view = (await conversationView(container.db, ref))!;
    expect(view.current).toMatchObject({ key, answered: true });
    // the page says what the button does now
    const page = await (await app.request(`/c/screen/${ref.token}`)).text();
    expect(page).toContain('<button class="link-action" type="submit" name="action" value="skip" formnovalidate="">Keep my answer and move on</button>');
    expect(page).not.toContain(">Skip this question</button>");
    expect(await conversationTurn(container, ref, { skip: true })).toMatchObject({ kind: "reply", message: expect.stringMatching(/^No problem\. Next: /) });
    expect(await (await app.request(`/c/screen/${ref.token}`)).text()).toContain("You moved on. Your answer is kept.");
    const scr = await screenOf(applicationId);
    expect(scr.answers[key]).toBe("Cleanings and charting");
    expect(scr.progress.declined ?? []).not.toContain(key);
    expect(scr.transcript.find((t) => t.questionKey === key && t.role === "system")).toMatchObject({ content: MOVED_ON_MESSAGE, source: "system" });
    expect((await conversationView(container.db, ref))!.current?.key).not.toBe(key);
    // a question with no answer at all is skipped as before, and is unknown
    const next = (await conversationView(container.db, ref))!.current!.key;
    await conversationTurn(container, ref, { skip: true });
    expect((await screenOf(applicationId)).progress.declined).toEqual([next]);
    container.fake!.clearScripts();
  });

  it("E4, E10: someone who answered everything but did not press Send is reminded to send; then the answers go as they are, never as 'unfinished'", async () => {
    const { outcome, applicationId } = await applyNow({ first: "Tess", last: "Moore", email: "tess@onevisit.test" });
    const ref = await refOf(outcome);
    await conversationStart(container, ref);
    for (let i = 0; i < 12; i++) {
      if ((await conversationView(container.db, ref))!.phase !== "conversation") break;
      await answer(ref, { tap: true });
    }
    expect((await conversationView(container.db, ref))!.phase).toBe("review");
    await advance(25 * HOUR);
    const toTess = () => mail().filter((m) => m.to === "tess@onevisit.test");
    expect(toTess().filter((m) => /are ready to send/.test(m.subject))).toHaveLength(1);
    expect(toTess().find((m) => /are ready to send/.test(m.subject))!.text).toMatch(/If you do nothing, we will send your answers to the hiring team as they are on /);
    // the team can already see her answers, so the reminder never says they are unsent; only that she has not pressed Send
    expect(toTess().find((m) => /are ready to send/.test(m.subject))!.text).toContain("but you have not pressed Send yet.");
    expect(toTess().find((m) => /are ready to send/.test(m.subject))!.text).not.toMatch(/have not been sent/);
    expect(toTess().filter((m) => /Pick up your screening conversation/.test(m.subject))).toHaveLength(0);
    await advance(49 * HOUR);
    const scr = await screenOf(applicationId);
    expect(scr.status).toBe("completed");
    expect(scr.progress.submittedAt).toBeTruthy();
    expect((await container.db.select().from(events).where(and(eq(events.subjectId, scr.id), eq(events.type, "screen.completed"))))[0].payload).toMatchObject({ via: "review_timeout" });
    const asmt = (await container.db.select().from(assessments).where(and(eq(assessments.applicationId, applicationId), eq(assessments.kind, "screen"))))[0];
    expect(asmt.result.anomalies.some((x) => x.kind === "incomplete_screen")).toBe(false);
    expect((await reload(applicationId)).stage).toMatch(/screen_complete|interview_recommended/);
    expect(toTess().filter((m) => /^Your application for/.test(m.subject))).toHaveLength(0); // no "we passed on what you told us"
  });

  it("E4: someone who never starts the conversation that goes with the application is reminded once; then the application goes to the team without it, and they are told nothing else is needed", async () => {
    const { outcome, applicationId } = await applyNow({ first: "Ola", last: "Berg", email: "ola@onevisit.test" });
    const ref = await refOf(outcome);
    await advance(49 * HOUR);
    const toOla = () => mail().filter((m) => m.to === "ola@onevisit.test");
    expect(toOla().filter((m) => /the short conversation is still open/.test(m.subject))).toHaveLength(1);
    expect(toOla().find((m) => /the short conversation is still open/.test(m.subject))!.text).toContain("in a few days your application goes to the hiring team without it");
    expect(toOla().filter((m) => /^Reminder: your screening conversation/.test(m.subject))).toHaveLength(0);
    await advance(73 * HOUR);
    expect((await screenOf(applicationId)).status).toBe("expired");
    expect((await reload(applicationId)).stage).toBe("triaged");
    expect(toOla().filter((m) => /^Your application for/.test(m.subject) && m.text.includes("has gone to the hiring team without the short written conversation"))).toHaveLength(1);
    expect((await notesAbout("Ola Berg")).some((n) => /applied without the screening conversation/.test(n.title))).toBe(true);
    expect((await notesAbout("Ola Berg")).some((n) => /did not respond to the screen/.test(n.title))).toBe(false);
    expect((await conversationView(container.db, ref))!).toMatchObject({ phase: "closed", status: "expired", oneVisit: true });
  });

  it("E5: a retried answer after an outage that hands over to a person tells the candidate so, and no 'finish now' email goes", async () => {
    const { outcome, applicationId } = await applyNow({ first: "Pia", last: "Lang", email: "pia@onevisit.test" });
    const ref = await refOf(outcome);
    await conversationStart(container, ref);
    await answer(ref, { tap: true });
    for (let i = 0; i < 3; i++) container.fake!.failNext("screen.turn", "throw");
    container.fake!.scriptNext("screen.turn", { messageToCandidate: "I'm sorry this is hard. A person from One Visit Dental will follow up with you.", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "distressed", done: false, humanRequested: true });
    expect((await answer(ref)).kind).toBe("error");
    expect(await answer(ref)).toMatchObject({ paused: true });
    await container.drain();
    await advance(31 * 60_000);
    expect((await screenOf(applicationId)).status).toBe("human_requested");
    const toPia = mail().filter((m) => m.to === "pia@onevisit.test");
    expect(toPia.filter((m) => /You can finish your screening conversation/.test(m.subject))).toHaveLength(0);
    expect(toPia.filter((m) => /^A person will contact you about/.test(m.subject))).toHaveLength(1);
    container.fake!.clearScripts();
  });

  it("E4: a conversation that should have closed by itself and did not is named to the team as stuck", async () => {
    const { outcome, applicationId } = await applyNow({ first: "Quinn", last: "Hale", email: "quinn@onevisit.test" });
    const ref = await refOf(outcome);
    await conversationStart(container, ref);
    const now = container.engine.clock();
    const scr = await screenOf(applicationId);
    expect(conversationOverdue(scr, now)).toBe(false);
    // its run stalled: the last answer five days ago, and still open
    await container.db.update(screens).set({ lastCandidateMessageAt: new Date(now.getTime() - 5 * 24 * HOUR).toISOString() }).where(eq(screens.id, scr.id));
    const stuck = (await withTenant(container.db, companyId, (tx) => detectStuckRoles(tx, companyId, now))).find((d) => d.detector === "conversations_stuck");
    expect(stuck?.applicationIds).toContain(applicationId);
    expect(stuck?.title).toMatch(/stuck in the screening conversation/);
    expect(stuck?.body).toContain("Quinn Hale");
    // the rule: started and idle past the reminder and the close, paused past the hand-over, never started past the link
    const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR).toISOString();
    const base = { expiresAt: null, startedAt: null, lastCandidateMessageAt: null, progress: { askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 } };
    expect(conversationOverdue({ ...base, status: "in_progress", lastCandidateMessageAt: at(90) }, now)).toBe(false);
    expect(conversationOverdue({ ...base, status: "in_progress", lastCandidateMessageAt: at(100) }, now)).toBe(true);
    expect(conversationOverdue({ ...base, status: "paused", progress: { ...base.progress, pausedAt: at(50) } }, now)).toBe(true);
    expect(conversationOverdue({ ...base, status: "invited", expiresAt: at(2) }, now)).toBe(false);
    expect(conversationOverdue({ ...base, status: "invited", expiresAt: at(30) }, now)).toBe(true);
    expect(conversationOverdue({ ...base, status: "completed", lastCandidateMessageAt: at(500) }, now)).toBe(false);
  });

  it("a recruiter's notes on someone with no conversation finish the screening; they never leave an invitation nobody sent", async () => {
    const recruiter = await signInAs(container, app, { companyId, role: "recruiter" });
    const [vera] = await container.db.select().from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(eq(candidates.email, "vera@onevisit.test"));
    const veraId = vera.applications.id;
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, veraId))).toHaveLength(0);
    const notes = { notes: [{ text: "Called her: active RDH license, five years of perio maintenance." }] };
    const open = await json("POST", `/api/v1/applications/${veraId}/screen/recruiter-notes`, { ...notes, complete: false }, recruiter);
    expect(open.status).toBe(409);
    expect(((await open.json()) as { error: { code: string } }).error.code).toBe("no_conversation");
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, veraId))).toHaveLength(0);
    const done = await json("POST", `/api/v1/applications/${veraId}/screen/recruiter-notes`, { ...notes, complete: true }, recruiter);
    expect(done.status, await done.clone().text()).toBe(200);
    await container.drain();
    expect((await screenOf(veraId)).status).toBe("completed");
  });

  it("an ITS recruiter sees or changes how people apply for a role only under a grant that covers it; the screens say how each was offered", async () => {
    await signIn();
    const its = await signInStaff(app, container, "rae@its.test", "its_recruiter", "Rae Recruiter");
    expect((await json("GET", `/api/v1/roles/${roleId}/apply-mode`, undefined, its)).status).toBe(403);
    const put = await json("PUT", `/api/v1/roles/${roleId}/apply-mode`, { applyMode: "form_then_screen", reason: "Owner asked for the later path" }, its);
    expect(put.status).toBe(403);
    expect(((await put.json()) as { error: { code: string } }).error.code).toBe("staff_scope");
    const [rae] = await container.db.select().from(users).where(eq(users.email, "rae@its.test"));
    await withPlatform(container.db, (tx) => grantStaffAccess(tx, { userId: rae.id, userName: "Rae Recruiter", companyId, kind: "escalation", scope: { roleId }, purpose: "test: a request about this role", grantedBy: { kind: "system", id: "test" }, expiresAt: new Date(Date.now() + 24 * HOUR) }));
    expect((await json("GET", `/api/v1/roles/${roleId}/apply-mode`, undefined, its)).status).toBe(200);
    const ok = await json("PUT", `/api/v1/roles/${roleId}/apply-mode`, { applyMode: "form_then_screen", reason: "Owner asked for the later path" }, its);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ applyMode: "form_then_screen", effective: "form_then_screen" });
    expect((await json("PUT", `/api/v1/roles/${roleId}/apply-mode`, { applyMode: null, reason: "Back to the company's default" }, its)).status).toBe(200);
    // GET /applications/:id names how each conversation was offered (the panel's "Still applying" reads it)
    const detail = (await (await json("GET", `/api/v1/applications/${mariaId}`)).json()) as { screens: Array<{ invitedVia: string | null }> };
    expect(detail.screens[0].invitedVia).toBe("apply");
  });

  // Last: it moves the clock two months on.
  it("Q17, G10: still used up after sixty days, the promised link never goes; the candidate is told it is not going ahead, and the team who never got it", async () => {
    const [ent] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "text_screens")));
    await container.db.update(entitlements).set({ limit: 10, used: 10 }).where(eq(entitlements.id, ent.id));
    const late = await applyNow({ first: "Ines", last: "Lowe", email: "ines@onevisit.test" });
    expect(late.outcome).toEqual({ kind: "receipt", reason: "conversation_by_email" });
    await advance(61 * 24 * HOUR);
    const run = (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "screen"))).find((r) => (r.state as { applicationId?: string }).applicationId === late.applicationId)!;
    expect(run.status).toBe("completed");
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, late.applicationId))).toHaveLength(0);
    const toInes = mail().filter((m) => m.to === "ines@onevisit.test");
    expect(toInes.filter((m) => /That conversation is not going ahead, and you do not need to do anything about it/.test(m.text))).toHaveLength(1);
    expect(toInes.filter((m) => /screening conversation/i.test(m.subject))).toHaveLength(0);
    expect((await notesAbout("Ines Lowe")).some((n) => /never got the screening conversation/.test(n.title) && n.action?.href.includes(late.applicationId))).toBe(true);
    expect((await container.db.select().from(events).where(and(eq(events.type, "screen.allowance_lapsed"), eq(events.subjectId, late.applicationId))))).toMatchObject([{ payload: { promised: true } }]);
    await container.db.update(entitlements).set({ limit: ent.limit, used: ent.used }).where(eq(entitlements.id, ent.id));
  });
});
