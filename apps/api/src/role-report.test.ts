import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, gte, inArray } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { createApplicationLink, entitlements, findPostingLink, ownerGroup } from "@ros/core";
import { applications, approvalRequests, assessments, auditRecords, communications, events, interviews, postings, recruiterEscalations, users, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { localDays } from "@ros/workflows";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { createApplication } from "./services/applications";
import { APPLICANT_COLUMNS, composeRoleReport, summaryRows, toCsv, type ReportData, type RoleReport } from "./services/role-report";
import { signInAdmin, signInAs, signInStaff } from "./test-helpers";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * The role report (docs/spec/21 section 7, P1; findings G1 to G15 and J18): one role with applicants from several
 * sources, a held and an overridden applicant, a decline whose message could not be sent, interviews in every state,
 * recruiter requests, a recorded hire. Every figure is asserted, then the two CSV files, the refusals, the
 * administrator's aggregate over the customer's roles, and (J18) that the roles list, the role page and the brief
 * quote the same numbers as the report.
 */
describe("role report", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerActor: Actor;
  let recruiterA = "";
  let recruiterB = "";
  let admin = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  let role2Id = "";
  let eligibility: Array<{ key: string; type: string }> = [];
  let eligibility2: Array<{ key: string; type: string }> = [];
  let licenseKey = "";
  const ids: Record<string, string> = {};
  let report: RoleReport;

  const BASE = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return d.getTime(); })();
  const setClock = (offsetMs: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offsetMs); };
  const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();
  const fake = () => container.integrations.email as FakeEmailAdapter;
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "report test" }, body: body ? JSON.stringify(body) : undefined });
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const seedRole = async (message: string) => {
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: message })).json()) as { session: { id: string } };
    const id = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${id}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    const role = (await (await json(owner, "GET", `/api/v1/roles/${id}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string; type: string }> } } } };
    return { id, eligibility: role.currentPacket.packet.requirements.eligibility };
  };
  /** The apply form as a browser posts it; a knockout answered "no" holds the applicant for a person. */
  const applyForm = (fields: Record<string, string>, elig = eligibility, knockoutNo = false) => {
    const fd = new FormData();
    const base: Record<string, string> = { locationText: "Irvine, CA", noResume: "Registered Dental Hygienist at Coastal Family Dentistry since 2019; active CA RDH license; Dentrix.", noticeVersionsShown: "ai_use@2026-09-01,privacy@2026-09-01", acknowledged: "yes" };
    for (const r of elig) base[`elig_${r.key}`] = knockoutNo && r.key === licenseKey ? "no" : "yes";
    for (const [k, v] of Object.entries({ ...base, ...fields })) fd.set(k, v);
    return fd;
  };
  const apply = async (first: string, last: string, email: string, opts: { cookie?: string; knockoutNo?: boolean; role?: string } = {}) => {
    const target = opts.role ?? roleId;
    const fd = applyForm({ firstName: first, lastName: last, email }, target === roleId ? eligibility : eligibility2, opts.knockoutNo);
    const r = await app.request(`/careers/${slug}/jobs/${target}/apply`, { method: "POST", body: fd, headers: opts.cookie ? { cookie: opts.cookie } : {} });
    expect(r.status, `${first} ${last}`).toBe(302);
    await container.drain();
    const rows = await container.db.select().from(applications).where(eq(applications.roleId, target));
    const known = new Set(Object.values(ids));
    return rows.find((a) => !known.has(a.id))!.id;
  };
  const cookieFromLink = async (token: string) => {
    const visit = await app.request(`/a/${token}`);
    expect(visit.status).toBe(302);
    const sealed = (visit.headers.get("set-cookie") ?? "").match(/ros_src=([^;]+)/)?.[1] ?? "";
    expect(sealed).toBeTruthy();
    return `ros_src=${sealed}`;
  };
  const roleApps = () => container.db.select().from(applications).where(eq(applications.roleId, roleId));
  const groupCounts = (rows: Array<{ stage: string }>) => {
    const out: Record<string, number> = { waiting_on_you: 0, in_process: 0, not_moving_forward: 0, hired: 0 };
    for (const a of rows) out[ownerGroup(a.stage as never)] += 1;
    return out;
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test", ITS_QUEUE_EMAIL: "queue@its.test" } });
    app = createApp(container);
    setClock(0);
    owner = await signIn("owner@ledger.test");
    const [user] = await container.db.select().from(users).where(eq(users.email, "owner@ledger.test"));
    ownerActor = { kind: "user", id: user.id, name: "Owner Olivia" };
    recruiterA = await signInStaff(app, container, "sam@its.test", "its_recruiter", "Sam");
    recruiterB = await signInStaff(app, container, "kim@its.test", "its_recruiter", "Kim");
    admin = await signInAdmin(app, container, "admin@its.test", "admin");
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Ledger Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    slug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const r1 = await seedRole("I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.");
    roleId = r1.id;
    eligibility = r1.eligibility;
    licenseKey = eligibility.find((e) => e.type === "license")!.key;
    const r2 = await seedRole("I need a front office coordinator in Irvine, $22 to $26 an hour, full time. It's growth. Ceiling $27. I decide. Must-haves: front-desk experience. Just draft it.");
    role2Id = r2.id;
    eligibility2 = r2.eligibility;

    // Eight applicants for the first role, from four sources.
    ids.ana = await apply("Ana", "Lopez", "ana.lopez@example.com");
    const referral = await withTenant(container.db, companyId, (tx) => createApplicationLink(tx, { companyId, roleId, source: "referral", sourceDetail: "Dr. Patel", label: "Referral: Dr. Patel", actor: ownerActor, now: container.engine.clock() }));
    ids.ben = await apply("Ben", "Osei", "ben.osei@example.com", { cookie: await cookieFromLink(referral.token) });
    const [indeed] = await container.db.select().from(postings).where(and(eq(postings.roleId, roleId), eq(postings.channel, "indeed")));
    const board = (await findPostingLink(container.db, indeed.id))!;
    ids.cara = await apply("Cara", "Diaz", "cara.diaz@example.com", { cookie: await cookieFromLink(board.token) });
    const dev = await withTenant(container.db, companyId, (tx) => createApplication(tx, container, { companyId, roleId, source: "linkedin", sourceDetail: "LinkedIn campaign", firstName: "Dev", lastName: "Patel", email: "dev.patel@example.com", phone: null, smsConsent: false, consentSource: "manual_add", noticeVersionsShown: ["privacy@2026-09-01"], eligibilityAnswers: {}, noResumeAnswers: { summary: "Hygienist at Harbor Dental since 2020; CA RDH license." } }, ownerActor));
    ids.dev = dev.application.id;
    await container.drain();
    ids.eve = await apply("Eve", "Kim", "eve.kim@example.com", { knockoutNo: true });
    ids.finn = await apply("Finn", "Ola", "finn.ola@example.com", { knockoutNo: true });
    ids.gia = await apply("Gia", "Ruiz", "gia.ruiz@example.com");
    ids.hal = await apply("Hal", "Ng", "hal.ng@example.com");
    // and one for the second role, so the administrator's aggregate has something to add up
    ids.ivy = await apply("Ivy", "Chen", "ivy.chen@example.com", { role: role2Id });

    // People decide: Eve's eligibility answer is overridden, Ben goes to interview, Ana is held and her assessment flagged, Hal is hired.
    expect((await json(owner, "POST", `/api/v1/applications/${ids.eve}/actions`, { action: "override_eligibility", note: "She sits the exam next week." })).status).toBe(200);
    // the held application's review timer notices the override when it fires (as in app.test.ts): a day passes
    setClock(25 * HOUR);
    await container.drain();
    setClock(0);
    expect((await json(owner, "POST", `/api/v1/applications/${ids.ben}/actions`, { action: "advance_to_interview", note: "Strong referral." })).status).toBe(200);
    expect((await json(owner, "POST", `/api/v1/applications/${ids.ana}/actions`, { action: "hold", note: "Waiting on her reply." })).status).toBe(200);
    const anaDetail = (await (await json(owner, "GET", `/api/v1/applications/${ids.ana}`)).json()) as { assessments: Array<{ id: string }> };
    expect(anaDetail.assessments.length).toBeGreaterThan(0);
    expect((await json(owner, "POST", `/api/v1/applications/${ids.ana}/assessments/${anaDetail.assessments[0].id}/flag`, { kind: "wrong_evidence", note: "Quoted the wrong employer." })).status).toBe(200);
    expect((await json(owner, "POST", `/api/v1/applications/${ids.hal}/outcome`, { outcome: "hired_externally", confirm: true, hireDate: "2026-10-05" })).status).toBe(201);

    // Interviews in every state (the rows a scheduling loop would leave behind). Each row is created at its own time, in the
    // order a real loop makes them (the first round before the final conversation): one bulk insert would give every row the
    // same created_at, and the report lists rounds in the order they were first created.
    const packet = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { interviews: { plan: Array<{ key: string; title: string; format: string; durationMinutes: number }> } } } };
    const round = packet.currentPacket.packet.interviews.plan[0] ?? { key: "r1", title: "Working interview", format: "onsite", durationMinutes: 45 };
    const iv = (applicationId: string, status: string, extra: Partial<typeof interviews.$inferInsert> = {}) => ({ companyId, applicationId, roundKey: round.key, title: round.title, format: round.format, durationMinutes: round.durationMinutes, status, timezone: "America/Los_Angeles", createdBy: ownerActor, ...extra });
    await withTenant(container.db, companyId, (tx) => tx.insert(interviews).values([
      iv(ids.ana, "completed", { decision: "next_round", createdAt: at(0) }),
      iv(ids.ben, "no_show", { createdAt: at(HOUR) }),
      iv(ids.cara, "cancelled", { rescheduleCountCandidate: 1, cancelReason: "cancelled by the candidate", createdAt: at(2 * HOUR) }),
      iv(ids.dev, "proposed", { createdAt: at(3 * HOUR) }),
      iv(ids.ana, "scheduled", { roundKey: "final", title: "Final conversation", startsAt: at(2 * DAY), endsAt: at(2 * DAY + HOUR), createdAt: at(4 * HOUR) }),
    ]));

    // Recruiter help: one request resolved, one still open and past its promised time, one picked up and in progress.
    const e1 = (await (await json(owner, "POST", "/api/v1/escalations", { kind: "review", roleId, question: "Can you look at our shortlist?" })).json()) as { id: string };
    expect((await json(recruiterA, "POST", `/api/v1/escalations/${e1.id}/claim`)).status).toBe(200);
    expect((await json(recruiterA, "POST", `/api/v1/escalations/${e1.id}/resolve`, { resolution: "The shortlist looks right; interview the top two.", minutesSpent: 20 })).status).toBe(200);
    const e2 = (await (await json(owner, "POST", "/api/v1/escalations", { kind: "ask", roleId, question: "What should we pay for evenings?" })).json()) as { id: string };
    const e3 = (await (await json(owner, "POST", "/api/v1/escalations", { kind: "review", roleId, applicationId: ids.ana, question: "Is Ana worth a working interview?" })).json()) as { id: string };
    expect((await json(recruiterB, "POST", `/api/v1/escalations/${e3.id}/claim`)).status).toBe(200);
    // response times the report can be checked against: two hours and four hours (median three)
    await container.db.update(recruiterEscalations).set({ createdAt: at(-10 * HOUR), firstResponseAt: at(-8 * HOUR), slaDueAt: at(DAY) }).where(eq(recruiterEscalations.id, e1.id));
    await container.db.update(recruiterEscalations).set({ createdAt: at(-5 * HOUR), slaDueAt: at(-HOUR) }).where(eq(recruiterEscalations.id, e2.id));
    await container.db.update(recruiterEscalations).set({ createdAt: at(-6 * HOUR), firstResponseAt: at(-2 * HOUR), slaDueAt: at(DAY) }).where(eq(recruiterEscalations.id, e3.id));

    // Gia is declined while the email provider is down for good: the decline is retried by the outbox and ends failed.
    fake().failNext(20);
    const declined = await json(owner, "POST", `/api/v1/applications/${ids.gia}/actions`, { action: "reject", reason: "not_a_match_experience", note: "Wants weekends off." });
    expect(declined.status).toBe(200);
    for (let i = 1; i <= 10; i++) { setClock(i * 70_000); await container.drain(); }
    fake().failNext(0);
    setClock(0);
    const giaMessages = await container.db.select().from(communications).where(and(eq(communications.applicationId, ids.gia), eq(communications.templateKey, "disposition:human")));
    expect(giaMessages.map((m) => m.status)).toEqual(["failed"]);

    // Eve has been waiting on the owner for three days.
    await container.db.update(applications).set({ stageChangedAt: at(-3 * DAY) }).where(eq(applications.id, ids.eve));
    const r = await json(owner, "GET", `/api/v1/roles/${roleId}/report`);
    expect(r.status).toBe(200);
    report = (await r.json()) as RoleReport;
  });
  afterAll(async () => {
    await container.close();
  });

  it("names the role and counts applicants by source (careers page, a referral link, a board's link, a manual add) and by day in the company's time zone", async () => {
    expect(report.role).toMatchObject({ id: roleId, status: "open", daysOpen: 0 });
    expect(report.role!.title).toBeTruthy();
    expect(report.applicants.total).toBe(8);
    expect(report.applicants.bySource).toEqual([
      { source: "careers_page", label: "Careers page", sourceDetail: null, count: 5 },
      { source: "linkedin", label: "LinkedIn", sourceDetail: "LinkedIn campaign", count: 1 },
      { source: "indeed", label: "Indeed", sourceDetail: null, count: 1 },
      { source: "referral", label: "Referral", sourceDetail: "Dr. Patel", count: 1 },
    ]);
    expect(report.applicants.timeZone).toBe("America/Los_Angeles");
    expect(report.applicants.byDay).toHaveLength(30);
    const local = localDays(new Date(BASE), "America/Los_Angeles");
    expect(report.applicants.byDay.map((d) => d.day)).toEqual(Array.from({ length: 30 }, (_, i) => local.key(local.start(i - 29))));
    const keys = new Set(report.applicants.byDay.map((d) => d.day));
    const expectedInWindow = (await roleApps()).filter((a) => keys.has(local.key(new Date(a.createdAt)))).length;
    expect(report.applicants.last30Days).toBe(expectedInWindow);
    expect(report.applicants.byDay.reduce((n, d) => n + d.count, 0)).toBe(expectedInWindow);
  });

  it("counts every stage with its plain label and the four owner groups, exactly as the applications stand", async () => {
    const rows = await roleApps();
    expect(report.stages.total).toBe(8);
    expect(report.stages.byGroup).toEqual(groupCounts(rows));
    const byStage: Record<string, number> = {};
    for (const a of rows) byStage[a.stage] = (byStage[a.stage] ?? 0) + 1;
    expect(Object.fromEntries(report.stages.byStage.map((s) => [s.stage, s.count]))).toEqual(byStage);
    for (const s of report.stages.byStage) expect(s).toMatchObject({ label: expect.any(String), group: ownerGroup(s.stage as never) });
    // the people decided on are where they should be
    const stageOf = (id: string) => rows.find((a) => a.id === id)!.stage;
    expect(stageOf(ids.hal)).toBe("hired");
    expect(stageOf(ids.gia)).toBe("rejected");
    expect(stageOf(ids.finn)).toBe("ineligible");
    expect(stageOf(ids.eve)).toBe("triaged");
    expect(stageOf(ids.ben)).toBe("interview_recommended");
  });

  it("measures time in stage from the stage-change history and the wait of the people on the owner right now", async () => {
    const rows = await roleApps();
    const leftApplied = (await container.db.select().from(events).where(and(eq(events.type, "application.stage_changed"), inArray(events.subjectId, rows.map((a) => a.id))))).filter((e) => (e.payload as { from?: string }).from === "applied").length;
    expect(leftApplied).toBe(8);
    const applied = report.timeInStage.byStage.find((s) => s.stage === "applied")!;
    expect(applied).toMatchObject({ completed: 8, medianDays: 0, averageDays: 0, nowHere: 0, longestDays: null });
    for (const s of report.stages.byStage) expect(report.timeInStage.byStage.find((t) => t.stage === s.stage)?.nowHere, s.stage).toBe(s.count);
    expect(report.timeInStage.waitingOnYou.count).toBe(report.stages.byGroup.waiting_on_you);
    expect(report.timeInStage.waitingOnYou.longestDays).toBe(3);
    expect(report.timeInStage.byStage.find((s) => s.stage === "triaged")!.longestDays).toBe(3);
  });

  it("counts interviews by state and by round", () => {
    expect(report.interviews).toMatchObject({ total: 5, requested: 1, scheduled: 1, completed: 1, noShow: 1, cancelled: 1, offerExpired: 0, rescheduledByCandidate: 1, awaitingDecision: 1 });
    expect(report.interviews.byRound).toHaveLength(2);
    expect(report.interviews.byRound[0]).toMatchObject({ total: 4, scheduled: 0, completed: 1, noShow: 1, cancelled: 1 });
    expect(report.interviews.byRound[0].roundKey).not.toBe("final");
    expect(report.interviews.byRound[1]).toMatchObject({ roundKey: "final", title: "Final conversation", total: 1, scheduled: 1, completed: 0, noShow: 0, cancelled: 0 });
  });

  it("lists the decisions only a person can make, oldest first, and agrees with the roles list", async () => {
    const rows = await roleApps();
    const waiting = rows.filter((a) => ownerGroup(a.stage) === "waiting_on_you" || a.stage === "ineligible");
    const pending = await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, roleId), eq(approvalRequests.status, "pending")));
    const waitingIds = new Set(waiting.map((a) => a.id));
    expect(report.pendingDecisions.candidates).toBe(waiting.length);
    expect(report.pendingDecisions.approvals).toBe(pending.length);
    expect(report.pendingDecisions.count).toBe(waiting.length + pending.filter((p) => !p.applicationId || !waitingIds.has(p.applicationId)).length);
    expect(report.pendingDecisions.oldestDays).toBe(3);
    expect(report.pendingDecisions.list[0]).toEqual({ kind: "candidate", label: "Ready for your review", days: 3, applicationId: ids.eve, approvalRequestId: null });
    expect(report.pendingDecisions.list.length).toBeLessThanOrEqual(5);
    expect(report.pendingDecisions.list.some((p) => p.applicationId === ids.finn && p.label === "Doesn't meet eligibility")).toBe(true);
    // J18: the roles list's "needs you" is the same pending-approval count
    const list = (await (await json(owner, "GET", "/api/v1/roles")).json()) as Array<{ id: string; needsYou: number }>;
    expect(list.find((r) => r.id === roleId)!.needsYou).toBe(report.pendingDecisions.approvals);
  });

  it("pairs the assistant's suggestion with the first decision a person made afterwards", async () => {
    const rows = await roleApps();
    const latest = rows.map((a) => a.latestAssessmentId).filter((x): x is string => !!x);
    const asmts = await container.db.select().from(assessments).where(inArray(assessments.id, latest));
    expect(report.recommendationsVsDecisions.assessed).toBe(latest.length);
    expect(latest.length).toBeGreaterThanOrEqual(6);
    const expectedTotals: Record<string, number> = {};
    for (const a of asmts) expectedTotals[a.result.recommendation] = (expectedTotals[a.result.recommendation] ?? 0) + 1;
    expect(Object.fromEntries(report.recommendationsVsDecisions.rows.map((r) => [r.recommendation, r.total]))).toEqual(expectedTotals);
    const sum = (k: "invited" | "interviewed" | "declined" | "held" | "noActionYet") => report.recommendationsVsDecisions.rows.reduce((n, r) => n + r[k], 0);
    // Ben went to interview, Ana was held, Gia was declined; Eve's override came before her assessment and Hal's outcome is not a decision about the suggestion
    expect({ invited: sum("invited"), interviewed: sum("interviewed"), declined: sum("declined"), held: sum("held") }).toEqual({ invited: 0, interviewed: 1, declined: 1, held: 1 });
    expect(sum("noActionYet")).toBe(latest.length - 3);
    for (const r of report.recommendationsVsDecisions.rows) {
      expect(r.label).not.toMatch(/_/);
      expect(r.invited + r.interviewed + r.declined + r.held + r.noActionYet).toBe(r.total);
    }
  });

  it("counts the times a person overruled the system", () => {
    expect(report.overrides).toMatchObject({ eligibilityOverrides: 1, reviewAnyway: 0, holds: 1, flaggedAssessments: 1 });
    expect(report.overrides.byAction).toMatchObject({ override_eligibility: 1, hold: 1, flag_assessment: 1, reject: 1, advance_to_interview: 1, outcome: 1 });
  });

  it("counts recruiter requests: open, resolved, past the promised time, and the typical first response", () => {
    expect(report.escalations).toEqual({ total: 3, open: 2, resolved: 1, overdue: 1, medianResponseHours: 3 });
  });

  it("counts messages from the outbox's own statuses and names how many candidates could not be reached", async () => {
    const rows = await roleApps();
    const msgs = await container.db.select().from(communications).where(and(eq(communications.direction, "outbound"), inArray(communications.applicationId, rows.map((a) => a.id))));
    const n = (statuses: string[]) => msgs.filter((m) => statuses.includes(m.status)).length;
    expect(report.messages).toEqual({ total: msgs.length, sent: n(["sent", "delivered"]), failed: n(["failed", "complained"]), bounced: n(["bounced"]), unknown: n(["unknown"]), pending: n(["queued", "sending"]), candidatesAffected: 1 });
    expect(report.messages.failed).toBe(1);
    expect(report.messages.sent).toBeGreaterThanOrEqual(8);
  });

  it("counts the outcomes people recorded and why candidates were declined, under the statement that offers happen outside the platform", () => {
    expect(report.outcomes).toMatchObject({ hired: 1, withdrew: 0, declinedByEmployer: 0, declinedOffer: 0, noHire: 0, talentPool: 0, corrections: 0, role: null, rolesByOutcome: {} });
    expect(report.outcomes.declineReasons).toEqual([{ reason: "not_a_match_experience", label: "Experience not a match", count: 1 }]);
    expect(report.outcomes.statement).toMatch(/outside Recruiting OS/);
    // no candidate is named in the JSON ("Dr. Patel" is the referral link's own label, which the owner wrote)
    expect(JSON.stringify(report)).not.toMatch(/Lopez|Osei|Diaz|Dev Patel|Ruiz|Eve Kim|Finn|Hal Ng/);
  });

  it("J18: the role page, the roles list and the brief quote the same numbers as the report", async () => {
    const detail = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { counts: Record<string, number> };
    expect(Object.values(detail.counts).reduce((a, b) => a + b, 0)).toBe(8);
    for (const s of report.stages.byStage) expect(detail.counts[s.stage], s.stage).toBe(s.count);
    const list = (await (await json(owner, "GET", "/api/v1/roles")).json()) as Array<{ id: string; counts: Record<string, number> }>;
    const mine = list.find((r) => r.id === roleId)!;
    expect(mine.counts.total).toBe(8);
    for (const g of ["waiting_on_you", "in_process", "not_moving_forward", "hired"] as const) expect(mine.counts[g] ?? 0, g).toBe(report.stages.byGroup[g]);
    // the brief's four numbers, from the same facts
    const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { summary: string; cards: Array<{ kind: string }> };
    const m = brief.summary.match(/^(\d+) things? needs? you · (\d+) strong candidates? ready · (\d+) at risk · (\d+) handled for you since yesterday\.$/);
    expect(m, brief.summary).toBeTruthy();
    const pendingAll = await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.status, "pending")));
    let needsMe = pendingAll.length;
    for (const rid of [roleId, role2Id]) {
      const rows = await container.db.select().from(applications).where(eq(applications.roleId, rid));
      if (rows.some((a) => ownerGroup(a.stage) === "waiting_on_you" || a.stage === "eligible")) needsMe += 1;
      if (rows.some((a) => a.stage === "ineligible")) needsMe += 1;
    }
    expect(Number(m![1])).toBe(needsMe);
    const strongIds = new Set((await container.db.select().from(assessments).where(and(eq(assessments.companyId, companyId), eq(assessments.overall, "strong")))).map((a) => a.applicationId));
    const strong = (await container.db.select().from(applications).where(eq(applications.companyId, companyId))).filter((a) => strongIds.has(a.id) && ownerGroup(a.stage) === "waiting_on_you").length;
    expect(Number(m![2])).toBe(strong);
    expect(Number(m![3])).toBe(brief.cards.filter((c) => c.kind === "stuck").length + report.escalations.open);
    const AUTOMATED = new Set(["application.acknowledged", "resume.ingested", "eligibility.evaluated", "application.triaged", "screen.invited", "screen.assessed", "candidate.recommended", "posting.published", "message.sent", "intervention.sent"]);
    const recent = await container.db.select().from(events).where(and(eq(events.companyId, companyId), gte(events.occurredAt, new Date(Date.now() - 24 * HOUR).toISOString())));
    expect(Number(m![4])).toBe(recent.filter((e) => AUTOMATED.has(e.type) && (e.actor.kind === "system" || e.actor.kind === "agent")).length);
  });

  it("exports the applicant list as CSV with the agreed columns, one row per applicant, and audits the export", async () => {
    const r = await json(owner, "GET", `/api/v1/roles/${roleId}/report.csv`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="[a-z0-9-]+-applicants-\d{4}-\d{2}-\d{2}\.csv"$/);
    const text = (await r.text()).replace(/^﻿/, "");
    const lines = text.split("\r\n").filter(Boolean);
    expect(lines[0]).toBe(APPLICANT_COLUMNS.join(","));
    expect(lines).toHaveLength(9);
    const cells = (name: string) => lines.find((l) => l.includes(name))!.split(",");
    const col = (name: string, column: (typeof APPLICANT_COLUMNS)[number]) => cells(name)[APPLICANT_COLUMNS.indexOf(column)];
    expect(col("Ben Osei", "Source")).toBe("Referral");
    expect(col("Ben Osei", "Source detail")).toBe("Dr. Patel");
    expect(col("Ben Osei", "Stage")).toBe("Recommended for interview");
    expect(col("Ben Osei", "Decision")).toBe("Moved to interview");
    expect(col("Cara Diaz", "Source")).toBe("Indeed");
    expect(col("Dev Patel", "Source detail")).toBe("LinkedIn campaign");
    expect(col("Gia Ruiz", "Decision")).toBe("Declined");
    expect(col("Gia Ruiz", "Stage")).toBe("Not moving forward");
    expect(col("Hal Ng", "Outcome")).toBe("Hired");
    expect(col("Ana Lopez", "Interviews")).toBe("2");
    expect(col("Ana Lopez", "Interviews completed")).toBe("1");
    expect(col("Ana Lopez", "Decision")).toBe("Assessment flagged");
    expect(col("Eve Kim", "Days in stage")).toBe("3");
    expect(col("Eve Kim", "Recommendation")).toBe("Needs a person's look");
    expect(col("Finn Ola", "Recommendation")).toBe("");
    expect(text).not.toMatch(/\$|rationale|evidence/i);
    const audits = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "report.exported")));
    expect(audits).toHaveLength(1);
    expect(audits[0].target).toEqual({ type: "role", id: roleId });
    expect(audits[0].details).toMatchObject({ kind: "applicants", rows: 8 });
    expect(audits[0].actor).toMatchObject({ kind: "user", id: ownerActor.id });
  });

  it("exports the figures as rows", async () => {
    const r = await json(owner, "GET", `/api/v1/roles/${roleId}/report/summary.csv`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(/-summary-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = (await r.text()).replace(/^﻿/, "").split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("Figure,Item,Value");
    expect(lines).toContain("Applicants,Total,8");
    expect(lines).toContain("Applicants by source,Referral: Dr. Patel,1");
    expect(lines).toContain("Interviews,No-shows,1");
    expect(lines).toContain("Recruiter help,Typical first response (hours),3");
    expect(lines).toContain("Outcomes,Hired,1");
    expect(lines).toContain("Decline reasons,Experience not a match,1");
    expect(lines.filter((l) => l.startsWith("Suggestions vs decisions,")).length).toBe(report.recommendationsVsDecisions.rows.length * 6);
    expect(lines.length).toBe(summaryRows(report).length + 1);
    expect((await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "report.exported")))).length).toBe(2);
  });

  it("refuses interviewers, lets other members read, and shows nothing of another company's role", async () => {
    const interviewer = await signInAs(container, app, { companyId, role: "interviewer" });
    for (const path of [`/api/v1/roles/${roleId}/report`, `/api/v1/roles/${roleId}/report.csv`, `/api/v1/roles/${roleId}/report/summary.csv`]) {
      const r = await json(interviewer, "GET", path);
      expect(r.status, path).toBe(403);
    }
    const hm = await signInAs(container, app, { companyId, role: "hiring_manager" });
    expect((await json(hm, "GET", `/api/v1/roles/${roleId}/report`)).status).toBe(200);
    const hr = await signInAs(container, app, { companyId, role: "hr" });
    expect((await json(hr, "GET", `/api/v1/roles/${roleId}/report.csv`)).status).toBe(200);
    const rival = await signIn("owner@rival.test");
    expect((await json(rival, "POST", "/api/v1/companies", { name: "Rival Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Tustin", region: "CA", country: "US" }] })).status).toBe(201);
    expect((await json(rival, "GET", `/api/v1/roles/${roleId}/report`)).status).toBe(404);
    expect((await json(rival, "GET", `/api/v1/roles/${roleId}/report.csv`)).status).toBe(404);
    expect((await json(owner, "GET", "/api/v1/roles/not-a-role/report")).status).toBe(404);
    expect((await app.request(`/api/v1/roles/${roleId}/report`)).status).toBe(401);
  });

  it("gives a recruiter whose grant names one candidate that candidate's row of the applicant list and nobody else's", async () => {
    // Kim accepted the request about Ana (e3), so her grant covers the role and Ana only; the applications list already honours that
    expect((await json(recruiterB, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
    const listed = (await (await json(recruiterB, "GET", `/api/v1/roles/${roleId}/applications`)).json()) as Array<{ id: string }>;
    expect(listed.map((a) => a.id)).toEqual([ids.ana]);
    const r = await json(recruiterB, "GET", `/api/v1/roles/${roleId}/report.csv`);
    expect(r.status).toBe(200);
    const lines = (await r.text()).replace(/^﻿/, "").split("\r\n").filter(Boolean);
    expect(lines[0]).toBe(APPLICANT_COLUMNS.join(","));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Ana Lopez");
    expect(lines.join("\n")).not.toMatch(/Osei|Diaz|Dev Patel|Eve Kim|Finn Ola|Gia Ruiz|Hal Ng/);
    const exported = (await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "report.exported")))).filter((a) => a.actor.kind === "recruiter");
    expect(exported).toHaveLength(1);
    expect(exported[0].details).toMatchObject({ kind: "applicants", rows: 1 });
    // the figures are counts without names, so the report itself stays readable under the grant
    expect((await json(recruiterB, "GET", `/api/v1/roles/${roleId}/report`)).status).toBe(200);
  });

  it("gives the administrator the same figures aggregated over every role of the customer, and nobody else", async () => {
    expect((await json(owner, "GET", `/api/v1/admin/customers/${companyId}/report`)).status).toBe(403);
    expect((await json(admin, "GET", "/api/v1/admin/customers/00000000-0000-0000-0000-000000000000/report")).status).toBe(404);
    expect((await json(admin, "GET", "/api/v1/admin/customers/nope/report")).status).toBe(404);
    const r = await json(admin, "GET", `/api/v1/admin/customers/${companyId}/report`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { company: { id: string; name: string }; roles: Array<{ id: string; title: string; applicants: number; waitingOnYou: number; hired: number }>; report: RoleReport };
    expect(body.company).toMatchObject({ id: companyId, name: "Ledger Dental" });
    expect(body.roles.map((x) => x.id).sort()).toEqual([roleId, role2Id].sort());
    expect(body.roles.find((x) => x.id === roleId)).toMatchObject({ applicants: 8, waitingOnYou: report.stages.byGroup.waiting_on_you, hired: 1 });
    expect(body.roles.find((x) => x.id === role2Id)).toMatchObject({ applicants: 1, hired: 0 });
    const agg = body.report;
    expect(agg.role).toBeNull();
    expect(agg.applicants.total).toBe(9);
    expect(agg.applicants.bySource.find((s) => s.source === "careers_page")!.count).toBe(6);
    expect(agg.stages.total).toBe(9);
    const all = await container.db.select().from(applications).where(eq(applications.companyId, companyId));
    expect(agg.stages.byGroup).toEqual(groupCounts(all));
    expect(agg.interviews.total).toBe(5);
    expect(agg.escalations).toEqual(report.escalations);
    expect(agg.overrides).toEqual(report.overrides);
    expect(agg.outcomes).toMatchObject({ hired: 1, corrections: 0, role: null });
    expect(agg.outcomes.declineReasons).toEqual(report.outcomes.declineReasons);
    expect(agg.messages.failed).toBe(1);
    expect(agg.messages.total).toBeGreaterThan(report.messages.total);
    expect(agg.recommendationsVsDecisions.assessed).toBe(report.recommendationsVsDecisions.assessed + 1);
    expect(JSON.stringify(body)).not.toMatch(/Lopez|Osei|Chen/);
    // the administrator's read is audited like every other console read
    const bypass = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "admin.bypass"));
    expect(bypass.some((a) => (a.reason ?? "").includes(`/api/v1/admin/customers/${companyId}/report`))).toBe(true);
  });
});

describe("role report arithmetic on hand-made rows", () => {
  const BASE = Date.UTC(2026, 8, 30, 19, 0, 0);
  const d = (days: number) => new Date(BASE + days * DAY).toISOString();
  const app = (id: string, stage: string, createdAt: string, stageChangedAt: string, extra: Partial<ReportData["apps"][number]> = {}): ReportData["apps"][number] => ({ id, roleId: "r", candidateId: `c-${id}`, source: "careers_page", sourceDetail: null, stage: stage as never, stageChangedAt, createdAt, latestAssessmentId: null, rejectReason: null, ...extra });
  const moved = (id: string, from: string, to: string, at: string) => ({ subjectId: id, occurredAt: at, payload: { from, to } });
  const data: ReportData = {
    roles: [{ id: "r", title: "Bookkeeper", status: "open", openedAt: d(-10), closedAt: null }],
    timeZone: "America/Los_Angeles",
    apps: [app("a1", "triaged", d(-10), d(-4)), app("a2", "screen_invited", d(-8), d(-1)), app("a3", "rejected", d(-6), d(-2), { rejectReason: "other" })],
    stageEvents: [
      moved("a1", "applied", "received", d(-10)), moved("a1", "received", "eligible", d(-9)), moved("a1", "eligible", "triaged", d(-4)),
      moved("a2", "applied", "received", d(-8)), moved("a2", "received", "eligible", d(-5)), moved("a2", "eligible", "triaged", d(-3)), moved("a2", "triaged", "screen_invited", d(-1)),
      moved("a3", "applied", "received", d(-6)), moved("a3", "received", "eligible", d(-4)), moved("a3", "eligible", "rejected", d(-2)),
    ],
    overrides: [{ subjectId: "a3", occurredAt: d(-2), payload: { action: "reject", reason: "other" } }],
    assessments: [{ id: "s3", applicationId: "a3", createdAt: d(-3), recommendation: "screen" }, { id: "s1", applicationId: "a1", createdAt: d(-4), recommendation: "hold" }],
    interviews: [],
    approvals: [{ id: "p1", actionType: "application.invite_screen", applicationId: "a2", createdAt: d(-6) }],
    escalations: [],
    messages: { total: 3, sent: 2, failed: 1, bounced: 0, unknown: 0, pending: 0, candidatesAffected: 1 },
    outcomes: [],
  };

  it("takes the typical (median) and average stay from the history, and the current wait from the stage's start", () => {
    const r = composeRoleReport(data, new Date(BASE));
    const stage = (s: string) => r.timeInStage.byStage.find((x) => x.stage === s)!;
    expect(stage("applied")).toMatchObject({ completed: 3, medianDays: 0, averageDays: 0, nowHere: 0, longestDays: null });
    expect(stage("received")).toMatchObject({ completed: 3, medianDays: 2, averageDays: 2, nowHere: 0 });
    expect(stage("eligible")).toMatchObject({ completed: 3, medianDays: 2, averageDays: 3, nowHere: 0 });
    expect(stage("triaged")).toMatchObject({ label: "Ready for your review", completed: 1, medianDays: 2, averageDays: 2, nowHere: 1, longestDays: 4 });
    expect(stage("screen_invited")).toMatchObject({ completed: 0, medianDays: null, averageDays: null, nowHere: 1, longestDays: 1 });
    expect(r.timeInStage.waitingOnYou).toEqual({ count: 1, averageDays: 4, medianDays: 4, longestDays: 4 });
    expect(r.role).toMatchObject({ title: "Bookkeeper", daysOpen: 10 });
    expect(r.stages.byGroup).toEqual({ waiting_on_you: 1, in_process: 1, not_moving_forward: 1, hired: 0 });
    expect(r.applicants.byDay.filter((x) => x.count).map((x) => x.count)).toEqual([1, 1, 1]);
    expect(r.applicants.last30Days).toBe(3);
  });

  it("dedupes an approval about a candidate who is already waiting, pairs suggestions with the decision that followed, and reads the outbox totals as given", () => {
    const r = composeRoleReport(data, new Date(BASE));
    // a2 is in process, so the approval about a2 counts; a1 waits on the owner and counts once
    expect(r.pendingDecisions).toMatchObject({ count: 2, approvals: 1, candidates: 1, oldestDays: 6 });
    expect(r.pendingDecisions.list.map((p) => p.kind)).toEqual(["approval", "candidate"]);
    expect(r.pendingDecisions.list[0]).toMatchObject({ label: "Invite to a screen?", days: 6, approvalRequestId: "p1" });
    expect(r.recommendationsVsDecisions.rows).toEqual([
      { recommendation: "screen", label: "Screen suggested", total: 1, invited: 0, interviewed: 0, declined: 1, held: 0, noActionYet: 0 },
      { recommendation: "hold", label: "Hold suggested", total: 1, invited: 0, interviewed: 0, declined: 0, held: 0, noActionYet: 1 },
    ]);
    expect(r.overrides).toEqual({ eligibilityOverrides: 0, reviewAnyway: 0, holds: 0, flaggedAssessments: 0, byAction: { reject: 1 } });
    expect(r.messages).toEqual(data.messages);
    expect(r.outcomes.declineReasons).toEqual([{ reason: "other", label: "Other", count: 1 }]);
    expect(r.escalations).toEqual({ total: 0, open: 0, resolved: 0, overdue: 0, medianResponseHours: null });
  });

  it("reads the decision recorded after an interview as the decision that followed the suggestion", () => {
    // the interview-decision route emits human.override with action "interview.decision" and the choice in payload.decision
    const after = (decision: string) => composeRoleReport({
      ...data,
      assessments: [{ id: "s2", applicationId: "a2", createdAt: d(-3), recommendation: "interview" }],
      overrides: [{ subjectId: "a2", occurredAt: d(-1), payload: { action: "interview.decision", decision } }],
    }, new Date(BASE)).recommendationsVsDecisions.rows;
    expect(after("not_moving_forward")).toEqual([{ recommendation: "interview", label: "Interview suggested", total: 1, invited: 0, interviewed: 0, declined: 1, held: 0, noActionYet: 0 }]);
    expect(after("next_round")[0]).toMatchObject({ interviewed: 1, declined: 0, noActionYet: 0 });
    expect(after("finalist")[0]).toMatchObject({ interviewed: 1, noActionYet: 0 });
    // an override that is not a decision about the suggestion still leaves the candidate undecided
    expect(after("something_else")[0]).toMatchObject({ interviewed: 0, declined: 0, noActionYet: 1 });
  });

  it("names every pending approval and the role's status in plain words, never a key", () => {
    const r = composeRoleReport({
      ...data,
      roles: [{ ...data.roles[0], status: "pending_approval" }],
      approvals: [
        { id: "p2", actionType: "application.hold_ineligible", applicationId: "a2", createdAt: d(-2) },
        { id: "p3", actionType: "intervention.offer_recruiter", applicationId: null, createdAt: d(-1) },
      ],
    }, new Date(BASE));
    expect(r.pendingDecisions.list.map((p) => p.label)).toEqual(["Ready for your review", "Decide on an eligibility hold", "Want a recruiter to take a look?"]);
    for (const p of r.pendingDecisions.list) expect(p.label).not.toMatch(/[._]/);
    expect(summaryRows(r)).toContainEqual(["Role", "Status", "waiting for approval"]);
  });

  it("writes CSV that a spreadsheet opens safely: quoted commas and quotes, formulas neutralised, a byte-order mark", () => {
    expect(toCsv([["a,b", "say \"hi\"", "=SUM(A1)", 3, null]])).toBe("﻿\"a,b\",\"say \"\"hi\"\"\",'=SUM(A1),3,\r\n");
    const rows = summaryRows(composeRoleReport(data, new Date(BASE)));
    expect(rows[0]).toEqual(["Role", "Title", "Bookkeeper"]);
    expect(rows).toContainEqual(["Applicants", "Total", 3]);
    expect(rows).toContainEqual(["Time in stage (typical days)", "Eligible", 2]);
    expect(rows).toContainEqual(["Messages", "Candidates affected", 1]);
  });
});
