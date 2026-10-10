import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, like } from "drizzle-orm";
import type { ApplicationStage, MembershipRole } from "@ros/contracts";
import { STAGE_LABEL, anonymizeCandidate, can, canTransition, entitlements, ownerGroup, transition, type Permission } from "@ros/core";
import { detectStuckRoles } from "@ros/agents";
import { applications, candidates, communications, events, interviewFollowups, interviewParticipants, interviews, notifications, randomToken, screens, users, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { sendDecisionMessage } from "./services/application-actions";
import { exitCleanup } from "./services/exit-cleanup";
import { signInAs } from "./test-helpers";

/**
 * Closing the loop after an interview (audit findings F1 to F6, F9, F14 to F16, J13): the interviewers are told when
 * they are put on an interview; when it is over the candidate waits on a person, in the brief and on the Talent page,
 * with a link straight to their sheet; the decision lands on the right interview; "not moving forward" sends the
 * respectful message through the outbox; roles without the interview permissions never see the card and are refused.
 */
describe("the loop after an interview", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const BASE = (() => { const d = new Date(); d.setUTCHours(18, 0, 0, 0); return d.getTime(); })(); // 11:00 Pacific today
  const setClock = (offsetMs: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offsetMs); };
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const outbox = () => (container.integrations.email as FakeEmailAdapter).sent;
  const H = 3600_000;
  const DAY = 24 * H;

  type Brief = { summary: string; cards: Array<{ kind: string; title: string; body: string; applicationId?: string; actions: Array<{ label: string; method: string; path: string }> }> };
  type Detail = { stage: string; group: string; allowedActions: string[]; interviews: Array<{ id: string; roundKey: string; status: string; decision: string | null }>; interviewPlan: Array<{ key: string; title: string; interviewerUserIds: string[] }> };

  let owner = "";
  let ownerId = "";
  let companyId = "";
  let companySlug = "";
  let roleId = "";
  let plan: Array<{ key: string; title: string }> = [];
  let n = 0;

  const apply = async (first: string, last: string) => {
    n += 1;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}${n}@example.com`;
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    const form = new FormData();
    form.set("firstName", first);
    form.set("lastName", last);
    form.set("email", email);
    form.set("locationText", "Tustin, CA");
    form.set("resume", new File([`${first} ${last}, RDH\nRegistered Dental Hygienist at Coastal Family Dentistry 2019 - present\nSkills: periodontal charting`], "resume.txt", { type: "text/plain" }));
    for (const rule of role.currentPacket.packet.requirements.eligibility) form.set(`elig_${rule.key}`, "yes");
    form.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    form.set("acknowledged", "yes");
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: form });
    expect(r.status).toBe(302);
    await container.drain();
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId))).orderBy(desc(applications.createdAt)).limit(1);
    return { id: a.id, email, name: `${first} ${last}` };
  };
  const requestInterview = async (applicationId: string, extra: Record<string, unknown> = {}, cookie = owner) => {
    const r = await json(cookie, "POST", `/api/v1/applications/${applicationId}/interviews`, { roundKey: plan[0].key, interviewerUserIds: [ownerId], linkSource: "calendar", ...extra });
    expect(r.status, await r.clone().text()).toBe(201);
    return (await r.json()) as { id: string; status: string };
  };
  const interview = async (id: string) => (await container.db.select().from(interviews).where(eq(interviews.id, id)))[0];
  const application = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];
  const participants = async (id: string) => container.db.select().from(interviewParticipants).where(eq(interviewParticipants.interviewId, id));
  const told = (kind: string, userId?: string) => container.db.select().from(notifications).where(userId ? and(eq(notifications.companyId, companyId), eq(notifications.kind, kind), eq(notifications.userId, userId)) : and(eq(notifications.companyId, companyId), eq(notifications.kind, kind)));
  /** The candidate picks the first offered time; the workflow books it. */
  const book = async (interviewId: string) => {
    const row = await interview(interviewId);
    expect(row.status, "times must be on offer before the candidate can pick").toBe("scheduling");
    const r = await app.request(`/c/schedule/${row.scheduleToken}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ slotId: row.offeredSlots[0].id, timezone: "America/New_York" }).toString() });
    expect(r.status).toBe(302);
    await container.drain();
    expect((await interview(interviewId)).status).toBe("scheduled");
  };
  /** The clock passes the end of the interview; the workflow closes it and the candidate is at "Interview done". */
  const finish = async (interviewId: string) => {
    const row = await interview(interviewId);
    setClock(Date.parse(row.endsAt!) + 2 * H - BASE);
    await container.drain();
    expect((await interview(interviewId)).status).toBe("completed");
  };
  const detail = async (applicationId: string, cookie = owner) => {
    const r = await json(cookie, "GET", `/api/v1/applications/${applicationId}`);
    expect(r.status).toBe(200);
    return (await r.json()) as Detail;
  };
  const brief = async (cookie: string) => (await (await json(cookie, "GET", "/api/v1/brief")).json()) as Brief;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    setClock(0);
    owner = await signIn("owner@loop.test");
    const [u] = await container.db.select({ id: users.id }).from(users).where(eq(users.email, "owner@loop.test"));
    ownerId = u.id;
    await container.db.update(users).set({ name: "Dana Whitfield" }).where(eq(users.id, ownerId));
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Smile Bright Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Tustin", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    companySlug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = (await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json() as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "Looks right." })).status).toBe(200);
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { interviews: { plan: Array<{ key: string; title: string }> } } } };
    plan = role.currentPacket.packet.interviews.plan;
    expect(plan.length, "the next-round tests need a plan with two rounds").toBeGreaterThanOrEqual(2);
    // the owner interviews, so declared hours make times available
    expect((await json(owner, "PUT", "/api/v1/me/availability", { timezone: "America/Los_Angeles", windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 6 })).status).toBe(200);
    await container.drain();
  });
  afterAll(async () => {
    await container.close();
  });

  it("interviewers are told when they are put on an interview, confirmed by the booking, and invited again by a reschedule", async () => {
    const cand = await apply("Maria", "Reyes");
    const iv = await requestInterview(cand.id);
    const assigned = await told("interview.assigned", ownerId);
    expect(assigned.length).toBeGreaterThanOrEqual(1);
    expect(assigned.at(-1)).toMatchObject({ title: "You are interviewing Maria Reyes", action: { href: `/interviews/${iv.id}` } });
    expect(assigned.at(-1)!.body).toContain(plan[0].title);
    expect((await participants(iv.id)).map((p) => p.status)).toEqual(["invited"]);
    await book(iv.id);
    expect((await participants(iv.id)).map((p) => p.status)).toEqual(["confirmed"]);
    expect((await json(owner, "POST", `/api/v1/interviews/${iv.id}/reschedule`, { reason: "conflict" })).status).toBe(200);
    await container.drain();
    expect((await participants(iv.id)).map((p) => p.status)).toEqual(["invited"]);
    await book(iv.id);
    expect((await participants(iv.id)).map((p) => p.status)).toEqual(["confirmed"]);
  });

  it("when the interview is over the candidate waits on you: the group, the label, the deep link, the brief card and the stuck-role rule all say so", async () => {
    const cand = await apply("Luis", "Ortega");
    const iv = await requestInterview(cand.id);
    await book(iv.id);
    await finish(iv.id);
    expect((await application(cand.id)).stage).toBe("interview_complete");
    expect(ownerGroup("interview_complete")).toBe("waiting_on_you");
    expect(STAGE_LABEL.interview_complete).toBe("Interview done: decision needed");
    const decide = (await told("interview.decision")).filter((x) => x.action?.href.includes(cand.id));
    expect(decide.length).toBeGreaterThanOrEqual(1);
    expect(decide[0].action).toEqual({ label: "Decide", href: `/roles/${roleId}/talent?open=${cand.id}` });
    const list = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/applications`)).json()) as Array<{ id: string; group: string; stageLabel: string }>;
    expect(list.find((a) => a.id === cand.id)).toMatchObject({ group: "waiting_on_you", stageLabel: "Interview done: decision needed" });
    const d = await detail(cand.id);
    expect(d.allowedActions).toContain("record_decision");
    const card = (await brief(owner)).cards.find((c) => c.applicationId === cand.id);
    expect(card).toMatchObject({ kind: "decision", title: "Decide after the interview: Luis Ortega" });
    expect(card!.body).toContain(plan[0].title);
    expect(card!.actions[0]).toEqual({ label: "Decide", method: "GET", path: `/roles/${roleId}/talent?open=${cand.id}` });
    // the generic review card does not list them a second time
    expect((await brief(owner)).cards.filter((c) => c.kind === "needs_review").every((c) => !c.body.includes("Luis Ortega"))).toBe(true);
    // the stuck-role detector counts a candidate waiting after an interview among the decisions pending
    const stuck = await detectStuckRoles(container.db, companyId, new Date(Date.parse((await application(cand.id)).stageChangedAt) + 4 * DAY));
    const waiting = stuck.find((s) => s.detector === "candidates_waiting" && s.roleId === roleId);
    expect(waiting).toBeTruthy();
    expect(waiting!.body).toContain("decide after an interview");
  });

  it("next round returns the round key, the sheet lists that round, and the interview can be approved from there", async () => {
    const cand = await apply("Ana", "Silva");
    const iv = await requestInterview(cand.id);
    await book(iv.id);
    await finish(iv.id);
    const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/decision`, { decision: "next_round", note: "Strong on the phone." });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; stage: string; nextRoundKey: string | null; dispositionSent?: boolean };
    expect(body).toMatchObject({ ok: true, stage: "interview_complete", nextRoundKey: plan[1].key });
    expect(body.dispositionSent).toBeUndefined();
    expect((await interview(iv.id))).toMatchObject({ decision: "next_round", decisionNote: "Strong on the phone." });
    const d = await detail(cand.id);
    expect(d.allowedActions).not.toContain("record_decision");
    expect(d.allowedActions).toContain("interview");
    expect(d.interviews.find((i) => i.id === iv.id)?.decision).toBe("next_round");
    expect(d.interviewPlan.find((p) => p.key === body.nextRoundKey)).toBeTruthy();
    const nudge = (await brief(owner)).cards.find((c) => c.applicationId === cand.id);
    expect(nudge).toMatchObject({ kind: "decision", title: "Set up the next round: Ana Silva" });
    // the card opens the interview approval itself, filled in with the next round from the plan
    expect(nudge!.actions[0]).toEqual({ label: "Approve the next round", method: "GET", path: `/roles/${roleId}/talent?open=${cand.id}&step=interview` });
    const next = await requestInterview(cand.id, { roundKey: body.nextRoundKey });
    expect((await interview(next.id)).roundKey).toBe(plan[1].key);
    expect((await brief(owner)).cards.find((c) => c.applicationId === cand.id)).toBeUndefined();
  });

  it("declining after an interview is private: nothing goes until a person sends the decision message, through the outbox", async () => {
    const cand = await apply("Ben", "Okafor");
    const iv = await requestInterview(cand.id);
    await book(iv.id);
    await finish(iv.id);
    const before = outbox().filter((m) => m.to === cand.email).length;
    const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/decision`, { decision: "not_moving_forward", reason: "not_a_match_experience", note: "Needs more perio experience." });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, stage: "rejected", dispositionSent: false, candidateNotice: "not_told" });
    expect(await application(cand.id)).toMatchObject({ stage: "rejected", rejectReason: "not_a_match_experience", rejectNote: "Needs more perio experience.", toldState: "not_told" });
    await container.drain();
    expect(outbox().filter((m) => m.to === cand.email).slice(before)).toHaveLength(0);
    const decisionRows = () => container.db.select().from(communications).where(and(eq(communications.applicationId, cand.id), like(communications.templateKey, "disposition:%")));
    expect(await decisionRows()).toHaveLength(0);
    // a person sends it: one respectful message in the wording suggested for someone who met the team (Q28), and the
    // interview that already took place is not called off in it
    expect(await (await json(owner, "POST", `/api/v1/applications/${cand.id}/actions`, { action: "send_decision" })).json()).toMatchObject({ candidateNotice: "queued", wording: "after_interview" });
    const queued = await decisionRows();
    expect(queued).toHaveLength(1);
    expect(queued[0].templateKey).toBe("disposition:after_interview");
    await container.drain();
    const mail = outbox().filter((m) => m.to === cand.email).slice(before);
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toBe("Your application to Smile Bright Dental");
    expect(mail[0].text).toMatch(/Thank you for taking the time to meet the team at Smile Bright Dental\. After the interviews, the team has decided not to move forward/);
    expect(mail[0].text).not.toMatch(/cancelled/);
    expect((await application(cand.id)).toldState).toBe("sent");
    expect((await interview(iv.id)).decision).toBe("not_moving_forward");
    const rejected = await container.db.select().from(events).where(and(eq(events.type, "application.rejected"), eq(events.subjectId, cand.id)));
    expect(rejected[0].payload).toMatchObject({ byHuman: true, afterInterview: true, candidateTold: false });
  });

  it("the decision is recorded on the undecided interview, not on the newest finished one", async () => {
    const cand = await apply("Chloe", "Nguyen");
    const first = await requestInterview(cand.id);
    await container.db.update(interviews).set({ status: "completed", outcome: "happened" }).where(eq(interviews.id, first.id));
    await container.drain();
    const second = await requestInterview(cand.id, { roundKey: plan[1].key });
    await container.db.update(interviews).set({ status: "completed", outcome: "happened", decision: "next_round" }).where(eq(interviews.id, second.id));
    await container.db.update(applications).set({ stage: "interview_complete" }).where(eq(applications.id, cand.id));
    await container.drain();
    expect((await detail(cand.id)).allowedActions).toContain("record_decision");
    const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/decision`, { decision: "finalist", note: "Great with patients." });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ stage: "finalist" });
    expect((await interview(first.id)).decision).toBe("finalist");
    expect((await interview(second.id)).decision).toBe("next_round");
    const recorded = await container.db.select().from(events).where(and(eq(events.type, "interview.decision_recorded"), eq(events.subjectId, cand.id)));
    expect(recorded.at(-1)!.payload).toMatchObject({ decision: "finalist", interviewId: first.id });
    expect((await detail(cand.id)).allowedActions).not.toContain("record_decision");
  });

  it("recording that the interview took place moves the candidate on without waiting for the closing timer", async () => {
    const cand = await apply("Priya", "Raman");
    const iv = await requestInterview(cand.id);
    await book(iv.id);
    expect((await application(cand.id)).stage).toBe("interview_scheduled");
    expect((await json(owner, "POST", `/api/v1/interviews/${iv.id}/outcome`, { outcome: "happened" })).status).toBe(200);
    expect((await application(cand.id)).stage).toBe("interview_complete");
    // the hiring team is asked for their decision now, exactly as the closing timer would have asked, once
    const asked = (await told("interview.decision", ownerId)).filter((x) => x.action?.href === `/roles/${roleId}/talent?open=${cand.id}`);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ title: "How did it go with Priya Raman?", action: { label: "Decide" } });
    const completed = await container.db.select().from(events).where(and(eq(events.type, "interview.completed"), eq(events.subjectId, iv.id)));
    expect(completed).toHaveLength(1);
    expect(completed[0].payload).toMatchObject({ via: "outcome" });
    const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/decision`, { decision: "finalist" });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await application(cand.id)).stage).toBe("finalist");
    // the closing timer later finds the interview already over and does not ask a second time
    await finish(iv.id);
    expect((await told("interview.decision", ownerId)).filter((x) => x.action?.href === `/roles/${roleId}/talent?open=${cand.id}`)).toHaveLength(1);
    expect(await container.db.select().from(events).where(and(eq(events.type, "interview.completed"), eq(events.subjectId, iv.id)))).toHaveLength(1);
  });

  it("HR never sees the decision card and is refused, and so is an interviewer", async () => {
    const hr = await signInAs(container, app, { companyId, role: "hr", email: "holly.hr@loop.test", name: "Holly" });
    const interviewer = await signInAs(container, app, { companyId, role: "interviewer", email: "ivan.interviewer@loop.test", name: "Ivan" });
    const cand = await apply("Omar", "Haddad");
    const iv = await requestInterview(cand.id);
    await book(iv.id);
    await finish(iv.id);
    expect((await detail(cand.id)).allowedActions).toEqual(expect.arrayContaining(["record_decision", "interview"]));
    const mine = await detail(cand.id, hr);
    expect(mine.allowedActions).not.toContain("record_decision");
    expect(mine.allowedActions).not.toContain("interview");
    expect((await json(hr, "POST", `/api/v1/applications/${cand.id}/decision`, { decision: "finalist" })).status).toBe(403);
    expect((await json(hr, "POST", `/api/v1/applications/${cand.id}/interviews`, { roundKey: plan[1].key, interviewerUserIds: [ownerId] })).status).toBe(403);
    expect((await json(hr, "POST", `/api/v1/interviews/${iv.id}/reschedule`, {})).status).toBe(403);
    expect((await json(hr, "POST", `/api/v1/interviews/${iv.id}/cancel`, { reason: "no" })).status).toBe(403);
    expect((await json(hr, "POST", `/api/v1/interviews/${iv.id}/outcome`, { outcome: "happened" })).status).toBe(403);
    // HR's Today never asks them for a decision they cannot give; the owner's does
    expect((await brief(hr)).cards.some((c) => c.applicationId === cand.id)).toBe(false);
    expect((await brief(owner)).cards.find((c) => c.applicationId === cand.id)).toMatchObject({ kind: "decision", title: "Decide after the interview: Omar Haddad" });
    // an interviewer who is not on this interview is refused (or, under the application scope guard, does not see it at all)
    expect([403, 404]).toContain((await json(interviewer, "POST", `/api/v1/applications/${cand.id}/decision`, { decision: "finalist" })).status);
    expect((await interview(iv.id)).decision).toBeNull();
    expect((await application(cand.id)).stage).toBe("interview_complete");
  });

  it("an interviewer's Today shows their own interviews and nothing else", async () => {
    const interviewer = await signInAs(container, app, { companyId, role: "interviewer", email: "ivan.interviewer@loop.test" });
    const [ivan] = await container.db.select({ id: users.id }).from(users).where(eq(users.email, "ivan.interviewer@loop.test"));
    const cand = await apply("Sofia", "Marin");
    const iv = await requestInterview(cand.id, { interviewerUserIds: [ownerId, ivan.id] });
    expect((await told("interview.assigned", ivan.id)).at(-1)).toMatchObject({ title: "You are interviewing Sofia Marin", action: { label: "Open the interview", href: `/interviews/${iv.id}` } });
    const othersNames = ["Maria Reyes", "Luis Ortega", "Ana Silva", "Ben Okafor", "Chloe Nguyen", "Priya Raman", "Omar Haddad"];
    let b = await brief(interviewer);
    expect(b.cards.every((c) => c.kind === "interviews" || c.kind === "empty")).toBe(true);
    expect(b.cards.some((c) => c.kind === "interviews" && c.body.includes("Sofia Marin") && /being offered/.test(c.body))).toBe(true);
    for (const c of b.cards) for (const name of othersNames) { expect(c.title).not.toContain(name); expect(c.body).not.toContain(name); }
    expect(b.summary).toContain("1 being scheduled");
    // the owner's brief is the company's day, with candidate names and decisions
    const o = await brief(owner);
    expect(o.cards.some((c) => c.kind === "decision" || c.kind === "needs_review")).toBe(true);
    // the interviews list is theirs only
    const list = (await (await json(interviewer, "GET", "/api/v1/interviews")).json()) as Array<{ id: string; participants: Array<{ userId: string }> }>;
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.every((i) => i.participants.some((p) => p.userId === ivan.id))).toBe(true);
    await book(iv.id);
    expect((await participants(iv.id)).every((p) => p.status === "confirmed")).toBe(true);
    b = await brief(interviewer);
    expect(b.cards.find((c) => c.kind === "interviews")).toMatchObject({ title: "1 interview coming up" });
    expect(b.cards.find((c) => c.kind === "interviews")!.actions[0]).toEqual({ label: "Open interviews", method: "GET", path: "/interviews" });
    await finish(iv.id);
    b = await brief(interviewer);
    const ask = b.cards.find((c) => c.title === "Did the interview with Sofia Marin take place?");
    expect(ask).toBeTruthy();
    expect(ask!.actions[0]).toEqual({ label: "Record what happened", method: "GET", path: `/interviews/${iv.id}` });
    // a participant records the outcome of their own interview; the decision stays with the hiring team
    expect((await json(interviewer, "POST", `/api/v1/interviews/${iv.id}/outcome`, { outcome: "happened" })).status).toBe(200);
    expect((await brief(interviewer)).cards.some((c) => c.title.startsWith("Did the interview"))).toBe(false);
    expect((await brief(interviewer)).cards.some((c) => c.title.startsWith("Decide after"))).toBe(false);
    expect((await brief(owner)).cards.find((c) => c.applicationId === cand.id)).toMatchObject({ kind: "decision", title: "Decide after the interview: Sofia Marin" });
  });

  it("an HR member who sat on the interview records whether it took place; the decision still is not theirs", async () => {
    const hr = await signInAs(container, app, { companyId, role: "hr", email: "holly.hr@loop.test" });
    const [holly] = await container.db.select({ id: users.id }).from(users).where(eq(users.email, "holly.hr@loop.test"));
    const cand = await apply("Nadia", "Petrov");
    const iv = await requestInterview(cand.id, { interviewerUserIds: [ownerId, holly.id] });
    await book(iv.id);
    expect((await application(cand.id)).stage).toBe("interview_scheduled");
    const r = await json(hr, "POST", `/api/v1/interviews/${iv.id}/outcome`, { outcome: "happened" });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await interview(iv.id)).toMatchObject({ status: "completed", outcome: "happened" });
    expect((await application(cand.id)).stage).toBe("interview_complete");
    expect((await told("interview.decision", ownerId)).some((x) => x.action?.href === `/roles/${roleId}/talent?open=${cand.id}`)).toBe(true);
    expect((await json(hr, "POST", `/api/v1/applications/${cand.id}/decision`, { decision: "finalist" })).status).toBe(403);
    expect((await brief(hr)).cards.some((c) => c.applicationId === cand.id)).toBe(false);
    expect((await application(cand.id)).stage).toBe("interview_complete");
  });

  it("a recruiter holds the decision and may mark a finalist", async () => {
    const recruiter = await signInAs(container, app, { companyId, role: "recruiter", email: "rita.recruiter@loop.test", name: "Rita" });
    const cand = await apply("Elena", "Costa");
    const iv = await requestInterview(cand.id, {}, recruiter);
    await book(iv.id);
    await finish(iv.id);
    expect((await detail(cand.id, recruiter)).allowedActions).toContain("record_decision");
    expect((await brief(recruiter)).cards.find((c) => c.applicationId === cand.id)).toMatchObject({ kind: "decision", title: "Decide after the interview: Elena Costa" });
    const r = await json(recruiter, "POST", `/api/v1/applications/${cand.id}/decision`, { decision: "finalist", note: "Calm and thorough." });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, stage: "finalist" });
    expect((await application(cand.id)).stage).toBe("finalist");
    expect(await interview(iv.id)).toMatchObject({ decision: "finalist", decisionNote: "Calm and thorough." });
  });

  it("the permission matrix: owner, admin, hiring manager and recruiter hold the three interview permissions; HR and interviewers do not", () => {
    const table: Record<MembershipRole, boolean> = { owner: true, admin: true, hiring_manager: true, recruiter: true, hr: false, interviewer: false };
    for (const permission of ["interview.request", "interview.manage", "interview.decide"] as Permission[]) {
      for (const [role, allowed] of Object.entries(table) as Array<[MembershipRole, boolean]>) expect(can(role, permission), `${role} ${permission}`).toBe(allowed);
    }
    // the pre-existing permissions are untouched by the new ones
    expect(can("hr", "application.act")).toBe(true);
    expect(can("interviewer", "role.read")).toBe(true);
    expect(can("interviewer", "application.read")).toBe(false);
    // the state machine agrees with the matrix: every role that holds interview.decide may mark a finalist, and every
    // member who can sit on an interview may record that it ended
    for (const role of ["owner", "admin", "hiring_manager", "recruiter"] as MembershipRole[]) expect(canTransition("interview_complete", "finalist", role), `${role} finalist`).toBe(true);
    for (const role of ["hr", "interviewer"] as MembershipRole[]) expect(canTransition("interview_complete", "finalist", role), `${role} finalist`).toBe(false);
    for (const role of ["owner", "admin", "hiring_manager", "hr", "recruiter", "interviewer"] as MembershipRole[]) expect(canTransition("interview_scheduled", "interview_complete", role), `${role} ends an interview`).toBe(true);
  });

  /* ---------------------------------------------------------------------------------------------------------------- */
  /* Leaving the process cleans up (plan A9), and the candidate's status page (plan A1).                                */
  /* ---------------------------------------------------------------------------------------------------------------- */

  const sentTo = (email: string) => outbox().filter((m) => m.to === email).length;
  const mailTo = (email: string, from: number) => outbox().filter((m) => m.to === email).slice(from);
  const reminders = (email: string) => outbox().filter((m) => m.to === email && /^(Tomorrow|Soon|Reminder):/.test(m.subject)).length;
  const act = (id: string, body: Record<string, unknown>, cookie = owner) => json(cookie, "POST", `/api/v1/applications/${id}/actions`, body);
  const statusPage = async (id: string) => (await app.request(`/c/status/${(await application(id)).statusToken}`)).text();
  const statusWord = (html: string) => html.match(/<span>Status<\/span><strong>([^<]+)<\/strong>/)?.[1] ?? null;
  const withdraw = async (id: string) => app.request(`/c/status/${(await application(id)).statusToken}/withdraw`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ confirm: "yes" }).toString() });
  /** Moves the clock on from wherever it is now, and lets every timer that came due run. */
  const advance = async (ms: number) => { setClock(container.engine.clock().getTime() + ms - BASE); await container.drain(); };
  const seed = (stage: ApplicationStage) =>
    withTenant(container.db, companyId, async (tx) => {
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: "Sam", lastName: stage, email: `${stage}.${randomToken(4)}@seeded.test`, firstSource: "direct" }).returning();
      const [a] = await tx.insert(applications).values({ companyId, roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage, statusToken: randomToken(16) }).returning();
      return a.id;
    });

  it("a private decline calls off a booked interview and tells the candidate right away, with no reason, that it is off; the decision stays private, and the decision message sent later does not repeat the interview; no reminder follows", async () => {
    const cand = await apply("Hana", "Kim");
    const iv = await requestInterview(cand.id);
    await book(iv.id);
    const booked = await interview(iv.id);
    const before = sentTo(cand.email);
    const remindedBefore = reminders(cand.email);
    const r = await act(cand.id, { action: "reject", reason: "not_a_match_experience", note: "Wants a front-desk role." });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ stage: "rejected", candidateNotice: "not_told", dispositionSent: false, interviewsCancelled: 1, interviewOffNotes: 1 });
    await container.drain();
    expect(await interview(iv.id)).toMatchObject({ status: "cancelled", attempt: booked.attempt + 1, scheduleToken: booked.scheduleToken });
    // the candidate is told now that the interview is off, so nobody turns up to it: a short note, no reason, no decision
    const note = mailTo(cand.email, before);
    expect(note).toHaveLength(1);
    expect(note[0].subject).toBe(`Cancelled: ${booked.title} at Smile Bright Dental`);
    expect(note[0].text).toMatch(/is cancelled, so there is no need to attend\./);
    expect(note[0].text).not.toMatch(/decided not to move forward|front-desk|not_a_match|in touch about next steps/);
    expect((await container.db.select().from(events).where(and(eq(events.type, "interview.cancelled"), eq(events.subjectId, iv.id))))[0].payload).toMatchObject({ candidateTold: true, cause: "left_process" });
    // the decision itself stays private: not told, and the status page does not show it
    expect((await application(cand.id)).toldState).toBe("not_told");
    expect(await statusPage(cand.id)).not.toMatch(/did not work out|not moving forward/i);
    // the interviewer is told in a sentence, not a reason code
    expect((await told("interview.cancelled", ownerId)).some((n) => n.title === `Interview cancelled: ${booked.title}` && n.body === "The candidate is no longer in the process, so this interview is off.")).toBe(true);
    // the old link is refused with a page that says the interview is off, and nothing about why
    const confirmed = await app.request(`/c/schedule/${booked.scheduleToken}/confirmed`);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.text()).toContain("This interview was cancelled");
    expect((await app.request(`/c/schedule/${booked.scheduleToken}`)).status).toBe(410);
    // the decision message a person sends later does not tell them a second time that the interview is off
    const preview = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}/decision-message`)).json()) as { text: string };
    expect(preview.text).toMatch(/decided not to move forward/);
    expect(preview.text).not.toMatch(/no need to attend|is cancelled/);
    expect(await (await act(cand.id, { action: "send_decision" })).json()).toMatchObject({ candidateNotice: "queued" });
    await container.drain();
    const mail = mailTo(cand.email, before);
    expect(mail).toHaveLength(2);
    expect(mail[1].text).toMatch(/decided not to move forward/);
    expect(mail[1].text).not.toContain(`The ${booked.title} on `);
    expect(mail[1].text).not.toMatch(/no need to attend|is cancelled/);
    expect(mail[1].text).not.toMatch(/front-desk|not_a_match/);
    // the scheduling run is stale: past the interview's time, no reminder reached them
    setClock(Date.parse(booked.startsAt!) + H - BASE);
    await container.drain();
    expect(reminders(cand.email)).toBe(remindedBefore);
    expect(mailTo(cand.email, before)).toHaveLength(2);
  });

  it("moving someone with times on offer to the talent pool tells them right away, with no reason, that the times are gone; the link says so, no reminder follows, and the decision message does not repeat it", async () => {
    const cand = await apply("Ivo", "Novak");
    const iv = await requestInterview(cand.id);
    const offered = await interview(iv.id);
    expect(offered.status).toBe("scheduling");
    const before = sentTo(cand.email);
    const r = await act(cand.id, { action: "move_to_talent_pool", note: "Better for the autumn opening." });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ stage: "talent_pool", candidateNotice: "not_told", interviewsCancelled: 1, interviewOffNotes: 1 });
    await container.drain();
    expect((await interview(iv.id)).status).toBe("cancelled");
    const note = mailTo(cand.email, before);
    expect(note).toHaveLength(1);
    expect(note[0].subject).toMatch(/^Cancelled:/);
    expect(note[0].text).toContain(`The interview times Smile Bright Dental offered you for ${offered.title} are no longer available, so there is no need to pick one.`);
    expect(note[0].text).not.toMatch(/talent pool|autumn|decided not to move forward/i);
    expect((await application(cand.id)).toldState).toBe("not_told");
    const page = await app.request(`/c/schedule/${offered.scheduleToken}`);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain("These interview times are no longer available");
    const pick = await app.request(`/c/schedule/${offered.scheduleToken}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ slotId: offered.offeredSlots[0].id, timezone: "America/New_York" }).toString() });
    expect(pick.status).toBe(410);
    expect((await interview(iv.id)).selectedSlot).toBeNull();
    // the offer's reminder never goes (this suite's clock runs days ahead of the decision, so the untold safety net,
    // Q27, may have sent the decision message by now: that is not the offer's reminder)
    await advance(3 * DAY);
    expect(mailTo(cand.email, before).filter((m) => !/^Your application to/.test(m.subject))).toHaveLength(1);
    // the decision message, when someone sends it, does not say the times are gone a second time
    const preview = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}/decision-message`)).json()) as { text: string };
    expect(preview.text).not.toContain(`The times we offered you for the ${offered.title}`);
    expect(preview.text).not.toMatch(/no need to pick one/);
  });

  it("a candidate who withdraws on the status page has the booked interview called off, with a note confirming it", async () => {
    const cand = await apply("Jon", "Park");
    const iv = await requestInterview(cand.id);
    await book(iv.id);
    const before = sentTo(cand.email);
    expect((await withdraw(cand.id)).status).toBe(302);
    await container.drain();
    expect((await application(cand.id)).stage).toBe("withdrawn");
    expect((await interview(iv.id)).status).toBe("cancelled");
    const mail = mailTo(cand.email, before);
    const cancelled = mail.filter((m) => /^Cancelled:/.test(m.subject));
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].text).toContain("As requested");
    expect(mail.some((m) => /withdrawal/i.test(m.text))).toBe(true);
    const html = await statusPage(cand.id);
    expect(statusWord(html)).toBe("Decision");
    expect(html).toContain("You withdrew this application.");
    expect(html).not.toMatch(/reactivate|change your mind/i);
  });

  it("an outcome the team records (the candidate withdrew by phone) calls off the booked interview with a plain note", async () => {
    const cand = await apply("Kim", "Adler");
    const iv = await requestInterview(cand.id);
    await book(iv.id);
    const before = sentTo(cand.email);
    const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/outcome`, { outcome: "candidate_withdrew", confirm: true, note: "Took another job." });
    expect(r.status, await r.clone().text()).toBe(201);
    await container.drain();
    expect((await interview(iv.id)).status).toBe("cancelled");
    const mail = mailTo(cand.email, before);
    expect(mail).toHaveLength(1);
    expect(mail[0].text).toMatch(/is cancelled, so there is no need to attend\./);
    expect(mail[0].text).not.toContain("Took another job");
  });

  it("when the decision message goes in the same transaction as the cancellation, the candidate gets one message that says both", async () => {
    const cand = await apply("Noa", "Weiss");
    const iv = await requestInterview(cand.id);
    await book(iv.id);
    const before = sentTo(cand.email);
    const actor = { kind: "user" as const, id: ownerId, name: "Dana Whitfield" };
    await withTenant(container.db, companyId, async (tx) => {
      await transition(tx, { applicationId: cand.id, companyId, to: "rejected", by: "owner", actor, reason: "position_filled" });
      expect(await exitCleanup(tx, container, { companyId, applicationId: cand.id, reason: "declined: position_filled", actor, candidateEmail: "with_decision_message" })).toMatchObject({ interviewsCancelled: 1, candidateNotes: 0 });
      const [row] = await tx.select().from(applications).where(eq(applications.id, cand.id));
      expect((await sendDecisionMessage(tx, container, { app: row, actor })).notice).toBe("queued");
    });
    await container.drain();
    expect((await interview(iv.id)).status).toBe("cancelled");
    const mail = mailTo(cand.email, before);
    expect(mail).toHaveLength(1);
    // declined as "position filled", so the wording suggested for that reason (Q28)
    expect(mail[0].text).toMatch(/The position has now been filled/);
    expect(mail[0].text).toMatch(/is cancelled, so there is no need to attend\./);
  });

  it("withdrawing inside the screening conversation (WITHDRAW, then CONFIRM) leaves the process like every exit: offered times are called off with a note, and nothing promises a way back", async () => {
    const cand = await apply("Rui", "Costa");
    const [scr] = await container.db.select().from(screens).where(eq(screens.applicationId, cand.id)).orderBy(desc(screens.createdAt)).limit(1);
    expect(scr, "applying opens a screen in this role").toBeTruthy();
    const iv = await requestInterview(cand.id);
    expect((await interview(iv.id)).status).toBe("scheduling");
    const before = sentTo(cand.email);
    const say = (message: string) => app.request(`/c/screen/${scr.token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ message }).toString() });
    expect((await say("WITHDRAW")).status).toBe(302);
    expect((await say("CONFIRM")).status).toBe(302);
    await container.drain();
    expect((await application(cand.id)).stage).toBe("withdrawn");
    expect((await interview(iv.id)).status).toBe("cancelled");
    expect(mailTo(cand.email, before).filter((m) => /^Cancelled:/.test(m.subject))).toHaveLength(1);
    const [after] = await container.db.select().from(screens).where(eq(screens.id, scr.id));
    const last = after.transcript.at(-1)?.content ?? "";
    expect(last).toMatch(/^Understood, we have withdrawn your application for .*\. Thank you for your time\.$/);
    expect(last).not.toMatch(/change your mind|reply to any of our emails/);
  });

  it("a deletion ends the person's part in the process: the interviewers are told the booked interview is off, nothing is written to the candidate, the application is withdrawn", async () => {
    const cand = await apply("Mia", "Rossi");
    const iv = await requestInterview(cand.id);
    await book(iv.id);
    const before = sentTo(cand.email);
    const { candidateId } = await application(cand.id);
    await withTenant(container.db, companyId, (tx) => anonymizeCandidate(tx, { companyId, candidateId, actor: { kind: "system", id: "interview-loop.test" }, deleteFile: async () => undefined, now: container.engine.clock() }));
    await container.drain();
    expect(await interview(iv.id)).toMatchObject({ status: "cancelled", cancelReason: "the candidate asked for their information to be deleted" });
    expect(mailTo(cand.email, before)).toHaveLength(0);
    expect((await application(cand.id)).stage).toBe("withdrawn");
    expect((await told("interview.cancelled", ownerId)).some((n) => n.body === "The candidate asked for their information to be deleted, so this interview is off.")).toBe(true);
  });

  it("the status page speaks in the candidate's four steps, never the team's stage names", async () => {
    const cases: Array<[ApplicationStage, string]> = [["applied", "Received"], ["received", "Received"], ["ineligible", "Under review"], ["triaged", "Under review"], ["screen_complete", "Under review"], ["interview_recommended", "Under review"], ["interview_complete", "Interview"], ["finalist", "Under review"], ["offer_sent", "Decision"], ["hired", "Decision"], ["withdrawn", "Decision"]];
    for (const [stage, word] of cases) {
      const html = await statusPage(await seed(stage));
      expect(statusWord(html), stage).toBe(word);
      expect(html, stage).toContain('aria-current="step"');
      expect(html, stage).toContain("make every decision about your application");
      expect(html, stage).not.toMatch(/Recommended for interview|Finalist|eligibility answers did not match|reactivate/i);
    }
  });

  it("a decision shows only once the candidate was told: until then the page stands where it was and withdrawing stays open; only messages that left are listed", async () => {
    const cand = await apply("Lia", "Moreau");
    const token = (await application(cand.id)).statusToken;
    let html = await statusPage(cand.id);
    expect(statusWord(html)).toBe("Under review");
    expect(html).toContain("Start the screening conversation");
    expect((await act(cand.id, { action: "reject", reason: "not_a_match_experience" })).status).toBe(200);
    await container.drain();
    html = await statusPage(cand.id);
    expect(statusWord(html)).toBe("Under review");
    expect(html).not.toMatch(/did not work out|not moving forward/i);
    expect(html).not.toContain("Start the screening conversation"); // the screen closed with the decision
    expect(html).toContain(`/c/status/${token}/withdraw`);
    // a message still in the outbox is not shown as sent
    const { candidateId } = await application(cand.id);
    await withTenant(container.db, companyId, (tx) => tx.insert(communications).values({ companyId, candidateId, applicationId: cand.id, direction: "outbound", channel: "email", subject: "Still waiting to go", bodyText: "not sent yet", status: "queued", sentBy: { kind: "system", id: "test" } }));
    expect(await statusPage(cand.id)).not.toContain("Still waiting to go");
    expect(html).toContain("We received your application");
    // she withdraws before anyone told her: allowed, and recorded as hers
    expect((await withdraw(cand.id)).status).toBe(302);
    expect((await application(cand.id)).stage).toBe("withdrawn");
    const moves = await container.db.select().from(events).where(and(eq(events.type, "application.stage_changed"), eq(events.subjectId, cand.id)));
    expect(moves.at(-1)!.payload).toMatchObject({ from: "rejected", to: "withdrawn" });
    expect(moves.at(-1)!.actor).toMatchObject({ kind: "candidate" });
    expect(statusWord(await statusPage(cand.id))).toBe("Decision");

    // someone who was told sees the decision and the message, and can no longer withdraw
    const other = await apply("Ola", "Berg");
    expect((await act(other.id, { action: "reject", reason: "not_a_match_experience" })).status).toBe(200);
    expect((await act(other.id, { action: "send_decision" })).status).toBe(200);
    await container.drain();
    html = await statusPage(other.id);
    expect(statusWord(html)).toBe("Decision");
    expect(html).toContain("This role did not work out");
    expect(html).toContain("Your application to Smile Bright Dental");
    expect(html).not.toContain("/withdraw");
    expect((await withdraw(other.id)).status).toBe(302);
    expect((await application(other.id)).stage).toBe("rejected");
  });

  /* ---------------------------------------------------------------------------------------------------------------- */
  /* The Cancelled column (founder decisions 1A to 4A): leaving the process, a no-show's round, "Next round".           */
  /* ---------------------------------------------------------------------------------------------------------------- */

  const followUpOf = async (applicationId: string) => (await container.db.select().from(interviewFollowups).where(eq(interviewFollowups.applicationId, applicationId)).orderBy(desc(interviewFollowups.createdAt)))[0];
  /** The candidate cancels their booked interview from the confirmed page, with their choice. */
  const candidateCancels = async (interviewId: string, next: "new_times" | "not_interested") => {
    const row = await interview(interviewId);
    const r = await app.request(`/c/schedule/${row.scheduleToken}/cancel`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ confirm: "yes", next }).toString() });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/c/schedule/${row.scheduleToken}/cancelled`);
    await container.drain();
    return followUpOf((await interview(interviewId)).applicationId);
  };

  it("leaving the process takes someone out of Cancelled: a private decline and a withdrawal resolve their row, and nothing goes to them automatically", async () => {
    const declined = await apply("Ines", "Duarte");
    const iv = await requestInterview(declined.id);
    await book(iv.id);
    expect(await candidateCancels(iv.id, "new_times")).toMatchObject({ choice: "new_times", autoState: "waiting", resolvedAt: null });
    expect((await act(declined.id, { action: "reject", reason: "not_a_match_experience" })).status).toBe(200);
    expect(await followUpOf(declined.id)).toMatchObject({ resolvedHow: "left_process", autoState: "not_sent", autoReason: "left_process" });
    const left = await container.db.select().from(events).where(and(eq(events.type, "application.left_cancelled"), eq(events.subjectId, declined.id)));
    expect(left.at(-1)?.payload).toMatchObject({ how: "left_process", autoStopped: true });
    // the decision stays private, and nothing promises the new times that will no longer come
    const html = await statusPage(declined.id);
    expect(html.match(/<h2>What happens next<\/h2><p>([^<]*)<\/p>/)?.[1]).toBe("The hiring team is reviewing your application. You will hear from them either way.");
    expect(html).not.toMatch(/did not work out/);

    const withdrew = await apply("Owen", "Price");
    const iv2 = await requestInterview(withdrew.id);
    await book(iv2.id);
    expect(await candidateCancels(iv2.id, "not_interested")).toMatchObject({ choice: "not_interested", autoState: "none", resolvedAt: null });
    expect((await withdraw(withdrew.id)).status).toBe(302);
    await container.drain();
    expect(await followUpOf(withdrew.id)).toMatchObject({ resolvedHow: "left_process", autoState: "none" });
  });

  it("after a candidate's no-show the approval card proposes the same round again, and 'Next round' takes them out of Cancelled; after an interviewer's no-show the card proposes the next round", async () => {
    const missed = await apply("Yara", "Haddad");
    const iv = await requestInterview(missed.id);
    await book(iv.id);
    expect((await json(owner, "POST", `/api/v1/interviews/${iv.id}/outcome`, { outcome: "no_show_candidate" })).status).toBe(200);
    expect(await followUpOf(missed.id)).toMatchObject({ kind: "candidate_no_show", resolvedAt: null });
    const draft = (await (await json(owner, "GET", `/api/v1/applications/${missed.id}/interview-draft`)).json()) as { roundKey: string; nextRound: boolean };
    expect(draft).toMatchObject({ roundKey: plan[0].key, nextRound: false });
    // a person decides on the next round anyway: they leave the column, and the no-show stays on record
    const r = await json(owner, "POST", `/api/v1/applications/${missed.id}/decision`, { decision: "next_round" });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await followUpOf(missed.id)).toMatchObject({ resolvedHow: "moved_by_team", resolvedBy: { kind: "user", id: ownerId } });
    expect(await interview(iv.id)).toMatchObject({ status: "no_show", outcome: "no_show_candidate", decision: "next_round" });

    const stoodUp = await apply("Zane", "Ito");
    const iv2 = await requestInterview(stoodUp.id);
    await book(iv2.id);
    expect((await json(owner, "POST", `/api/v1/interviews/${iv2.id}/outcome`, { outcome: "no_show_interviewer" })).status).toBe(200);
    expect(await followUpOf(stoodUp.id)).toBeUndefined();
    const next = (await (await json(owner, "GET", `/api/v1/applications/${stoodUp.id}/interview-draft`)).json()) as { roundKey: string; nextRound: boolean };
    expect(next).toMatchObject({ roundKey: plan[1].key, nextRound: true });
  });

  // Last: it closes the role.
  it("closing the role ends every interview still to come: whoever held a booked time or offered times is told right away, with no reason, that it is off; the decision stays private, and the decision message sent later does not repeat it", async () => {
    const a = await apply("Oli", "Grant");
    const ivA = await requestInterview(a.id);
    await book(ivA.id);
    const b = await apply("Pia", "Sato");
    const ivB = await requestInterview(b.id);
    const offeredB = await interview(ivB.id);
    const beforeA = sentTo(a.email);
    const beforeB = sentTo(b.email);
    const r = await json(owner, "POST", `/api/v1/roles/${roleId}/outcome`, { outcome: "role_cancelled", confirm: true, reason: "Budget pulled." });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ interviewsCancelled: 2, interviewOffNotes: 2 });
    await container.drain();
    expect((await interview(ivA.id)).status).toBe("cancelled");
    expect((await interview(ivB.id)).status).toBe("cancelled");
    expect((await application(a.id)).stage).toBe("talent_pool");
    // each is told now that their interview is off, in a short note that gives no reason and says nothing of the decision
    const noteA = mailTo(a.email, beforeA);
    expect(noteA).toHaveLength(1);
    expect(noteA[0].subject).toMatch(/^Cancelled:/);
    expect(noteA[0].text).toMatch(/is cancelled, so there is no need to attend\./);
    const noteB = mailTo(b.email, beforeB);
    expect(noteB).toHaveLength(1);
    expect(noteB[0].text).toMatch(/are no longer available, so there is no need to pick one\./);
    for (const m of [...noteA, ...noteB]) expect(m.text).not.toMatch(/Budget|decided not to move forward|talent pool/i);
    expect((await application(a.id)).toldState).toBe("not_told");
    expect((await application(b.id)).toldState).toBe("not_told");
    expect((await app.request(`/c/schedule/${offeredB.scheduleToken}`)).status).toBe(410);
    // the decision message, when someone sends it, does not say the interview is off a second time
    expect(await (await act(a.id, { action: "send_decision" })).json()).toMatchObject({ candidateNotice: "queued" });
    await container.drain();
    const mailA = mailTo(a.email, beforeA);
    expect(mailA).toHaveLength(2);
    expect(mailA[1].subject).not.toMatch(/^Cancelled:/);
    expect(mailA[1].text).not.toMatch(/no need to attend|is cancelled/);
    expect(mailA[1].text).not.toContain("Budget");
  });
});
