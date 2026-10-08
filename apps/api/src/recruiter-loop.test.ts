import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { anonymizeCandidate, createEscalation } from "@ros/core";
import { adminAlerts, applications, candidates, entitlements, escalationMessages, events, notifications, randomToken, recruiterEscalations, staffAccessGrants, users, withPlatform, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAdmin, signInAs, signInStaff } from "./test-helpers";

/**
 * The recruiter loop (plan items B4 to B8). The team's requests are listed on Today with their state, reply-by time, who
 * picked them up and the full answer; the answer reaches the person who asked and the owners in full with a link; the
 * team can add a note or reopen an answered request ("this didn't solve it"), which gives fresh, recorded access; urgent
 * requests go to the front of the queue with the same reply-by time, said before sending; and the plan's allowance of
 * recruiter requests counts the team's own requests without ever refusing one.
 */
describe("the recruiter loop", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerId = "";
  let hana = "";
  let hanaId = "";
  let abe = "";
  let abeId = "";
  let ivan = "";
  let kai = "";
  let companyId = "";
  let roleId = "";
  let applicationId = "";
  const mail = () => (container.integrations.email as FakeEmailAdapter).sent;
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const ask = async (cookie: string, body: Record<string, unknown>) => {
    const r = await json(cookie, "POST", "/api/v1/escalations", { kind: "ask", question: "Is Nia Brooks right for the evening shift?", ...body });
    expect(r.status).toBe(201);
    return (await r.json()) as { id: string; slaDueAt: string; message: string };
  };
  const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
  type View = { id: string; status: string; askedBy: { kind: string; name: string | null }; recruiterName: string | null; roleTitle: string | null; candidateName: string | null; scope: string; reopenedCount: number; resolution: string | null; slaDueAt: string; thread: Array<{ kind: string; side: string; body: string; by: string | null }> };
  const mine = async (cookie: string) => (await (await json(cookie, "GET", "/api/v1/escalations/mine")).json()) as View[];
  const noticesFor = (userId: string, kind: string) => container.db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.kind, kind)));
  const idOf = async (email: string) => (await container.db.select().from(users).where(eq(users.email, email)))[0].id;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@loop.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    ownerId = await idOf("owner@loop.test");
    // a trial company: its plan includes one recruiter request
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Loop Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    applicationId = await withTenant(container.db, companyId, async (tx) => {
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: "Nia", lastName: "Brooks", email: "nia.brooks@example.com", firstSource: "direct" }).returning();
      const [a] = await tx.insert(applications).values({ companyId, roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage: "triaged", statusToken: randomToken(16) }).returning();
      return a.id;
    });
    hana = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hana@loop.test", name: "Hana Manager" });
    hanaId = await idOf("hana@loop.test");
    abe = await signInAs(container, app, { companyId, role: "admin", email: "abe@loop.test", name: "Abe Admin" });
    abeId = await idOf("abe@loop.test");
    ivan = await signInAs(container, app, { companyId, role: "interviewer", email: "ivan@loop.test", name: "Ivan Interviewer" });
    kai = await signInStaff(app, container, "kai@its.test", "its_recruiter", "Kai Recruiter");
  });
  afterAll(async () => {
    await container.close();
  });

  let urgentId = "";

  it("the form shows the reply-by time before sending; urgent says what it does and keeps the same time; interviewers cannot ask", async () => {
    const estimate = await json(hana, "GET", "/api/v1/escalations/estimate?kind=ask");
    expect(estimate.status).toBe(200);
    const est = (await estimate.json()) as { slaDueAt: string; businessHours: number; message: string; hours: string; allowance: { counted: boolean; used: number; limit: number | null; message: string } };
    expect(est.businessHours).toBe(8);
    expect(est.message).toMatch(/^If you send it now, a recruiter will respond by .+ Pacific\. Business hours are Monday to Friday, 9 to 5 Pacific\.$/);
    // which of the plan's recruiter requests it would be, said before sending (Q33); a talk about the plan is never counted
    expect(est.allowance).toEqual({ counted: true, used: 0, limit: 1, message: "Your plan includes 1 recruiter request, and this would use it." });
    const planTalk = (await (await json(hana, "GET", "/api/v1/escalations/estimate?kind=ask&topic=plan")).json()) as { allowance: { counted: boolean; message: string } };
    expect(planTalk.allowance).toMatchObject({ counted: false, message: "Talking with ITS about your plan does not use one of your plan's recruiter requests." });
    expect((await json(hana, "GET", "/api/v1/escalations/estimate?kind=whatever")).status).toBe(400);
    const sent = await ask(hana, { applicationId, urgency: "high" });
    urgentId = sent.id;
    expect(sent.message).toContain("It is marked urgent, so it goes to the front of the ITS queue; the reply-by time is the same as for any request.");
    expect(Math.abs(Date.parse(sent.slaDueAt) - Date.parse(est.slaDueAt))).toBeLessThan(120_000);
    // the plan includes one request, and this is it: nothing about going over
    expect(sent.message).not.toMatch(/Your plan includes/);
    // an interviewer neither asks nor reads the team's requests (escalation.create)
    expect((await json(ivan, "GET", "/api/v1/escalations/estimate?kind=ask")).status).toBe(403);
    expect((await json(ivan, "GET", "/api/v1/escalations/mine")).status).toBe(403);
    expect((await json(ivan, "POST", "/api/v1/escalations", { kind: "ask", roleId, question: "Hm?" })).status).toBe(403);
  });

  let normalId = "";

  it("past the plan's allowance a request still goes through; the team is told plainly and ITS is flagged once, for billing", async () => {
    const second = await ask(owner, { roleId, question: "Can someone look at the whole shortlist?" });
    normalId = second.id;
    expect(second.message).toContain("Your plan includes 1 recruiter request and this is number 2. It goes ahead as usual; ITS will talk with you about the extra.");
    const third = await ask(owner, { scope: "company", question: "And our pay bands in general?" });
    expect(third.message).toContain("this is number 3");
    // asking ITS about more roles is a talk about the plan, not recruiting help: never counted, never flagged
    const plan = await ask(owner, { scope: "company", topic: "plan", question: "We would like to open more roles than our plan includes." });
    expect(plan.message).not.toMatch(/Your plan includes/);
    expect((await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, plan.id)))[0].billing).toEqual({ countsTowardAllowance: false, topic: "plan" });
    const [ent] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "recruiter_asks")));
    expect(ent).toMatchObject({ used: 3, limit: 1 });
    // the admin console's Customers tab flags the company for billing
    const admin = await signInAdmin(app, container, "ada.admin@identifiedtalent.com", "Ada Admin");
    const customers = (await (await app.request("/api/v1/admin/customers", { headers: { cookie: admin, "x-admin-reason": "test" } })).json()) as Array<{ id: string; recruiterAsks: { used: number; limit: number | null; over: boolean } }>;
    expect(customers.find((co) => co.id === companyId)?.recruiterAsks).toEqual({ used: 3, limit: 1, over: true });
    const [row] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, second.id));
    expect(row.billing).toEqual({ countsTowardAllowance: true, used: 2, limit: 1, overAllowance: true });
    const alerts = (await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "billing.recruiter_asks_over"))).filter((a) => a.companyId === companyId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe("Loop Dental has asked for more recruiter help than its plan includes");
    expect(alerts[0].body).toContain("Nothing was held up");
    // the Setup counter moves
    const co = (await (await json(owner, "GET", "/api/v1/companies/current")).json()) as { usage: Record<string, { used: number; limit: number | null }> };
    expect(co.usage.recruiter_asks).toEqual({ used: 3, limit: 1 });
  });

  it("the ITS queue lists urgent requests first, whatever their reply-by time", async () => {
    // a normal request due sooner than the urgent one (two business hours against eight), raised by the system, so the allowance is untouched
    const sooner = await withTenant(container.db, companyId, (tx) => createEscalation(tx, { companyId, roleId, kind: "negotiation", urgency: "normal", question: "Offer talks stalled.", requestedBy: { kind: "system", id: "test" } }));
    const queue = (await (await json(kai, "GET", "/api/v1/escalations")).json()) as Array<{ id: string; urgency: string; slaDueAt: string }>;
    const at = (id: string) => queue.findIndex((e) => e.id === id);
    expect(Date.parse(queue[at(sooner.id)].slaDueAt)).toBeLessThan(Date.parse(queue[at(urgentId)].slaDueAt));
    expect(at(urgentId)).toBeGreaterThanOrEqual(0);
    expect(at(urgentId)).toBeLessThan(at(sooner.id));
    expect(at(sooner.id)).toBeLessThan(at(normalId));
    expect(queue[0].urgency).toBe("high");
  });

  it("a recruiter inside the company asks without using the allowance; the team's list says who asked", async () => {
    expect((await json(kai, "POST", `/api/v1/escalations/${urgentId}/claim`)).status).toBe(200);
    expect((await json(kai, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
    const theirs = await ask(kai, { applicationId, kind: "review", question: "A second opinion on this candidate, please." });
    expect(theirs.message).not.toMatch(/Your plan includes/);
    const [ent] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "recruiter_asks")));
    expect(ent.used).toBe(3);
    const [row] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, theirs.id));
    expect(row.billing).toEqual({});
    const list = await mine(owner);
    expect(list.find((r) => r.id === theirs.id)!.askedBy).toEqual({ kind: "recruiter", name: "Kai Recruiter" });
    // the recruiter answers from the queue, never as the customer
    const note = await json(kai, "POST", `/api/v1/escalations/mine/${urgentId}/messages`, { body: "Writing as the customer?" });
    expect(note.status).toBe(403);
    expect((await errorOf(note)).code).toBe("staff_reply");
  });

  it("the list on Today: state, reply-by time, who asked and who picked it up", async () => {
    const forHana = (await mine(hana)).find((r) => r.id === urgentId)!;
    expect(forHana).toMatchObject({ status: "claimed", scope: "application", candidateName: "Nia Brooks", recruiterName: "Kai Recruiter", reopenedCount: 0, askedBy: { kind: "you", name: "Hana Manager" } });
    expect(forHana.roleTitle).toMatch(/hygienist/i);
    expect(forHana.thread.map((e) => e.kind)).toEqual(["question"]);
    expect((await mine(owner)).find((r) => r.id === urgentId)!.askedBy).toEqual({ kind: "team", name: "Hana Manager" });
    // everyone who may ask sees the team's requests, not only their own
    expect((await mine(abe)).map((r) => r.id)).toContain(urgentId);
    const company = (await mine(owner)).find((r) => r.scope === "company")!;
    expect(company).toMatchObject({ status: "open", recruiterName: null, roleTitle: null, candidateName: null });
  });

  it("notes go both ways while it is open: the recruiter is emailed that there is one (never its words), and their reply reaches the asker and the owners in full", async () => {
    const before = mail().length;
    const note = await json(hana, "POST", `/api/v1/escalations/mine/${urgentId}/messages`, { body: "She can only do Tuesday and Thursday evenings." });
    expect(note.status).toBe(201);
    expect(((await note.json()) as { recruiterTold: boolean }).recruiterTold).toBe(true);
    const told = mail().slice(before).filter((m) => m.to === "kai@its.test");
    expect(told).toHaveLength(1);
    expect(told[0].text).not.toContain("Tuesday");
    expect(told[0].text).toContain(`/recruiter/queue/${urgentId}`);
    // the recruiter reads it in the queue, under their grant
    const detail = (await (await json(kai, "GET", `/api/v1/escalations/${urgentId}`)).json()) as { accessGranted: boolean; thread: Array<{ kind: string; side: string; body: string; by: string | null }> };
    expect(detail.accessGranted).toBe(true);
    expect(detail.thread.map((e) => [e.kind, e.side])).toEqual([["question", "customer"], ["reply", "customer"]]);
    // the team's names stay with the company: the recruiter's copy of the thread carries none
    expect(detail.thread.map((e) => e.by)).toEqual([null, null]);
    expect(JSON.stringify(detail.thread)).not.toContain("Hana");
    // and writes back without resolving: in progress, and the asker and the owners have it in full
    const long = `Thanks. ${"Evening availability matters for this role. ".repeat(10)}Could you also share her license number?`;
    expect(long.length).toBeGreaterThan(300);
    const reply = await json(kai, "POST", `/api/v1/escalations/${urgentId}/messages`, { body: long });
    expect(reply.status).toBe(201);
    const [row] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, urgentId));
    expect(row.status).toBe("in_progress");
    for (const id of [hanaId, ownerId]) {
      const [n] = await noticesFor(id, "recruiter.replied");
      expect(n.body).toBe(long);
      expect(n.title).toMatch(/^Kai Recruiter \(ITS recruiter\) wrote to you about a candidate for /);
      expect(n.title).not.toContain("Nia");
      expect(n.action).toEqual({ label: "Open the request", href: `/?request=${urgentId}` });
    }
    // an admin who did not ask is not told (they see it in the list)
    expect(await noticesFor(abeId, "recruiter.replied")).toHaveLength(0);
    expect((await container.db.select().from(events).where(and(eq(events.type, "customer.replied"), eq(events.subjectId, urgentId))))).toHaveLength(1);
    // only the recruiter holding it writes; nobody writes on what nobody holds
    const lee = await signInStaff(app, container, "lee@its.test", "its_recruiter", "Lee Recruiter");
    expect((await json(lee, "POST", `/api/v1/escalations/${urgentId}/messages`, { body: "Me too." })).status).toBe(403);
    expect((await json(hana, "POST", `/api/v1/escalations/mine/${urgentId}/messages`, { body: "" })).status).toBe(400);
    expect((await json(hana, "POST", "/api/v1/escalations/mine/00000000-0000-4000-8000-000000000000/messages", { body: "Hello?" })).status).toBe(404);
  });

  it("the answer reaches the person who asked and the owners in full, with a link to the request; it is kept on the thread", async () => {
    const answer = `Yes, interview her. ${"She has run evening clinics before and her references say so. ".repeat(8)}`;
    expect(answer.length).toBeGreaterThan(300);
    expect((await json(kai, "POST", `/api/v1/escalations/${urgentId}/resolve`, { resolution: answer, minutesSpent: 20 })).status).toBe(200);
    for (const id of [hanaId, ownerId]) {
      const [n] = await noticesFor(id, "recruiter.resolved");
      expect(n.body).toBe(answer);
      expect(n.title).toMatch(/^Kai Recruiter \(ITS recruiter\) answered the request about a candidate for /);
      expect(n.action).toEqual({ label: "Read the answer", href: `/?request=${urgentId}` });
    }
    expect(await noticesFor(abeId, "recruiter.resolved")).toHaveLength(0);
    const view = (await mine(hana)).find((r) => r.id === urgentId)!;
    expect(view).toMatchObject({ status: "resolved", resolution: answer, recruiterName: "Kai Recruiter" });
    expect(view.thread.map((e) => e.kind)).toEqual(["question", "reply", "reply", "answer"]);
    expect(view.thread.at(-1)).toMatchObject({ side: "recruiter", body: answer, by: "Kai Recruiter" });
    // a second submit of the same answer is refused: the thread keeps one answer and nobody is told twice
    const again = await json(kai, "POST", `/api/v1/escalations/${urgentId}/resolve`, { resolution: answer, minutesSpent: 20 });
    expect(again.status).toBe(409);
    expect((await mine(hana)).find((r) => r.id === urgentId)!.thread.filter((e) => e.kind === "answer")).toHaveLength(1);
    expect(await noticesFor(hanaId, "recruiter.resolved")).toHaveLength(1);
    // an answered request takes no more notes: it is reopened instead
    const late = await json(hana, "POST", `/api/v1/escalations/mine/${urgentId}/messages`, { body: "One more thing." });
    expect(late.status).toBe(409);
    expect((await errorOf(late)).message).toMatch(/reopen the request/);
  });

  it("'this didn't solve it' reopens it: the recruiter who answered has it again with fresh, recorded access and a new reply-by time", async () => {
    expect((await json(hana, "POST", `/api/v1/escalations/mine/${normalId}/reopen`, { note: "It was never answered." })).status).toBe(409);
    expect((await json(hana, "POST", `/api/v1/escalations/mine/${urgentId}/reopen`, { note: "no" })).status).toBe(400);
    const [oldGrant] = await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.escalationId, urgentId));
    const before = mail().length;
    const r = await json(hana, "POST", `/api/v1/escalations/mine/${urgentId}/reopen`, { note: "She cannot start until March. Does that change your advice?" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; slaDueAt: string; message: string };
    expect(body.status).toBe("claimed");
    expect(body.message).toMatch(/^Reopened\. Kai Recruiter \(ITS recruiter\) has it again and will respond by /);
    expect(body.message).toContain("They can see this candidate and the role they applied for until");
    expect(body.message).toContain("recorded in your activity");
    expect(Date.parse(body.slaDueAt)).toBeGreaterThan(Date.now());
    const [row] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, urgentId));
    expect(row).toMatchObject({ status: "claimed", resolvedAt: null, assignedToUserId: await idOf("kai@its.test") });
    expect(Date.parse(row.slaDueAt!)).toBe(Date.parse(body.slaDueAt));
    // the answered round's access ended; a fresh grant of the same scope runs for up to 14 days, recorded like any other
    const grants = await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.escalationId, urgentId));
    expect(grants).toHaveLength(2);
    expect(grants.find((g) => g.id === oldGrant.id)!.endedAt).toBeTruthy();
    const fresh = grants.find((g) => g.id !== oldGrant.id)!;
    expect(fresh).toMatchObject({ roleId, applicationId, endedAt: null, revokedAt: null });
    expect(Date.parse(fresh.expiresAt) - Date.now()).toBeGreaterThan(13 * 86_400_000);
    expect(row.accessExpiresAt).toBe(fresh.expiresAt);
    const [reopened] = await container.db.select().from(events).where(and(eq(events.type, "recruiter.reopened"), eq(events.subjectId, urgentId)));
    expect(reopened.payload).toMatchObject({ grantId: fresh.id, recruiterUserId: await idOf("kai@its.test"), slaDueAt: body.slaDueAt });
    const staffList = (await (await json(owner, "GET", "/api/v1/companies/current/staff-access")).json()) as Array<{ id: string; active: boolean }>;
    expect(staffList.find((g) => g.id === fresh.id)?.active).toBe(true);
    // the whole team that hears about recruiters is told of the fresh access, not only the person who reopened it, and
    // it is one of the updates always emailed (Q31)
    for (const id of [ownerId, abeId, hanaId]) {
      const [n] = await noticesFor(id, "recruiter.access_granted");
      expect(n.title).toBe("Kai Recruiter (ITS recruiter) has access again for a reopened request");
      expect(n.body).toContain("Hana Manager reopened a request Kai Recruiter answered");
      expect(n.body).toContain("They can see this candidate and the role they applied for until");
      expect(n.body).not.toContain("March");
      expect(n.action).toEqual({ label: "Recruiter access", href: "/setup#setup-recruiters" });
    }
    await container.drain();
    expect(mail().slice(before).filter((m) => m.to === "abe@loop.test" && m.tags?.template === "notification_alert")).toHaveLength(1);
    // reopening it again at once (a double click, or a second person) is refused: one fresh access, not two
    expect((await json(owner, "POST", `/api/v1/escalations/mine/${urgentId}/reopen`, { note: "Reopening it as well." })).status).toBe(409);
    expect(await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.escalationId, urgentId))).toHaveLength(2);
    // the recruiter is told the request is theirs again, without the customer's words
    const told = mail().slice(before).filter((m) => m.to === "kai@its.test");
    expect(told).toHaveLength(1);
    expect(told[0].text).not.toContain("March");
    // the thread keeps why, and a second answer joins the first
    const view = (await mine(owner)).find((r) => r.id === urgentId)!;
    expect(view.reopenedCount).toBe(1);
    expect(view.thread.at(-1)).toMatchObject({ kind: "reopen", side: "customer", by: "Hana Manager", body: "She cannot start until March. Does that change your advice?" });
    const detail = (await (await json(kai, "GET", `/api/v1/escalations/${urgentId}`)).json()) as { accessGranted: boolean; reopenedCount: number };
    expect(detail).toMatchObject({ accessGranted: true, reopenedCount: 1 });
    expect((await json(kai, "POST", `/api/v1/escalations/${urgentId}/resolve`, { resolution: "Still yes: hold the role for her until March." })).status).toBe(200);
    expect((await mine(owner)).find((r) => r.id === urgentId)!.thread.filter((e) => e.kind === "answer")).toHaveLength(2);
  });

  it("a recruiter whose access the company ended does not get it back: the reopened request goes to the queue", async () => {
    const asked = await ask(owner, { roleId, question: "Is the pay range right?" });
    expect((await json(kai, "POST", `/api/v1/escalations/${asked.id}/claim`)).status).toBe(200);
    expect((await json(kai, "POST", `/api/v1/escalations/${asked.id}/resolve`, { resolution: "Raise it by two dollars." })).status).toBe(200);
    const [grant] = await container.db.select().from(staffAccessGrants).where(and(eq(staffAccessGrants.escalationId, asked.id), eq(staffAccessGrants.userId, await idOf("kai@its.test"))));
    expect((await json(owner, "POST", `/api/v1/companies/current/staff-access/${grant.id}/revoke`, { reason: "We have what we need.", confirm: true })).status).toBe(200);
    const before = mail().length;
    const r = await json(owner, "POST", `/api/v1/escalations/mine/${asked.id}/reopen`, { note: "Two dollars is not enough to compete." });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; message: string };
    expect(body.status).toBe("open");
    expect(body.message).toMatch(/^Reopened and back in the ITS queue\. A recruiter will respond by /);
    expect(body.message).toContain("Whoever picks it up will see this role and its candidates");
    const [row] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, asked.id));
    expect(row).toMatchObject({ status: "open", assignedToUserId: null, accessExpiresAt: null, resolvedAt: null });
    expect(await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.escalationId, asked.id))).toHaveLength(1);
    const queued = mail().slice(before).filter((m) => m.to === container.env.ITS_QUEUE_EMAIL);
    expect(queued).toHaveLength(1);
    expect(queued[0].subject).toMatch(/reopened/);
    expect(queued[0].text).not.toContain("Two dollars");
    // and Kai cannot take it back from the queue either
    expect((await json(kai, "POST", `/api/v1/escalations/${asked.id}/claim`)).status).toBe(403);
  });

  it("a note says honestly when the recruiter could not be emailed; the note is kept either way", async () => {
    const asked = await ask(owner, { roleId, question: "Can you check the job ad wording?" });
    expect((await json(kai, "POST", `/api/v1/escalations/${asked.id}/claim`)).status).toBe(200);
    (container.integrations.email as FakeEmailAdapter).failNext();
    const r = await json(owner, "POST", `/api/v1/escalations/mine/${asked.id}/messages`, { body: "The second paragraph especially." });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { recruiterTold: boolean; message: string };
    expect(body.recruiterTold).toBe(false);
    expect(body.message).toMatch(/could not be emailed just now/);
    expect((await mine(owner)).find((v) => v.id === asked.id)!.thread.map((e) => e.body)).toContain("The second paragraph especially.");
  });

  it("deleting the candidate's data reaches the threads too", async () => {
    const other = await ask(owner, { roleId, question: "Compare Nia Brooks with the others?" });
    expect((await json(owner, "POST", `/api/v1/escalations/mine/${other.id}/messages`, { body: "Nia Brooks (nia.brooks@example.com) is our favourite." })).status).toBe(201);
    const [cand] = await container.db.select().from(applications).where(eq(applications.id, applicationId));
    await withPlatform(container.db, (tx) => anonymizeCandidate(tx, { companyId, candidateId: cand.candidateId, actor: { kind: "user", id: "admin-test", name: "ITS admin" }, deleteFile: async () => {} }));
    const bodies = (await container.db.select({ escalationId: escalationMessages.escalationId, side: escalationMessages.side, body: escalationMessages.body }).from(escalationMessages)).filter((m) => m.escalationId === urgentId || m.escalationId === other.id);
    for (const m of bodies) expect(m.body).not.toMatch(/Nia|Brooks|nia\.brooks/);
    // the team's own notes on a request about her go; elsewhere her name and address are taken out
    expect(bodies.filter((m) => m.escalationId === urgentId && m.side === "customer").every((m) => m.body === "[removed at the candidate's request]")).toBe(true);
    expect(bodies.find((m) => m.escalationId === other.id)!.body).toBe("a candidate ([removed]) is our favourite.");
    expect(JSON.stringify(await mine(owner))).not.toMatch(/Nia|Brooks/);
  });
});
