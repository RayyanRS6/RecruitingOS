import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { findLinkByToken } from "@ros/core";
import { applications, auditRecords, candidates, companies, events, memberships, notifications, postings, randomToken, roles, users, withPlatform } from "@ros/db";
import type { FakeUrlVerifier } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { jobUrls } from "./services/job-urls";

/**
 * The owner's posting routes and the Posting tab's data (docs/spec/20 section 2, items 9 to 17): what each channel
 * looks like to the owner, the record-URL / check / confirm flow, pause, resume, close and the removal checklist,
 * tracked links, the accepting switch, the volume report, the daily volume alert, and the boards still up after the
 * role closes. The core functions and the worker job are covered by job-distribution.test.ts; this file drives HTTP.
 */
describe("posting routes: the owner's Posting tab API", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let interviewer = "";
  let ownerId = "";
  let companyId = "";
  let companySlug = "";
  let roleId = "";
  let roleTitle = "";
  const BASE = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return d.getTime(); })();
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  let clockOffset = 0;
  const setClock = (offsetMs: number) => { clockOffset = offsetMs; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + clockOffset); };
  const advance = async (ms: number) => { setClock(clockOffset + ms); await container.drain(); };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const get = (cookie: string, path: string) => json(cookie, "GET", path);
  const post = (cookie: string, path: string, body?: unknown) => json(cookie, "POST", path, body ?? {});
  const P = (channel: string, action: string) => `/api/v1/roles/${roleId}/postings/${channel}/${action}`;
  const verifier = () => container.integrations.verifier as FakeUrlVerifier;
  const posting = async (channel: string) => (await container.db.select().from(postings).where(and(eq(postings.roleId, roleId), eq(postings.channel, channel))))[0];
  const eventsOf = async (type: string) => container.db.select().from(events).where(eq(events.type, type));
  const body = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  /** Rows straight into the tables: the counts are what is tested, not the intake. */
  const seedApplications = async (n: number, source: string, createdAt: Date) => {
    const stamp = createdAt.toISOString();
    const people = await container.db.insert(candidates).values(Array.from({ length: n }, (_, i) => ({ companyId, firstName: `Seed${source}${i}`, lastName: stamp.slice(0, 10), email: `${source}-${randomToken(6).toLowerCase()}@example.test`, firstSource: source, createdAt: stamp }))).returning({ id: candidates.id });
    await container.db.insert(applications).values(people.map((c) => ({ companyId, roleId, candidateId: c.id, packetVersion: 1, source, statusToken: randomToken(18), createdAt: stamp, stageChangedAt: stamp })));
  };

  type PostingView = { id: string; channel: string; status: string; stateLabel: string; isBoard: boolean; name: string; externalUrl: string | null; steps: string[]; verifiedAt: string | null; verifiedBy: { kind: string; id: string } | null; verificationNote: string | null; verificationAttempts: number; verificationError: string | null; pausedAt: string | null; closedAt: string | null; closureRequired: boolean; closureConfirmedAt: string | null; closureConfirmedBy: { kind: string; id: string } | null; stillUp: boolean; error: string | null; link: { id: string; url: string; label: string; visits: number } | null; package: { text: string; fields: Record<string, string> } | null };
  type PostingsResponse = { role: { acceptingApplications: boolean; volumeAlertPerDay: number }; urls: { careers: string; job: string; apply: string }; emailIn: { address: string | null; connected: boolean }; postings: PostingView[]; links: Array<{ id: string; url: string; label: string; source: string; postingId: string | null; disabledAt: string | null }>; boardsStillUp: string[] };
  type ErrorBody = { error: { code: string; message: string; details?: { from?: string; to?: string } } };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    setClock(0);
    owner = await signIn("owner@ledger.test");
    ownerId = (await container.db.select().from(users).where(eq(users.email, "owner@ledger.test")))[0].id;
    const co = await body<{ id: string; slug: string }>(await post(owner, "/api/v1/companies", { name: "Ledger & Co", vertical: "professional_services", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] }));
    companyId = co.id;
    companySlug = co.slug;
    const s = await body<{ session: { id: string } }>(await post(owner, "/api/v1/intake/sessions", { initialMessage: "I need a bookkeeper in Irvine, $60,000 to $70,000, in the office. It's growth. Ceiling $72,000. I decide. Must-haves: QuickBooks. Just draft it." }));
    roleId = (await body<{ roleId: string }>(await post(owner, `/api/v1/intake/sessions/${s.session.id}/compile`))).roleId;
    // This suite covers every board, posted by the team itself: the company has its own ZipRecruiter plan and posts on
    // the boards itself, and the role uses all three (plan D3, D6; ITS posting is covered by publishing.test.ts).
    const [co0] = await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    await container.db.update(companies).set({ settings: { ...co0.settings, boardPosting: "self", zipRecruiterPlan: true } }).where(eq(companies.id, companyId));
    expect((await post(owner, `/api/v1/roles/${roleId}/channels`, { channels: ["linkedin_basic", "indeed", "ziprecruiter"] })).status).toBe(200);
    await post(owner, `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" });
    await container.drain();
    roleTitle = (await container.db.select({ title: roles.title }).from(roles).where(eq(roles.id, roleId)))[0].title;
    // an interviewer on the team: may look, may not change a posting
    const [person] = await container.db.insert(users).values({ email: "interviewer@ledger.test", name: "Ivy Interviewer" }).returning();
    await container.db.insert(memberships).values({ companyId, userId: person.id, role: "interviewer", status: "active" });
    interviewer = await signIn("interviewer@ledger.test");
  });
  afterAll(async () => {
    await container.close();
  });

  it("describes every channel for the owner: state label, steps, the board's tracked link and its package; readers may read, an interviewer may change nothing", async () => {
    const r = await get(owner, `/api/v1/roles/${roleId}/postings`);
    expect(r.status).toBe(200);
    const d = await body<PostingsResponse>(r);
    const urls = jobUrls(container.env, { slug: companySlug, roleId });
    expect(d.urls).toEqual(urls);
    expect(d.role).toMatchObject({ acceptingApplications: true, volumeAlertPerDay: 100 });
    expect(d.boardsStillUp).toEqual([]);
    expect(d.postings.map((p) => p.channel)).toEqual(["careers_page", "google_jobs", "email_in", "linkedin_basic", "indeed", "ziprecruiter"]);
    const by = Object.fromEntries(d.postings.map((p) => [p.channel, p]));
    expect(by.careers_page).toMatchObject({ status: "live_verified", stateLabel: "Live and verified", isBoard: false, name: "Careers page", package: null, link: null });
    expect(by.google_jobs).toMatchObject({ status: "submitted_integration", stateLabel: "Submitted", name: "Google for Jobs" });
    expect(by.email_in).toMatchObject({ status: "failed", stateLabel: "Failed", package: null });
    expect(d.emailIn.connected).toBe(false);
    expect(d.emailIn.address).toMatch(/^apply-[a-z0-9]+@/);
    for (const channel of ["linkedin_basic", "indeed", "ziprecruiter"]) {
      const p = by[channel];
      expect(p, channel).toMatchObject({ status: "ready_to_post", stateLabel: "Ready to post", isBoard: true, externalUrl: null, stillUp: false });
      expect(p.steps).toHaveLength(5);
      expect(p.link?.url).toMatch(/^https:\/\/jobs\.example\.test\/a\/[a-z0-9]{12}$/);
      expect(p.package?.fields.applyUrl).toBe(p.link!.url);
      expect(p.package?.fields.employer).toBe("Ledger & Co");
      expect(p.package?.text).toContain(roleTitle);
      expect(p.package?.text).not.toContain("send applications instead"); // email-in is not connected, so the intake address is not offered
    }
    expect(d.links).toHaveLength(3);
    // the package route, per channel
    const indeed = await body<{ text: string; fields: Record<string, string> }>(await get(owner, P("indeed", "package")));
    expect(indeed.text).toContain("Posting package for Indeed");
    expect(indeed.fields.applyUrl).toBe(by.indeed.link!.url);
    expect(indeed.fields.jobUrl).toBe(urls.job);
    const careers = await body<{ fields: Record<string, string> }>(await get(owner, P("careers_page", "package")));
    expect(careers.fields.applyUrl).toBe(urls.apply);
    expect((await get(owner, P("email_in", "package"))).status).toBe(409);
    expect((await get(owner, P("facebook", "package"))).status).toBe(404);
    // an interviewer reads, and is refused every change
    expect((await get(interviewer, `/api/v1/roles/${roleId}/postings`)).status).toBe(200);
    expect((await get(interviewer, `/api/v1/roles/${roleId}/links`)).status).toBe(200);
    expect((await get(interviewer, `/api/v1/roles/${roleId}/volume`)).status).toBe(200);
    expect((await get(interviewer, P("indeed", "package"))).status).toBe(200);
    for (const action of ["url", "verify", "pause", "resume", "close", "closure-confirm", "retry"]) {
      const refused = await post(interviewer, P("indeed", action), { url: "https://www.indeed.com/viewjob?jk=x", note: "checked" });
      expect(refused.status, action).toBe(403);
    }
    expect((await post(interviewer, `/api/v1/roles/${roleId}/links`, { source: "referral", label: "x" })).status).toBe(403);
    expect((await post(interviewer, `/api/v1/roles/${roleId}/links/${d.links[0].id}/disable`)).status).toBe(403);
    expect((await post(interviewer, `/api/v1/roles/${roleId}/applications/accepting`, { accepting: false })).status).toBe(403);
    // a signed-out call is not a reader either
    expect((await app.request(`/api/v1/roles/${roleId}/postings`)).status).toBe(401);
  });

  it("recording a board's public address moves it to posted and the worker marks it live; only https; a live board refuses another address, naming both states", async () => {
    const url = "https://www.indeed.com/viewjob?jk=abc123";
    verifier().set(url, { pageText: `<html><title>${roleTitle} - Ledger & Co | Indeed</title><body>Apply now</body></html>` });
    expect((await post(owner, P("indeed", "url"), { url: "http://www.indeed.com/viewjob?jk=abc123" })).status).toBe(400);
    expect((await post(owner, P("indeed", "url"), { url: "not a link" })).status).toBe(400);
    expect((await post(owner, P("careers_page", "url"), { url })).status).toBe(409);
    const r = await post(owner, P("indeed", "url"), { url });
    expect(r.status).toBe(200);
    const view = await body<PostingView>(r);
    expect(view).toMatchObject({ channel: "indeed", status: "posted_manually", stateLabel: "Posted", externalUrl: url, verificationAttempts: 0 });
    await container.drain();
    const row = await posting("indeed");
    expect(row).toMatchObject({ status: "live_verified", externalUrl: url, verificationAttempts: 0, verificationError: null });
    expect(row.publicUrlRecordedAt).toBeTruthy();
    expect(row.verifiedBy).toMatchObject({ kind: "system", id: "link_check" });
    expect(verifier().calls.at(-1)).toEqual({ url, expectedTitle: roleTitle });
    const live = (await eventsOf("posting.live_verified")).filter((e) => e.subjectId === row.id);
    expect(live).toHaveLength(1);
    expect(live[0].payload).toMatchObject({ check: "fetched" });
    const audited = (await container.db.select().from(auditRecords).where(eq(auditRecords.action, "posting.changed"))).filter((a) => a.target?.id === row.id);
    expect(audited).toHaveLength(1);
    expect(audited[0].actor).toMatchObject({ kind: "user", id: ownerId });
    // a live listing that moved takes its new address, but is not live there until that address is checked: it is
    // "Posted" again and nothing of the earlier check is kept
    const other = "https://www.indeed.com/viewjob?jk=other";
    verifier().set(other, { pageText: "<h1>Page not found</h1>" });
    const moved = await body<PostingView>(await post(owner, P("indeed", "url"), { url: other }));
    expect(moved).toMatchObject({ status: "posted_manually", stateLabel: "Posted", externalUrl: other, verifiedAt: null, verifiedBy: null, verificationNote: null, verificationAttempts: 0 });
    expect((await eventsOf("posting.posted_manually")).filter((e) => e.subjectId === row.id).at(-1)?.payload).toMatchObject({ from: "live_verified", to: "posted_manually", url: other });
    // back to the right address, which is checked again and live again
    expect((await post(owner, P("indeed", "url"), { url })).status).toBe(200);
    await container.drain();
    expect(await posting("indeed")).toMatchObject({ status: "live_verified", externalUrl: url });
  });

  it("a page that does not name the job fails after three checks; pausing and resuming in between restarts the checks; a person's own confirmation with a note recovers it", async () => {
    const url = "https://www.linkedin.com/jobs/view/999";
    verifier().set(url, { pageText: "<h1>Front office coordinator</h1>" });
    expect((await post(owner, P("linkedin_basic", "verify"), { note: "I looked" })).status).toBe(409); // no address yet
    expect(await body<ErrorBody>(await post(owner, P("linkedin_basic", "verify"), { note: "I looked" }))).toMatchObject({ error: { code: "url_required" } });
    expect((await post(owner, P("linkedin_basic", "url"), { url })).status).toBe(200);
    await container.drain();
    expect(await posting("linkedin_basic")).toMatchObject({ status: "posted_manually", verificationAttempts: 1 });
    // paused while the check is pending: the address is kept; resume records it as posted again and checks from the start
    const paused = await body<PostingView>(await post(owner, P("linkedin_basic", "pause"), { reason: "checking with the board" }));
    expect(paused).toMatchObject({ status: "paused", externalUrl: url });
    expect(paused.pausedAt).toBeTruthy();
    const resumed = await body<PostingView>(await post(owner, P("linkedin_basic", "resume")));
    expect(resumed).toMatchObject({ status: "posted_manually", verificationAttempts: 0, pausedAt: null });
    await container.drain();
    expect(await posting("linkedin_basic")).toMatchObject({ status: "posted_manually", verificationAttempts: 1 });
    // the check that was pending before the pause is still queued and runs alongside the new one: every fetch counts on the row, the third miss fails it
    await advance(5_000);
    let row = await posting("linkedin_basic");
    expect(row).toMatchObject({ status: "failed", verificationAttempts: 3, externalUrl: url });
    expect(row.error).toMatch(/could not be verified after 3 checks/);
    await advance(10_000);
    expect(await posting("linkedin_basic")).toMatchObject({ status: "failed", verificationAttempts: 3 }); // nothing left in the queue touches it
    const failedView = (await body<PostingsResponse>(await get(owner, `/api/v1/roles/${roleId}/postings`))).postings.find((p) => p.channel === "linkedin_basic")!;
    expect(failedView).toMatchObject({ stateLabel: "Failed", verificationError: expect.stringContaining("title_mismatch") });
    // the note is required
    expect((await post(owner, P("linkedin_basic", "verify"), {})).status).toBe(400);
    expect((await post(owner, P("linkedin_basic", "verify"), { note: " " })).status).toBe(400);
    const verified = await post(owner, P("linkedin_basic", "verify"), { note: "Opened the listing on LinkedIn on 24 September; title and apply link are right." });
    expect(verified.status).toBe(200);
    const view = await body<PostingView>(verified);
    expect(view).toMatchObject({ status: "live_verified", stateLabel: "Live and verified", verificationNote: expect.stringContaining("24 September"), verificationAttempts: 0, verificationError: null, error: null });
    expect(view.verifiedBy).toMatchObject({ kind: "user", id: ownerId });
    row = await posting("linkedin_basic");
    expect(row.verifiedAt).toBeTruthy();
    const live = (await eventsOf("posting.live_verified")).filter((e) => e.subjectId === row.id);
    expect(live).toHaveLength(1);
    expect(live[0].payload).toMatchObject({ from: "posted_manually", to: "live_verified", check: "person" });
  });

  it("a person's confirmation stands against a check still queued; \"check again\" is the one thing that re-checks it; a failed board with a recorded address is checked once more and goes live when the page is right", async () => {
    const url = "https://www.ziprecruiter.com/jobs/ledger-co/bookkeeper-1";
    verifier().set(url, { pageText: "<h1>Something else entirely</h1>" });
    expect((await post(owner, P("ziprecruiter", "retry"))).status).toBe(409); // nothing recorded yet, nothing to check
    expect((await post(owner, P("ziprecruiter", "url"), { url })).status).toBe(200);
    await container.drain();
    expect(await posting("ziprecruiter")).toMatchObject({ status: "posted_manually", verificationAttempts: 1 }); // the queue holds the next try
    // the person can see the posting and says so while that next try is still waiting in the queue
    const confirmed = await body<PostingView>(await post(owner, P("ziprecruiter", "verify"), { note: "Opened the listing on ZipRecruiter; it is up." }));
    expect(confirmed).toMatchObject({ status: "live_verified", verificationAttempts: 0, verificationError: null });
    expect(confirmed.verifiedBy).toMatchObject({ kind: "user", id: ownerId });
    const fetched = verifier().calls.length;
    await advance(5_000);
    await advance(10_000);
    let row = await posting("ziprecruiter");
    expect(row).toMatchObject({ status: "live_verified", verificationAttempts: 0, verificationError: null, error: null, verificationNote: "Opened the listing on ZipRecruiter; it is up." });
    expect(row.verifiedBy).toMatchObject({ kind: "user", id: ownerId });
    expect(verifier().calls.length).toBe(fetched); // the queued try saw a person's word and did not even fetch the page
    expect((await eventsOf("posting.failed")).filter((e) => e.subjectId === row.id)).toHaveLength(0);
    // "check again" is a request: the page is fetched, and three misses fail the posting with the reason
    expect((await body<{ action: string }>(await post(owner, P("ziprecruiter", "retry")))).action).toBe("check_again");
    await container.drain();
    expect(verifier().calls.length).toBe(fetched + 1);
    await advance(5_000);
    await advance(10_000);
    row = await posting("ziprecruiter");
    expect(row).toMatchObject({ status: "failed", verificationAttempts: 3, verificationError: expect.stringContaining("title_mismatch") });
    expect(row.verifiedAt).toBeTruthy(); // the person's verification is still on the failed row; nothing below may bring it back for a different address
    // a fresh address starts from nothing: the old verification is cleared, so a later pause and resume cannot call the new address live on the old word
    const url2 = "https://www.ziprecruiter.com/jobs/ledger-co/bookkeeper-2";
    verifier().set(url2, { pageText: `<title>${roleTitle} | ZipRecruiter</title>` });
    const fresh = await body<PostingView>(await post(owner, P("ziprecruiter", "url"), { url: url2 }));
    expect(fresh).toMatchObject({ status: "posted_manually", externalUrl: url2, verifiedAt: null, verifiedBy: null, verificationNote: null, verificationAttempts: 0, verificationError: null, error: null });
    await container.drain();
    row = await posting("ziprecruiter");
    expect(row).toMatchObject({ status: "live_verified", externalUrl: url2 });
    expect(row.verifiedBy).toMatchObject({ kind: "system", id: "link_check" });
    // the page changes under a live posting: check again notices, and three misses fail it
    verifier().set(url2, { pageText: "<h1>This position has been filled</h1>" });
    expect((await body<{ action: string }>(await post(owner, P("ziprecruiter", "retry")))).action).toBe("check_again");
    await container.drain();
    await advance(5_000);
    await advance(10_000);
    expect(await posting("ziprecruiter")).toMatchObject({ status: "failed", verificationAttempts: 3, externalUrl: url2 });
    // the page is fixed: check again on a failed board starts from nothing (the earlier verification does not come back) and it goes live on the system's word
    verifier().set(url2, { pageText: `<title>${roleTitle} | ZipRecruiter</title>` });
    const r = await post(owner, P("ziprecruiter", "retry"));
    expect(r.status).toBe(200);
    const res = await body<{ ok: boolean; action: string; posting: PostingView }>(r);
    expect(res.action).toBe("check_again");
    expect(res.posting).toMatchObject({ status: "posted_manually", verificationAttempts: 0, error: null, verifiedAt: null, verifiedBy: null, verificationNote: null });
    await container.drain();
    row = await posting("ziprecruiter");
    expect(row).toMatchObject({ status: "live_verified", externalUrl: url2 });
    expect(row.verifiedBy).toMatchObject({ kind: "system" });
    // a live posting can be checked again too; it stays live when the page is still right
    expect((await body<{ action: string }>(await post(owner, P("ziprecruiter", "retry")))).action).toBe("check_again");
    await container.drain();
    expect((await posting("ziprecruiter")).status).toBe("live_verified");
  });

  it("pause keeps the verification and resume restores it; close names the board for removal; the removal is confirmed once", async () => {
    const paused = await body<PostingView>(await post(owner, P("indeed", "pause"), { reason: "hiring freeze" }));
    expect(paused).toMatchObject({ status: "paused", stateLabel: "Paused" });
    expect(paused.pausedAt).toBeTruthy();
    expect((await eventsOf("posting.paused")).filter((e) => e.subjectId === paused.id).at(-1)?.payload).toMatchObject({ reason: "hiring freeze" });
    expect((await post(owner, P("indeed", "retry"))).status).toBe(409); // resume it first
    const resumed = await body<PostingView>(await post(owner, P("indeed", "resume")));
    expect(resumed).toMatchObject({ status: "live_verified", pausedAt: null });
    expect(resumed.verifiedBy).toMatchObject({ kind: "system", id: "link_check" });
    expect(resumed.verifiedAt).toBe(paused.verifiedAt);
    const notPaused = await post(owner, P("indeed", "resume"));
    expect(notPaused.status).toBe(409);
    expect((await body<ErrorBody>(notPaused)).error.code).toBe("not_paused");
    // closing a board that is up: the person still has to take it down
    const closed = await body<PostingView>(await post(owner, P("indeed", "close"), { reason: "enough from Indeed" }));
    expect(closed).toMatchObject({ status: "closed", stateLabel: "Closed", closureRequired: true, closureConfirmedAt: null, stillUp: true });
    expect(closed.closedAt).toBeTruthy();
    expect((await eventsOf("posting.closure_required")).filter((e) => e.subjectId === closed.id)).toHaveLength(1);
    expect((await body<PostingsResponse>(await get(owner, `/api/v1/roles/${roleId}/postings`))).boardsStillUp).toEqual(["indeed"]);
    expect((await body<{ boardsStillUp: string[] }>(await get(owner, `/api/v1/roles/${roleId}`))).boardsStillUp).toEqual(["indeed"]);
    // pausing and resuming the role prepares its channels again, and a Retry elsewhere does too: the closed board stays closed, on the checklist and in the brief
    const preparedBefore = (await eventsOf("posting.ready_to_post")).filter((e) => e.subjectId === closed.id).length;
    // the role itself pauses only from open and resumes only from paused (Wave 0 item 0.8): a second click changes nothing
    const openNotPaused = await post(owner, `/api/v1/roles/${roleId}/resume`);
    expect(openNotPaused.status).toBe(409);
    expect((await body<ErrorBody>(openNotPaused)).error).toMatchObject({ code: "not_paused", message: "This role is already open." });
    const resumedBefore = (await eventsOf("role.resumed")).length;
    expect((await post(owner, `/api/v1/roles/${roleId}/pause`)).status).toBe(200);
    const twice = await post(owner, `/api/v1/roles/${roleId}/pause`);
    expect(twice.status).toBe(409);
    expect((await body<ErrorBody>(twice)).error).toMatchObject({ code: "not_open", message: "This role is already paused." });
    expect((await eventsOf("role.paused")).filter((e) => e.subjectId === roleId)).toHaveLength(1);
    expect((await post(owner, `/api/v1/roles/${roleId}/resume`)).status).toBe(200);
    expect((await eventsOf("role.resumed")).length).toBe(resumedBefore + 1);
    await container.drain();
    expect((await body<{ action: string }>(await post(owner, P("email_in", "retry")))).action).toBe("republish");
    await container.drain();
    expect(await posting("indeed")).toMatchObject({ status: "closed", closureRequired: true, closureConfirmedAt: null, closedAt: closed.closedAt });
    expect((await eventsOf("posting.ready_to_post")).filter((e) => e.subjectId === closed.id)).toHaveLength(preparedBefore);
    expect((await body<PostingsResponse>(await get(owner, `/api/v1/roles/${roleId}/postings`))).boardsStillUp).toEqual(["indeed"]);
    expect((await body<{ boardsStillUp: string[] }>(await get(owner, `/api/v1/roles/${roleId}`))).boardsStillUp).toEqual(["indeed"]);
    type StillUpBrief = { cards: Array<{ title: string }> };
    expect((await body<StillUpBrief>(await get(owner, "/api/v1/brief"))).cards.map((c) => c.title)).toContain("Still posted on Indeed");
    // a board that was never marked for removal has nothing to confirm
    const nothing = await post(owner, P("linkedin_basic", "closure-confirm"));
    expect(nothing.status).toBe(409);
    expect((await body<ErrorBody>(nothing)).error.code).toBe("not_required");
    const confirmed = await body<PostingView>(await post(owner, P("indeed", "closure-confirm")));
    expect(confirmed.closureConfirmedAt).toBeTruthy();
    expect(confirmed.closureConfirmedBy).toMatchObject({ kind: "user", id: ownerId });
    expect(confirmed.stillUp).toBe(false);
    expect((await eventsOf("posting.closure_confirmed")).filter((e) => e.subjectId === closed.id)).toHaveLength(1);
    // ticking twice changes nothing
    const again = await body<PostingView>(await post(owner, P("indeed", "closure-confirm")));
    expect(again.closureConfirmedAt).toBe(confirmed.closureConfirmedAt);
    expect((await eventsOf("posting.closure_confirmed")).filter((e) => e.subjectId === closed.id)).toHaveLength(1);
    expect((await body<PostingsResponse>(await get(owner, `/api/v1/roles/${roleId}/postings`))).boardsStillUp).toEqual([]);
    // closed is terminal: the table refuses, naming both states
    const refused = await post(owner, P("indeed", "pause"));
    expect(refused.status).toBe(409);
    expect((await body<ErrorBody>(refused)).error.message).toMatch(/from "Closed" to "Paused"/);
  });

  it("Google for Jobs is marked verified by a person with a note; the careers page and Google follow the role and cannot be paused or closed on their own; one an earlier version left paused can be resumed; the careers page can be checked again; a failed native channel is prepared again", async () => {
    const google = await body<PostingView>(await post(owner, P("google_jobs", "verify"), { note: "Seen in Search Console on 24 September." }));
    expect(google).toMatchObject({ status: "live_verified", verificationNote: "Seen in Search Console on 24 September." });
    expect(google.verifiedBy).toMatchObject({ kind: "user", id: ownerId });
    // Wave 0 item 0.8: a pause or close here would change a label while the job page stayed up and kept taking applications
    for (const channel of ["careers_page", "google_jobs"]) {
      for (const action of ["pause", "close"]) {
        const refused = await post(owner, P(channel, action));
        expect(refused.status, `${channel} ${action}`).toBe(409);
        const err = (await body<ErrorBody>(refused)).error;
        expect(err.code).toBe("follows_the_role");
        expect(err.message).toMatch(/accepting applications|pause the role/);
      }
    }
    expect((await posting("google_jobs")).status).toBe("live_verified");
    expect((await posting("careers_page")).status).toBe("live_verified");
    // a Google posting an earlier version left paused comes back to where it was
    await container.db.update(postings).set({ status: "paused", pausedAt: new Date(BASE + clockOffset).toISOString() }).where(eq(postings.id, google.id));
    const back = await body<PostingView>(await post(owner, P("google_jobs", "resume")));
    expect(back).toMatchObject({ status: "live_verified", verificationNote: "Seen in Search Console on 24 September." });
    expect((await post(owner, P("google_jobs", "retry"))).status).toBe(409); // live: nothing to retry
    // the careers page is fetched again on request and stays live
    const page = await body<{ action: string; posting: PostingView }>(await post(owner, P("careers_page", "retry")));
    expect(page.action).toBe("check_again");
    await container.drain();
    expect((await posting("careers_page")).status).toBe("live_verified");
    // email-in failed because inbound mail is not configured here; a retry re-runs publish and it says so again
    const before = await posting("email_in");
    expect(before.status).toBe("failed");
    const retried = await body<{ action: string }>(await post(owner, P("email_in", "retry")));
    expect(retried.action).toBe("republish");
    await container.drain();
    const after = await posting("email_in");
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/inbound mail domain/i);
    expect(after.intakeToken).toBe(before.intakeToken);
    expect((await post(owner, P("email_in", "verify"), { note: "x" })).status).toBe(409);
    expect((await post(owner, P("nowhere", "retry"))).status).toBe(404);
  });

  it("tracked links: a person creates referral, direct and other links, disables one, and a board's own link is protected while the board is up", async () => {
    expect((await post(owner, `/api/v1/roles/${roleId}/links`, { source: "linkedin", label: "LinkedIn again" })).status).toBe(400);
    expect((await post(owner, `/api/v1/roles/${roleId}/links`, { source: "referral", label: "" })).status).toBe(400);
    const r = await post(owner, `/api/v1/roles/${roleId}/links`, { source: "referral", label: "Referral: Dr. Patel", sourceDetail: "Dr. Patel" });
    expect(r.status).toBe(201);
    const link = await body<{ id: string; url: string; source: string; sourceLabel: string; label: string; sourceDetail: string; postingId: string | null; visits: number; disabledAt: string | null }>(r);
    expect(link).toMatchObject({ source: "referral", sourceLabel: "Referral", label: "Referral: Dr. Patel", sourceDetail: "Dr. Patel", postingId: null, visits: 0, disabledAt: null });
    expect(link.url).toMatch(/^https:\/\/jobs\.example\.test\/a\/[a-z0-9]{12}$/);
    const direct = await body<{ id: string }>(await post(owner, `/api/v1/roles/${roleId}/links`, { source: "direct", label: "Email to past applicants" }));
    await post(owner, `/api/v1/roles/${roleId}/links`, { source: "other", label: "Community board" });
    const list = await body<PostingsResponse["links"]>(await get(owner, `/api/v1/roles/${roleId}/links`));
    expect(list).toHaveLength(6);
    expect(list.filter((l) => l.postingId).map((l) => l.label).sort()).toEqual(["Indeed", "LinkedIn", "ZipRecruiter"]);
    expect(list.filter((l) => !l.postingId).map((l) => l.source).sort()).toEqual(["direct", "other", "referral"]);
    // the event trail never carries the token
    const token = new URL(link.url).pathname.split("/").at(-1)!;
    for (const e of await eventsOf("application_link.created")) expect(JSON.stringify(e)).not.toContain(token);
    // disabling: the public redirect (its own package) reads disabledAt and refuses
    const disabled = await body<{ disabledAt: string | null }>(await post(owner, `/api/v1/roles/${roleId}/links/${direct.id}/disable`));
    expect(disabled.disabledAt).toBeTruthy();
    const foundDirect = await withPlatform(container.db, (tx) => findLinkByToken(tx, new URL((list.find((l) => l.id === direct.id)!).url).pathname.split("/").at(-1)!));
    expect(foundDirect?.disabledAt).toBeTruthy();
    expect((await withPlatform(container.db, (tx) => findLinkByToken(tx, token)))?.disabledAt).toBeNull();
    const twice = await post(owner, `/api/v1/roles/${roleId}/links/${direct.id}/disable`);
    expect(twice.status).toBe(409);
    expect((await body<ErrorBody>(twice)).error.code).toBe("already_disabled");
    // LinkedIn is live: its apply link stays; Indeed is closed: its link may go
    const linkedin = list.find((l) => l.label === "LinkedIn")!;
    const inUse = await post(owner, `/api/v1/roles/${roleId}/links/${linkedin.id}/disable`);
    expect(inUse.status).toBe(409);
    expect((await body<ErrorBody>(inUse)).error.code).toBe("link_in_use");
    const indeed = list.find((l) => l.label === "Indeed")!;
    expect((await post(owner, `/api/v1/roles/${roleId}/links/${indeed.id}/disable`)).status).toBe(200);
    expect((await post(owner, `/api/v1/roles/${roleId}/links/00000000-0000-0000-0000-000000000000/disable`)).status).toBe(404);
    expect((await eventsOf("application_link.disabled")).length).toBe(2);
    const audited = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "application_link.changed"));
    expect(audited.map((a) => a.reason).sort()).toEqual(["created", "created", "created", "disabled", "disabled"]);
  });

  it("the accepting switch closes and reopens applications, tells the team, records the events, and touches nobody who applied", async () => {
    await seedApplications(2, "careers_page", new Date(BASE));
    const before = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(before).toHaveLength(2);
    const r = await post(owner, `/api/v1/roles/${roleId}/applications/accepting`, { accepting: false, reason: "Enough for now" });
    expect(r.status).toBe(200);
    const closed = await body<{ ok: boolean; changed: boolean; role: { acceptingApplications: boolean; applicationsClosedAt: string | null; applicationsClosedReason: string | null } }>(r);
    expect(closed.changed).toBe(true);
    expect(closed.role).toMatchObject({ acceptingApplications: false, applicationsClosedReason: "Enough for now" });
    expect(closed.role.applicationsClosedAt).toBeTruthy();
    expect((await container.db.select().from(roles).where(eq(roles.id, roleId)))[0]).toMatchObject({ acceptingApplications: false, applicationsClosedReason: "Enough for now", status: "open" });
    expect((await eventsOf("role.applications_closed")).at(-1)?.payload).toMatchObject({ reason: "Enough for now" });
    const told = (await container.db.select().from(notifications).where(eq(notifications.kind, "applications.closed")));
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ userId: ownerId, action: { label: "Open the Posting tab", href: `/roles/${roleId}?tab=posting` } });
    expect(told[0].body).toContain("Everyone who already applied stays exactly where they are");
    // nobody was touched
    const after = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(after.map((a) => [a.stage, a.rejectedAt, a.withdrawnAt])).toEqual(before.map((a) => [a.stage, a.rejectedAt, a.withdrawnAt]));
    // the same request twice changes nothing
    const same = await body<{ changed: boolean }>(await post(owner, `/api/v1/roles/${roleId}/applications/accepting`, { accepting: false }));
    expect(same.changed).toBe(false);
    expect((await eventsOf("role.applications_closed")).length).toBe(1);
    // the role page and the volume report say so
    expect(await body<{ acceptingApplications: boolean; applicationsClosedReason: string | null }>(await get(owner, `/api/v1/roles/${roleId}`))).toMatchObject({ acceptingApplications: false, applicationsClosedReason: "Enough for now" });
    expect(await body<{ acceptingApplications: boolean }>(await get(owner, `/api/v1/roles/${roleId}/volume`))).toMatchObject({ acceptingApplications: false });
    // and reopening
    const reopened = await body<{ changed: boolean; role: { acceptingApplications: boolean; applicationsClosedAt: string | null } }>(await post(owner, `/api/v1/roles/${roleId}/applications/accepting`, { accepting: true }));
    expect(reopened).toMatchObject({ changed: true, role: { acceptingApplications: true, applicationsClosedAt: null } });
    expect((await eventsOf("role.applications_reopened")).length).toBe(1);
    expect((await container.db.select().from(notifications).where(eq(notifications.kind, "applications.reopened"))).length).toBe(1);
    expect((await container.db.select().from(auditRecords).where(eq(auditRecords.action, "role.applications_toggled"))).length).toBe(2);
    expect((await post(owner, `/api/v1/roles/${roleId}/applications/accepting`, { accepting: "no" })).status).toBe(400);
  });

  it("the volume report counts applications per day and by source for the last fourteen days, in the company's own time zone", async () => {
    // BASE is 19:00 UTC, midday in the company's zone (Pacific, the default). A row at BASE + 10 h is 05:00 UTC the next
    // day but still the same evening in Pacific time: it belongs to today here, not to a UTC tomorrow.
    await seedApplications(3, "indeed", new Date(BASE));
    await seedApplications(1, "direct", new Date(BASE + 10 * HOUR));
    await seedApplications(2, "linkedin", new Date(BASE - DAY));
    await seedApplications(1, "referral", new Date(BASE - 5 * DAY));
    await seedApplications(1, "other", new Date(BASE - 20 * DAY)); // outside the window
    type Report = { from: string; to: string; timeZone: string; days: Array<{ day: string; total: number; bySource: Record<string, number> }>; totals: { total: number; bySource: Record<string, number> }; sources: Array<{ source: string; label: string; total: number }>; threshold: number; yesterday: { day: string; total: number }; today: { day: string; total: number } };
    const report = await body<Report>(await get(owner, `/api/v1/roles/${roleId}/volume`));
    const todayKey = new Date(BASE).toISOString().slice(0, 10);
    expect(report.timeZone).toBe("America/Los_Angeles");
    expect(report.days).toHaveLength(14);
    expect(report.to).toBe(todayKey);
    expect(report.days.map((d) => d.day)).toEqual([...report.days].map((d) => d.day).sort());
    expect(report.today).toEqual({ day: todayKey, total: 6 });
    expect(report.days[13]).toEqual({ day: todayKey, total: 6, bySource: { careers_page: 2, indeed: 3, direct: 1 } });
    expect(report.yesterday.total).toBe(2);
    expect(report.days[12].bySource).toEqual({ linkedin: 2 });
    expect(report.days[8]).toMatchObject({ total: 1, bySource: { referral: 1 } });
    expect(report.totals).toEqual({ total: 9, bySource: { careers_page: 2, indeed: 3, direct: 1, linkedin: 2, referral: 1 } });
    // sources come in the vocabulary's order (careers page, email, LinkedIn, Indeed, ZipRecruiter, referral, direct, other)
    expect(report.sources).toEqual([{ source: "careers_page", label: "Careers page", total: 2 }, { source: "linkedin", label: "LinkedIn", total: 2 }, { source: "indeed", label: "Indeed", total: 3 }, { source: "referral", label: "Referral", total: 1 }, { source: "direct", label: "Direct", total: 1 }]);
    expect(report.threshold).toBe(100);
  });

  it("the daily check tells owners once when yesterday's applications went above the limit, counts the company's own day, and touches no application", async () => {
    await seedApplications(100, "indeed", new Date(BASE + HOUR)); // still "today" at BASE: 106 in all, counting the evening one
    const applied = (await container.db.select().from(applications).where(eq(applications.roleId, roleId))).length;
    expect(applied).toBe(110);
    expect(await eventsOf("role.volume_high")).toHaveLength(0);
    // the detector runs a day after the company was created; by then BASE's day is "yesterday" in Pacific time
    await advance(25 * HOUR);
    const alerts = await eventsOf("role.volume_high");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subjectId).toBe(roleId);
    expect(alerts[0].payload).toEqual({ day: new Date(BASE).toISOString().slice(0, 10), count: 106, threshold: 100 });
    const told = await container.db.select().from(notifications).where(eq(notifications.kind, "volume.high"));
    expect(told).toHaveLength(1); // the owner; the interviewer is not told
    expect(told[0]).toMatchObject({ userId: ownerId, title: `106 people applied to ${roleTitle} yesterday`, action: { label: "Open the Posting tab", href: `/roles/${roleId}?tab=posting` } });
    expect(told[0].body).toContain("Nobody is turned away automatically");
    // the next day is quiet: no second alert, and the first is not repeated
    await advance(25 * HOUR);
    expect(await eventsOf("role.volume_high")).toHaveLength(1);
    expect((await container.db.select().from(notifications).where(eq(notifications.kind, "volume.high"))).length).toBe(1);
    const rows = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(rows).toHaveLength(applied);
    expect(rows.every((a) => a.stage === "applied" && !a.rejectedAt && !a.withdrawnAt)).toBe(true);
  });

  it("closing the role names the boards still up on the role page, in the postings and in the brief until each removal is confirmed", async () => {
    expect((await post(owner, `/api/v1/roles/${roleId}/outcome`, { outcome: "filled_outside_platform", confirm: true })).status).toBe(200);
    const role = await body<{ status: string; boardsStillUp: string[] }>(await get(owner, `/api/v1/roles/${roleId}`));
    expect(role.status).toBe("closed");
    expect([...role.boardsStillUp].sort()).toEqual(["linkedin_basic", "ziprecruiter"]);
    const d = await body<PostingsResponse>(await get(owner, `/api/v1/roles/${roleId}/postings`));
    expect(d.postings.every((p) => p.status === "closed")).toBe(true);
    expect(d.postings.filter((p) => p.stillUp).map((p) => p.channel).sort()).toEqual(["linkedin_basic", "ziprecruiter"]);
    expect(d.postings.find((p) => p.channel === "google_jobs")?.closureRequired).toBe(false);
    type Brief = { cards: Array<{ kind: string; title: string; body: string; roleId?: string; actions: Array<{ label: string; method: string; path: string }> }> };
    const card = (await body<Brief>(await get(owner, "/api/v1/brief"))).cards.find((c) => c.title.startsWith("Still posted on"));
    expect(card).toBeTruthy();
    expect(card).toMatchObject({ kind: "posting_action", title: "Still posted on LinkedIn, ZipRecruiter", roleId, actions: [{ label: "Open the Posting tab", method: "GET", path: `/roles/${roleId}?tab=posting` }] });
    expect(card!.body).toContain(roleTitle);
    // a closed role takes no new address, no new link, and the switch is moot
    const late = await post(owner, P("ziprecruiter", "url"), { url: "https://www.ziprecruiter.com/jobs/x" });
    expect(late.status).toBe(409);
    expect((await body<ErrorBody>(late)).error.message).toMatch(/from "Closed" to "Posted"/);
    expect((await post(owner, `/api/v1/roles/${roleId}/links`, { source: "referral", label: "Too late" })).status).toBe(409);
    expect((await body<ErrorBody>(await post(owner, `/api/v1/roles/${roleId}/applications/accepting`, { accepting: false }))).error.code).toBe("role_closed");
    // a closed role cannot be resumed back to open, nor paused (Wave 0 item 0.8): before, resume reopened it and published it again
    const publishRunsBefore = (await eventsOf("workflow.started")).filter((e) => (e.payload as { workflowKey?: string }).workflowKey === "publish_role").length;
    const resumeClosed = await post(owner, `/api/v1/roles/${roleId}/resume`);
    expect(resumeClosed.status).toBe(409);
    expect((await body<ErrorBody>(resumeClosed)).error.code).toBe("not_paused");
    expect((await body<ErrorBody>(await post(owner, `/api/v1/roles/${roleId}/pause`))).error.code).toBe("not_open");
    expect((await container.db.select({ status: roles.status }).from(roles).where(eq(roles.id, roleId)))[0].status).toBe("closed");
    expect((await eventsOf("workflow.started")).filter((e) => (e.payload as { workflowKey?: string }).workflowKey === "publish_role").length).toBe(publishRunsBefore);
    // the checklist
    expect((await body<PostingView>(await post(owner, P("linkedin_basic", "closure-confirm")))).stillUp).toBe(false);
    const half = (await body<Brief>(await get(owner, "/api/v1/brief"))).cards.find((c) => c.title.startsWith("Still posted on"));
    expect(half?.title).toBe("Still posted on ZipRecruiter");
    expect((await body<{ boardsStillUp: string[] }>(await get(owner, `/api/v1/roles/${roleId}`))).boardsStillUp).toEqual(["ziprecruiter"]);
    expect((await body<PostingView>(await post(owner, P("ziprecruiter", "closure-confirm")))).closureConfirmedAt).toBeTruthy();
    expect((await body<Brief>(await get(owner, "/api/v1/brief"))).cards.find((c) => c.title.startsWith("Still posted on"))).toBeUndefined();
    expect((await body<{ boardsStillUp: string[] }>(await get(owner, `/api/v1/roles/${roleId}`))).boardsStillUp).toEqual([]);
    expect((await body<PostingsResponse>(await get(owner, `/api/v1/roles/${roleId}/postings`))).boardsStillUp).toEqual([]);
    expect((await eventsOf("posting.closure_confirmed")).length).toBe(3);
  });
});
