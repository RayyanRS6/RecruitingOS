import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { BatchPreview, BoardView } from "@ros/contracts";
import { entitlements as plans } from "@ros/core";
import { applications, candidates, communications, notifications, screens, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { aiNoticeSentSignal } from "@ros/workflows";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { conversationStart, conversationTurn, findConversation } from "./services/apply-conversation";

/**
 * 20 October 2026, Step 3 (docs/workflow-decisions.md R20-7, R20-8): the first column "No AI interview yet". Everyone who
 * applies sits there until they send the AI interview, also when its link lapses or they stop part-way; the team sees
 * where each stands in neutral words, can send a reminder (once a day; the link stays open 72 hours from then), a new
 * link, or decline privately, and is told nothing per person: Home has one line per job. The worker runs only when the
 * test drains it, on the test's own clock.
 */
describe("No AI interview yet", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  let role: { id: string; title: string; eligibility: string[] };
  const HOUR = 3_600_000;
  const BASE = Date.now();
  let offset = 0;
  const later = async (ms: number) => {
    offset += ms;
    (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset);
    await container.drain();
  };
  const now = () => new Date(BASE + offset);
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body ? JSON.stringify(body) : undefined });
  const get = async <T>(path: string) => (await (await json("GET", path)).json()) as T;
  const mailTo = (email: string) => (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === email);
  let ip = 20;
  const applyAs = async (first: string, email: string) => {
    const fd = new FormData();
    fd.set("firstName", first); fd.set("lastName", "Column"); fd.set("email", email); fd.set("locationText", "Irvine, CA");
    fd.set("noResume", "Registered Dental Hygienist at Harbor Dental since 2019; active CA RDH license; perio maintenance.");
    for (const k of role.eligibility) fd.set(`elig_${k}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    const r = await app.request(`/careers/${slug}/jobs/${role.id}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": `198.51.100.${ip++}` } });
    expect(r.status).toBe(302);
    await later(0);
    const [c] = await container.db.select().from(candidates).where(and(eq(candidates.companyId, companyId), eq(candidates.email, email)));
    return (await container.db.select().from(applications).where(and(eq(applications.roleId, role.id), eq(applications.candidateId, c.id))))[0].id;
  };
  const screenOf = async (applicationId: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, applicationId)))[0];
  const stageOf = async (applicationId: string) => (await container.db.select().from(applications).where(eq(applications.id, applicationId)))[0].stage;
  type Row = { id: string; ownerStage: string; ownerStageLabel: string; group: string; aiInterview: { state: string; group: string; label: string; since: string | null; linkOpenUntil: string | null; canRemind: boolean; canResend: boolean } | null };
  type Detail = { ownerStage: string; ownerStageLabel: string; aiInterview: Row["aiInterview"]; allowedActions: string[]; blockedReasons: Record<string, string>; screens: Array<{ id: string; status: string; expiresAt: string | null }> };
  const rowOf = async (id: string) => (await get<Row[]>(`/api/v1/roles/${role.id}/applications`)).find((r) => r.id === id)!;
  const remind = (id: string) => json("POST", `/api/v1/applications/${id}/actions`, { action: "remind_screen" });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "false", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    await later(0);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@column.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json("POST", "/api/v1/companies", { name: "Column Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    slug = co.slug;
    await plans.applyPlan(container.db, companyId, "growth");
    const s = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    const id = ((await (await json("POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    await container.drain();
    expect((await json("POST", `/api/v1/roles/${id}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    const r = (await (await json("GET", `/api/v1/roles/${id}`)).json()) as { currentPacket: { packet: { identity: { title: string }; requirements: { eligibility: Array<{ key: string }> } } } };
    role = { id, title: r.currentPacket.packet.identity.title, eligibility: r.currentPacket.packet.requirements.eligibility.map((e) => e.key) };
  });
  afterAll(async () => {
    await container.close();
  });

  let ana = "";
  let ben = "";
  let cy = "";

  it("everyone who applies starts there, in neutral words, waiting on nobody; the stage button never moves anyone in, and New comes with the interview", async () => {
    ana = await applyAs("Ana", "ana@column.test");
    expect(await stageOf(ana)).toBe("screen_invited");
    const row = await rowOf(ana);
    expect(row).toMatchObject({ ownerStage: "no_ai_interview", ownerStageLabel: "Invited (not started)", group: "in_process", aiInterview: { state: "invited", group: "not_started", label: "Invited (not started)", canRemind: false, canResend: false } });
    const d = await get<Detail>(`/api/v1/applications/${ana}`);
    // the link's close is on the page now, as on the screen
    expect(d.screens[0].expiresAt).toBe((await screenOf(ana)).expiresAt);
    expect(d.aiInterview?.linkOpenUntil).toBe(d.screens[0].expiresAt);
    const moves = (d as unknown as { stageMoves: Array<{ to: string; allowed: boolean; current: boolean; blockedReason?: string }> }).stageMoves;
    expect(moves.map((m) => m.to)[0]).toBe("no_ai_interview");
    expect(moves.find((m) => m.to === "no_ai_interview")).toMatchObject({ current: true, allowed: false });
    expect(moves.find((m) => m.to === "new")).toMatchObject({ allowed: false, blockedReason: "They move to New when they finish the AI interview." });
  });

  it("'Send a reminder' at most once a day: refused while the link went less than a day ago, then sent, and refused again for a day", async () => {
    let d = await get<Detail>(`/api/v1/applications/${ana}`);
    expect(d.allowedActions).not.toContain("remind_screen");
    expect(d.blockedReasons.remind_screen).toBe("Their link or a reminder went less than a day ago. You can send a reminder a day after the last one.");
    const early = await remind(ana);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: { code: string } }).error.code).toBe("reminded_recently");
    await later(25 * HOUR);
    d = await get<Detail>(`/api/v1/applications/${ana}`);
    expect(d.allowedActions).toContain("remind_screen");
    const sent = await remind(ana);
    expect(sent.status).toBe(200);
    const body = (await sent.json()) as { candidateNotice: string; next: string };
    expect(body.candidateNotice).toBe("queued");
    expect(body.next).toMatch(/^Reminder on its way\. Their link stays open until /);
    await later(0); // the outbox sends it
    const reminders = mailTo("ana@column.test").filter((m) => /your AI interview is still open/.test(m.subject));
    expect(reminders).toHaveLength(1);
    expect(reminders[0].text).toContain(`/c/screen/${(await screenOf(ana)).token}`);
    // the link stays open five days from the invitation (later than 72 hours from now): never moved in
    const scr = await screenOf(ana);
    expect(scr).toMatchObject({ status: "reminded" });
    expect(Date.parse(scr.remindedAt!)).toBe(now().getTime());
    expect(Date.parse(scr.expiresAt!)).toBeGreaterThanOrEqual(now().getTime() + 72 * HOUR);
    // again within the day: refused, nothing sent
    await later(23 * HOUR);
    expect((await remind(ana)).status).toBe(409);
    expect(mailTo("ana@column.test").filter((m) => /your AI interview is still open/.test(m.subject))).toHaveLength(1);
  });

  it("a reminder keeps the link open 72 hours from then: the run waits again past the old close, then the link expires and she stays, 'Link expired', with a new link offered", async () => {
    const invitedAt = Date.parse((await screenOf(ana)).invitedAt!);
    const firstClose = Date.parse((await screenOf(ana)).expiresAt!);
    // the 48-hour reminder did not go again: she had one
    expect(mailTo("ana@column.test").filter((m) => /your AI interview is still open/.test(m.subject))).toHaveLength(1);
    // a second reminder late in the link's life pushes its close out to 72 hours from now
    await later(firstClose - 20 * HOUR - now().getTime());
    const sent = await remind(ana);
    expect(sent.status).toBe(200);
    await later(0);
    const pushed = Date.parse((await screenOf(ana)).expiresAt!);
    expect(pushed).toBe(now().getTime() + 72 * HOUR);
    expect(pushed).toBeGreaterThan(firstClose);
    expect(mailTo("ana@column.test").filter((m) => /your AI interview is still open/.test(m.subject))).toHaveLength(2);
    // past the old close: still open
    await later(firstClose + HOUR - now().getTime());
    expect((await screenOf(ana)).status).toBe("reminded");
    expect((await rowOf(ana)).aiInterview).toMatchObject({ state: "invited" });
    // past the new one: expired, told nothing else is needed, and still in the column
    await later(pushed + HOUR - now().getTime());
    expect((await screenOf(ana)).status).toBe("expired");
    expect(await stageOf(ana)).toBe("screen_invited");
    expect(mailTo("ana@column.test").filter((m) => m.text.includes("has gone to the hiring team without the AI interview"))).toHaveLength(1);
    const row = await rowOf(ana);
    expect(row).toMatchObject({ ownerStage: "no_ai_interview", ownerStageLabel: "Link expired", aiInterview: { state: "link_expired", group: "closed", canResend: true, canRemind: false } });
    const d = await get<Detail>(`/api/v1/applications/${ana}`);
    expect(d.allowedActions).toEqual(expect.arrayContaining(["invite_screen", "reject"]));
    expect(d.blockedReasons.remind_screen).toBe("Their link has closed. Send them a new link instead.");
    expect(invitedAt).toBeLessThan(pushed);
    // nobody on the team was told about her, one by one
    expect((await container.db.select().from(notifications).where(eq(notifications.companyId, companyId))).filter((n) => n.title.includes("Ana Column") || n.body.includes("Ana Column"))).toHaveLength(0);
  });

  it("a reminder to someone who stopped part-way keeps their interview open 72 hours from then, past the usual close", async () => {
    ben = await applyAs("Ben", "ben@column.test");
    const ref = (await findConversation(container.db, (await screenOf(ben)).token))!;
    expect(await conversationStart(container, ref)).toBe(true);
    await conversationTurn(container, ref, { message: "Six years at Harbor Dental, mostly perio maintenance." });
    await later(25 * HOUR); // the run's own reminder
    expect((await screenOf(ben)).idleRemindedAt).toBeTruthy();
    // a day after it, a person may send one more
    expect((await rowOf(ben)).aiInterview).toMatchObject({ state: "started", label: "Started (not finished)", canRemind: false });
    await later(24 * HOUR);
    expect((await rowOf(ben)).aiInterview).toMatchObject({ state: "started", canRemind: true });
    const sent = await remind(ben);
    expect(sent.status).toBe(200);
    await later(0);
    expect(mailTo("ben@column.test").filter((m) => /^Pick up your AI interview/.test(m.subject))).toHaveLength(2);
    const kept = Date.parse((await screenOf(ben)).progress.keptOpenUntil!);
    expect(kept).toBe(now().getTime() + 72 * HOUR);
    // the usual close (48 hours after the run's reminder) passes: still open
    await later(24 * HOUR);
    expect((await screenOf(ben)).status).toBe("in_progress");
    // the kept time passes: closed unfinished, still in the column, "Didn't finish"
    await later(kept + HOUR - now().getTime());
    expect((await screenOf(ben)).status).toBe("unfinished");
    expect(await stageOf(ben)).toBe("screening");
    expect((await rowOf(ben))).toMatchObject({ ownerStageLabel: "Didn't finish", aiInterview: { state: "didnt_finish", canResend: true } });
    expect((await container.db.select().from(notifications).where(eq(notifications.companyId, companyId))).filter((n) => n.kind === "screen.unfinished")).toHaveLength(0);
  });

  it("the counts agree across the list, the Jobs list and the role report, and the list filters by where people stand", async () => {
    cy = await applyAs("Cy", "cy@column.test");
    const list = await get<{ applications: Row[]; counts: { byOwnerStage: Record<string, number>; aiInterview: Record<string, number>; stillApplying: number } }>(`/api/v1/roles/${role.id}/applications?counts=1`);
    expect(list.counts.byOwnerStage.no_ai_interview).toBe(3);
    expect(list.counts.aiInterview).toEqual({ not_started: 1, started: 0, asked_person: 0, closed: 2 });
    expect(list.counts.stillApplying).toBe(3);
    const mine = (await get<Array<{ id: string; stageCounts: Record<string, number> }>>("/api/v1/roles")).find((r) => r.id === role.id)!;
    const report = await get<{ stages: { byOwnerStage: Record<string, number> } }>(`/api/v1/roles/${role.id}/report`);
    expect(mine.stageCounts).toEqual(list.counts.byOwnerStage);
    expect(report.stages.byOwnerStage).toEqual(list.counts.byOwnerStage);
    const closed = await get<Row[]>(`/api/v1/roles/${role.id}/applications?ownerStage=no_ai_interview&aiInterview=closed`);
    expect(closed.map((r) => r.id).sort()).toEqual([ana, ben].sort());
    const notStarted = await get<Row[]>(`/api/v1/roles/${role.id}/applications?aiInterview=not_started`);
    expect(notStarted.map((r) => r.id)).toEqual([cy]);
    expect((await json("GET", `/api/v1/roles/${role.id}/applications?aiInterview=nonsense`)).status).toBe(400);
  });

  it("Home has one line for the job, never a 'needs you', linking to the column; the board keeps them in a read-only lane that Review and apply never takes", async () => {
    const brief = await get<{ cards: Array<{ kind: string; roleId?: string; title: string; body: string; actions: Array<{ path: string }> }> }>("/api/v1/brief");
    const lines = brief.cards.filter((c) => c.kind === "screening" && c.roleId === role.id);
    expect(lines).toHaveLength(1);
    expect(lines[0].title).toBe(`AI interviews for ${role.title}: 1 not started, 2 link closed`);
    expect(lines[0].actions[0].path).toBe(`/roles/${role.id}/talent?ownerStage=no_ai_interview&aiInterview=closed`);
    expect(brief.cards.some((c) => c.kind === "needs_review" && c.roleId === role.id)).toBe(false);
    const board = await get<BoardView>(`/api/v1/roles/${role.id}/board`);
    expect(board.noAiInterview.map((c) => c.name).sort()).toEqual(["Ana Column", "Ben Column", "Cy Column"]);
    for (const c of board.noAiInterview) expect(c.placement).toMatchObject({ column: null, state: "waiting", suggestedAction: null });
    expect(board.noAiInterview.find((c) => c.name === "Ana Column")).toMatchObject({ ownerStageLabel: "Link expired", aiInterview: { state: "link_expired" } });
    expect(board.summary).toMatchObject({ total: 0, noAiInterview: 3 });
    // the refusal says where they stand: Ana's link lapsed, so she cannot finish it without a new one; Cy's is open
    const preview = (await (await json("POST", `/api/v1/roles/${role.id}/batch`, { dryRun: true, items: [{ applicationId: ana, action: "shortlist" }, { applicationId: cy, action: "longlist" }] })).json()) as BatchPreview;
    expect(preview.items[0]).toMatchObject({ allowed: false, refusedReason: "They have no AI interview and none is open, so the board leaves them out. Decide from their own page, or send them a new AI interview link." });
    expect(preview.items[1]).toMatchObject({ allowed: false, refusedReason: "They have no AI interview yet; they join the board when they finish it. Decide from their own page if you need to." });
    expect(board.summary.sentences).toEqual(["Nobody to sort yet; 3 people are not on the board yet: no AI interview in their score."]);
  });

  it("a mark set in the column overlays it, and survives a person stopping the invitation (the two first columns are one step)", async () => {
    const marked = await json("POST", `/api/v1/applications/${cy}/actions`, { action: "set_mark", mark: "longlist" });
    expect(marked.status).toBe(200);
    expect((await rowOf(cy)).ownerStage).toBe("longlist");
    const stopped = await json("POST", `/api/v1/applications/${cy}/actions`, { action: "cancel_screen" });
    expect(stopped.status).toBe(200);
    expect(await stageOf(cy)).toBe("triaged");
    expect((await rowOf(cy))).toMatchObject({ ownerStage: "longlist", aiInterview: null });
  });

  it("'Send a new link' after the link lapsed, and 'Not moving forward' from the column, privately", async () => {
    const fresh = await json("POST", `/api/v1/applications/${ana}/actions`, { action: "invite_screen" });
    expect(fresh.status).toBe(200);
    await later(0);
    const newest = (await container.db.select().from(screens).where(eq(screens.applicationId, ana))).find((s) => s.status === "invited")!;
    expect(newest.progress.flow).toBe("one_visit");
    expect((await rowOf(ana)).aiInterview).toMatchObject({ state: "invited" });
    const declined = await json("POST", `/api/v1/applications/${ben}/actions`, { action: "reject", reason: "candidate_unresponsive" });
    expect(declined.status).toBe(200);
    expect(((await declined.json()) as { candidateNotice: string; ownerStage: string })).toMatchObject({ candidateNotice: "not_told", ownerStage: "not_moving_forward" });
    expect((await container.db.select().from(communications).where(and(eq(communications.applicationId, ben), eq(communications.templateKey, "disposition:v1"))))).toHaveLength(0);
  });

  /** The email carrying an applicant's link, held for the ITS company check (B7) as the outbox leaves it, and its release. */
  const holdLinkEmail = (id: string) => container.db.update(communications).set({ status: "held" }).where(eq(communications.idempotencyKey, `ack:${id}`));
  const releaseLinkEmail = async (id: string) => {
    await container.db.update(communications).set({ status: "sent" }).where(eq(communications.idempotencyKey, `ack:${id}`));
    await withTenant(container.db, companyId, (tx) => container.engine.signal(tx, { companyId, key: aiNoticeSentSignal(id) }));
  };
  const reminded = (email: string) => mailTo(email).filter((m) => /your AI interview is still open/.test(m.subject));

  it("B7: no reminder while the email carrying the link waits for the ITS check; the link never lapses unreceived, and the day counts from when it left", async () => {
    const dan = await applyAs("Dan", "dan@column.test");
    await holdLinkEmail(dan);
    const firstClose = Date.parse((await screenOf(dan)).expiresAt!);
    await later(25 * HOUR);
    const d = await get<Detail & { aiInterview: { remindBlocked?: string } }>(`/api/v1/applications/${dan}`);
    expect(d.allowedActions).not.toContain("remind_screen");
    expect(d.aiInterview?.remindBlocked).toBe("email_held");
    expect(d.blockedReasons.remind_screen).toBe("Their AI interview link has not gone to them yet: the email waits for ITS to check your company. You can send a reminder a day after it goes.");
    const refused = await remind(dan);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("link_email_held");
    // the run's own 48-hour reminder waits too, and the old close passes with the link still open
    await later(firstClose + 2 * HOUR - now().getTime());
    expect((await screenOf(dan)).status).toBe("invited");
    expect(reminded("dan@column.test")).toHaveLength(0);
    // ITS confirms: the email leaves, and the link's five days and the day between reminders start now
    await releaseLinkEmail(dan);
    await later(0);
    const left = await screenOf(dan);
    expect(Date.parse(left.invitedAt!)).toBe(now().getTime());
    expect(Date.parse(left.expiresAt!)).toBe(now().getTime() + 120 * HOUR);
    const early = await remind(dan);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: { code: string } }).error.code).toBe("reminded_recently");
    await later(25 * HOUR);
    expect((await remind(dan)).status).toBe(200);
  });

  it("B7: a link reminded before 21 Oct while its email waited is not closed before that email leaves either", async () => {
    const eve = await applyAs("Eve", "eve@column.test");
    await holdLinkEmail(eve);
    // as a person's reminder left it before the reminder waited for the email
    await container.db.update(screens).set({ status: "reminded", remindedAt: now().toISOString() }).where(eq(screens.applicationId, eve));
    const firstClose = Date.parse((await screenOf(eve)).expiresAt!);
    await later(firstClose + 30 * HOUR - now().getTime());
    expect((await screenOf(eve)).status).toBe("reminded");
    await releaseLinkEmail(eve);
    await later(0);
    expect(Date.parse((await screenOf(eve)).expiresAt!)).toBe(now().getTime() + 120 * HOUR);
    await later(119 * HOUR);
    expect((await screenOf(eve)).status).toBe("reminded");
    await later(2 * HOUR);
    expect((await screenOf(eve)).status).toBe("expired");
  });

  it("a paused AI interview says why 'Send a reminder' waits, never that a reminder went recently", async () => {
    const fay = await applyAs("Fay", "fay@column.test");
    await container.db.update(screens).set({ status: "paused", startedAt: now().toISOString() }).where(eq(screens.applicationId, fay));
    const d = await get<Detail & { aiInterview: { remindBlocked?: string } }>(`/api/v1/applications/${fay}`);
    expect(d.aiInterview).toMatchObject({ state: "started", canRemind: false, remindBlocked: "paused" });
    expect(d.blockedReasons.remind_screen).toBe("Their AI interview is paused while the assistant is not working; it carries on by itself, and they are emailed when it does.");
    const refused = await remind(fay);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("interview_paused");
  });
});
