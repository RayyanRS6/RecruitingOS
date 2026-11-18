import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { ActionResult, BulkActionResult, CandidateList, CandidatePanel, HomeView } from "@ros/contracts";
import { FAKE_SAMPLE_RESUMES } from "@ros/agents";
import { applications, auditRecords, candidates, communications, notifications, screens, users } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { plantJob, signInAs, statusTokenFor, usePlan } from "./test-helpers";

/**
 * A company's candidates through the API: the list, the panel, the resume file, the actions a person presses for one
 * candidate or several, and what the candidate's own choices (a person instead of the AI interview, withdrawing) do to
 * them. The whole hire, from the job builder to the decision email, is tests/scenario/hiring.test.ts.
 */
describe("a job's candidates", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  const ids: Record<string, string> = {};

  const BASE = Date.now();
  let offset = 0;
  const advance = async (ms: number) => { offset += ms; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset); await container.drain(); };
  const HOUR = 3600_000;

  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(devLink).searchParams.get("token") }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const call = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const read = async <T>(path: string, cookie = owner): Promise<T> => {
    const r = await call(cookie, "GET", path);
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as T;
  };
  const act = (who: string, action: string, cookie = owner) => call(cookie, "POST", `/api/v1/applications/${ids[who]}/actions`, { action });
  const acted = async (who: string, action: string): Promise<ActionResult> => {
    const r = await act(who, action);
    expect(r.status, await r.clone().text()).toBe(200);
    await container.drain();
    return (await r.json()) as ActionResult;
  };
  const refused = async (who: string, action: string) => {
    const r = await act(who, action);
    return { status: r.status, ...((await r.json()) as { error: { code: string; message: string } }).error };
  };
  const list = (tab: string, job = roleId) => read<CandidateList>(`/api/v1/roles/${job}/applications?tab=${tab}`);
  const panel = (who: string) => read<CandidatePanel>(`/api/v1/applications/${ids[who]}`);
  const actionsOf = async (who: string) => (await panel(who)).actions.map((a) => [a.action, a.allowed, a.reason]);
  const form = (path: string, fields: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const mailTo = (email: string) => (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === email);
  const stageOf = async (who: string) => (await container.db.select({ stage: applications.stage, toldState: applications.toldState }).from(applications).where(eq(applications.id, ids[who])))[0];
  const screensOf = async (who: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, ids[who]))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  /** The owner's own updates (everyone on the team gets a row of their own). */
  const updates = async () => (await container.db.select({ title: notifications.title }).from(notifications).innerJoin(users, eq(users.id, notifications.userId)).where(and(eq(notifications.companyId, companyId), eq(users.email, "owner@candidates.test")))).map((n) => n.title);

  /** Applies on the public form with a resume inside it, as a browser without script does. */
  const apply = async (name: string, resume: string, job = roleId) => {
    const email = `${name.toLowerCase()}@people.test`;
    const fd = new FormData();
    fd.set("firstName", name);
    fd.set("lastName", "Tester");
    fd.set("email", email);
    fd.set("acknowledged", "yes");
    fd.set("resume", new File([`${name} Tester\n${email}\n${resume}\n`], "resume.txt", { type: "text/plain" }));
    const res = await app.request(`/careers/${slug}/jobs/${job}/apply`, { method: "POST", body: fd });
    expect(res.status, await res.clone().text()).toBe(302);
    await container.drain();
    const [row] = await container.db.select({ id: applications.id }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(and(eq(applications.roleId, job), eq(candidates.email, email)));
    ids[name] = row.id;
    return email;
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", STORAGE_PROVIDER: "memory", WORKER_INLINE: "true", MESSAGE_UNDO_SECONDS: "30", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset);
    owner = await signIn("owner@candidates.test");
    companyId = ((await (await call(owner, "POST", "/api/v1/companies", { name: "Coastal Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    slug = (await read<{ slug: string }>("/api/v1/companies/current")).slug;
    await usePlan(container, companyId, "ultra");
    roleId = await plantJob(container, { companyId, title: "Dental Assistant" });
    for (const name of ["Ada", "Ben", "Cy", "Dee"]) await apply(name, FAKE_SAMPLE_RESUMES.possible);
  });
  afterAll(async () => { await container.close(); });

  it("lists the people of a tab with their resume score and allowed actions, and opens one as a panel, recording who looked", async () => {
    const fresh = await list("new");
    expect(fresh.role).toMatchObject({ id: roleId, title: "Dental Assistant", status: "open" });
    expect(fresh.rows.map((r) => r.name).sort()).toEqual(["Ada Tester", "Ben Tester", "Cy Tester", "Dee Tester"]);
    expect(fresh.counts).toEqual({ total: 4, byTab: { new: 4, shortlisted: 0, interviewed: 0, hired: 0, not_selected: 0 }, locked: 0 });
    for (const row of fresh.rows) {
      expect(row).toMatchObject({ stage: "triaged", tab: "new", label: "New", interviewScore: null, aiInterview: null, toldState: null });
      expect(typeof row.cvScore.score).toBe("number");
      expect(row.actions.map((a) => [a.action, a.allowed])).toEqual([["shortlist", true], ["hire", true], ["reject", true]]);
    }
    // an unknown tab is refused, and a job of nobody's is not found
    expect((await call(owner, "GET", `/api/v1/roles/${roleId}/applications?tab=everyone`)).status).toBe(400);
    expect((await call(owner, "GET", "/api/v1/roles/00000000-0000-7000-8000-000000000000/applications")).status).toBe(404);
    const ada = await panel("Ada");
    expect(ada).toMatchObject({ id: ids.Ada, role: { id: roleId, title: "Dental Assistant", status: "open" }, candidate: { firstName: "Ada", lastName: "Tester", name: "Ada Tester", email: "ada@people.test" }, stage: "triaged", tab: "new", label: "New", sourceLabel: "Job page", aiInterview: null, toldState: null, toldAt: null });
    expect(ada.cv).toMatchObject({ filename: "resume.txt", status: "clean", statusLabel: expect.any(String), hasText: true });
    expect(ada.cvReview?.summary).toEqual(expect.any(String));
    const viewed = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "candidate.viewed")));
    expect(viewed.length).toBeGreaterThanOrEqual(1);
  });

  it("serves the resume itself only as a checked file, and records each read", async () => {
    const ada = await panel("Ada");
    const text = await call(owner, "GET", `/api/v1/applications/${ids.Ada}/documents/${ada.cv!.id}/inline?as=text`);
    expect(text.status).toBe(200);
    expect(text.headers.get("content-type")).toContain("text/plain");
    expect(text.headers.get("cache-control")).toBe("private, no-store");
    expect(await text.text()).toContain("Dental Hygienist at Coastal Smiles");
    const file = await call(owner, "GET", `/api/v1/applications/${ids.Ada}/documents/${ada.cv!.id}/file`);
    expect(file.status).toBe(302);
    // the document of one application is not found under another
    expect((await call(owner, "GET", `/api/v1/applications/${ids.Ben}/documents/${ada.cv!.id}/file`)).status).toBe(404);
    const reads = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "document.read")));
    expect(reads).toHaveLength(2);
  });

  it("keeps another company out, and lets a member of the team act", async () => {
    const stranger = await signIn("owner@elsewhere.test");
    await call(stranger, "POST", "/api/v1/companies", { name: "Elsewhere Dental", vertical: "dental", sizeBand: "1-9", locations: [{ city: "Tustin", region: "CA", country: "US" }] });
    // refused or not found, and never a word about the person
    for (const r of [await call(stranger, "GET", `/api/v1/roles/${roleId}/applications`), await call(stranger, "GET", `/api/v1/applications/${ids.Ada}`), await act("Ada", "hire", stranger)]) {
      expect([403, 404]).toContain(r.status);
      expect(await r.text()).not.toContain("Ada");
    }
    expect((await stageOf("Ada")).stage).toBe("triaged");
    expect((await call("", "GET", `/api/v1/roles/${roleId}/applications`)).status).toBe(401);
    const member = await signInAs(container, app, { companyId, role: "hiring_manager" });
    expect((await call(member, "GET", `/api/v1/roles/${roleId}/applications`)).status).toBe(200);
    const done = await act("Dee", "reject", member);
    expect(done.status, await done.clone().text()).toBe(200);
    expect((await acted("Dee", "undo_decision")).stage).toBe("triaged");
  });

  it("refuses an action that does not fit where the person is, in the rule's own words", async () => {
    expect(await refused("Ada", "send_decision")).toMatchObject({ status: 409, code: "action_not_allowed" });
    expect(await refused("Ada", "cancel_screen")).toMatchObject({ status: 409, code: "action_not_allowed" });
    expect(await refused("Ada", "undo_decision")).toMatchObject({ status: 409, code: "action_not_allowed" });
    expect((await call(owner, "POST", `/api/v1/applications/${ids.Ada}/actions`, { action: "promote" })).status).toBe(400);
    expect((await stageOf("Ada")).stage).toBe("triaged");
  });

  it("cancels an AI interview before it is sent: the link closes and the person is back in New", async () => {
    await acted("Ada", "shortlist");
    const [first] = await screensOf("Ada");
    expect(first.status).toBe("invited");
    expect(await actionsOf("Ada")).toEqual([["remind_screen", false, "A reminder or the link went to them in the last day. Try again tomorrow."], ["cancel_screen", true, null], ["hire", true, null], ["reject", true, null]]);
    const back = await acted("Ada", "cancel_screen");
    expect(back).toMatchObject({ stage: "triaged", tab: "new", label: "New" });
    expect((await screensOf("Ada"))[0].status).toBe("cancelled");
    expect(await (await app.request(`/c/screen/${first.token}`)).text()).toContain("This AI interview is closed");
    expect((await panel("Ada")).aiInterview).toBeNull();
    // and they can be shortlisted again, with a new link
    await acted("Ada", "shortlist");
    const both = await screensOf("Ada");
    expect(both.map((s) => s.status)).toEqual(["cancelled", "invited"]);
    expect(both[1].token).not.toBe(first.token);
  });

  it("sends a reminder when a person asks, at most one a day", async () => {
    expect(await refused("Ada", "remind_screen")).toMatchObject({ status: 409, code: "action_not_allowed", message: "A reminder or the link went to them in the last day. Try again tomorrow." });
    const before = mailTo("ada@people.test").length;
    await advance(25 * HOUR);
    const done = await acted("Ada", "remind_screen");
    expect(done.message).toBe("Reminder sent to Ada.");
    const mail = mailTo("ada@people.test");
    expect(mail).toHaveLength(before + 1);
    expect(mail.at(-1)!.text).toContain(`/c/screen/${(await screensOf("Ada"))[1].token}`);
    expect(await refused("Ada", "remind_screen")).toMatchObject({ status: 409, code: "action_not_allowed" });
    // the reminder that goes by itself at 48 hours is not sent on top of it
    await advance(23 * HOUR);
    expect(mailTo("ada@people.test")).toHaveLength(before + 1);
  });

  it("records a candidate's choice of a person instead of the AI interview, and tells the team", async () => {
    await acted("Ben", "shortlist");
    const [screen] = await screensOf("Ben");
    const page = await (await app.request(`/c/screen/${screen.token}/person`)).text();
    expect(page).toContain("Talk to a person instead");
    expect((await form(`/c/screen/${screen.token}/person`)).status).toBe(302);
    await container.drain();
    expect((await screensOf("Ben"))[0].status).toBe("declined_by_candidate");
    expect(await (await app.request(`/c/screen/${screen.token}`)).text()).toContain("The hiring team has been told");
    const row = (await list("shortlisted")).rows.find((r) => r.name === "Ben Tester")!;
    expect(row).toMatchObject({ stage: "screen_invited", label: "Chose not to do the AI interview", aiInterview: { status: "opted_out" } });
    expect(row.actions.filter((a) => a.allowed).map((a) => a.action)).toEqual(expect.arrayContaining(["hire", "reject"]));
    expect((await updates()).filter((t) => t.includes("Ben Tester"))).toHaveLength(1);
    // nothing they typed was sent, and the team decides from here: Not selected stays private until a person tells them
    const done = await acted("Ben", "reject");
    expect(done).toMatchObject({ stage: "rejected", toldState: "not_told" });
  });

  it("takes a decision email back while it waits, and marks several people at once with one result each", async () => {
    const queued = await acted("Ben", "send_decision");
    expect(queued.toldState).toBe("queued");
    const taken = await acted("Ben", "unsend_decision");
    expect(taken).toMatchObject({ stage: "rejected", toldState: "not_told", message: "The decision email to Ben was not sent." });
    await advance(HOUR);
    expect(mailTo("ben@people.test").some((m) => m.subject === "Your application to Coastal Dental")).toBe(false);
    expect(await container.db.select({ status: communications.status }).from(communications).where(and(eq(communications.applicationId, ids.Ben), eq(communications.templateKey, "disposition")))).toEqual([{ status: "cancelled" }]);
    // several at once: each gets its own result, and a refusal never blocks the rest
    const otherJob = await plantJob(container, { companyId, title: "Front Desk" });
    await apply("Eve", FAKE_SAMPLE_RESUMES.possible, otherJob);
    const bulk = await call(owner, "POST", `/api/v1/roles/${roleId}/applications/actions`, { action: "reject", applicationIds: [ids.Cy, ids.Dee, ids.Eve, ids.Ben] });
    expect(bulk.status, await bulk.clone().text()).toBe(200);
    const out = (await bulk.json()) as BulkActionResult;
    expect(out).toMatchObject({ action: "reject", done: 2, refused: 2 });
    expect(out.results.map((r) => [r.name, r.ok, r.code])).toEqual([["Cy Tester", true, null], ["Dee Tester", true, null], ["", false, "not_found"], ["Ben Tester", false, "action_not_allowed"]]);
    expect((await stageOf("Eve")).stage).toBe("triaged");
    expect((await list("not_selected")).rows.map((r) => [r.name, r.toldLabel]).sort()).toEqual([["Ben Tester", "Not told yet"], ["Cy Tester", "Not told yet"], ["Dee Tester", "Not told yet"]]);
  });

  it("a candidate who withdraws is listed as Withdrew, their AI interview closes, and the team gets one update saying so", async () => {
    const token = await statusTokenFor(container, { roleId, email: "ada@people.test" });
    const [, open] = await screensOf("Ada");
    // without the tick nothing happens
    expect((await form(`/c/status/${token}/withdraw`)).headers.get("location")).toBe(`/c/status/${token}?confirm=withdraw`);
    expect((await stageOf("Ada")).stage).toBe("screen_invited");
    expect((await form(`/c/status/${token}/withdraw`, { confirm: "yes" })).headers.get("location")).toBe(`/c/status/${token}?withdrawn=1`);
    await container.drain();
    expect((await stageOf("Ada")).stage).toBe("withdrawn");
    expect((await screensOf("Ada")).map((s) => s.status)).toEqual(["cancelled", "cancelled"]);
    expect(await (await app.request(`/c/screen/${open.token}`)).text()).toContain("This AI interview is closed");
    expect((await updates()).filter((t) => t.includes("withdrew"))).toEqual(["Ada Tester withdrew"]);
    const row = (await list("not_selected")).rows.find((r) => r.name === "Ada Tester")!;
    expect(row).toMatchObject({ stage: "withdrawn", label: "Withdrew", toldState: null, actions: [] });
    // someone marked Not selected who was never told may still withdraw; nothing of the decision was ever shown to them
    const cy = await statusTokenFor(container, { roleId, email: "cy@people.test" });
    expect(await (await app.request(`/c/status/${cy}`)).text()).toContain("Withdraw my application");
    // a second press changes nothing
    await form(`/c/status/${token}/withdraw`, { confirm: "yes" });
    expect((await updates()).filter((t) => t.includes("withdrew"))).toHaveLength(1);
  });

  it("Home counts what is new to review and who finished the AI interview, for open and paused jobs", async () => {
    const home = await read<HomeView>("/api/v1/home");
    expect(home.jobs.map((j) => [j.title, j.status, j.toReview, j.interviewed, j.applicants])).toEqual([["Front Desk", "open", 1, 0, 1], ["Dental Assistant", "open", 0, 0, 4]]);
    expect(home.notices).toEqual([]);
    expect(home.drafts).toEqual([]);
    expect(home.room).toMatchObject({ ok: true });
  });
});
