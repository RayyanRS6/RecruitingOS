import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { RolePacket } from "@ros/contracts";
import { entitlements } from "@ros/core";
import { approvalRequests, auditRecords, companies, entitlements as entitlementRows, events, postings, recruiterEscalations, rolePackets, roles, withPlatform } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAs } from "./test-helpers";

/**
 * Approving with the boards ticked on the approval card (POST /roles/:id/approve with `channels`; the live smoke test of
 * 4 Nov 2026): the boards are checked as POST /roles/:id/channels checks them and land with the approval, or not at all.
 * A refused approval changes nothing, a change to a live job carries no boards, and with no list the saved boards stand.
 */
describe("approving with the boards ticked on the approval card", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const post = (cookie: string, path: string, body: unknown = {}) => json(cookie, "POST", path, body);
  const approve = (cookie: string, roleId: string, body: { version: number; channels?: unknown[] }) => post(cookie, `/api/v1/roles/${roleId}/approve`, body);
  const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string } }).error;
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    return (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
  };
  /** The fake role plan names Indeed, so a new role's saved boards are the plan's: Indeed, with nothing ticked yet. */
  const newRole = async (cookie: string, mutate?: (p: RolePacket) => void) => {
    const s = (await (await post(cookie, "/api/v1/intake/sessions", { initialMessage: "I need a bookkeeper in Irvine, $60,000 to $70,000, in the office. It's growth. Ceiling $72,000. I decide. Must-haves: QuickBooks. Just draft it." })).json()) as { session: { id: string } };
    const roleId = ((await (await post(cookie, `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    await container.drain();
    if (mutate) {
      const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, 1)));
      const packet = structuredClone(pv.packet);
      mutate(packet);
      await container.db.update(rolePackets).set({ packet }).where(eq(rolePackets.id, pv.id));
    }
    return roleId;
  };
  const roleRow = async (roleId: string) => (await container.db.select().from(roles).where(eq(roles.id, roleId)))[0];
  const channelsOf = async (roleId: string) => (await container.db.select().from(postings).where(eq(postings.roleId, roleId))).map((p) => p.channel).sort();
  const posting = async (roleId: string, channel: string) => (await container.db.select().from(postings).where(and(eq(postings.roleId, roleId), eq(postings.channel, channel))))[0];
  const tasksOf = (roleId: string) => container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.roleId, roleId));
  const boardEvents = (roleId: string) => container.db.select().from(events).where(and(eq(events.type, "role.boards_chosen"), eq(events.subjectId, roleId)));
  const approvalsOf = (roleId: string) => container.db.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, roleId), eq(approvalRequests.actionType, "role_packet.approve")));
  const settings = async (patch: Record<string, unknown>, id = companyId) => {
    const [co] = await container.db.select({ s: companies.settings }).from(companies).where(eq(companies.id, id));
    await container.db.update(companies).set({ settings: { ...co.s, ...patch } }).where(eq(companies.id, id));
  };
  /** These tests leave many roles waiting or open; the plan's places are not their subject. */
  const roomForRoles = (id: string) => withPlatform(container.db, (tx) => tx.update(entitlementRows).set({ limit: 40 }).where(and(eq(entitlementRows.companyId, id), eq(entitlementRows.key, "active_roles"))));
  /** A new role whose approval was refused is exactly as it was: nothing ticked, still waiting, nothing recorded. */
  const stillWaitingUntouched = async (roleId: string) => {
    expect(await roleRow(roleId)).toMatchObject({ status: "pending_approval", publishChannels: null });
    expect((await approvalsOf(roleId)).map((a) => a.status)).toEqual(["pending"]);
    expect(await boardEvents(roleId)).toEqual([]);
    expect(await channelsOf(roleId)).toEqual([]);
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    owner = await signIn("owner@approve-boards.test");
    companyId = ((await (await post(owner, "/api/v1/companies", { name: "Boards & Co", vertical: "professional_services", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    await roomForRoles(companyId);
  });
  afterAll(async () => {
    await container.close();
  });

  it("applies the boards with the approval: the job goes only where they say, ITS gets a task for each, and the record says who chose them", async () => {
    const roleId = await newRole(owner);
    expect((await approve(owner, roleId, { version: 1, channels: ["linkedin_basic"] })).status).toBe(200);
    await container.drain();
    const role = await roleRow(roleId);
    expect(role).toMatchObject({ status: "open", currentPacketVersion: 1, publishChannels: ["linkedin_basic"] });
    expect((await approvalsOf(roleId)).map((a) => a.status)).toEqual(["approved"]);
    expect(await channelsOf(roleId)).toEqual(["careers_page", "email_in", "google_jobs", "linkedin_basic"]);
    expect((await tasksOf(roleId)).map((t) => [t.kind, t.postingId])).toEqual([["post_job", (await posting(roleId, "linkedin_basic")).id]]);
    const [chosen, ...others] = await boardEvents(roleId);
    expect(others).toEqual([]);
    expect(chosen.payload).toEqual({ channels: ["linkedin_basic"], before: ["indeed"] });
    const [record] = await container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "role.boards_chosen"), sql`${auditRecords.target}->>'id' = ${roleId}`));
    expect(record).toMatchObject({ reason: "linkedin_basic", details: { channels: ["linkedin_basic"], before: ["indeed"] } });
    // what the Share tab and the screen right after approval read
    const view = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/postings`)).json()) as { boards: Array<{ channel: string; chosen: boolean }> };
    expect(view.boards.filter((b) => b.chosen).map((b) => b.channel)).toEqual(["linkedin_basic"]);
  });

  it("takes an empty list as a choice: no job boards at all", async () => {
    const roleId = await newRole(owner);
    expect((await approve(owner, roleId, { version: 1, channels: [] })).status).toBe(200);
    await container.drain();
    expect((await roleRow(roleId)).publishChannels).toEqual([]);
    expect(await channelsOf(roleId)).toEqual(["careers_page", "email_in", "google_jobs"]);
    expect(await tasksOf(roleId)).toEqual([]);
    expect((await boardEvents(roleId))[0].payload).toEqual({ channels: [], before: ["indeed"] });
  });

  it("with no list the saved boards stand, as before: the role plan's, or the ones saved earlier", async () => {
    const fromThePlan = await newRole(owner);
    expect((await approve(owner, fromThePlan, { version: 1 })).status).toBe(200);
    await container.drain();
    expect((await roleRow(fromThePlan)).publishChannels).toBeNull();
    expect(await channelsOf(fromThePlan)).toEqual(["careers_page", "email_in", "google_jobs", "indeed"]);
    expect(await boardEvents(fromThePlan)).toEqual([]);

    const saved = await newRole(owner);
    expect((await post(owner, `/api/v1/roles/${saved}/channels`, { channels: ["linkedin_basic"] })).status).toBe(200);
    expect((await approve(owner, saved, { version: 1 })).status).toBe(200);
    await container.drain();
    expect((await roleRow(saved)).publishChannels).toEqual(["linkedin_basic"]);
    expect(await channelsOf(saved)).toEqual(["careers_page", "email_in", "google_jobs", "linkedin_basic"]);
    // the save, and nothing more
    expect(await boardEvents(saved)).toHaveLength(1);
  });

  it("a refused approval leaves the boards alone: the wrong version, or what the law still asks for", async () => {
    const wrong = await newRole(owner);
    const r = await approve(owner, wrong, { version: 2, channels: [] });
    expect(r.status).toBe(409);
    expect((await errorOf(r)).code).toBe("version_mismatch");
    await stillWaitingUntouched(wrong);

    const colorado = await newRole(owner, (p) => { p.identity.locations = [{ city: "Denver", region: "CO", country: "US" }]; delete p.compensation.benefitsSummary; });
    const law = await approve(owner, colorado, { version: 1, channels: ["linkedin_basic"] });
    expect(law.status).toBe(409);
    expect((await errorOf(law)).code).toBe("legal_check");
    await stillWaitingUntouched(colorado);
  });

  it("a page left behind changes nothing: another approver already opened the role, and its listing stays up", async () => {
    const roleId = await newRole(owner);
    expect((await approve(owner, roleId, { version: 1 })).status).toBe(200);
    await container.drain();
    expect((await post(owner, `/api/v1/roles/${roleId}/postings/indeed/url`, { url: "https://www.indeed.com/viewjob?jk=stale" })).status).toBe(200);
    await container.drain();
    expect(await posting(roleId, "indeed")).toMatchObject({ status: "live_verified", closureRequired: false });

    const stale = await approve(owner, roleId, { version: 1, channels: [] });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe("nothing_pending");
    expect((await roleRow(roleId)).publishChannels).toBeNull();
    expect(await posting(roleId, "indeed")).toMatchObject({ status: "live_verified", closureRequired: false });
    expect((await tasksOf(roleId)).filter((t) => t.kind === "take_down_job")).toEqual([]);
    expect(await boardEvents(roleId)).toEqual([]);
  });

  it("refused for who is asking or an ended trial, the boards stay as they were; the person who may decide approves with theirs", async () => {
    const own = await signIn("owner@second-boards.test");
    const second = ((await (await post(own, "/api/v1/companies", { name: "Second Boards", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    await roomForRoles(second);
    const first = await newRole(own);
    const later = await newRole(own);
    // a second owner: whoever started the role no longer approves it
    const other = await signInAs(container, app, { companyId: second, role: "owner", email: "other@second-boards.test" });
    const self = await approve(own, first, { version: 1, channels: [] });
    expect(self.status).toBe(409);
    expect((await errorOf(self)).code).toBe("self_approval");
    await stillWaitingUntouched(first);
    expect((await approve(other, first, { version: 1, channels: [] })).status).toBe(200);
    await container.drain();
    expect((await roleRow(first)).publishChannels).toEqual([]);
    // the trial's days are over: a job going live for the first time waits for a plan
    await withPlatform(container.db, (tx) => tx.update(companies).set({ settings: sql`${companies.settings} || jsonb_build_object('trial', (${companies.settings}->'trial') || jsonb_build_object('endsAt', ${new Date(Date.now() - 86_400_000).toISOString()}::text))` }).where(eq(companies.id, second)));
    const ended = await approve(other, later, { version: 1, channels: [] });
    expect(ended.status).toBe(402);
    expect((await errorOf(ended)).code).toBe("trial_ended");
    await stillWaitingUntouched(later);
  });

  it("choosing the boards needs role.manage here too: a hiring manager approves, but with no list", async () => {
    const roleId = await newRole(owner);
    const hiring = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hank@approve-boards.test" });
    const refused = await approve(hiring, roleId, { version: 1, channels: [] });
    expect(refused.status).toBe(403);
    await stillWaitingUntouched(roleId);
    expect((await approve(hiring, roleId, { version: 1 })).status).toBe(200);
    await container.drain();
    expect((await roleRow(roleId)).publishChannels).toBeNull();
    expect(await channelsOf(roleId)).toContain("indeed");
  });

  it("the plan's limits still hold: ZipRecruiter needs the company's own plan, and the list is checked as POST /channels checks it", async () => {
    const roleId = await newRole(owner);
    const noPlan = await approve(owner, roleId, { version: 1, channels: ["ziprecruiter"] });
    expect(noPlan.status).toBe(409);
    expect((await errorOf(noPlan)).code).toBe("ziprecruiter_needs_plan");
    await stillWaitingUntouched(roleId);
    for (const channels of [["monster"], ["careers_page"], ["indeed", "indeed", "indeed", "indeed"]]) expect((await approve(owner, roleId, { version: 1, channels })).status, channels.join()).toBe(400);
    await stillWaitingUntouched(roleId);
    // with its own plan it is offered, and the boards are kept in their usual order
    await settings({ zipRecruiterPlan: true });
    expect((await approve(owner, roleId, { version: 1, channels: ["ziprecruiter", "indeed"] })).status).toBe(200);
    await container.drain();
    expect((await roleRow(roleId)).publishChannels).toEqual(["indeed", "ziprecruiter"]);
    expect(await channelsOf(roleId)).toEqual(["careers_page", "email_in", "google_jobs", "indeed", "ziprecruiter"]);
    await settings({ zipRecruiterPlan: false });
  });

  it("a change to a live job never carries boards: approving it closes nothing, whatever a stale page sends", async () => {
    const roleId = await newRole(owner);
    expect((await approve(owner, roleId, { version: 1 })).status).toBe(200);
    await container.drain();
    expect((await post(owner, `/api/v1/roles/${roleId}/postings/indeed/url`, { url: "https://www.indeed.com/viewjob?jk=live" })).status).toBe(200);
    await container.drain();
    const v1 = ((await (await json(owner, "GET", `/api/v1/roles/${roleId}/packets`)).json()) as Array<{ packet: RolePacket }>)[0].packet;
    const pay = structuredClone(v1);
    pay.compensation.max += 1000;
    expect(await (await post(owner, `/api/v1/roles/${roleId}/packets`, { packet: pay, changeSummary: "Top of the range up" })).json()).toMatchObject({ version: 2, outcome: "proposed_pending_approval" });
    await container.drain();

    const refused = await approve(owner, roleId, { version: 2, channels: [] });
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).code).toBe("live_job_boards");
    expect(await roleRow(roleId)).toMatchObject({ status: "open", currentPacketVersion: 1, publishChannels: null });
    expect((await approvalsOf(roleId)).find((a) => (a.proposal as { version?: number }).version === 2)?.status).toBe("pending");
    expect(await posting(roleId, "indeed")).toMatchObject({ status: "live_verified", closureRequired: false });
    expect(await boardEvents(roleId)).toEqual([]);

    expect((await approve(owner, roleId, { version: 2 })).status).toBe(200);
    await container.drain();
    expect(await roleRow(roleId)).toMatchObject({ status: "open", currentPacketVersion: 2, publishChannels: null });
    expect((await posting(roleId, "indeed")).status).not.toBe("closed");
  });

  it("the boards and the approval land together: an approval that cannot finish saves no boards either", async () => {
    const roleId = await newRole(owner);
    const engine = container.engine as unknown as { signal: (...args: unknown[]) => Promise<unknown> };
    const real = engine.signal;
    engine.signal = async () => { throw new Error("the last step of the approval failed"); };
    try {
      expect((await approve(owner, roleId, { version: 1, channels: [] })).status).toBe(500);
    } finally {
      engine.signal = real;
    }
    await stillWaitingUntouched(roleId);
    expect((await approve(owner, roleId, { version: 1, channels: [] })).status).toBe(200);
    await container.drain();
    expect(await roleRow(roleId)).toMatchObject({ status: "open", publishChannels: [] });
  });
});
