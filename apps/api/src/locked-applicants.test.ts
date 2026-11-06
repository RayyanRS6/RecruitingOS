import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { detectStuckRoles, runUntoldSafetyNet, sendCloseOutNotes, sendStillReviewingNotes } from "@ros/agents";
import { NO_WORK_WHILE_LOCKED, type ClosingMessagePreview } from "@ros/contracts";
import { CLOSED_OUT_STATUS_LINE, CLOSE_OUT_DAYS, ON_FILE_LAST_STEP, ON_FILE_NOTICE, anonymizeCandidate, closeOutDayWords, closeOutDueAt, closeOutNoteLine, decideLock, exportCandidateData, onFileFormLine, onFileReceiptLine, onFileStatusLine } from "@ros/core";
import { aiRuns, applications, approvalRequests, auditRecords, candidates, communications, dataRequests, documents, entitlements, events, interviews, notifications, plans, policies, postings, recruiterEscalations, roles, screens, unconfirmedScreens, withPlatform, withTenant, workflowRuns } from "@ros/db";
import { fakePostmarkEvent, type FakeEmailAdapter, type FakeIdentityProvider } from "@ros/integrations";
import { UNLOCK_INTERVIEW_DAYS, startInterviewAgain } from "@ros/workflows";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { RESUME_READ_NOTICE } from "./pages/apply-form";
import { followApply, signInAdmin, signInStaff, usePlan } from "./test-helpers";

const HIRE = "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.";
const DAY = 86_400_000;
/**
 * Far enough on that five working days have passed, whatever day a suite runs: nine days hold five only with no holiday among
 * them (from Friday 6 November 2026, Veterans Day left four).
 */
const FIVE_WORKING_DAYS_ON = 14 * DAY;
/** Every locked person in these suites has this surname, so a team notice that names one is easy to find. */
const LOCKED = "Lockwood";

/**
 * The plans of 5 November 2026, Rule 2, from the candidate's side and in the workflows. Someone past the plan's candidates per
 * job gets no AI and no team work: the file is scanned and the one email goes, in its on-file form. They can still see their
 * page, withdraw, ask about their information, reply and ask for a person, and all of that reaches ITS, never the team. They
 * hear by a date, or when the job closes, exactly once and never about a plan. A change of plan opens them oldest first, and
 * the interview's link goes by itself; a move down locks nobody.
 */
