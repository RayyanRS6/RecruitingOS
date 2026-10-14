import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { redactText } from "@ros/contracts";
import { createDataRequest, entitlements, fulfilCorrectionRequest } from "@ros/core";
import { aiRuns, applications, assessments, candidates, communications, dataRequests, inboundEmails, notifications, postings, roles, screens, unconfirmedScreens, withPlatform, withTenant, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { applyFormProblem, statusDay } from "./pages/candidate";
import { consentOf, createApplication, emailStatusLinks, insertCandidateOnce } from "./services/applications";
import { findConversation } from "./services/apply-conversation";
import { signInAdmin, statusTokenFor, useOneVisitApplyFlow } from "./test-helpers";

/**
 * Wave S5, slice C3 (candidates and applications), known-bugs rows 16, 17, 48, 68, 71, 72, 73, 74, 78, 80 and 120: what a
 * stranger typing someone's address can see and change, the consent an emailed-in applicant really gave, a new private
 * link, a withdrawal in the screening chat, re-keying a corrected address, one address-matching rule, the form's error
 * line, the status page's dates, log redaction of the confirm link, and failed email applications in the console.
 */
describe("candidates and applications (Wave S5, C3)", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let admin = "";
  let companyId = "";
  let slug = "";
  let roleA = "";
  let roleB = "";
  const elig: Record<string, Array<{ key: string }>> = {};
  const env = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", JOBS_BASE_URL: "https://jobs.example.test" };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "c3 test" }, body: body ? JSON.stringify(body) : undefined });
  const mail = () => (container.integrations.email as FakeEmailAdapter).sent;
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    return (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
  };
  const newRole = async (message: string) => {
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: message })).json()) as { session: { id: string } };
    const roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    elig[roleId] = role.currentPacket.packet.requirements.eligibility;
    return roleId;
  };
  const applyForm = (roleId: string, p: { first: string; email: string; phone?: string }) => {
    const fd = new FormData();
    fd.set("firstName", p.first); fd.set("lastName", "Lind"); fd.set("email", p.email); fd.set("phone", p.phone ?? ""); fd.set("locationText", "Tustin, CA");
    fd.set("resume", new File([`${p.first} Lind, registered dental hygienist, active CA RDH license.`], "resume.txt", { type: "text/plain" }));
    for (const rule of elig[roleId]) fd.set(`elig_${rule.key}`, "yes");
    fd.set("acknowledged", "yes");
    return app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
  };
  const form = (path: string, fields: Record<string, string>) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const appByToken = async (token: string) => (await container.db.select().from(applications).where(eq(applications.statusToken, token)))[0];

  beforeAll(async () => {
    container = await createContainer({ memory: true, env });
    app = createApp(container);
    owner = await signIn("owner@c3.test");
    admin = await signInAdmin(app, container, "admin@its.test", "admin");
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Lind Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    slug = co.slug;
    await entitlements.applyPlan(container.db, co.id, "growth");
    await useOneVisitApplyFlow(container, co.id);
    roleA = await newRole("I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.");
    roleB = await newRole("I need a dental assistant in Irvine, $25 to $30 an hour, full time. It's growth. Ceiling $32. I decide. Must-haves: radiography certificate. Just draft it.");
  });
  afterAll(async () => { await container.close(); });

  it("row 17: a first application to another role from a known address gets the neutral, detached conversation; nothing joins the real record unconfirmed", async () => {
    const first = await applyForm(roleA, { first: "Rosa", email: "rosa.lind@gmail.com" });
    expect(first.status).toBe(302);
    await container.drain();
    const rosa = (await container.db.select().from(candidates).where(and(eq(candidates.companyId, companyId), eq(candidates.email, "rosa.lind@gmail.com"))))[0];
    const stranger = await applyForm(roleB, { first: "Mallory", email: "RosaLind+x@gmail.com" });
    expect(stranger.status).toBe(302);
    const to = stranger.headers.get("location")!;
    expect(to).toMatch(/^\/c\/screen\//);
    const ref = (await findConversation(container.db, to.split("/").at(-1)!))!;
    expect(ref.kind).toBe("detached");
    const page = await (await app.request(to, { headers: { cookie: stranger.headers.get("set-cookie")?.split(";")[0] ?? "" } })).text();
    expect(page).toContain("Mallory");
    expect(page).not.toContain("Rosa");
    // the new application is Rosa's (the form path's rule), but no conversation of hers was started from this visit
    const [newApp] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleB), eq(applications.candidateId, rosa.id)));
    expect(newApp).toBeTruthy();
    expect(await container.db.select().from(screens).where(and(eq(screens.applicationId, newApp.id), eq(screens.invitedVia, "apply")))).toHaveLength(0);
    expect((await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, ref.id)))[0]).toMatchObject({ applicationId: newApp.id, firstName: "Mallory" });
    // the person on file keeps their own name and details
    expect((await container.db.select().from(candidates).where(eq(candidates.id, rosa.id)))[0].firstName).toBe("Rosa");
    // the acknowledgment to the address on file says it was sent using their address (Wave S5 review); her own first one did not
    await container.drain();
    const acks = mail().filter((m) => m.to === "rosa.lind@gmail.com" && /^We received your application/.test(m.subject));
    expect(acks.length).toBeGreaterThanOrEqual(2);
    expect(acks[0]!.text).not.toContain("sent using your email address");
    expect(acks.at(-1)!.text).toContain("This application was sent using your email address. If you did not send it, reply to this email and a person will look into it.");
  });

  it("row 78: a person added at the same moment by another submission is read again instead of failing on the unique key", async () => {
    const out = await withTenant(container.db, companyId, async (tx) => {
      const values = { companyId, firstName: "Twin", lastName: "One", email: "twin@example.com", phone: null, dedupeKey: "email:twin@example.com", firstSource: "careers_page", consent: {} };
      const a = await insertCandidateOnce(tx, values);
      const b = await insertCandidateOnce(tx, { ...values, firstName: "Twin", lastName: "Two" });
      return { a, b };
    });
    expect(out.a.inserted).toBe(true);
    expect(out.b.inserted).toBe(false);
    expect(out.b.candidate.id).toBe(out.a.candidate.id);
    expect(out.b.candidate.lastName).toBe("One");
  });

  it("row 16: an emailed-in applicant is not recorded as having seen the terms or the AI notice", () => {
    const now = "2026-10-15T10:00:00.000Z";
    const emailed = consentOf({ consentSource: "email_in", noticeVersionsShown: [], smsConsent: false, acknowledgment: null }, now);
    expect(emailed.application_terms).toBeUndefined();
    expect(emailed.ai_notice).toBeUndefined();
    expect(emailed.notices_by_email).toMatchObject({ granted: false, source: "email_in", noticeVersion: "acknowledgment_email" });
    const formed = consentOf({ consentSource: "careers_page_apply", noticeVersionsShown: ["ai_use@1", "privacy@1"], smsConsent: false, acknowledgment: { at: now, noticeVersions: [] }, ip: "203.0.113.9" }, now);
    expect(formed.application_terms).toMatchObject({ granted: true, acknowledged: true, ip: "203.0.113.9" });
    expect(formed.ai_notice).toMatchObject({ granted: true, noticeVersion: "ai_use@1,privacy@1" });
  });

  it("row 48: Get a new link replaces the private link, the old one stops working, and the new one goes only by email", async () => {
    await applyForm(roleA, { first: "Nina", email: "nina.lind@example.com" });
    await container.drain();
    const old = await statusTokenFor(container, { roleId: roleA, email: "nina.lind@example.com" });
    const page = await (await app.request(`/c/status/${old}`)).text();
    expect(page).toContain(`action="/c/status/${old}/new-link"`);
    expect(page).toContain("Get a new link");
    // the open screening chat the old page linked to (Wave S5 review): its link changes with the status link
    const ninaApp = await appByToken(old);
    const chatsBefore = await container.db.select({ id: screens.id, token: screens.token, status: screens.status }).from(screens).where(eq(screens.applicationId, ninaApp.id));
    const res = await form(`/c/status/${old}/new-link`, {});
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Your new link is on its way");
    expect(html).toContain("n***@example.com");
    const fresh = await statusTokenFor(container, { roleId: roleA, email: "nina.lind@example.com" });
    expect(fresh).not.toBe(old);
    expect(html).not.toContain(fresh);
    expect((await app.request(`/c/status/${old}`)).status).toBe(404);
    expect((await app.request(`/c/status/${fresh}`)).status).toBe(200);
    await container.drain();
    const sent = mail().filter((m) => m.to === "nina.lind@example.com" && /new application link/.test(m.subject));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`/c/status/${fresh}`);
    expect(sent[0].text).not.toContain(old);
    for (const chat of chatsBefore.filter((s) => ["invited", "reminded", "in_progress", "paused"].includes(s.status))) {
      const [now] = await container.db.select({ token: screens.token }).from(screens).where(eq(screens.id, chat.id));
      expect(now.token).not.toBe(chat.token);
      expect(await (await app.request(`/c/screen/${chat.token}`)).text()).not.toContain("Nina");
    }
  });

  it("row 74: withdrawing in the screening chat is recorded as a request and confirmed by email, like the status page", async () => {
    const res = await applyForm(roleA, { first: "Wren", email: "wren.lind@example.com" });
    const to = res.headers.get("location")!;
    expect(to).toMatch(/^\/c\/screen\//);
    expect((await form(`${to}/start`, {})).status).toBe(302);
    expect((await form(to, { message: "WITHDRAW" })).status).toBe(302);
    expect((await form(`${to}/withdraw`, { confirm: "yes" })).status).toBe(302);
    await container.drain();
    const token = await statusTokenFor(container, { roleId: roleA, email: "wren.lind@example.com" });
    const wren = await appByToken(token);
    expect(wren.stage).toBe("withdrawn");
    const reqs = await withPlatform(container.db, (tx) => tx.select().from(dataRequests).where(eq(dataRequests.applicationId, wren.id)));
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ kind: "withdrawal", status: "fulfilled", details: "Withdrawn in the screening chat." });
    expect(reqs[0].confirmationSentAt).toBeTruthy();
    expect(await container.db.select().from(communications).where(eq(communications.idempotencyKey, `privacy_done:${reqs[0].id}`))).toHaveLength(1);
  });

  it("rows 71 and 68: a corrected address re-keys the record, and Lost your link? and the privacy form find people by the same rule", async () => {
    await applyForm(roleA, { first: "Cora", email: "cora.old@example.com" });
    await container.drain();
    const [cora] = await container.db.select().from(candidates).where(eq(candidates.email, "cora.old@example.com"));
    const fixed = await withPlatform(container.db, async (tx) => {
      const row = await createDataRequest(tx, { companyId, kind: "correct", requesterEmail: "cora.old@example.com", candidateId: cora.id, channel: "admin", verified: true, actor: { kind: "system", id: "test" } });
      return fulfilCorrectionRequest(tx, row, { field: "email", value: "Cora.New@Example.com", resolution: "fixed", actor: { kind: "system", id: "test" } });
    });
    expect(fixed.status).toBe("fulfilled");
    const after = (await container.db.select().from(candidates).where(eq(candidates.id, cora.id)))[0];
    expect(after.email).toBe("cora.new@example.com");
    expect(after.dedupeKey).toBe("email:cora.new@example.com");
    const deps = { db: container.db, integrations: container.integrations, jobsBaseUrl: "https://jobs.example.test" };
    expect(await emailStatusLinks(deps, "cora.new@example.com", new Date())).toBe(1);
    // a correction to an address another record already holds keeps the key, says so, and merges nothing
    const [rosa] = await container.db.select().from(candidates).where(eq(candidates.email, "rosa.lind@gmail.com"));
    const clash = await withPlatform(container.db, async (tx) => {
      const row = await createDataRequest(tx, { companyId, kind: "correct", requesterEmail: "cora.new@example.com", candidateId: cora.id, channel: "admin", verified: true, actor: { kind: "system", id: "test" } });
      return fulfilCorrectionRequest(tx, row, { field: "email", value: "rosa.lind@gmail.com", resolution: "fixed", actor: { kind: "system", id: "test" } });
    });
    expect(clash.notes.map((n) => n.text).join(" ")).toContain("were not merged");
    expect((await container.db.select().from(candidates).where(eq(candidates.id, cora.id)))[0].dedupeKey).toBe("email:cora.new@example.com");
    expect(rosa.dedupeKey).toBe("email:rosalind@gmail.com");
    // the privacy form folds a Gmail address the same way and writes to the address on file
    const before = mail().length;
    const sentPage = await form("/c/privacy-request", { email: "RosaLind@gmail.com", kind: "access" });
    expect(sentPage.status).toBe(200);
    const confirm = mail().slice(before).filter((m) => /^Confirm your request/.test(m.subject));
    expect(confirm.map((m) => m.to)).toEqual(["rosa.lind@gmail.com"]);
  });

  it("row 72: the form's error line names the fields that are highlighted", async () => {
    expect(applyFormProblem(["phone"])).toBe("Please check the highlighted field: a phone number of at least 7 digits, or leave it empty.");
    expect(applyFormProblem(["firstName", "email"])).toBe("Please check the highlighted fields: your first name and a valid email address.");
    const res = await applyForm(roleA, { first: "Pia", email: "pia.lind@example.com", phone: "123" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("a phone number of at least 7 digits");
    expect(html).not.toContain("a first name, last name, a valid email");
  });

  it("row 73: status-page dates are the company's days", () => {
    expect(statusDay("2026-10-15T03:00:00.000Z", "America/Los_Angeles")).toBe("Oct 14, 2026");
    expect(statusDay("2026-10-15T03:00:00.000Z", "America/New_York")).toBe("Oct 14, 2026");
    expect(statusDay("2026-10-15T05:00:00.000Z", "America/New_York")).toBe("Oct 15, 2026");
  });

  it("row 80: the repeat-confirmation link's token never reaches a request log", () => {
    const line = "<-- POST /c/confirm-answers/AbCdEfGhIjKlMnOpQrStUvWxYz012345 302";
    const out = redactText(line);
    expect(out).toContain("/c/confirm-answers/[redacted]");
    expect(out).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz012345");
  });

  it("rows 120 and 16: a failed email application is kept with its résumé, listed in the console, and tried again from there", async () => {
    const [posting] = await container.db.select().from(postings).where(and(eq(postings.roleId, roleB), eq(postings.channel, "email_in")));
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleB));
    // break the role for a moment so the import fails the way an unexpected error would
    await withPlatform(container.db, (tx) => tx.update(roles).set({ currentPacketVersion: null }).where(eq(roles.id, roleB)));
    const resume = "Ezra Lind, dental assistant, radiography certificate.";
    const res = await app.request("/webhooks/postmark/inbound", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ From: "noreply@indeed.com", FromName: "Indeed", To: `apply-${posting.intakeToken}@${container.integrations.env.intakeDomain}`, Subject: "New applicant: Ezra Lind", TextBody: "Ezra Lind applied via Indeed.\nEmail: ezra.lind@example.com", Attachments: [{ Name: "resume.txt", ContentType: "text/plain", Content: Buffer.from(resume).toString("base64"), ContentLength: resume.length }] }),
    });
    expect(res.status).toBe(202);
    const [failed] = await container.db.select().from(inboundEmails).where(eq(inboundEmails.subject, "New applicant: Ezra Lind"));
    expect(failed.status).toBe("error");
    expect(failed.rawStorageKey).toBeTruthy();
    await withPlatform(container.db, (tx) => tx.update(roles).set({ currentPacketVersion: role.currentPacketVersion }).where(eq(roles.id, roleB)));

    const list = (await (await json(admin, "GET", "/api/v1/admin/failed-email-applications")).json()) as Array<{ id: string; roleTitle: string | null; from: string | null; hasResume: boolean; canRetry: boolean; text: string }>;
    const row = list.find((r) => r.id === failed.id)!;
    expect(row).toMatchObject({ roleTitle: role.title, from: "noreply@indeed.com", hasResume: true, canRetry: true });
    expect(row.text).toContain("Ezra Lind applied via Indeed.");
    // only platform administrators see the list
    expect((await json(owner, "GET", "/api/v1/admin/failed-email-applications")).status).toBe(403);

    // an id that is not one is a plain "not found", never a database error
    expect((await json(admin, "POST", "/api/v1/admin/failed-email-applications/not-an-id/retry", {})).status).toBe(404);
    // two presses at the same moment: the row is claimed by one, the other finds nothing waiting (Wave S5 review)
    const presses = await Promise.all([json(admin, "POST", `/api/v1/admin/failed-email-applications/${failed.id}/retry`, {}), json(admin, "POST", `/api/v1/admin/failed-email-applications/${failed.id}/retry`, {})]);
    expect(presses.map((p) => p.status).sort()).toEqual([200, 409]);
    const retried = presses.find((p) => p.status === 200)!;
    const out = (await retried.json()) as { ok: boolean; applicationId: string };
    const [done] = await container.db.select().from(inboundEmails).where(eq(inboundEmails.id, failed.id));
    expect(done).toMatchObject({ status: "matched", applicationId: out.applicationId, rawStorageKey: null });
    expect(await container.integrations.storage.get(failed.rawStorageKey!)).toBeNull();
    const [created] = await container.db.select().from(applications).where(eq(applications.id, out.applicationId));
    expect(created.source).toBe("email_in");
    const [ezra] = await container.db.select().from(candidates).where(eq(candidates.id, created.candidateId));
    expect(ezra.consent.ai_notice).toBeUndefined();
    expect(ezra.consent.application_terms).toBeUndefined();
    expect(ezra.consent.notices_by_email?.granted).toBe(false);
    // a second press finds nothing waiting
    expect((await json(admin, "POST", `/api/v1/admin/failed-email-applications/${failed.id}/retry`, {})).status).toBe(409);
    expect(((await (await json(admin, "GET", "/api/v1/admin/failed-email-applications")).json()) as Array<{ id: string }>).some((r) => r.id === failed.id)).toBe(false);
  });

  it("row 16: createApplication by email records no form consent", async () => {
    const created = await withTenant(container.db, companyId, (tx) => createApplication(tx, container, { companyId, roleId: roleA, source: "email_in", firstName: "Iris", lastName: "Lind", email: "iris.lind@example.com", phone: null, smsConsent: false, consentSource: "email_in", noticeVersionsShown: [], eligibilityAnswers: {}, noResumeAnswers: { summary: "Hygienist." } }, { kind: "system", id: "email_in" }));
    expect(created.knownPerson).toBe(false);
    expect(Object.keys(created.candidate.consent)).toEqual(["notices_by_email"]);
  });

  it("row 16: no AI reads an emailed-in application before its AI notice email has gone; one whose email never goes is not read by AI (Wave S5 review)", async () => {
    const byEmail = (first: string, email: string) => withTenant(container.db, companyId, (tx) => createApplication(tx, container, { companyId, roleId: roleA, source: "email_in", firstName: first, lastName: "Lind", email, phone: null, smsConsent: false, consentSource: "email_in", noticeVersionsShown: [], eligibilityAnswers: Object.fromEntries(elig[roleA].map((r) => [r.key, "yes"])), noResumeAnswers: { summary: "Registered dental hygienist, eight years of perio work." } }, { kind: "system", id: "email_in" }));
    const runOf = async (applicationId: string) => (await container.db.select().from(workflowRuns).where(eq(workflowRuns.idempotencyKey, `application_intake:${applicationId}`)))[0]!;
    const aiRunsOf = async (runId: string) => container.db.select({ id: aiRuns.id }).from(aiRuns).where(eq(aiRuns.workflowRunId, runId));
    const ackOf = async (applicationId: string) => (await container.db.select().from(communications).where(eq(communications.idempotencyKey, `ack:${applicationId}`)))[0];

    // the email cannot go (the address is on the do-not-send list): nothing is read by AI, and the team is asked to read it
    const { suppressAddress } = await import("@ros/core");
    await suppressAddress(container.db, { address: "juno.lind@example.com", reason: "hard_bounce", source: "admin", actor: { kind: "system", id: "test" } });
    const juno = await byEmail("Juno", "juno.lind@example.com");
    await container.drain();
    expect((await ackOf(juno.application.id))?.status).toBe("failed");
    const junoRun = await runOf(juno.application.id);
    expect(await aiRunsOf(junoRun.id)).toEqual([]);
    expect(await container.db.select().from(assessments).where(eq(assessments.applicationId, juno.application.id))).toEqual([]);
    expect((await container.db.select().from(applications).where(eq(applications.id, juno.application.id)))[0].stage).toBe("triaged");
    expect((await container.db.select().from(notifications).where(eq(notifications.companyId, companyId))).some((n) => n.title === "Juno Lind's application was not read by AI")).toBe(true);

    // the email went: the reading follows; held for the ITS company check, the run waits at the notice and reads nothing
    const kai = await byEmail("Kai", "kai.lind@example.com");
    await container.drain();
    const ack = await ackOf(kai.application.id);
    const kaiRun = await runOf(kai.application.id);
    if (ack?.status === "held") {
      expect(kaiRun).toMatchObject({ status: "waiting", currentStep: "ai_notice" });
      expect(await aiRunsOf(kaiRun.id)).toEqual([]);
    } else {
      expect(ack?.status).toBe("sent");
      expect((await aiRunsOf(kaiRun.id)).length).toBeGreaterThan(0);
      expect((await container.db.select().from(candidates).where(eq(candidates.id, kai.candidate.id)))[0].consent.notices_by_email?.granted).toBe(false);
    }
  });
});
