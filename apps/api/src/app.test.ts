import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { ActionResult, AdminFailures, AdminQueue, CompanyCreated, CompanyView } from "@ros/contracts";
import { aiRuns, applications, assessments, candidates, communications, documents, events, jobs, screens, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { TRIAGE_READINGS } from "@ros/agents";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { applicationForm, plantJob } from "./test-helpers";

/**
 * The API end to end, through the HTTP layer: sign in by the emailed link, a company on the Free plan, a job page, an
 * application (received, read, one email), a repeat of it, an email outage, a person's decision, and what an
 * administrator may inspect. The job builder is job-builder.test.ts; the whole hire is tests/scenario/hiring.test.ts.
 */
describe("the API, from sign-in to an application and the administrator's view", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let companyId = "";
  let companySlug = "";
  let roleId = "";

  const json = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie, ...extra }, body: body ? JSON.stringify(body) : undefined });
  const outbox = () => (container.integrations.email as FakeEmailAdapter).sent;
  const applyTo = (form: FormData) => app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: form });
  const MARIA_RESUME = "Registered Dental Hygienist at Smile Bright Dental 2019 - present\nDental Hygienist at Coastal Family Dentistry 2015 - 2019\n\nLicenses: RDH license CA #RDH12345, active\nRadiography certificate\nCertifications: BLS/CPR current\nSkills: Dentrix, periodontal charting, digital radiography";

  // The engine clock: today at noon Pacific plus whatever the test advances.
  const BASE = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return d.getTime(); })();
  const setClock = (offsetMs: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offsetMs); };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    setClock(0);
  });
  afterAll(async () => {
    await container.close();
  });

  it("signs up with a magic link", async () => {
    const r1 = await json("POST", "/api/v1/auth/magic-link", { email: "dana@brightline.test" });
    expect(r1.status).toBe(200);
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await json("POST", "/api/v1/auth/magic-link/consume", { token });
    expect(r2.status).toBe(200);
    cookie = r2.headers.get("set-cookie")!.split(";")[0];
    const me = await json("GET", "/api/v1/auth/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe("dana@brightline.test");
    // a used link cannot be reused
    expect((await json("POST", "/api/v1/auth/magic-link/consume", { token })).status).toBe(401);
  });

  it("signs in from the emailed link: opening it changes nothing, the button signs in with a top-level redirect, and the link works once", async () => {
    const r1 = await json("POST", "/api/v1/auth/magic-link", { email: "link@brightline.test" });
    const { devLink } = (await r1.json()) as { devLink: string };
    expect(devLink).toMatch(/\/api\/v1\/auth\/consume\?token=/);
    const token = new URL(devLink).searchParams.get("token")!;
    // a mail scanner or a preview fetches the link: the page shows a button and consumes nothing
    const page = await app.request(devLink.replace(container.env.APP_BASE_URL, ""), { redirect: "manual" });
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(await page.text()).toMatch(/Continue to/);
    const press = () => app.request("/api/v1/auth/consume", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString(), redirect: "manual" });
    const r2 = await press();
    expect(r2.status).toBe(302);
    expect(r2.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup/company`);
    expect(r2.headers.get("set-cookie")).toMatch(/ros_session=/);
    const again = await press();
    expect(again.headers.get("location")).toMatch(/error=expired/);
  });

  it("two requests carrying the same link open exactly one session", async () => {
    const r1 = await json("POST", "/api/v1/auth/magic-link", { email: "race@brightline.test" });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const attempts = await Promise.all([0, 1, 2].map(() => json("POST", "/api/v1/auth/magic-link/consume", { token })));
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 401, 401]);
  });

  it("creates the company on the Free plan, with no clock", async () => {
    const r = await json("POST", "/api/v1/companies", { name: "Brightline Dental Group", vertical: "dental", sizeBand: "50-99", ownerName: "Dana Whitfield", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
    expect(r.status).toBe(201);
    const co = (await r.json()) as CompanyCreated;
    expect(co).toEqual({ id: co.id, name: "Brightline Dental Group", accessRequest: null });
    companyId = co.id;
    const cur = await json("GET", "/api/v1/companies/current");
    expect(cur.status).toBe(200);
    // the Free plan's 2 people, counted live: the owner is the one in use (known bug 128)
    const body = (await cur.json()) as CompanyView;
    companySlug = body.slug;
    expect(body.plan).toMatchObject({ key: "free", name: "Free", trial: null });
    expect(body.plan.usage.find((l) => l.key === "seats")).toMatchObject({ used: 1, limit: 2 });
  });

  it("serves the job page with JobPosting markup, the AI notice and the pay", async () => {
    roleId = await plantJob(container, { companyId, title: "Registered Dental Hygienist" });
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('"@type":"JobPosting"');
    expect(html).toMatch(/artificial intelligence/);
    expect(html).toMatch(/\$24–\$28 an hour/);
  });

  it("accepts a web application: the resume is read once and scored, the person is under review, and one email carries their own link; no AI interview is sent by itself", async () => {
    const r = await applyTo(applicationForm({ phone: "(949) 555-0100" }, MARIA_RESUME));
    expect(r.status).toBe(302);
    // the receipt, never the status page: the status link travels only by email
    const location = r.headers.get("location")!;
    expect(location).toBe(`/careers/${companySlug}/jobs/${roleId}/applied`);
    const receipt = await (await app.request(location, { headers: { cookie: r.headers.get("set-cookie")!.match(/ros_applied=[^;,]+/)![0] } })).text();
    expect(receipt).toContain("Thanks, we have your application");
    expect(receipt).toContain("m***@example.com");
    await container.drain();

    const apps = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(apps).toHaveLength(1);
    const a = apps[0];
    // received, read and scored: it waits for a person in New, and nothing invites anyone by itself
    expect(a.stage).toBe("triaged");
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, a.id))).toEqual([]);
    const [asmt] = await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id));
    expect(asmt.kind).toBe("triage");
    for (const s of asmt.result.strengths) if (s.evidence.quote) expect(s.evidence.source).toBe("resume");
    expect(asmt.result.requirementFindings.map((f) => [f.requirementKey, f.met])).toEqual([["mh_xray", "yes"]]);
    expect(a.extraction?.licenses.map((l) => l.name)).toContain("RDH");
    expect(a.extraction?.positions.length).toBeGreaterThanOrEqual(1);
    // one email: thank you, what happens next and their own link; no link to an AI interview
    const mine = outbox().filter((m) => m.to === "maria.reyes@example.com");
    expect(mine.map((m) => m.subject)).toEqual(["Thank you for applying: Registered Dental Hygienist at Brightline Dental Group"]);
    const ack = mine[0];
    expect(ack.text).toContain(`/c/status/${a.statusToken}`);
    expect(ack.text).not.toContain("/c/screen/");
    expect(ack.text).toMatch(/AI assistant/);
    expect(ack.text).not.toMatch(/HUMAN/);
    const comms = await container.db.select().from(communications).where(eq(communications.applicationId, a.id));
    expect(comms).toHaveLength(1);
    expect(comms[0].status).toBe("sent");
    expect(comms[0].disclosureIncluded).toBe(true);
    expect(await container.db.select().from(aiRuns).where(eq(aiRuns.task, "resume.extract"))).toHaveLength(1);
    // the application is read TRIAGE_READINGS times side by side, and the middle answer kept
    expect(await container.db.select().from(aiRuns).where(eq(aiRuns.task, "triage.assess"))).toHaveLength(TRIAGE_READINGS);
    expect(`${location} ${receipt}`).not.toContain(a.statusToken);
    const statusHtml = await (await app.request(`/c/status/${a.statusToken}`)).text();
    expect(statusHtml).toContain("Registered Dental Hygienist");
    expect(statusHtml).toContain("The hiring team is reviewing your application.");
    expect(statusHtml).not.toContain("/c/screen/");
  });

  it("dedupes a repeat application from the same candidate: the same receipt, nothing on the record changed, the link emailed to the address on file", async () => {
    const [maria] = await container.db.select().from(candidates).where(eq(candidates.email, "maria.reyes@example.com"));
    const [mariaApp] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, maria.id)));
    const sentBefore = outbox().length;
    // someone else types Maria's address, with their own phone and resume
    const r = await applyTo(applicationForm({ email: "Maria.Reyes@example.com", phone: "(714) 555-0199" }, "Not Maria at all"));
    expect(r.status).toBe(302);
    // exactly what a first application gets: the receipt, never a status link
    expect(r.headers.get("location")).toBe(`/careers/${companySlug}/jobs/${roleId}/applied`);
    const receipt = await (await app.request(r.headers.get("location")!, { headers: { cookie: r.headers.get("set-cookie")!.match(/ros_applied=[^;,]+/)![0] } })).text();
    expect(receipt).toContain("Thanks, we have your application");
    expect(receipt).toContain("M***@example.com");
    expect(`${r.headers.get("location")} ${r.headers.get("set-cookie")} ${receipt}`).not.toContain(mariaApp.statusToken);
    await container.drain();
    expect(await container.db.select().from(applications).where(eq(applications.roleId, roleId))).toHaveLength(1);
    expect(await container.db.select().from(events).where(eq(events.type, "application.duplicate_detected"))).toHaveLength(1);
    // nothing about Maria changed: consent, phone, resume, answers
    const [after] = await container.db.select().from(candidates).where(eq(candidates.id, maria.id));
    expect(after.consent).toEqual(maria.consent);
    expect(after.phone).toBe(maria.phone);
    const [appAfter] = await container.db.select().from(applications).where(eq(applications.id, mariaApp.id));
    expect(appAfter.resumeDocumentId).toBe(mariaApp.resumeDocumentId);
    expect(appAfter.answers).toEqual(mariaApp.answers);
    expect(await container.db.select().from(documents).where(eq(documents.applicationId, mariaApp.id))).toHaveLength(1);
    // the address on file learns about it, with its own link
    const notice = outbox().slice(sentBefore).find((m) => m.to === "maria.reyes@example.com");
    expect(notice?.subject).toMatch(/^Your application for /);
    expect(notice?.text).toContain(`/c/status/${mariaApp.statusToken}`);
    expect(notice?.text).toContain("Nothing in it was changed or replaced.");
  });

  it("recovers from a transient email outage: the message is queued, the workflow moves on, and the outbox retries the send exactly once", async () => {
    (container.integrations.email as FakeEmailAdapter).failNext(1);
    expect((await applyTo(applicationForm({ firstName: "Priya", lastName: "Shah", email: "priya@example.com" }, "Hygienist, 6 years.\nRadiography certificate"))).status).toBe(302);
    await container.drain();
    const [priya] = await container.db.select().from(candidates).where(eq(candidates.email, "priya@example.com"));
    // the received email is recorded and queued; the provider refused it once, so the outbox job waits for its retry
    const [ack] = await container.db.select().from(communications).where(and(eq(communications.candidateId, priya.id), eq(communications.templateKey, "acknowledgment")));
    expect(ack.status).toBe("queued");
    expect(ack.error).toMatch(/outage/);
    expect(ack.sendAttempts).toBe(1);
    const [job] = await container.db.select().from(jobs).where(and(eq(jobs.kind, "communication.send"), sql`${jobs.payload}->>'communicationId' = ${ack.id}`));
    expect(job.status).toBe("queued");
    expect(job.lastError).toMatch(/outage/);
    // the workflow itself was never held up by the provider: it wrote the email and went on to read the resume
    const [priyaApp] = await container.db.select().from(applications).where(eq(applications.candidateId, priya.id));
    expect(priyaApp.stage).toBe("triaged");
    expect((await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "application_intake"))).some((x) => x.status === "waiting" && x.lastError?.includes("acknowledgment"))).toBe(false);
    expect((await container.db.select().from(events).where(eq(events.type, "message.retried"))).some((e) => e.subjectId === ack.id)).toBe(true);
    // the retry timer fires
    setClock(60_000);
    await container.drain();
    setClock(0);
    const [sent] = await container.db.select().from(communications).where(eq(communications.id, ack.id));
    expect(sent.status).toBe("sent");
    expect(sent.providerMessageId).toBeTruthy();
    expect(outbox().filter((m) => m.to === "priya@example.com" && /^Thank you for applying: /.test(m.subject))).toHaveLength(1);
  });

  it("a decision is a person's press: Not selected emails nothing, stays private, and is recorded as theirs", async () => {
    const [priya] = await container.db.select({ id: applications.id }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(eq(candidates.email, "priya@example.com"));
    const sentBefore = outbox().length;
    // an action the API does not know is refused, and so is one without a session
    expect((await json("POST", `/api/v1/applications/${priya.id}/actions`, { action: "decline" })).status).toBe(400);
    expect((await app.request(`/api/v1/applications/${priya.id}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reject" }) })).status).toBe(401);
    const ok = await json("POST", `/api/v1/applications/${priya.id}/actions`, { action: "reject" });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as ActionResult).toMatchObject({ stage: "rejected", tab: "not_selected", toldState: "not_told", message: "Priya is marked Not selected. Nothing was emailed." });
    await container.drain();
    expect(outbox().slice(sentBefore).filter((m) => m.to === "priya@example.com")).toEqual([]);
    const [pressed] = await container.db.select().from(events).where(and(eq(events.type, "human.override"), eq(events.subjectId, priya.id)));
    expect(pressed).toMatchObject({ actor: { kind: "user" }, payload: { action: "reject" } });
    // the candidate's own page shows nothing of a decision nobody told them
    const [row] = await container.db.select({ statusToken: applications.statusToken }).from(applications).where(eq(applications.id, priya.id));
    const page = await (await app.request(`/c/status/${row.statusToken}`)).text();
    expect(page).toContain("The hiring team is reviewing your application.");
    expect(page).not.toMatch(/not selected|not moving forward/i);
  });

  it("enforces the Free plan's one job before any draft or assistant run", async () => {
    const runsBefore = (await container.db.select().from(aiRuns)).length;
    const r = await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a front office coordinator in Irvine, $22 to $26 an hour, full time. Just draft it." });
    expect(r.status).toBe(402);
    const err = ((await r.json()) as { error: { code: string; message: string; details: { upgrade: boolean; room: { holding: Array<{ title: string }> } } } }).error;
    expect(err.code).toBe("limit_reached");
    // a job that went live counts for good, so no job is named to close, and the message says what to do instead
    expect(err.details.upgrade).toBe(true);
    expect(err.details.room.holding).toEqual([]);
    expect(err.message).toBe("Your Free plan includes one job. Upgrade to post more.");
    expect((await container.db.select().from(aiRuns)).length).toBe(runsBefore);
  });

  it("blocks admin routes for non-admins and shows the queue, the failures and the costs to admins", async () => {
    expect((await json("GET", "/api/v1/admin/queue")).status).toBe(403);
    const { users } = await import("@ros/db");
    const { grantPlatformRole } = await import("@ros/core");
    const [dana] = await container.db.select().from(users).where(eq(users.email, "dana@brightline.test"));
    await grantPlatformRole(container.db, { userId: dana.id, role: "platform_admin", actor: { kind: "system", id: "test_seed" }, reason: "test seed", source: "test_seed" });
    // the role alone is not enough: the email-link session has no second factor
    const noMfa = await json("GET", "/api/v1/admin/queue", undefined, { "x-admin-reason": "test" });
    expect(noMfa.status).toBe(403);
    expect(((await noMfa.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
    const { signInWithIdentity } = await import("./test-helpers");
    const adminCookie = await signInWithIdentity(app, container, { email: "dana@brightline.test", provider: "azure", aal2: true });
    const asAdmin = (method: string, path: string) => json(method, path, undefined, { "x-admin-reason": "test", cookie: adminCookie });
    const r = await asAdmin("GET", "/api/v1/admin/queue");
    expect(r.status).toBe(200);
    const queue = (await r.json()) as AdminQueue;
    expect(queue.definitions.length).toBeGreaterThan(0);
    expect(typeof queue.queued).toBe("number");
    const failures = (await (await asAdmin("GET", "/api/v1/admin/failures")).json()) as AdminFailures;
    expect(Object.keys(failures).sort()).toEqual(["alerts", "failedAi", "failedJobs", "failedRuns"]);
    // what failed is named by what it was and its error: never a run's state, a job's payload or an AI call's output
    expect(JSON.stringify(failures)).not.toMatch(/"(state|payload|output|outputRef|inputRef)":/);
    const costs = (await (await asAdmin("GET", "/api/v1/admin/costs")).json()) as Array<{ task: string }>;
    expect(costs.some((c) => c.task === "resume.extract")).toBe(true);
    // ?since= (the dashboard's "this month"): only the runs from that day on; a day before every run gives the
    // same answer as no filter, a day after them none, and anything but a real date is refused
    const sorted = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();
    const sinceLongAgo = (await (await asAdmin("GET", "/api/v1/admin/costs?since=2000-01-01")).json()) as unknown[];
    expect(sorted(sinceLongAgo)).toEqual(sorted(costs));
    expect(await (await asAdmin("GET", "/api/v1/admin/costs?since=2999-01-01")).json()).toEqual([]);
    for (const bad of ["October", "2026-02-30", "2026-10-1"]) expect((await asAdmin("GET", `/api/v1/admin/costs?since=${bad}`)).status, bad).toBe(400);
  });
});
