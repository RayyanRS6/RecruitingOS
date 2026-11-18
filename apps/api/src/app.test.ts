import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AdminFailures, AdminQueue, CompanyCreated, CompanyView } from "@ros/contracts";
import { aiRuns, applications, assessments, candidates, communications, documents, entitlements, events, jobs, screens, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { TRIAGE_READINGS } from "@ros/agents";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { useLaterApplyFlow } from "./test-helpers";

/**
 * Slice 1 through the HTTP layer: sign up → company → intake conversation → packet → approval → publish →
 * apply (web and email-in) → acknowledgment → eligibility → brief → admin inspection.
 */
describe("Slice 1 API", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let companySlug = "";
  let roleId = "";
  let sessionId = "";

  const json = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie, ...extra }, body: body ? JSON.stringify(body) : undefined });

  // The engine clock: today at noon Pacific plus whatever the test advances.
  const BASE = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return d.getTime(); })();
  const setClock = (offsetMs: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offsetMs); };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    setClock(0);
  });
  afterAll(async () => {
    await container.close();
  });

  it("signs up with a magic link", async () => {
    const r1 = await json("POST", "/api/v1/auth/magic-link", { email: "dana@brightline.test" });
    expect(r1.status).toBe(200);
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await json("POST", "/api/v1/auth/magic-link/consume", { token });
    expect(r2.status).toBe(200);
    cookie = r2.headers.get("set-cookie")!.split(";")[0];
    const me = await json("GET", "/api/v1/auth/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe("dana@brightline.test");
    // a used link cannot be reused
    expect((await json("POST", "/api/v1/auth/magic-link/consume", { token })).status).toBe(401);
  });

  it("signs in from the emailed link: opening it changes nothing, the button signs in with a top-level redirect, and the link works once", async () => {
    const r1 = await json("POST", "/api/v1/auth/magic-link", { email: "link@brightline.test" });
    const { devLink } = (await r1.json()) as { devLink: string };
    expect(devLink).toMatch(/\/api\/v1\/auth\/consume\?token=/);
    const token = new URL(devLink).searchParams.get("token")!;
    // a mail scanner or a preview fetches the link: the page shows a button and consumes nothing
    const page = await app.request(devLink.replace(container.env.APP_BASE_URL, ""), { redirect: "manual" });
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(await page.text()).toMatch(/Continue to/);
    const press = () => app.request("/api/v1/auth/consume", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString(), redirect: "manual" });
    const r2 = await press();
    expect(r2.status).toBe(302);
    expect(r2.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup/company`);
    expect(r2.headers.get("set-cookie")).toMatch(/ros_session=/);
    const again = await press();
    expect(again.headers.get("location")).toMatch(/error=expired/);
  });

  it("two requests carrying the same link open exactly one session", async () => {
    const r1 = await json("POST", "/api/v1/auth/magic-link", { email: "race@brightline.test" });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const attempts = await Promise.all([0, 1, 2].map(() => json("POST", "/api/v1/auth/magic-link/consume", { token })));
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 401, 401]);
  });

  it("creates the company on the Free plan, with no clock", async () => {
    const r = await json("POST", "/api/v1/companies", { name: "Brightline Dental Group", vertical: "dental", sizeBand: "50-99", ownerName: "Dana Whitfield", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
    expect(r.status).toBe(201);
    const co = (await r.json()) as CompanyCreated;
    expect(co).toEqual({ id: co.id, name: "Brightline Dental Group", accessRequest: null });
    // This suite follows the later path: the form now, the screening invitation by email after the résumé is read (plan Wave E).
    await useLaterApplyFlow(container, co.id);
    const cur = await json("GET", "/api/v1/companies/current");
    expect(cur.status).toBe(200);
    // the Free plan's 2 people, counted live: the owner is the one in use (known bug 128)
    const body = (await cur.json()) as CompanyView;
    companySlug = body.slug;
    expect(body.plan).toMatchObject({ key: "free", name: "Free", trial: null });
    expect(body.plan.usage.find((l) => l.key === "seats")).toMatchObject({ used: 1, limit: 2 });
  });

  it("runs the intake conversation and compiles a role packet", async () => {
    const r1 = await json("POST", "/api/v1/intake/conversation/messages", { message: "I need a dental hygienist in Irvine. Full time. $45 to $55 an hour. I need someone who can start within 30 days." });
    expect(r1.status).toBe(200);
    const c1 = (await r1.json()) as { reply: string; intakeSessionId: string; readyToCompile: boolean };
    sessionId = c1.intakeSessionId;
    expect(c1.reply).toMatch(/playbook|market/i);
    expect(c1.readyToCompile).toBe(false);

    const r2 = await json("POST", `/api/v1/intake/sessions/${sessionId}/messages`, { message: "It's a replacement, our hygienist moved. Ceiling is $58. Interviewers: Dr. Chen and me. I decide. Must-haves: active CA RDH license, perio experience. Deal-breakers: can't work Saturdays." });
    expect(r2.status).toBe(200);
    const c2 = (await r2.json()) as { reply: { readyToCompile: boolean; factsExtracted: { compensationCeiling: number; mustHaves: string[] } } };
    expect(c2.reply.readyToCompile).toBe(true);
    expect(c2.reply.factsExtracted.compensationCeiling).toBe(58);
    expect(c2.reply.factsExtracted.mustHaves.length).toBeGreaterThanOrEqual(2);

    const r3 = await json("POST", `/api/v1/intake/sessions/${sessionId}/compile`);
    expect(r3.status).toBe(201);
    const compiled = (await r3.json()) as { roleId: string; version: number; packet: { identity: { title: string }; compensation: { ceiling: number; discloseRange: boolean }; compliance: { jurisdictions: string[]; notices: string[] }; requirements: { eligibility: Array<{ type: string }> } } };
    roleId = compiled.roleId;
    expect(compiled.version).toBe(1);
    expect(compiled.packet.identity.title).toBe("Registered Dental Hygienist");
    expect(compiled.packet.compensation.ceiling).toBe(58);
    expect(compiled.packet.compliance.jurisdictions).toContain("US-CA");
    expect(compiled.packet.compliance.notices).toContain("pay_transparency");
    expect(compiled.packet.requirements.eligibility.some((e) => e.type === "license")).toBe(true);

    // The packet is proposed and an approval is pending; the role is not open yet.
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { status: string; pendingApprovals: unknown[] };
    expect(role.status).toBe("pending_approval");
    expect(role.pendingApprovals).toHaveLength(1);
    const brief = (await (await json("GET", "/api/v1/brief")).json()) as { cards: Array<{ kind: string; title: string }> };
    expect(brief.cards.some((c) => c.kind === "decision" && /Approve the job/.test(c.title))).toBe(true);
  });

  it("resumes an open conversation after a reload and lets the owner start over", async () => {
    // the compiled session no longer resumes
    const none = (await (await json("GET", "/api/v1/intake/sessions/current")).json()) as { session: null | { id: string } };
    expect(none.session).toBeNull();
    // Free's one job is the role above: room for a second draft here, put back at the end (plan C13)
    await container.db.update(entitlements).set({ limit: 2 }).where(inArray(entitlements.key, ["active_roles", "jobs_total"]));
    const r1 = await json("POST", "/api/v1/intake/conversation/messages", { message: "I need a front office coordinator in Irvine, $22 to $26 an hour, full time." });
    const { intakeSessionId } = (await r1.json()) as { intakeSessionId: string };
    const cur = (await (await json("GET", "/api/v1/intake/sessions/current")).json()) as { session: { id: string; messages: Array<{ role: string }>; missingFacts: string[] } };
    expect(cur.session.id).toBe(intakeSessionId);
    expect(cur.session.messages.map((m) => m.role)).toEqual(["owner", "assistant"]);
    expect(cur.session.missingFacts).toContain("reason_for_hire");
    const ab = await json("POST", `/api/v1/intake/sessions/${intakeSessionId}/abandon`);
    expect(ab.status).toBe(200);
    expect(((await ab.json()) as { status: string }).status).toBe("abandoned");
    const after = (await (await json("GET", "/api/v1/intake/sessions/current")).json()) as { session: null | { id: string } };
    expect(after.session).toBeNull();
    // an abandoned conversation cannot be continued
    expect((await json("POST", `/api/v1/intake/sessions/${intakeSessionId}/messages`, { message: "It's a replacement." })).status).toBe(409);
    const evs = await container.db.select().from(events).where(eq(events.type, "intake.abandoned"));
    expect(evs).toHaveLength(1);
    await container.db.update(entitlements).set({ limit: 1 }).where(inArray(entitlements.key, ["active_roles", "jobs_total"]));
  });

  it("serves the job page with JobPosting markup and notices", async () => {
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('"@type":"JobPosting"');
    expect(html).toMatch(/artificial intelligence/);
    expect(html).toMatch(/\$45–\$55 an hour/);
  });

  it("accepts a web application, extracts the resume, passes eligibility, is assessed, and gets the AI interview on the page and in one email (20 Oct 2026)", async () => {
    const form = new FormData();
    form.set("firstName", "Maria");
    form.set("lastName", "Reyes");
    form.set("email", "maria.reyes@example.com");
    form.set("phone", "(949) 555-0100");
    form.set("locationText", "Tustin, CA");
    form.set("resume", new File([`Maria Reyes, RDH\nmaria.reyes@example.com | (949) 555-0100\n\nRegistered Dental Hygienist at Smile Bright Dental 2019 - present\nDental Hygienist at Coastal Family Dentistry 2015 - 2019\n\nLicenses: RDH license CA #RDH12345, active\nCertifications: BLS/CPR current\nSkills: Dentrix, periodontal charting, digital radiography`], "maria-reyes.txt", { type: "text/plain" }));
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string; type: string }> } } } };
    for (const rule of role.currentPacket.packet.requirements.eligibility) form.set(`elig_${rule.key}`, "yes");
    form.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    form.set("acknowledged", "yes");
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: form });
    expect(r.status).toBe(302);
    // the waiting room, never the status page: the status link travels only by email (Wave 0 item 0.1)
    const location = r.headers.get("location")!;
    expect(location).toBe(`/careers/${companySlug}/jobs/${roleId}/applied`);
    // 20 Oct 2026 (R20-12): the résumé is read and the AI interview exists (the inline worker ran); the page still says
    // "preparing" for its first 40 to 90 seconds, as every waiting room does (Q14, 21 Oct), and then opens it
    const receiptCookie = r.headers.get("set-cookie")!.match(/ros_applied=[^;,]+/)![0];
    expect((await app.request(location, { headers: { cookie: receiptCookie } })).status).toBe(200);
    const engine = container.engine as unknown as { now: () => Date };
    const real = engine.now;
    const past = real().getTime() + 91_000;
    engine.now = () => new Date(past);
    let waiting: Response;
    try {
      waiting = await app.request(location, { headers: { cookie: receiptCookie } });
    } finally {
      engine.now = real;
    }
    expect(waiting.status).toBe(302);
    expect(waiting.headers.get("location")).toMatch(/^\/c\/screen\/[A-Za-z0-9_-]+$/);
    const intro = await (await app.request(waiting.headers.get("location")!, { headers: { cookie: waiting.headers.get("set-cookie")!.match(/ros_applied_to=[^;,]+/)![0] } })).text();
    expect(intro).toContain("Your application is sent.");
    expect(intro).toContain("m***@example.com");

    const apps = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(apps).toHaveLength(1);
    const a = apps[0];
    // 20 Oct 2026 (R20-4): eligible → read → the AI interview, by itself, on the web only (never by text, R20-6)
    expect(a.stage).toBe("screen_invited");
    expect(a.eligibility?.passed).toBe(true);
    const [asmt] = await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id));
    expect(asmt.kind).toBe("triage");
    expect(["strong", "potential"]).toContain(asmt.overall);
    expect(asmt.result.recommendation).toBe("screen");
    for (const s of asmt.result.strengths) if (s.evidence.quote) expect(s.evidence.source).toBe("resume");
    const [scr] = await container.db.select().from(screens).where(eq(screens.applicationId, a.id));
    expect(scr.status).toBe("invited");
    expect(scr.channel).toBe("web");
    expect(scr.invitedVia).toBe("with_application");
    expect(waiting.headers.get("location")).toBe(`/c/screen/${scr.token}`);
    expect(a.extraction?.licenses.map((l) => l.name)).toContain("RDH");
    expect(a.extraction?.positions.length).toBeGreaterThanOrEqual(1);
    const outbox = (container.integrations.email as FakeEmailAdapter).sent;
    // one email: thank you, the AI interview's link and how it works
    expect(outbox.filter((m) => m.to === "maria.reyes@example.com")).toHaveLength(1);
    const ack = outbox.find((m) => m.to === "maria.reyes@example.com" && /^Thank you for applying: your next step for /.test(m.subject));
    expect(ack).toBeTruthy();
    expect(ack!.text).toContain(`/c/screen/${scr.token}`);
    expect(ack!.text).toMatch(/AI recruiting assistant/);
    expect(ack!.text).toMatch(/HUMAN/);
    const comms = await container.db.select().from(communications).where(eq(communications.applicationId, a.id));
    expect(comms[0].status).toBe("sent");
    expect(comms[0].disclosureIncluded).toBe(true);
    const runs = await container.db.select().from(aiRuns).where(eq(aiRuns.task, "resume.extract"));
    expect(runs).toHaveLength(1);
    // the application is read TRIAGE_READINGS times side by side, and the middle answer kept (fairness, 14 Oct 2026)
    expect(await container.db.select().from(aiRuns).where(eq(aiRuns.task, "triage.assess"))).toHaveLength(TRIAGE_READINGS);
    expect(`${waiting.headers.get("location")} ${intro}`).not.toContain(a.statusToken);
    expect(ack!.text).toContain(`/c/status/${a.statusToken}`);
    const status = await app.request(`/c/status/${a.statusToken}`);
    const statusHtml = await status.text();
    expect(statusHtml).toMatch(/Maria/);
    expect(statusHtml).toMatch(/\/c\/screen\//);
  });

  it("holds an ineligible applicant for a person: reminds, never declines automatically; the decline message goes out only after a human decision", async () => {
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string; type: string }> } } } };
    const license = role.currentPacket.packet.requirements.eligibility.find((e) => e.type === "license")!;
    const submit = async (email: string, first: string) => {
      const form = new FormData();
      form.set("firstName", first);
      form.set("lastName", "Nolicense");
      form.set("email", email);
      form.set("noResume", "I worked as a dental assistant for three years and am studying for my hygiene license.");
      form.set("acknowledged", "yes");
      for (const rule of role.currentPacket.packet.requirements.eligibility) form.set(`elig_${rule.key}`, rule.key === license.key ? "no" : "yes");
      const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: form });
      expect(r.status).toBe(302);
    };
    await submit("jon@example.com", "Jon");
    await submit("ana@example.com", "Ana");
    const list = (await (await json("GET", `/api/v1/roles/${roleId}/applications?stage=ineligible`)).json()) as Array<{ id: string; candidate: { name: string } }>;
    expect(list).toHaveLength(2);
    const jon = list.find((x) => x.candidate.name.startsWith("Jon"))!;
    const ana = list.find((x) => x.candidate.name.startsWith("Ana"))!;
    // R20-10: held on a must-have "No", both got the neutral thank-you, without the AI interview's link
    for (const to of ["jon@example.com", "ana@example.com"]) {
      const mine = (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === to);
      expect(mine.map((m) => m.subject)).toEqual([expect.stringMatching(/^Thank you for applying: Registered Dental Hygienist at /)]);
      expect(mine[0].text).not.toContain("/c/screen/");
    }
    // the owner keeps one in before the window ends: "Keep them in" sends the link by itself, after the reading, with
    // nothing more to approve (known bug 30 rule replaced on 20 Oct 2026)
    const ov = await json("POST", `/api/v1/applications/${jon.id}/actions`, { action: "override_eligibility", note: "She is sitting the exam next week." });
    expect(ov.status).toBe(200);
    await container.drain();
    expect((await container.db.select().from(applications).where(eq(applications.id, jon.id)))[0].stage).toBe("screen_invited");
    const [jonScreen] = await container.db.select().from(screens).where(eq(screens.applicationId, jon.id));
    expect(jonScreen).toMatchObject({ invitedVia: "with_application", channel: "web", status: "invited" });
    const jonMail = (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === "jon@example.com");
    expect(jonMail).toHaveLength(2);
    expect(jonMail[1].subject).toMatch(/^Your next step: a short AI interview for /);
    expect(jonMail[1].text).toContain(`/c/screen/${jonScreen.token}`);
    // time passes: advance the engine clock by 25 hours and drain the timers
    setClock(25 * 3600_000);
    await container.drain();
    const after = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(after.find((x) => x.id === jon.id)!.stage).toBe("screen_invited");
    // Founder decision (correction 6): the timer is operational, never adverse action. Ana is still held and reminded; nothing was sent to her.
    expect(after.find((x) => x.id === ana.id)!.stage).toBe("ineligible");
    let outbox = (container.integrations.email as FakeEmailAdapter).sent;
    expect(outbox.find((m) => m.to === "ana@example.com" && /Your application to/.test(m.subject))).toBeFalsy();
    expect(outbox.filter((m) => m.to === "ana@example.com")).toHaveLength(1);
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, ana.id))).toHaveLength(0);
    const notes = ((await (await json("GET", "/api/v1/notifications/history?filter=unread&limit=100")).json()) as { items: Array<{ kind: string; title: string }> }).items;
    expect(notes.some((n) => n.kind === "application.ineligible_review_due" && /Ana/.test(n.title))).toBe(true);
    // after three days without a decision the reminders end; she is still held, and still nothing is sent to Ana
    setClock(80 * 3600_000);
    await container.drain();
    expect((await container.db.select().from(applications).where(eq(applications.id, ana.id)))[0].stage).toBe("ineligible");
    expect((container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === "ana@example.com")).toHaveLength(1);
    // only a person declines; the decision is private (founder decision B6) and the message goes only when a person sends it
    const decline = await json("POST", `/api/v1/applications/${ana.id}/actions`, { action: "reject", reason: "eligibility", note: "No active license." });
    expect(decline.status).toBe(200);
    expect(await decline.json()).toMatchObject({ dispositionSent: false, candidateNotice: "not_told" });
    const [anaRow] = await container.db.select().from(applications).where(eq(applications.id, ana.id));
    expect(anaRow.stage).toBe("rejected");
    expect(anaRow.rejectReason).toBe("eligibility");
    outbox = (container.integrations.email as FakeEmailAdapter).sent;
    expect(outbox.find((m) => m.to === "ana@example.com" && /Your application to/.test(m.subject))).toBeFalsy();
    expect(await (await json("POST", `/api/v1/applications/${ana.id}/actions`, { action: "send_decision" })).json()).toMatchObject({ dispositionSent: true, candidateNotice: "queued" });
    outbox = (container.integrations.email as FakeEmailAdapter).sent;
    expect(outbox.find((m) => m.to === "ana@example.com" && /Your application to/.test(m.subject))).toBeTruthy();
    expect(outbox.find((m) => m.to === "jon@example.com" && /Your application to/.test(m.subject))).toBeFalsy();
    setClock(0);
  });

  it("dedupes a repeat application from the same candidate: the same receipt, nothing on the record changed, the link emailed to the address on file", async () => {
    const [maria] = await container.db.select().from(candidates).where(eq(candidates.email, "maria.reyes@example.com"));
    const [mariaApp] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, maria.id)));
    const sentBefore = (container.integrations.email as FakeEmailAdapter).sent.length;
    // someone else types Maria's address, with their own phone, place, text consent and résumé
    const form = new FormData();
    form.set("firstName", "Maria");
    form.set("lastName", "Reyes");
    form.set("email", "Maria.Reyes@example.com");
    form.set("phone", "(714) 555-0199");
    form.set("locationText", "Somewhere Else, NV");
    form.set("resume", new File(["Not Maria at all"], "other.txt", { type: "text/plain" }));
    form.set("acknowledged", "yes");
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: form });
    expect(r.status).toBe(302);
    // exactly what a first application gets: the waiting room (Q14; it opens a detached interview, never hers), never a status link
    expect(r.headers.get("location")).toBe(`/careers/${companySlug}/jobs/${roleId}/applied`);
    const receipt = await (await app.request(r.headers.get("location")!, { headers: { cookie: r.headers.get("set-cookie")!.match(/ros_applied=[^;,]+/)![0] } })).text();
    expect(receipt).toContain("preparing your AI interview");
    expect(receipt).not.toContain("/c/screen/");
    expect(receipt).toContain("M***@example.com");
    expect(`${r.headers.get("location")} ${r.headers.get("set-cookie")} ${receipt}`).not.toContain(mariaApp.statusToken);
    const apps = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(apps.filter((x) => x.source === "careers_page")).toHaveLength(3);
    const dup = await container.db.select().from(events).where(eq(events.type, "application.duplicate_detected"));
    expect(dup).toHaveLength(1);
    // nothing about Maria changed: consent, phone, place, résumé
    const [after] = await container.db.select().from(candidates).where(eq(candidates.id, maria.id));
    expect(after.consent).toEqual(maria.consent);
    expect(after.phone).toBe(maria.phone);
    expect(after.locationText).toBe(maria.locationText);
    const [appAfter] = await container.db.select().from(applications).where(eq(applications.id, mariaApp.id));
    expect(appAfter.resumeDocumentId).toBe(mariaApp.resumeDocumentId);
    expect(appAfter.answers).toEqual(mariaApp.answers);
    expect((await container.db.select().from(documents).where(eq(documents.applicationId, mariaApp.id))).length).toBe(1);
    // the address on file learns about it, with its own link
    const notice = (container.integrations.email as FakeEmailAdapter).sent.slice(sentBefore).find((m) => m.to === "maria.reyes@example.com");
    expect(notice?.subject).toMatch(/^Your application for /);
    expect(notice?.text).toContain(`/c/status/${mariaApp.statusToken}`);
    expect(notice?.text).toContain("Nothing in it was changed or replaced.");
  });

  it("recovers from a transient email outage: the message is queued, the workflow moves on, and the outbox retries the send exactly once", async () => {
    (container.integrations.email as FakeEmailAdapter).failNext(1);
    const form = new FormData();
    form.set("firstName", "Priya");
    form.set("lastName", "Shah");
    form.set("email", "priya@example.com");
    form.set("noResume", "Hygienist, 6 years.");
    form.set("acknowledged", "yes");
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    for (const rule of role.currentPacket.packet.requirements.eligibility) form.set(`elig_${rule.key}`, "yes");
    await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: form });
    const [priya] = await container.db.select().from(candidates).where(eq(candidates.email, "priya@example.com"));
    // the acknowledgment is recorded and queued; the provider refused it once, so the outbox job waits for its retry
    const [ack] = await container.db.select().from(communications).where(and(eq(communications.candidateId, priya.id), eq(communications.templateKey, "acknowledgment")));
    expect(ack.status).toBe("queued");
    expect(ack.error).toMatch(/outage/);
    expect(ack.sendAttempts).toBe(1);
    const [job] = await container.db.select().from(jobs).where(and(eq(jobs.kind, "communication.send"), sql`${jobs.payload}->>'communicationId' = ${ack.id}`));
    expect(job.status).toBe("queued");
    expect(job.lastError).toMatch(/outage/);
    // the workflow itself was never held up by the provider: it acknowledged and moved on
    const runs = await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "application_intake"));
    expect(runs.some((x) => x.status === "waiting" && x.lastError?.includes("acknowledgment"))).toBe(false);
    expect((await container.db.select().from(events).where(eq(events.type, "message.retried"))).some((e) => e.subjectId === ack.id)).toBe(true);
    // the retry timer fires
    setClock(60_000);
    await container.drain();
    setClock(0);
    const [sent] = await container.db.select().from(communications).where(eq(communications.id, ack.id));
    expect(sent.status).toBe("sent");
    expect(sent.providerMessageId).toBeTruthy();
    const outbox = (container.integrations.email as FakeEmailAdapter).sent;
    expect(outbox.filter((m) => m.to === "priya@example.com" && /^Thank you for applying: your next step/.test(m.subject))).toHaveLength(1);
  });

  it("rejecting on judgment requires a human with a reason, and is audited", async () => {
    // everyone not held is invited to the AI interview by itself now (20 Oct 2026): a person declines from there
    const apps = (await (await json("GET", `/api/v1/roles/${roleId}/applications?stage=screen_invited`)).json()) as Array<{ id: string }>;
    expect(apps.length).toBeGreaterThan(0);
    const bad = await json("POST", `/api/v1/applications/${apps[0].id}/actions`, { action: "reject" });
    expect(bad.status).toBe(400);
    const ok = await json("POST", `/api/v1/applications/${apps[0].id}/actions`, { action: "reject", reason: "not_a_match_experience", note: "Wants Saturdays off." });
    expect(ok.status).toBe(200);
    const detail = (await (await json("GET", `/api/v1/applications/${apps[0].id}`)).json()) as { stage: string; timeline: Array<{ type: string }> };
    expect(detail.stage).toBe("rejected");
    expect(detail.timeline.some((e) => e.type === "human.override")).toBe(true);
  });

  it("enforces the Free plan's one job before any draft or assistant run (plan C13)", async () => {
    const runsBefore = (await container.db.select().from(aiRuns)).length;
    const r = await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a front office coordinator in Irvine, $22 to $26 an hour, full time. Just draft it." });
    expect(r.status).toBe(402);
    const err = ((await r.json()) as { error: { code: string; message: string; details: { upgrade: boolean; room: { holding: Array<{ title: string }> } } } }).error;
    expect(err.code).toBe("limit_reached");
    // a job that went live counts for good, so no role is named to close, and the message says what to do instead
    expect(err.details.upgrade).toBe(true);
    expect(err.details.room.holding).toEqual([]);
    expect(err.message).toBe("Your Free plan includes one job. Upgrade to post more.");
    expect((await container.db.select().from(aiRuns)).length).toBe(runsBefore);
  });

  it("blocks admin routes for non-admins and shows the queue, the failures and the costs to admins", async () => {
    expect((await json("GET", "/api/v1/admin/queue")).status).toBe(403);
    const { users } = await import("@ros/db");
    const { grantPlatformRole } = await import("@ros/core");
    const [dana] = await container.db.select().from(users).where(eq(users.email, "dana@brightline.test"));
    await grantPlatformRole(container.db, { userId: dana.id, role: "platform_admin", actor: { kind: "system", id: "test_seed" }, reason: "test seed", source: "test_seed" });
    // the role alone is not enough (21 Sep, item 2): the email-link session has no second factor
    const noMfa = await json("GET", "/api/v1/admin/queue", undefined, { "x-admin-reason": "test" });
    expect(noMfa.status).toBe(403);
    expect(((await noMfa.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
    const { signInWithIdentity } = await import("./test-helpers");
    const adminCookie = await signInWithIdentity(app, container, { email: "dana@brightline.test", provider: "azure", aal2: true });
    const asAdmin = (method: string, path: string) => json(method, path, undefined, { "x-admin-reason": "test", cookie: adminCookie });
    const r = await asAdmin("GET", "/api/v1/admin/queue");
    expect(r.status).toBe(200);
    const queue = (await r.json()) as AdminQueue;
    expect(queue.definitions.length).toBeGreaterThan(0);
    expect(typeof queue.queued).toBe("number");
    const failures = (await (await asAdmin("GET", "/api/v1/admin/failures")).json()) as AdminFailures;
    expect(Object.keys(failures).sort()).toEqual(["alerts", "failedAi", "failedJobs", "failedRuns"]);
    // what failed is named by what it was and its error: never a run's state, a job's payload or an AI call's output
    expect(JSON.stringify(failures)).not.toMatch(/"(state|payload|output|outputRef|inputRef)":/);
    const costs = (await (await asAdmin("GET", "/api/v1/admin/costs")).json()) as Array<{ task: string }>;
    expect(costs.some((c) => c.task === "intake.turn")).toBe(true);
    // ?since= (the dashboard's "this month"): only the runs from that day on; a day before every run gives the
    // same answer as no filter, a day after them none, and anything but a real date is refused
    const sorted = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();
    const sinceLongAgo = (await (await asAdmin("GET", "/api/v1/admin/costs?since=2000-01-01")).json()) as unknown[];
    expect(sorted(sinceLongAgo)).toEqual(sorted(costs));
    expect(await (await asAdmin("GET", "/api/v1/admin/costs?since=2999-01-01")).json()).toEqual([]);
    for (const bad of ["October", "2026-02-30", "2026-10-1"]) expect((await asAdmin("GET", `/api/v1/admin/costs?since=${bad}`)).status, bad).toBe(400);
  });
});
