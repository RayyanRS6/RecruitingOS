import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, rowsOf, type DbHandle } from "./client";
import { MIGRATIONS_DIR, migrate, migrationStatus } from "./migrate";

/**
 * Migrations 0040 and 0041 on a database as the build before the simple product left it (migration 0037): every row in
 * a state today's code does not know is moved to the nearest one it does, nobody gains or loses access, the storage of
 * the removed features is dropped with rows in it, and the tables that are records lose no row.
 */
describe("migrations 0040 and 0041: the rows and the storage of the build before the simple product", () => {
  const REMAP = "0040_states_the_code_knows.sql";
  const DROPS = "0041_storage_nothing_uses.sql";
  let handle: DbHandle;
  let dir = "";
  const rows = async <T>(q: ReturnType<typeof sql>) => rowsOf<T>(await handle.db.execute(q));
  const run = (q: ReturnType<typeof sql>) => handle.db.execute(q);
  const one = async <T>(q: ReturnType<typeof sql>) => (await rows<T>(q))[0];
  const columnsOf = async (table: string) => (await rows<{ column_name: string }>(sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position`)).map((r) => r.column_name);
  const uuid = (group: number, n: number) => `${String(group).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const company = (n: number) => uuid(1, n);
  const user = (n: number) => uuid(2, n);
  const job = (n: number) => uuid(3, n);
  const cand = (n: number) => uuid(4, n);
  const app = (n: number) => uuid(5, n);
  const scr = (n: number) => uuid(6, n);
  const msg = (n: number) => uuid(7, n);
  const wf = (n: number) => uuid(8, n);
  const misc = (n: number) => uuid(9, n);
  const actor = sql`'{"kind":"user","id":"u1"}'::jsonb`;
  const CO = { live: 1, unchecked: 2, open: 3, waiting: 4, declined: 5, staffOnly: 6 };
  const U = { owner: 1, hr: 2, interviewer: 3, staff: 4, invited: 5, itsRecruiter: 6, admin: 7, owner2: 8, owner3: 9, owner4: 10, owner5: 11 };
  const J = { open: 1, pending: 2, filled: 3, closed: 4, odd: 5 };
  /** Each person, the stage the old build left them at, and what else is theirs. */
  const A = {
    interviewBooked: 1, offerOut: 2, heldOnAnswer: 3, eligible: 4, poolTold: 5, poolUntold: 6, declinedOffer: 7, rejectedBefore: 8, rejectedQueued: 9,
    chatting: 10, oldChat: 11, interviewDuringInvite: 12, sentUnscored: 13, received: 14, invitedOnClosedJob: 15, hired: 16, pausedChat: 17, askedPerson: 18, abandoned: 19, byText: 20,
  };
  const before: Record<string, unknown> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ros-0040-"));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((x) => x < "0038")) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle, { dir });

    // Companies: one checked, two whose people work but that were never checked, one waiting, one declined, one with only ITS staff in it.
    const addCompany = (n: number, name: string, settings: Record<string, unknown>) => run(sql`INSERT INTO companies (id, name, slug, vertical, size_band, settings, status, created_at) VALUES (${company(n)}, ${name}, ${`co-${n}`}, 'dental', '20-49', ${JSON.stringify(settings)}::jsonb, 'active', '2026-09-01T08:00:00Z')`);
    await addCompany(CO.live, "Live Dental", { website: "https://live.example", verifiedAt: "2026-09-02T10:00:00.000Z", verifiedBy: { kind: "user", id: "admin" }, applyFlowDefault: "one_visit", applyFlowSetBy: { at: "x" }, boardPosting: "its", onboarding: { hidden: true }, zipRecruiterPlan: true, newTimesAfterCancel: { auto: true, workingDays: 3 }, candidateScoreShown: false, candidateScoreSetBy: { at: "x" }, businessHours: { days: [1], start: "09:00", end: "17:00" }, brief: { channel: "email", hourLocal: 8 }, retention: { applications: 365 }, notices: { ai_use: { version: "v", text: "t", jurisdictions: [] } }, aiCreditTold: { warnedFor: "total" } });
    await addCompany(CO.unchecked, "Unchecked Dental", { website: "https://unchecked.example" });
    await addCompany(CO.open, "Open Dental", {});
    await addCompany(CO.waiting, "Waiting Dental", {});
    await addCompany(CO.declined, "Declined Dental", {});
    await addCompany(CO.staffOnly, "Staff Only Dental", {});
    for (const [n, email, role] of [[U.owner, "owner@live.test", "none"], [U.hr, "hr@live.test", "none"], [U.interviewer, "interviewer@live.test", "none"], [U.staff, "staff@its.test", "none"], [U.invited, "invited@live.test", "none"], [U.itsRecruiter, "recruiter@its.test", "its_recruiter"], [U.admin, "admin@its.test", "platform_admin"], [U.owner2, "owner@unchecked.test", "none"], [U.owner3, "owner@open.test", "none"], [U.owner4, "owner@waiting.test", "none"], [U.owner5, "owner@declined.test", "none"]] as const) {
      await run(sql`INSERT INTO users (id, email, phone, platform_role) VALUES (${user(n)}, ${email}, '555-0100', ${role})`);
    }
    const member = (n: number, companyN: number, userN: number, role: string, status: string, at = "2026-09-20T08:00:00Z") => run(sql`INSERT INTO memberships (id, company_id, user_id, role, status, created_at) VALUES (${misc(100 + n)}, ${company(companyN)}, ${user(userN)}, ${role}, ${status}, ${at})`);
    await member(1, CO.live, U.owner, "owner", "active");
    await member(2, CO.live, U.hr, "hr", "active");
    await member(3, CO.live, U.interviewer, "interviewer", "active");
    await member(4, CO.live, U.staff, "recruiter", "active");
    await member(5, CO.live, U.invited, "hiring_manager", "invited");
    await member(6, CO.unchecked, U.owner2, "owner", "active");
    await member(7, CO.open, U.owner3, "owner", "active", "2026-09-20T08:00:00Z");
    await member(8, CO.waiting, U.owner4, "owner", "requested");
    await member(9, CO.declined, U.owner5, "owner", "declined");
    await member(10, CO.staffOnly, U.staff, "recruiter", "active");
    await run(sql`INSERT INTO events (company_id, type, actor, subject_type, subject_id, occurred_at) VALUES (${company(CO.unchecked)}, 'company.access_accepted', ${actor}, 'company', ${company(CO.unchecked)}, '2026-10-05T09:30:00Z')`);
    // Sessions: the ITS person working in Live Dental, and a company's own person.
    await run(sql`INSERT INTO sessions (id, user_id, token_hash, active_company_id, expires_at) VALUES (${misc(201)}, ${user(U.staff)}, 'h-staff', ${company(CO.live)}, now() + interval '1 day')`);
    await run(sql`INSERT INTO sessions (id, user_id, token_hash, active_company_id, expires_at) VALUES (${misc(202)}, ${user(U.hr)}, 'h-hr', ${company(CO.live)}, now() + interval '1 day')`);
    await run(sql`INSERT INTO invitations (id, company_id, email, role, invited_by, token_hash, expires_at) VALUES (${misc(301)}, ${company(CO.live)}, 'new-hr@live.test', 'hr', ${actor}, 'inv-1', now() + interval '7 days')`);
    await run(sql`INSERT INTO invitations (id, company_id, email, role, invited_by, token_hash, expires_at) VALUES (${misc(302)}, ${company(CO.live)}, 'new-admin@live.test', 'admin', ${actor}, 'inv-2', now() + interval '7 days')`);
    await run(sql`INSERT INTO platform_role_grants (id, user_id, role, source, granted_by, grant_reason) VALUES (${misc(401)}, ${user(U.itsRecruiter)}, 'its_recruiter', 'console', ${actor}, 'works the queue')`);
    await run(sql`INSERT INTO platform_role_grants (id, user_id, role, source, granted_by, grant_reason) VALUES (${misc(402)}, ${user(U.admin)}, 'platform_admin', 'bootstrap', ${actor}, 'first administrator')`);

    // Jobs in every status the old build knew, and one no build names.
    for (const [n, status] of [[J.open, "open"], [J.pending, "pending_approval"], [J.filled, "filled"], [J.closed, "closed"], [J.odd, "archived"]] as const) {
      await run(sql`INSERT INTO roles (id, company_id, title, status, close_reason, apply_mode, publish_channels, created_by, updated_at) VALUES (${job(n)}, ${company(CO.live)}, ${`Hygienist ${n}`}, ${status}, 'hired_externally', 'one_visit', ARRAY['linkedin'], ${actor}, '2026-10-10T10:00:00Z')`);
    }

    // People at every stage that is gone, and the ones whose AI interview or told state needs a second look.
    const person = async (n: number, stage: string, opts: { told?: string; toldAt?: string | null; jobN?: number; version?: number } = {}) => {
      await run(sql`INSERT INTO candidates (id, company_id, first_name, last_name, first_source, in_talent_pool, preferences) VALUES (${cand(n)}, ${company(CO.live)}, ${`P${n}`}, 'Old', 'linkedin', true, '{"smsOptOut":true,"emailOptOut":true,"contactWindow":"evenings","talentPoolOptOut":true}'::jsonb)`);
      await run(sql`INSERT INTO applications (id, company_id, role_id, candidate_id, packet_version, source, status_token, stage, stage_changed_at, told_state, candidate_told_at, reject_reason, withdraw_reason, eligibility)
        VALUES (${app(n)}, ${company(CO.live)}, ${job(opts.jobN ?? J.open)}, ${cand(n)}, ${opts.version ?? 1}, 'linkedin', ${`status-${n}`}, ${stage}, '2026-10-12T12:00:00Z', ${opts.told ?? "not_told"}, ${opts.toldAt ?? null}, 'other', 'changed my mind', '{"passed":false}'::jsonb)`);
    };
    await person(A.interviewBooked, "interview_scheduled", { version: 3 });
    await person(A.offerOut, "offer_sent");
    await person(A.heldOnAnswer, "ineligible", { told: "sent", toldAt: "2026-10-11T09:00:00Z" });
    await person(A.eligible, "eligible");
    await person(A.poolTold, "talent_pool", { told: "told_in_person", toldAt: "2026-10-12T13:00:00Z" });
    await person(A.poolUntold, "talent_pool");
    await person(A.declinedOffer, "declined");
    await person(A.rejectedBefore, "rejected", { told: "before_tracking", toldAt: "2026-10-01T09:00:00Z" });
    await person(A.rejectedQueued, "rejected", { told: "queued" });
    await person(A.chatting, "screening");
    await person(A.oldChat, "screen_invited");
    await person(A.interviewDuringInvite, "interview_recommended");
    await person(A.sentUnscored, "screen_complete");
    await person(A.received, "received");
    await person(A.invitedOnClosedJob, "screen_invited", { jobN: J.closed });
    await person(A.hired, "hired");
    await person(A.pausedChat, "screening");
    await person(A.askedPerson, "screen_invited");
    await person(A.abandoned, "triaged");
    await person(A.byText, "screening");
    const interviewOf = (n: number, status: string, opts: { progress?: Record<string, unknown>; transcript?: unknown[]; channel?: string; remindedAt?: string | null; humanAt?: string | null } = {}) =>
      run(sql`INSERT INTO screens (id, company_id, application_id, channel, status, token, invited_at, expires_at, reminded_at, human_requested_at, transcript, progress, invited_via, updated_at)
        VALUES (${scr(n)}, ${company(CO.live)}, ${app(n)}, ${opts.channel ?? "web"}, ${status}, ${`screen-${n}`}, now() - interval '1 day', now() + interval '4 days', ${opts.remindedAt ?? null}, ${opts.humanAt ?? null}, ${JSON.stringify(opts.transcript ?? [])}::jsonb, ${JSON.stringify(opts.progress ?? { askedKeys: [] })}::jsonb, 'with_application', '2026-10-13T10:00:00Z')`);
    const planned = { askedKeys: [], chat: { items: [], section: "questions" } };
    const opened = [{ role: "assistant", content: "Hello", at: "2026-10-12T10:00:00Z" }];
    await interviewOf(A.interviewBooked, "completed");
    await interviewOf(A.chatting, "in_progress", { progress: planned, transcript: opened });
    await interviewOf(A.oldChat, "invited", { transcript: opened });
    await interviewOf(A.interviewDuringInvite, "invited");
    await interviewOf(A.sentUnscored, "completed");
    await interviewOf(A.invitedOnClosedJob, "invited");
    await interviewOf(A.pausedChat, "paused", { progress: planned, transcript: opened });
    await interviewOf(A.askedPerson, "human_requested", { humanAt: "2026-10-12T15:00:00Z" });
    await interviewOf(A.abandoned, "abandoned");
    await interviewOf(A.byText, "in_progress", { channel: "sms", progress: planned, transcript: opened });

    // The outbox: a held email, a queued one of a template that is gone, a queued decision of the old wording, a text, and two that stay.
    const email = (n: number, status: string, template: string, opts: { appN?: number; channel?: string } = {}) =>
      run(sql`INSERT INTO communications (id, company_id, application_id, direction, channel, body_text, template_key, status, sent_by) VALUES (${msg(n)}, ${company(CO.live)}, ${opts.appN ? app(opts.appN) : null}, 'outbound', ${opts.channel ?? "email"}, 'words', ${template}, ${status}, ${actor})`);
    await email(1, "held", "acknowledgment", { appN: A.received });
    await email(2, "queued", "acknowledgment", { appN: A.eligible });
    await email(3, "queued", "interview_invite", { appN: A.interviewBooked });
    await email(4, "queued", "disposition:v1", { appN: A.rejectedQueued });
    await email(5, "queued", "screen_invite", { appN: A.byText, channel: "sms" });
    await email(6, "sent", "disposition:v1", { appN: A.rejectedBefore });

    // Workflow runs: two of removed workflows, old runs of the two that remain, and two that are left alone.
    const runOf = (n: number, key: string, status: string, step: string, opts: { subject?: string; state?: Record<string, unknown>; wait?: Record<string, unknown> | null; version?: number } = {}) =>
      run(sql`INSERT INTO workflow_runs (id, company_id, workflow_key, workflow_version, subject, status, current_step, state, wait, attempts, last_error)
        VALUES (${wf(n)}, ${company(CO.live)}, ${key}, ${opts.version ?? 1}, ${JSON.stringify({ type: "application", id: opts.subject ?? app(1) })}::jsonb, ${status}, ${step}, ${JSON.stringify(opts.state ?? {})}::jsonb, ${opts.wait ? JSON.stringify(opts.wait) : null}::jsonb, 2, 'an old error')`);
    await runOf(1, "role_approval", "waiting", "on_decision", { wait: { kind: "human", approvalRequestId: misc(900), keys: [`approval:${misc(900)}`] } });
    await runOf(2, "schedule_interview", "running", "offer_slots");
    await runOf(3, "application_intake", "waiting", "ai_notice", { subject: app(A.received), state: { applicationId: app(A.received), roleId: job(J.open), noticeWaitSince: "2026-10-12T10:00:00Z" }, wait: { kind: "event", eventTypes: ["ai_notice.sent"], keys: ["x"] } });
    await runOf(4, "screen", "waiting", "after_invite", { subject: app(A.chatting), state: { applicationId: app(A.chatting), roleId: job(J.open), screenId: scr(A.chatting), mode: "with_application" }, wait: { kind: "event", eventTypes: ["completed"], keys: ["y"] } });
    await runOf(5, "screen", "waiting", "assess", { subject: app(A.sentUnscored), state: { applicationId: app(A.sentUnscored), roleId: job(J.open), screenId: scr(A.sentUnscored), creditWaitSince: "2026-10-12T10:00:00Z" }, wait: { kind: "timer", until: "2026-12-01T00:00:00Z" } });
    await runOf(6, "screen", "waiting", "await_reading", { subject: app(A.eligible), state: { applicationId: app(A.eligible), roleId: job(J.open), mode: "with_application" }, wait: { kind: "event", eventTypes: ["reading.settled"], keys: ["z"] } });
    await runOf(7, "screen", "waiting", "after_invite", { subject: app(A.oldChat), state: { applicationId: app(A.oldChat), roleId: job(J.open), screenId: scr(A.oldChat) }, wait: { kind: "event", eventTypes: ["started"], keys: ["w"] } });
    await runOf(8, "role_closing_date", "waiting", "wait", { wait: { kind: "timer", until: "2026-12-31T00:00:00Z" } });
    await runOf(9, "application_intake", "completed", "after_triage", { subject: app(A.hired) });
    await run(sql`INSERT INTO jobs (kind, payload, status) VALUES ('posting.verify', '{}'::jsonb, 'queued'), ('email.fallback_sms', '{}'::jsonb, 'queued'), ('communication.send', '{"communicationId":"x"}'::jsonb, 'queued'), ('workflow.tick', '{"runId":"old"}'::jsonb, 'queued'), ('interview.cancel_events', '{}'::jsonb, 'done')`);

    // What the dropped tables held, with their links to one another and to the tables that stay.
    await run(sql`INSERT INTO interviews (id, company_id, application_id, round_key, title, format, duration_minutes, schedule_token) VALUES (${misc(501)}, ${company(CO.live)}, ${app(A.interviewBooked)}, 'first', 'First interview', 'video', 30, 'sched-1')`);
    await run(sql`INSERT INTO interview_followups (id, company_id, application_id, interview_id, interview_attempt, kind, choice, created_by) VALUES (${misc(502)}, ${company(CO.live)}, ${app(A.interviewBooked)}, ${misc(501)}, 1, 'candidate_cancelled', 'new_times', ${actor})`);
    await run(sql`INSERT INTO interview_participants (id, company_id, interview_id, user_id) VALUES (${misc(503)}, ${company(CO.live)}, ${misc(501)}, ${user(U.interviewer)})`);
    await run(sql`INSERT INTO scorecards (id, company_id, interview_id, application_id, interviewer_user_id) VALUES (${misc(504)}, ${company(CO.live)}, ${misc(501)}, ${app(A.interviewBooked)}, ${user(U.interviewer)})`);
    await run(sql`INSERT INTO offers (id, company_id, application_id, status, made_outside, created_by) VALUES (${misc(505)}, ${company(CO.live)}, ${app(A.offerOut)}, 'made', true, ${actor})`);
    await run(sql`INSERT INTO application_marks (id, company_id, application_id, mark, note, set_by) VALUES (${misc(506)}, ${company(CO.live)}, ${app(A.eligible)}, 'shortlist', 'looks good', ${actor})`);
    await run(sql`INSERT INTO application_notes (id, company_id, application_id, author_user_id, body) VALUES (${misc(507)}, ${company(CO.live)}, ${app(A.eligible)}, ${user(U.owner)}, 'a private note')`);
    await run(sql`INSERT INTO approval_requests (id, company_id, role_id, action_type, subject, requested_by) VALUES (${misc(900)}, ${company(CO.live)}, ${job(J.pending)}, 'role.approve', '{"type":"role","id":"r"}'::jsonb, ${actor})`);
    await run(sql`INSERT INTO policies (id, company_id, action_type, level, created_by) VALUES (${misc(508)}, ${company(CO.live)}, 'disposition.send', 'approval', ${actor})`);
    await run(sql`INSERT INTO recruiter_escalations (id, company_id, kind, requested_by, question) VALUES (${misc(509)}, ${company(CO.live)}, 'ask', ${actor}, 'Can you help?')`);
    await run(sql`INSERT INTO escalation_messages (id, company_id, escalation_id, side, author, body) VALUES (${misc(510)}, ${company(CO.live)}, ${misc(509)}, 'customer', ${actor}, 'Please')`);
    await run(sql`INSERT INTO staff_access_grants (id, user_id, company_id, kind, purpose, granted_by, expires_at) VALUES (${misc(511)}, ${user(U.staff)}, ${company(CO.live)}, 'escalation', 'help', ${actor}, now() + interval '1 day')`);
    await run(sql`INSERT INTO takeovers (id, company_id, role_id, recruiter_user_id) VALUES (${misc(512)}, ${company(CO.live)}, ${job(J.open)}, ${user(U.staff)})`);
    await run(sql`INSERT INTO integrations (id, company_id, provider, kind, secret_ref) VALUES (${misc(513)}, ${company(CO.live)}, 'google', 'calendar', 'vault-secret-1')`);
    await run(sql`INSERT INTO inbound_emails (id, company_id, to_address, from_address, raw_storage_key) VALUES (${misc(514)}, ${company(CO.live)}, 'apply@in.example', 'someone@example.com', 'inbound/co/1.pdf')`);
    await run(sql`INSERT INTO postings (id, company_id, role_id, channel) VALUES (${misc(515)}, ${company(CO.live)}, ${job(J.open)}, 'linkedin')`);
    await run(sql`INSERT INTO application_links (id, company_id, role_id, token, source, label, created_by) VALUES (${misc(516)}, ${company(CO.live)}, ${job(J.open)}, 'link-1', 'linkedin', 'LinkedIn', ${actor})`);
    await run(sql`INSERT INTO unconfirmed_screens (id, company_id, role_id, application_id, packet_version, first_name, token, expires_at) VALUES (${misc(517)}, ${company(CO.live)}, ${job(J.open)}, ${app(A.hired)}, 1, 'Pat', 'unconfirmed-1', now() + interval '1 day')`);
    await run(sql`INSERT INTO interventions (id, company_id, detector, ladder_level) VALUES (${misc(518)}, ${company(CO.live)}, 'candidates_waiting', 'brief')`);
    await run(sql`INSERT INTO interviewer_availability (id, company_id, user_id, timezone) VALUES (${misc(519)}, ${company(CO.live)}, ${user(U.interviewer)}, 'America/Chicago')`);
    await run(sql`INSERT INTO onboardings (id, company_id, application_id) VALUES (${misc(520)}, ${company(CO.live)}, ${app(A.hired)})`);
    await run(sql`INSERT INTO debriefs (id, company_id, role_id, created_by) VALUES (${misc(521)}, ${company(CO.live)}, ${job(J.open)}, ${actor})`);
    await run(sql`INSERT INTO playbooks (id, vertical, version, content) VALUES (${misc(522)}, 'dental', 1, '{}'::jsonb)`);
    await run(sql`INSERT INTO business_calendar_versions (id, version, effective_from, time_zone, hours, created_by) VALUES (${misc(523)}, 99, '2026-01-01', 'America/Chicago', '{}'::jsonb, ${actor})`);

    // The records: an AI run of a chat kept in unconfirmed_screens, an outcome, a privacy request, an audit record.
    await run(sql`INSERT INTO ai_runs (id, company_id, agent, task, provider, model, model_version, prompt_key, prompt_version, prompt_hash, input_ref, cost_usd, confidence) VALUES (${misc(601)}, ${company(CO.live)}, 'screen', 'screen.turn', 'fake', 'fake', 'v1', 'screen.turn', 8, 'h', ${JSON.stringify({ unconfirmedScreenId: misc(517), turn: 1 })}::jsonb, 0.0021, 'high')`);
    await run(sql`INSERT INTO ai_runs (id, company_id, agent, task, provider, model, prompt_key, prompt_version, prompt_hash, input_ref, cost_usd) VALUES (${misc(602)}, ${company(CO.live)}, 'triage', 'triage.assess', 'fake', 'fake', 'triage.assess', 7, 'h', ${JSON.stringify({ applicationId: app(A.hired), reading: 1 })}::jsonb, 0.0100)`);
    await run(sql`INSERT INTO hiring_outcomes (id, company_id, application_id, milestone, outcome, rating, notes, recorded_by, hire_date, offer_accepted_at) VALUES (${misc(603)}, ${company(CO.live)}, ${app(A.hired)}, 'final', 'hired_externally', 4, 'a good hire', ${actor}, '2026-10-14', '2026-10-10')`);
    await run(sql`INSERT INTO data_requests (id, company_id, kind, requester_email, sla_due_at, escalation_id) VALUES (${misc(604)}, ${company(CO.live)}, 'access', 'p16@example.com', now() + interval '45 days', ${misc(509)})`);
    await run(sql`INSERT INTO audit_records (id, company_id, actor, action) VALUES (${misc(605)}, ${company(CO.live)}, ${actor}, 'staff.access_granted')`);
    before.events = (await rows<{ id: number; type: string; payload: unknown }>(sql`SELECT id, type, payload FROM events ORDER BY id`));
    before.audit = await rows(sql`SELECT id, action FROM audit_records ORDER BY id`);
    before.grants = (await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM platform_role_grants`))!.n;

    for (const f of files.filter((x) => x >= "0038")) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    expect(await migrate(handle, { dir })).toEqual(files.filter((x) => x >= "0038"));
  });
  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("moves every stage that is gone to the nearest one that exists, and writes no event for it", async () => {
    const stages = Object.fromEntries((await rows<{ id: string; stage: string }>(sql`SELECT id, stage FROM applications`)).map((r) => [r.id, r.stage]));
    const at = (n: number) => stages[app(n)];
    expect(at(A.interviewBooked)).toBe("screen_complete"); // sent an AI interview
    expect(at(A.offerOut)).toBe("triaged"); // never sent one
    expect(at(A.heldOnAnswer)).toBe("triaged");
    expect(at(A.eligible)).toBe("triaged");
    expect(at(A.poolTold)).toBe("rejected");
    expect(at(A.poolUntold)).toBe("rejected");
    expect(at(A.declinedOffer)).toBe("withdrawn");
    expect(at(A.interviewDuringInvite)).toBe("triaged");
    for (const kept of [[A.rejectedBefore, "rejected"], [A.chatting, "screening"], [A.oldChat, "screen_invited"], [A.sentUnscored, "screen_complete"], [A.received, "received"], [A.hired, "hired"], [A.pausedChat, "screening"], [A.askedPerson, "screen_invited"], [A.abandoned, "triaged"]] as const) expect(at(kept[0]), `person ${kept[0]}`).toBe(kept[1]);
    expect(new Set(Object.values(stages)).size).toBeLessThanOrEqual(9);
    for (const s of Object.values(stages)) expect(["applied", "received", "triaged", "screen_invited", "screening", "screen_complete", "hired", "rejected", "withdrawn"]).toContain(s);
    // someone moved to Not selected from the talent pool keeps the time of that move as the time of the decision
    expect(await rows(sql`SELECT (rejected_at = stage_changed_at) AS same FROM applications WHERE id IN (${app(A.poolTold)}, ${app(A.poolUntold)})`)).toEqual([{ same: true }, { same: true }]);
    expect(await rows(sql`SELECT id FROM events WHERE type = 'application.stage_changed'`)).toEqual([]);
  });

  it("leaves a told state today's code knows, that fits where the person is", async () => {
    const told = Object.fromEntries((await rows<{ id: string; told_state: string; candidate_told_at: string | null }>(sql`SELECT id, told_state, candidate_told_at FROM applications`)).map((r) => [r.id, r]));
    expect(told[app(A.poolTold)]!.told_state).toBe("sent"); // told in person
    expect(told[app(A.rejectedBefore)]!.told_state).toBe("sent"); // decided before decisions were private
    expect(told[app(A.poolUntold)]!.told_state).toBe("not_told"); // a Not selected nobody was told about
    expect(told[app(A.rejectedQueued)]!.told_state).toBe("not_told"); // its email of the old wording never goes
    expect(told[app(A.heldOnAnswer)]).toMatchObject({ told_state: "not_told", candidate_told_at: null }); // back in the process
    for (const r of Object.values(told)) expect(["not_told", "queued", "sent"]).toContain(r!.told_state);
  });

  it("closes the AI interviews today's chat cannot carry on, and keeps one open only for someone Shortlisted on a job that is not closed", async () => {
    const all = Object.fromEntries((await rows<{ id: string; status: string; packet_version: number | null; completed_at: string | null }>(sql`SELECT id, status, packet_version, completed_at FROM screens`)).map((r) => [r.id, r]));
    const of = (n: number) => all[scr(n)]!;
    expect(of(A.chatting).status).toBe("in_progress"); // a chat with its plan goes on
    expect(of(A.oldChat).status).toBe("expired"); // begun before the chat had its plan
    expect(of(A.byText).status).toBe("expired"); // by text message
    expect(of(A.pausedChat).status).toBe("expired");
    expect(of(A.abandoned).status).toBe("expired");
    expect(of(A.askedPerson).status).toBe("declined_by_candidate");
    expect(new Date(of(A.askedPerson).completed_at!).toISOString()).toBe("2026-10-12T15:00:00.000Z");
    expect(of(A.interviewDuringInvite).status).toBe("cancelled"); // its person is no longer Shortlisted
    expect(of(A.invitedOnClosedJob).status).toBe("cancelled"); // its job is closed
    expect(of(A.interviewBooked).status).toBe("completed");
    for (const s of Object.values(all)) {
      expect(["invited", "reminded", "in_progress", "completed", "expired", "declined_by_candidate", "cancelled"]).toContain(s!.status);
      if (s!.status !== "invited" && s!.status !== "in_progress") expect(s!.completed_at ?? (s!.status === "completed" ? "sent" : null), s!.status).toBeTruthy();
    }
    // a closed job closes the interview and moves nobody
    expect(await one(sql`SELECT stage FROM applications WHERE id = ${app(A.invitedOnClosedJob)}`)).toEqual({ stage: "screen_invited" });
    // every interview asks about the job version its application was sent against
    expect(of(A.interviewBooked).packet_version).toBe(3);
    expect(Object.values(all).every((s) => s!.packet_version !== null)).toBe(true);
  });

  it("cancels the emails that must never go, and leaves the rest", async () => {
    const status = Object.fromEntries((await rows<{ id: string; status: string; error: string | null }>(sql`SELECT id, status, error FROM communications`)).map((r) => [r.id, r]));
    for (const n of [1, 3, 4, 5]) expect(status[msg(n)], `message ${n}`).toMatchObject({ status: "cancelled", error: "written before the simple product and never sent" });
    expect(status[msg(2)]!.status).toBe("queued"); // a template that still exists
    expect(status[msg(6)]!.status).toBe("sent");
    const recorded = await rows<{ subject_id: string }>(sql`SELECT subject_id FROM events WHERE type = 'message.cancelled' ORDER BY subject_id`);
    expect(recorded.map((r) => r.subject_id)).toEqual([msg(1), msg(3), msg(4), msg(5)]);
  });

  it("gives every job a status that exists", async () => {
    const status = Object.fromEntries((await rows<{ id: string; status: string; closed_at: string | null }>(sql`SELECT id, status, closed_at FROM roles`)).map((r) => [r.id, r]));
    expect(status[job(J.open)]!.status).toBe("open");
    expect(status[job(J.pending)]!.status).toBe("draft");
    expect(status[job(J.filled)]).toMatchObject({ status: "closed" });
    expect(status[job(J.filled)]!.closed_at).toBeTruthy();
    expect(status[job(J.closed)]!.status).toBe("closed");
    expect(status[job(J.odd)]!.status).toBe("closed");
  });

  it("makes hr and interviewer members, ends the membership of ITS staff, and leaves nobody with a role or status that is gone", async () => {
    const m = Object.fromEntries((await rows<{ user_id: string; company_id: string; role: string; status: string }>(sql`SELECT user_id, company_id, role, status FROM memberships`)).map((r) => [`${r.company_id}:${r.user_id}`, r]));
    const of = (c: number, u: number) => m[`${company(c)}:${user(u)}`]!;
    expect(of(CO.live, U.owner)).toMatchObject({ role: "owner", status: "active" });
    expect(of(CO.live, U.hr)).toMatchObject({ role: "hiring_manager", status: "active" });
    expect(of(CO.live, U.interviewer)).toMatchObject({ role: "hiring_manager", status: "active" });
    expect(of(CO.live, U.staff)).toMatchObject({ role: "hiring_manager", status: "removed" });
    expect(of(CO.staffOnly, U.staff)).toMatchObject({ status: "removed" });
    expect(of(CO.live, U.invited)).toMatchObject({ status: "removed" });
    expect(of(CO.waiting, U.owner4)).toMatchObject({ role: "owner", status: "requested" });
    expect(of(CO.declined, U.owner5)).toMatchObject({ role: "owner", status: "declined" });
    // the ITS person's session in the company is ended; the company's own person stays signed in
    expect(await rows(sql`SELECT id, (revoked_at IS NOT NULL) AS ended FROM sessions ORDER BY id`)).toEqual([{ id: misc(201), ended: true }, { id: misc(202), ended: false }]);
    // ended the way the code ends a membership: two events and an audit record for each
    expect(await rows(sql`SELECT type, company_id, subject_id, payload FROM events WHERE type IN ('member.removed', 'membership.changed') AND subject_id = ${user(U.staff)} ORDER BY type, company_id`)).toEqual([
      { type: "member.removed", company_id: company(CO.live), subject_id: user(U.staff), payload: { role: "recruiter" } },
      { type: "member.removed", company_id: company(CO.staffOnly), subject_id: user(U.staff), payload: { role: "recruiter" } },
      { type: "membership.changed", company_id: company(CO.live), subject_id: user(U.staff), payload: { role: "recruiter", status: "removed" } },
      { type: "membership.changed", company_id: company(CO.staffOnly), subject_id: user(U.staff), payload: { role: "recruiter", status: "removed" } },
    ]);
    expect((await rows(sql`SELECT id FROM audit_records WHERE action = 'membership.changed' AND target->>'id' = ${user(U.staff)}`)).length).toBe(2);
    expect(await rows(sql`SELECT email, role FROM invitations ORDER BY email`)).toEqual([{ email: "new-admin@live.test", role: "admin" }, { email: "new-hr@live.test", role: "hiring_manager" }]);
  });

  it("ends the grants of the ITS recruiter role in the ledger, with who and why, and keeps every ledger row", async () => {
    const grants = await rows<{ id: string; role: string; revoked: boolean; revoke_reason: string | null; revoked_by: { id?: string } | null }>(sql`SELECT id, role, (revoked_at IS NOT NULL) AS revoked, revoke_reason, revoked_by FROM platform_role_grants ORDER BY id`);
    expect(grants).toEqual([
      { id: misc(401), role: "its_recruiter", revoked: true, revoke_reason: "the ITS recruiter role no longer exists", revoked_by: { kind: "system", id: "migration_0040", name: "The simple product" } },
      { id: misc(402), role: "platform_admin", revoked: false, revoke_reason: null, revoked_by: null },
    ]);
    expect(grants.length).toBe(before.grants);
    expect(await rows(sql`SELECT id, platform_role FROM users WHERE id IN (${user(U.itsRecruiter)}, ${user(U.admin)}) ORDER BY id`)).toEqual([{ id: user(U.itsRecruiter), platform_role: "none" }, { id: user(U.admin), platform_role: "platform_admin" }]);
    expect(await rows(sql`SELECT details FROM audit_records WHERE action = 'platform_role.revoked'`)).toEqual([{ details: { grantId: misc(401), role: "its_recruiter", granteeEmail: "recruiter@its.test" } }]);
  });

  it("makes a company live when its people could already work, from the best stored date, and leaves a waiting or declined one as it is", async () => {
    const settings = Object.fromEntries((await rows<{ id: string; settings: Record<string, unknown> }>(sql`SELECT id, settings FROM companies`)).map((r) => [r.id, r.settings]));
    expect(settings[company(CO.live)]!.verifiedAt).toBe("2026-09-02T10:00:00.000Z"); // already live: its time stays
    expect(settings[company(CO.unchecked)]!.verifiedAt).toBe("2026-10-05T09:30:00.000Z"); // when an administrator accepted it
    expect(settings[company(CO.open)]!.verifiedAt).toBe("2026-09-20T08:00:00.000Z"); // when its first active member joined
    expect(settings[company(CO.waiting)]).not.toHaveProperty("verifiedAt");
    expect(settings[company(CO.declined)]).not.toHaveProperty("verifiedAt");
    expect(settings[company(CO.staffOnly)]).not.toHaveProperty("verifiedAt"); // only ITS staff were in it
    // the keys nothing reads are gone; the ones still read stay as they were
    expect(Object.keys(settings[company(CO.live)]!).sort()).toEqual(["aiCreditTold", "notices", "verifiedAt", "website"]);
    expect(settings[company(CO.unchecked)]).toEqual({ website: "https://unchecked.example", verifiedAt: "2026-10-05T09:30:00.000Z" });
    // a candidate's preferences keep only whether they may be emailed
    expect(await rows(sql`SELECT DISTINCT preferences FROM candidates`)).toEqual([{ preferences: { emailOptOut: true } }]);
  });

  it("starts old runs of the two workflows that remain at a step of today's, cancels the rest that were going, and clears the queue of removed kinds", async () => {
    const runs = Object.fromEntries((await rows<{ id: string; workflow_version: number; status: string; current_step: string; wait: unknown; last_error: string | null; attempts: number }>(sql`SELECT id, workflow_version, status, current_step, wait, last_error, attempts FROM workflow_runs`)).map((r) => [r.id, r]));
    const cancelled = { status: "cancelled", wait: null, last_error: "this workflow is not part of the simple product" };
    expect(runs[wf(1)]).toMatchObject(cancelled); // role_approval
    expect(runs[wf(2)]).toMatchObject(cancelled); // schedule_interview
    expect(runs[wf(7)]).toMatchObject(cancelled); // an old screen run whose interview is over
    const going = { workflow_version: 2, status: "running", wait: null, last_error: null, attempts: 0 };
    expect(runs[wf(3)]).toMatchObject({ ...going, current_step: "receive" }); // the application is read from the top
    expect(runs[wf(4)]).toMatchObject({ ...going, current_step: "remind" }); // an open interview, not reminded yet
    expect(runs[wf(5)]).toMatchObject({ ...going, current_step: "score" }); // answers sent, scorecard not written
    expect(runs[wf(6)]).toMatchObject({ ...going, current_step: "invite" }); // no interview made yet
    expect(runs[wf(8)]).toMatchObject({ workflow_version: 1, status: "waiting", current_step: "wait" }); // the closing date is as it was
    expect(runs[wf(9)]).toMatchObject({ workflow_version: 1, status: "completed", current_step: "after_triage" }); // an ended run is history
    // each run started again has a tick waiting; each cancelled run has its event, as the engine writes it
    const ticks = (await rows<{ run: string }>(sql`SELECT payload->>'runId' AS run FROM jobs WHERE kind = 'workflow.tick' AND status = 'queued' ORDER BY 1`)).map((r) => r.run);
    expect(ticks).toEqual([wf(3), wf(4), wf(5), wf(6), "old"].sort());
    expect(await rows(sql`SELECT subject_id, correlation_id, payload FROM events WHERE type = 'workflow.cancelled' ORDER BY subject_id`)).toEqual([wf(1), wf(2), wf(7)].map((id) => ({ subject_id: id, correlation_id: id, payload: { reason: "this workflow is not part of the simple product" } })));
    expect((await rows<{ kind: string; status: string }>(sql`SELECT kind, status FROM jobs WHERE kind <> 'workflow.tick' ORDER BY kind`))).toEqual([{ kind: "communication.send", status: "queued" }, { kind: "interview.cancel_events", status: "done" }]);
  });

  it("keeps an AI run of a chat whose table is dropped findable by its application", async () => {
    expect(await one(sql`SELECT input_ref, cost_usd::float AS cost FROM ai_runs WHERE id = ${misc(601)}`)).toEqual({ input_ref: { unconfirmedScreenId: misc(517), turn: 1, applicationId: app(A.hired) }, cost: 0.0021 });
    expect(await one(sql`SELECT input_ref, cost_usd::float AS cost FROM ai_runs WHERE id = ${misc(602)}`)).toEqual({ input_ref: { applicationId: app(A.hired), reading: 1 }, cost: 0.01 });
  });

  it("drops the storage of the removed features, rows and all, and nothing else", async () => {
    const tables = (await rows<{ table_name: string }>(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).map((r) => r.table_name);
    expect(tables).toEqual([
      "_migrations", "admin_alerts", "ai_runs", "applications", "assessments", "audit_records", "candidates", "communications", "companies", "csp_reports", "data_requests", "documents",
      "email_suppressions", "entitlements", "events", "hiring_outcomes", "intake_sessions", "invitations", "jobs", "magic_links", "memberships", "notification_preferences", "notifications",
      "plans", "platform_role_grants", "role_packets", "roles", "screens", "sessions", "usage_events", "users", "webhook_receipts", "worker_heartbeats", "workflow_runs", "workflow_steps",
    ]);
    expect(await columnsOf("applications")).toEqual(["id", "company_id", "role_id", "candidate_id", "packet_version", "source", "stage", "stage_changed_at", "resume_document_id", "answers", "extraction", "status_token", "rejected_at", "created_at", "updated_at", "told_state", "candidate_told_at", "locked_at"]);
    expect(await columnsOf("screens")).toEqual(["id", "company_id", "application_id", "status", "token", "invited_at", "started_at", "completed_at", "transcript", "answers", "assessment_id", "workflow_run_id", "created_at", "updated_at", "progress", "expires_at", "reminded_at", "packet_version"]);
    expect(await columnsOf("candidates")).toEqual(["id", "company_id", "first_name", "last_name", "email", "phone", "location_text", "dedupe_key", "consent", "preferences", "created_at", "updated_at", "anonymized_at"]);
    expect(await columnsOf("roles")).toEqual(["id", "company_id", "title", "status", "current_packet_version", "opened_at", "paused_at", "closed_at", "created_by", "created_at", "updated_at", "accepting_applications", "applications_closed_at", "applications_closed_reason", "applications_close_on", "posts"]);
    expect(await columnsOf("companies")).toEqual(["id", "name", "slug", "vertical", "size_band", "timezone", "locations", "settings", "plan_key", "created_at", "updated_at"]);
    for (const [table, gone] of [["users", "phone"], ["magic_links", "invite_role"], ["intake_sessions", "workflow_run_id"], ["notifications", "channel"], ["webhook_receipts", "outcome"], ["ai_runs", "confidence"], ["ai_runs", "tool_calls"], ["workflow_runs", "escalation_id"], ["data_requests", "escalation_id"], ["hiring_outcomes", "rating"], ["hiring_outcomes", "offer_accepted_at"]] as const) expect(await columnsOf(table), `${table}.${gone}`).not.toContain(gone);
    // the index of who was told counts Not selected only
    expect((await one<{ indexdef: string }>(sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'applications_company_told_idx'`))!.indexdef).toMatch(/WHERE \(stage = 'rejected'::text\)/);
  });

  it("deletes no row of a table that is a record: the history is only added to", async () => {
    const events = await rows<{ id: number; type: string; payload: unknown }>(sql`SELECT id, type, payload FROM events ORDER BY id`);
    expect(events.slice(0, (before.events as unknown[]).length)).toEqual(before.events);
    const audit = await rows<{ id: string; action: string }>(sql`SELECT id, action FROM audit_records ORDER BY id`);
    for (const r of before.audit as Array<{ id: string }>) expect(audit.map((a) => a.id)).toContain(r.id);
    expect(await one(sql`SELECT outcome, notes, hire_date::text AS hire_date FROM hiring_outcomes WHERE id = ${misc(603)}`)).toEqual({ outcome: "hired_externally", notes: "a good hire", hire_date: "2026-10-14" });
    expect(await one(sql`SELECT kind, requester_email FROM data_requests WHERE id = ${misc(604)}`)).toEqual({ kind: "access", requester_email: "p16@example.com" });
    expect((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM ai_runs`))!.n).toBe(2);
    expect((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM applications`))!.n).toBe(20);
    expect((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM screens`))!.n).toBe(10);
    expect((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM communications`))!.n).toBe(6);
    expect((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM memberships`))!.n).toBe(10);
  });

  it("is recorded once each, and running the migrations again changes nothing", async () => {
    expect(await rows(sql`SELECT name FROM _migrations WHERE name IN (${REMAP}, ${DROPS}) ORDER BY name`)).toEqual([{ name: REMAP }, { name: DROPS }]);
    expect(await migrate(handle, { dir })).toEqual([]);
    expect((await migrationStatus(handle, { dir })).pending).toEqual([]);
  });
});
