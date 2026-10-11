import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Actor, ApplicationStage, CancelNext, FollowUpKind } from "@ros/contracts";
import { entitlements, openFollowUp, setAutoState, setCurrentInterview, type FollowUpEntryAuto } from "@ros/core";
import { detectStuckRoles } from "@ros/agents";
import { applications, candidates, communications, interviewFollowups, interviews, randomToken, users, withTenant, type Tx } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import type { RoleReport } from "./services/role-report";
import { signInAs } from "./test-helpers";

const DAY = 86_400_000;

/**
 * The Cancelled column on the read side (founder decisions 1A to 4A): the roles list (a GROUP BY with one EXISTS column
 * for "an interview is being set up or offered"), the Talent list and the role report put the same people in the same
 * groups (J18); Today has one Cancelled card per role, naming only the people with nothing in motion, and never names
 * anyone under Cancelled a second time (needs your review, Decide after the interview, the long wait).
 */
describe("the Cancelled column: counts, groups and Today", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerActor: Actor;
  let companyId = "";
  let roleId = "";
  let roleTitle = "";
  const ids: Record<string, string> = {};
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const candidate: Actor = { kind: "candidate", id: "candidate" };
  /** Everyone has waited longer than the long-wait card's three days; the people under Cancelled longest of all. */
  const longAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  const followUpIdOf = async (tx: Tx, applicationId: string) => (await tx.select({ id: interviewFollowups.id }).from(interviewFollowups).where(eq(interviewFollowups.applicationId, applicationId)))[0].id;

  /** A candidate at `stage` with the interview they missed or cancelled (attempt 2), and their open follow-up when `followUp` is given. */
  async function person(first: string, stage: ApplicationStage, input: { interview: "cancelled" | "no_show" | "completed"; followUp?: { kind: FollowUpKind; choice: CancelNext | null; auto: FollowUpEntryAuto; at: string }; waitedDays: number }) {
    return withTenant(container.db, companyId, async (tx) => {
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: first, lastName: "Park", email: `${first.toLowerCase()}@cancelled.test`, firstSource: "direct" }).returning();
      const [a] = await tx.insert(applications).values({ companyId, roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage, statusToken: randomToken(16), stageChangedAt: longAgo(input.waitedDays) }).returning();
      const [iv] = await tx.insert(interviews).values({ companyId, applicationId: a.id, roundKey: "first", title: "First interview", format: "video", durationMinutes: 30, status: input.interview, attempt: 2, outcome: input.interview === "no_show" ? "no_show_candidate" : null, createdBy: ownerActor }).returning();
      if (input.followUp) await openFollowUp(tx, { companyId, applicationId: a.id, interviewId: iv.id, interviewAttempt: 2, kind: input.followUp.kind, choice: input.followUp.choice, auto: input.followUp.auto, actor: input.followUp.kind === "candidate_no_show" ? ownerActor : candidate, now: new Date(input.followUp.at) });
      return { applicationId: a.id, interviewId: iv.id, candidateId: cand.id };
    });
  }

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@cancelled.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const [user] = await container.db.select().from(users).where(eq(users.email, "owner@cancelled.test"));
    ownerActor = { kind: "user", id: user.id, name: "Olive Owner" };
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Cancelled Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    roleTitle = ((await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { title: string }).title;

    // Wes cancelled and asked for new times: they are promised for a day, so nothing waits on the team before it.
    ids.wes = (await person("Wes", "interview_recommended", { interview: "cancelled", waitedDays: 20, followUp: { kind: "candidate_cancelled", choice: "new_times", auto: { state: "waiting", dueAt: new Date(Date.now() + 5 * DAY).toISOString(), workingDays: 3 }, at: longAgo(20) } })).applicationId;
    // Pat's day came: the same interview was reopened for new times, which are being worked out (no email yet).
    const pat = await person("Pat", "interview_recommended", { interview: "cancelled", waitedDays: 19, followUp: { kind: "candidate_cancelled", choice: "new_times", auto: { state: "waiting", dueAt: longAgo(1), workingDays: 3 }, at: longAgo(19) } });
    ids.pat = pat.applicationId;
    await withTenant(container.db, companyId, async (tx) => {
      await tx.update(interviews).set({ status: "scheduling", attempt: 3 }).where(eq(interviews.id, pat.interviewId));
      const followUpId = await followUpIdOf(tx, pat.applicationId);
      await setCurrentInterview(tx, { followUpId, interviewId: pat.interviewId });
      await setAutoState(tx, { followUpId, to: "preparing", actor: { kind: "system", id: "workflow:interview_new_times" } });
    });
    // Oli did not come; the team set up the same round again and the email with the times is on its way.
    const oli = await person("Oli", "interview_complete", { interview: "no_show", waitedDays: 18, followUp: { kind: "candidate_no_show", choice: null, auto: { state: "none", reason: "no_show" }, at: longAgo(18) } });
    ids.oli = oli.applicationId;
    await withTenant(container.db, companyId, async (tx) => {
      await tx.update(interviews).set({ decision: "new_times", decisionNote: "New times sent after the candidate did not attend" }).where(eq(interviews.id, oli.interviewId));
      const [again] = await tx.insert(interviews).values({ companyId, applicationId: oli.applicationId, roundKey: "first", title: "First interview", format: "video", durationMinutes: 30, status: "scheduling", attempt: 1, createdBy: ownerActor }).returning();
      await tx.insert(communications).values({ companyId, candidateId: oli.candidateId, applicationId: oli.applicationId, direction: "outbound", channel: "email", bodyText: "Pick a time", templateKey: "interview_slots", status: "queued", sentBy: { kind: "system", id: "workflow:schedule_interview" }, idempotencyKey: `slots:${again.id}:1` });
      await setCurrentInterview(tx, { followUpId: await followUpIdOf(tx, oli.applicationId), interviewId: again.id });
    });
    // Nia did not come and Ned said he is no longer interested: nothing is on its way to either, so they wait on the team.
    ids.nia = (await person("Nia", "interview_complete", { interview: "no_show", waitedDays: 17, followUp: { kind: "candidate_no_show", choice: null, auto: { state: "none", reason: "no_show" }, at: longAgo(17) } })).applicationId;
    ids.ned = (await person("Ned", "interview_recommended", { interview: "cancelled", waitedDays: 16, followUp: { kind: "candidate_cancelled", choice: "not_interested", auto: { state: "none", reason: "not_asked" }, at: longAgo(16) } })).applicationId;
    // Not under Cancelled: Tom's interview is over and nobody decided; Ivy is recommended for an interview.
    ids.tom = (await person("Tom", "interview_complete", { interview: "completed", waitedDays: 12 })).applicationId;
    ids.ivy = (await person("Ivy", "interview_recommended", { interview: "cancelled", waitedDays: 10 })).applicationId;
  });
  afterAll(async () => {
    await container.close();
  });

  it("J18: the roles list, the Talent list and the report put everyone in the same column and group, whatever stands for their new times", async () => {
    type Row = { id: string; ownerStage: string; ownerStageLabel: string; group: string; cancelled: { reason: string; times: string; status: string } | null };
    const talent = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/applications?counts=1`)).json()) as { applications: Row[]; counts: { byOwnerStage: Record<string, number>; byGroup: Record<string, number>; cancelled: Record<string, number> } };
    const row = (id: string) => talent.applications.find((r) => r.id === id)!;
    // promised, being prepared, or out: in process; nothing in motion: waiting on you
    expect(row(ids.wes)).toMatchObject({ ownerStage: "cancelled", ownerStageLabel: "Asked for new times", group: "in_process", cancelled: { times: "none" } });
    expect(row(ids.pat)).toMatchObject({ ownerStage: "cancelled", group: "in_process", cancelled: { times: "preparing", status: "Getting new times ready" } });
    expect(row(ids.oli)).toMatchObject({ ownerStage: "cancelled", ownerStageLabel: "No-show", group: "in_process", cancelled: { reason: "no_show", times: "out" } });
    expect(row(ids.nia)).toMatchObject({ ownerStage: "cancelled", ownerStageLabel: "No-show", group: "waiting_on_you", cancelled: { status: "Waiting for you" } });
    expect(row(ids.ned)).toMatchObject({ ownerStage: "cancelled", ownerStageLabel: "No longer interested", group: "waiting_on_you" });
    expect(row(ids.tom)).toMatchObject({ ownerStage: "interviewing", group: "waiting_on_you", cancelled: null });
    expect(talent.counts.byOwnerStage).toMatchObject({ cancelled: 5, interviewing: 2 });
    expect(talent.counts.cancelled).toEqual({ askedNewTimes: 2, notInterested: 1, noShow: 2 });

    const roles = (await (await json(owner, "GET", "/api/v1/roles")).json()) as Array<{ id: string; counts: Record<string, number>; stageCounts: Record<string, number> }>;
    const mine = roles.find((r) => r.id === roleId)!;
    const report = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/report`)).json()) as RoleReport;
    expect(mine.stageCounts).toEqual(talent.counts.byOwnerStage);
    expect(report.stages.byOwnerStage).toEqual(talent.counts.byOwnerStage);
    for (const g of ["waiting_on_you", "waiting_on_candidate", "in_process", "not_moving_forward", "hired"] as const) {
      expect(mine.counts[g] ?? 0, g).toBe(talent.counts.byGroup[g]);
      expect(report.stages.byGroup[g], g).toBe(talent.counts.byGroup[g]);
    }
    expect(talent.counts.byGroup).toMatchObject({ in_process: 3, waiting_on_you: 4 });
    // the report's "waiting on you" names Nia and Ned by why they are under Cancelled
    expect(report.pendingDecisions.list.filter((p) => p.applicationId === ids.nia || p.applicationId === ids.ned).map((p) => p.label).sort()).toEqual(["Cancelled: no longer interested", "Cancelled: no-show"]);
    // the stage button's choices follow: new times only with nothing open; stopping only a set still waiting for its day
    const detail = async (id: string) => (await (await json(owner, "GET", `/api/v1/applications/${id}`)).json()) as { allowedActions: string[]; blockedReasons: Record<string, string> };
    expect((await detail(ids.nia)).allowedActions).toContain("send_new_times");
    expect((await detail(ids.oli)).blockedReasons.send_new_times).toBe("New times are already being prepared or are out to them.");
    expect((await detail(ids.wes)).allowedActions).toEqual(expect.arrayContaining(["send_new_times", "stop_new_times"]));
    expect((await detail(ids.pat)).blockedReasons.stop_new_times).toBe("Nothing is due to go to them automatically.");
  });

  it("Today: one Cancelled card per role naming only the people with nothing in motion, and nobody named twice", async () => {
    type Card = { kind: string; title: string; body: string; roleId?: string; applicationId?: string; actions: Array<{ label: string; path: string }> };
    const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Card[] };
    const cancelledCards = brief.cards.filter((c) => /under Cancelled/.test(c.title));
    expect(cancelledCards).toEqual([{ kind: "interviews", title: `2 people under Cancelled for ${roleTitle}`, body: "Nia Park (no-show), Ned Park (no longer interested). Send new times, or decide for each of them. Nothing is on its way to them now.", roleId, actions: [{ label: "See them", method: "GET", path: `/roles/${roleId}/talent?ownerStage=cancelled` }] }]);
    const others = brief.cards.filter((c) => c !== cancelledCards[0]);
    // nobody whose new times are promised, being prepared or out is named anywhere, and Nia and Ned only on their card
    for (const name of ["Wes Park", "Pat Park", "Oli Park", "Nia Park", "Ned Park"]) expect(others.some((c) => c.title.includes(name) || c.body.includes(name)), name).toBe(false);
    for (const id of [ids.wes, ids.pat, ids.oli, ids.nia, ids.ned]) expect(others.some((c) => c.applicationId === id)).toBe(false);
    // "needs your review" counts Ivy and not the five; "Decide after the interview" is Tom's alone
    expect(brief.cards.find((c) => c.kind === "needs_review" && c.roleId === roleId && /need(s)? your review/.test(c.title))?.title).toBe(`1 candidate needs your review for ${roleTitle}`);
    expect(brief.cards.filter((c) => c.title.startsWith("Decide after the interview")).map((c) => c.applicationId)).toEqual([ids.tom]);
    // the long wait names the person waiting longest who is not under Cancelled (they waited longer still)
    const longWait = brief.cards.find((c) => c.kind === "stuck" && c.roleId === roleId && /waiting on you/.test(c.title));
    expect(longWait?.applicationId).toBe(ids.tom);
    // HR can neither approve interviews nor decide after one, so the card is not theirs
    const hr = await signInAs(container, app, { companyId, role: "hr" });
    const hrBrief = (await (await json(hr, "GET", "/api/v1/brief")).json()) as { cards: Card[] };
    expect(hrBrief.cards.some((c) => /under Cancelled/.test(c.title))).toBe(false);
  });

  it("the stuck detector leaves everyone under Cancelled out of the people waiting on the team", async () => {
    const found = (await withTenant(container.db, companyId, (tx) => detectStuckRoles(tx, companyId, new Date()))).find((d) => d.detector === "candidates_waiting" && d.roleId === roleId);
    expect(found?.applicationIds).toEqual([ids.tom, ids.ivy]);
  });

  it("someone whose promised set the team stopped waits on them now, and joins the card (named first: under Cancelled longest)", async () => {
    await withTenant(container.db, companyId, async (tx) => setAutoState(tx, { followUpId: await followUpIdOf(tx, ids.wes), to: "not_sent", reason: "stopped_by_team", actor: ownerActor }));
    const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ title: string; body: string }> };
    const card = brief.cards.find((c) => /under Cancelled/.test(c.title))!;
    expect(card.title).toBe(`3 people under Cancelled for ${roleTitle}`);
    expect(card.body).toBe("Wes Park (asked for new times), Nia Park (no-show), Ned Park (no longer interested). Send new times, or decide for each of them. Nothing is on its way to them now.");
  });
});
