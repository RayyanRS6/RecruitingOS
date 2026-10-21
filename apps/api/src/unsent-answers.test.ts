import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { RolePacket, TapAnswer } from "@ros/contracts";
import { SCORECARD_READINGS, composeInterviewerBrief } from "@ros/agents";
import { HANDED_TO_A_PERSON, emit, exportCandidateData } from "@ros/core";
import { aiRuns, applications, assessments, communications, companies, events, notifications, recruiterEscalations, rolePackets, roles, screens, withTenant } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { createApplication } from "./services/applications";
import { applyVisitNext, conversationPerson, conversationStart, conversationSubmit, conversationTurn, conversationView, findConversation, interviewWaitFor, type ApplyVisitOutcome, type ConversationRef } from "./services/apply-conversation";
import { signInAdmin, signInAs, signInStaff, useOneVisitApplyFlow } from "./test-helpers";

/**
 * "Hide them until they send" (founder decision, 9 October 2026; counsel register item 20). While a candidate is in the
 * screening conversation and has not pressed Send, the hiring team, and an ITS recruiter working for it, sees nothing
 * they said in it, nor anything worked out from it: not on the Talent list or the candidate's page, in Compare, on the
 * board, in the one-click questions, in the match score, on Today, in the role report or its CSV files, in the history,
 * in a notification, in an interviewer's brief, or in a recruiter's request. A conversation closed without being sent
 * (unfinished, sent without it, handed to a person) stays that way, and is never read: the reading and the match score
 * stay the résumé's. Once sent, everything is there. A recruiter's notes from a call are not the candidate's answers and
 * are shown. The candidate's own copy of their data is unchanged.
 */
