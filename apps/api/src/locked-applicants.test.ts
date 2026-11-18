import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CandidateList, PlanChangeAnswer } from "@ros/contracts";
import { CLOSED_OUT_STATUS_LINE, CLOSE_OUT_DAYS, ON_FILE_LAST_STEP, ON_FILE_NOTICE, ON_FILE_SOFTWARE_LINE, closeOutDayWords, closeOutDueAt, onFileFormLine, onFileNoDateLine, onFileReceiptLine, onFileStatusLine } from "@ros/core";
import { CLOSE_OUT_TEMPLATE, afterApplyingSteps } from "@ros/agents";
import { aiRuns, applications, assessments, auditRecords, candidates, communications, companies, documents, entitlements, events, notifications, withPlatform, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { unlockApplicants } from "@ros/workflows";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { sendDueCloseOutNotes } from "./services/close-out";
import { applicationForm, plantJob, seedCompany, signInAdmin } from "./test-helpers";

/**
 * Someone who applies to a job past its plan's candidates per job, from their own side and the plan's: the application
 * is stored and never read by AI, the team sees only a card, and every page and email tells them the truth in words
 * with nothing about a plan (the on-file wording of packages/core/src/candidate-lock.ts). A change of plan opens the
 * oldest first, and they are then read. Whoever is still on file hears once: when their job closes, or at the latest
 * 30 days after applying. What the team can and cannot read is apps/api/src/candidate-lock.test.ts.
 */
describe("an applicant past the plan's candidates per job", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let admin = "";
  let made = 0;
  const DAY = 86_400_000;
  const TITLE = "Dental Hygienist";
  /** A word about a plan, which no candidate ever reads. */
  const PLAN_WORDS = /\bplans?\b|upgrad|\blimit\b|\blocked\b/i;

  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "test" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const read = async <T>(r: Response) => (await r.json()) as T;
  const form = (path: string, fields: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  /** A candidate's page as they read it: its words, without its styles and scripts. */
  const shown = async (path: string, cookie = "") => (await (await app.request(path, { headers: { cookie } })).text()).replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, "\"");
  const mailTo = (email: string) => (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === email);

  /** A company with one job open: on Free as it is created (five people per job), or with its plan reading `limit` people per job. */
  const companyWithJob = async (limit?: number) => {
    made += 1;
    const name = `Harbor Dental ${made}`;
    const company = await seedCompany(app, { email: `owner-${made}@onfile.test`, name });
    if (limit !== undefined) await withPlatform(container.db, (tx) => tx.update(entitlements).set({ limit }).where(and(eq(entitlements.companyId, company.companyId), eq(entitlements.key, "candidates_per_job"))));
    const [{ timezone }] = await container.db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, company.companyId));
    return { cookie: company.owner, companyId: company.companyId, slug: company.slug, name, timezone, n: made, roleId: await plantJob(container, { companyId: company.companyId, title: TITLE }) };
  };
  type Job = Awaited<ReturnType<typeof companyWithJob>>;
  const emailOf = (job: Job, first: string) => `${first.toLowerCase()}.${job.n}@people.test`;
  const rowOf = async (job: Job, first: string) => {
    const [cand] = await container.db.select().from(candidates).where(and(eq(candidates.companyId, job.companyId), eq(candidates.email, emailOf(job, first))));
    return (await container.db.select().from(applications).where(and(eq(applications.roleId, job.roleId), eq(applications.candidateId, cand.id))))[0];
  };
  /** The form, as a browser posts it. `Onfile` is the family name of everyone expected past the limit, so a team's notice that named one would show. */
  const post = (job: Job, first: string, last = "Tester", fields: Record<string, string> = {}) => app.request(`/careers/${job.slug}/jobs/${job.roleId}/apply`, { method: "POST", body: applicationForm({ firstName: first, lastName: last, email: emailOf(job, first), ...fields }, "Registered Dental Hygienist at Coastal Dental 2019 - present\nRadiography certificate\nPerio maintenance, Dentrix") });
  const apply = async (job: Job, first: string, last = "Tester") => {
    const res = await post(job, first, last);
    expect(res.status, await res.clone().text()).toBe(302);
    await container.drain();
    return rowOf(job, first);
  };
  const byDayOf = (job: Job, appliedAt: string | Date) => closeOutDayWords(closeOutDueAt(appliedAt), job.timezone);
  const listOf = async (job: Job) => read<CandidateList>(await json(job.cookie, "GET", `/api/v1/roles/${job.roleId}/applications?tab=new`));
  const teamNotices = async (job: Job) => JSON.stringify(await container.db.select().from(notifications).where(eq(notifications.companyId, job.companyId)));
  const notesWritten = async (job: Job) => (await container.db.select({ id: communications.id }).from(communications).where(and(eq(communications.companyId, job.companyId), eq(communications.templateKey, CLOSE_OUT_TEMPLATE)))).length;
  /** The daily check as the worker runs it, `at` from now: how many close-out notes it wrote for this company. */
  const closeOutNotes = async (job: Job, at: number) => {
    const before = await notesWritten(job);
    await sendDueCloseOutNotes({ db: container.db, integrations: container.integrations, jobsBaseUrl: container.env.JOBS_BASE_URL }, new Date(Date.now() + at));
    return (await notesWritten(job)) - before;
  };
  const NOTE_SUBJECT = (job: Job) => `Your application: ${TITLE} at ${job.name}`;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    admin = await signInAdmin(app, container, "ada.admin@identifiedtalent.com", "Ada Admin");
  });
  afterAll(async () => {
    await container.close();
  });

  it("on Free the sixth person to apply to a job is on file: stored, never read by AI, a card to the team, and told so in words with nothing about a plan, on every page and in their one email", async () => {
    const job = await companyWithJob();
    const jobPath = `/careers/${job.slug}/jobs/${job.roleId}`;
    // before the limit: what happens next is a review, and the form has nothing more to say
    let jobPage = await shown(jobPath);
    for (const step of afterApplyingSteps(job.name)) expect(jobPage).toContain(step);
    expect(jobPage).not.toContain(ON_FILE_LAST_STEP);
    let applyPage = await shown(`${jobPath}/apply`);
    expect(applyPage).not.toContain(onFileFormLine(job.name));
    expect(applyPage).not.toContain("onFileShown");
    for (const first of ["Ada", "Ben", "Cy", "Dee", "Eli"]) expect((await apply(job, first)).lockedAt, first).toBeNull();
    expect((await listOf(job)).counts).toMatchObject({ total: 5, locked: 0 });

    // past it, the job's pages say so before anyone applies, the same for everyone
    jobPage = await shown(jobPath);
    expect(jobPage).toContain(ON_FILE_LAST_STEP);
    expect(jobPage).not.toContain(afterApplyingSteps(job.name)[0]);
    applyPage = await shown(`${jobPath}/apply`);
    expect(applyPage).toContain(onFileFormLine(job.name));
    expect(applyPage).toContain(ON_FILE_SOFTWARE_LINE);
    expect(applyPage).toContain('<input type="hidden" name="onFileShown" value="yes"/>');
    for (const page of [jobPage, applyPage]) expect(page.match(PLAN_WORDS)).toBeNull();

    // the sixth applies: the receipt says they are on file and by when they hear
    const aiBefore = (await container.db.select().from(aiRuns).where(eq(aiRuns.companyId, job.companyId))).length;
    const sent = await post(job, "Fay", "Onfile", { onFileShown: "yes" });
    expect(sent.status).toBe(302);
    const receiptCookie = sent.headers.get("set-cookie")!.match(/ros_applied=[^;,]+/)![0];
    const receipt = await shown(sent.headers.get("location")!, receiptCookie);
    expect(receipt).toContain(onFileReceiptLine(job.name, byDayOf(job, new Date())));
    expect(receipt).toContain("People make every decision.");
    expect(receipt).not.toContain(afterApplyingSteps(job.name)[0]);
    // opened later, with the page's cookie gone, it still promises no review
    const bare = await shown(sent.headers.get("location")!);
    expect(bare).toContain("The email we sent you says what happens next.");
    expect(bare).not.toContain(afterApplyingSteps(job.name)[0]);
    for (const page of [receipt, bare]) expect(page.match(PLAN_WORDS)).toBeNull();
    await container.drain();

    // stored, with their file checked, and nothing of theirs read by AI
    const fay = await rowOf(job, "Fay");
    expect(fay).toMatchObject({ stage: "received", extraction: null });
    expect(fay.lockedAt).not.toBeNull();
    expect(fay.answers.noticeVersionsShown).toContain(ON_FILE_NOTICE);
    expect((await container.db.select().from(documents).where(eq(documents.applicationId, fay.id))).map((d) => d.status)).toEqual(["clean"]);
    expect(await container.db.select().from(assessments).where(eq(assessments.applicationId, fay.id))).toEqual([]);
    expect((await container.db.select().from(aiRuns).where(eq(aiRuns.companyId, job.companyId))).length).toBe(aiBefore);
    expect((await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "application_intake"))).find((r) => r.subject.id === fay.id)?.status).toBe("completed");
    // why, on the record: arrival order and the plan's numbers, never a name or a score
    const why = { position: 6, limit: 5, plan: "free" };
    expect((await container.db.select().from(events).where(and(eq(events.type, "application.locked"), eq(events.subjectId, fay.id)))).map((e) => e.payload)).toEqual([why]);
    expect((await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, job.companyId), eq(auditRecords.action, "application.locked")))).map((a) => a.details)).toEqual([why]);

    // their one email: on file, when they hear, their own link, and none of the steps of a review
    const byDay = byDayOf(job, fay.createdAt);
    const mails = mailTo(emailOf(job, "Fay"));
    expect(mails.map((m) => m.subject)).toEqual([`Thank you for applying: ${TITLE} at ${job.name}`]);
    expect(mails[0].text).toContain(`${onFileReceiptLine(job.name, byDay)} People make every decision.`);
    expect(mails[0].text).toContain(`/c/status/${fay.statusToken}`);
    expect(mails[0].text).not.toContain("What happens next");
    expect(`${mails[0].subject} ${mails[0].text}`.match(PLAN_WORDS)).toBeNull();
    // their own page says the same, and never that the team is reviewing them
    const status = await shown(`/c/status/${fay.statusToken}`);
    expect(status).toContain(onFileStatusLine(job.name, byDay));
    expect(status).not.toContain("The hiring team is reviewing your application.");
    expect(status.match(PLAN_WORDS)).toBeNull();

    // the team reads five people and one card: where she came in and when, and nothing else
    const list = await listOf(job);
    expect(list.rows.map((r) => r.name).sort()).toEqual(["Ada Tester", "Ben Tester", "Cy Tester", "Dee Tester", "Eli Tester"]);
    expect(list.counts).toMatchObject({ total: 6, locked: 1 });
    expect(list.locked).toEqual({ count: 1, cards: [{ position: 6, appliedAt: new Date(fay.createdAt).toISOString() }] });
    expect((await json(job.cookie, "GET", `/api/v1/applications/${fay.id}`)).status).toBe(402);

    // a place is taken once: someone the team can read withdraws, and the next person is on file all the same
    const ada = await rowOf(job, "Ada");
    expect((await form(`/c/status/${ada.statusToken}/withdraw`, { confirm: "yes" })).status).toBe(302);
    const gil = await apply(job, "Gil", "Onfile");
    expect(gil.lockedAt).not.toBeNull();
    expect((await container.db.select().from(events).where(and(eq(events.type, "application.locked"), eq(events.subjectId, gil.id))))[0].payload).toEqual({ position: 7, limit: 5, plan: "free" });
    // the words depend on the job and never on who asks: a second application from someone the team can read gets the same receipt, and changes nothing
    const again = await post(job, "Ben");
    expect(await shown(again.headers.get("location")!, again.headers.get("set-cookie")!.match(/ros_applied=[^;,]+/)![0])).toContain(onFileReceiptLine(job.name, byDayOf(job, new Date())));
    await container.drain();
    expect((await rowOf(job, "Ben")).lockedAt).toBeNull();
    expect(await container.db.select().from(applications).where(eq(applications.roleId, job.roleId))).toHaveLength(7);

    // someone on file can still ask about their information and withdraw, and the team hears nothing of either
    expect((await form(`/c/status/${fay.statusToken}/privacy`, { kind: "access", details: "What do you hold about me?" })).status).toBe(302);
    expect((await form(`/c/status/${gil.statusToken}/withdraw`, { confirm: "yes" })).headers.get("location")).toBe(`/c/status/${gil.statusToken}?withdrawn=1`);
    await container.drain();
    expect((await rowOf(job, "Gil")).stage).toBe("withdrawn");
    expect(await teamNotices(job)).not.toContain("Onfile");
    expect(await teamNotices(job)).toContain("Ada Tester withdrew");
  }, 120_000);

  it("a change of plan opens the people past the old limit, oldest first and up to the new one, and they are then read; someone who withdrew there is not opened, and a move down locks nobody", async () => {
    const job = await companyWithJob(2);
    for (const first of ["Ann", "Bo"]) expect((await apply(job, first)).lockedAt, first).toBeNull();
    for (const first of ["Cal", "Dot", "Eve", "Flo"]) expect((await apply(job, first, "Onfile")).lockedAt, first).not.toBeNull();
    const dot = await rowOf(job, "Dot");
    expect((await form(`/c/status/${dot.statusToken}/withdraw`, { confirm: "yes" })).status).toBe(302);
    await container.drain();

    // room for two more: the two oldest still waiting are opened, in the order they came; who withdrew is not, and uses no room
    const actor = { kind: "system" as const, id: "test_seed" };
    const opened = await withPlatform(container.db, (tx) => unlockApplicants(tx, container.engine, { companyId: job.companyId, planKey: "basic", limit: 4, actor, reason: "They asked to upgrade.", now: new Date() }));
    expect(opened).toEqual({ unlocked: 2, reading: 2 });
    await container.drain();
    const lockedNow = async () => Object.fromEntries(await Promise.all(["Ann", "Bo", "Cal", "Dot", "Eve", "Flo"].map(async (first) => [first, !!(await rowOf(job, first)).lockedAt] as const)));
    expect(await lockedNow()).toEqual({ Ann: false, Bo: false, Cal: false, Dot: true, Eve: false, Flo: true });
    expect((await rowOf(job, "Dot")).stage).toBe("withdrawn");
    // each opening is on the record with why, and no name
    const cal = await rowOf(job, "Cal");
    const [unlocked] = await container.db.select().from(events).where(and(eq(events.type, "application.unlocked"), eq(events.subjectId, cal.id)));
    expect(unlocked.payload).toMatchObject({ cause: "plan_changed", plan: "basic", limit: 4, reading: true });
    expect((await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, job.companyId), eq(auditRecords.action, "application.unlocked")))).map((a) => a.reason)).toEqual(["They asked to upgrade.", "They asked to upgrade."]);
    // opened, they are read as if they had just applied, and no second email goes
    for (const first of ["Cal", "Eve"]) {
      const row = await rowOf(job, first);
      expect(row.stage, first).toBe("triaged");
      expect(row.extraction, first).toBeTruthy();
      expect((await container.db.select().from(assessments).where(eq(assessments.applicationId, row.id))).map((a) => a.kind), first).toEqual(["triage"]);
      expect(mailTo(emailOf(job, first)), first).toHaveLength(1);
    }
    // their page goes back to the usual words by itself, and the team reads them as it reads anyone
    expect(await shown(`/c/status/${cal.statusToken}`)).toContain("The hiring team is reviewing your application.");
    let list = await listOf(job);
    expect(list.rows.map((r) => r.name).sort()).toEqual(["Ann Tester", "Bo Tester", "Cal Onfile", "Eve Onfile"]);
    expect(list.locked).toEqual({ count: 1, cards: [{ position: 6, appliedAt: new Date((await rowOf(job, "Flo")).createdAt).toISOString() }] });
    expect((await json(job.cookie, "GET", `/api/v1/applications/${cal.id}`)).status).toBe(200);

    // Change plan itself opens whoever the new plan has room for, and says how many
    const moved = await json(admin, "POST", `/api/v1/admin/customers/${job.companyId}/plan`, { planKey: "basic", reason: "They asked to upgrade." });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await read<PlanChangeAnswer>(moved)).toMatchObject({ unlocked: 1 });
    await container.drain();
    expect(await lockedNow()).toEqual({ Ann: false, Bo: false, Cal: false, Dot: true, Eve: false, Flo: false });
    expect((await rowOf(job, "Flo")).stage).toBe("triaged");
    expect((await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, job.companyId), eq(auditRecords.action, "plan.changed")))).map((a) => (a.details as { unlocked: number }).unlocked)).toEqual([1]);
    list = await listOf(job);
    expect(list.rows).toHaveLength(5);
    expect(list.locked).toEqual({ count: 0, cards: [] });

    // a move down locks nobody who could be read; whoever applies next follows the new plan
    const down = await json(admin, "POST", `/api/v1/admin/customers/${job.companyId}/plan`, { planKey: "free", reason: "They asked to move down." });
    expect(down.status, await down.clone().text()).toBe(200);
    expect(await read<PlanChangeAnswer>(down)).toMatchObject({ unlocked: 0 });
    expect(await lockedNow()).toEqual({ Ann: false, Bo: false, Cal: false, Dot: true, Eve: false, Flo: false });
    expect((await apply(job, "Gus", "Onfile")).lockedAt).not.toBeNull();
  }, 120_000);

  it(`the close-out note goes once, by day ${CLOSE_OUT_DAYS}, to someone still on file: it declines nobody, moves nothing and tells the team nothing; nobody who left, was opened or can be read gets one`, async () => {
    const job = await companyWithJob(1);
    await apply(job, "Vera");
    const ona = await apply(job, "Ona", "Onfile");
    const lon = await apply(job, "Lon", "Onfile");
    const wes = await apply(job, "Wes", "Onfile");
    expect((await form(`/c/status/${wes.statusToken}/withdraw`, { confirm: "yes" })).status).toBe(302);
    // room for one more: the oldest on file is opened, and is read
    await withPlatform(container.db, (tx) => unlockApplicants(tx, container.engine, { companyId: job.companyId, planKey: "free", limit: 2, actor: { kind: "system", id: "test_seed" }, reason: "A place opened.", now: new Date() }));
    await container.drain();
    expect((await rowOf(job, "Ona")).lockedAt).toBeNull();

    // the day before it is due, nothing; from day 29 on it goes, so a check that runs once a day keeps "at the latest"
    expect(await closeOutNotes(job, 29 * DAY - 60_000)).toBe(0);
    expect(await closeOutNotes(job, 29 * DAY)).toBe(1);
    await container.drain();
    const mails = mailTo(emailOf(job, "Lon"));
    expect(mails.map((m) => m.subject)).toEqual([`Thank you for applying: ${TITLE} at ${job.name}`, NOTE_SUBJECT(job)]);
    const note = mails[1];
    expect(note.text).toContain(`Your application for ${TITLE} at ${job.name} has not been reviewed, and we cannot say whether it will be. You do not need to do anything. If this changes, the team will contact you.`);
    expect(note.text).toContain(`/c/status/${lon.statusToken}`);
    expect(`${note.subject} ${note.text}`.match(PLAN_WORDS)).toBeNull();
    // it is no decision: they are where they were, still on file, and the team heard nothing
    const after = await rowOf(job, "Lon");
    expect(after).toMatchObject({ stage: "received", toldState: lon.toldState });
    expect(after.lockedAt).toBe(lon.lockedAt);
    expect(await teamNotices(job)).not.toContain("Onfile");
    // once: the next days' checks write nothing more
    expect(await closeOutNotes(job, 30 * DAY)).toBe(0);
    expect(await closeOutNotes(job, 45 * DAY)).toBe(0);
    await container.drain();
    expect(mailTo(emailOf(job, "Lon"))).toHaveLength(2);
    // their page says what the note said, with no date and no email promised any more
    const status = await shown(`/c/status/${lon.statusToken}`);
    expect(status).toContain(CLOSED_OUT_STATUS_LINE);
    expect(status).not.toContain(byDayOf(job, lon.createdAt));
    // nobody who left, was opened or can be read got one
    for (const first of ["Vera", "Ona", "Wes"]) expect(mailTo(emailOf(job, first)).map((m) => m.subject), first).not.toContain(NOTE_SUBJECT(job));
    expect(ona.lockedAt).not.toBeNull();
  }, 120_000);

  it("when their job closes, someone still on file hears on the next daily check instead of weeks later; until then their page promises no date and no email", async () => {
    const job = await companyWithJob(1);
    await apply(job, "Vic");
    const lea = await apply(job, "Lea", "Onfile");
    expect(await shown(`/c/status/${lea.statusToken}`)).toContain(onFileStatusLine(job.name, byDayOf(job, lea.createdAt)));
    const closed = await json(job.cookie, "POST", `/api/v1/roles/${job.roleId}/close`, { confirm: true });
    expect(closed.status, await closed.clone().text()).toBe(200);
    await container.drain();
    // a close tells nobody by itself, and the page stops promising what may no longer be true
    expect(mailTo(emailOf(job, "Lea"))).toHaveLength(1);
    expect(await shown(`/c/status/${lea.statusToken}`)).toContain(onFileNoDateLine(job.name));
    // the next daily check keeps the promise "we email you to say so when the job closes"
    expect(await closeOutNotes(job, 0)).toBe(1);
    await container.drain();
    expect(mailTo(emailOf(job, "Lea")).map((m) => m.subject)).toEqual([`Thank you for applying: ${TITLE} at ${job.name}`, NOTE_SUBJECT(job)]);
    expect(await shown(`/c/status/${lea.statusToken}`)).toContain(CLOSED_OUT_STATUS_LINE);
    expect((await rowOf(job, "Lea")).stage).toBe("received");
    expect(await closeOutNotes(job, DAY)).toBe(0);
    // someone the team could read on that job hears nothing from a close, and the team heard nothing of anyone on file
    expect(mailTo(emailOf(job, "Vic"))).toHaveLength(1);
    expect(await teamNotices(job)).not.toContain("Onfile");
  }, 120_000);
});
