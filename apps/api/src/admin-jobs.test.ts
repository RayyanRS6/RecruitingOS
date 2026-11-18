import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { AdminCompany, AdminCompanyJobs } from "@ros/contracts";
import { auditRecords } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { plantApplicant, plantJob, signInAdmin, signInAs, signInWithIdentity } from "./test-helpers";

/**
 * What a platform administrator reads of a company's hiring: its jobs as counts (GET /admin/customers/:id/jobs) and its
 * row on the list of companies. Never a candidate's name, email, file, answers or score; only a platform administrator
 * with a second factor reads it, and every read is recorded.
 */
describe("the admin dashboard reads a company's jobs as counts", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let admin = "";
  let companyId = "";
  let slug = "";
  let openJob = "";
  let draftJob = "";
  let closedJob = "";
  /** Each planted person carries their mark as their name and in their address. */
  const MARKS = ["Zqnew", "Zqlocked", "Zqinvited", "Zqtalking", "Zqsent", "Zqhired", "Zqdeclined", "Zqleft", "Zqold"];
  const json = (cookie: string, method: string, path: string, body?: unknown, reason = "admin jobs test") => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": reason }, body: body ? JSON.stringify(body) : undefined });
  const jobsOf = async (id: string) => json(admin, "GET", `/api/v1/admin/customers/${id}/jobs`);

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    owner = await signInWithIdentity(app, container, { email: "olive@counts.test", name: "Olive Owner", provider: "google", aal2: false });
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Counts Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    slug = ((await (await json(owner, "GET", "/api/v1/companies/current")).json()) as { slug: string }).slug;
    admin = await signInAdmin(app, container, "ada.admin@identifiedtalent.com", "Ada Admin");
    draftJob = await plantJob(container, { companyId, title: "Front Desk Coordinator", status: "draft" });
    closedJob = await plantJob(container, { companyId, title: "Office Manager", status: "closed" });
    openJob = await plantJob(container, { companyId, title: "Dental Hygienist" });
    const person = (mark: string, stage: Parameters<typeof plantApplicant>[1]["stage"], roleId = openJob, locked = false) => plantApplicant(container, { companyId, roleId, mark, stage, locked });
    await person("Zqnew", "triaged");
    await person("Zqlocked", "received", openJob, true);
    await person("Zqinvited", "screen_invited");
    await person("Zqtalking", "screening");
    await person("Zqsent", "screen_complete");
    await person("Zqhired", "hired");
    await person("Zqdeclined", "rejected");
    await person("Zqleft", "withdrawn");
    await person("Zqold", "hired", closedJob);
  });
  afterAll(async () => {
    await container.close();
  });

  it("lists every job, newest first, with everyone who applied and the people in the Shortlisted, Interviewed and Hired tabs", async () => {
    const r = await jobsOf(companyId);
    expect(r.status).toBe(200);
    const body = (await r.json()) as AdminCompanyJobs;
    expect(body.company).toEqual({ id: companyId, name: "Counts Dental" });
    expect(body.jobs.map((j) => j.title)).toEqual(["Dental Hygienist", "Office Manager", "Front Desk Coordinator"]);
    const [open, closed, draft] = body.jobs;
    // eight applied to the open job; the one the plan keeps locked is counted as an applicant and is in no tab
    expect(open).toEqual({ id: openJob, title: "Dental Hygienist", status: "open", statusLabel: expect.any(String), publishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), applicants: 8, shortlisted: 2, interviewed: 1, hired: 1, jobPageUrl: `https://jobs.example.test/careers/${slug}/jobs/${openJob}` });
    // a closed job keeps its counts and has no public page; a draft has neither applicants nor a page nor an opening day
    expect(closed).toMatchObject({ id: closedJob, status: "closed", applicants: 1, shortlisted: 0, interviewed: 0, hired: 1, jobPageUrl: null });
    expect(draft).toMatchObject({ id: draftJob, status: "draft", publishedAt: null, applicants: 0, shortlisted: 0, interviewed: 0, hired: 0, jobPageUrl: null });
  });

  it("carries nothing of any candidate: counts only, on the jobs and on the company's row", async () => {
    const jobs = await (await jobsOf(companyId)).text();
    const row = ((await (await json(admin, "GET", "/api/v1/admin/customers")).json()) as AdminCompany[]).find((c) => c.id === companyId)!;
    expect(row).toMatchObject({ jobs: { open: 1, total: 3 }, applicants: 9, lockedApplicants: 1, status: "active", owner: { name: "Olive Owner", email: "olive@counts.test" } });
    for (const text of [jobs, JSON.stringify(row)]) {
      for (const mark of MARKS) expect(text.toLowerCase(), mark).not.toContain(mark.toLowerCase());
      expect(text).not.toMatch(/people\.test|firstName|lastName|statusToken|resume|answers|score/i);
    }
    // the keys of a job are exactly the contract's: nothing else can ride along
    expect(Object.keys((JSON.parse(jobs) as AdminCompanyJobs).jobs[0]).sort()).toEqual(["applicants", "hired", "id", "interviewed", "jobPageUrl", "publishedAt", "shortlisted", "status", "statusLabel", "title"]);
  });

  it("is for a platform administrator with a second factor only, and every read is recorded with its reason", async () => {
    const path = `/api/v1/admin/customers/${companyId}/jobs`;
    expect((await app.request(path)).status).toBe(401);
    const member = await signInAs(container, app, { companyId, role: "hiring_manager" });
    for (const cookie of [owner, member]) {
      const refused = await json(cookie, "GET", path);
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    }
    const before = (await container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "admin.bypass"), like(auditRecords.reason, `GET ${path}:%`)))).length;
    expect((await json(admin, "GET", path, undefined, "checking a company's hiring")).status).toBe(200);
    const recorded = await container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "admin.bypass"), like(auditRecords.reason, `GET ${path}:%`)));
    expect(recorded).toHaveLength(before + 1);
    expect(recorded.some((a) => a.reason === `GET ${path}: checking a company's hiring` && a.actor.name === "Ada Admin")).toBe(true);
    // a refused read is not a read: nothing was recorded for the owner or the member
    expect(recorded.every((a) => a.actor.name === "Ada Admin")).toBe(true);
  });

  it("answers 404 for a company that does not exist, and for an id that is none", async () => {
    expect((await jobsOf("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await jobsOf("not-a-company")).status).toBe(404);
  });

  it("gives a job's public page only while the company is live", async () => {
    expect((await json(admin, "POST", `/api/v1/admin/customers/${companyId}/access`, { decision: "remove", confirm: true })).status).toBe(200);
    const taken = (await (await jobsOf(companyId)).json()) as AdminCompanyJobs;
    expect(taken.jobs.map((j) => j.jobPageUrl)).toEqual([null, null, null]);
    expect(taken.jobs[0]).toMatchObject({ applicants: 8, shortlisted: 2, interviewed: 1, hired: 1 });
    expect((await json(admin, "POST", `/api/v1/admin/customers/${companyId}/access`, { decision: "accept", from: "declined", confirm: true })).status).toBe(200);
    expect(((await (await jobsOf(companyId)).json()) as AdminCompanyJobs).jobs[0].jobPageUrl).toBe(`https://jobs.example.test/careers/${slug}/jobs/${openJob}`);
  });
});