describe("answers the candidate has not sent stay hidden from the team", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let roleId = "";
  let packet: RolePacket;
  const BASE = Math.floor(Date.now() / 60_000) * 60_000;
  let offset = 0;
  const HOUR = 3600_000;
  const setClock = (ms: number) => { offset = ms; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset); };
  const advance = async (ms: number) => { setClock(offset + ms); await container.drain(); };
  const RESUME = (name: string) => `${name}, RDH\n\nRegistered Dental Hygienist at Smile Bright Dental 2019 - present\nLicenses: RDH license CA #RDH12345, active\nSkills: Dentrix, periodontal charting, perio maintenance`;

  const request = (method: string, path: string, body?: unknown, as = owner) => app.request(path, { method, headers: { "content-type": "application/json", cookie: as }, body: body ? JSON.stringify(body) : undefined });
  const get = async <T = unknown>(path: string, as = owner): Promise<{ status: number; text: string; body: T }> => {
    const r = await request("GET", path, undefined, as);
    const text = await r.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: r.status, text, body: body as T };
  };
  const screenOf = async (applicationId: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, applicationId))).sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))[0];
  const screenAssessments = (applicationId: string) => container.db.select().from(assessments).where(and(eq(assessments.applicationId, applicationId), eq(assessments.kind, "screen")));
  const assessRuns = async () => (await container.db.select().from(aiRuns).where(eq(aiRuns.task, "screen.assess"))).length;

  async function applyNow(p: { first: string; last: string; email: string }): Promise<{ applicationId: string; candidateId: string; ref: ConversationRef }> {
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    const [company] = await container.db.select().from(companies).where(eq(companies.id, role.companyId));
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    const eligibilityAnswers = Object.fromEntries(packet.requirements.eligibility.map((r) => [r.key, "yes"]));
    const out = await withTenant(container.db, company.id, async (tx) => {
      const created = await createApplication(tx, container, { companyId: company.id, roleId, source: "careers_page", firstName: p.first, lastName: p.last, email: p.email, phone: null, smsConsent: false, consentSource: "careers_page_apply", noticeVersionsShown: ["ai_use@2026-10-08", "privacy@2026-09-01"], eligibilityAnswers, resume: { kind: "bytes", filename: `${p.first.toLowerCase()}.txt`, mime: "text/plain", bytes: new TextEncoder().encode(RESUME(`${p.first} ${p.last}`)), via: "server" } }, { kind: "candidate", id: "applicant" });
      const outcome: ApplyVisitOutcome = await applyVisitNext(tx, container, { application: created.application, duplicate: created.duplicate, knownPerson: created.knownPerson, company, role, packet: pv.packet as RolePacket, eligibilityAnswers, typedFirstName: p.first });
      return { applicationId: created.application.id, candidateId: created.application.candidateId, outcome };
    });
    await container.kick();
    await container.drain();
    // the AI interview that goes with the application, made once the résumé is read (20 Oct 2026)
    if (out.outcome.kind !== "interview") throw new Error(`expected the AI interview, got ${out.outcome.reason}`);
    const wait = await interviewWaitFor(container.db, out.applicationId);
    if (wait.state !== "ready") throw new Error(`expected the AI interview to be ready, got ${wait.state}`);
    return { applicationId: out.applicationId, candidateId: out.candidateId, ref: (await findConversation(container.db, wait.token))! };
  }

  /** The first question by tap, then one typed answer carrying `marker`, both in the transcript and recorded as the answer. */
  async function startAndSay(ref: ConversationRef, marker: string): Promise<void> {
    await conversationStart(container, ref);
    await tapCurrent(ref);
    const key = (await conversationView(container.db, ref))!.current!.key;
    container.fake!.scriptNext("screen.turn", { messageToCandidate: "Thanks.", questionKey: null, answerRecorded: { questionKey: key, answer: `${marker}-answer: I see nine patients a day and chart in Dentrix.`, complete: true }, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false });
    expect((await conversationTurn(container, ref, { message: `${marker}-typed: At Smile Bright I see nine patients a day and chart in Dentrix.` })).kind).toBe("reply");
    container.fake!.clearScripts();
  }
  async function tapCurrent(ref: ConversationRef): Promise<void> {
    const q = (await conversationView(container.db, ref))!.current!;
    if (!q.tap) {
      await conversationTurn(container, ref, { message: "At Smile Bright I see nine patients a day, chart in Dentrix and do perio maintenance; I like steady teams." });
      return;
    }
    const tap: TapAnswer = q.tap.kind === "yes_no" ? { kind: "yes_no", choice: "yes" } : q.tap.kind === "pay_range" ? { kind: "pay_range", min: 50, max: 54 } : q.tap.kind === "days" ? { kind: "days", days: ["Monday", "Tuesday"] } : { kind: "start_date", date: new Date(BASE + 14 * 24 * HOUR).toISOString().slice(0, 10) };
    await conversationTurn(container, ref, { tap });
  }

  type DetailScreen = { id: string; status: string; answersShared?: boolean; answers: Record<string, string>; transcript: Array<{ role: string; content: string; source?: string }>; progress: { askedKeys: string[]; declined?: string[]; completedBy?: string }; assessmentId: string | null };
  type Detail = { latestAssessmentId: string | null; screens: DetailScreen[]; assessments: Array<{ id: string; kind: string }>; communications: Array<{ direction: string; channel: string; bodyText: string | null }>; timeline: Array<{ type: string; subjectId: string; payload: Record<string, unknown> }>; matchScore: { score: number | null; basedOn: string; interview: string; basis: string } | null };

  /**
   * Every place the team reads a candidate, as the owner (or `as`) sees it, in one string to search, with the parts the
   * tests look into. Each must answer 200.
   */
  async function teamSurfaces(ids: string[], as = owner) {
    const mustHave = packet.requirements.mustHaves[0].key;
    const paths = {
      list: `/api/v1/roles/${roleId}/applications?counts=1`,
      listByScore: `/api/v1/roles/${roleId}/applications?order=score`,
      compare: `/api/v1/roles/${roleId}/compare?ids=${ids.join(",")}`,
      board: `/api/v1/roles/${roleId}/board`,
      questions: `/api/v1/roles/${roleId}/questions`,
      missing: `/api/v1/roles/${roleId}/questions/missing_must_have`,
      overlooked: `/api/v1/roles/${roleId}/questions/overlooked`,
      strongest: `/api/v1/roles/${roleId}/questions/strongest_evidence?mustHave=${mustHave}`,
      compareQuestion: `/api/v1/roles/${roleId}/questions/compare?ids=${ids.join(",")}`,
      today: "/api/v1/brief",
      report: `/api/v1/roles/${roleId}/report`,
      csv: `/api/v1/roles/${roleId}/report.csv`,
      summaryCsv: `/api/v1/roles/${roleId}/report/summary.csv`,
      funnel: `/api/v1/roles/${roleId}/screening`,
      history: "/api/v1/events",
      // the job's Activity tab reads its own list of events: the same rule holds there (Wave S5)
      timeline: `/api/v1/roles/${roleId}/timeline`,
      notifications: "/api/v1/notifications",
      notificationHistory: "/api/v1/notifications/history",
      ...Object.fromEntries(ids.map((id) => [`detail:${id}`, `/api/v1/applications/${id}`])),
    } as Record<string, string>;
    const out: Record<string, { status: number; text: string; body: unknown }> = {};
    for (const [name, path] of Object.entries(paths)) {
      const r = await get(path, as);
      expect(r.status, `${name} ${path}: ${r.text.slice(0, 300)}`).toBe(200);
      out[name] = r;
    }
    // what the team's alerts hold, read straight from the table too (every kind, read or not)
    const alerts = await container.db.select().from(notifications).where(eq(notifications.companyId, companyId));
    const all = Object.values(out).map((r) => r.text).join("\n") + JSON.stringify(alerts);
    return { all, out, detail: (id: string) => out[`detail:${id}`].body as Detail, alerts };
  }

  /** The interviewer's brief for the plan's first round, as an interviewer would get it. */
  const briefFor = (applicationId: string, firstName: string) => withTenant(container.db, companyId, async (tx) => composeInterviewerBrief(tx, { applicationId, candidateFirstName: firstName, packet, roundKey: packet.interviews.plan[0].key }));

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake" } });
    app = createApp(container);
    setClock(0);
    const r1 = await request("POST", "/api/v1/auth/magic-link", { email: "dana@unsent.test" });
    const { devLink } = (await r1.json()) as { devLink: string };
    owner = (await request("POST", "/api/v1/auth/magic-link/consume", { token: new URL(devLink).searchParams.get("token") })).headers.get("set-cookie")!.split(";")[0];
    companyId = ((await (await request("POST", "/api/v1/companies", { name: "Unsent Dental", vertical: "dental", sizeBand: "50-99", ownerName: "Dana Whitfield", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    await useOneVisitApplyFlow(container, companyId);
    const c1 = (await (await request("POST", "/api/v1/intake/conversation/messages", { message: "I need a dental hygienist in Irvine. Full time. $45 to $55 an hour. I need someone who can start within 30 days." })).json()) as { intakeSessionId: string };
    await request("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/messages`, { message: "It's a replacement, our hygienist moved. Ceiling is $58. Interviewers: Dr. Chen and me. I decide. Must-haves: active CA RDH license, perio experience. Deal-breakers: can't work Saturdays." });
    roleId = ((await (await request("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/compile`)).json()) as { roleId: string }).roleId;
    await request("POST", `/api/v1/roles/${roleId}/approve`, { version: 1 });
    await container.drain();
    const role = (await (await request("GET", `/api/v1/roles/${roleId}`)).json()) as { status: string; currentPacket: { packet: RolePacket } };
    expect(role.status).toBe("open");
    packet = role.currentPacket.packet;
  });
  afterAll(async () => { await container.close(); });

  let maria: { applicationId: string; candidateId: string; ref: ConversationRef };

  it("while she is still applying, nothing she said reaches the team: list, detail, Compare, board, questions, score, Today, report and CSV, history, alerts, brief", async () => {
    maria = await applyNow({ first: "Maria", last: "Reyes", email: "maria@unsent.test" });
    await startAndSay(maria.ref, "ZQXM");
    await container.drain();
    // what she said is on her conversation, and the message she typed is on record, tagged with the conversation
    const scr = await screenOf(maria.applicationId);
    expect(scr.status).toBe("in_progress");
    expect(JSON.stringify(scr.answers)).toContain("ZQXM-answer");
    expect(scr.transcript.some((t) => t.role === "candidate" && t.content.startsWith("ZQXM-typed"))).toBe(true);
    const typed = (await container.db.select().from(communications).where(eq(communications.applicationId, maria.applicationId))).filter((m) => m.direction === "inbound" && m.bodyText?.includes("ZQXM-typed"));
    expect(typed.map((m) => m.tags)).toEqual([{ screenId: scr.id }]);

    const seen = await teamSurfaces([maria.applicationId]);
    expect(seen.all).not.toContain("ZQXM");
    const d = seen.detail(maria.applicationId);
    expect(d.screens).toHaveLength(1);
    // the panel has nothing to read yet, and says why (`answersShared: false`): no answer, no line, nothing about how far she got
    expect(d.screens[0]).toMatchObject({ status: "in_progress", answersShared: false, answers: {}, transcript: [], assessmentId: null });
    expect(d.screens[0].progress.askedKeys).toEqual([]);
    expect(d.communications.some((m) => m.direction === "inbound" && m.channel === "web")).toBe(false);
    expect(d.timeline.some((e) => e.type.startsWith("screen.answer_") || e.type === "screen.question_skipped")).toBe(false);
    // the reading and the score are the résumé's, and the score says so (R20-9): never how far she got
    expect(d.assessments.map((a) => a.kind)).toEqual(["triage"]);
    if (d.matchScore) expect(d.matchScore).toMatchObject({ basedOn: "resume", interview: "not_done_yet", basis: "Résumé only: AI interview not done yet" });
    // on the list and the board she is under "No AI interview yet" (R20-7; `stillApplying` is its alias for one release)
    const list = seen.out.list.body as { applications: Array<{ id: string; stillApplying: boolean; ownerStage: string; ownerStageLabel: string }> };
    expect(list.applications.find((r) => r.id === maria.applicationId)).toMatchObject({ ownerStage: "no_ai_interview", ownerStageLabel: "Started (not finished)", stillApplying: true });
    const board = seen.out.board.body as { noAiInterview: Array<{ applicationId: string; score: unknown; placement: { column: string | null } }>; stillApplying: Array<{ applicationId: string }> };
    expect(board.noAiInterview.map((c) => c.applicationId)).toContain(maria.applicationId);
    expect(board.noAiInterview.find((c) => c.applicationId === maria.applicationId)?.placement.column).toBeNull();
    expect(board.stillApplying.map((c) => c.applicationId)).toContain(maria.applicationId);
    const compare = seen.out.compare.body as { candidates: Array<{ applicationId: string; screen: unknown }> };
    expect(compare.candidates[0]).toMatchObject({ applicationId: maria.applicationId, screen: null });
    // nobody is alerted about her yet
    expect(seen.alerts.filter((n) => n.title.includes("Maria") || n.body.includes("Maria"))).toHaveLength(0);
    // an interviewer's brief has none of it either
    expect(JSON.stringify(await briefFor(maria.applicationId, "Maria"))).not.toContain("ZQXM");
  });

  it("the moment she presses Send, her answers, her messages and the scorecard are there", async () => {
    // taps where they fit; "Skip" elsewhere, which keeps an answer already given and moves on (E11)
    for (let i = 0; i < 12; i++) {
      const view = (await conversationView(container.db, maria.ref))!;
      if (view.phase !== "conversation") break;
      if (view.current?.tap) await tapCurrent(maria.ref);
      else await conversationTurn(container, maria.ref, { skip: true });
    }
    expect((await conversationView(container.db, maria.ref))!.phase).toBe("review");
    // answered everything, not sent yet: still nothing
    expect((await teamSurfaces([maria.applicationId])).all).not.toContain("ZQXM");
    expect(await conversationSubmit(container, maria.ref)).toBe(true);
    await container.drain();
    expect((await screenOf(maria.applicationId)).status).toBe("completed");
    const seen = await teamSurfaces([maria.applicationId]);
    const d = seen.detail(maria.applicationId);
    expect(d.screens[0].answersShared).toBe(true);
    expect(JSON.stringify(d.screens[0].answers)).toContain("ZQXM-answer");
    expect(d.screens[0].transcript.some((t) => t.role === "candidate" && t.content.startsWith("ZQXM-typed"))).toBe(true);
    expect(d.communications.some((m) => m.direction === "inbound" && m.bodyText?.startsWith("ZQXM-typed"))).toBe(true);
    expect(d.assessments.some((a) => a.kind === "screen")).toBe(true);
    expect(d.screens[0].assessmentId).toBeTruthy();
    const compare = seen.out.compare.body as { candidates: Array<{ screen: unknown }> };
    expect(compare.candidates[0].screen).not.toBeNull();
    expect(seen.alerts.some((n) => n.title.includes("Maria"))).toBe(true);
    expect(JSON.stringify(await briefFor(maria.applicationId, "Maria"))).toContain("ZQXM-answer");
  });

  let luisId = "";

  it("asking for a person: the ITS recruiter's request and the team see the recruiter's call notes, never what he typed before", async () => {
    const luis = await applyNow({ first: "Luis", last: "Ortega", email: "luis@unsent.test" });
    luisId = luis.applicationId;
    await startAndSay(luis.ref, "ZQXL");
    expect((await conversationPerson(container, luis.ref, "contact_me"))?.message).toMatch(/will follow up with you/);
    await container.drain();
    expect((await screenOf(luisId)).status).toBe("human_requested");
    // the request ITS works from, and the team's alert, say nothing he typed
    const [esc] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, luisId));
    expect(JSON.stringify(esc)).not.toContain("ZQXL");
    expect((esc.contextSnapshot as { screens: Array<{ answersShared: boolean }> }).screens[0].answersShared).toBe(false);
    const alert = (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "screen.human_requested"))))[0];
    expect(alert.body).toContain("Anything they typed before asking was not sent");
    // an ITS recruiter who claims it: the request, and the candidate's page under the grant
    const its = await signInStaff(app, container, "rae@its.test", "its_recruiter", "Rae Recruiter");
    expect((await request("POST", `/api/v1/escalations/${esc.id}/claim`, undefined, its)).status).toBe(200);
    const opened = await get<{ full: { contextSnapshot: unknown } | null; accessGranted?: boolean }>(`/api/v1/escalations/${esc.id}`, its);
    expect(opened.status).toBe(200);
    expect(opened.text).not.toContain("ZQXL");
    expect((await request("POST", "/api/v1/auth/switch", { companyId }, its)).status).toBe(200);
    const asRecruiter = await get<Detail>(`/api/v1/applications/${luisId}`, its);
    expect(asRecruiter.status).toBe(200);
    expect(asRecruiter.text).not.toContain("ZQXL");
    expect(asRecruiter.body.screens[0]).toMatchObject({ status: "human_requested", answersShared: false, answers: {}, transcript: [] });

    // the recruiter's notes from the call finish it: the notes are shown, his own words still are not
    const recruiter = await signInAs(container, app, { companyId, role: "recruiter" });
    const before = await assessRuns();
    const res = await request("POST", `/api/v1/applications/${luisId}/screen/recruiter-notes`, { notes: [{ questionKey: packet.screening.questions[0].key, text: "NOTESL: called him, his RDH license is active in California." }, { text: "NOTESL: six years of perio maintenance; can start in two weeks." }] }, recruiter);
    expect(res.status, await res.clone().text()).toBe(200);
    await container.drain();
    const scr = await screenOf(luisId);
    expect(scr).toMatchObject({ status: "completed" });
    expect(scr.progress.completedBy).toBe("recruiter_call");
    // read from the notes alone (three readings, the middle answer kept: Wave S5)
    expect(await assessRuns()).toBe(before + SCORECARD_READINGS);
    const [card] = await screenAssessments(luisId);
    expect(JSON.stringify(card.result)).not.toContain("ZQXL");
    const seen = await teamSurfaces([luisId]);
    expect(seen.all).not.toContain("ZQXL");
    expect(seen.all).toContain("NOTESL");
    const d = seen.detail(luisId);
    expect(d.screens[0]).toMatchObject({ status: "completed", answersShared: false, answers: {} });
    expect(d.screens[0].progress.completedBy).toBe("recruiter_call");
    expect(d.screens[0].transcript.map((t) => [t.role, t.source])).toEqual([["recruiter", "recruiter_call"], ["recruiter", "recruiter_call"]]);
    expect(d.assessments.some((a) => a.kind === "screen")).toBe(true);
    // finished on a call, its scorecard is in his score (R20-9)
    if (d.matchScore) expect(d.matchScore.interview).toBe("done");
    // the conversation page tells him it was finished on a call, never that his answers were sent
    const page = await (await app.request(`/c/screen/${luis.ref.token}`)).text();
    expect(page).toContain("went through the questions with you");
    expect(page).not.toContain("your answers are sent");
  });

  let ana: { applicationId: string; candidateId: string; ref: ConversationRef };

  it("sending the application without the conversation: what was answered before is never read, shown or alerted", async () => {
    ana = await applyNow({ first: "Ana", last: "Silva", email: "ana@unsent.test" });
    await startAndSay(ana.ref, "ZQXA");
    const before = await assessRuns();
    expect(await conversationPerson(container, ana.ref, "send_without")).toMatchObject({ message: expect.stringMatching(/without the conversation/) });
    await container.drain();
    expect((await screenOf(ana.applicationId)).status).toBe("declined_by_candidate");
    expect(await screenAssessments(ana.applicationId)).toHaveLength(0);
    expect(await assessRuns()).toBe(before);
    const seen = await teamSurfaces([ana.applicationId]);
    expect(seen.all).not.toContain("ZQXA");
    expect(seen.detail(ana.applicationId).screens[0]).toMatchObject({ status: "declined_by_candidate", answersShared: false, answers: {}, transcript: [] });
    // her score is the résumé's, in the same words as a lapsed or unfinished one: nothing says she chose to send it without (R20-9)
    const anaScore = seen.detail(ana.applicationId).matchScore;
    if (anaScore) expect(anaScore).toMatchObject({ basedOn: "resume", interview: "not_done", basis: "Résumé only: no AI interview" });
    // the history says she sent it without the conversation, never how far she got
    const history = seen.out.history.body as Array<{ type: string; subjectId: string; payload: Record<string, unknown> }>;
    const declined = history.find((e) => e.type === "screen.declined_by_candidate" && e.subjectId === (seen.detail(ana.applicationId).screens[0].id));
    expect(declined?.payload).not.toHaveProperty("answered");
    expect(seen.alerts.filter((n) => n.kind === "screen.declined_by_candidate" && n.title.includes("Ana Silva"))).toHaveLength(1);
  });

  let priya: { applicationId: string; candidateId: string; ref: ConversationRef };

  it("closed unfinished: never read, never shown; the team sees that she didn't finish, and her reading and score stay the résumé's", async () => {
    priya = await applyNow({ first: "Priya", last: "Shah", email: "priya@unsent.test" });
    await startAndSay(priya.ref, "ZQXP");
    await container.drain();
    const before = await assessRuns();
    await advance(25 * HOUR); // one reminder
    await advance(49 * HOUR); // then it closes
    const scr = await screenOf(priya.applicationId);
    expect(scr.status).toBe("unfinished");
    expect(scr.assessmentId).toBeNull();
    // nothing was read from what she never sent
    expect(await screenAssessments(priya.applicationId)).toHaveLength(0);
    expect(await assessRuns()).toBe(before);
    const [app0] = await container.db.select().from(applications).where(eq(applications.id, priya.applicationId));
    expect((await container.db.select().from(assessments).where(eq(assessments.id, app0.latestAssessmentId!)))[0].kind).toBe("triage");
    const seen = await teamSurfaces([priya.applicationId]);
    expect(seen.all).not.toContain("ZQXP");
    const d = seen.detail(priya.applicationId);
    expect(d.screens[0]).toMatchObject({ status: "unfinished", answersShared: false, answers: {}, transcript: [], assessmentId: null });
    expect(d.assessments.map((a) => a.kind)).toEqual(["triage"]);
    // résumé only, in one wording for every way a link closes unsent (R20-9)
    if (d.matchScore) expect(d.matchScore).toMatchObject({ basedOn: "resume", interview: "not_done", basis: "Résumé only: no AI interview" });
    // no alert (R20-7): she stays under "No AI interview yet" as "Didn't finish"; the history says it, with no count of what she answered
    expect(seen.alerts.filter((n) => n.kind === "screen.unfinished")).toHaveLength(0);
    expect((seen.out.list.body as { applications: Array<{ id: string; ownerStageLabel: string }> }).applications.find((r) => r.id === priya.applicationId)?.ownerStageLabel).toBe("Didn't finish");
    const unfinished = (seen.out.history.body as Array<{ type: string; subjectId: string; payload: Record<string, unknown> }>).find((e) => e.type === "screen.unfinished" && e.subjectId === scr.id)!;
    expect(unfinished.payload).not.toHaveProperty("answered");
    expect(unfinished.payload).not.toHaveProperty("stoppedAt");
    expect(d.timeline.find((e) => e.type === "screen.unfinished")?.payload).not.toHaveProperty("answered");
  });

  let legacyId = "";
  const strongCount = (body: unknown) => Number(/(\d+) strong candidates? ready/.exec((body as { summary: string }).summary)?.[1] ?? Number.NaN);

  it("a reading written of an unsent conversation before this rule is never shown or counted: everything reads as before it, history and Today included", async () => {
    const score = (body: unknown, id: string) => (body as { applications: Array<{ id: string; score: number | null; band: string | null }> }).applications.find((r) => r.id === id);
    // as an unfinished chat did before 20 October 2026 (R20-7 keeps her under "No AI interview yet" now), she waits on the
    // team; her résumé reading is Strong: Today counts her among the strong candidates waiting on the team
    await container.db.update(applications).set({ stage: "triaged" }).where(eq(applications.id, priya.applicationId));
    const baseline = await teamSurfaces([priya.applicationId]);
    const [app0] = await container.db.select().from(applications).where(eq(applications.id, priya.applicationId));
    await container.db.update(assessments).set({ overall: "strong" }).where(eq(assessments.id, app0.latestAssessmentId!));
    const before = await teamSurfaces([priya.applicationId]);
    expect(strongCount(before.out.today.body)).toBe(strongCount(baseline.out.today.body) + 1);
    const beforeCsv = before.out.csv.text;
    const beforeToday = (before.out.today.body as { summary: string }).summary;
    // an old scorecard of Priya's unfinished conversation, "strong", as one was written before 9 October 2026: marked as
    // read from a conversation she did not finish, linked from her screen, her latest reading, and in her history
    const [maria0] = await screenAssessments(maria.applicationId);
    const [legacy] = await container.db.insert(assessments).values({ companyId, applicationId: priya.applicationId, kind: "screen", packetVersion: maria0.packetVersion, aiRunId: null, result: { ...maria0.result, summary: "ZQXP-legacy: read from what she said before she stopped.", recommendation: "strong_interview", anomalies: [{ kind: "incomplete_screen", detail: "The candidate stopped part-way and did not come back: 1 of 5 questions answered." }] } as typeof maria0.result, overall: "strong", confidence: "high" }).returning();
    legacyId = legacy.id;
    const priyaScreen = await screenOf(priya.applicationId);
    await container.db.update(screens).set({ assessmentId: legacy.id }).where(eq(screens.applicationId, priya.applicationId));
    await container.db.update(applications).set({ latestAssessmentId: legacy.id }).where(eq(applications.id, priya.applicationId));
    const agent = { kind: "agent" as const, id: "screening" };
    await withTenant(container.db, companyId, async (tx) => {
      await emit(tx, { type: "screen.assessed", companyId, actor: agent, subject: { type: "screen", id: priyaScreen.id }, payload: { assessmentId: legacy.id, recommendation: "strong_interview", confidence: "high", incomplete: true } });
      // naming the role too, so the job's Activity tab would list it if it did not hold it back
      await emit(tx, { type: "assessment.created", companyId, actor: agent, subject: { type: "application", id: priya.applicationId }, payload: { kind: "screen", assessmentId: legacy.id, overall: "strong", roleId } });
    });
    // written back then, before 9 October 2026
    await container.db.update(events).set({ occurredAt: new Date(BASE - 30 * 24 * HOUR).toISOString() }).where(and(inArray(events.type, ["screen.assessed", "assessment.created"]), inArray(events.subjectId, [priyaScreen.id, priya.applicationId])));

    const after = await teamSurfaces([priya.applicationId]);
    expect(after.all).not.toContain("ZQXP");
    // nothing names it either: not the latest reading, not "scorecard written", not "assessed" with its recommendation
    expect(after.all).not.toContain(legacy.id);
    expect(after.all).not.toContain("strong_interview");
    const d = after.detail(priya.applicationId);
    expect(d.assessments.map((a) => a.kind)).toEqual(["triage"]);
    expect(d.latestAssessmentId).toBe(before.detail(priya.applicationId).latestAssessmentId);
    expect(d.screens[0].assessmentId).toBeNull();
    expect(d.matchScore).toEqual(before.detail(priya.applicationId).matchScore);
    expect(score(after.out.list.body, priya.applicationId)).toEqual(score(before.out.list.body, priya.applicationId));
    expect((after.out.compare.body as { candidates: Array<{ screen: unknown; score: unknown }> }).candidates[0]).toMatchObject({ screen: null, score: (before.out.compare.body as { candidates: Array<{ score: unknown }> }).candidates[0].score });
    expect(after.out.csv.text).toBe(beforeCsv);
    // Today counts her by her Strong résumé reading, as the list and the board show her, not by the hidden one
    expect((after.out.today.body as { summary: string }).summary).toBe(beforeToday);
    expect(JSON.stringify(await briefFor(priya.applicationId, "Priya"))).not.toContain("ZQXP");
    // and nobody can flag what they cannot see
    expect((await request("POST", `/api/v1/applications/${priya.applicationId}/assessments/${legacy.id}/flag`, { kind: "wrong_evidence" })).status).toBe(404);
  });

  it("finishing that conversation on a recruiter's call writes a scorecard from the notes, and the older reading still never shows", async () => {
    const recruiter = await signInAs(container, app, { companyId, role: "recruiter" });
    const before = await assessRuns();
    const res = await request("POST", `/api/v1/applications/${priya.applicationId}/screen/recruiter-notes`, { notes: [{ text: "NOTESP: called her; her RDH license is active, four years of perio maintenance." }] }, recruiter);
    expect(res.status, await res.clone().text()).toBe(200);
    // at once, before the notes' scorecard is written: her latest reading is her résumé's again, never the old one
    const [now] = await container.db.select().from(applications).where(eq(applications.id, priya.applicationId));
    expect(now.latestAssessmentId).not.toBe(legacyId);
    expect(now.latestAssessmentId).toBeTruthy();
    await container.drain();
    const scr = await screenOf(priya.applicationId);
    expect(scr.status).toBe("completed");
    expect(scr.progress.completedBy).toBe("recruiter_call");
    expect(scr.assessmentId).toBeTruthy();
    expect(scr.assessmentId).not.toBe(legacyId);
    expect(await assessRuns()).toBe(before + SCORECARD_READINGS);
    const seen = await teamSurfaces([priya.applicationId]);
    expect(seen.all).not.toContain("ZQXP");
    expect(seen.all).not.toContain(legacyId);
    expect(seen.all).toContain("NOTESP");
    const d = seen.detail(priya.applicationId);
    expect(d.assessments.map((a) => a.id)).toContain(scr.assessmentId);
    expect(d.latestAssessmentId).toBe(scr.assessmentId);
    // the history says the notes' scorecard was written, and nothing about the old one
    expect(d.timeline.some((e) => e.type === "assessment.created" && e.payload.assessmentId === scr.assessmentId)).toBe(true);
    expect(JSON.stringify(await briefFor(priya.applicationId, "Priya"))).not.toContain("ZQXP");
    expect((await request("POST", `/api/v1/applications/${priya.applicationId}/assessments/${legacyId}/flag`, { kind: "wrong_evidence" })).status).toBe(404);
  });

  it("a hand-over the assistant makes reads the same whatever it made of how the candidate sounded, and of an explicit ask", async () => {
    const ids: string[] = [];
    for (const [first, sentiment] of [["Hana", "frustrated"], ["Ivo", "fine"]] as const) {
      const who = await applyNow({ first, last: "Novak", email: `${first.toLowerCase()}@unsent.test` });
      ids.push(who.applicationId);
      await conversationStart(container, who.ref);
      container.fake!.scriptNext("screen.turn", { messageToCandidate: "I understand. A person from Unsent Dental will follow up with you.", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment, done: false, humanRequested: true });
      expect((await conversationTurn(container, who.ref, { message: `ZQXH ${first}: this is a lot, can someone call me instead` })).kind).toBe("reply");
      container.fake!.clearScripts();
      await container.drain();
      expect((await screenOf(who.applicationId)).status).toBe("human_requested");
      const [esc] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, who.applicationId));
      expect(esc.question).toContain(`(${HANDED_TO_A_PERSON})`);
    }
    // Today's request cards, the history and the recruiter requests: never how the assistant read them
    const seen = await teamSurfaces(ids);
    expect(seen.all).not.toMatch(/sounded|frustrated/);
    expect(seen.all).not.toContain("ZQXH");
    const mine = await get("/api/v1/escalations/mine");
    expect(mine.status).toBe(200);
    expect(mine.text).not.toMatch(/sounded|frustrated|ZQXH/);
  });

  it("the ITS operations console never shows what an unsent conversation said either", async () => {
    const ops = await signInAdmin(app, container, "ops@its.test", "Ops Admin");
    const runs = await get("/api/v1/admin/ai-runs", ops);
    expect(runs.status, runs.text.slice(0, 300)).toBe(200);
    for (const marker of ["ZQXP", "ZQXA", "ZQXL", "ZQXH"]) expect(runs.text, marker).not.toContain(marker);
    expect(runs.text).toContain("not shown here");
    // a sent conversation's runs are there as they were
    expect(runs.text).toContain("ZQXM-answer");
    const anaScreen = await screenOf(ana.applicationId);
    const run = await get<{ aiRuns: Array<{ structuredOutput: unknown }>; events: Array<{ type: string; payload: Record<string, unknown> }> }>(`/api/v1/admin/runs/${anaScreen.workflowRunId}`, ops);
    expect(run.status).toBe(200);
    expect(run.text).not.toContain("ZQXA");
    expect(run.body.aiRuns.length).toBeGreaterThan(0);
    expect(run.body.events.find((e) => e.type === "screen.declined_by_candidate")?.payload).not.toHaveProperty("answered");
  });

  it("the candidate's own copy of their data still has everything they said", async () => {
    for (const [who, marker] of [[priya, "ZQXP-typed"], [ana, "ZQXA-typed"]] as const) {
      const mine = JSON.stringify(await withTenant(container.db, companyId, (tx) => exportCandidateData(tx, companyId, who.candidateId)));
      expect(mine).toContain(marker);
    }
  });
});
