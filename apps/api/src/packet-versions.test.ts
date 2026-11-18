import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { RolePacket, type Actor } from "@ros/contracts";
import { entitlements } from "@ros/core";
import { events, memberships, notifications, rolePackets, roles, users, withTenant } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { HttpError } from "./middleware/errors";
import type { Tenant } from "./middleware/session";
import { createPacketVersion } from "./services/packet-versions";
import { signInAs } from "./test-helpers";

/**
 * Saving a new version of a job (services/packet-versions.ts). Every save is a new version and nothing is overwritten:
 * on an open or paused job it is live at once, on a draft it waits for the job to be published, and a closed job takes
 * none. Nobody approves a version.
 */
describe("a new version of a job", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerId = "";
  let companyId = "";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

  const packet = (change: (p: RolePacket) => void = () => {}): RolePacket => {
    const p = RolePacket.parse({
      identity: { title: "Dental Assistant", locations: [{ city: "Irvine", region: "CA", country: "US" }], employmentType: "full_time", schedule: "Monday to Friday, 8 to 5", remotePolicy: "onsite" },
      compensation: { basis: "hourly", currency: "USD", min: 24, max: 28, discloseRange: true },
      description: { publicJobDescription: "Harbor Dental is hiring a dental assistant in Irvine. You will seat patients, take digital x-rays and keep the operatories ready." },
      requirements: { mustHaves: [{ key: "mh_xray", text: "Radiography certificate" }], niceToHaves: [] },
      competencies: [{ key: "chairside", name: "Chairside skill", definition: "Anticipates the dentist's next step.", importance: "essential", indicators: [] }],
      screening: { questions: [{ key: "recent", question: "Tell me about your most recent dental assisting work." }, { key: "nervous", question: "Tell me about a nervous patient and what you did." }, { key: "available", question: "Which days and hours are you available?" }] },
      communication: { tone: "warm", companyBlurb: "A family practice in Irvine.", signature: "The team at Harbor Dental", disclosureText: "This message was sent with help from an AI assistant.", humanAlternativeText: "Reply to reach a person." },
      compliance: {},
      provenance: {},
    });
    change(p);
    return p;
  };
  /** A job with one version, in the given status, started by the owner. */
  const job = (status: "draft" | "open" | "paused" | "closed") =>
    withTenant(container.db, companyId, async (tx) => {
      const actor: Actor = { kind: "user", id: ownerId, name: "Dana Owner" };
      const live = status !== "draft";
      const [role] = await tx.insert(roles).values({ companyId, title: "Dental Assistant", status, createdBy: actor, ...(live ? { openedAt: new Date().toISOString(), currentPacketVersion: 1 } : {}) }).returning();
      await tx.insert(rolePackets).values({ companyId, roleId: role.id, version: 1, packet: packet(), status: live ? "approved" : "proposed", source: "human_edit", createdBy: actor });
      return role.id;
    });
  /** Saves a version as a member of the team would through the editor. */
  const save = async (who: { userId: string; role: Tenant["role"]; name: string }, roleId: string, next: RolePacket) =>
    withTenant(container.db, companyId, async (tx) => {
      const [role] = await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1);
      return createPacketVersion(tx, container, { tenant: { companyId, userId: who.userId, role: who.role } as Tenant, actor: { kind: "user", id: who.userId, name: who.name }, role, packet: next, changeSummary: "Changed the schedule" });
    });
  const versionsOf = (roleId: string) => container.db.select().from(rolePackets).where(eq(rolePackets.roleId, roleId)).orderBy(rolePackets.version);
  const roleOf = async (roleId: string) => (await container.db.select().from(roles).where(eq(roles.id, roleId)))[0];
  const dana = () => ({ userId: ownerId, role: "owner" as const, name: "Dana Owner" });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake",WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dana@versions.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Harbor Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    ownerId = ((await (await json(owner, "GET", "/api/v1/auth/me")).json()) as { user: { id: string } }).user.id;
    await entitlements.applyPlan(container.db, companyId, "growth");
  });
  afterAll(async () => {
    await container.close();
  });

  it("is live at once on an open job: the earlier version is superseded and nothing waits for anyone", async () => {
    const roleId = await job("open");
    const made = await save(dana(), roleId, packet((p) => { p.identity.title = "Lead Dental Assistant"; p.identity.schedule = "Monday to Thursday, 7 to 5"; }));
    expect(made.outcome).toBe("live");
    expect(made.paused).toBeUndefined();
    expect(made.version).toMatchObject({ version: 2, status: "approved", approvedBy: ownerId });
    expect((await versionsOf(roleId)).map((v) => [v.version, v.status])).toEqual([[1, "superseded"], [2, "approved"]]);
    expect(await roleOf(roleId)).toMatchObject({ status: "open", currentPacketVersion: 2, title: "Lead Dental Assistant" });
    const types = (await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.subjectId, `${roleId}:2`)))).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["role_packet.edited", "role_packet.approved"]));
  });

  it("is the current version of a paused job, shown when it resumes", async () => {
    const roleId = await job("paused");
    const made = await save(dana(), roleId, packet((p) => { p.identity.schedule = "Weekends"; }));
    expect(made).toMatchObject({ outcome: "live", paused: true });
    expect(await roleOf(roleId)).toMatchObject({ status: "paused", currentPacketVersion: 2 });
  });

  it("is refused on an open job while it carries flagged wording nobody dealt with, and nothing is saved", async () => {
    const roleId = await job("open");
    const flagged = packet((p) => { p.description.publicJobDescription = "Harbor Dental is hiring a dental assistant in Irvine to join our young and energetic team of digital natives."; });
    const refused = await save(dana(), roleId, flagged).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpError);
    expect(refused).toMatchObject({ status: 422, code: "packet_flags" });
    expect((refused as HttpError).details).toMatchObject({ flags: [expect.objectContaining({ path: "description.publicJobDescription" })] });
    expect((await versionsOf(roleId)).map((v) => v.version)).toEqual([1]);
    expect((await roleOf(roleId)).currentPacketVersion).toBe(1);
  });

  it("is saved on a draft, flagged wording and all, and goes live only when the job is published", async () => {
    const roleId = await job("draft");
    const made = await save(dana(), roleId, packet((p) => { p.identity.title = "Dental Assistant (bilingual)"; p.description.publicJobDescription = "Harbor Dental is hiring a dental assistant in Irvine to join our young and energetic team of digital natives."; }));
    expect(made.outcome).toBe("saved");
    expect(made.version).toMatchObject({ version: 2, status: "proposed", approvedBy: null });
    expect(await roleOf(roleId)).toMatchObject({ status: "draft", currentPacketVersion: null, title: "Dental Assistant (bilingual)" });
    // the open flag holds publishing until a person rewords it or keeps it with a reason
    const publish = await json(owner, "POST", `/api/v1/roles/${roleId}/publish`);
    expect(publish.status).toBe(409);
    expect(((await publish.json()) as { error: { details: { blockers: Array<{ code: string }> } } }).error.details.blockers.map((b) => b.code)).toEqual(["open_flags"]);
  });

  it("is refused on a closed job, in plain words", async () => {
    const roleId = await job("closed");
    const refused = await save(dana(), roleId, packet()).then(() => null, (e: unknown) => e);
    expect(refused).toMatchObject({ status: 409, code: "role_closed", message: "This job is closed, so it is not changed any more. Start a new job to hire again." });
    expect((await versionsOf(roleId)).map((v) => v.version)).toEqual([1]);
  });

  it("tells the person who started the job when a teammate's change went live, and nobody when they changed it themselves", async () => {
    const roleId = await job("open");
    const mine = async () => (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "role.edited_live")))).filter((n) => n.action?.href === `/roles/${roleId}`);
    await save(dana(), roleId, packet((p) => { p.identity.schedule = "Monday to Thursday"; }));
    expect(await mine()).toEqual([]);
    await signInAs(container, app, { companyId, role: "hiring_manager", email: "mo@versions.test", name: "Mo Manager" });
    const [mo] = await container.db.select({ id: users.id }).from(users).innerJoin(memberships, eq(memberships.userId, users.id)).where(and(eq(users.email, "mo@versions.test"), eq(memberships.companyId, companyId)));
    await save({ userId: mo.id, role: "hiring_manager", name: "Mo Manager" }, roleId, packet((p) => { p.identity.schedule = "Monday to Friday, 9 to 6"; }));
    const told = await mine();
    expect(told.map((n) => n.userId)).toEqual([ownerId]);
    expect(told[0]).toMatchObject({ title: "Dental Assistant: version 3 is live" });
    expect(told[0].body).toContain("Mo Manager changed the job: Changed the schedule. It is live now.");
  });
});
