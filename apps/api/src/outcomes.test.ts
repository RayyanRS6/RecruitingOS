import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { can, entitlements } from "@ros/core";
import { applications, auditRecords, events, hiringOutcomes, roles, users } from "@ros/db";
import type { FakeAnalyticsAdapter, FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAdmin, signInStaff, testContainerOptions } from "./test-helpers";

/**
 * Founder instruction of 21 September 2026, item 4: people record hiring outcomes; the platform generates, approves and
 * sends no offer, stores no payroll, tax, identity or banking data, and only an audited administrator action corrects a record.
 */
describe("human-recorded hiring outcomes", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "outcomes test" }, body: body ? JSON.stringify(body) : undefined });
  const email = () => container.integrations.email as FakeEmailAdapter;
  const analytics = () => container.integrations.analytics as FakeAnalyticsAdapter;

  let owner = "";
  let recruiter = "";
  let admin = "";
  let companyId = "";
  let companySlug = "";
  let roleId = "";
  const applicationIds: string[] = [];
  let outcomeId = "";

  const apply = async (first: string, last: string, mail: string) => {
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    const fd = new FormData();
    fd.set("firstName", first); fd.set("lastName", last); fd.set("email", mail); fd.set("phone", "(949) 555-0100"); fd.set("smsConsent", "no"); fd.set("locationText", "Tustin, CA");
    fd.set("resume", new File([`${first} ${last}\nBookkeeper at Coastal Books 2019 - present\nQuickBooks`], "resume.txt", { type: "text/plain" }));
    for (const rule of role.currentPacket.packet.requirements.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    expect(r.status).toBe(302);
    await container.drain();
    const rows = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    return rows.find((a) => !applicationIds.includes(a.id))!.id;
  };

  beforeAll(async () => {
    container = await createContainer(testContainerOptions({ ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", ITS_QUEUE_EMAIL: "queue@its.test" }));
    app = createApp(container);
    owner = await signIn("owner@ledger.test");
    recruiter = await signInStaff(app, container, "sam@its.test", "its_recruiter", "Sam");
    admin = await signInAdmin(app, container, "admin@its.test", "admin");
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Ledger & Co", vertical: "professional_services", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id; companySlug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a bookkeeper in Irvine, $60,000 to $70,000, in the office. It's growth. Ceiling $72,000. I decide. Must-haves: QuickBooks. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" });
    applicationIds.push(await apply("Ana", "Lopez", "ana.lopez@example.com"));
    applicationIds.push(await apply("Ben", "Ortiz", "ben.ortiz@example.com"));
    await container.db.update(users).set({ name: "Owner Olivia" }).where(eq(users.email, "owner@ledger.test"));
  });
  afterAll(async () => {
    await container.close();
  });

  it("only decision-makers record outcomes, and only with an explicit confirmation", async () => {
    expect(can("owner", "outcome.record")).toBe(true);
    expect(can("hiring_manager", "outcome.record")).toBe(true);
    expect(can("hr", "outcome.record")).toBe(true);
    expect(can("interviewer", "outcome.record")).toBe(false);
    expect(can("recruiter", "outcome.record")).toBe(false); // an ITS recruiter under a grant records nothing for the customer
    expect((await json(owner, "POST", `/api/v1/applications/${applicationIds[0]}/outcome`, { outcome: "hired_externally", hireDate: "2026-10-05" })).status).toBe(400); // no confirm
    expect((await json(owner, "POST", `/api/v1/applications/${applicationIds[0]}/outcome`, { outcome: "hired_externally", confirm: true })).status).toBe(400); // no hire date
    expect((await json(owner, "POST", `/api/v1/applications/${applicationIds[0]}/outcome`, { outcome: "employer_declined", confirm: true })).status).toBe(400); // no reason
    // fields the platform must never hold are refused outright (strict contract), not silently stored
    const r = await json(owner, "POST", `/api/v1/applications/${applicationIds[0]}/outcome`, { outcome: "hired_externally", confirm: true, hireDate: "2026-10-05", salary: 65000, ssn: "123-45-6789", bankAccount: "000111" });
    expect(r.status).toBe(400);
    expect(await container.db.select().from(hiringOutcomes)).toHaveLength(0);
  });

  it("a recorded hire moves the candidate, is audited with the actor, tells the ITS recruiter, feeds metrics without PII, and leaves the role open", async () => {
    // an ITS recruiter is working on this role
    const esc = (await (await json(owner, "POST", "/api/v1/escalations", { kind: "review", roleId, question: "Can you look at our shortlist?" })).json()) as { id: string };
    expect((await json(recruiter, "POST", `/api/v1/escalations/${esc.id}/claim`)).status).toBe(200);
    email().sent.length = 0;
    analytics().captured.length = 0;
    const r = await json(owner, "POST", `/api/v1/applications/${applicationIds[0]}/outcome`, { outcome: "hired_externally", confirm: true, hireDate: "2026-10-05", offerAcceptedAt: "2026-09-20", note: "Verbal acceptance on the phone." });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { outcomeId: string; stage: string; roleStillOpen: boolean; statement: string; next: string | null };
    outcomeId = body.outcomeId;
    expect(body.stage).toBe("hired");
    expect(body.roleStillOpen).toBe(true);
    expect(body.statement).toMatch(/outside Recruiting OS/);
    expect(body.next).toMatch(/separate confirmation/);
    const [appRow] = await container.db.select().from(applications).where(eq(applications.id, applicationIds[0]));
    expect(appRow.stage).toBe("hired");
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    expect(role.status).toBe("open");
    const [row] = await container.db.select().from(hiringOutcomes).where(eq(hiringOutcomes.id, outcomeId));
    expect(row).toMatchObject({ outcome: "hired_externally", hireDate: "2026-10-05", offerAcceptedAt: "2026-09-20", roleId, applicationId: applicationIds[0], milestone: "final" });
    expect(row.recordedBy).toMatchObject({ kind: "user", name: "Owner Olivia" });
    expect(Object.keys(row)).not.toEqual(expect.arrayContaining(["salary", "ssn", "bankAccount", "payroll", "taxId"]));
    const audits = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "outcome.recorded")));
    expect(audits).toHaveLength(1);
    expect(audits[0].actor).toMatchObject({ kind: "user", name: "Owner Olivia" });
    expect((audits[0].details as { hireDate: string }).hireDate).toBe("2026-10-05");
    const evs = await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "outcome.recorded")));
    expect(evs).toHaveLength(1);
    expect(evs[0].payload).toMatchObject({ outcome: "hired_externally", level: "application" });
    expect((await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "human.override")))).length).toBeGreaterThanOrEqual(1);
    // the assigned recruiter hears about it, by role, never by candidate name
    const toSam = email().sent.find((m) => m.to === "sam@its.test")!;
    expect(toSam).toBeTruthy();
    expect(toSam.text).toMatch(/recorded a hire/);
    expect(toSam.text).toMatch(/outside Recruiting OS/);
    expect(toSam.text).not.toContain("Ana");
    // the approved metric, keyed and without personal data
    const hire = analytics().captured.find((e) => e.name === "hire_recorded")!;
    expect(hire).toBeTruthy();
    expect(hire.properties).toEqual({ outcome: "hired_externally" });
    expect(JSON.stringify(hire)).not.toContain(applicationIds[0]);
    expect(JSON.stringify(hire)).not.toContain("Ana");
    // visible on the candidate with the statement
    const list = (await (await json(owner, "GET", `/api/v1/applications/${applicationIds[0]}/outcomes`)).json()) as { statement: string; outcomes: Array<{ id: string }> };
    expect(list.outcomes.map((o) => o.id)).toContain(outcomeId);
    expect(list.statement).toMatch(/did not generate, approve or send/);
  });

  it("the other outcomes are recorded the same way, each with the right stage", async () => {
    const r = await json(owner, "POST", `/api/v1/applications/${applicationIds[1]}/outcome`, { outcome: "offer_declined_externally", confirm: true, note: "Took another job." });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { stage: string }).stage).toBe("declined");
    // a third applicant: employer declined, with the reason required; the decline message follows the human decision as always
    const third = await apply("Cara", "Nguyen", "cara.nguyen@example.com");
    applicationIds.push(third);
    const d = await json(owner, "POST", `/api/v1/applications/${third}/outcome`, { outcome: "employer_declined", confirm: true, reason: "Chose another finalist." });
    expect(d.status).toBe(201);
    expect(((await d.json()) as { stage: string }).stage).toBe("rejected");
    const [row] = await container.db.select().from(hiringOutcomes).where(eq(hiringOutcomes.applicationId, third));
    expect((row.details as { reason: string }).reason).toBe("Chose another finalist.");
    // withdrew and no-hire
    const fourth = await apply("Dev", "Patel", "dev.patel@example.com");
    applicationIds.push(fourth);
    expect(((await (await json(owner, "POST", `/api/v1/applications/${fourth}/outcome`, { outcome: "candidate_withdrew", confirm: true })).json()) as { stage: string }).stage).toBe("withdrawn");
    const fifth = await apply("Eve", "Kim", "eve.kim@example.com");
    applicationIds.push(fifth);
    expect(((await (await json(owner, "POST", `/api/v1/applications/${fifth}/outcome`, { outcome: "no_hire", confirm: true })).json()) as { stage: string }).stage).toBe("talent_pool");
    // a closed candidate takes no second outcome; the same outcome twice is refused; a talent-pool candidate can be hired later
    expect((await json(owner, "POST", `/api/v1/applications/${fourth}/outcome`, { outcome: "hired_externally", confirm: true, hireDate: "2026-10-01" })).status).toBe(409);
    expect((await json(owner, "POST", `/api/v1/applications/${fourth}/outcome`, { outcome: "candidate_withdrew", confirm: true })).status).toBe(409);
    const rehire = await json(owner, "POST", `/api/v1/applications/${fifth}/outcome`, { outcome: "hired_externally", confirm: true, hireDate: "2026-11-02" });
    expect(rehire.status).toBe(201);
    expect(((await rehire.json()) as { stage: string }).stage).toBe("hired");
    expect((await json(owner, "POST", `/api/v1/applications/${fifth}/outcome`, { outcome: "hired_externally", confirm: true, hireDate: "2026-11-02" })).status).toBe(409);
    // the employer's decline is private like the Decline button's (founder decision B6): no decline message until a person sends it
    expect(email().sent.some((m) => m.to === "cara.nguyen@example.com" && m.subject.startsWith("Your application to"))).toBe(false);
    // an impossible date is a field error, not a server error
    const sixth = await apply("Finn", "Ola", "finn.ola@example.com");
    applicationIds.push(sixth);
    expect((await json(owner, "POST", `/api/v1/applications/${sixth}/outcome`, { outcome: "hired_externally", confirm: true, hireDate: "2026-02-31" })).status).toBe(400);
    // the old unconfirmed close is gone
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/close`, {})).status).toBe(404);
  });

  it("closing the role is a separate, confirmed decision with its own outcome; cancelled and filled-elsewhere work the same", async () => {
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/outcome`, { outcome: "filled" })).status).toBe(400);
    email().sent.length = 0;
    const r = await json(owner, "POST", `/api/v1/roles/${roleId}/outcome`, { outcome: "filled", confirm: true, reason: "Ana starts in October." });
    expect(r.status).toBe(200);
    const closedBody = (await r.json()) as { movedToTalentPool: number };
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    expect(role.status).toBe("closed");
    expect(role.closeReason).toBe("filled");
    // active candidates really are kept in the talent pool; hired and closed candidates are untouched
    expect(closedBody.movedToTalentPool).toBeGreaterThanOrEqual(1);
    const [finn] = await container.db.select().from(applications).where(eq(applications.id, applicationIds[5]));
    expect(finn.stage).toBe("talent_pool");
    expect((await container.db.select().from(applications).where(eq(applications.id, applicationIds[0])))[0].stage).toBe("hired");
    const rows = await container.db.select().from(hiringOutcomes).where(eq(hiringOutcomes.roleId, roleId));
    expect(rows.some((o) => o.milestone === "role" && o.outcome === "filled" && o.applicationId === null)).toBe(true);
    expect((await container.db.select().from(auditRecords).where(eq(auditRecords.action, "role.outcome_recorded"))).length).toBe(1);
    expect(email().sent.some((m) => m.to === "sam@its.test" && /closed the role as filled/.test(m.text))).toBe(true);
    expect(analytics().captured.some((e) => e.name === "role_outcome_recorded" && e.properties.outcome === "filled")).toBe(true);
    // closing twice is refused
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/outcome`, { outcome: "role_cancelled", confirm: true })).status).toBe(409);
    // a second role: cancelled, then a third: filled outside the platform
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need an office manager in Irvine, $55,000 to $65,000, in the office. It's growth. Ceiling $66,000. I decide. Must-haves: scheduling experience. Just draft it." })).json()) as { session: { id: string } };
    const role2 = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect(((await (await json(owner, "POST", `/api/v1/roles/${role2}/outcome`, { outcome: "role_cancelled", confirm: true, reason: "Budget pulled." })).json()) as { role: { status: string; closeReason: string } }).role).toMatchObject({ status: "closed", closeReason: "role_cancelled" });
    const s3 = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a receptionist in Irvine, $40,000 to $48,000, in the office. It's growth. Ceiling $50,000. I decide. Must-haves: front-desk experience. Just draft it." })).json()) as { session: { id: string } };
    const role3 = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s3.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect(((await (await json(owner, "POST", `/api/v1/roles/${role3}/outcome`, { outcome: "filled_outside_platform", confirm: true })).json()) as { role: { closeReason: string } }).role.closeReason).toBe("filled_outside_platform");
    // an administrator corrects the role outcome: the role's own record follows
    const [r3] = await container.db.select().from(hiringOutcomes).where(eq(hiringOutcomes.roleId, role3));
    expect((await json(admin, "POST", `/api/v1/admin/outcomes/${r3.id}/correct`, { confirm: true, reason: "It was cancelled, not filled.", outcome: "role_cancelled" })).status).toBe(200);
    expect((await container.db.select().from(roles).where(eq(roles.id, role3)))[0].closeReason).toBe("role_cancelled");
    expect(analytics().captured.some((e) => e.name === "outcome_corrected" && e.properties.outcome === "role_cancelled" && e.properties.previous === "filled_outside_platform")).toBe(true);
  });

  it("only an administrator corrects an outcome: audited, the original stays, the candidate returns to the implied stage", async () => {
    expect((await json(owner, "POST", `/api/v1/admin/outcomes/${outcomeId}/correct`, { confirm: true, reason: "typo" })).status).toBe(403);
    const list = (await (await json(admin, "GET", "/api/v1/admin/outcomes")).json()) as { outcomes: Array<{ id: string; companyName: string }> };
    expect(list.outcomes.find((o) => o.id === outcomeId)?.companyName).toBe("Ledger & Co");
    // corrections name a real outcome and a corrected hire needs its date
    expect((await json(admin, "POST", `/api/v1/admin/outcomes/${outcomeId}/correct`, { confirm: true, reason: "typo fix here", outcome: "hired" })).status).toBe(400);
    expect((await json(admin, "POST", `/api/v1/admin/outcomes/${outcomeId}/correct`, { confirm: true, reason: "role outcome on a candidate", outcome: "role_cancelled" })).status).toBe(400);
    const r = await json(admin, "POST", `/api/v1/admin/outcomes/${outcomeId}/correct`, { confirm: true, reason: "The owner picked the wrong candidate; Ana was not hired.", outcome: "no_hire" });
    expect(r.status).toBe(200);
    expect(analytics().captured.some((e) => e.name === "outcome_corrected" && e.properties.outcome === "no_hire" && e.properties.previous === "hired_externally")).toBe(true);
    const { correctionId } = (await r.json()) as { correctionId: string };
    const [original] = await container.db.select().from(hiringOutcomes).where(eq(hiringOutcomes.id, outcomeId));
    expect(original.correctedAt).toBeTruthy();
    expect(original.correctionReason).toMatch(/wrong candidate/);
    expect(original.correctedBy).toMatchObject({ kind: "user", name: "admin" });
    expect(original.outcome).toBe("hired_externally"); // the original fact is kept
    const [correction] = await container.db.select().from(hiringOutcomes).where(eq(hiringOutcomes.id, correctionId));
    expect(correction).toMatchObject({ correctionOf: outcomeId, outcome: "no_hire", applicationId: applicationIds[0] });
    const [appRow] = await container.db.select().from(applications).where(eq(applications.id, applicationIds[0]));
    expect(appRow.stage).toBe("talent_pool");
    expect((await container.db.select().from(auditRecords).where(eq(auditRecords.action, "outcome.corrected"))).length).toBe(2); // the role correction above and this one
    // correcting the corrected record again is refused; the newest record is the one to correct
    expect((await json(admin, "POST", `/api/v1/admin/outcomes/${outcomeId}/correct`, { confirm: true, reason: "again please" })).status).toBe(409);
    // nothing was deleted
    expect((await container.db.select().from(hiringOutcomes)).length).toBeGreaterThanOrEqual(8);
  });
});
