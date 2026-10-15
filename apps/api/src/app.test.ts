import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { aiRuns, applications, approvalRequests, assessments, candidates, communications, documents, entitlements, events, jobs, postings, recruiterEscalations, roles, screens, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter, FakeSmsAdapter } from "@ros/integrations";
import { TRIAGE_READINGS } from "@ros/agents";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { useLaterApplyFlow } from "./test-helpers";

/**
 * Slice 1 through the HTTP layer: sign up → company → intake conversation → packet → approval → publish →
 * apply (web and email-in) → acknowledgment → eligibility → brief → ask a recruiter → admin inspection.
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

  // The engine clock: today at noon Pacific (inside SMS contact hours) plus whatever the test advances.
  const BASE = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return d.getTime(); })();
  const setClock = (offsetMs: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offsetMs); };

  beforeAll(async () => {
    // Texting on: this file exercises the SMS screen path a consenting applicant gets (decision M2 keeps it off by default).
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", SMS_ENABLED: "true" } });
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

  it("creates the company with trial entitlements", async () => {
    const r = await json("POST", "/api/v1/companies", { name: "Brightline Dental Group", vertical: "dental", sizeBand: "50-99", ownerName: "Dana Whitfield", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
    expect(r.status).toBe(201);
    const co = (await r.json()) as { id: string; slug: string; planKey: string };
    companySlug = co.slug;
    expect(co.planKey).toBe("trial");
    // This suite follows the later path: the form now, the screening invitation by email after the résumé is read (plan Wave E).
    await useLaterApplyFlow(container, co.id);
    const cur = await json("GET", "/api/v1/companies/current");
    expect(cur.status).toBe(200);
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
    // the trial's one place is taken by the role above: room for a second draft here, put back at the end (plan C13)
    await container.db.update(entitlements).set({ limit: 2 }).where(eq(entitlements.key, "active_roles"));
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
    await container.db.update(entitlements).set({ limit: 1 }).where(eq(entitlements.key, "active_roles"));
  });

  it("approval opens the role and publishes to its channels: the careers page, Google, email and the boards the role plan names", async () => {
    const r = await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "Looks right." });
    expect(r.status).toBe(200);
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { status: string; currentPacketVersion: number; postings: Array<{ channel: string; status: string; intakeToken: string | null; instructions: string | null; steps: string[]; externalUrl: string | null; verifiedBy: { kind: string } | null }> };
    expect(role.status).toBe("open");
    expect(role.currentPacketVersion).toBe(1);
    const byChannel = Object.fromEntries(role.postings.map((p) => [p.channel, p]));
    // docs/spec/20: nothing is live until its public URL was checked. The careers page passed the (fake) check during
    // the inline drain; Google is submitted through the page's structured data; email-in is failed (no inbound domain);
    // the boards the role plan names (Indeed here; founder decision Q11) wait at "ready to post" with their steps until
    // a person records the public URL, and no board the plan does not name is prepared.
    expect(byChannel.careers_page.status).toBe("live_verified");
    expect(byChannel.careers_page.verifiedBy).toMatchObject({ kind: "system" });
    expect(byChannel.careers_page.externalUrl).toBe(`${container.env.JOBS_BASE_URL}/careers/${companySlug}/jobs/${roleId}`);
    expect(byChannel.google_jobs.status).toBe("submitted_integration");
    expect(byChannel.email_in.status).toBe("failed");
    expect(byChannel.linkedin_basic).toBeUndefined();
    expect(byChannel.ziprecruiter).toBeUndefined();
    expect(byChannel.indeed.status).toBe("ready_to_post");
    expect(byChannel.indeed.instructions).toMatch(/apply/);
    expect(byChannel.indeed.steps.length).toBeGreaterThanOrEqual(5);
    expect(byChannel.indeed.steps.join("\n")).toMatch(new RegExp(`${container.env.JOBS_BASE_URL}/a/[a-z0-9]{12}`));
    expect(byChannel.email_in.intakeToken).toBeTruthy();
    const runs = await container.db.select().from(workflowRuns);
    // the morning email summaries (plan B3) run beside the stuck-role check
    expect(runs.map((x) => `${x.workflowKey}:${x.status}`).sort()).toEqual(["notification_digest:waiting", "publish_role:completed", "role_approval:completed", "stuck_role_detector:waiting"]);
    const feed = await app.request("/feeds/linkedin.xml");
    expect(await feed.text()).toContain("Registered Dental Hygienist");
  });

  it("serves the job page with JobPosting markup and notices", async () => {
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('"@type":"JobPosting"');
    expect(html).toMatch(/artificial intelligence/);
    expect(html).toMatch(/\$45–\$55 an hour/);
  });

  it("accepts a web application, acknowledges within the workflow, extracts the resume, passes eligibility, is assessed, and is invited to a screen under policy", async () => {
    const form = new FormData();
    form.set("firstName", "Maria");
    form.set("lastName", "Reyes");
    form.set("email", "maria.reyes@example.com");
    form.set("phone", "(949) 555-0100");
    form.set("smsConsent", "yes");
    form.set("locationText", "Tustin, CA");
    form.set("resume", new File([`Maria Reyes, RDH\nmaria.reyes@example.com | (949) 555-0100\n\nRegistered Dental Hygienist at Smile Bright Dental 2019 - present\nDental Hygienist at Coastal Family Dentistry 2015 - 2019\n\nLicenses: RDH license CA #RDH12345, active\nCertifications: BLS/CPR current\nSkills: Dentrix, periodontal charting, digital radiography`], "maria-reyes.txt", { type: "text/plain" }));
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string; type: string }> } } } };
    for (const rule of role.currentPacket.packet.requirements.eligibility) form.set(`elig_${rule.key}`, "yes");
    form.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    form.set("acknowledged", "yes");
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: form });
    expect(r.status).toBe(302);
    // the receipt, never the status page: the link travels only by email (Wave 0 item 0.1)
    const location = r.headers.get("location")!;
    expect(location).toBe(`/careers/${companySlug}/jobs/${roleId}/applied`);
    const receipt = await (await app.request(location, { headers: { cookie: r.headers.get("set-cookie")!.match(/ros_applied=[^;,]+/)![0] } })).text();
    expect(receipt).toContain("Check your email.");
    expect(receipt).toContain("m***@example.com");

    const apps = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(apps).toHaveLength(1);
    const a = apps[0];
    // Slice 2: eligible → assessed (triaged) → policy application.invite_screen = auto_notify → invited by text (consented) and email
    expect(a.stage).toBe("screen_invited");
    expect(a.eligibility?.passed).toBe(true);
    const [asmt] = await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id));
    expect(asmt.kind).toBe("triage");
    expect(["strong", "potential"]).toContain(asmt.overall);
    expect(asmt.result.recommendation).toBe("screen");
    for (const s of asmt.result.strengths) if (s.evidence.quote) expect(s.evidence.source).toBe("resume");
    const [scr] = await container.db.select().from(screens).where(eq(screens.applicationId, a.id));
    expect(scr.status).toBe("invited");
    expect(scr.channel).toBe("sms");
    const sms = (container.integrations.sms as FakeSmsAdapter).sent;
    expect(sms.find((m) => m.to === "+19495550100")?.body).toMatch(/AI assistant|AI-assisted/);
    expect(sms.find((m) => m.to === "+19495550100")?.body).toMatch(/HUMAN/);
    expect(a.extraction?.licenses.map((l) => l.name)).toContain("RDH");
    expect(a.extraction?.positions.length).toBeGreaterThanOrEqual(1);
    const outbox = (container.integrations.email as FakeEmailAdapter).sent;
    const ack = outbox.find((m) => m.to === "maria.reyes@example.com" && /received your application/.test(m.subject));
    expect(ack).toBeTruthy();
    expect(outbox.find((m) => m.to === "maria.reyes@example.com" && /screening conversation/.test(m.subject))?.text).toMatch(/\/c\/screen\//);
    expect(ack!.text).toMatch(/AI recruiting assistant/);
    expect(ack!.text).toMatch(/HUMAN/);
    const comms = await container.db.select().from(communications).where(eq(communications.applicationId, a.id));
    expect(comms[0].status).toBe("sent");
    expect(comms[0].disclosureIncluded).toBe(true);
    const runs = await container.db.select().from(aiRuns).where(eq(aiRuns.task, "resume.extract"));
    expect(runs).toHaveLength(1);
    // the application is read TRIAGE_READINGS times side by side, and the middle answer kept (fairness, 14 Oct 2026)
    expect(await container.db.select().from(aiRuns).where(eq(aiRuns.task, "triage.assess"))).toHaveLength(TRIAGE_READINGS);
    expect(receipt).not.toContain(a.statusToken);
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
    // the owner overrides one before the window ends
    const ov = await json("POST", `/api/v1/applications/${jon.id}/actions`, { action: "override_eligibility", note: "She is sitting the exam next week." });
    expect(ov.status).toBe(200);
    // overridden eligibility: assessed at once, not when the review timer is due, but the owner reviews (no automatic
    // screen when a rule was overridden)
    await container.drain();
    expect((await container.db.select().from(applications).where(eq(applications.id, jon.id)))[0].stage).toBe("triaged");
    // time passes: advance the engine clock by 25 hours and drain the timers
    setClock(25 * 3600_000);
    await container.drain();
    const after = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(after.find((x) => x.id === jon.id)!.stage).toBe("triaged");
    // Founder decision (correction 6): the timer is operational, never adverse action. Ana is still held and reminded; nothing was sent to her.
    expect(after.find((x) => x.id === ana.id)!.stage).toBe("ineligible");
    let outbox = (container.integrations.email as FakeEmailAdapter).sent;
    expect(outbox.find((m) => m.to === "ana@example.com" && /Your application to/.test(m.subject))).toBeFalsy();
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string; title: string }>;
    expect(notes.some((n) => n.kind === "application.ineligible_review_due" && /Ana/.test(n.title))).toBe(true);
    // after three days without a decision an ITS recruiter is brought in; still nothing is sent to Ana
    setClock(80 * 3600_000);
    await container.drain();
    const held = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, ana.id));
    expect(held.some((e) => e.kind === "review")).toBe(true);
    expect((await container.db.select().from(applications).where(eq(applications.id, ana.id)))[0].stage).toBe("ineligible");
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

  it("ingests an Indeed-style forwarded application through the intake address", async () => {
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { postings: Array<{ channel: string; intakeToken: string | null }> };
    const token = role.postings.find((p) => p.channel === "email_in")!.intakeToken!;
    const r = await app.request("/webhooks/postmark/inbound", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ From: "noreply@indeed.com", FromName: "Indeed", To: `apply-${token}@${container.integrations.env.intakeDomain}`, Subject: "New applicant: Luis Ortega - Registered Dental Hygienist", TextBody: "Luis Ortega applied via Indeed.\nEmail: luis.ortega@example.com\nPhone: 949-555-0199", Attachments: [{ Name: "Luis-Ortega.txt", ContentType: "text/plain", Content: Buffer.from("Luis Ortega\nRegistered Dental Hygienist at Harbor Dental 2020 - present\nRDH license CA active").toString("base64"), ContentLength: 80 }] }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { matched: boolean; applicationId: string };
    expect(body.matched).toBe(true);
    const [a] = await container.db.select().from(applications).where(eq(applications.id, body.applicationId));
    expect(a.source).toBe("email_in");
    // no eligibility answers by email: unverifiable, not failed; assessed and invited to a screen by email (no SMS consent)
    expect(a.stage).toBe("screen_invited");
    expect(a.eligibility?.unverifiable.length).toBeGreaterThan(0);
    const [scr] = await container.db.select().from(screens).where(eq(screens.applicationId, a.id));
    expect(scr.channel).toBe("web");
    expect(a.extraction?.positions[0]?.employer).toBe("Harbor Dental");
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
    form.set("smsConsent", "yes");
    form.set("locationText", "Somewhere Else, NV");
    form.set("resume", new File(["Not Maria at all"], "other.txt", { type: "text/plain" }));
    form.set("acknowledged", "yes");
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: form });
    expect(r.status).toBe(302);
    // exactly what a first application gets: the receipt, never a status link
    expect(r.headers.get("location")).toBe(`/careers/${companySlug}/jobs/${roleId}/applied`);
    const receipt = await (await app.request(r.headers.get("location")!, { headers: { cookie: r.headers.get("set-cookie")!.match(/ros_applied=[^;,]+/)![0] } })).text();
    expect(receipt).toContain("Check your email.");
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
    expect(outbox.filter((m) => m.to === "priya@example.com" && /received your application/.test(m.subject))).toHaveLength(1);
  });

  it("escalates to a recruiter with full context and shows it in the brief", async () => {
    const apps = (await (await json("GET", `/api/v1/roles/${roleId}/applications`)).json()) as Array<{ id: string }>;
    const r = await json("POST", "/api/v1/escalations", { kind: "review", roleId, applicationId: apps[0].id, question: "Is Maria worth a working interview?" });
    expect(r.status).toBe(201);
    const outbox = (container.integrations.email as FakeEmailAdapter).sent;
    const queueMail = outbox.find((m) => /^\[review\]/.test(m.subject));
    expect(queueMail).toBeTruthy();
    // correction 11: the queue notification never carries the customer's words
    expect(queueMail!.text).not.toContain("Maria");
    expect(queueMail!.text).toContain("Summary:");
    const brief = (await (await json("GET", "/api/v1/brief")).json()) as { cards: Array<{ kind: string }> };
    expect(brief.cards.some((c) => c.kind === "escalation")).toBe(true);
    // the recruiter queue needs a platform role
    expect((await json("GET", "/api/v1/escalations")).status).toBe(403);
  });

  it("rejecting on judgment requires a human with a reason, and is audited", async () => {
    const apps = (await (await json("GET", `/api/v1/roles/${roleId}/applications?stage=triaged`)).json()) as Array<{ id: string }>;
    expect(apps.length).toBeGreaterThan(0);
    const bad = await json("POST", `/api/v1/applications/${apps[0].id}/actions`, { action: "reject" });
    expect(bad.status).toBe(400);
    const ok = await json("POST", `/api/v1/applications/${apps[0].id}/actions`, { action: "reject", reason: "not_a_match_experience", note: "Wants Saturdays off." });
    expect(ok.status).toBe(200);
    const detail = (await (await json("GET", `/api/v1/applications/${apps[0].id}`)).json()) as { stage: string; timeline: Array<{ type: string }> };
    expect(detail.stage).toBe("rejected");
    expect(detail.timeline.some((e) => e.type === "human.override")).toBe(true);
  });

  it("enforces the trial's one-active-role entitlement before any draft or assistant run (plan C13)", async () => {
    const runsBefore = (await container.db.select().from(aiRuns)).length;
    const r = await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a front office coordinator in Irvine, $22 to $26 an hour, full time. Just draft it." });
    expect(r.status).toBe(402);
    const err = ((await r.json()) as { error: { code: string; message: string; details: { room: { holding: Array<{ title: string }> } } } }).error;
    expect(err.code).toBe("limit_reached");
    // the role using the place is named, and the message says plainly that closing a role frees its place (polish list)
    expect(err.details.room.holding.map((h) => h.title)).toEqual(["Registered Dental Hygienist"]);
    expect(err.message).toMatch(/A role uses a place while it is open, paused or waiting for approval, and closing a role gives its place back/);
    expect((await container.db.select().from(aiRuns)).length).toBe(runsBefore);
  });

  it("blocks admin routes for non-admins and exposes runs to admins", async () => {
    expect((await json("GET", "/api/v1/admin/runs")).status).toBe(403);
    const { users } = await import("@ros/db");
    const { grantPlatformRole } = await import("@ros/core");
    const [dana] = await container.db.select().from(users).where(eq(users.email, "dana@brightline.test"));
    await grantPlatformRole(container.db, { userId: dana.id, role: "platform_admin", actor: { kind: "system", id: "test_seed" }, reason: "test seed", source: "test_seed" });
    // the role alone is not enough (21 Sep, item 2): the email-link session has no second factor
    const noMfa = await json("GET", "/api/v1/admin/runs", undefined, { "x-admin-reason": "test" });
    expect(noMfa.status).toBe(403);
    expect(((await noMfa.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
    const { signInWithIdentity } = await import("./test-helpers");
    const adminCookie = await signInWithIdentity(app, container, { email: "dana@brightline.test", provider: "azure", aal2: true });
    const asAdmin = (method: string, path: string) => json(method, path, undefined, { "x-admin-reason": "test", cookie: adminCookie });
    const r = await asAdmin("GET", "/api/v1/admin/runs");
    expect(r.status).toBe(200);
    const runs = (await r.json()) as Array<{ id: string; workflowKey: string }>;
    const detail = (await (await asAdmin("GET", `/api/v1/admin/runs/${runs[0].id}`)).json()) as { steps: unknown[]; events: unknown[] };
    expect(detail.steps.length).toBeGreaterThan(0);
    expect(detail.events.length).toBeGreaterThan(0);
    const costs = (await (await asAdmin("GET", "/api/v1/admin/costs")).json()) as Array<{ task: string }>;
    expect(costs.some((c) => c.task === "intake.turn")).toBe(true);
    // ?since= (the console's "this month", Wave S6): only the runs from that day on; a day before every run gives the
    // same answer as no filter, a day after them none, and anything but a real date is refused
    const sorted = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();
    const sinceLongAgo = (await (await asAdmin("GET", "/api/v1/admin/costs?since=2000-01-01")).json()) as unknown[];
    expect(sorted(sinceLongAgo)).toEqual(sorted(costs));
    expect(await (await asAdmin("GET", "/api/v1/admin/costs?since=2999-01-01")).json()).toEqual([]);
    for (const bad of ["October", "2026-02-30", "2026-10-1"]) expect((await asAdmin("GET", `/api/v1/admin/costs?since=${bad}`)).status, bad).toBe(400);
  });

  it("keeps postings and approvals consistent", async () => {
    // the careers page, Google, email and the one board the role plan names (Indeed; founder decision Q11)
    const posts = await container.db.select().from(postings).where(eq(postings.roleId, roleId));
    expect(posts.length).toBe(4);
    const pend = await container.db.select().from(approvalRequests).where(eq(approvalRequests.status, "pending"));
    expect(pend.filter((p) => p.roleId === roleId)).toHaveLength(0);
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    expect(role.status).toBe("open");
  });
});
