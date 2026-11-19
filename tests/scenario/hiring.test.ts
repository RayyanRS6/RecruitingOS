import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { aiRuns, applications, assessments, companies, entitlements, events, notifications, screens } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import type { ActionResult, BulkActionResult, CandidateList, CandidatePanel, DecisionMessagePreview, HomeView, IntakeSessionView, IntakeStartResponse, PlanLimitDetails, PublishResult, RoleDetail } from "../../packages/contracts/src";
import { FAKE_SAMPLE_RESUMES } from "../../packages/agents/src/fake-candidate";
import { createApp } from "../../apps/api/src/app";
import { createContainer, type Container } from "../../apps/api/src/container";
import { statusTokenFor, usePlan } from "../../apps/api/src/test-helpers";

/**
 * The whole hire on the stand-in providers, walked the way people use it: an owner opens a job through the job builder;
 * people apply with a resume on the public form; each is received, read and scored; the company shortlists one, who does
 * the AI interview and sends it; the scorecard is stored; one person is hired and another marked Not selected and told
 * by email. With it: a "No" answer flags and holds nobody, a second application creates nothing, an AI interview link
 * closes after five days and a new one can be sent, a shortlist is refused when the month's AI interviews are used up,
 * and someone past the plan's candidates per job is not read.
 *
 * The job is built through the job builder's own routes: POST /api/v1/intake/sessions (one sentence), POST .../draft
 * ("Write the job") and POST .../publish ("Publish job").
 */
