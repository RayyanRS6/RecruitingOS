import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { POSTING_VERIFY_JOB_KIND, PostingTransitionError, applyLinkUrl, correctOutcome, disableApplicationLink, findLinkByToken, findPostingLink, postingPackage, recordLinkVisit, transitionPosting } from "@ros/core";
import { applicationLinks, applications, candidates, communications, companies, events, hiringOutcomes, jobs, postings, rolePackets, roles, users, withPlatform, withTenant } from "@ros/db";
import type { FakeUrlVerifier } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { loadEnv } from "./env";
import { createApplication } from "./services/applications";
import { jobUrls, trackedLinkUrl } from "./services/job-urls";

/**
 * Job distribution, the data layer and the worker (docs/spec/20 items 7 to 15): publishing prepares each board with
 * its own tracked link and package and nothing is live until its URL was checked; the careers page passes through
 * the same check; a recorded URL is verified by the worker, a wrong page fails after three checks; a person may
 * confirm a posting themselves; closing the role names the boards still up. The HTTP routes and pages that sit on
 * top of these are tested with their own packages; here the core functions and the job are called directly.
 */
describe("job distribution: postings, links and verification", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerActor: Actor;
  let companyId = "";
  let companySlug = "";
  let roleId = "";
  let roleTitle = "";
  const BASE = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return d.getTime(); })();
  let clockOffset = 0;
  const setClock = (offsetMs: number) => { clockOffset = offsetMs; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + clockOffset); };
  const advance = async (ms: number) => { setClock(clockOffset + ms); await container.drain(); };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const verifier = () => container.integrations.verifier as FakeUrlVerifier;
  const posting = async (channel: string) => (await container.db.select().from(postings).where(and(eq(postings.roleId, roleId), eq(postings.channel, channel))))[0];
  const eventsOf = async (type: string) => container.db.select().from(events).where(eq(events.type, type));
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test/" } });
    app = createApp(container);
    setClock(0);
    owner = await signIn("owner@ledger.test");
    const [user] = await container.db.select().from(users).where(eq(users.email, "owner@ledger.test"));
    ownerActor = { kind: "user", id: user.id, name: "Owner Olivia" };
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Ledger & Co", vertical: "professional_services", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    companySlug = co.slug;
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a bookkeeper in Irvine, $60,000 to $70,000, in the office. It's growth. Ceiling $72,000. I decide. Must-haves: QuickBooks. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" });
    await container.drain();
    roleTitle = (await container.db.select({ title: roles.title }).from(roles).where(eq(roles.id, roleId)))[0].title;
  });
  afterAll(async () => {
    await container.close();
  });

  it("JOBS_BASE_URL defaults to APP_BASE_URL, loses its trailing slash, and must be https in production when set", () => {
    expect(loadEnv({ APP_BASE_URL: "https://app.example.com/" }).JOBS_BASE_URL).toBe("https://app.example.com");
    const env = loadEnv({ APP_BASE_URL: "https://app.example.com", JOBS_BASE_URL: "https://jobs.example.com/" });
    expect(env.JOBS_BASE_URL).toBe("https://jobs.example.com");
    expect(jobUrls(env, { slug: "ledger", roleId: "r1" })).toEqual({ careers: "https://jobs.example.com/careers/ledger", job: "https://jobs.example.com/careers/ledger/jobs/r1", apply: "https://jobs.example.com/careers/ledger/jobs/r1/apply" });
    expect(trackedLinkUrl(env, "abc123def456")).toBe("https://jobs.example.com/a/abc123def456");
    const prod = { NODE_ENV: "production", APP_BASE_URL: "https://app.example.com", SESSION_SECRET: "x".repeat(40), ANALYTICS_SALT: "s", SECRET_STORE: "vault", AI_PROVIDER: "anthropic", AUTH_PROVIDER: "supabase", SUPABASE_URL: "https://p.supabase.co", SUPABASE_ANON_KEY: "k", DATABASE_URL: "postgres://ros_app:pw@h/db", WORKER_INLINE: "false", STORAGE_PROVIDER: "supabase", RATE_LIMIT_STORE: "upstash" };
    expect(() => loadEnv({ ...prod, JOBS_BASE_URL: "http://jobs.example.com" })).toThrow(/JOBS_BASE_URL/);
    expect(() => loadEnv({ ...prod, JOBS_BASE_URL: "https://jobs.example.com/careers" })).toThrow(/JOBS_BASE_URL/);
    expect(loadEnv({ ...prod, JOBS_BASE_URL: "https://jobs.example.com" }).JOBS_BASE_URL).toBe("https://jobs.example.com");
    expect(container.env.JOBS_BASE_URL).toBe("https://jobs.example.test");
  });

  it("publishing prepares each board at ready to post with its own tracked link, its steps and a package; the careers page is live only after the check", async () => {
    const rows = await container.db.select().from(postings).where(eq(postings.roleId, roleId));
    const by = Object.fromEntries(rows.map((p) => [p.channel, p]));
    expect(Object.keys(by).sort()).toEqual(["careers_page", "email_in", "google_jobs", "indeed", "linkedin_basic", "ziprecruiter"]);
    // the careers page: prepared, its URL recorded by the system, then fetched by the (fake) verifier during the drain
    const urls = jobUrls(container.env, { slug: companySlug, roleId });
    expect(by.careers_page).toMatchObject({ status: "live_verified", externalUrl: urls.job, verificationAttempts: 0, verificationError: null });
    expect(by.careers_page.publicUrlRecordedAt).toBeTruthy();
    expect(by.careers_page.verifiedAt).toBeTruthy();
    expect(by.careers_page.verifiedBy).toMatchObject({ kind: "system" });
    expect(verifier().calls).toContainEqual({ url: urls.job, expectedTitle: roleTitle });
    expect(by.google_jobs).toMatchObject({ status: "submitted_integration", externalUrl: urls.job });
    expect(by.email_in).toMatchObject({ status: "failed" });
    expect(by.email_in.error).toMatch(/inbound mail domain/i);
    expect(by.email_in.intakeToken).toBeTruthy();
    // the boards
    const expectedLabel: Record<string, string> = { linkedin_basic: "LinkedIn", indeed: "Indeed", ziprecruiter: "ZipRecruiter" };
    const expectedSource: Record<string, string> = { linkedin_basic: "linkedin", indeed: "indeed", ziprecruiter: "ziprecruiter" };
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, 1)));
    for (const channel of ["linkedin_basic", "indeed", "ziprecruiter"]) {
      const p = by[channel];
      expect(p.status, channel).toBe("ready_to_post");
      expect(p.externalUrl).toBeNull();
      const link = await findPostingLink(container.db, p.id);
      expect(link, channel).toBeTruthy();
      expect(link!.token).toMatch(/^[a-z0-9]{12}$/);
      expect(link!.token).not.toContain(roleId.slice(0, 8));
      expect(link!).toMatchObject({ companyId, roleId, postingId: p.id, source: expectedSource[channel], label: expectedLabel[channel], visits: 0, disabledAt: null });
      const trackedUrl = applyLinkUrl(container.env.JOBS_BASE_URL, link!.token);
      expect(trackedUrl).toBe(`https://jobs.example.test/a/${link!.token}`);
      expect(p.instructions).toContain(trackedUrl);
      expect(p.steps).toHaveLength(5);
      expect(p.steps.join("\n")).toContain(trackedUrl);
      expect(p.steps.join("\n")).toContain("Ledger & Co");
      // the package the API serves for this board is built from the same pieces
      const pkg = postingPackage({ packet: pv.packet, companyName: "Ledger & Co", jobUrl: urls.job, applyUrl: trackedUrl, intakeAddress: `apply-${by.email_in.intakeToken}@${container.integrations.env.intakeDomain}`, boardName: expectedLabel[channel] });
      expect(pkg.fields.applyUrl).toBe(trackedUrl);
      expect(pkg.fields.employer).toBe("Ledger & Co");
      expect(pkg.fields.jobUrl).toBe(urls.job);
      expect(pkg.text).toContain(roleTitle);
    }
    expect((await container.db.select().from(applicationLinks).where(eq(applicationLinks.roleId, roleId))).length).toBe(3);
    expect((await eventsOf("application_link.created")).length).toBe(3);
    // the state events tell the story: three boards and the careers page prepared, the page posted and then live
    expect((await eventsOf("posting.ready_to_post")).length).toBe(4);
    expect((await eventsOf("posting.posted_manually")).length).toBe(1);
    expect((await eventsOf("posting.live_verified")).length).toBe(1);
    const runs = await container.db.select().from(jobs).where(eq(jobs.kind, POSTING_VERIFY_JOB_KIND));
    expect(runs.map((j) => j.status)).toEqual(["done"]);
  });

  it("re-running publish (a paused role resumed) keeps the boards' links and leaves a verified posting alone", async () => {
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/pause`, {})).status).toBe(200);
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/resume`, {})).status).toBe(200);
    await container.drain();
    expect((await container.db.select().from(applicationLinks).where(eq(applicationLinks.roleId, roleId))).length).toBe(3);
    expect((await posting("careers_page")).status).toBe("live_verified");
    expect((await posting("indeed")).status).toBe("ready_to_post");
    expect((await eventsOf("posting.live_verified")).length).toBe(1);
  });

  it("recording a board's public URL moves it to posted; the worker fetches it and marks it live and verified by the system", async () => {
    const indeed = await posting("indeed");
    const url = "https://www.indeed.com/viewjob?jk=abc123";
    verifier().set(url, { pageText: `<html><title>${roleTitle} - Ledger & Co | Indeed</title><body>Apply now</body></html>` });
    const moved = await withTenant(container.db, companyId, (tx) => transitionPosting(tx, { postingId: indeed.id, to: "posted_manually", actor: ownerActor, now: container.engine.clock(), patch: { externalUrl: url } }));
    expect(moved).toMatchObject({ from: "ready_to_post", to: "posted_manually" });
    expect(moved.row.publicUrlRecordedAt).toBeTruthy();
    await container.engine.enqueue(container.db, { kind: POSTING_VERIFY_JOB_KIND, payload: { postingId: indeed.id, companyId }, maxAttempts: 3 });
    await container.drain();
    const after = await posting("indeed");
    expect(after).toMatchObject({ status: "live_verified", externalUrl: url, verificationAttempts: 0, verificationError: null });
    expect(after.verifiedBy).toMatchObject({ kind: "system", id: "link_check" });
    expect(after.verifiedAt).toBeTruthy();
    expect(after.publishedAt).toBeTruthy();
    expect(verifier().calls.at(-1)).toEqual({ url, expectedTitle: roleTitle });
    const live = (await eventsOf("posting.live_verified")).filter((e) => e.subjectId === indeed.id);
    expect(live).toHaveLength(1);
    expect(live[0].payload).toMatchObject({ channel: "indeed", from: "posted_manually", to: "live_verified", url, check: "fetched" });
  });

  it("a page that does not name the job fails after three checks with backoff, and stays a person's decision", async () => {
    const linkedin = await posting("linkedin_basic");
    const url = "https://www.linkedin.com/jobs/view/999";
    verifier().set(url, { pageText: "<h1>Front office coordinator</h1>" });
    await withTenant(container.db, companyId, (tx) => transitionPosting(tx, { postingId: linkedin.id, to: "posted_manually", actor: ownerActor, now: container.engine.clock(), patch: { externalUrl: url } }));
    await container.engine.enqueue(container.db, { kind: POSTING_VERIFY_JOB_KIND, payload: { postingId: linkedin.id, companyId }, maxAttempts: 3 });
    await container.drain();
    let row = await posting("linkedin_basic");
    expect(row).toMatchObject({ status: "posted_manually", verificationAttempts: 1 });
    expect(row.verificationError).toMatch(/title_mismatch/);
    // the queue holds the job with a delay; nothing changes until the clock reaches it
    await container.drain();
    expect((await posting("linkedin_basic")).verificationAttempts).toBe(1);
    await advance(5_000);
    row = await posting("linkedin_basic");
    expect(row).toMatchObject({ status: "posted_manually", verificationAttempts: 2 });
    await advance(10_000);
    row = await posting("linkedin_basic");
    expect(row).toMatchObject({ status: "failed", verificationAttempts: 3, externalUrl: url });
    expect(row.error).toMatch(/could not be verified after 3 checks/);
    expect(row.verifiedAt).toBeNull();
    const failures = (await eventsOf("posting.verification_failed")).filter((e) => e.subjectId === linkedin.id);
    expect(failures.map((e) => e.payload.attempt)).toEqual([1, 2, 3]);
    expect(failures.map((e) => e.payload.final)).toEqual([false, false, true]);
    expect((await eventsOf("posting.failed")).filter((e) => e.subjectId === linkedin.id)).toHaveLength(1);
    const queued = await container.db.select().from(jobs).where(eq(jobs.kind, POSTING_VERIFY_JOB_KIND));
    expect(queued.every((j) => j.status === "done")).toBe(true);
  });

  it("a person may confirm a posting themselves with a note, and the state table refuses a shortcut to live", async () => {
    const linkedin = await posting("linkedin_basic");
    await withTenant(container.db, companyId, async (tx) => {
      await expect(transitionPosting(tx, { postingId: linkedin.id, to: "live_verified", actor: ownerActor })).rejects.toThrow(PostingTransitionError);
      await transitionPosting(tx, { postingId: linkedin.id, to: "posted_manually", actor: ownerActor, now: container.engine.clock(), patch: { error: null } });
      await transitionPosting(tx, { postingId: linkedin.id, to: "live_verified", actor: ownerActor, now: container.engine.clock(), patch: { verificationNote: "Opened the listing on LinkedIn on 22 September; title and apply link are right." } });
    });
    const row = await posting("linkedin_basic");
    expect(row).toMatchObject({ status: "live_verified", verificationNote: expect.stringContaining("22 September") });
    expect(row.verifiedBy).toMatchObject({ kind: "user", id: ownerActor.id });
    expect(row.verifiedAt).toBeTruthy();
    // pause and resume keep the URL and the verification
    await withTenant(container.db, companyId, async (tx) => {
      const paused = await transitionPosting(tx, { postingId: row.id, to: "paused", actor: ownerActor, now: container.engine.clock(), reason: "hiring freeze" });
      expect(paused.row.pausedAt).toBeTruthy();
      const resumed = await transitionPosting(tx, { postingId: row.id, to: "live_verified", actor: ownerActor, now: container.engine.clock(), patch: { verifiedBy: row.verifiedBy, verifiedAt: row.verifiedAt } });
      expect(resumed.row.pausedAt).toBeNull();
      expect(resumed.row.verifiedBy).toMatchObject({ kind: "user" });
    });
    expect((await eventsOf("posting.paused")).filter((e) => e.subjectId === row.id)).toHaveLength(1);
  });

  it("an application through a tracked link records the source, the detail and the link, never the token; visits are counted; a disabled link is not found for its board", async () => {
    const indeed = await posting("indeed");
    const link = (await findPostingLink(container.db, indeed.id))!;
    // the public redirect resolves the token through the platform role and counts the visit
    const found = await withPlatform(container.db, (tx) => findLinkByToken(tx, link.token));
    expect(found?.id).toBe(link.id);
    expect(await withPlatform(container.db, (tx) => findLinkByToken(tx, "nope"))).toBeNull();
    await withPlatform(container.db, (tx) => recordLinkVisit(tx, link.id, container.engine.clock()));
    expect((await container.db.select().from(applicationLinks).where(eq(applicationLinks.id, link.id)))[0]).toMatchObject({ visits: 1 });
    const result = await withTenant(container.db, companyId, (tx) =>
      createApplication(tx, container, { companyId, roleId, source: link.source, sourceDetail: "Indeed listing", linkId: link.id, firstName: "Ana", lastName: "Lopez", email: "ana.lopez@example.com", phone: null, smsConsent: false, consentSource: "careers_page_apply", noticeVersionsShown: ["privacy@2026-09-01"], eligibilityAnswers: {}, noResumeAnswers: { summary: "Bookkeeper at Coastal Books since 2019; QuickBooks." } }, { kind: "candidate", id: "applicant" }),
    );
    await container.drain();
    const [application] = await container.db.select().from(applications).where(eq(applications.id, result.application.id));
    expect(application).toMatchObject({ source: "indeed", sourceDetail: "Indeed listing", linkId: link.id });
    const [candidate] = await container.db.select().from(candidates).where(eq(candidates.id, application.candidateId));
    expect(candidate.firstSource).toBe("indeed");
    const comms = await container.db.select().from(communications).where(eq(communications.applicationId, application.id));
    expect(comms.length).toBeGreaterThan(0);
    for (const record of [application, candidate, ...comms]) expect(JSON.stringify(record)).not.toContain(link.token);
    const status = await app.request(`/c/status/${application.statusToken}`);
    expect(status.status).toBe(200);
    expect(await status.text()).not.toContain(link.token);
    // the acknowledgment's status link is on the job-page host
    expect(comms.find((c) => c.templateKey === "acknowledgment")?.bodyText).toContain(`https://jobs.example.test/c/status/${application.statusToken}`);
    // disabling
    const extra = await withTenant(container.db, companyId, (tx) => disableApplicationLink(tx, { linkId: link.id, companyId, actor: ownerActor, now: container.engine.clock() }));
    expect(extra?.disabledAt).toBeTruthy();
    expect(await findPostingLink(container.db, indeed.id)).toBeNull();
    expect((await withPlatform(container.db, (tx) => findLinkByToken(tx, link.token)))?.disabledAt).toBeTruthy(); // the redirect sees it and refuses
    expect((await eventsOf("application_link.disabled")).length).toBe(1);
  });

  it("closing the role closes every posting and names the boards that are still up for manual removal", async () => {
    const before = Object.fromEntries((await container.db.select().from(postings).where(eq(postings.roleId, roleId))).map((p) => [p.channel, p.status]));
    expect(before).toEqual({ careers_page: "live_verified", google_jobs: "submitted_integration", email_in: "failed", indeed: "live_verified", linkedin_basic: "live_verified", ziprecruiter: "ready_to_post" });
    const r = await json(owner, "POST", `/api/v1/roles/${roleId}/outcome`, { outcome: "role_cancelled", confirm: true, reason: "Budget pulled." });
    expect(r.status).toBe(200);
    const after = await container.db.select().from(postings).where(eq(postings.roleId, roleId));
    for (const p of after) {
      expect(p.status, p.channel).toBe("closed");
      expect(p.closedAt, p.channel).toBeTruthy();
      expect(p.closureRequired, p.channel).toBe(["indeed", "linkedin_basic"].includes(p.channel));
      expect(p.closureConfirmedAt).toBeNull();
    }
    const required = await eventsOf("posting.closure_required");
    expect(required.map((e) => e.payload.channel).sort()).toEqual(["indeed", "linkedin_basic"]);
    expect(required.find((e) => e.payload.channel === "indeed")?.payload.url).toBe("https://www.indeed.com/viewjob?jk=abc123");
    expect((await eventsOf("posting.closed")).filter((e) => e.payload.roleId === roleId)).toHaveLength(6);
    expect((await eventsOf("role.closed")).at(-1)?.payload).toMatchObject({ closureRequired: ["indeed", "linkedin_basic"] });
    // a person confirms a board was taken down (the route belongs to another package; the write is a plain patch)
    const indeed = after.find((p) => p.channel === "indeed")!;
    await withTenant(container.db, companyId, (tx) => tx.update(postings).set({ closureConfirmedAt: container.engine.clock().toISOString(), closureConfirmedBy: ownerActor }).where(eq(postings.id, indeed.id)));
    const stillUp = (await container.db.select().from(postings).where(eq(postings.roleId, roleId))).filter((p) => p.closureRequired && !p.closureConfirmedAt).map((p) => p.channel);
    expect(stillUp).toEqual(["linkedin_basic"]);
    // closed is terminal: a late verification is a no-op and nothing reopens
    await container.engine.enqueue(container.db, { kind: POSTING_VERIFY_JOB_KIND, payload: { postingId: indeed.id, companyId }, maxAttempts: 3 });
    await container.drain();
    expect((await posting("indeed")).status).toBe("closed");
    await withTenant(container.db, companyId, async (tx) => {
      await expect(transitionPosting(tx, { postingId: indeed.id, to: "live_verified", actor: ownerActor })).rejects.toThrow(/cannot move from "Closed"/);
    });
    const [co] = await container.db.select().from(companies).where(eq(companies.id, companyId));
    expect(co.slug).toBe(companySlug);
  });

  it("a role opened again after closing prepares its closed channels again, but a board still up on the outside stays closed and on the checklist", async () => {
    // an administrator voids the role's outcome (the role goes back to open) and publishing runs again
    const [outcome] = await container.db.select().from(hiringOutcomes).where(and(eq(hiringOutcomes.roleId, roleId), eq(hiringOutcomes.milestone, "role")));
    await withTenant(container.db, companyId, async (tx) => {
      await correctOutcome(tx, { outcomeId: outcome.id, actor: ownerActor, reason: "closed by mistake" });
      await container.engine.start(tx, { workflowKey: "publish_role", companyId, subject: { type: "role", id: roleId }, state: { roleId, packetVersion: 1 }, actor: ownerActor });
    });
    await container.drain();
    expect((await container.db.select().from(roles).where(eq(roles.id, roleId)))[0].status).toBe("open");
    // Indeed was taken down and confirmed, ZipRecruiter was never up: both are prepared again from nothing
    for (const channel of ["indeed", "ziprecruiter"]) expect(await posting(channel), channel).toMatchObject({ status: "ready_to_post", closedAt: null, closureRequired: false, closureConfirmedAt: null });
    expect((await posting("careers_page")).status).toBe("live_verified");
    // LinkedIn is still up and nobody confirmed its removal: it is not offered for posting again, and the checklist keeps it
    expect(await posting("linkedin_basic")).toMatchObject({ status: "closed", closureRequired: true, closureConfirmedAt: null });
    expect((await posting("linkedin_basic")).closedAt).toBeTruthy();
  });
});
