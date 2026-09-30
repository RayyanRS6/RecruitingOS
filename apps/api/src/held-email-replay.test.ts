import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { applications, candidates, inboundEmails, notifications, postings, roles } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * Emailed applications held while a role is not taking applications (C19) keep the notice's promise that they will be
 * added on their own: when the owner turns the accepting switch back on through the route, and when the owner closes
 * a paused role instead of reopening it (they then join the talent pool with the role's other candidates in process,
 * never acknowledged as if the role were still hiring). Nothing is ever left "held" for good.
 */
describe("held email applications: added when the switch reopens, kept when the role closes", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let roleId = "";
  let roleTitle = "";
  let intakeToken = "";
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body ? JSON.stringify(body) : undefined });
  const emails = () => (container.integrations.email as FakeEmailAdapter).sent;
  const inbound = (name: string, resumeText?: string) => app.request("/webhooks/postmark/inbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ From: "noreply@indeed.com", FromName: "Indeed", To: `apply-${intakeToken}@${container.integrations.env.intakeDomain}`, Subject: `New applicant: ${name}`, TextBody: `${name} applied via Indeed.\nEmail: ${name.toLowerCase().replace(" ", ".")}@example.com`, Attachments: resumeText ? [{ Name: "resume.txt", ContentType: "text/plain", Content: Buffer.from(resumeText).toString("base64"), ContentLength: resumeText.length }] : [] }),
  });
  const inboundRow = async (name: string) => (await container.db.select().from(inboundEmails).where(eq(inboundEmails.subject, `New applicant: ${name}`)))[0];
  const heldNotice = async () => (await container.db.select().from(notifications).where(eq(notifications.kind, "application.email_held"))).at(-1);

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@heldmail.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    expect((await json("POST", "/api/v1/companies", { name: "Held Mail Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).ok).toBe(true);
    const s = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json("POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    roleTitle = (await container.db.select({ title: roles.title }).from(roles).where(eq(roles.id, roleId)))[0].title;
    const [emailIn] = await container.db.select().from(postings).where(and(eq(postings.roleId, roleId), eq(postings.channel, "email_in")));
    intakeToken = emailIn.intakeToken!;
  });
  afterAll(async () => {
    await container.close();
  });

  it("an email held while the switch is off becomes an application when the owner turns the switch back on through the route", async () => {
    expect((await json("POST", `/api/v1/roles/${roleId}/applications/accepting`, { accepting: false, reason: "Enough for now" })).status).toBe(200);
    expect(await (await inbound("Held Switch")).json()).toMatchObject({ ok: true, matched: true, held: true });
    expect((await inboundRow("Held Switch")).status).toBe("held");
    const fromEmail = async () => (await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.source, "email_in")))).length;
    const before = await fromEmail();
    expect((await heldNotice())?.body).toContain("added to the role's applications on its own");

    const reopened = await json("POST", `/api/v1/roles/${roleId}/applications/accepting`, { accepting: true });
    expect(reopened.status).toBe(200);
    await container.drain();
    const row = await inboundRow("Held Switch");
    expect(row.status).toBe("matched");
    expect(row.applicationId).toBeTruthy();
    expect(await fromEmail()).toBe(before + 1);
    const [created] = await container.db.select().from(applications).where(eq(applications.id, row.applicationId!));
    expect(created).toMatchObject({ roleId, source: "email_in" });
    expect((await container.db.select().from(candidates).where(eq(candidates.id, created.candidateId)))[0].email).toBe("held.switch@example.com");
    const notice = await heldNotice();
    expect(notice?.title).toBe(`A held email application was added to ${roleTitle}`);
    expect(notice?.body).not.toContain("@example.com");
    expect((await container.db.select().from(inboundEmails).where(eq(inboundEmails.status, "held"))).length).toBe(0);
  });

  it("an email held while the role is paused is not dropped when the role is closed instead: it joins the talent pool, unacknowledged, and the team is told", async () => {
    expect((await json("POST", `/api/v1/roles/${roleId}/pause`, {})).status).toBe(200);
    expect(await (await inbound("Held Closing", "Held Closing, registered dental hygienist since 2018, active CA RDH license.")).json()).toMatchObject({ ok: true, matched: true, held: true });
    const held = await inboundRow("Held Closing");
    expect(held.status).toBe("held");
    expect(held.rawStorageKey).toBeTruthy();

    const closed = await json("POST", `/api/v1/roles/${roleId}/outcome`, { outcome: "no_hire", confirm: true });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ heldEmailsAddedToTalentPool: 1 });
    await container.drain();
    // never left held: matched to an application in the talent pool, the parked résumé travelled with it and left storage
    const row = await inboundRow("Held Closing");
    expect(row.status).toBe("matched");
    expect(row.rawStorageKey).toBeNull();
    const [admitted] = await container.db.select().from(applications).where(eq(applications.id, row.applicationId!));
    expect(admitted).toMatchObject({ roleId, source: "email_in", stage: "talent_pool" });
    expect(admitted.resumeDocumentId).toBeTruthy();
    expect((await container.db.select().from(candidates).where(eq(candidates.id, admitted.candidateId)))[0].email).toBe("held.closing@example.com");
    expect(await container.integrations.storage.list("inbound/")).toEqual([]);
    expect((await container.db.select().from(inboundEmails).where(eq(inboundEmails.status, "held"))).length).toBe(0);
    // the role is closed, so nobody is told their application is being reviewed
    expect(emails().filter((m) => m.to === "held.closing@example.com")).toHaveLength(0);
    // the team's notice says what became of it, without the sender's address
    const notice = await heldNotice();
    expect(notice?.title).toBe(`A held email application for ${roleTitle} is in your talent pool`);
    expect(notice?.body).toContain("moved to your talent pool");
    expect(notice?.body).toContain("Nobody was sent a message");
    expect(notice?.body).not.toContain("@example.com");
  });
});