describe("The whole hire: Harbor Dental hires a dental hygienist", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  /** The key of the form's one screening question ("Do you hold this: Active CA RDH license?"). */
  let licenceKey = "";
  const ids: Record<string, string> = {};

  const JOB = "I need a registered dental hygienist in Tustin, CA, on site, full time, Monday to Friday, $45 to $55 an hour. Must-haves: active CA RDH license, periodontal charting.";
  const PEOPLE = {
    strong: { first: "Sam", last: "Strong", email: "sam.strong@people.test", resume: FAKE_SAMPLE_RESUMES.strong },
    possible: { first: "Pat", last: "Possible", email: "pat.possible@people.test", resume: FAKE_SAMPLE_RESUMES.possible },
    weak: { first: "Wes", last: "Weak", email: "wes.weak@people.test", resume: FAKE_SAMPLE_RESUMES.weak },
    fourth: { first: "Fay", last: "Fourth", email: "fay.fourth@people.test", resume: FAKE_SAMPLE_RESUMES.possible },
    fifth: { first: "Finn", last: "Fifth", email: "finn.fifth@people.test", resume: FAKE_SAMPLE_RESUMES.strong },
  } as const;
  type Who = (typeof PEOPLE)[keyof typeof PEOPLE];

  // The engine's clock: now, plus whatever a step moves it on by.
  const BASE = Date.now();
  let clockOffset = 0;
  const setClock = (offsetMs: number) => { clockOffset = offsetMs; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + clockOffset); };
  const advance = async (ms: number) => { setClock(clockOffset + ms); await container.drain(); };
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;

  const signIn = async () => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dana@harbor.test" }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const consume = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(devLink).searchParams.get("token") }) });
    cookie = consume.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const read = async <T>(path: string): Promise<T> => {
    const r = await json("GET", path);
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as T;
  };
  const act = (who: string, action: string) => json("POST", `/api/v1/applications/${ids[who]}/actions`, { action });
  const acted = async (who: string, action: string): Promise<ActionResult> => {
    const r = await act(who, action);
    expect(r.status, await r.clone().text()).toBe(200);
    await container.drain();
    return (await r.json()) as ActionResult;
  };
  const list = (tab: string) => read<CandidateList>(`/api/v1/roles/${roleId}/applications?tab=${tab}`);
  const panel = (who: string) => read<CandidatePanel>(`/api/v1/applications/${ids[who]}`);
  const page = async (path: string) => (await app.request(path)).text();
  const form = (path: string, fields: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const mailTo = (who: Who) => (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === who.email);
  const stageOf = async (who: string) => (await container.db.select({ stage: applications.stage, toldState: applications.toldState }).from(applications).where(eq(applications.id, ids[who])))[0];
  const setLimit = async (key: string, limit: number) => {
    const changed = await container.db.update(entitlements).set({ limit }).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, key))).returning({ id: entitlements.id });
    if (!changed.length) await container.db.insert(entitlements).values({ companyId, key, limit });
  };

  /** Sends the public application form as a browser without script does: the fields, the screening answer, the tick, and the resume inside the form. */
  const apply = async (who: Who, licence: "yes" | "no", opts: { src?: string } = {}): Promise<Response> => {
    const fd = new FormData();
    fd.set("firstName", who.first);
    fd.set("lastName", who.last);
    fd.set("email", who.email);
    fd.set("acknowledged", "yes");
    fd.set(`q_${licenceKey}`, licence);
    if (opts.src) fd.set("src", opts.src);
    fd.set("resume", new File([`${who.first} ${who.last}\n${who.email}\nTustin, CA\n${who.resume}\n`], "resume.txt", { type: "text/plain" }));
    const res = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    await container.drain();
    return res;
  };
  const applied = async (name: keyof typeof PEOPLE, licence: "yes" | "no", opts: { src?: string } = {}) => {
    const res = await apply(PEOPLE[name], licence, opts);
    expect(res.status, await res.clone().text()).toBe(302);
    expect(res.headers.get("location")).toBe(`/careers/${slug}/jobs/${roleId}/applied`);
    const [row] = await container.db.select({ id: applications.id }).from(applications).where(and(eq(applications.roleId, roleId), eq(applications.statusToken, await statusTokenFor(container, { roleId, email: PEOPLE[name].email }))));
    ids[name] = row.id;
  };
  const screenOf = async (who: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, ids[who]))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", STORAGE_PROVIDER: "memory", WORKER_INLINE: "true", MESSAGE_UNDO_SECONDS: "30", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    setClock(0);
    await signIn();
    companyId = ((await (await json("POST", "/api/v1/companies", { name: "Harbor Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Tustin", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    slug = (await container.db.select({ slug: companies.slug }).from(companies).where(eq(companies.id, companyId)))[0].slug;
    await usePlan(container, companyId, "ultra");
  });
  afterAll(async () => { await container.close(); });

  it("opens a job through the job builder: one sentence, Write the job, Publish job", async () => {
    const started = await json("POST", "/api/v1/intake/sessions", { initialMessage: JOB });
    expect(started.status, await started.clone().text()).toBe(201);
    const draft = ((await started.json()) as IntakeStartResponse).session!;
    expect(draft.readiness.mayDraft, draft.readiness.draftBlocker ?? "").toBe(true);
    const written = await json("POST", `/api/v1/intake/sessions/${draft.id}/draft`);
    expect(written.status, await written.clone().text()).toBe(200);
    expect(((await written.json()) as { session: IntakeSessionView }).session.readiness.publish).toMatchObject({ allowed: true });
    const published = await json("POST", `/api/v1/intake/sessions/${draft.id}/publish`);
    expect(published.status, await published.clone().text()).toBe(201);
    roleId = ((await published.json()) as PublishResult).roleId;
    const job = await read<RoleDetail>(`/api/v1/roles/${roleId}`);
    expect(job).toMatchObject({ status: "open", public: true, acceptingApplications: true });
    expect(job.packet!.requirements.mustHaves.map((m) => m.text)).toEqual(["Active CA RDH license", "Periodontal charting"]);
    expect(job.packet!.formQuestions).toHaveLength(1);
    expect(job.packet!.formQuestions[0]).toMatchObject({ kind: "yes_no", question: "Do you hold this: Active CA RDH license?" });
    licenceKey = job.packet!.formQuestions[0].key;
    // the public job page and its form: nothing about an account, the form's own labels, and the source kept for the form
    const jobPage = await page(`/careers/${slug}/jobs/${roleId}?src=linkedin`);
    expect(jobPage).toContain("Apply now");
    expect(jobPage).toContain(`/careers/${slug}/jobs/${roleId}/apply?src=linkedin`);
    const formPage = await page(`/careers/${slug}/jobs/${roleId}/apply?src=linkedin`);
    for (const words of ["First name", "Last name", "Email", "Do you hold this: Active CA RDH license?", "I have read the full notice above", "Send my application", '<input type="hidden" name="src" value="linkedin"/>']) expect(formPage).toContain(words);
    expect(formPage.match(/type="file"/g)).toHaveLength(1);
    expect(formPage).not.toMatch(/Read my resume|No resume\?/);
  });

  it("takes two applications with resumes: each is received, read and scored, and a No answer flags but holds nobody", async () => {
    await applied("strong", "yes", { src: "linkedin" });
    await applied("weak", "no");
    // the receipt is one page for everyone
    const receipt = await page(`/careers/${slug}/jobs/${roleId}/applied`);
    expect(receipt).toContain("Thanks, we have your application");
    // both were read: New, with a number, and each with the resume and its reading stored
    for (const who of ["strong", "weak"]) {
      expect((await stageOf(who)).stage).toBe("triaged");
      const readings = await container.db.select().from(assessments).where(and(eq(assessments.applicationId, ids[who]), eq(assessments.kind, "triage")));
      expect(readings).toHaveLength(1);
    }
    expect((await container.db.select().from(events).where(eq(events.type, "application.triaged"))).map((e) => e.payload.noScore)).toEqual([null, null]);
    const strong = await panel("strong");
    const weak = await panel("weak");
    expect(strong).toMatchObject({ stage: "triaged", tab: "new", label: "New", source: "linkedin", sourceLabel: "LinkedIn" });
    expect(weak).toMatchObject({ stage: "triaged", tab: "new", label: "New", sourceLabel: "Job page" });
    expect(typeof strong.cvScore.score).toBe("number");
    expect(typeof weak.cvScore.score).toBe("number");
    expect(strong.cvScore.score!).toBeGreaterThan(weak.cvScore.score!);
    expect(strong.cv).toMatchObject({ filename: "resume.txt", status: "clean", hasText: true });
    // the No is a flag for a person to read, on the row and the panel; it moved and held nobody
    expect(strong.screeningAnswers).toEqual([{ key: licenceKey, question: "Do you hold this: Active CA RDH license?", kind: "yes_no", answer: "Yes", flagged: false, flag: null }]);
    expect(weak.screeningAnswers).toEqual([{ key: licenceKey, question: "Do you hold this: Active CA RDH license?", kind: "yes_no", answer: "No", flagged: true, flag: "Answered No: Do you hold this: Active CA RDH license?" }]);
    expect(weak.actions.find((a) => a.action === "shortlist")).toMatchObject({ allowed: true });
    // one email each: the receipt, with their own status link and no AI interview
    for (const who of [PEOPLE.strong, PEOPLE.weak]) {
      const mail = mailTo(who);
      expect(mail).toHaveLength(1);
      expect(mail[0].text).toContain(`https://jobs.example.test/c/status/${await statusTokenFor(container, { roleId, email: who.email })}`);
      expect(mail[0].text).not.toContain("/c/screen/");
    }
    expect(await container.db.select().from(screens)).toEqual([]);
  });

  it("ranks them by resume score on the New tab, and Home counts them", async () => {
    const fresh = await list("new");
    expect(fresh.rows.map((r) => r.name)).toEqual(["Sam Strong", "Wes Weak"]);
    expect(fresh.rows[1].flags).toEqual(["Answered No: Do you hold this: Active CA RDH license?"]);
    expect(fresh.counts).toEqual({ total: 2, byTab: { new: 2, shortlisted: 0, interviewed: 0, hired: 0, not_selected: 0 }, locked: 0 });
    expect(fresh.rows[0].actions.map((a) => [a.action, a.allowed])).toEqual([["shortlist", true], ["hire", true], ["reject", true]]);
    const home = await read<HomeView>("/api/v1/home");
    expect(home.jobs).toEqual([{ id: roleId, title: fresh.role.title, status: "open", statusLabel: "Open", toReview: 2, interviewed: 0, applicants: 2 }]);
  });

  it("creates nothing for a second application from the same address, and emails their status link once more", async () => {
    const again = await apply(PEOPLE.weak, "yes");
    expect(again.status).toBe(302);
    expect(await container.db.select({ id: applications.id }).from(applications).where(eq(applications.roleId, roleId))).toHaveLength(2);
    // nothing on file changed: the answer is still the No they sent first
    expect((await panel("weak")).screeningAnswers[0].answer).toBe("No");
    const mail = mailTo(PEOPLE.weak);
    expect(mail).toHaveLength(2);
    expect(mail[1].text).toContain("/c/status/");
    expect(mail[1].text).not.toContain("/c/screen/");
  });

  it("shortlists one person: the AI interview's invitation goes to them, and nothing of it reaches the team before they send it", async () => {
    const done = await acted("strong", "shortlist");
    expect(done).toMatchObject({ ok: true, action: "shortlist", stage: "screen_invited", tab: "shortlisted", label: "AI interview sent" });
    const [screen] = await screenOf("strong");
    expect(screen.status).toBe("invited");
    expect(Date.parse(screen.expiresAt!) - Date.parse(screen.invitedAt!)).toBe(5 * DAY);
    const invitation = mailTo(PEOPLE.strong)[1];
    expect(invitation.text).toContain(`https://jobs.example.test/c/screen/${screen.token}`);
    // the candidate's status page: the steps, the button into their AI interview, never a score
    const status = await page(`/c/status/${await statusTokenFor(container, { roleId, email: PEOPLE.strong.email })}`);
    expect(status).toContain('aria-label="Where your application is"');
    for (const step of ["Received", "Under review", "AI interview"]) expect(status).toContain(`<span>${step}</span>`);
    expect(status).not.toContain("<span>Decision</span>");
    expect(status).toContain(`/c/screen/${screen.token}`);
    expect(status).toContain("make every decision");
    expect(status).not.toMatch(/\d+\s*\/\s*100/);
    // someone who was not shortlisted has no AI interview step
    expect(await page(`/c/status/${await statusTokenFor(container, { roleId, email: PEOPLE.weak.email })}`)).not.toContain("<span>AI interview</span>");
    const shortlisted = await list("shortlisted");
    expect(shortlisted.rows.map((r) => [r.name, r.label, r.aiInterview?.status, r.interviewScore])).toEqual([["Sam Strong", "AI interview sent", "sent", null]]);
  });

  it("walks the AI interview one question at a time to Send my answers; the scorecard is stored and the person is Interviewed", async () => {
    const [screen] = await screenOf("strong");
    const base = `/c/screen/${screen.token}`;
    const intro = await page(base);
    for (const words of ["AI assistant", "when you press Send my answers", "rather talk to a person", ">Start</button>"]) expect(intro).toContain(words);
    expect((await form(`${base}/start`)).status).toBe(302);
    expect((await stageOf("strong")).stage).toBe("screening");
    const asked: string[] = [];
    let html = await page(base);
    for (let turn = 0; turn < 40 && !html.includes("<h1>Check your answers</h1>"); turn++) {
      expect(html).toContain("only when you press Send my answers");
      expect(html).toContain("rather talk to a person");
      asked.push(/<li class="msg assistant now" id="question">(?:<span class="sr-only">[^<]*<\/span>)?([\s\S]*?)<\/li>/.exec(html)?.[1] ?? "");
      expect((await form(base, { message: `At Harbor Dental I see about nine patients a day, with periodontal charting and scaling in Dentrix, and I can speak to this in detail (${turn + 1}).` })).status).toBe(302);
      html = await page(base);
    }
    expect(html).toContain("<h1>Check your answers</h1>");
    // one question at a time: every turn asked something, and the job's own questions were all asked
    const job = await read<RoleDetail>(`/api/v1/roles/${roleId}`);
    expect(asked.every((q) => q.trim().length > 0)).toBe(true);
    for (const q of job.packet!.screening.questions) expect(asked.some((a) => a.includes(q.question))).toBe(true);
    // nothing of it reaches the team before the candidate sends it
    const before = await panel("strong");
    expect(before.aiInterview).toMatchObject({ status: "started", label: "AI interview started", score: null, review: null, answers: [] });
    expect(await container.db.select().from(assessments).where(and(eq(assessments.applicationId, ids.strong), eq(assessments.kind, "screen")))).toEqual([]);
    // Send my answers
    expect(html).toContain(">Send my answers</button>");
    expect((await form(`${base}/submit`)).status).toBe(302);
    await container.drain();
    expect(await page(base)).toContain("<h1>Thanks, your answers are sent</h1>");
    expect((await stageOf("strong")).stage).toBe("screen_complete");
    const [sent] = await screenOf("strong");
    expect(sent.status).toBe("completed");
    const scorecards = await container.db.select().from(assessments).where(and(eq(assessments.applicationId, ids.strong), eq(assessments.kind, "screen")));
    expect(scorecards).toHaveLength(1);
    expect(sent.assessmentId).toBe(scorecards[0].id);
    const after = await panel("strong");
    expect(after).toMatchObject({ stage: "screen_complete", tab: "interviewed", label: "Interviewed" });
    expect(after.aiInterview!.status).toBe("done");
    expect(typeof after.aiInterview!.score!.score).toBe("number");
    expect(after.aiInterview!.score!.questions.length).toBeGreaterThanOrEqual(job.packet!.screening.questions.length);
    expect(after.aiInterview!.answers.length).toBeGreaterThanOrEqual(job.packet!.screening.questions.length);
    expect(after.aiInterview!.answers.every((a) => !!a.answer)).toBe(true);
    const interviewed = await list("interviewed");
    expect(interviewed.rows.map((r) => r.name)).toEqual(["Sam Strong"]);
    expect(typeof interviewed.rows[0].interviewScore!.score).toBe("number");
    // the team is told once
    const told = (await container.db.select().from(notifications).where(eq(notifications.companyId, companyId))).filter((n) => n.title.includes("finished the AI interview"));
    expect(told.map((n) => n.title)).toEqual(["Sam Strong finished the AI interview"]);
    expect((await read<HomeView>("/api/v1/home")).jobs[0]).toMatchObject({ toReview: 1, interviewed: 1, applicants: 2 });
  });

  it("hires one person, marks the other Not selected in private, takes that back before they are told, and then emails the decision", async () => {
    const hired = await acted("strong", "hire");
    expect(hired).toMatchObject({ stage: "hired", tab: "hired", label: "Hired", toldState: null });
    expect(await container.db.select().from(events).where(and(eq(events.type, "outcome.recorded"), eq(events.subjectId, ids.strong)))).toHaveLength(1);
    expect(mailTo(PEOPLE.strong)).toHaveLength(2); // nothing was emailed about the hire

    const statusPath = `/c/status/${await statusTokenFor(container, { roleId, email: PEOPLE.weak.email })}`;
    const rejected = await acted("weak", "reject");
    expect(rejected).toMatchObject({ stage: "rejected", tab: "not_selected", label: "Not selected", toldState: "not_told" });
    // private: no email, and their page still stands where it was
    expect(mailTo(PEOPLE.weak)).toHaveLength(2);
    expect(await page(statusPath)).not.toContain("<span>Decision</span>");
    expect(await page(statusPath)).not.toContain("Not moving forward");
    // Undo, before they were told: back in New, nothing of the decision left
    const undone = await acted("weak", "undo_decision");
    expect(undone).toMatchObject({ stage: "triaged", tab: "new", label: "New", toldState: null });
    expect((await stageOf("weak")).toldState).toBe("not_told");

    // decided again, and this time told
    await acted("weak", "reject");
    const preview = await read<DecisionMessagePreview>(`/api/v1/applications/${ids.weak}/decision-message`);
    expect(preview).toMatchObject({ to: PEOPLE.weak.email, subject: "Your application to Harbor Dental", toldState: "not_told" });
    const queued = await acted("weak", "send_decision");
    expect(queued).toMatchObject({ stage: "rejected", toldState: "queued" });
    expect(queued.undoUntil).not.toBeNull();
    expect(mailTo(PEOPLE.weak)).toHaveLength(2); // it waits for the short time "Don't send" can take it back
    expect((await panel("weak")).actions.map((a) => [a.action, a.allowed])).toEqual([["unsend_decision", true], ["undo_decision", false]]);
    await advance(31_000);
    const mail = mailTo(PEOPLE.weak);
    expect(mail).toHaveLength(3);
    expect(mail[2].subject).toBe(preview.subject);
    expect(mail[2].text).toBe(preview.text);
    expect((await stageOf("weak")).toldState).toBe("sent");
    expect((await panel("weak")).actions.map((a) => [a.action, a.allowed, a.reason])).toEqual([["send_decision", false, "They were already told by email."], ["undo_decision", false, "They were already told by email."]]);
    // now their page says so
    const status = await page(statusPath);
    expect(status).toContain("<span>Decision</span>");
    expect(status).toContain("Not moving forward");
    const notSelected = await list("not_selected");
    expect(notSelected.rows.map((r) => [r.name, r.toldState, r.toldLabel])).toEqual([["Wes Weak", "sent", "Told by email"]]);
    expect(notSelected.counts.byTab).toEqual({ new: 0, shortlisted: 0, interviewed: 0, hired: 1, not_selected: 1 });
  });

  it("closes an AI interview link after five days, with one reminder on the way, and sends a new link when a person asks", async () => {
    await applied("possible", "yes");
    await acted("possible", "shortlist");
    const [first] = await screenOf("possible");
    expect(mailTo(PEOPLE.possible).map((m) => m.text.includes(`/c/screen/${first.token}`))).toEqual([false, true]);
    await advance(49 * HOUR);
    expect(mailTo(PEOPLE.possible)).toHaveLength(3); // the one reminder
    expect(mailTo(PEOPLE.possible)[2].text).toContain(`/c/screen/${first.token}`);
    await advance(3 * DAY + 2 * HOUR);
    await signIn();
    expect((await screenOf("possible"))[0].status).toBe("expired");
    const closed = mailTo(PEOPLE.possible)[3];
    expect(closed.subject).toContain("has closed");
    expect(await page(`/c/screen/${first.token}`)).toContain("<h1>This link has closed</h1>");
    const row = (await list("shortlisted")).rows[0];
    expect(row).toMatchObject({ name: "Pat Possible", stage: "screen_invited", label: "AI interview link closed" });
    expect(row.actions.find((a) => a.action === "send_new_link")).toMatchObject({ allowed: true });
    const again = await acted("possible", "send_new_link");
    expect(again).toMatchObject({ stage: "screen_invited", label: "AI interview sent" });
    const both = await screenOf("possible");
    expect(both.map((s) => s.status)).toEqual(["expired", "invited"]);
    expect(both[1].token).not.toBe(first.token);
    expect(mailTo(PEOPLE.possible)[4].text).toContain(`/c/screen/${both[1].token}`);
  });

  it("refuses a shortlist when the month's AI interviews are used up, for one person and for several", async () => {
    await applied("fourth", "yes");
    // one AI interview was begun this month (they are counted at a candidate's first answer); the plan now allows one
    await setLimit("text_screens", 1);
    const row = (await list("new")).rows.find((r) => r.name === "Fay Fourth")!;
    expect(row.actions.find((a) => a.action === "shortlist")).toEqual({ action: "shortlist", label: "Shortlist", allowed: false, reason: "This month's AI interviews are used up." });
    const refused = await act("fourth", "shortlist");
    expect(refused.status).toBe(402);
    const body = (await refused.json()) as { error: { code: string; message: string; details: PlanLimitDetails } };
    expect(body.error).toMatchObject({ code: "limit_reached", message: "This month's AI interviews are used up.", details: { upgrade: true } });
    expect(body.error.details.ask).not.toBeNull();
    const several = await json("POST", `/api/v1/roles/${roleId}/applications/actions`, { action: "shortlist", applicationIds: [ids.fourth] });
    expect(several.status).toBe(200);
    expect((await several.json()) as BulkActionResult).toMatchObject({ done: 0, refused: 1, results: [{ applicationId: ids.fourth, name: "Fay Fourth", ok: false, code: "limit_reached" }] });
    expect((await stageOf("fourth")).stage).toBe("triaged");
    expect(await screenOf("fourth")).toEqual([]);
    // hiring and Not selected cost no AI interview, so they stay allowed
    expect(row.actions.filter((a) => a.action !== "shortlist").map((a) => [a.action, a.allowed])).toEqual([["hire", true], ["reject", true]]);
  });

  it("does not read someone past the plan's candidates per job: they are received, counted as locked, and no AI reads them", async () => {
    await setLimit("candidates_per_job", 4);
    const readsBefore = (await container.db.select({ id: aiRuns.id }).from(aiRuns).where(eq(aiRuns.companyId, companyId))).length;
    await applied("fifth", "yes");
    expect((await container.db.select({ id: aiRuns.id }).from(aiRuns).where(eq(aiRuns.companyId, companyId))).length).toBe(readsBefore);
    const [row] = await container.db.select().from(applications).where(eq(applications.id, ids.fifth));
    expect(row.stage).toBe("received");
    expect(row.lockedAt).not.toBeNull();
    expect(await container.db.select().from(assessments).where(eq(assessments.applicationId, ids.fifth))).toEqual([]);
    const fresh = await list("new");
    expect(fresh.rows.map((r) => r.name)).not.toContain("Finn Fifth");
    expect(fresh.locked.count).toBe(1);
    expect(fresh.counts).toMatchObject({ total: 5, locked: 1 });
    const direct = await json("GET", `/api/v1/applications/${ids.fifth}`);
    expect(direct.status).not.toBe(200);
    expect(await direct.text()).not.toContain("Finn");
    // they still got their receipt, in the words for someone on file, and no word about a plan
    const mail = mailTo(PEOPLE.fifth);
    expect(mail).toHaveLength(1);
    expect(mail[0].text).toContain("/c/status/");
    expect(mail[0].text).not.toMatch(/plan|upgrade|locked/i);
  });
});
