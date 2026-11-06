import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { TRIAL_ENDED_LINE, type RolePacket } from "@ros/contracts";
import { approvalRequests, companies, entitlements, notifications, policies, rolePackets, roles, withPlatform, withTenant, workflowRuns } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAs, signInWithIdentity, usePlan, useTrial } from "./test-helpers";

/**
 * Approving a remote job with no benefits (the owner's report of 6 November 2026: "where can I approve this job"). Every
 * remote job answers to the six places whose law asks for the benefits, and until now the only ways to give them left the
 * page or restarted the approval. The words now go straight on the version waiting (POST
 * /roles/:id/packets/:version/benefits): in place, only filling a blank, with no new version and no new approval. Nothing
 * else about the law moved: both approve routes still refuse while the words are missing. `viewer.blockedBy` says what
 * holds Approve for the person reading the card.
 */
describe("the benefits, written on the approval card", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  const WORDS = "Health and dental cover, 401(k), paid time off.";
  const REMOTE_JOB = "I need a bookkeeper in Irvine, fully remote, $60,000 to $70,000 a year, full time. It's growth. Ceiling $72,000. I decide. Must-haves: QuickBooks. Just draft it.";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const post = (cookie: string, path: string, body: unknown = {}) => json(cookie, "POST", path, body);
  const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;
  const benefits = (cookie: string, roleId: string, version: number | string, text: unknown = WORDS) => post(cookie, `/api/v1/roles/${roleId}/packets/${version}/benefits`, { text });

  type LegalItem = { key: string; label: string; met: boolean; detail: string; fix: string | null };
  type Pending = { id: string; version: number; editWhileOpen: boolean; legalCheck: { items: LegalItem[]; missing: LegalItem[] }; viewer: { mayDecide: boolean; maySendBack: boolean; reason: string | null; blockedBy: string | null } };
  const pendingFor = async (cookie: string, roleId: string) => ((await (await json(cookie, "GET", `/api/v1/roles/${roleId}`)).json()) as { packetApproval: { pending: Pending | null } }).packetApproval.pending;
  const viewerOf = async (cookie: string, roleId: string) => (await pendingFor(cookie, roleId))!.viewer;
  const request = async (roleId: string) => (await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, roleId), eq(approvalRequests.actionType, "role_packet.approve"), eq(approvalRequests.status, "pending"))))[0] ?? null;
  const versionsOf = (roleId: string) => container.db.select().from(rolePackets).where(eq(rolePackets.roleId, roleId));
  const versionOf = async (roleId: string, version = 1) => (await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, version))))[0];
  const roleRow = async (roleId: string) => (await container.db.select().from(roles).where(eq(roles.id, roleId)))[0];

  /** A role waiting for approval, drafted the way the owner drafts one; `message` says where the job is. */
  const waiting = async (cookie = owner, message = REMOTE_JOB) => {
    const s = (await (await post(cookie, "/api/v1/intake/sessions", { initialMessage: message })).json()) as { session: { id: string } };
    const r = await post(cookie, `/api/v1/intake/sessions/${s.session.id}/compile`);
    expect(r.status, await r.clone().text()).toBe(201);
    const made = (await r.json()) as { roleId: string; packet: RolePacket };
    await container.drain();
    return made;
  };
  /** A new company with its owner, on a plan with room, so each case has the people it names and nobody else. */
  const newCompany = async (name: string, opts: { plan?: boolean } = {}) => {
    const cookie = await signInWithIdentity(app, container, { email: `owner@${name}.test`, name: `${name} Owner`, provider: "google", aal2: false });
    const co = (await (await post(cookie, "/api/v1/companies", { name, vertical: "professional_services", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    if (opts.plan !== false) await usePlan(container, co.id);
    await roomForRoles(co.id);
    return { cookie, id: co.id, slug: co.slug };
  };
  /** These tests leave many roles waiting or open; the plan's places are not their subject. */
  const roomForRoles = (id: string) => withPlatform(container.db, (tx) => tx.update(entitlements).set({ limit: 40 }).where(and(eq(entitlements.companyId, id), eq(entitlements.key, "active_roles"))));

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    const co = await newCompany("benefits-co");
    owner = co.cookie;
    companyId = co.id;
    slug = co.slug;
  });
  afterAll(async () => {
    await container.close();
  });

  describe("a remote job with no benefits", () => {
    it("the law holds it on both approve routes, whoever asks, until the words are there", async () => {
      const { roleId, packet } = await waiting();
      expect(packet.identity.remotePolicy).toBe("remote");
      expect(packet.compensation.benefitsSummary).toBeUndefined();
      const pending = (await pendingFor(owner, roleId))!;
      expect(pending.legalCheck.missing.map((m) => m.key)).toEqual(["benefits"]);
      // the compliance layer's own words, which the field shows word for word
      expect(pending.legalCheck.missing[0]).toMatchObject({
        label: "A short description of the benefits",
        detail: "The law in Colorado, Illinois, Maryland, Minnesota, New Jersey and Washington asks for a short description of the benefits on the job ad, and this remote job could be done there.",
        fix: "Describe the benefits on the job's approval card, or in Settings (used for every job).",
      });
      expect(pending.viewer).toMatchObject({ mayDecide: false, maySendBack: true, blockedBy: "legal", reason: expect.stringMatching(/^Before this job can go live, the law where it is asks for: a short description of the benefits\. Describe the benefits on the job's approval card/) });

      const refused = await post(owner, `/api/v1/roles/${roleId}/approve`, { version: 1 });
      expect(refused.status).toBe(409);
      const err = await errorOf(refused);
      expect(err.code).toBe("legal_check");
      expect((err.details?.missing as Array<{ key: string }>).map((m) => m.key)).toEqual(["benefits"]);
      const viaDecide = await post(owner, `/api/v1/approvals/${pending.id}/decide`, { decision: "approve" });
      expect(viaDecide.status).toBe(409);
      expect((await errorOf(viaDecide)).code).toBe("legal_check");
      // still waiting, as it was
      expect((await roleRow(roleId)).status).toBe("pending_approval");
      expect((await request(roleId))?.id).toBe(pending.id);
      // Home says the same and sends them to the job's card
      type Card = { kind: string; roleId?: string; body: string; actions: Array<{ label: string; path: string }> };
      const card = ((await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Card[] }).cards.find((c) => c.kind === "decision" && c.roleId === roleId)!;
      expect(card.body).toContain("Describe the benefits on the job's approval card");
      expect(card.actions).toMatchObject([{ label: "See what is missing", path: `/roles/${roleId}` }]);
    });

    it("one press fills the blank on the version waiting: the same version, the same request, the same run, and nobody told again", async () => {
      const { roleId } = await waiting();
      const before = await request(roleId);
      const row = await versionOf(roleId);
      const told = () => container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "approval.requested")));
      const noticesBefore = (await told()).length;
      const runsBefore = (await container.db.select().from(workflowRuns).where(eq(workflowRuns.companyId, companyId))).length;

      const r = await benefits(owner, roleId, 1, `  ${WORDS}  `);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ version: 1 });
      await container.drain();

      expect((await versionsOf(roleId)).map((v) => v.version)).toEqual([1]);
      const after = await versionOf(roleId);
      expect(after.packet.compensation.benefitsSummary).toBe(WORDS);
      // only that one blank moved: who wrote the version, its status and everything else in it are as they were
      expect({ ...after.packet, compensation: { ...after.packet.compensation, benefitsSummary: undefined } }).toEqual({ ...row.packet, compensation: { ...row.packet.compensation, benefitsSummary: undefined } });
      expect(after).toMatchObject({ status: "proposed", createdBy: row.createdBy, approvedAt: null, approvedBy: null, changeSummary: row.changeSummary });
      expect((await request(roleId))?.id).toBe(before!.id);
      expect((await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, before!.workflowRunId!)))[0].status).toBe("waiting");
      expect((await container.db.select().from(workflowRuns).where(eq(workflowRuns.companyId, companyId))).length).toBe(runsBefore);
      expect((await told()).length).toBe(noticesBefore);
      // the company's own text is not touched: this says it for this job alone
      expect((await container.db.select({ s: companies.settings }).from(companies).where(eq(companies.id, companyId)))[0].s.benefitsSummary).toBeUndefined();
    });

    it("the legal check clears, Approve wakes, and nothing is public until someone says yes; then the job page and the preview carry the words", async () => {
      const { roleId } = await waiting();
      const jobPage = () => app.request(`/careers/${slug}/jobs/${roleId}`);
      expect((await benefits(owner, roleId, 1)).status).toBe(200);
      const pending = (await pendingFor(owner, roleId))!;
      expect(pending.legalCheck.missing).toEqual([]);
      expect(pending.legalCheck.items.find((i) => i.key === "benefits")).toMatchObject({ met: true, detail: "The job ad describes the benefits.", fix: null });
      expect(pending.viewer).toEqual({ mayDecide: true, maySendBack: true, reason: null, blockedBy: null });
      expect((await roleRow(roleId)).status).toBe("pending_approval");
      expect((await jobPage()).status).toBe(404);
      const preview = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/preview?version=1`)).json()) as { job: { benefits: string | null } };
      expect(preview.job.benefits).toBe(WORDS);

      expect((await post(owner, `/api/v1/roles/${roleId}/approve`, { version: 1 })).status).toBe(200);
      await container.drain();
      expect((await roleRow(roleId)).status).toBe("open");
      const html = await (await jobPage()).text();
      expect(html).toContain("<h2>Benefits</h2>");
      expect(html).toContain("Health and dental cover, 401(k), paid time off.");
    });

    it("says who wrote the words and on which version, on the job's Activity", async () => {
      const { roleId } = await waiting();
      expect((await benefits(owner, roleId, 1)).status).toBe(200);
      const timeline = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/timeline`)).json()) as Array<{ type: string; subjectId: string; actor: { kind: string; name?: string }; payload: Record<string, unknown> }>;
      const entry = timeline.find((e) => e.type === "role_packet.edited")!;
      expect(entry).toMatchObject({ subjectId: `${roleId}:1`, actor: { kind: "user", name: "benefits-co Owner" }, payload: { roleId, version: 1, changeSummary: "Benefits written on the approval card", takesEffect: "after_approval", openFlags: 0 } });
    });

    it("a change that makes a live job remote is held the same way, and the box fills that version too, while the job keeps running", async () => {
      const { roleId, packet } = await waiting(owner, "I need a bookkeeper in Irvine, $60,000 to $70,000 a year, full time, in the office. It's growth. Ceiling $72,000. I decide. Must-haves: QuickBooks. Just draft it.");
      expect(packet.identity.remotePolicy).toBe("onsite");
      expect((await post(owner, `/api/v1/roles/${roleId}/approve`, { version: 1 })).status).toBe(200);
      await container.drain();
      const remote = structuredClone(packet);
      remote.identity.remotePolicy = "remote";
      const v2 = await post(owner, `/api/v1/roles/${roleId}/packets`, { packet: remote, changeSummary: "Fully remote now" });
      expect(await v2.json()).toMatchObject({ version: 2, outcome: "proposed_pending_approval" });
      await container.drain();
      const pending = (await pendingFor(owner, roleId))!;
      expect(pending).toMatchObject({ version: 2, editWhileOpen: true, viewer: { mayDecide: false, blockedBy: "legal" } });
      expect((await benefits(owner, roleId, 2)).status).toBe(200);
      expect((await versionOf(roleId, 2)).packet.compensation.benefitsSummary).toBe(WORDS);
      // the version the job runs on has not moved
      expect((await versionOf(roleId, 1)).packet.compensation.benefitsSummary).toBeUndefined();
      expect((await roleRow(roleId)).currentPacketVersion).toBe(1);
      expect((await viewerOf(owner, roleId))).toMatchObject({ mayDecide: true, blockedBy: null });
      expect((await post(owner, `/api/v1/roles/${roleId}/approve`, { version: 2 })).status).toBe(200);
      await container.drain();
      expect((await roleRow(roleId)).currentPacketVersion).toBe(2);
    });

    it("the job's own words come before the company's, and with the company's words nothing is missing at all", async () => {
      const co = await newCompany("company-words");
      const { roleId } = await waiting(co.cookie);
      const [row] = await container.db.select({ s: companies.settings }).from(companies).where(eq(companies.id, co.id));
      await container.db.update(companies).set({ settings: { ...row.s, benefitsSummary: "The company's own benefits." } }).where(eq(companies.id, co.id));
      expect((await pendingFor(co.cookie, roleId))!.legalCheck.missing).toEqual([]);
      expect((await viewerOf(co.cookie, roleId)).blockedBy).toBeNull();
      expect((await benefits(co.cookie, roleId, 1)).status).toBe(200);
      const preview = (await (await json(co.cookie, "GET", `/api/v1/roles/${roleId}/preview?version=1`)).json()) as { job: { benefits: string | null } };
      expect(preview.job.benefits).toBe(WORDS);
    });
  });

  describe("what the route refuses", () => {
    it("anyone who may not edit the job: HR and an interviewer, and nothing is written", async () => {
      const { roleId } = await waiting();
      const hr = await signInAs(container, app, { companyId, role: "hr", email: "hr@benefits-co.test" });
      const interviewer = await signInAs(container, app, { companyId, role: "interviewer", email: "wes@benefits-co.test" });
      for (const cookie of [hr, interviewer]) {
        const r = await benefits(cookie, roleId, 1);
        expect(r.status).toBe(403);
        expect((await errorOf(r)).code).toBe("forbidden");
      }
      expect((await versionOf(roleId)).packet.compensation.benefitsSummary).toBeUndefined();
    });

    it("words too short to be a description, too long for the company's own limit, or anything else in the body", async () => {
      const { roleId } = await waiting();
      for (const text of ["", "   ", "x", " y ", "a".repeat(2001), 7, null]) expect((await benefits(owner, roleId, 1, text)).status, JSON.stringify(text)).toBe(400);
      expect((await post(owner, `/api/v1/roles/${roleId}/packets/1/benefits`, {})).status).toBe(400);
      expect((await post(owner, `/api/v1/roles/${roleId}/packets/1/benefits`, { text: WORDS, version: 2 })).status).toBe(400);
      expect((await versionOf(roleId)).packet.compensation.benefitsSummary).toBeUndefined();
      expect((await viewerOf(owner, roleId)).blockedBy).toBe("legal");
      // the limit itself is fine
      expect((await benefits(owner, roleId, 1, "a".repeat(2000))).status).toBe(200);
    });

    it("a version or a job that is not there, or belongs to another company", async () => {
      const { roleId } = await waiting();
      const missing = await benefits(owner, roleId, 9);
      expect(missing.status).toBe(404);
      expect((await errorOf(missing)).code).toBe("version_not_found");
      expect((await benefits(owner, "00000000-0000-4000-8000-000000000000", 1)).status).toBe(404);
      const other = await newCompany("other-co");
      expect((await benefits(other.cookie, roleId, 1)).status).toBe(404);
      expect((await versionOf(roleId)).packet.compensation.benefitsSummary).toBeUndefined();
    });

    it("an approved version: a live job with nothing waiting, and the live version beside a change that waits", async () => {
      const { roleId, packet } = await waiting(owner, "I need a bookkeeper in Irvine, $60,000 to $70,000 a year, full time, in the office. It's growth. Ceiling $72,000. I decide. Must-haves: QuickBooks. Just draft it.");
      expect((await post(owner, `/api/v1/roles/${roleId}/approve`, { version: 1 })).status).toBe(200);
      await container.drain();
      const live = await benefits(owner, roleId, 1);
      expect(live.status).toBe(409);
      expect(await errorOf(live)).toMatchObject({ code: "not_waiting", message: "Only the version waiting for approval takes this." });
      const remote = structuredClone(packet);
      remote.identity.remotePolicy = "remote";
      expect((await post(owner, `/api/v1/roles/${roleId}/packets`, { packet: remote, changeSummary: "Remote" })).status).toBe(201);
      await container.drain();
      expect((await errorOf(await benefits(owner, roleId, 1))).code).toBe("not_waiting");
      expect((await versionOf(roleId, 1)).packet.compensation.benefitsSummary).toBeUndefined();
    });

    it("a version an edit has replaced: the request now waits on the new one, which takes the words", async () => {
      const { roleId, packet } = await waiting();
      const next = structuredClone(packet);
      next.identity.schedule = "Monday to Thursday";
      expect((await post(owner, `/api/v1/roles/${roleId}/packets`, { packet: next, changeSummary: "A new schedule" })).status).toBe(201);
      await container.drain();
      expect((await errorOf(await benefits(owner, roleId, 1))).code).toBe("not_waiting");
      expect((await versionOf(roleId, 1)).packet.compensation.benefitsSummary).toBeUndefined();
      expect((await benefits(owner, roleId, 2)).status).toBe(200);
    });

    it("a version that was sent back, or whose approval has not been asked for yet", async () => {
      const { roleId } = await waiting();
      const req = await request(roleId);
      expect((await post(owner, `/api/v1/approvals/${req!.id}/decide`, { decision: "reject", note: "Not yet." })).status).toBe(200);
      await container.drain();
      expect((await roleRow(roleId)).status).toBe("draft");
      expect((await errorOf(await benefits(owner, roleId, 1))).code).toBe("not_waiting");
      expect((await versionOf(roleId)).packet.compensation.benefitsSummary).toBeUndefined();
    });

    it("a version that already says, so a second press changes nothing and words are only changed through Edit", async () => {
      const { roleId } = await waiting();
      expect((await benefits(owner, roleId, 1)).status).toBe(200);
      const again = await benefits(owner, roleId, 1, "Something else entirely.");
      expect(again.status).toBe(409);
      expect(await errorOf(again)).toMatchObject({ code: "already_described", message: "This version already describes the benefits. Change them with Edit." });
      expect((await versionOf(roleId)).packet.compensation.benefitsSummary).toBe(WORDS);
      // words a person wrote in the draft count the same
      const own = await waiting(owner, "I need a bookkeeper in Irvine, fully remote, $60,000 to $70,000 a year, full time. It's growth. Ceiling $72,000. I decide. Must-haves: QuickBooks. Just draft it.");
      const row = await versionOf(own.roleId);
      const packet = structuredClone(row.packet);
      packet.compensation.benefitsSummary = "Health cover.";
      await container.db.update(rolePackets).set({ packet }).where(eq(rolePackets.id, row.id));
      expect((await errorOf(await benefits(owner, own.roleId, 1))).code).toBe("already_described");
    });

    it("a closed job, even with its request left waiting", async () => {
      const { roleId } = await waiting();
      await withPlatform(container.db, (tx) => tx.update(roles).set({ status: "closed", closedAt: new Date().toISOString(), closeReason: "role_cancelled" }).where(eq(roles.id, roleId)));
      const r = await benefits(owner, roleId, 1);
      expect(r.status).toBe(409);
      expect((await errorOf(r)).code).toBe("role_closed");
      expect((await versionOf(roleId)).packet.compensation.benefitsSummary).toBeUndefined();
    });
  });

  describe("whoever types the words may still decide", () => {
    it("a hiring manager who did not start the job: types them, Approve wakes, and they approve; there is no self-approval catch", async () => {
      const co = await newCompany("hiring-manager");
      const hana = await signInAs(container, app, { companyId: co.id, role: "hiring_manager", email: "hana@hiring-manager.test", name: "Hana Manager" });
      const { roleId } = await waiting(co.cookie);
      expect(await viewerOf(hana, roleId)).toMatchObject({ mayDecide: false, blockedBy: "legal" });
      expect((await benefits(hana, roleId, 1)).status).toBe(200);
      expect(await viewerOf(hana, roleId)).toMatchObject({ mayDecide: true, blockedBy: null });
      expect((await post(hana, `/api/v1/roles/${roleId}/approve`, { version: 1 })).status).toBe(200);
      await container.drain();
      expect((await roleRow(roleId)).status).toBe("open");
    });

    it("a second owner who did not start the job: the trap of the old way (a new version under their name) is gone", async () => {
      const co = await newCompany("two-owners");
      const olive = await signInAs(container, app, { companyId: co.id, role: "owner", email: "olive@two-owners.test", name: "Olive Owner" });
      const { roleId } = await waiting(co.cookie);
      expect((await benefits(olive, roleId, 1)).status).toBe(200);
      expect(await viewerOf(olive, roleId)).toMatchObject({ mayDecide: true, blockedBy: null });
      expect((await versionOf(roleId)).createdBy).not.toMatchObject({ name: "Olive Owner" });
      expect((await post(olive, `/api/v1/roles/${roleId}/approve`, { version: 1 })).status).toBe(200);
    });

    it("the owner who started the job can fill the blank, but the rule that someone else approves still stands, on the server too", async () => {
      const co = await newCompany("drafter");
      const olive = await signInAs(container, app, { companyId: co.id, role: "owner", email: "olive@drafter.test", name: "Olive Owner" });
      const { roleId } = await waiting(co.cookie);
      expect(await viewerOf(co.cookie, roleId)).toMatchObject({ mayDecide: false, blockedBy: "self_approval" });
      expect((await benefits(co.cookie, roleId, 1)).status).toBe(200);
      expect(await viewerOf(co.cookie, roleId)).toMatchObject({ mayDecide: false, blockedBy: "self_approval", reason: expect.stringMatching(/^You started this role/) });
      const refused = await post(co.cookie, `/api/v1/roles/${roleId}/approve`, { version: 1 });
      expect(refused.status).toBe(409);
      expect((await errorOf(refused)).code).toBe("self_approval");
      expect((await post(olive, `/api/v1/roles/${roleId}/approve`, { version: 1 })).status).toBe(200);
    });
  });

  describe("what holds Approve, for the person reading the card (viewer.blockedBy)", () => {
    const ON_SITE = "I need a bookkeeper in Irvine, $60,000 to $70,000 a year, full time, in the office. It's growth. Ceiling $72,000. I decide. Must-haves: QuickBooks. Just draft it.";
    const flag = (p: RolePacket) => {
      const flagged = structuredClone(p);
      flagged.description.publicJobDescription = `${p.description.publicJobDescription} No employment gaps.`;
      return flagged;
    };

    it("nothing: Approve is live", async () => {
      const co = await newCompany("nothing-holds");
      const { roleId } = await waiting(co.cookie, ON_SITE);
      expect(await viewerOf(co.cookie, roleId)).toEqual({ mayDecide: true, maySendBack: true, reason: null, blockedBy: null });
    });

    it("role: holds no right to approve (HR), or is off the company's narrowed list, in words a person reads", async () => {
      const co = await newCompany("role-held");
      const hr = await signInAs(container, app, { companyId: co.id, role: "hr", email: "hr@role-held.test" });
      const hana = await signInAs(container, app, { companyId: co.id, role: "hiring_manager", email: "hana@role-held.test" });
      const adam = await signInAs(container, app, { companyId: co.id, role: "admin", email: "adam@role-held.test" });
      const { roleId } = await waiting(co.cookie, ON_SITE);
      expect(await viewerOf(hr, roleId)).toEqual({ mayDecide: false, maySendBack: false, blockedBy: "role", reason: "Your role cannot approve jobs; an owner, admin or hiring manager does." });
      await withTenant(container.db, co.id, (tx) => tx.insert(policies).values({ companyId: co.id, roleId: null, actionType: "role_packet.approve", level: "approval", approverRoles: ["owner", "hiring_manager"], createdBy: { kind: "system", id: "test" } }));
      const narrowed = await waiting(co.cookie, ON_SITE);
      expect(await viewerOf(hana, narrowed.roleId)).toMatchObject({ mayDecide: true });
      expect(await viewerOf(adam, narrowed.roleId)).toEqual({ mayDecide: false, maySendBack: false, blockedBy: "role", reason: "This decision needs one of: owner, hiring manager." });
    });

    it("reserved: the decision is kept for the person named; an owner can still decide", async () => {
      const co = await newCompany("reserved");
      await signInAs(container, app, { companyId: co.id, role: "hiring_manager", email: "hank@reserved.test", name: "Hank Manager" });
      const priya = await signInAs(container, app, { companyId: co.id, role: "hiring_manager", email: "priya@reserved.test", name: "Priya Nair" });
      const { roleId } = await waiting(co.cookie, "I need a bookkeeper in Irvine, $60,000 to $70,000 a year, full time, in the office. It's growth. Ceiling $72,000. Hank Manager makes the final decision. Must-haves: QuickBooks. Just draft it.");
      expect(await viewerOf(priya, roleId)).toEqual({ mayDecide: false, maySendBack: false, blockedBy: "reserved", reason: "This decision is reserved for Hank Manager; an owner can also decide it." });
    });

    it("self_approval: they started the job or wrote the version, and are not the only owner", async () => {
      const co = await newCompany("self-held");
      await signInAs(container, app, { companyId: co.id, role: "owner", email: "olive@self-held.test" });
      const hana = await signInAs(container, app, { companyId: co.id, role: "hiring_manager", email: "hana@self-held.test" });
      const { roleId, packet } = await waiting(co.cookie, ON_SITE);
      expect(await viewerOf(co.cookie, roleId)).toMatchObject({ mayDecide: false, maySendBack: true, blockedBy: "self_approval", reason: expect.stringMatching(/^You started this role/) });
      expect((await post(hana, `/api/v1/roles/${roleId}/packets`, { packet, changeSummary: "A look over it" })).status).toBe(201);
      await container.drain();
      expect(await viewerOf(hana, roleId)).toMatchObject({ mayDecide: false, maySendBack: true, blockedBy: "self_approval", reason: expect.stringMatching(/^You wrote this version/) });
    });

    it("flags, then kept_own_flag: wording to decide on comes before the law, and whoever keeps it on a live job does not approve it", async () => {
      const co = await newCompany("flags-held");
      const hank = await signInAs(container, app, { companyId: co.id, role: "hiring_manager", email: "hank@flags-held.test" });
      const olive = await signInAs(container, app, { companyId: co.id, role: "owner", email: "olive@flags-held.test" });
      const { roleId, packet } = await waiting(co.cookie, ON_SITE);
      expect((await post(olive, `/api/v1/roles/${roleId}/approve`, { version: 1 })).status).toBe(200);
      await container.drain();
      // on a live job, flagged wording that also makes it remote: both are outstanding, and the wording is the first thing refused
      const flagged = flag(packet);
      flagged.identity.remotePolicy = "remote";
      const v2 = (await (await post(co.cookie, `/api/v1/roles/${roleId}/packets`, { packet: flagged, changeSummary: "Remote, and a gaps line" })).json()) as { version: number; packet: RolePacket };
      expect(v2.version).toBe(2);
      await container.drain();
      expect(await viewerOf(hank, roleId)).toMatchObject({ mayDecide: false, maySendBack: true, blockedBy: "flags", reason: expect.stringMatching(/needs a decision first/) });
      expect((await errorOf(await post(hank, `/api/v1/roles/${roleId}/approve`, { version: 2 }))).code).toBe("packet_flags");
      const gap = v2.packet.provenance.flags!.find((f) => !f.kept && f.rule === "employment_gaps")!;
      expect((await post(hank, `/api/v1/roles/${roleId}/packets/2/flags/keep`, { flagId: gap.id, reason: "We only mean recent hands-on practice, nothing else." })).status).toBe(200);
      // the one who kept it is held by that; the other owner, by the law, which is next
      expect(await viewerOf(hank, roleId)).toMatchObject({ mayDecide: false, maySendBack: true, blockedBy: "kept_own_flag", reason: expect.stringMatching(/^You kept wording the fairness check flagged/) });
      expect(await viewerOf(olive, roleId)).toMatchObject({ mayDecide: false, blockedBy: "legal" });
      expect((await benefits(olive, roleId, 2)).status).toBe(200);
      expect(await viewerOf(olive, roleId)).toMatchObject({ mayDecide: true, blockedBy: null });
      expect((await post(olive, `/api/v1/roles/${roleId}/approve`, { version: 2 })).status).toBe(200);
    });

    it("trial_ended: a job going live for the first time waits for a plan, and says so; a change to a job already live does not, and sending back never does", async () => {
      const co = await newCompany("trial-held", { plan: false });
      await useTrial(container, co.id);
      await roomForRoles(co.id);
      const live = await waiting(co.cookie, ON_SITE);
      expect((await post(co.cookie, `/api/v1/roles/${live.roleId}/approve`, { version: 1 })).status).toBe(200);
      await container.drain();
      const edited = structuredClone(live.packet);
      edited.identity.title = "Senior bookkeeper";
      expect(await (await post(co.cookie, `/api/v1/roles/${live.roleId}/packets`, { packet: edited, changeSummary: "A new title" })).json()).toMatchObject({ version: 2, outcome: "proposed_pending_approval" });
      const { roleId } = await waiting(co.cookie);
      await container.drain();

      // the trial's days are over
      await withPlatform(container.db, (tx) => tx.update(companies).set({ settings: sql`${companies.settings} || jsonb_build_object('trial', (${companies.settings}->'trial') || jsonb_build_object('endsAt', ${new Date(Date.now() - 86_400_000).toISOString()}::text))` }).where(eq(companies.id, co.id)));
      expect(await viewerOf(co.cookie, roleId)).toEqual({ mayDecide: false, maySendBack: true, blockedBy: "trial_ended", reason: TRIAL_ENDED_LINE });
      const refused = await post(co.cookie, `/api/v1/roles/${roleId}/approve`, { version: 1 });
      expect(refused.status).toBe(402);
      expect((await errorOf(refused)).code).toBe("trial_ended");
      // the words can still be written meanwhile: nothing goes anywhere until a plan is chosen
      expect((await benefits(co.cookie, roleId, 1)).status).toBe(200);
      expect((await viewerOf(co.cookie, roleId)).blockedBy).toBe("trial_ended");
      // a change to the job already live is not new work
      expect(await viewerOf(co.cookie, live.roleId)).toMatchObject({ mayDecide: true, blockedBy: null });
      expect((await post(co.cookie, `/api/v1/roles/${live.roleId}/approve`, { version: 2 })).status).toBe(200);
    });
  });
});