describe("locked candidates", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let admin = "";
  let made = 0;
  let applicants = 0;

  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "test" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const read = async <T>(r: Response) => (await r.json()) as T;
  const moveClock = (at: number | null) => { (container.engine as unknown as { now: () => Date }).now = at === null ? () => new Date() : () => new Date(at); };
  const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const page = async (path: string) => {
    const r = await app.request(path);
    expect(r.status, path).toBe(200);
    return decode(await r.text());
  };
  /** What a person reads on a page: no stylesheet, no script. */
  const wordsOf = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ");
  const mailsTo = (email: string) => (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === email);
  const form = (fields: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

  /** A company of its own on Free, signed in from an address of its own (the route's limit per address). */
  const newCompany = async () => {
    made += 1;
    const accessToken = (container.integrations.identity as FakeIdentityProvider).mint({ email: `owner-${made}@locked.test`, name: `Owner ${made}`, provider: "google" });
    const signedIn = await app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${made}` }, body: JSON.stringify({ accessToken }) });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    const r = await json(cookie, "POST", "/api/v1/companies", { name: `Harbor Dental ${made}`, vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
    expect(r.status, await r.clone().text()).toBe(201);
    const co = await read<{ id: string; slug: string; name: string; timezone: string }>(r);
    return { cookie, id: co.id, slug: co.slug, name: co.name, timezone: co.timezone };
  };
  type Company = Awaited<ReturnType<typeof newCompany>>;

  const openRole = async (company: Company) => {
    const s = await read<{ session: { id: string } }>(await json(company.cookie, "POST", "/api/v1/intake/sessions", { initialMessage: HIRE }));
    const compiled = await json(company.cookie, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`);
    expect(compiled.status, await compiled.clone().text()).toBe(201);
    const { roleId } = await read<{ roleId: string }>(compiled);
    expect((await json(company.cookie, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    const role = await read<{ status: string; title: string; currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> }; communication: { humanAlternativeText: string; disclosureText: string } } } }>(await json(company.cookie, "GET", `/api/v1/roles/${roleId}`));
    expect(role.status).toBe("open");
    return { ...company, roleId, title: role.title, eligibility: role.currentPacket.packet.requirements.eligibility, communication: role.currentPacket.packet.communication };
  };
  type Job = Awaited<ReturnType<typeof openRole>>;

  /** A company on Free with one job open and, for a shorter suite, a smaller limit than Free's five. */
  const openJob = async (limit?: number) => {
    const company = await newCompany();
    if (limit !== undefined) await setLimit(company.id, limit);
    return openRole(company);
  };
  const setLimit = (companyId: string, limit: number | null) => withPlatform(container.db, (tx) => tx.update(entitlements).set({ limit }).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "candidates_per_job"))));

  const person = (first: string, last = LOCKED) => {
    applicants += 1;
    return { first, last, email: `${first.toLowerCase()}.${applicants}@people.test` };
  };
  type Person = ReturnType<typeof person>;

  /** The public form, as a browser posts it; `extra` sets or overrides fields. */
  const postApplication = async (job: Job, p: Person, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("firstName", p.first); fd.set("lastName", p.last); fd.set("email", p.email); fd.set("locationText", "Irvine, CA");
    fd.set("resume", new File([`${p.first} ${p.last}\nRegistered Dental Hygienist at Coastal Dental 2019 - present\nRDH license active\nPerio maintenance, Dentrix`], `${p.first.toLowerCase()}.txt`, { type: "text/plain" }));
    for (const rule of job.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("acknowledged", "yes");
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    const res = await app.request(`/careers/${job.slug}/jobs/${job.roleId}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": `198.51.100.${applicants % 250}` } });
    expect(res.status, await res.clone().text()).toBe(302);
    return res;
  };
  const rowOf = async (job: Pick<Job, "id" | "roleId">, p: Person) => {
    const [cand] = await container.db.select().from(candidates).where(and(eq(candidates.companyId, job.id), eq(candidates.email, p.email)));
    const [row] = await container.db.select().from(applications).where(and(eq(applications.roleId, job.roleId), eq(applications.candidateId, cand.id)));
    return row;
  };
  const apply = async (job: Job, p: Person, extra: Record<string, string> = {}) => {
    await postApplication(job, p, extra);
    await container.drain();
    return rowOf(job, p);
  };
  const fill = async (job: Job, n: number) => {
    const out: Array<Awaited<ReturnType<typeof apply>>> = [];
    for (let i = 0; i < n; i++) out.push(await apply(job, person(`Vera${i}`, "Visible")));
    return out;
  };
  const applicationOf = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];
  const runsOf = async (companyId: string) => container.db.select().from(aiRuns).where(eq(aiRuns.companyId, companyId));
  const screenRunsOf = async (applicationId: string) => (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "screen"))).filter((r) => r.subject.id === applicationId);
  const intakeRunsOf = async (applicationId: string) => (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "application_intake"))).filter((r) => r.subject.id === applicationId);
  const commsOf = (applicationId: string) => container.db.select().from(communications).where(eq(communications.applicationId, applicationId));
  const eventsOf = (applicationId: string, type: string) => container.db.select().from(events).where(and(eq(events.subjectId, applicationId), eq(events.type, type)));
  const auditsOf = async (applicationId: string, action: string) => (await container.db.select().from(auditRecords).where(eq(auditRecords.action, action))).filter((r) => r.target?.id === applicationId);
  const noticesOf = (companyId: string) => container.db.select().from(notifications).where(eq(notifications.companyId, companyId));
  /** No team notice names anyone locked, whatever else happened. */
  const noTeamNoticeNames = async (companyId: string, surname = LOCKED) => {
    const named = (await noticesOf(companyId)).filter((n) => `${n.title} ${n.body}`.includes(surname));
    expect(named.map((n) => `${n.kind}: ${n.title}`)).toEqual([]);
  };
  const statusOf = (row: { statusToken: string }) => page(`/c/status/${row.statusToken}`);
  const changePlan = async (companyId: string, planKey: string) => {
    const r = await json(admin, "POST", `/api/v1/admin/customers/${companyId}/plan`, { planKey, reason: "They asked to upgrade." });
    expect(r.status, await r.clone().text()).toBe(200);
    await container.drain();
    return read<{ unlocked: number; planKey: string }>(r);
  };
  const inbound = (payload: Record<string, unknown>) => app.request("/webhooks/postmark/inbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const reply = (row: { replyToken: string }, from: string, text: string, id: string) => inbound({ From: from, To: `reply-${row.replyToken}@${container.integrations.env.intakeDomain}`, Subject: "Re: Your application", TextBody: text, MessageID: id });
  const close = async (job: Pick<Job, "cookie" | "roleId">) => {
    const r = await json(job.cookie, "POST", `/api/v1/roles/${job.roleId}/outcome`, { outcome: "role_cancelled", confirm: true, reason: "We changed our plans." });
    expect(r.status, await r.clone().text()).toBe(200);
    await container.drain();
    return read<{ movedToTalentPool: number; keptInTalentPool: number; closingMessage: ClosingMessagePreview }>(r);
  };
  const setPolicy = (companyId: string, actionType: string, level: "auto" | "approval" | "human_only") => withTenant(container.db, companyId, async (tx) => {
    await tx.delete(policies).where(and(eq(policies.companyId, companyId), eq(policies.actionType, actionType)));
    await tx.insert(policies).values({ companyId, roleId: null, actionType, level, approverRoles: ["owner"], createdBy: { kind: "system", id: "test" } });
  });
  const courtesy = (now: Date, id: string) => ({ integrations: container.integrations, statusBaseUrl: container.env.JOBS_BASE_URL, now, actor: { kind: "system" as const, id } });
  const closeOutNotes = (companyId: string, now: Date) => withTenant(container.db, companyId, (tx) => sendCloseOutNotes(tx, courtesy(now, "close_out"), companyId));
  const safetyNet = (companyId: string, now: Date) => withTenant(container.db, companyId, (tx) => runUntoldSafetyNet(tx, courtesy(now, "untold_safety_net"), companyId));
  /** What the same page reads for two people, with what differs by address taken out. */
  const sameReceipt = (html: string) => html.replace(/[a-z0-9]\*\*\*@[a-z0-9.-]+/gi, "[address]").replace(/nonce="[^"]+"/g, "");

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", AUTH_PROVIDER: "fake", MESSAGE_UNDO_SECONDS: "0" } });
    app = createApp(container);
    admin = await signInAdmin(app, container, "ada.admin@identifiedtalent.com", "Ada Admin");
    // A plan with room for two more than Free's five, so an upgrade opens some and leaves others.
    await withPlatform(container.db, (tx) => tx.insert(plans).values([{ key: "test_seven", name: "Seven", limits: { candidates_per_job: 7 } }, { key: "test_two", name: "Two", limits: { candidates_per_job: 2 } }, { key: "test_one", name: "One", limits: { candidates_per_job: 1 } }]));
  });
  afterAll(async () => {
    await container.close();
  });

  it("the whole way, with the stand-in AI: past the limit no AI runs, they read the truth, withdrawal and privacy work, an upgrade opens the oldest and starts their interview, and closing the job tells the rest once", async () => {
    const job = await openJob();
    const visible = await fill(job, 5);
    expect(visible.every((a) => a.lockedAt === null)).toBe(true);

    // The job's pages, before anyone applies past the limit: what is true of the next person, and every required notice.
    const jobPage = await page(`/careers/${job.slug}/jobs/${job.roleId}`);
    expect(jobPage).toContain(ON_FILE_LAST_STEP);
    expect(jobPage).not.toContain("A decision, and a real answer either way.");
    expect(jobPage).not.toContain("short AI interview");
    expect(jobPage).toContain("A short form, about 3 minutes.");
    expect(jobPage).toContain(`People at ${job.name} make every hiring decision.`);
    expect(jobPage).toContain("How AI is used");
    expect(wordsOf(jobPage)).not.toMatch(/\b(upgrade|locked)\b|free plan/i);
    const formPage = await page(`/careers/${job.slug}/jobs/${job.roleId}/apply`);
    expect(formPage).not.toContain("Read my resume");
    expect(formPage).not.toContain(RESUME_READ_NOTICE);
    expect(formPage).not.toContain("Next comes a short AI interview");
    expect(formPage).toContain(onFileFormLine(job.name));
    expect(formPage).toContain("I have read the full notice above and I understand that people, not software, make the hiring decisions.");
    expect(formPage).toContain("Software helps organize applications and works out a match score.");
    expect(formPage).toContain("Why:");
    expect(wordsOf(formPage)).not.toMatch(/\b(upgrade|locked)\b|free plan/i);

    // Applying past the limit, on that form.
    const aiBefore = (await runsOf(job.id)).length;
    const lena = person("Lena", "Later");
    const sent = await postApplication(job, lena, { onFileShown: "yes" });
    const seen = await followApply(app, sent, container);
    await container.drain();
    const lenaRow = await rowOf(job, lena);
    expect(lenaRow.lockedAt).not.toBeNull();
    expect(lenaRow.stage).toBe("received");

    // No AI ran, and nothing waits: no screen, no interview run, no eligibility step, no approval, no reading.
    expect((await runsOf(job.id)).length).toBe(aiBefore);
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, lenaRow.id))).toEqual([]);
    expect(await screenRunsOf(lenaRow.id)).toEqual([]);
    expect(lenaRow.eligibility).toBeNull();
    expect(lenaRow.extraction).toBeNull();
    expect((await intakeRunsOf(lenaRow.id)).map((r) => r.status)).toEqual(["completed"]);
    // ... and the file was still scanned.
    const [doc] = await container.db.select().from(documents).where(eq(documents.applicationId, lenaRow.id));
    expect(doc.status).toBe("clean");
    // The line before Send is on the record with the notices shown.
    expect(lenaRow.answers.noticeVersionsShown).toContain(ON_FILE_NOTICE);

    // What she read on the receipt.
    const byDay = closeOutDayWords(closeOutDueAt(lenaRow.createdAt), job.timezone);
    expect(seen.token).toBeNull();
    const receipt = decode(seen.html);
    expect(receipt).toContain("Thanks for applying");
    expect(receipt).toContain(onFileReceiptLine(job.name, byDay));
    expect(receipt).toContain("People make every decision.");
    expect(receipt).not.toContain("reviews your application");
    expect(receipt).not.toContain("You hear from us by email either way.");
    expect(receipt).not.toContain("preparing your AI interview");
    expect(wordsOf(receipt)).not.toMatch(/\b(plan|upgrade|locked)\b/i);

    // What email was queued: one, the acknowledgment's own, in its on-file form.
    const [only, ...none] = await commsOf(lenaRow.id);
    expect(none).toEqual([]);
    expect(only).toMatchObject({ templateKey: "acknowledgment", idempotencyKey: `ack:${lenaRow.id}`, status: "sent", disclosureIncluded: true });
    const mail = mailsTo(lena.email);
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toBe(`Thank you for applying: ${job.title} at ${job.name}`);
    expect(mail[0].text).toContain(onFileReceiptLine(job.name, byDay));
    expect(mail[0].text).toContain(`/c/status/${lenaRow.statusToken}`);
    expect(mail[0].text).toContain(job.communication.humanAlternativeText);
    expect(mail[0].text).toContain(job.communication.disclosureText);
    expect(mail[0].text).toContain("People make every decision.");
    expect(mail[0].text).not.toContain("AI interview");
    expect(mail[0].text).not.toContain("read every application");
    expect(mail[0].text).not.toMatch(/\b(plan|upgrade|locked)\b/i);

    // The reason is on the record: arrival order, the limit and the plan, and no name.
    const [locked] = await eventsOf(lenaRow.id, "application.locked");
    expect(locked.payload).toEqual({ position: 6, limit: 5, plan: "free" });
    const [lockAudit] = await auditsOf(lenaRow.id, "application.locked");
    expect(lockAudit.details).toEqual({ position: 6, limit: 5, plan: "free" });
    expect(JSON.stringify([locked, lockAudit])).not.toContain("Later");

    // Her own page: where she stands, with no score, no review and no word about a plan.
    const onPage = await statusOf(lenaRow);
    expect(onPage).toContain(onFileStatusLine(job.name, byDay));
    expect(onPage).not.toContain("The hiring team is reviewing your application");
    expect(onPage).not.toContain("Your match score");
    expect(onPage).toContain("To write to us, reply to any of our emails.");
    expect(onPage).not.toContain("To write to the team");
    expect(onPage).toContain("No longer interested?");
    expect(onPage).toContain(`People on the hiring team at ${job.name} make every decision about your application.`);
    expect(wordsOf(onPage)).not.toMatch(/\b(upgrade|locked)\b|free plan/i);
    expect(onPage).toMatch(/aria-current="step"[^>]*>.*?<span>Applied<\/span>/s);

    // More people, past the limit, some of whom act.
    const liam = person("Liam", "Later");
    const liamRow = await apply(job, liam);
    const wes = person("Wes");
    const wesRow = await apply(job, wes);
    const nora = person("Nora");
    const noraRow = await apply(job, nora);
    const omar = person("Omar");
    const omarRow = await apply(job, omar);
    expect((await eventsOf(omarRow.id, "application.locked"))[0].payload).toMatchObject({ position: 10 });

    // Withdrawing works, and is confirmed; the team hears nothing.
    expect((await app.request(`/c/status/${wesRow.statusToken}/withdraw`, form({ confirm: "yes" }))).status).toBe(302);
    await container.drain();
    expect((await applicationOf(wesRow.id)).stage).toBe("withdrawn");
    expect(mailsTo(wes.email).length).toBe(2);
    expect((await noticesOf(job.id)).filter((n) => n.kind === "candidate.withdrawn")).toEqual([]);

    // Asking about their information works, and a person's review reaches ITS, not the team.
    expect((await app.request(`/c/status/${noraRow.statusToken}/privacy`, form({ kind: "access" }))).status).toBe(302);
    expect((await app.request(`/c/status/${noraRow.statusToken}/privacy`, form({ kind: "human_review" }))).status).toBe(302);
    await container.drain();
    const requests = await container.db.select().from(dataRequests).where(eq(dataRequests.applicationId, noraRow.id));
    expect(requests.map((r) => r.kind).sort()).toEqual(["access", "human_review"]);
    expect(mailsTo(nora.email).length).toBe(3);
    expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, noraRow.id))).toHaveLength(1);
    const copy = await withPlatform(container.db, (tx) => exportCandidateData(tx, job.id, noraRow.candidateId));
    expect((copy.applications as Array<Record<string, unknown>>)[0]).toMatchObject({ hiringTeamCanSeeThis: false });
    expect(JSON.stringify(copy.applications)).not.toMatch(/\bplan\b/i);

    // HUMAN reaches ITS, answered with when; the team hears nothing.
    expect((await reply(omarRow, omar.email, "HUMAN", "msg-omar")).status).toBe(200);
    await container.drain();
    const [omarEsc] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, omarRow.id));
    expect(omarEsc).toMatchObject({ kind: "candidate_issue" });
    expect(mailsTo(omar.email).map((m) => m.subject)).toHaveLength(2);
    expect((await commsOf(omarRow.id)).map((c) => c.templateKey)).toContain("human_requested_reply");
    await noTeamNoticeNames(job.id);
    await noTeamNoticeNames(job.id, "Later");
    expect((await noticesOf(job.id)).filter((n) => ["screen.human_requested", "message.received"].includes(n.kind))).toEqual([]);

    // Nothing so far spent the company's AI credit on any of them.
    expect((await runsOf(job.id)).length).toBe(aiBefore);

    // An upgrade: oldest first, up to the new limit, each with one event and one audit line.
    const changed = await changePlan(job.id, "test_seven");
    expect(changed.unlocked).toBe(2);
    expect((await applicationOf(lenaRow.id)).lockedAt).toBeNull();
    expect((await applicationOf(liamRow.id)).lockedAt).toBeNull();
    for (const row of [wesRow, noraRow, omarRow]) expect((await applicationOf(row.id)).lockedAt).not.toBeNull();
    const [unlocked] = await eventsOf(lenaRow.id, "application.unlocked");
    expect(unlocked.payload).toMatchObject({ cause: "plan_changed", plan: "test_seven", limit: 7, interview: true });
    expect(JSON.stringify(unlocked)).not.toContain("Later");
    expect(await auditsOf(lenaRow.id, "application.unlocked")).toHaveLength(1);
    expect(await eventsOf(noraRow.id, "application.unlocked")).toEqual([]);

    // The interview starts by itself: her résumé is read, and the link goes in an email of its own.
    const lenaNow = await applicationOf(lenaRow.id);
    expect(lenaNow.stage).toBe("screen_invited");
    expect(lenaNow.extraction).not.toBeNull();
    expect((await runsOf(job.id)).length).toBeGreaterThan(aiBefore);
    const [scr] = await container.db.select().from(screens).where(eq(screens.applicationId, lenaRow.id));
    expect(scr).toMatchObject({ status: "invited", channel: "web" });
    const lenaMail = mailsTo(lena.email);
    expect(lenaMail).toHaveLength(2);
    expect(lenaMail[1].text).toContain("Thanks again for applying");
    expect(lenaMail[1].text).toContain(`/c/screen/${scr.token}`);
    expect((await commsOf(lenaRow.id)).filter((c) => c.templateKey === "acknowledgment")).toHaveLength(1);
    // Her page goes back to its usual words by itself.
    const openPage = await statusOf(lenaRow);
    expect(openPage).not.toContain(onFileStatusLine(job.name, byDay));
    expect(openPage).toContain("Start your AI interview");
    expect(openPage).toContain("To write to the team, reply to any of our emails.");
    // Her copy of her data says since when the team could read it, in one plain field and with no word about a plan.
    const opened = await withPlatform(container.db, (tx) => exportCandidateData(tx, job.id, lenaRow.candidateId));
    const openedCopy = (opened.applications as Array<Record<string, unknown>>)[0];
    expect(openedCopy).toMatchObject({ hiringTeamCanSeeThis: true });
    expect(Date.parse(String(openedCopy.hiringTeamCanSeeThisSince))).toBeGreaterThan(Date.parse(lenaRow.createdAt));
    expect(JSON.stringify(opened.applications)).not.toMatch(/\bplan\b/i);

    // Someone new follows the new limit: there are ten applications and seven places, so they are on file.
    const pia = person("Pia");
    const piaRow = await apply(job, pia);
    expect(piaRow.lockedAt).not.toBeNull();
    expect((await eventsOf(piaRow.id, "application.locked"))[0].payload).toEqual({ position: 11, limit: 7, plan: "test_seven" });

    // Closing the job: they move and stay locked, are not kept, and only a count reaches the team.
    const closed = await close(job);
    expect(closed.movedToTalentPool).toBe(7);
    expect(closed.closingMessage.locked).toBe(3);
    expect(closed.closingMessage.people.map((p) => p.name).join(" ")).not.toContain(LOCKED);
    for (const row of [noraRow, omarRow, piaRow]) {
      const now = await applicationOf(row.id);
      expect(now.stage).toBe("talent_pool");
      expect(now.lockedAt).not.toBeNull();
      expect((await container.db.select().from(candidates).where(eq(candidates.id, row.candidateId)))[0].inTalentPool).toBe(false);
    }
    expect((await container.db.select().from(candidates).where(eq(candidates.id, visible[0].candidateId)))[0].inTalentPool).toBe(true);
    const noraMailsBefore = mailsTo(nora.email).length;

    // Five working days on, the daily check tells them by itself: the closing wording with no line about keeping them.
    moveClock(Date.now() + FIVE_WORKING_DAYS_ON);
    try {
      await container.drain();
      const closingOf = (email: string) => mailsTo(email).filter((m) => m.subject === `Your application to ${job.name}`);
      const [note] = closingOf(nora.email);
      expect(note.text).toContain(`${job.name} has closed this position, so your application for this role will not go any further.`);
      expect(note.text).not.toContain("keep your information");
      expect(note.text).not.toContain("future roles");
      expect(note.text).not.toMatch(/\b(plan|upgrade|locked)\b/i);
      expect(mailsTo(nora.email).length).toBe(noraMailsBefore + 1);
      // Exactly once, however often the check looks again.
      moveClock(Date.now() + FIVE_WORKING_DAYS_ON + 2 * DAY);
      await container.drain();
      for (const p of [nora, omar, pia]) expect(closingOf(p.email)).toHaveLength(1);
      expect(closingOf(wes.email)).toEqual([]);
      for (const row of [noraRow, omarRow, piaRow]) expect((await commsOf(row.id)).filter((c) => c.idempotencyKey === `role_closed:${row.id}`)).toHaveLength(1);
      // No names to the team and no request raised about them.
      await noTeamNoticeNames(job.id);
      const raised = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.companyId, job.id));
      expect(raised.filter((e) => /not been told/.test(e.question))).toEqual([]);
    } finally {
      moveClock(null);
    }
    // Her page says the job closed, and nothing about keeping her.
    const closedPage = await statusOf(noraRow);
    expect(closedPage).toContain(`${job.name} has closed this position, so your application for it will not go any further.`);
    expect(closedPage).not.toContain("We are keeping you in mind");
    expect(closedPage).not.toContain("Would you rather we did not keep");
    expect((await applicationOf(noraRow.id)).lockedAt).not.toBeNull();
  });

  describe("the place", () => {
    it("is arrival order alone, and nothing a person does later gives one back", async () => {
      const job = await openJob(2);
      const [first, second] = await fill(job, 2);
      const third = await apply(job, person("Tia"));
      expect(third.lockedAt).not.toBeNull();
      expect((await eventsOf(third.id, "application.locked"))[0].payload).toEqual({ position: 3, limit: 2, plan: "free" });
      // Someone visible withdraws, and the next person is still locked: no place came back, and nobody came into view.
      expect((await app.request(`/c/status/${first.statusToken}/withdraw`, form({ confirm: "yes" }))).status).toBe(302);
      await container.drain();
      const fourth = await apply(job, person("Uma"));
      expect(fourth.lockedAt).not.toBeNull();
      expect((await eventsOf(fourth.id, "application.locked"))[0].payload).toMatchObject({ position: 4 });
      expect((await applicationOf(second.id)).lockedAt).toBeNull();
      expect((await applicationOf(third.id)).lockedAt).not.toBeNull();
    });

    it("is decided behind the job's own lock, held until the application commits, so people applying at the same moment take different places; a company with no limit takes no lock", async () => {
      // PGlite runs one connection, so it cannot show a second transaction waiting (on Postgres the race below is real). What
      // it can show is the lock itself, in pg_locks, for as long as the transaction lasts.
      const advisoryLocks = async (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => {
        const result = await tx.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted`);
        return ((Array.isArray(result) ? result : (result as unknown as { rows: unknown[] }).rows) as Array<{ n: number }>)[0].n;
      };
      const job = await openJob(2);
      await withTenant(container.db, job.id, async (tx) => {
        expect(await advisoryLocks(tx)).toBe(0);
        expect(await decideLock(tx, { companyId: job.id, roleId: job.roleId })).toBeNull();
        expect(await advisoryLocks(tx)).toBe(1);
      });
      const open = await newCompany();
      await usePlan(container, open.id, "ultra");
      const free = await openRole(open);
      await withTenant(container.db, open.id, async (tx) => {
        expect(await decideLock(tx, { companyId: open.id, roleId: free.roleId })).toBeNull();
        expect(await advisoryLocks(tx)).toBe(0);
      });

      const people = [person("Ara"), person("Bel"), person("Cyd"), person("Dru")];
      await Promise.all(people.map((p) => postApplication(job, p)));
      await container.drain();
      const rows = await Promise.all(people.map((p) => rowOf(job, p)));
      expect(rows.filter((r) => r.lockedAt === null)).toHaveLength(2);
      const places = await Promise.all(rows.filter((r) => r.lockedAt !== null).map(async (r) => (await eventsOf(r.id, "application.locked"))[0].payload.position as number));
      expect(places.sort()).toEqual([3, 4]);
    });

    it("a decline or a deletion gives no place back either", async () => {
      const job = await openJob(3);
      const [declined, deleted] = await fill(job, 3);
      const declining = await json(job.cookie, "POST", `/api/v1/applications/${declined.id}/actions`, { action: "reject", reason: "position_filled", note: "Hired internally." });
      expect(declining.status, await declining.clone().text()).toBe(200);
      await withTenant(container.db, job.id, (tx) => anonymizeCandidate(tx, { companyId: job.id, candidateId: deleted.candidateId, actor: { kind: "system", id: "locked-applicants.test" }, deleteFile: async () => undefined }));
      await container.drain();
      const next = await apply(job, person("Vik"));
      expect(next.lockedAt).not.toBeNull();
      expect((await eventsOf(next.id, "application.locked"))[0].payload).toEqual({ position: 4, limit: 3, plan: "free" });
    });

    it("an email held while applications are off takes its place when it is added: on file when they reopen, and when the job closes it joins the pool, unacknowledged and not kept, and hears once", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const [emailIn] = await container.db.select().from(postings).where(and(eq(postings.roleId, job.roleId), eq(postings.channel, "email_in")));
      const emailed = (first: string) => inbound({ From: "noreply@indeed.com", FromName: "Indeed", To: `apply-${emailIn.intakeToken}@${container.integrations.env.intakeDomain}`, Subject: `New applicant: ${first} ${LOCKED}`, TextBody: `${first} ${LOCKED} applied via Indeed.\nEmail: ${first.toLowerCase()}.lockwood@people.test`, Attachments: [] });
      const rowFor = async (first: string) => {
        const [cand] = await container.db.select().from(candidates).where(and(eq(candidates.companyId, job.id), eq(candidates.email, `${first.toLowerCase()}.lockwood@people.test`)));
        return (await container.db.select().from(applications).where(and(eq(applications.roleId, job.roleId), eq(applications.candidateId, cand.id))))[0];
      };

      expect((await json(job.cookie, "POST", `/api/v1/roles/${job.roleId}/applications/accepting`, { accepting: false, reason: "Enough for now" })).status).toBe(200);
      expect(await (await emailed("Ann")).json()).toMatchObject({ matched: true, held: true });
      expect((await json(job.cookie, "POST", `/api/v1/roles/${job.roleId}/applications/accepting`, { accepting: true })).status).toBe(200);
      await container.drain();
      const ann = await rowFor("Ann");
      expect(ann.lockedAt).not.toBeNull();
      expect((await eventsOf(ann.id, "application.locked"))[0].payload).toEqual({ position: 2, limit: 1, plan: "free" });
      const annMail = mailsTo("ann.lockwood@people.test");
      expect(annMail).toHaveLength(1);
      expect(annMail[0].text).toContain(`${job.name} has your application on file.`);

      expect((await json(job.cookie, "POST", `/api/v1/roles/${job.roleId}/pause`, {})).status).toBe(200);
      expect(await (await emailed("Bo")).json()).toMatchObject({ matched: true, held: true });
      const before = (await runsOf(job.id)).length;
      const closed = await close(job);
      await container.drain();
      const bo = await rowFor("Bo");
      expect(bo).toMatchObject({ stage: "talent_pool", toldState: "not_told" });
      expect(bo.lockedAt).not.toBeNull();
      expect((await container.db.select().from(candidates).where(eq(candidates.id, bo.candidateId)))[0].inTalentPool).toBe(false);
      expect(closed.closingMessage.locked).toBe(2);
      expect(mailsTo("bo.lockwood@people.test")).toEqual([]);
      expect((await runsOf(job.id)).length).toBe(before);
      await noTeamNoticeNames(job.id);

      const oneOf = (x: { applicationId: string }) => x.applicationId === ann.id || x.applicationId === bo.id;
      expect((await safetyNet(job.id, new Date(Date.now() + FIVE_WORKING_DAYS_ON))).filter(oneOf).map((x) => x.action)).toEqual(["sent", "sent"]);
      await container.drain();
      expect(mailsTo("bo.lockwood@people.test").map((m) => m.subject)).toEqual([`Your application to ${job.name}`]);
      expect((await safetyNet(job.id, new Date(Date.now() + FIVE_WORKING_DAYS_ON + DAY))).filter(oneOf)).toEqual([]);
      expect(mailsTo("bo.lockwood@people.test")).toHaveLength(1);
    });

    it("takes no lock and locks nobody for a company with no limit", async () => {
      const company = await newCompany();
      await usePlan(container, company.id);
      const job = await openRole(company);
      const rows = await fill(job, 7);
      expect(rows.every((a) => a.lockedAt === null)).toBe(true);
      expect(await page(`/careers/${job.slug}/jobs/${job.roleId}`)).toContain("A decision, and a real answer either way.");
      expect(await page(`/careers/${job.slug}/jobs/${job.roleId}/apply`)).toContain("Read my resume");
    });

    it("reads the same for a new address, a repeat of someone locked or visible, a known address and a must-have No, with no second interview anywhere", async () => {
      const company = await newCompany();
      await usePlan(container, company.id);
      const elsewhere = await openRole(company);
      const job = await openRole(company);
      const known = person("Kim", "Visible");
      await apply(elsewhere, known);
      await setLimit(company.id, 1);
      const visible = person("Vic", "Visible");
      const visibleRow = await apply(job, visible);
      expect(visibleRow.lockedAt).toBeNull();

      const lockedPerson = person("Lou");
      const receipts: string[] = [];
      const visit = async (p: Person, extra: Record<string, string> = {}) => {
        const res = await postApplication(job, p, extra);
        const seen = await followApply(app, res, container);
        expect(seen.token).toBeNull();
        receipts.push(sameReceipt(seen.html));
        await container.drain();
      };
      await visit(lockedPerson);                 // new
      await visit(lockedPerson);                 // a repeat of someone locked
      await visit(visible);                      // a repeat of someone visible
      await visit(known);                        // an address the company knew
      const no = person("Noa");
      await visit(no, Object.fromEntries(job.eligibility.map((r) => [`elig_${r.key}`, "no"])));
      expect(new Set(receipts).size).toBe(1);
      expect(decode(receipts[0])).toContain(`${job.name} has your application on file.`);
      // No detached interview, for anyone: it would be a conversation with a model nobody may read.
      expect(await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.roleId, job.roleId))).toEqual([]);
      // A repeat is not a new row, and keeps what it has.
      expect((await rowOf(job, visible)).lockedAt).toBeNull();
      const lockedRow = await rowOf(job, lockedPerson);
      expect(await eventsOf(lockedRow.id, "application.locked")).toHaveLength(1);
      expect((await rowOf(job, known)).lockedAt).not.toBeNull();
      // Nothing about a must-have answer reaches anyone while locked: it is on file and read after an unlock.
      const noRow = await rowOf(job, no);
      expect(noRow.stage).toBe("received");
      expect(noRow.eligibility).toBeNull();
      expect((await noticesOf(company.id)).filter((n) => n.kind === "application.ineligible_hold")).toEqual([]);
    });

    it("applies to an emailed application: no wait for the AI notice, the on-file email, no interview and no AI", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const [emailIn] = await container.db.select().from(postings).where(and(eq(postings.roleId, job.roleId), eq(postings.channel, "email_in")));
      const before = (await runsOf(job.id)).length;
      const r = await inbound({ From: "noreply@indeed.com", FromName: "Indeed", To: `apply-${emailIn.intakeToken}@${container.integrations.env.intakeDomain}`, Subject: `New applicant: Mel ${LOCKED}`, TextBody: `Mel ${LOCKED} applied via Indeed.\nEmail: mel.lockwood@people.test`, Attachments: [] });
      expect(r.status).toBe(200);
      await container.drain();
      const { applicationId } = (await r.json()) as { applicationId: string };
      const row = await applicationOf(applicationId);
      expect(row.lockedAt).not.toBeNull();
      expect(row.stage).toBe("received");
      expect((await runsOf(job.id)).length).toBe(before);
      expect(await screenRunsOf(row.id)).toEqual([]);
      expect((await intakeRunsOf(row.id)).map((x) => x.status)).toEqual(["completed"]);
      const mail = mailsTo("mel.lockwood@people.test");
      expect(mail).toHaveLength(1);
      expect(mail[0].text).toContain(`${job.name} has your application on file.`);
      await noTeamNoticeNames(job.id);
    });
  });

  describe("the form on a job at its limit", () => {
    it("before the limit it is the usual form, and past it the line before Send is recorded only where the page showed it", async () => {
      const job = await openJob(1);
      const usual = await page(`/careers/${job.slug}/jobs/${job.roleId}/apply`);
      expect(usual).toContain("Read my resume");
      expect(usual).toContain(RESUME_READ_NOTICE);
      expect(usual).not.toContain(onFileFormLine(job.name));
      await fill(job, 1);
      // A form opened before the limit was hit: it is taken, on file, with the one email, and no notice it never showed.
      const late = await apply(job, person("Lee"));
      expect(late.lockedAt).not.toBeNull();
      expect(late.answers.noticeVersionsShown).not.toContain(ON_FILE_NOTICE);
      expect((await commsOf(late.id)).map((c) => c.templateKey)).toEqual(["acknowledgment"]);
    });

    it("reads no résumé past the limit: the file stays attached, nothing is asked of the model, and the same form sends it", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const before = (await runsOf(job.id)).length;
      const p = person("Rue");
      const fd = new FormData();
      fd.set("firstName", p.first); fd.set("lastName", p.last); fd.set("email", p.email);
      fd.set("resume", new File([`${p.first} ${p.last}\nRegistered Dental Hygienist`], "rue.txt", { type: "text/plain" }));
      const r = await app.request(`/careers/${job.slug}/jobs/${job.roleId}/apply/read`, { method: "POST", body: fd, headers: { "x-forwarded-for": "198.51.100.200" } });
      expect(r.status).toBe(200);
      const html = decode(await r.text());
      expect(html).toContain("rue.txt is attached to your application. Fill in your details below.");
      expect(html).not.toContain("<h1>Reading your resume");
      expect(html).not.toContain("Read this resume instead");
      await container.drain();
      expect((await runsOf(job.id)).length).toBe(before);
      const grant = /name="uploadGrant" value="([^"]+)"/.exec(html)![1];
      const send = new FormData();
      send.set("firstName", p.first); send.set("lastName", p.last); send.set("email", p.email); send.set("uploadGrant", grant); send.set("acknowledged", "yes"); send.set("onFileShown", "yes");
      for (const rule of job.eligibility) send.set(`elig_${rule.key}`, "yes");
      expect((await app.request(`/careers/${job.slug}/jobs/${job.roleId}/apply`, { method: "POST", body: send, headers: { "x-forwarded-for": "198.51.100.201" } })).status).toBe(302);
      await container.drain();
      const row = await rowOf(job, p);
      expect(row.lockedAt).not.toBeNull();
      expect(row.resumeDocumentId).not.toBeNull();
      const [doc] = await container.db.select().from(documents).where(eq(documents.id, row.resumeDocumentId!));
      expect(doc.status).toBe("clean");
      expect((await runsOf(job.id)).length).toBe(before);
    });

    it("a receipt opened later, with the page's cookie gone, promises no review on a job past its limit", async () => {
      const job = await openJob(1);
      const usual = await page(`/careers/${job.slug}/jobs/${job.roleId}/applied`);
      expect(usual).toContain(`The hiring team at ${job.name} reviews your application.`);
      await fill(job, 1);
      const html = await page(`/careers/${job.slug}/jobs/${job.roleId}/applied`);
      expect(html).not.toContain("reviews your application");
      expect(html).toContain("People make every decision.");
      expect(html).toContain("You hear from us by email either way.");
      expect(wordsOf(html)).not.toMatch(/\b(upgrade|locked)\b|free plan/i);
    });

    it("drops the link preview's promise to answer every applicant for a company whose plan can leave people unread", async () => {
      const job = await openJob(1);
      const html = await page(`/careers/${job.slug}`);
      expect(html).not.toContain("We respond to every applicant");
    });
  });

  describe("who hears what", () => {
    it("a reply reaches ITS, one request at a time, and never the team; saying no to being kept is done with no request", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const p = person("Bea");
      const row = await apply(job, p);
      expect((await reply(row, p.email, "Could I have more time because of a disability?", "msg-bea-1")).status).toBe(200);
      await container.drain();
      const requests = () => container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, row.id));
      expect((await requests()).map((e) => e.kind)).toEqual(["candidate_issue"]);
      expect((await requests())[0].question).not.toContain("disability");
      expect((await commsOf(row.id)).some((c) => c.direction === "inbound" && c.bodyText.includes("disability"))).toBe(true);
      // Her message is on her own page.
      expect(await statusOf(row)).toContain("Could I have more time");
      expect((await reply(row, p.email, "Any news?", "msg-bea-2")).status).toBe(200);
      await container.drain();
      expect(await requests()).toHaveLength(1);
      expect((await noticesOf(job.id)).filter((n) => n.kind === "message.received")).toEqual([]);
      await noTeamNoticeNames(job.id);

      const q = person("Dag");
      const qRow = await apply(job, q);
      // Told something first, so "no thanks" answers the offer about future roles: here, a closing message below.
      await container.db.update(applications).set({ stage: "talent_pool", toldState: "sent" }).where(eq(applications.id, qRow.id));
      expect((await reply(qRow, q.email, "no thanks", "msg-dag")).status).toBe(200);
      await container.drain();
      expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, qRow.id))).toEqual([]);
      expect((await container.db.select().from(candidates).where(eq(candidates.id, qRow.candidateId)))[0].preferences.talentPoolOptOut).toBe(true);
      expect((await noticesOf(job.id)).filter((n) => n.kind === "message.received")).toEqual([]);
    });

    it("a text with no conversation open reaches a person: ITS for someone locked, on the locked application's own company, and the team for anyone else", async () => {
      const text = (from: string, body: string, sid: string) => app.request("/webhooks/twilio/inbound", form({ From: from, To: "+15550001111", Body: body, MessageSid: sid }));
      const requestsOf = (applicationId: string) => container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, applicationId));
      const inboundOf = async (applicationId: string) => (await commsOf(applicationId)).filter((c) => c.direction === "inbound").map((c) => c.bodyText);

      // The same number at two companies: read at the first, which comes first in the list, and locked at the second.
      const seenAt = await newCompany();
      await usePlan(container, seenAt.id, "ultra");
      const seenJob = await openRole(seenAt);
      const same = "(949) 555-0190";
      const seen = await apply(seenJob, person("Tia", "Visible"), { phone: same });
      await container.db.update(screens).set({ status: "expired" }).where(eq(screens.applicationId, seen.id));
      const job = await openJob(1);
      await fill(job, 1);
      const row = await apply(job, person("Tam"), { phone: same });
      expect(row.lockedAt).not.toBeNull();

      expect((await text("+19495550190", "HUMAN", "SM-tam-1")).status).toBe(200);
      await container.drain();
      const [asked] = await requestsOf(row.id);
      expect(asked).toMatchObject({ kind: "candidate_issue", companyId: job.id });
      expect(await inboundOf(row.id)).toEqual(["HUMAN"]);
      // Not on the other company's record, and neither team hears.
      expect(await requestsOf(seen.id)).toEqual([]);
      expect(await inboundOf(seen.id)).toEqual([]);
      expect((await noticesOf(job.id)).filter((n) => ["screen.human_requested", "message.received"].includes(n.kind))).toEqual([]);
      expect((await noticesOf(seenAt.id)).filter((n) => ["screen.human_requested", "message.received"].includes(n.kind))).toEqual([]);
      await noTeamNoticeNames(job.id);
      // One request at a time; their other words wait on the thread, and anything they text reaches ITS, not only HUMAN.
      expect((await text("+19495550190", "Any news?", "SM-tam-2")).status).toBe(200);
      await container.drain();
      expect(await requestsOf(row.id)).toHaveLength(1);
      expect(await inboundOf(row.id)).toEqual(expect.arrayContaining(["HUMAN", "Any news?"]));
      const other = await apply(job, person("Tod"), { phone: "(949) 555-0191" });
      expect((await text("+19495550191", "When will I hear?", "SM-tod-1")).status).toBe(200);
      await container.drain();
      expect(await requestsOf(other.id)).toHaveLength(1);

      // Someone the team can read: the team is told, and HUMAN brings in a recruiter too.
      const openCompany = await newCompany();
      await usePlan(container, openCompany.id, "ultra");
      const openJobRow = await openRole(openCompany);
      const read2 = person("Ula", "Visible");
      const visible = await apply(openJobRow, read2, { phone: "(949) 555-0192" });
      await container.db.update(screens).set({ status: "expired" }).where(eq(screens.applicationId, visible.id));
      expect((await text("+19495550192", "When will I hear?", "SM-ula-1")).status).toBe(200);
      await container.drain();
      expect((await noticesOf(openCompany.id)).find((n) => n.kind === "message.received")).toMatchObject({ title: `${read2.first} ${read2.last} wrote back` });
      expect(await requestsOf(visible.id)).toEqual([]);
      expect((await text("+19495550192", "HUMAN", "SM-ula-2")).status).toBe(200);
      await container.drain();
      expect((await requestsOf(visible.id)).map((e) => e.kind)).toEqual(["candidate_issue"]);
      expect((await noticesOf(openCompany.id)).find((n) => n.kind === "screen.human_requested")).toMatchObject({ title: `${read2.first} ${read2.last} asked for a person` });
    }, 180_000);

    it("what ITS writes about someone locked stays with ITS", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const p = person("Eli");
      const row = await apply(job, p);
      expect((await reply(row, p.email, "HUMAN", "msg-eli")).status).toBe(200);
      await container.drain();
      const [esc] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, row.id));
      const recruiter = await signInStaff(app, container, "rae.recruiter@identifiedtalent.com", "its_recruiter", "Rae Recruiter");
      expect((await json(recruiter, "POST", `/api/v1/escalations/${esc.id}/claim`)).status).toBe(200);
      // The claim is told in general words: a candidate needed a person.
      const claimed = (await noticesOf(job.id)).filter((n) => n.kind === "recruiter.claimed");
      expect(claimed.length).toBeGreaterThan(0);
      expect(claimed[0].body).toContain("A candidate needed a person");
      const answered = await json(recruiter, "POST", `/api/v1/escalations/${esc.id}/resolve`, { resolution: `Spoke to Eli ${LOCKED}: a strong hygienist.` });
      expect(answered.status, await answered.clone().text()).toBe(200);
      await noTeamNoticeNames(job.id);
      expect((await noticesOf(job.id)).filter((n) => n.kind === "recruiter.resolved")).toEqual([]);
    });

    it("a bounce or a message that could not go tells ITS and never the team", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const p = person("Fay");
      const row = await apply(job, p);
      const [ack] = await commsOf(row.id);
      const r = await app.request("/webhooks/postmark/bounces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fakePostmarkEvent({ providerMessageId: ack.providerMessageId!, email: p.email, type: "HardBounce" })) });
      expect(r.status).toBe(200);
      await container.drain();
      expect((await noticesOf(job.id)).filter((n) => n.kind === "candidate.unreachable")).toEqual([]);
      await noTeamNoticeNames(job.id);
      // The record of what happened stays.
      expect((await container.db.select().from(communications).where(eq(communications.id, ack.id)))[0].status).toBe("bounced");
      // Someone visible is still told.
      const v = person("Gus", "Visible");
      const company = await newCompany();
      await usePlan(container, company.id);
      const other = await openRole(company);
      const vRow = await apply(other, v);
      const [vAck] = await commsOf(vRow.id);
      await app.request("/webhooks/postmark/bounces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fakePostmarkEvent({ providerMessageId: vAck.providerMessageId!, email: v.email, type: "HardBounce" })) });
      expect((await noticesOf(company.id)).filter((n) => n.kind === "candidate.unreachable")).toHaveLength(1);
    });

    it("'Lost your link' works for someone locked, and the team hears nothing", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const p = person("Lia");
      const row = await apply(job, p);
      const before = mailsTo(p.email).length;
      const asked = await app.request("/c/link-request", { ...form({ email: p.email }), headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.210" } });
      expect(asked.status).toBe(303);
      await container.drain();
      const links = mailsTo(p.email).slice(before);
      expect(links).toHaveLength(1);
      expect(links[0].text).toContain(`/c/status/${row.statusToken}`);
      expect((await noticesOf(job.id)).filter((n) => n.title.includes(p.first))).toEqual([]);
    });

    it("Home names nobody locked, while the job is open or once it closed, and its counts are of people the team can open", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      await apply(job, person("Gil"));
      const brief = async () => read<{ cards: Array<{ kind: string; title: string; body: string }> }>(await json(job.cookie, "GET", "/api/v1/brief"));
      const open = await brief();
      expect(JSON.stringify(open)).not.toContain(LOCKED);
      // The one who is read gets the AI interview, so the card's sentence is true of everyone it counts.
      expect(open.cards.find((c) => c.kind === "new_applicants")?.title).toMatch(/^1 person applied to /);
      await close(job);
      const closed = await brief();
      expect(JSON.stringify(closed)).not.toContain(LOCKED);
      expect(closed.cards.find((c) => /not been told/.test(c.title))?.title).toMatch(/^1 person has not been told/);
    });

    it("no interview starts for someone locked, whoever asks", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const row = await apply(job, person("Hal"));
      const started = await withTenant(container.db, job.id, (tx) => startInterviewAgain(tx, container.engine, { companyId: job.id, applicationId: row.id, actor: { kind: "system", id: "test" }, now: new Date() }));
      expect(started).toBe(false);
      expect(await screenRunsOf(row.id)).toEqual([]);
    });

    it("nobody locked nags the team, climbs a ladder or gets 'still being reviewed'", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const row = await apply(job, person("Ida"));
      const later = new Date(Date.now() + 8 * DAY);
      // Stood at a stage the team would be asked about, for as long as it takes: still nothing, because they cannot read her.
      await container.db.update(applications).set({ stage: "triaged", stageChangedAt: new Date(Date.now() - 20 * DAY).toISOString() }).where(eq(applications.id, row.id));
      const detected = await withTenant(container.db, job.id, (tx) => detectStuckRoles(tx, job.id, later));
      expect(detected.flatMap((d) => d.applicationIds ?? [])).not.toContain(row.id);
      await container.db.update(applications).set({ stage: "received", createdAt: new Date(Date.now() - 31 * DAY).toISOString() }).where(eq(applications.id, row.id));
      await setPolicy(job.id, "message.still_reviewing", "auto");
      const noted = await withTenant(container.db, job.id, (tx) => sendStillReviewingNotes(tx, courtesy(new Date(), "still_reviewing"), job.id));
      expect(noted).not.toContain(row.id);
      expect((await commsOf(row.id)).filter((c) => c.templateKey === "still_reviewing")).toEqual([]);
    });
  });

  describe("ITS under a grant naming someone locked", () => {
    /** Someone locked who asked for a person, and the recruiter who took their request, inside the company. */
    const underGrant = async (name: string) => {
      const job = await openJob(1);
      await fill(job, 1);
      const p = person(name);
      const row = await apply(job, p);
      expect((await reply(row, p.email, "HUMAN", `msg-${name}`)).status).toBe(200);
      await container.drain();
      const [ask] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, row.id));
      const recruiter = await signInStaff(app, container, `${name.toLowerCase()}.recruiter@identifiedtalent.com`, "its_recruiter", `${name} Recruiter`);
      expect((await json(recruiter, "POST", `/api/v1/escalations/${ask.id}/claim`)).status).toBe(200);
      expect((await json(recruiter, "POST", "/api/v1/auth/switch", { companyId: job.id })).status).toBe(200);
      return { job, p, row, recruiter, ask };
    };

    it("nothing spends AI on them and no interview starts: refused by the route and not offered, with the reason on the button, and they read as having no AI interview coming", async () => {
      const { job, row, recruiter } = await underGrant("Noa");
      const aiBefore = (await runsOf(job.id)).length;
      const open = await json(recruiter, "GET", `/api/v1/applications/${row.id}`);
      expect(open.status).toBe(200);
      const detail = await read<{ lockedAt: string | null; allowedActions: string[]; blockedReasons: Record<string, string>; stageMoves: Array<{ to: string; allowed: boolean; blockedReason?: string }>; aiInterview: unknown; ownerStageLabel: string; interviewPlan: Array<{ key: string }> }>(open);
      expect(detail.lockedAt).not.toBeNull();
      for (const cap of ["invite_screen", "ask_in_screen", "interview", "advance_to_interview"]) {
        expect(detail.allowedActions, cap).not.toContain(cap);
        expect(detail.blockedReasons[cap], cap).toBe(NO_WORK_WHILE_LOCKED);
      }
      expect(detail.stageMoves.find((m) => m.to === "interviewing")).toMatchObject({ allowed: false, blockedReason: NO_WORK_WHILE_LOCKED });
      // Their application is not being read for an interview that is coming: nothing may say so.
      expect(detail.aiInterview).toBeNull();
      expect(detail.ownerStageLabel).toBe("No AI interview yet");
      // What is left to do for them stays: deciding, and writing to them.
      expect(detail.allowedActions).toEqual(expect.arrayContaining(["reject", "hold"]));

      for (const action of ["invite_screen", "ask_in_screen", "advance_to_interview"]) {
        const refused = await json(recruiter, "POST", `/api/v1/applications/${row.id}/actions`, { action });
        expect(refused.status, action).toBe(409);
        expect((await read<{ error: { code: string; message: string } }>(refused)).error, action).toMatchObject({ code: "not_while_locked", message: NO_WORK_WHILE_LOCKED });
      }
      const owner = await read<{ user: { id: string } }>(await json(job.cookie, "GET", "/api/v1/auth/me"));
      const approved = await json(recruiter, "POST", `/api/v1/applications/${row.id}/interviews`, { roundKey: detail.interviewPlan[0].key, interviewerUserIds: [owner.user.id], linkSource: "calendar" });
      expect(approved.status, await approved.clone().text()).toBe(409);
      expect((await read<{ error: { code: string } }>(approved)).error.code).toBe("not_while_locked");
      expect((await read<{ error: { code: string } }>(await json(recruiter, "GET", `/api/v1/applications/${row.id}/interview-draft`))).error.code).toBe("not_while_locked");
      const suggested = await json(recruiter, "POST", `/api/v1/applications/${row.id}/messages/suggest`, { purpose: "update" });
      expect(suggested.status, await suggested.clone().text()).toBe(409);

      // A suggestion left waiting about them, from however it got there, starts nothing either; "Not now" still goes through.
      const [waiting] = await container.db.insert(approvalRequests).values({ companyId: job.id, roleId: job.roleId, applicationId: row.id, actionType: "application.invite_screen", subject: { type: "application", id: row.id }, proposal: {}, requestedBy: { kind: "system", id: "test" }, requiredRoles: ["recruiter"] }).returning();
      const yes = await json(recruiter, "POST", `/api/v1/approvals/${waiting.id}/decide`, { decision: "approve" });
      expect(yes.status, await yes.clone().text()).toBe(409);
      expect((await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, waiting.id)))[0].status).toBe("pending");
      expect((await json(recruiter, "POST", `/api/v1/approvals/${waiting.id}/decide`, { decision: "reject" })).status).toBe(200);

      await container.drain();
      expect(await screenRunsOf(row.id)).toEqual([]);
      expect(await container.db.select().from(screens).where(eq(screens.applicationId, row.id))).toEqual([]);
      expect(await container.db.select().from(interviews).where(eq(interviews.applicationId, row.id))).toEqual([]);
      expect((await runsOf(job.id)).length).toBe(aiBefore);
      expect((await applicationOf(row.id)).stage).toBe(row.stage);
    }, 120_000);

    it("a recruiter's notes from a call are kept as their own note with no screen, no scorecard and no AI, whatever the form says; the team reads them after an upgrade, which still starts the interview by itself", async () => {
      const { job, p, row, recruiter } = await underGrant("Ona");
      const aiBefore = (await runsOf(job.id)).length;
      const notesUrl = `/api/v1/applications/${row.id}/screen/recruiter-notes`;
      // What the recruiter had already written stays, and so does its starter.
      expect((await json(recruiter, "PUT", `/api/v1/applications/${row.id}/notes/mine`, { starter: "for_and_against", body: "Sounds organised." })).status).toBe(201);
      for (const [complete, text] of [[true, "Called her; she can start in two weeks."], [false, "Left a voicemail on Friday."]] as const) {
        const added = await json(recruiter, "POST", notesUrl, { notes: [{ text }], complete });
        expect(added.status, await added.clone().text()).toBe(200);
        expect(await read(added)).toEqual({ ok: true, screenId: null, completed: false, keptAsNote: true });
      }
      await container.drain();
      expect(await container.db.select().from(screens).where(eq(screens.applicationId, row.id))).toEqual([]);
      expect(await screenRunsOf(row.id)).toEqual([]);
      expect((await runsOf(job.id)).length).toBe(aiBefore);
      expect((await applicationOf(row.id)).stage).toBe(row.stage);
      // On the record, with no words; the words are the recruiter's own note, each sitting after the last.
      expect(await auditsOf(row.id, "screen.recruiter_notes_added")).toHaveLength(2);
      const kept = await read<{ notes: Array<{ body: string; mine: boolean; starter: string | null }> }>(await json(recruiter, "GET", `/api/v1/applications/${row.id}/notes`));
      expect(kept.notes).toHaveLength(1);
      expect(kept.notes[0].mine).toBe(true);
      expect(kept.notes[0].starter).toBe("for_and_against");
      expect(kept.notes[0].body).toMatch(/^Sounds organised\.[\s\S]*Called her; she can start in two weeks\.[\s\S]*Left a voicemail on Friday\./);
      // A note has its limit, and one too long leaves the earlier words as they were.
      const tooLong = await json(recruiter, "POST", notesUrl, { notes: [{ text: "x".repeat(4000) }, { text: "y".repeat(4000) }], complete: false });
      expect(tooLong.status).toBe(400);
      expect((await read<{ error: { code: string } }>(tooLong)).error.code).toBe("message_too_long");
      // Nobody at the company reads them while locked.
      expect((await json(job.cookie, "GET", `/api/v1/applications/${row.id}/notes`)).status).toBe(402);

      expect((await changePlan(job.id, "pro")).unlocked).toBe(1);
      const opened = await applicationOf(row.id);
      expect(opened.stage).toBe("screen_invited");
      expect(await container.db.select().from(screens).where(eq(screens.applicationId, row.id))).toHaveLength(1);
      expect(mailsTo(p.email).some((m) => /Thanks again for applying/.test(m.text))).toBe(true);
      const read2 = await read<{ notes: Array<{ body: string; author: { name: string } }> }>(await json(job.cookie, "GET", `/api/v1/applications/${row.id}/notes`));
      expect(read2.notes[0]).toMatchObject({ author: { name: "ITS recruiter" } });
      expect(read2.notes[0].body).toContain("Left a voicemail on Friday.");
    }, 120_000);

    for (const level of ["approval", "human_only"] as const) {
      it(`what they write goes under the company's "${level}" rule, on the record, because nobody there may read it or approve it`, async () => {
        const { job, p, row, recruiter } = await underGrant(level === "approval" ? "Uma" : "Una");
        await setPolicy(job.id, "message.send_freeform", level);
        await setPolicy(job.id, "disposition.send", level);
        const before = mailsTo(p.email).length;
        // The screen says it goes, before anything is pressed: not "an owner or admin reads it".
        expect(await read(await json(recruiter, "GET", `/api/v1/applications/${row.id}/messages/preview`))).toMatchObject({ needsApproval: false });
        const sent = await json(recruiter, "POST", `/api/v1/applications/${row.id}/messages`, { text: "This is a person at ITS: how can I help?" });
        expect(sent.status, await sent.clone().text()).toBe(201);
        expect(await read(sent)).toMatchObject({ ok: true, status: "queued" });
        await container.drain();
        expect(mailsTo(p.email).length).toBe(before + 1);
        expect(mailsTo(p.email).at(-1)?.text).toContain("This is a person at ITS");

        // So does the decision message, which the same rule would hold for an approver the company does not have.
        const declined = await json(recruiter, "POST", `/api/v1/applications/${row.id}/actions`, { action: "reject", reason: "position_filled" });
        expect(declined.status, await declined.clone().text()).toBe(200);
        expect((await read<{ decisionMessage: { policy: string } }>(declined)).decisionMessage.policy).toBe("sends");
        expect((await read<{ declineMessage: string }>(await json(recruiter, "GET", `/api/v1/applications/${row.id}`))).declineMessage).toBe("sends");
        const told = await json(recruiter, "POST", `/api/v1/applications/${row.id}/actions`, { action: "send_decision" });
        expect(told.status, await told.clone().text()).toBe(200);
        expect(await read(told)).toMatchObject({ candidateNotice: "queued" });
        await container.drain();
        expect(mailsTo(p.email).length).toBe(before + 2);

        expect(await container.db.select().from(approvalRequests).where(eq(approvalRequests.applicationId, row.id))).toEqual([]);
        const lines = await auditsOf(row.id, "message.approval_skipped");
        expect(lines.map((l) => (l.details as { actionType: string }).actionType).sort()).toEqual(["disposition.send", "message.send_freeform"]);
        expect(lines[0].reason).toBe("Nobody at the company may read someone locked, so nobody there can approve a message to them.");
        await noTeamNoticeNames(job.id);
      }, 120_000);
    }

    it("the rule still holds for someone the company can read, under the same kind of grant", async () => {
      const job = await openJob(1);
      const [seen] = await fill(job, 1);
      await setPolicy(job.id, "message.send_freeform", "approval");
      const asked = await json(job.cookie, "POST", "/api/v1/escalations", { kind: "review", applicationId: seen.id, question: "Please look at this person." });
      expect(asked.status, await asked.clone().text()).toBe(201);
      const recruiter = await signInStaff(app, container, "visa.recruiter@identifiedtalent.com", "its_recruiter", "Visa Recruiter");
      expect((await json(recruiter, "POST", `/api/v1/escalations/${(await read<{ id: string }>(asked)).id}/claim`)).status).toBe(200);
      expect((await json(recruiter, "POST", "/api/v1/auth/switch", { companyId: job.id })).status).toBe(200);
      expect(await read(await json(recruiter, "GET", `/api/v1/applications/${seen.id}/messages/preview`))).toMatchObject({ needsApproval: true });
      const held = await json(recruiter, "POST", `/api/v1/applications/${seen.id}/messages`, { text: "A question for you." });
      expect(held.status, await held.clone().text()).toBe(202);
      expect(await auditsOf(seen.id, "message.approval_skipped")).toEqual([]);
    }, 120_000);
  });

  describe("the close-out note", () => {
    it(`goes once, by day ${CLOSE_OUT_DAYS}, declines nobody, moves no stage and tells the team nothing`, async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const p = person("Jan");
      const row = await apply(job, p);
      const applied = Date.parse(row.createdAt);
      // Nothing yet: the promise is days away.
      expect(await closeOutNotes(job.id, new Date(applied + 28 * DAY))).toEqual([]);
      // The daily check goes in the last day before the promise falls due, never after it.
      const noted = await closeOutNotes(job.id, new Date(applied + 29 * DAY + 60_000));
      expect(noted).toEqual([row.id]);
      await container.drain();
      const notes = (await commsOf(row.id)).filter((c) => c.templateKey === "close_out");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ idempotencyKey: `close_out:${row.id}`, status: "sent", disclosureIncluded: true });
      const statusUrl = `${container.env.JOBS_BASE_URL}/c/status/${row.statusToken}`;
      expect(notes[0].bodyText).toContain(closeOutNoteLine({ roleTitle: job.title, companyName: job.name, statusUrl }));
      expect(notes[0].bodyText).not.toMatch(/\b(plan|upgrade|locked|decline)\b/i);
      expect(await closeOutNotes(job.id, new Date(applied + 40 * DAY))).toEqual([]);
      expect((await commsOf(row.id)).filter((c) => c.templateKey === "close_out")).toHaveLength(1);
      const after = await applicationOf(row.id);
      expect(after.stage).toBe("received");
      expect(after.lockedAt).not.toBeNull();
      expect(after.toldState).toBe("not_told");
      await noTeamNoticeNames(job.id);
      // The page says what the note said, not a date that has passed.
      const onPage = await statusOf(row);
      expect(onPage).toContain(CLOSED_OUT_STATUS_LINE);
      expect(onPage).not.toContain("We will email you when the job closes");
    });

    it("goes to nobody who left, was opened, or whose job closed; one waiting does not go once they are opened", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const gone = await apply(job, person("Kit"));
      expect((await app.request(`/c/status/${gone.statusToken}/withdraw`, form({ confirm: "yes" }))).status).toBe(302);
      const stays = await apply(job, person("Lux"));
      await container.drain();
      const later = new Date(Date.parse(stays.createdAt) + 31 * DAY);
      expect(await closeOutNotes(job.id, later)).toEqual([stays.id]);
      expect((await commsOf(gone.id)).filter((c) => c.templateKey === "close_out")).toEqual([]);

      const closing = await openJob(1);
      await fill(closing, 1);
      await apply(closing, person("Mae"));
      await close(closing);
      expect(await closeOutNotes(closing.id, new Date(Date.now() + 31 * DAY))).toEqual([]);

      // Opened while its note waits: the outbox withdraws it, because it says nobody has reviewed them.
      const waiting = await openJob(1);
      await fill(waiting, 1);
      const p = person("Ned");
      const row = await apply(waiting, p);
      expect(await closeOutNotes(waiting.id, new Date(Date.parse(row.createdAt) + 31 * DAY))).toEqual([row.id]);
      await changePlan(waiting.id, "pro");
      const [note] = (await commsOf(row.id)).filter((c) => c.templateKey === "close_out");
      expect(note.status).toBe("cancelled");
      expect(mailsTo(p.email).filter((m) => /has not been reviewed/.test(m.text))).toEqual([]);
    });
  });

  describe("when the job closes", () => {
    it("a person's Send for the others tells them too, once, with no name anywhere; and it never reopens by anything they do", async () => {
      const job = await openJob(1);
      const [visible] = await fill(job, 1);
      const p = person("Ona");
      const row = await apply(job, p);
      const closed = await close(job);
      expect(closed.movedToTalentPool).toBe(1);
      expect(closed.keptInTalentPool).toBe(1);
      expect(closed.closingMessage).toMatchObject({ count: 1, locked: 1 });
      expect(closed.closingMessage.people.map((x) => x.applicationId)).toEqual([visible.id]);
      const sent = await json(job.cookie, "POST", `/api/v1/roles/${job.roleId}/closing-message`, { confirm: true });
      expect(sent.status, await sent.clone().text()).toBe(200);
      await container.drain();
      const closing = () => mailsTo(p.email).filter((m) => m.subject === `Your application to ${job.name}`);
      expect(closing()).toHaveLength(1);
      expect(closing()[0].text).not.toContain("keep your information");
      expect((await applicationOf(row.id)).toldState).toBe("sent");
      // The team's own message keeps its line.
      const [toVisible] = (await commsOf(visible.id)).filter((c) => c.idempotencyKey === `role_closed:${visible.id}`);
      expect(toVisible.bodyText).toContain("keep your information");
      // The daily check finds nobody left to tell.
      expect(await safetyNet(job.id, new Date(Date.now() + FIVE_WORKING_DAYS_ON))).toEqual([]);
      expect(closing()).toHaveLength(1);
      await noTeamNoticeNames(job.id);
      expect((await applicationOf(row.id)).lockedAt).not.toBeNull();
      // Asking why goes to ITS's compliance queue, as it does for anyone; the team hears nothing of it.
      expect((await reply(row, p.email, "EXPLAIN", "msg-ona")).status).toBe(200);
      await container.drain();
      const asked = await container.db.select().from(dataRequests).where(eq(dataRequests.applicationId, row.id));
      expect(asked.map((d) => d.kind)).toEqual(["human_review"]);
      expect((await noticesOf(job.id)).filter((n) => n.kind === "message.received")).toEqual([]);
      await noTeamNoticeNames(job.id);
    });

    it("under 'ask me first' they are told when the approval comes", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      await setPolicy(job.id, "disposition.send", "approval");
      const p = person("Pat");
      await apply(job, p);
      await close(job);
      const asked = await json(job.cookie, "POST", `/api/v1/roles/${job.roleId}/closing-message`, { confirm: true });
      expect(asked.status).toBe(202);
      const { approvalRequestId } = (await asked.json()) as { approvalRequestId: string };
      expect(mailsTo(p.email).filter((m) => m.subject === `Your application to ${job.name}`)).toEqual([]);
      const decided = await json(job.cookie, "POST", `/api/v1/approvals/${approvalRequestId}/decide`, { decision: "approve" });
      expect(decided.status, await decided.clone().text()).toBe(200);
      await container.drain();
      expect(mailsTo(p.email).filter((m) => m.subject === `Your application to ${job.name}`)).toHaveLength(1);
    });

    it("by itself after five working days, whatever the settings say, with no recruiter and no names", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      await setPolicy(job.id, "disposition.send", "human_only");
      const p = person("Quin");
      const row = await apply(job, p);
      await close(job);
      expect(await safetyNet(job.id, new Date(Date.now() + 2 * DAY))).toEqual([]);
      const net = await safetyNet(job.id, new Date(Date.now() + FIVE_WORKING_DAYS_ON));
      expect(net.filter((x) => x.applicationId === row.id)).toEqual([{ applicationId: row.id, action: "sent" }]);
      await container.drain();
      expect(mailsTo(p.email).filter((m) => m.subject === `Your application to ${job.name}`)).toHaveLength(1);
      await noTeamNoticeNames(job.id);
      const raised = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.companyId, job.id));
      expect(raised.filter((e) => e.question.includes(LOCKED))).toEqual([]);
      // Nobody is reminded about them either.
      const detected = await withTenant(container.db, job.id, (tx) => detectStuckRoles(tx, job.id, new Date(Date.now() + FIVE_WORKING_DAYS_ON)));
      expect(detected.flatMap((d) => d.applicationIds ?? [])).not.toContain(row.id);
    });

    it("someone with no address on file cannot be told, and nobody is brought in to find them", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const row = await apply(job, person("Rey"));
      await container.db.update(candidates).set({ email: null }).where(eq(candidates.id, row.candidateId));
      await close(job);
      expect((await safetyNet(job.id, new Date(Date.now() + FIVE_WORKING_DAYS_ON))).filter((x) => x.applicationId === row.id)).toEqual([]);
      expect(await eventsOf(row.id, "application.untold_fallback")).toHaveLength(1);
      expect((await safetyNet(job.id, new Date(Date.now() + FIVE_WORKING_DAYS_ON + DAY))).filter((x) => x.applicationId === row.id)).toEqual([]);
      expect(await eventsOf(row.id, "application.untold_fallback")).toHaveLength(1);
      const raised = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.companyId, job.id));
      expect(raised.filter((e) => e.applicationId === row.id || e.question.includes(LOCKED))).toEqual([]);
    });
  });

  describe("a change of plan", () => {
    it("a move down locks nobody who could be read, and new arrivals follow the new limit", async () => {
      const company = await newCompany();
      await usePlan(container, company.id, "pro");
      const job = await openRole(company);
      const rows = await fill(job, 6);
      const changed = await changePlan(company.id, "free");
      expect(changed.unlocked).toBe(0);
      for (const row of rows) expect((await applicationOf(row.id)).lockedAt).toBeNull();
      const next = await apply(job, person("Sol"));
      expect(next.lockedAt).not.toBeNull();
      expect((await eventsOf(next.id, "application.locked"))[0].payload).toEqual({ position: 7, limit: 5, plan: "free" });
    });

    it("no limit opens everyone; a plan with no room opens nobody", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const a = await apply(job, person("Tam"));
      const b = await apply(job, person("Una"));
      // Room for nobody: a limit no higher than those already visible.
      expect((await changePlan(job.id, "test_one")).unlocked).toBe(0);
      expect((await applicationOf(a.id)).lockedAt).not.toBeNull();
      const done = await changePlan(job.id, "design_partner");
      expect(done.unlocked).toBe(2);
      expect((await applicationOf(a.id)).lockedAt).toBeNull();
      expect((await applicationOf(b.id)).lockedAt).toBeNull();
    });

    it(`someone who applied ${UNLOCK_INTERVIEW_DAYS} days ago or more, or was told it was not reviewed, is simply visible, with no email and no AI`, async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const noted = person("Wyn");
      const notedRow = await apply(job, noted);
      expect(await closeOutNotes(job.id, new Date(Date.parse(notedRow.createdAt) + 31 * DAY))).toEqual([notedRow.id]);
      await container.drain();
      const old = person("Val");
      const oldRow = await apply(job, old);
      await container.db.update(applications).set({ createdAt: new Date(Date.now() - (UNLOCK_INTERVIEW_DAYS + 1) * DAY).toISOString() }).where(eq(applications.id, oldRow.id));
      const fresh = person("Xia");
      const freshRow = await apply(job, fresh);
      const no = person("Yan");
      const noRow = await apply(job, no, Object.fromEntries(job.eligibility.map((r) => [`elig_${r.key}`, "no"])));
      await container.db.update(applications).set({ createdAt: new Date(Date.now() - (UNLOCK_INTERVIEW_DAYS + 1) * DAY).toISOString() }).where(eq(applications.id, noRow.id));
      const aiBefore = (await runsOf(job.id)).length;
      const mailsBefore = { old: mailsTo(old.email).length, noted: mailsTo(noted.email).length, no: mailsTo(no.email).length };

      await changePlan(job.id, "pro");

      for (const row of [oldRow, notedRow]) {
        const now = await applicationOf(row.id);
        expect(now.lockedAt).toBeNull();
        // In front of the team, ready for review: never "AI interview being prepared" for ever.
        expect(now.stage).toBe("triaged");
        expect(await screenRunsOf(row.id)).toEqual([]);
        expect(await container.db.select().from(screens).where(eq(screens.applicationId, row.id))).toEqual([]);
        expect((await eventsOf(row.id, "application.unlocked"))[0].payload).toMatchObject({ interview: false });
      }
      // A must-have "No" is held for a person, as it always is, and nothing goes to them.
      const held = await applicationOf(noRow.id);
      expect(held.stage).toBe("ineligible");
      expect(held.eligibility?.passed).toBe(false);
      expect(mailsTo(old.email).length).toBe(mailsBefore.old);
      expect(mailsTo(noted.email).length).toBe(mailsBefore.noted);
      expect(mailsTo(no.email).length).toBe(mailsBefore.no);
      // Only the one who goes on to the interview is read.
      expect((await applicationOf(freshRow.id)).stage).toBe("screen_invited");
      const reads = (await runsOf(job.id)).slice(aiBefore);
      expect(reads.length).toBeGreaterThan(0);
      expect(mailsTo(fresh.email).at(-1)!.text).toContain("Thanks again for applying");
    });

    it("someone who emailed in goes on too: the one email carried the AI notice, so nothing waits for it, and the link goes in an email of its own", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const [emailIn] = await container.db.select().from(postings).where(and(eq(postings.roleId, job.roleId), eq(postings.channel, "email_in")));
      const r = await inbound({ From: "noreply@indeed.com", FromName: "Indeed", To: `apply-${emailIn.intakeToken}@${container.integrations.env.intakeDomain}`, Subject: `New applicant: Ike ${LOCKED}`, TextBody: `Ike ${LOCKED} applied via Indeed.\nEmail: ike.lockwood@people.test`, Attachments: [] });
      expect(r.status).toBe(200);
      await container.drain();
      const { applicationId } = (await r.json()) as { applicationId: string };
      const before = (await runsOf(job.id)).length;
      expect((await changePlan(job.id, "pro")).unlocked).toBe(1);
      const now = await applicationOf(applicationId);
      expect(now.lockedAt).toBeNull();
      expect(now.stage).toBe("screen_invited");
      expect((await runsOf(job.id)).length).toBeGreaterThan(before);
      const mail = mailsTo("ike.lockwood@people.test");
      expect(mail).toHaveLength(2);
      expect(mail[0].text).toContain(`${job.name} has your application on file.`);
      expect(mail[1].text).toContain("Thanks again for applying");
      // Nothing waited for the notice to go again: the first intake's email is the notice.
      expect((await intakeRunsOf(applicationId)).map((x) => x.status)).toEqual(["completed", "completed"]);
    });

    it("a must-have No is read when they are opened: held for a person as it always is, named now, and Keep them in sends the link", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const p = person("Yul");
      const row = await apply(job, p, Object.fromEntries(job.eligibility.map((r) => [`elig_${r.key}`, "no"])));
      expect((await noticesOf(job.id)).filter((n) => n.kind === "application.ineligible_hold")).toEqual([]);
      await changePlan(job.id, "pro");
      const held = await applicationOf(row.id);
      expect(held.lockedAt).toBeNull();
      expect(held.stage).toBe("ineligible");
      expect(held.eligibility?.passed).toBe(false);
      expect((await noticesOf(job.id)).filter((n) => n.kind === "application.ineligible_hold").map((n) => n.title)).toEqual([`${p.first} ${p.last} answered no to an eligibility question`]);
      // Nothing about it went to them: their one email went when they applied.
      expect(mailsTo(p.email)).toHaveLength(1);
      expect((await json(job.cookie, "POST", `/api/v1/applications/${row.id}/actions`, { action: "override_eligibility", note: "The answer was a mistake." })).status).toBe(200);
      await container.drain();
      expect((await applicationOf(row.id)).stage).toBe("screen_invited");
      expect(mailsTo(p.email).at(-1)!.text).toContain("Thanks again for applying");
    });

    it("someone whose job closed is opened where they are, with nothing started; someone who left the process stays as they are", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const left = await apply(job, person("Zed"));
      expect((await app.request(`/c/status/${left.statusToken}/withdraw`, form({ confirm: "yes" }))).status).toBe(302);
      const pooled = person("Abe");
      const pooledRow = await apply(job, pooled);
      await container.drain();
      await close(job);
      const before = mailsTo(pooled.email).length;
      await changePlan(job.id, "pro");
      expect((await applicationOf(left.id))).toMatchObject({ stage: "withdrawn", lockedAt: left.lockedAt });
      expect(await eventsOf(left.id, "application.unlocked")).toEqual([]);
      expect((await applicationOf(pooledRow.id))).toMatchObject({ stage: "talent_pool", lockedAt: null });
      expect(await screenRunsOf(pooledRow.id)).toEqual([]);
      expect(mailsTo(pooled.email).length).toBe(before);
      expect((await eventsOf(pooledRow.id, "application.unlocked"))[0].payload).toMatchObject({ interview: false });
    });

    it("someone whose job is paused is opened where they are, with nothing read and nothing sent; someone whose details were deleted is not opened", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const deleted = await apply(job, person("Dov"));
      await withTenant(container.db, job.id, (tx) => anonymizeCandidate(tx, { companyId: job.id, candidateId: deleted.candidateId, actor: { kind: "system", id: "locked-applicants.test" }, deleteFile: async () => undefined }));
      const paused = person("Pam");
      const pausedRow = await apply(job, paused);
      expect((await json(job.cookie, "POST", `/api/v1/roles/${job.roleId}/pause`, {})).status).toBe(200);
      const aiBefore = (await runsOf(job.id)).length;
      const mailsBefore = mailsTo(paused.email).length;
      expect((await changePlan(job.id, "pro")).unlocked).toBe(1);
      expect(await applicationOf(deleted.id)).toMatchObject({ stage: "withdrawn", lockedAt: deleted.lockedAt });
      expect(await applicationOf(pausedRow.id)).toMatchObject({ stage: "triaged", lockedAt: null });
      expect((await eventsOf(pausedRow.id, "application.unlocked"))[0].payload).toMatchObject({ interview: false });
      expect((await runsOf(job.id)).length).toBe(aiBefore);
      expect(await screenRunsOf(pausedRow.id)).toEqual([]);
      expect(mailsTo(paused.email).length).toBe(mailsBefore);
    });

    it("someone who withdrew or was deleted while locked uses no room on an upgrade and has no card and no place in 'view more'; their place is still taken and nothing about them changes", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const left = await apply(job, person("Lev"));
      expect((await app.request(`/c/status/${left.statusToken}/withdraw`, form({ confirm: "yes" }))).status).toBe(302);
      await container.drain();
      // Home's line about more people applying is for people an upgrade would open.
      const moreApplied = async () => (await read<{ cards: Array<{ title: string }> }>(await json(job.cookie, "GET", "/api/v1/brief"))).cards.filter((c) => c.title === `More people applied to ${job.title}.`);
      expect(await moreApplied()).toEqual([]);
      const gone = await apply(job, person("Dia"));
      await withTenant(container.db, job.id, (tx) => anonymizeCandidate(tx, { companyId: job.id, candidateId: gone.candidateId, actor: { kind: "system", id: "locked-applicants.test" }, deleteFile: async () => undefined }));
      expect(await moreApplied()).toEqual([]);
      const waiting = await apply(job, person("Rea"));
      const last = await apply(job, person("Las"));
      expect(await moreApplied()).toHaveLength(1);

      // The team's numbers all say two: on the list, the jobs list, the job's page, the board and the report. The cards keep the places they came in at.
      const list = await read<{ locked: { count: number; cards: Array<{ position: number }> }; counts: { total: number } }>(await json(job.cookie, "GET", `/api/v1/roles/${job.roleId}/applications?counts=1`));
      expect(list.locked.count).toBe(2);
      expect(list.locked.cards.map((c) => c.position)).toEqual([4, 5]);
      expect(list.counts.total).toBe(3);
      const jobs = await read<Array<{ id: string; lockedCount: number; counts: { total: number } }>>(await json(job.cookie, "GET", "/api/v1/roles"));
      expect(jobs.find((j) => j.id === job.roleId)).toMatchObject({ lockedCount: 2, counts: { total: 3 } });
      expect(await read(await json(job.cookie, "GET", `/api/v1/roles/${job.roleId}`))).toMatchObject({ lockedCount: 2 });
      expect(await read(await json(job.cookie, "GET", `/api/v1/roles/${job.roleId}/board`))).toMatchObject({ lockedCount: 2 });
      expect(await read(await json(job.cookie, "GET", `/api/v1/roles/${job.roleId}/report`))).toMatchObject({ applicants: { locked: 2 } });

      // A place is taken once: the next person still comes in behind all of them.
      const next = await apply(job, person("Nix"));
      expect((await eventsOf(next.id, "application.locked"))[0].payload).toMatchObject({ position: 6 });

      // An upgrade with room for one more opens the oldest who can still be read, and nobody who left.
      expect((await changePlan(job.id, "test_two")).unlocked).toBe(1);
      expect((await applicationOf(waiting.id)).lockedAt).toBeNull();
      expect((await applicationOf(last.id)).lockedAt).not.toBeNull();
      // An upgrade with no limit opens everyone who is left, and still nobody who left.
      expect((await changePlan(job.id, "ultra")).unlocked).toBe(2);
      expect((await applicationOf(last.id)).lockedAt).toBeNull();
      for (const row of [left, gone]) {
        expect(await applicationOf(row.id)).toMatchObject({ stage: "withdrawn", lockedAt: row.lockedAt });
        expect(await eventsOf(row.id, "application.unlocked")).toEqual([]);
        expect((await json(job.cookie, "GET", `/api/v1/applications/${row.id}`)).status).toBe(402);
      }
      expect(await read(await json(job.cookie, "GET", `/api/v1/roles/${job.roleId}/applications?counts=1`))).toMatchObject({ locked: { count: 0, cards: [] }, lockedInProcess: 0 });
    }, 120_000);

    it("someone deleted after a decision has no card and uses no room either, whatever step they were left at", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const row = await apply(job, person("Eda"));
      await container.db.update(applications).set({ stage: "talent_pool" }).where(eq(applications.id, row.id));
      await withTenant(container.db, job.id, (tx) => anonymizeCandidate(tx, { companyId: job.id, candidateId: row.candidateId, actor: { kind: "system", id: "locked-applicants.test" }, deleteFile: async () => undefined }));
      // A decided step is not one a deletion moves them from: here it is the deletion that counts, not the stage.
      expect((await applicationOf(row.id)).stage).toBe("talent_pool");
      expect(await read(await json(job.cookie, "GET", `/api/v1/roles/${job.roleId}/applications?counts=1`))).toMatchObject({ locked: { count: 0, cards: [] } });
      expect((await changePlan(job.id, "test_two")).unlocked).toBe(0);
      expect((await applicationOf(row.id)).lockedAt).toBe(row.lockedAt);
    }, 60_000);

    it("'and N more you cannot see yet' is who is still in the running: not someone who withdrew, was deleted, or was already decided", async () => {
      const job = await openJob(2);
      const [hired, backup] = await fill(job, 2);
      await container.db.update(applications).set({ stage: "interview_complete" }).where(inArray(applications.id, [hired.id, backup.id]));
      const stillIn = await apply(job, person("Sia"));
      const left = await apply(job, person("Wyn"));
      expect((await app.request(`/c/status/${left.statusToken}/withdraw`, form({ confirm: "yes" }))).status).toBe(302);
      const gone = await apply(job, person("Gia"));
      await withTenant(container.db, job.id, (tx) => anonymizeCandidate(tx, { companyId: job.id, candidateId: gone.candidateId, actor: { kind: "system", id: "locked-applicants.test" }, deleteFile: async () => undefined }));
      const decided = await apply(job, person("Dex"));
      await container.db.update(applications).set({ stage: "rejected" }).where(eq(applications.id, decided.id));
      await container.drain();

      // The close card reads the list: the one in the running, beside cards for everyone an upgrade could open.
      expect(await read(await json(job.cookie, "GET", `/api/v1/roles/${job.roleId}/applications?counts=1`))).toMatchObject({ locked: { count: 2 }, lockedInProcess: 1 });
      expect((await applicationOf(stillIn.id)).lockedAt).not.toBeNull();

      const recorded = await json(job.cookie, "POST", `/api/v1/applications/${hired.id}/outcome`, { outcome: "hired_externally", confirm: true, hireDate: new Date(Date.now() + 14 * DAY).toISOString().slice(0, 10), offerAcceptedAt: new Date().toISOString().slice(0, 10) });
      const text = await recorded.text();
      expect(recorded.status, text).toBe(201);
      const { hire } = JSON.parse(text) as { hire: { backups: { count: number; locked?: number } } };
      expect(hire.backups).toMatchObject({ count: 1, locked: 1 });

      // Nobody else in the running: the line goes.
      await container.db.update(applications).set({ stage: "rejected" }).where(eq(applications.id, stillIn.id));
      expect(await read(await json(job.cookie, "GET", `/api/v1/roles/${job.roleId}/applications?counts=1`))).toMatchObject({ lockedInProcess: 0 });
    }, 120_000);

    it("each job is counted apart: the oldest on each is opened, up to the new limit, and each new arrival takes the place their own job has", async () => {
      const company = await newCompany();
      await usePlan(container, company.id, "pro");
      const first = await openRole(company);
      const second = await openRole(company);
      await setLimit(company.id, 1);
      await fill(first, 1);
      await fill(second, 1);
      const a1 = await apply(first, person("Ada"));
      const a2 = await apply(first, person("Abi"));
      const b1 = await apply(second, person("Bea"));
      const b2 = await apply(second, person("Bud"));
      expect((await eventsOf(b1.id, "application.locked"))[0].payload).toMatchObject({ position: 2 });
      expect((await changePlan(company.id, "test_two")).unlocked).toBe(2);
      expect((await applicationOf(a1.id)).lockedAt).toBeNull();
      expect((await applicationOf(b1.id)).lockedAt).toBeNull();
      expect((await applicationOf(a2.id)).lockedAt).not.toBeNull();
      expect((await applicationOf(b2.id)).lockedAt).not.toBeNull();
    });

    it("once they are opened a reply goes to the team, as anyone's does, and no longer to ITS", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const p = person("Rob");
      const row = await apply(job, p);
      await changePlan(job.id, "pro");
      expect((await reply(row, p.email, "When will I hear?", "msg-rob")).status).toBe(200);
      await container.drain();
      expect((await noticesOf(job.id)).filter((n) => n.kind === "message.received").map((n) => n.title)).toEqual([`${p.first} ${p.last} wrote back`]);
      expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, row.id))).toEqual([]);
    });

    it("the team's clocks count from the unlock: an upgrade never reads as weeks of neglect", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const row = await apply(job, person("Bob"));
      await changePlan(job.id, "pro");
      // Someone who stood at a waiting stage long before anyone could read them.
      await container.db.update(applications).set({ stage: "triaged", stageChangedAt: new Date(Date.now() - 30 * DAY).toISOString() }).where(eq(applications.id, row.id));
      const waitingNow = async (at: Date) => (await withTenant(container.db, job.id, (tx) => detectStuckRoles(tx, job.id, at))).find((d) => d.detector === "candidates_waiting" && (d.applicationIds ?? []).includes(row.id));
      expect(await waitingNow(new Date(Date.now() + DAY))).toBeUndefined();
      const later = await waitingNow(new Date(Date.now() + 4 * DAY));
      expect(later?.days).toBe(4);
    });

    it("a held decision counts from the unlock too: nobody is reminded or told by itself the moment they come into view", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      const p = person("Cal");
      const row = await apply(job, p);
      await close(job);
      await changePlan(job.id, "pro");
      const unlockedAt = Date.now();
      // The job closed long ago as far as the stage says.
      await container.db.update(applications).set({ stageChangedAt: new Date(unlockedAt - 20 * DAY).toISOString() }).where(eq(applications.id, row.id));
      const untold = async (at: Date) => (await withTenant(container.db, job.id, (tx) => detectStuckRoles(tx, job.id, at))).find((d) => d.detector === "decisions_untold" && (d.applicationIds ?? []).includes(row.id));
      expect(await untold(new Date(unlockedAt + 60_000))).toBeUndefined();
      expect((await safetyNet(job.id, new Date(unlockedAt + 60_000))).filter((x) => x.applicationId === row.id)).toEqual([]);
      expect(await untold(new Date(unlockedAt + 8 * DAY))).toBeDefined();
      // The day the panel names is the one the safety net will act on: from the unlock, not long past.
      const detail = await read<{ untoldFallbackOn: string | null }>(await json(job.cookie, "GET", `/api/v1/applications/${row.id}`));
      expect(Date.parse(detail.untoldFallbackOn!)).toBeGreaterThan(unlockedAt);
    });

    it("a volume alert on a job with locked people does not say everyone stays in the process", async () => {
      const job = await openJob(1);
      await fill(job, 1);
      await apply(job, person("Dee"));
      await withPlatform(container.db, (tx) => tx.update(roles).set({ volumeAlertPerDay: 1 }).where(eq(roles.id, job.roleId)));
      moveClock(Date.now() + DAY + 60_000);
      try {
        await container.drain();
      } finally {
        moveClock(null);
      }
      const alerts = (await noticesOf(job.id)).filter((n) => n.kind === "volume.high");
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0].body).toContain("Nobody is turned away automatically.");
      expect(alerts[0].body).not.toContain("everyone who already applied stays in the process");
    });
  });
});
