import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RolePacket } from "@ros/contracts";
import { ASSESSMENT_UNAVAILABLE_TEXT, CLOSER_LOOK_LABEL, RESUME_UNREADABLE_TEXT, anonymizeCandidate, buildEscalationContext, exportCandidateData } from "@ros/core";
import { TRIAGE_READINGS, composeInterviewerBrief } from "@ros/agents";
import { applications, assessments, auditRecords, candidates, events, screens, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { useLaterApplyFlow } from "./test-helpers";

type Finding = { claim: string; evidence: { source: string; quote?: string } };
type Evidence = { needsCloserLook: boolean; reason: string | null; assessmentUnavailable: boolean; resumeUnreadable: boolean; inconsistent: boolean; lowConfidence: boolean; hasProvenMiss: boolean; unknowns: string[]; unknownCount: number; topStrength: Finding | null; topConcern: Finding | null; confidenceReasons: string[] };
type Row = { id: string; stage: string; stageLabel: string; group: string; evidence: Evidence; assessment: { overall: string; summary: string } | null };
type Detail = { stage: string; allowedActions: string[]; assessments: Array<{ kind: string; overall: string; result: { recommendation: string; concerns: Finding[]; unknowns: Array<{ question: string }>; confidenceReasons?: string[] } }>; screens: Array<{ status: string; progress: { focusQuestions?: Array<{ key: string; question: string; answer?: string }> } }> };
type Note = { kind: string; title: string; body: string; action: { label: string; href: string } | null };

/**
 * What the owner sees about evidence (docs/spec/21 section 7, P1: "Insufficient evidence as an explicit state that
 * offers a one-click follow-up question"). An assessment that cannot say enough becomes "Needs a closer look" on the
 * Talent list, with what is missing in plain words; the notification says the same; "Ask about this in a screen" opens a
 * screen with those questions first; and the two failure branches (a résumé with no text, no usable assessment) are
 * said on the card, not only in the timeline.
 */
describe("Intelligence: insufficient evidence, the closer look, and the one-click follow-up", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let slug = "";
  let roleId = "";
  let elig: Array<{ key: string }> = [];

  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const form = (path: string, fields: Record<string, string>) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: "" }, body: new URLSearchParams(fields) });
  const eventsOf = async (type: string) => container.db.select().from(events).where(eq(events.type, type));
  const emailOutbox = () => (container.integrations.email as FakeEmailAdapter).sent;
  const fixtures = (name: string) => new Uint8Array(readFileSync(new URL(`../../../packages/agents/src/fixtures/${name}`, import.meta.url)));
  const list = async (query = "") => (await (await json("GET", `/api/v1/roles/${roleId}/applications${query}`)).json()) as Row[];
  const detail = async (id: string) => (await (await json("GET", `/api/v1/applications/${id}`)).json()) as Detail;
  const notes = async () => (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Note[];
  const screenOf = async (applicationId: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, applicationId))).sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))[0];

  async function apply(p: { first: string; last: string; email: string; resume?: string | File; noResume?: string }) {
    const fd = new FormData();
    fd.set("firstName", p.first); fd.set("lastName", p.last); fd.set("email", p.email);
    if (p.resume) fd.set("resume", typeof p.resume === "string" ? new File([p.resume], `${p.first.toLowerCase()}.txt`, { type: "text/plain" }) : p.resume);
    if (p.noResume) fd.set("noResume", p.noResume);
    for (const r of elig) fd.set(`elig_${r.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    const res = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    expect(res.status).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, p.email.toLowerCase()));
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id)));
    return a;
  }

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const { devLink } = (await (await json("POST", "/api/v1/auth/magic-link", { email: "dana@closerlook.test" })).json()) as { devLink: string };
    const consume = await json("POST", "/api/v1/auth/magic-link/consume", { token: new URL(devLink).searchParams.get("token") });
    cookie = consume.headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json("POST", "/api/v1/companies", { name: "Closer Look Dental", vertical: "dental", sizeBand: "20-49", ownerName: "Dana Whitfield", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    slug = co.slug;
    // The résumé reading decides what comes next here, so the role takes the later path (plan Wave E).
    await useLaterApplyFlow(container, co.id);
    const c1 = (await (await json("POST", "/api/v1/intake/conversation/messages", { message: "I need a dental hygienist in Irvine. Full time. $45 to $55 an hour. I need someone who can start within 30 days." })).json()) as { intakeSessionId: string };
    // The deal-breakers come before the must-haves so the fake intake keeps the must-have phrases clean (it reads a must-haves line to its end).
    await json("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/messages`, { message: "It's a replacement, our hygienist moved. Ceiling is $58. Interviewers: Dr. Chen and me. I decide. Deal-breakers: can't work Saturdays. Must-haves: active CA RDH license, perio experience." });
    const compiled = (await (await json("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/compile`)).json()) as { roleId: string };
    roleId = compiled.roleId;
    await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1 });
    await container.drain();
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { status: string; currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    expect(role.status).toBe("open");
    elig = role.currentPacket.packet.requirements.eligibility;
  });
  afterAll(async () => { await container.close(); });

  let taylorId = "";
  it("a résumé that never mentions the licence gets a concern and an unknown for that must-have, with the reasons for the confidence, on the list and the detail", async () => {
    const a = await apply({ first: "Taylor", last: "Brooks", email: "taylor@example.com", resume: "Taylor Brooks\nDental Hygienist at Harbor Dental 2019 - present\nPeriodontal charting and perio maintenance, Dentrix" });
    taylorId = a.id;
    const [asmt] = await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id));
    expect(asmt.kind).toBe("triage");
    // relevant work with thin evidence: "potential", still worth a screen (never "unknown" for a hygienist's résumé that says so)
    expect(asmt.overall).toBe("potential");
    expect(asmt.result.recommendation).toBe("screen");
    expect(a.stage).toBe("screen_invited");
    const concern = asmt.result.concerns.find((c) => /active CA RDH license/.test(c.claim))!;
    expect(concern).toBeTruthy();
    expect(concern.claim).toMatch(/^No evidence of active CA RDH license in the résumé$/);
    expect(concern.evidence.source).toBe("resume");
    expect(concern.evidence.quote).toBeUndefined(); // nothing to quote for an absence
    const unknown = asmt.result.unknowns.find((u) => /active CA RDH license/.test(u.question))!;
    expect(unknown.question).toBe("Can you tell me about your active CA RDH license?");
    expect(unknown.whyItMatters).toMatch(/must-have/);
    expect(asmt.result.confidenceReasons).toEqual(["one must-have has no evidence", "one must-have is only partly shown"]);
    // the Talent list: top strength, top concern, open questions, confidence reasons
    const row = (await list()).find((r) => r.id === a.id)!;
    expect(row.evidence.topConcern?.claim).toBe(concern.claim);
    expect(row.evidence.unknownCount).toBe(1);
    expect(row.evidence.unknowns).toEqual([unknown.question]);
    expect(row.evidence.confidenceReasons).toEqual(asmt.result.confidenceReasons);
    expect(row.evidence.needsCloserLook).toBe(false); // a screen is on its way; nobody is waiting on the owner
    expect(row.stageLabel).toBe("Invited to a screening chat");
    // no must-have shown in full: a low-confidence reading. That alone holds nothing (plan A8); it asks the reader to read it themselves
    expect(asmt.confidence).toBe("low");
    expect(row.evidence).toMatchObject({ lowConfidence: true, inconsistent: false });
    const d = await detail(a.id);
    expect(d.assessments[0].result.concerns.map((c) => c.claim)).toContain(concern.claim);
    expect(d.assessments[0].result.unknowns.map((u) => u.question)).toContain(unknown.question);
    expect(d.assessments[0].result.confidenceReasons).toEqual(asmt.result.confidenceReasons);
  });

  it("a résumé with the licence shows a strength with its evidence on the list", async () => {
    const a = await apply({ first: "Maria", last: "Reyes", email: "maria@example.com", resume: "Maria Reyes, RDH\nRegistered Dental Hygienist at Smile Bright Dental 2019 - present\nRDH license CA #RDH12345 active\nPeriodontal charting, perio maintenance, Dentrix" });
    const row = (await list()).find((r) => r.id === a.id)!;
    expect(row.evidence.topStrength?.claim).toMatch(/^Shows active CA RDH license/);
    expect(row.evidence.topStrength?.evidence.source).toBe("resume");
    expect(row.evidence.topConcern).toBeNull();
    expect(row.evidence.unknownCount).toBe(0);
    // "perio experience" can only ever be partly shown to the fake (it matches on "perio"); the reason says so instead of pretending certainty
    expect(row.evidence.confidenceReasons).toEqual(["one must-have is only partly shown"]);
    expect(row.evidence.lowConfidence).toBe(false);
    // the licence is shown, so the "Missing a must-have" filter does not catch her
    expect(row.evidence.hasProvenMiss).toBe(false);
  });

  let rileyId = "";
  it("insufficient evidence is an explicit state: waiting on you, labelled 'Needs a closer look', and the notification says what is missing", async () => {
    const a = await apply({ first: "Riley", last: "Quinn", email: "riley@example.com", resume: "Riley Quinn\nRetail associate at Bright Stores 2019 - present\nCustomer service and scheduling" });
    rileyId = a.id;
    expect(a.stage).toBe("triaged"); // the fake's overall=unknown now recommends review_manually, as the prompt rule says
    const [asmt] = await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id));
    expect(asmt.overall).toBe("unknown");
    expect(asmt.result.recommendation).toBe("review_manually");
    expect(asmt.result.unknowns).toHaveLength(2);
    expect(asmt.result.concerns).toHaveLength(2);
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, a.id))).toHaveLength(0);
    const row = (await list()).find((r) => r.id === a.id)!;
    expect(row.group).toBe("waiting_on_you");
    expect(row.stageLabel).toBe(CLOSER_LOOK_LABEL);
    expect(row.evidence.needsCloserLook).toBe(true);
    expect(row.evidence.assessmentUnavailable).toBe(false);
    expect(row.evidence.reason).toBe("Open questions: Can you tell me about your active CA RDH license? Can you tell me about your perio experience?");
    expect(row.evidence.unknownCount).toBe(2);
    // what the Talent page's filter chip counts: the rows that need a closer look, and only those
    expect((await list()).filter((r) => r.evidence.needsCloserLook).map((r) => r.id)).toEqual([a.id]);
    expect((await list("?group=waiting_on_you")).map((r) => r.id)).toContain(a.id);
    // the notification says what is missing, in plain words, and what to do about it
    const note = (await notes()).find((n) => n.kind === "application.needs_review" && /Riley Quinn/.test(n.title))!;
    expect(note.title).toBe("Riley Quinn needs a closer look");
    expect(note.body).toBe("Open questions: Can you tell me about your active CA RDH license? Can you tell me about your perio experience? Ask about it in a short screening chat, or review the application yourself.");
    expect(note.action).toEqual({ label: "Take a closer look", href: `/roles/${roleId}/talent?open=${a.id}` });
    // the capability list gains the one-click follow-up wherever the facts are loaded from the database
    const { applicationFacts, allowedApplicationActions } = await import("./services/application-actions");
    const facts = await withTenant(container.db, a.companyId, (tx) => applicationFacts(tx, a, "owner"));
    expect(facts.openUnknowns).toBe(2);
    expect(allowedApplicationActions(facts)).toEqual(expect.arrayContaining(["invite_screen", "ask_in_screen"]));
    const detailActions = (await detail(a.id)).allowedActions;
    expect(detailActions).toContain("invite_screen");
    expect(detailActions).toContain("ask_in_screen");
  });

  it("'Ask about this in a screen' invites them to a web screen that starts with the open questions, says so in the email and the opening, and keeps the answers beside the questions", async () => {
    const r = await json("POST", `/api/v1/applications/${rileyId}/actions`, { action: "ask_in_screen" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; workflowRunId: string; next?: string };
    expect(body.next).toMatch(/starts with the open questions/);
    await container.drain();
    const a = (await container.db.select().from(applications).where(eq(applications.id, rileyId)))[0];
    expect(a.stage).toBe("screen_invited");
    const scr = await screenOf(rileyId);
    expect(scr.status).toBe("invited");
    expect(scr.channel).toBe("web");
    expect(scr.progress.focusQuestions?.map((f) => f.key)).toEqual(["unknown_1", "unknown_2"]);
    expect(scr.progress.focusQuestions?.[0].question).toBe("Can you tell me about your active CA RDH license?");
    const invite = emailOutbox().find((m) => m.to === "riley@example.com" && /screening conversation/.test(m.subject))!;
    expect(invite.text).toContain(`/c/screen/${scr.token}`);
    expect(invite.text).toContain("a few quick questions about your background");
    expect(invite.text).toMatch(/8 questions/); // two open questions in front of the packet's six
    const invited = (await eventsOf("screen.invited")).find((e) => e.subjectId === scr.id)!;
    expect(invited.payload).toMatchObject({ focus: "unknowns", focusQuestions: 2, invitedBy: expect.any(String) });
    expect((await eventsOf("human.override")).some((e) => e.subjectId === rileyId && (e.payload as { action: string }).action === "ask_in_screen")).toBe(true);
    // a second click explains instead of sending twice
    expect((await json("POST", `/api/v1/applications/${rileyId}/actions`, { action: "ask_in_screen" })).status).toBe(409);
    // the candidate opens the screen: the fixed introduction (plan E2) with the sentence about the background questions;
    // Start then shows the first open question, in its own words
    const page = await app.request(`/c/screen/${scr.token}`);
    expect(page.status).toBe(200);
    const intro = await page.text();
    expect(intro).toMatch(/AI assistant/);
    expect(intro).toContain("a few quick questions about your background");
    expect(intro).toContain("8 short questions");
    expect((await form(`/c/screen/${scr.token}/start`, {})).status).toBe(302);
    let s = await screenOf(rileyId);
    expect(s.transcript[0].role).toBe("assistant");
    expect(s.transcript[0].content).toBe("Can you tell me about your active CA RDH license?");
    expect(s.transcript[0].questionKey).toBe("unknown_1");
    // the answers to the open questions sit beside them; the packet's own answers are counted separately
    expect((await form(`/c/screen/${scr.token}`, { message: "Yes, my RDH license is active in California, number RDH55555." })).status).toBe(302);
    s = await screenOf(rileyId);
    expect(s.progress.focusQuestions?.[0].answer).toBe("Yes, my RDH license is active in California, number RDH55555.");
    expect(s.answers).toEqual({});
    expect(s.progress.currentQuestionKey).toBe("unknown_2");
    expect((await form(`/c/screen/${scr.token}`, { message: "I have done perio charting and maintenance every day for six years." })).status).toBe(302);
    s = await screenOf(rileyId);
    expect(s.progress.focusQuestions?.[1].answer).toMatch(/perio charting/);
    expect(s.progress.currentQuestionKey).not.toMatch(/^unknown_/); // the packet's questions follow
    expect(Object.keys(s.answers)).toHaveLength(0);
    const d = await detail(rileyId);
    expect(d.screens[0].progress.focusQuestions?.map((f) => f.key)).toEqual(["unknown_1", "unknown_2"]);
    expect((await list()).find((r) => r.id === rileyId)!.evidence.needsCloserLook).toBe(false);
  });

  it("refuses the follow-up when the assessment left nothing to ask, and a plain invitation may still carry the focus option", async () => {
    // A refused policy change (for one, a sign-in older than the policy page accepts) would leave the invitation automatic and fail below as a wrong stage: assert it here, at the cause.
    expect((await json("PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "human_only", approverRoles: [] })).status).toBe(200);
    const a = await apply({ first: "Noor", last: "Haddad", email: "noor@example.com", resume: "Noor Haddad, RDH\nRegistered Dental Hygienist at Lakeside Dental 2016 - present\nRDH license CA active\nPerio charting, Open Dental" });
    expect(a.stage).toBe("triaged");
    const refused = await json("POST", `/api/v1/applications/${a.id}/actions`, { action: "ask_in_screen" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("nothing_to_ask");
    const ok = await json("POST", `/api/v1/applications/${a.id}/actions`, { action: "invite_screen", focus: "unknowns" });
    expect(ok.status).toBe(200);
    await container.drain();
    const scr = await screenOf(a.id);
    expect(scr.progress.focusQuestions ?? []).toEqual([]);
    expect(emailOutbox().find((m) => m.to === "noor@example.com" && /screening conversation/.test(m.subject))!.text).not.toContain("a few quick questions about your background");
    expect((await json("PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "auto_notify", approverRoles: [] })).status).toBe(200);
  });

  it("a clean résumé file with no text (a scan) is said on the card and in the notification, not only in the timeline", async () => {
    const a = await apply({ first: "Sam", last: "Okafor", email: "sam@example.com", resume: new File([fixtures("scanned.pdf")], "scan.pdf", { type: "application/pdf" }) });
    expect((await eventsOf("resume.extraction_failed")).some((e) => e.subjectId === a.id)).toBe(true);
    expect(a.extraction).toBeNull();
    expect(a.stage).toBe("triaged");
    const [asmt] = await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id));
    expect(asmt.overall).toBe("unknown");
    expect(asmt.result.recommendation).toBe("review_manually");
    expect(asmt.result.confidenceReasons).toContain("no résumé text and no written summary to assess");
    const row = (await list()).find((r) => r.id === a.id)!;
    expect(row.evidence.resumeUnreadable).toBe(true);
    expect(row.evidence.needsCloserLook).toBe(true);
    expect(row.stageLabel).toBe(CLOSER_LOOK_LABEL);
    expect(row.evidence.reason).toContain(RESUME_UNREADABLE_TEXT);
    const note = (await notes()).find((n) => n.kind === "application.needs_review" && /Sam Okafor/.test(n.title))!;
    expect(note.title).toBe("Sam Okafor needs a closer look");
    expect(note.body).toContain(RESUME_UNREADABLE_TEXT);
    expect(note.body).toMatch(/Not enough to assess automatically/);
    expect(note.body).toMatch(/Ask about it in a short screening chat, or review the application yourself\.$/);
    // the detail carries what the page derives the same sentence from: a clean résumé document without text
    const d = (await (await json("GET", `/api/v1/applications/${a.id}`)).json()) as { documents: Array<{ kind: string; status: string; hasText: boolean }>; extraction: unknown };
    expect(d.documents.find((x) => x.kind === "resume")).toMatchObject({ status: "clean", hasText: false });
    expect(d.extraction).toBeNull();
  });

  it("when the assessment is unusable twice the owner is told to review, on the card and by notification, and nothing is hidden", async () => {
    // every reading (TRIAGE_READINGS of them, each with the runner's one retry) unusable: one usable reading would do
    for (let i = 0; i < TRIAGE_READINGS * 2; i++) container.fake!.failNext("triage.assess", "invalid");
    const a = await apply({ first: "Casey", last: "Morgan", email: "casey@example.com", resume: "Casey Morgan, RDH\nRegistered Dental Hygienist at Coastal Dental 2018 - present\nRDH license CA active\nPerio charting, Eaglesoft" });
    expect(a.stage).toBe("triaged");
    expect(a.latestAssessmentId).toBeNull();
    expect(await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).toHaveLength(0);
    expect((await eventsOf("ai.output_invalid")).filter((e) => e.subjectId === a.id)).toHaveLength(1);
    const row = (await list()).find((r) => r.id === a.id)!;
    expect(row.assessment).toBeNull();
    expect(row.evidence.assessmentUnavailable).toBe(true);
    expect(row.evidence.needsCloserLook).toBe(true);
    expect(row.group).toBe("waiting_on_you");
    expect(row.stageLabel).toBe(CLOSER_LOOK_LABEL);
    expect(row.evidence.reason).toBe(ASSESSMENT_UNAVAILABLE_TEXT);
    const note = (await notes()).find((n) => n.kind === "application.assessment_unavailable")!;
    expect(note.title).toBe("We could not assess Casey Morgan automatically; please review");
    expect(note.body).toContain(ASSESSMENT_UNAVAILABLE_TEXT);
    expect(note.body).toMatch(/Nothing is hidden/);
    expect(note.action).toEqual({ label: "Review", href: `/roles/${roleId}/talent?open=${a.id}` });
    const d = await detail(a.id);
    expect(d.assessments).toHaveLength(0);
    expect(d.allowedActions).toEqual(expect.arrayContaining(["invite_screen", "interview", "reject"]));
    container.fake!.clearScripts();
    void taylorId;
  });

  it("a reading that disagrees with its own must-have findings holds the screen for a person, with the reason (plan A8)", async () => {
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: RolePacket } };
    const licence = role.currentPacket.packet.requirements.mustHaves.find((m) => /licen/i.test(m.text))!;
    // said plainly: under the licence rule (15 Oct 2026) only that is a "no"; a lapsed licence would be "not known yet"
    const lapsed = "I do not hold a CA RDH license";
    // a Potential reading whose own finding, quoted from the résumé, says the licence must-have is not met (every one of
    // the TRIAGE_READINGS readings, so the middle answer is the same)
    for (let i = 0; i < TRIAGE_READINGS; i++) container.fake!.scriptNext("triage.assess", { overall: "potential", confidence: "medium", confidenceReasons: [], summary: "Relevant hygiene work; no licence.", strengths: [{ claim: "Works as a dental hygienist", evidence: { source: "resume", quote: "Dental Hygienist at Harbor Dental 2016 - present" } }], concerns: [], unknowns: [], competencyFindings: [], requirementFindings: [{ requirementKey: licence.key, met: "no", evidence: { source: "resume", quote: lapsed } }], anomalies: [], recommendation: "screen", rationale: "Scripted for the consistency check." });
    const a = await apply({ first: "Uma", last: "Patel", email: "uma@example.com", resume: `Uma Patel\nDental Hygienist at Harbor Dental 2016 - present\n${lapsed}\nPeriodontal charting, Dentrix` });
    container.fake!.clearScripts();
    expect(a.stage).toBe("triaged");
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, a.id))).toHaveLength(0);
    expect(emailOutbox().filter((m) => m.to === "uma@example.com" && /screening conversation/.test(m.subject))).toHaveLength(0);
    const note = (await notes()).find((n) => n.kind === "application.needs_review" && /Uma Patel/.test(n.title))!;
    expect(note.title).toBe("Uma Patel needs a closer look");
    expect(note.body).toContain(`a must-have is not met (${licence.text}): "${lapsed}"`);
    expect(note.body).toMatch(/No screening invitation was sent\.$/);
    const flagged = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "assessment.flagged"));
    expect(flagged.some((r) => (r.target as { id: string } | null)?.id === a.id && (r.details as { held: string }).held === "application.invite_screen")).toBe(true);
    // the list says the same, read off the same assessment
    const row = (await list()).find((r) => r.id === a.id)!;
    expect(row.group).toBe("waiting_on_you");
    expect(row.stageLabel).toBe(CLOSER_LOOK_LABEL);
    // and the 'Missing a must-have' filter catches her, on the same checked quote (plan A3)
    expect(row.evidence).toMatchObject({ needsCloserLook: true, inconsistent: true, lowConfidence: false, hasProvenMiss: true });
    expect(row.evidence.reason).toContain(`"${lapsed}"`);
  });

  it("the answers to the open questions are what a person reads, what an access request exports, and what an anonymization removes", async () => {
    const a = (await container.db.select().from(applications).where(eq(applications.id, rileyId)))[0];
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: RolePacket } };
    const packet = role.currentPacket.packet;
    const licence = "Can you tell me about your active CA RDH license?";
    // while the conversation is still under way, nobody on the team or at ITS reads them (founder decision of
    // 9 October 2026, "hide them until they send"; an emailed conversation is sent when it ends normally)
    const open = await withTenant(container.db, a.companyId, async (tx) => ({
      ctx: await buildEscalationContext(tx, a.companyId, roleId, rileyId),
      brief: await composeInterviewerBrief(tx, { applicationId: rileyId, candidateFirstName: "Riley", packet, roundKey: packet.interviews.plan[0].key }),
    }));
    expect((await screenOf(rileyId)).status).toBe("in_progress");
    expect(JSON.stringify(open)).not.toContain("RDH55555");
    expect((open.ctx.screens as Array<{ answersShared: boolean }>)[0].answersShared).toBe(false);
    const d = await detail(rileyId);
    expect(JSON.stringify(d)).not.toContain("RDH55555");
    expect(d.screens[0].progress.focusQuestions?.map((f) => f.key)).toEqual(["unknown_1", "unknown_2"]);
    // the conversation ends normally (set directly here; the flow itself is tested with the screening suites)
    await container.db.update(screens).set({ status: "completed", completedAt: new Date().toISOString() }).where(eq(screens.applicationId, rileyId));
    // what a person reads: the recruiter's context and the interviewer's brief carry the answers, the brief with the questions in the words they were asked
    const ctx = await withTenant(container.db, a.companyId, (tx) => buildEscalationContext(tx, a.companyId, roleId, rileyId));
    expect((ctx.screens as Array<{ answers: Record<string, string> }>)[0].answers.unknown_1).toMatch(/RDH55555/);
    const brief = await withTenant(container.db, a.companyId, (tx) => composeInterviewerBrief(tx, { applicationId: rileyId, candidateFirstName: "Riley", packet, roundKey: packet.interviews.plan[0].key }));
    expect(brief?.screen?.answers.find((x) => x.question === licence)?.answer).toMatch(/RDH55555/);
    // what an access request exports: every answer, and the opening questions so the keys mean something
    const bundle = await withTenant(container.db, a.companyId, (tx) => exportCandidateData(tx, a.companyId, a.candidateId));
    const exported = (bundle.screens as Array<{ answers: Record<string, string>; openingQuestions: Array<{ key: string; question: string }> }>)[0];
    expect(exported.answers.unknown_1).toMatch(/RDH55555/);
    expect(exported.openingQuestions).toEqual([{ key: "unknown_1", question: licence }, { key: "unknown_2", question: "Can you tell me about your perio experience?" }]);
    // what an anonymization removes: the answers go with the transcript; the questions (the assistant's words) stay
    await withTenant(container.db, a.companyId, (tx) => anonymizeCandidate(tx, { companyId: a.companyId, candidateId: a.candidateId, actor: { kind: "system", id: "intelligence.test" }, deleteFile: async () => undefined }));
    const s = await screenOf(rileyId);
    expect(s.transcript).toEqual([]);
    expect(s.answers).toEqual({});
    expect(s.progress.focusQuestions?.map((f) => f.key)).toEqual(["unknown_1", "unknown_2"]);
    expect(s.progress.focusQuestions?.some((f) => "answer" in f)).toBe(false);
    expect(JSON.stringify(s)).not.toContain("RDH55555");
  });
});
