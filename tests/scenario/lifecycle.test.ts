import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addBusinessHours } from "../../packages/core/src/business-hours";
import { eq, and } from "drizzle-orm";
import { intakeTurnPrompt } from "../../packages/ai/src/prompts/intake";
import { aiRuns, applications, approvalRequests, assessments, auditRecords, communications, events, interventions, interviews, notifications, recruiterEscalations, rolePackets, roles, screens, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter, FakeSmsAdapter } from "@ros/integrations";
import { createApp } from "../../apps/api/src/app";
import { createContainer, type Container } from "../../apps/api/src/container";
import { useLaterApplyFlow } from "../../apps/api/src/test-helpers";

/**
 * docs/13: A 100-person company (Brightline Dental Group, Irvine) hires a full-time Dental Hygienist.
 * At every implemented step this test asserts: what the customer sees, what the AI does, what data is stored,
 * which event fired, which policy applied, whether a human had to approve, and what happens on failure.
 * Steps 11 to 13 are built; the rest are deferred with a recorded reason (docs/spec/15), so this file is the living record of what works.
 */
describe("End-to-end hiring scenario: Brightline Dental Group hires a Registered Dental Hygienist", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let slug = "";
  let roleId = "";
  let sessionId = "";
  const eventsOf = async (type: string) => container.db.select().from(events).where(eq(events.type, type));
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

  // The engine clock: today at noon Pacific (inside SMS contact hours) plus whatever a step advances.
  const BASE = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return d.getTime(); })();
  let clockOffset = 0;
  const setClock = (offsetMs: number) => { clockOffset = offsetMs; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + clockOffset); };
  const advance = async (ms: number) => { setClock(clockOffset + ms); await container.drain(); };

  // Dana signs in with an email link. A rule change (PUT /policies) is refused from a session older than thirty minutes
  // (audit finding A12), so once the steps have moved the clock by days she signs in again before changing one.
  const signIn = async () => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dana@brightline.test" }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const consume = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(devLink).searchParams.get("token") }) });
    cookie = consume.headers.get("set-cookie")!.split(";")[0];
  };

  beforeAll(async () => {
    // Texting on for the scenario: step 5 consents to texts and step 7 runs the screen by SMS (decision M2 keeps texting off by default).
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", STORAGE_PROVIDER: "memory", SMS_ENABLED: "true" } });
    app = createApp(container);
    setClock(0);
    await signIn();
    const co =(await (await json("POST", "/api/v1/companies", { name: "Brightline Dental Group", vertical: "dental", sizeBand: "100-199", ownerName: "Dana Whitfield", locations: [{ city: "Irvine", region: "CA", country: "US" }, { city: "Tustin", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    slug = co.slug;
    // docs/13 tells the later path (the screen by text after the résumé is read): the company is on it, as ITS can set (plan Wave E).
    await useLaterApplyFlow(container, co.id);
  });
  afterAll(async () => { await container.close(); });

  it("Step 1, Intake: the owner describes the hire; the AI asks recruiter questions; facts are stored; nothing is decided", async () => {
    const r = (await (await json("POST", "/api/v1/intake/conversation/messages", { message: "I need a dental hygienist in Irvine. Full time. $45 to $55 an hour. I need someone who can start within 30 days." })).json()) as { reply: string; intakeSessionId: string; readyToCompile: boolean };
    sessionId = r.intakeSessionId;
    // customer sees: a reply that names the playbook and the market, and asks questions
    expect(r.reply).toMatch(/playbook/);
    expect(r.reply).toMatch(/market/);
    expect(r.readyToCompile).toBe(false);
    // AI did: one intake.turn run, logged with cost and prompt version
    const runs = await container.db.select().from(aiRuns).where(eq(aiRuns.task, "intake.turn"));
    expect(runs).toHaveLength(1);
    // the prompt's own version, so a new version of the intake prompt does not break the scenario
    expect(runs[0].promptVersion).toBe(intakeTurnPrompt.version);
    expect(runs[0].status).toBe("ok");
    // events
    expect(await eventsOf("intake.started")).toHaveLength(1);
    expect(await eventsOf("intake.turn_completed")).toHaveLength(1);
  });

  it("Step 1b, Intake refuses unlawful criteria and explains why", async () => {
    const r = (await (await json("POST", `/api/v1/intake/sessions/${sessionId}/messages`, { message: "Also only recent grads please, native English speakers." })).json()) as { reply: { assistantMessage: string; factsExtracted: { declinedCriteria: Array<{ requested: string }> } } };
    expect(r.reply.assistantMessage).toMatch(/can't build/);
    expect(r.reply.factsExtracted.declinedCriteria.length).toBeGreaterThanOrEqual(2);
  });

  it("Step 1c, Failure path: an invalid AI output is retried once and reported honestly when it fails again", async () => {
    container.fake!.failNext("intake.turn", "invalid");
    container.fake!.failNext("intake.turn", "invalid");
    const r = (await (await json("POST", `/api/v1/intake/sessions/${sessionId}/messages`, { message: "It's a replacement, our hygienist moved. Ceiling is $58." })).json()) as { reply: { error?: string; recovery?: string } };
    expect(r.reply.error).toBeTruthy();
    expect(r.reply.recovery).toMatch(/recruiter/);
    const failed = await container.db.select().from(aiRuns).where(eq(aiRuns.status, "invalid_output"));
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(await eventsOf("ai.run_failed")).toHaveLength(1);
  });

  it("Step 2, Role packet: compiled with the dental playbook, jurisdictions, notices, ceiling; approval requested; policy role_packet.approve = approval", async () => {
    const ok = (await (await json("POST", `/api/v1/intake/sessions/${sessionId}/messages`, { message: "It's a replacement, our hygienist moved. Ceiling is $58. Interviewers: Dr. Chen and me. I decide. Must-haves: active CA RDH license, perio experience. Deal-breakers: unreliable attendance." })).json()) as { reply: { readyToCompile: boolean } };
    expect(ok.reply.readyToCompile).toBe(true);
    const compiled = (await (await json("POST", `/api/v1/intake/sessions/${sessionId}/compile`)).json()) as { roleId: string; version: number; packet: { compensation: { ceiling: number }; compliance: { jurisdictions: string[]; notices: string[] }; requirements: { mustHaves: unknown[]; eligibility: Array<{ type: string }> }; provenance: { playbookId?: string } }; workflowRunId: string };
    roleId = compiled.roleId;
    expect(compiled.packet.compensation.ceiling).toBe(58);
    expect(compiled.packet.compliance.jurisdictions).toEqual(expect.arrayContaining(["US-CA"]));
    expect(compiled.packet.compliance.notices).toEqual(expect.arrayContaining(["ai_use", "privacy", "pay_transparency"]));
    expect(compiled.packet.requirements.mustHaves.length).toBeLessThanOrEqual(6);
    expect(compiled.packet.requirements.eligibility.some((e) => e.type === "license")).toBe(true);
    expect(compiled.packet.provenance.playbookId).toBe("dental@v1");
    // data: role pending approval, packet v1 proposed, approval request pending with the owner's roles
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    expect(role.status).toBe("pending_approval");
    const [pv] = await container.db.select().from(rolePackets).where(eq(rolePackets.roleId, roleId));
    expect(pv.status).toBe("proposed");
    const [req] = await container.db.select().from(approvalRequests).where(eq(approvalRequests.roleId, roleId));
    expect(req.status).toBe("pending");
    expect(req.requiredRoles).toEqual(["owner", "admin", "hiring_manager"]);
    // events and workflow
    expect(await eventsOf("role_packet.proposed")).toHaveLength(1);
    expect(await eventsOf("approval.requested")).toHaveLength(1);
    const [run] = await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, compiled.workflowRunId));
    expect(run.status).toBe("waiting");
    expect(run.wait?.kind).toBe("human");
  });

  it("Step 3, Approval: only the owner can approve; approval opens the role and emits role.opened", async () => {
    const wrong = await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 2 });
    expect(wrong.status).toBe(409);
    const ok = await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "Good." });
    expect(ok.status).toBe(200);
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    expect(role.status).toBe("open");
    expect(await eventsOf("approval.granted")).toHaveLength(1);
    expect(await eventsOf("role.opened")).toHaveLength(1);
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, 1)));
    expect(pv.status).toBe("approved");
  });

  it("Step 4, Posting: the careers page is live only after its URL was checked; Google for Jobs is submitted; email-in is failed in development (no inbound domain); the board the role plan names (Indeed) waits at ready to post with its own tracked link, and an ITS recruiter has the task of posting it; policy role.publish = auto", async () => {
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { postings: Array<{ channel: string; status: string; instructions: string | null; steps: string[]; error: string | null }> };
    const s = Object.fromEntries(role.postings.map((p) => [p.channel, p.status]));
    // only the boards the role plan names are prepared (founder decision Q11): the dental playbook names Indeed
    expect(s).toEqual({ careers_page: "live_verified", google_jobs: "submitted_integration", email_in: "failed", indeed: "ready_to_post" });
    expect(role.postings.find((p) => p.channel === "indeed")!.instructions).toMatch(/own account/i);
    expect(role.postings.find((p) => p.channel === "indeed")!.steps.join(" ")).toMatch(/\/a\/[a-z0-9]{12}/);
    expect(role.postings.find((p) => p.channel === "email_in")!.error).toMatch(/inbound mail domain/i);
    // the careers page went ready to post, then posted (its URL is known), then live once the check answered with the title
    expect((await eventsOf("posting.ready_to_post")).length).toBe(2);
    expect((await eventsOf("posting.posted_manually")).length).toBe(1);
    expect((await eventsOf("posting.live_verified")).length).toBe(1);
    expect((await eventsOf("posting.submitted_integration")).length).toBe(1);
    expect((await eventsOf("posting.failed")).length).toBe(1);
    expect((await eventsOf("application_link.created")).length).toBe(1);
    // ITS posts it from the company's own account (plan D3): one task in the ITS queue, with no access to candidates
    const tasks = await container.db.select().from(recruiterEscalations).where(and(eq(recruiterEscalations.roleId, roleId), eq(recruiterEscalations.kind, "post_job")));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].contextSnapshot).not.toHaveProperty("candidate");
    const page = await app.request(`/careers/${slug}/jobs/${roleId}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("JobPosting");
  });

  it("Step 5, Application and acknowledgment: candidate applies on a phone; confirmation with AI disclosure within the workflow; policy message.send_templated = auto", async () => {
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    const form = new FormData();
    form.set("firstName", "Maria"); form.set("lastName", "Reyes"); form.set("email", "maria.reyes@example.com"); form.set("phone", "949-555-0100"); form.set("smsConsent", "yes");
    form.set("resume", new File(["Maria Reyes, RDH\nRegistered Dental Hygienist at Smile Bright Dental 2019 - present\nRDH license CA active\nBLS current\nDentrix, periodontal charting"], "maria.txt", { type: "text/plain" }));
    for (const r of role.currentPacket.packet.requirements.eligibility) form.set(`elig_${r.key}`, "yes");
    form.set("acknowledged", "yes");
    const res = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: form });
    expect(res.status).toBe(302);
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    // Slice 2 continues the pipeline: eligible → assessed → invited to a screen (policy auto_notify)
    expect(a.stage).toBe("screen_invited");
    const comms = await container.db.select().from(communications).where(eq(communications.applicationId, a.id));
    const ack = comms.find((m) => m.templateKey === "acknowledgment")!;
    expect(ack).toBeTruthy();
    expect(ack.disclosureIncluded).toBe(true);
    const sent = (container.integrations.email as FakeEmailAdapter).sent.find((m) => m.to === "maria.reyes@example.com");
    expect(sent!.text).toMatch(/AI recruiting assistant/);
    expect(await eventsOf("application.received")).toHaveLength(1);
    expect(await eventsOf("application.acknowledged")).toHaveLength(1);
    expect(await eventsOf("consent.granted")).toHaveLength(1);
    // the candidate's status page works without a login
    const status = await app.request(`/c/status/${a.statusToken}`);
    expect(await status.text()).toMatch(/screening conversation/);
  });

  it("Step 6, Eligibility and triage: deterministic rules; resume extracted with verified quotes; AI never rejects; failure path retries extraction", async () => {
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(a.eligibility?.passed).toBe(true);
    expect(a.extraction?.licenses.map((l) => l.name)).toContain("RDH");
    for (const p of a.extraction!.positions) if (p.quote) expect("Maria Reyes, RDH\nRegistered Dental Hygienist at Smile Bright Dental 2019 - present".includes(p.quote)).toBe(true);
    expect(await eventsOf("eligibility.evaluated")).toHaveLength(1);
    expect(await eventsOf("resume.ingested")).toHaveLength(1);
    // failure injection: the provider is down for the next extraction; the workflow retries and completes
    container.fake!.failNext("resume.extract", "throw");
    const form = new FormData();
    form.set("firstName", "Luis"); form.set("lastName", "Ortega"); form.set("email", "luis@example.com");
    form.set("resume", new File(["Luis Ortega\nDental Hygienist at Harbor Dental 2020 - present"], "luis.txt", { type: "text/plain" }));
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    for (const r of role.currentPacket.packet.requirements.eligibility) form.set(`elig_${r.key}`, "yes");
    form.set("acknowledged", "yes");
    await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: form });
    const retried = await eventsOf("workflow.retried");
    expect(retried.length).toBeGreaterThanOrEqual(1);
    await advance(60_000);
    const luis = (await container.db.select().from(applications).where(eq(applications.roleId, roleId))).find((x) => x.id !== a.id)!;
    expect(luis.stage).toBe("screen_invited");
    // triage: an assessment with grounded quotes, information only (policy application.triage = auto)
    const [asmt] = await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id));
    expect(asmt.kind).toBe("triage");
    expect(asmt.result.recommendation).toBe("screen");
    expect(await eventsOf("application.triaged")).toHaveLength(2);
    expect(await eventsOf("screen.invited")).toHaveLength(2);
    expect(luis.extraction?.positions[0]?.employer).toBe("Harbor Dental");
    const failedRuns = await container.db.select().from(workflowRuns).where(eq(workflowRuns.status, "failed"));
    expect(failedRuns).toHaveLength(0);
  });

  it("Step 7, The brief tells the owner what needs them", async () => {
    const brief = (await (await json("GET", "/api/v1/brief")).json()) as { cards: Array<{ kind: string; title: string }> };
    expect(brief.cards.some((c) => c.kind === "new_applicants")).toBe(true);
    expect(brief.cards.some((c) => c.kind === "screening")).toBe(true);
    // ITS posts the board (plan D3), so the owner is not told to post it from their own account
    expect(brief.cards.some((c) => c.kind === "posting_action")).toBe(false);
    // "do it and tell me": the auto_notify invitations are in the owner's updates
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string; title: string }>;
    expect(notes.some((n) => n.kind === "screen.invited")).toBe(true);
  });

  it("Step 8, Ask a recruiter: the escalation carries the complete context and reaches the ITS queue", async () => {
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    const r = await json("POST", "/api/v1/escalations", { kind: "review", roleId, applicationId: a.id, question: "Is Maria worth a working interview?" });
    expect(r.status).toBe(201);
    const [esc] = await container.db.select().from(recruiterEscalations).where(and(eq(recruiterEscalations.roleId, roleId), eq(recruiterEscalations.kind, "review")));
    const ctx = esc.contextSnapshot as { company: { name: string }; role: { title: string }; packet: { version: number }; candidate: { name: string }; resumeText: string; timeline: unknown[] };
    expect(ctx.company.name).toBe("Brightline Dental Group");
    expect(ctx.role.title).toBe("Registered Dental Hygienist");
    expect(ctx.packet.version).toBe(1);
    expect(ctx.candidate.name).toBe("Maria Reyes");
    expect(ctx.resumeText).toMatch(/Smile Bright/);
    expect(ctx.timeline.length).toBeGreaterThan(3);
    // this request, beside the ITS task of posting the job on Indeed (Step 4)
    expect((await eventsOf("recruiter.requested")).map((e) => (e.payload as { kind: string }).kind).sort()).toEqual(["post_job", "review"]);
  });

  it("Step 9, Human decisions are human and audited: declining needs a reason; viewing a candidate is audited", async () => {
    const [luis] = (await container.db.select().from(applications).where(eq(applications.roleId, roleId))).filter((x) => x.stage === "screen_invited").slice(-1);
    await json("GET", `/api/v1/applications/${luis.id}`);
    const viewed = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "candidate.viewed"));
    expect(viewed.length).toBeGreaterThanOrEqual(1);
    const r = await json("POST", `/api/v1/applications/${luis.id}/actions`, { action: "reject", reason: "location_or_schedule", note: "Wants Tustin only." });
    expect(r.status).toBe(200);
    expect((await eventsOf("human.override")).length).toBeGreaterThanOrEqual(1);
  });

  it("Step 10, Screening: text screen with disclosure and a human alternative; ScreenAssessment with quotes; recommendation under policy (Slice 2)", async () => {
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, roleId)); // Maria, consented to texts
    expect(a.stage).toBe("screen_invited");
    const [scr] = await container.db.select().from(screens).where(eq(screens.applicationId, a.id));
    expect(scr.channel).toBe("sms");
    // candidate sees: a text with the disclosure and the first question, and an email with the web link
    const sms = (container.integrations.sms as FakeSmsAdapter).sent.find((m) => m.to === "+19495550100")!;
    expect(sms.body).toMatch(/AI assistant/);
    expect(sms.body).toMatch(/HUMAN/);
    expect((container.integrations.email as FakeEmailAdapter).sent.find((m) => m.to === "maria.reyes@example.com" && /screening conversation/.test(m.subject))!.text).toContain(`/c/screen/${scr.token}`);
    // policy: application.invite_screen = auto_notify (owner told), screen.conduct = auto
    const answers: Record<string, string> = {
      license_confirm: "Yes, my RDH license is active in California.",
      experience: "At Smile Bright I see nine patients a day, do full perio charting and radiographs, and chart in Dentrix.",
      hard_moment: "A patient panicked at the ultrasonic scaler, so I slowed down, explained every step, and hand scaled; she came back to me.",
      availability: "Monday to Friday, any hours, and I can start in two weeks.",
      pay: "I'm looking for $52 an hour.",
      why: "A steady office that respects hygienists.",
    };
    const reply = (body: string) => app.request("/webhooks/twilio/inbound", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ From: "+19495550100", To: "+15550001111", Body: body, MessageSid: `SM${Math.random()}` }) });
    for (let i = 0; i < 10; i++) {
      const [s] = await container.db.select().from(screens).where(eq(screens.id, scr.id));
      if (s.status === "completed") break;
      expect((await reply(answers[s.progress.currentQuestionKey ?? ""] ?? "Yes, that works for me.")).status).toBe(200);
    }
    const [done] = await container.db.select().from(screens).where(eq(screens.id, scr.id));
    expect(done.status).toBe("completed");
    expect(Object.keys(done.answers)).toHaveLength(6);
    const asked = done.transcript.filter((t) => t.role === "assistant" && t.questionKey).map((t) => t.questionKey);
    expect(asked).toEqual(Object.keys(answers)); // one question per message, in the packet's order
    // data stored: every candidate text is a communication; the scorecard quotes only what they said
    const comms = await container.db.select().from(communications).where(eq(communications.applicationId, a.id));
    expect(comms.filter((c) => c.direction === "inbound" && c.channel === "sms")).toHaveLength(6);
    expect(comms.filter((c) => c.direction === "outbound" && c.channel === "sms").length).toBeGreaterThanOrEqual(7);
    const asmt = (await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).find((x) => x.kind === "screen")!;
    const said = done.transcript.filter((t) => t.role === "candidate").map((t) => t.content).join("\n").toLowerCase();
    for (const f of (asmt.result as { questionFindings: Array<{ evidence?: { quote?: string } }> }).questionFindings) if (f.evidence?.quote) expect(said).toContain(f.evidence.quote.toLowerCase());
    for (const s of asmt.result.strengths) if (s.evidence.quote) expect(said).toContain(s.evidence.quote.toLowerCase());
    expect(["strong_interview", "interview"]).toContain((asmt.result as { recommendation: string }).recommendation);
    // policy application.recommend_interview = auto_notify: the stage moves and the owner is told; nobody is rejected
    expect((await container.db.select().from(applications).where(eq(applications.id, a.id)))[0].stage).toBe("interview_recommended");
    expect(await eventsOf("screen.started")).toHaveLength(1);
    expect(await eventsOf("screen.completed")).toHaveLength(1);
    expect(await eventsOf("screen.assessed")).toHaveLength(1);
    expect(await eventsOf("candidate.recommended")).toHaveLength(1);
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string; title: string }>;
    expect(notes.some((n) => n.kind === "candidate.recommended" && /Maria/.test(n.title))).toBe(true);
    expect((await container.db.select().from(aiRuns).where(eq(aiRuns.task, "screen.turn"))).length).toBeGreaterThanOrEqual(7);
  });

  it("Step 10b, Screening hand-off and failure paths: HUMAN reaches a person within 4 hours; an AI outage never strands the candidate", async () => {
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    const form = new FormData();
    form.set("firstName", "Sam"); form.set("lastName", "Nguyen"); form.set("email", "sam@example.com"); form.set("phone", "949-555-0177"); form.set("smsConsent", "yes");
    form.set("resume", new File(["Sam Nguyen\nRegistered Dental Hygienist at Bright Smiles 2017 - present\nRDH license CA active\nPerio therapy, Dentrix"], "sam.txt", { type: "text/plain" }));
    for (const r of role.currentPacket.packet.requirements.eligibility) form.set(`elig_${r.key}`, "yes");
    form.set("acknowledged", "yes");
    await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: form });
    await container.drain();
    const sam = (await container.db.select().from(applications).where(eq(applications.roleId, roleId))).find((x) => x.source === "careers_page" && x.stage === "screen_invited")!;
    expect(sam).toBeTruthy();
    const [scr] = await container.db.select().from(screens).where(eq(screens.applicationId, sam.id));
    const reply = (body: string) => app.request("/webhooks/twilio/inbound", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ From: "+19495550177", To: "+15550001111", Body: body, MessageSid: `SM${Math.random()}` }) });
    // the model is down for one turn: an honest holding message, nothing lost
    container.fake!.failNext("screen.turn", "throw");
    expect((await reply("Yes, my license is active in California.")).status).toBe(200);
    let [s] = await container.db.select().from(screens).where(eq(screens.id, scr.id));
    expect(s.status).toBe("in_progress");
    expect(s.progress.failures).toBe(1);
    const texts = (container.integrations.sms as FakeSmsAdapter).sent.filter((m) => m.to === "+19495550177");
    expect(texts.at(-1)!.body).toMatch(/went wrong on our end/);
    expect((await eventsOf("ai.run_failed")).length).toBeGreaterThanOrEqual(1);
    // the candidate sends it again and the conversation continues
    expect((await reply("Yes, my license is active in California.")).status).toBe(200);
    [s] = await container.db.select().from(screens).where(eq(screens.id, scr.id));
    expect(s.progress.failures).toBe(0);
    expect(s.answers.license_confirm).toMatch(/active/);
    // HUMAN: the conversation stops, a recruiter gets the context with a 4-hour SLA, the owner is told. What Sam texted
    // was never sent as his answers, so neither the recruiter nor the team reads it (founder decision of 9 October 2026).
    expect((await reply("Can I talk to a real person please")).status).toBe(200);
    [s] = await container.db.select().from(screens).where(eq(screens.id, scr.id));
    expect(s.status).toBe("human_requested");
    const esc = (await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, sam.id)))[0];
    expect(esc.kind).toBe("candidate_issue");
    // Four business hours (Monday to Friday, 9 to 5 Pacific), never wall-clock hours (founder decision F12).
    expect(Math.abs(Date.parse(esc.slaDueAt!) - addBusinessHours(new Date(), 4).getTime())).toBeLessThanOrEqual(2 * 60_000);
    const ctx = esc.contextSnapshot as { screens: Array<{ transcript: unknown[]; answers: Record<string, string>; answersShared: boolean }> };
    expect(ctx.screens[0]).toMatchObject({ answersShared: false, answers: {}, transcript: [] });
    expect(JSON.stringify(ctx)).not.toContain("license is active in California");
    expect(await eventsOf("screen.human_requested")).toHaveLength(1);
    expect((container.integrations.sms as FakeSmsAdapter).sent.filter((m) => m.to === "+19495550177").at(-1)!.body).toMatch(/person/);
  });

  it("Step 10c, Nothing rots: the stuck-role detector nudges the owner up a ladder and, if ignored, brings in a recruiter; policy intervention.nudge sets the cooldown", async () => {
    const days = 86_400_000;
    const rungs = async () => (await container.db.select().from(interventions).where(eq(interventions.detector, "candidates_waiting"))).sort((x, y) => (x.sentAt < y.sentAt ? -1 : 1)).map((i) => i.ladderLevel);
    // the ladder's own email reaches whoever wants roles that need attention as they happen (plan B3); Dana does
    expect((await json("PUT", "/api/v1/notifications/preferences", { preferences: [{ group: "stuck", cadence: "immediate" }] })).status).toBe(200);
    await advance(4 * days); // Maria has been "recommended for interview" with no owner action
    expect(await rungs()).toEqual(["brief"]);
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string }>;
    expect(notes.some((n) => n.kind === "stuck.candidates_waiting")).toBe(true);
    await advance(24 * 3600_000); // inside the 48h cooldown
    expect(await rungs()).toEqual(["brief"]);
    await advance(25 * 3600_000);
    expect(await rungs()).toEqual(["brief", "message"]);
    expect((container.integrations.email as FakeEmailAdapter).sent.find((m) => m.to === "dana@brightline.test" && /waiting on you/.test(m.subject))).toBeTruthy();
    await advance(49 * 3600_000);
    expect(await rungs()).toEqual(["brief", "message", "offer_recruiter"]);
    await advance(49 * 3600_000);
    expect(await rungs()).toEqual(["brief", "message", "offer_recruiter", "escalation"]);
    expect((await container.db.select().from(recruiterEscalations)).some((e) => e.kind === "stuck_role")).toBe(true);
    expect((await eventsOf("intervention.sent")).length).toBeGreaterThanOrEqual(4);
  });
  /**
   * Steps 11 to 13 are release 1 (docs/spec/15). Steps 12's recording and scorecards, 13's debrief and steps 14 to 16
   * are deferred with a recorded reason, risk, owner and release; none of them is a security, privacy, tenant-isolation,
   * authentication, communication, scheduling, accessibility or audit test.
   */
  let interviewId = "";
  let scheduleToken = "";
  let ownerUserId = "";

  it("Step 11, Scheduling: the owner approves the round and interviewers; times go out; the candidate picks in her own zone; booked once, confirmed with an invitation, reminded, closed (Slice 5)", async () => {
    const H = 3600_000;
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(a.stage).toBe("interview_recommended");
    ownerUserId = ((await (await json("GET", "/api/v1/auth/me")).json()) as { user: { id: string } }).user.id;
    // preconditions: the owner declares hours (no calendar connected in this scenario)
    expect((await json("PUT", "/api/v1/me/availability", { timezone: "America/Los_Angeles", windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 3 })).status).toBe(200);
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { interviews: { plan: Array<{ key: string; title: string }> } } } };
    const round = role.currentPacket.packet.interviews.plan[0];
    // human approval: the click is the approval; policy interview.request never drops below approval. Steps 10b and 10c
    // moved the clock by days, so Dana signs in again first: a rule change needs a fresh sign-in (A12).
    await signIn();
    expect((await json("PUT", "/api/v1/policies", { actionType: "interview.request", level: "auto", approverRoles: [] })).status).toBe(400);
    const r = await json("POST", `/api/v1/applications/${a.id}/interviews`, { roundKey: round.key, interviewerUserIds: [ownerUserId], linkSource: "pasted", meetingUrl: "https://meet.example.com/brightline-rdh" });
    expect(r.status, await r.clone().text()).toBe(201);
    interviewId = ((await r.json()) as { id: string }).id;
    await container.drain();
    let iv = (await container.db.select().from(interviews).where(eq(interviews.id, interviewId)))[0];
    expect(iv.status).toBe("scheduling");
    expect(iv.offeredSlots.length).toBeGreaterThanOrEqual(6);
    scheduleToken = iv.scheduleToken!;
    // audit: the approval and the offer are events; nothing was decided by software
    expect((await eventsOf("interview.requested")).length).toBe(1);
    expect((await eventsOf("human.override")).some((e) => (e.payload as { action: string }).action === "interview.request")).toBe(true);
    expect((await eventsOf("interview.slots_offered")).length).toBe(1);
    // candidate sees: a disclosed email with the times in her zone and one link
    const offer = (container.integrations.email as FakeEmailAdapter).sent.find((m) => m.to === "maria.reyes@example.com" && /Pick a time/.test(m.subject))!;
    expect(offer.text).toContain(`/c/schedule/${scheduleToken}`);
    expect(offer.text).toMatch(/AI|assistant/i);
    const page = await app.request(`/c/schedule/${scheduleToken}?tz=America/Los_Angeles`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="slotId"');
    // she picks the second time
    const slot = iv.offeredSlots[1];
    const pick = await app.request(`/c/schedule/${scheduleToken}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ slotId: slot.id, timezone: "America/Los_Angeles" }).toString() });
    expect(pick.status).toBe(302);
    await container.drain();
    iv = (await container.db.select().from(interviews).where(eq(interviews.id, interviewId)))[0];
    expect(iv.status).toBe("scheduled");
    expect(Date.parse(iv.startsAt!)).toBe(Date.parse(slot.startsAt));
    expect(iv.meetingUrl).toBe("https://meet.example.com/brightline-rdh"); // pasted link kept; no calendar event because none is connected
    expect((await container.db.select().from(applications).where(eq(applications.id, a.id)))[0].stage).toBe("interview_scheduled");
    // data: one confirmation with the invitation attached; the interviewer gets an email too
    const confirm = (container.integrations.email as FakeEmailAdapter).sent.find((m) => m.to === "maria.reyes@example.com" && /^Confirmed:/.test(m.subject))!;
    expect(confirm.attachments?.[0].filename).toBe("interview.ics");
    expect(Buffer.from(confirm.attachments![0].contentBase64, "base64").toString("utf8")).toContain("BEGIN:VEVENT");
    expect((container.integrations.email as FakeEmailAdapter).sent.some((m) => m.to === "dana@brightline.test" && /Interview booked/.test(m.subject))).toBe(true);
    expect((await eventsOf("interview.booked")).length).toBe(1);
    expect((await eventsOf("interview.confirmed")).length).toBe(1);
    // timers: reminders the day before and two hours before; close an hour after the end
    const startMs = Date.parse(iv.startsAt!);
    setClock(startMs - 23 * H - BASE);
    await container.drain();
    expect((container.integrations.email as FakeEmailAdapter).sent.some((m) => m.to === "maria.reyes@example.com" && /^Tomorrow:/.test(m.subject))).toBe(true);
    setClock(startMs - 1.5 * H - BASE);
    await container.drain();
    expect((container.integrations.email as FakeEmailAdapter).sent.some((m) => m.to === "maria.reyes@example.com" && /^Soon:/.test(m.subject))).toBe(true);
    setClock(Date.parse(iv.endsAt!) + 2 * H - BASE);
    await container.drain();
    iv = (await container.db.select().from(interviews).where(eq(interviews.id, interviewId)))[0];
    expect(iv.status).toBe("completed");
    expect((await container.db.select().from(applications).where(eq(applications.id, a.id)))[0].stage).toBe("interview_complete");
    expect((await eventsOf("interview.reminder_sent")).length).toBe(2);
    expect((await eventsOf("interview.completed")).length).toBe(1);
  });

  it("Step 12, Interview: the interviewer is briefed and reminded; what happened is recorded by a person; nothing is recorded or scored by software (recording and scorecards deferred to release 2)", async () => {
    const notes = await container.db.select().from(notifications).where(eq(notifications.userId, ownerUserId));
    expect(notes.some((n) => n.kind === "interview.confirmed")).toBe(true);
    expect(notes.some((n) => n.kind === "interview.reminder")).toBe(true);
    expect(notes.some((n) => n.kind === "interview.outcome")).toBe(true);
    const r = await json("POST", `/api/v1/interviews/${interviewId}/outcome`, { outcome: "happened" });
    expect(r.status).toBe(200);
    const iv = (await container.db.select().from(interviews).where(eq(interviews.id, interviewId)))[0];
    expect(iv.outcome).toBe("happened");
    expect(iv.status).toBe("completed");
    expect(iv.recording).toEqual({}); // no recording in release 1 (founder restriction)
    expect(iv.transcriptDocumentId).toBeNull();
    expect((await eventsOf("interview.outcome_recorded")).length).toBe(1);
    expect((await container.db.select().from(aiRuns)).some((run) => /interview|scorecard/.test(run.task))).toBe(false);
  });

  it("Step 13, Decision: the decision after the interview is a person's; 'hired' needs the start date agreed outside the app (plan H1); declining still needs a reason (debrief deferred to release 2)", async () => {
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    const hired = await json("POST", `/api/v1/applications/${a.id}/decision`, { decision: "hired" });
    expect(hired.status).toBe(400);
    expect(((await hired.json()) as { error: { code: string } }).error.code).toBe("hire_date_required");
    expect(((await json("POST", `/api/v1/applications/${a.id}/decision`, { decision: "not_moving_forward" })).status)).toBe(400);
    const r = await json("POST", `/api/v1/applications/${a.id}/decision`, { decision: "finalist", note: "Calm under pressure; strong charting." });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { stage: string }).stage).toBe("finalist");
    expect((await container.db.select().from(applications).where(eq(applications.id, a.id)))[0].stage).toBe("finalist");
    const iv = (await container.db.select().from(interviews).where(eq(interviews.id, interviewId)))[0];
    expect(iv.decision).toBe("finalist");
    expect((await eventsOf("interview.decision_recorded")).length).toBe(1);
    expect((await eventsOf("human.override")).some((e) => (e.payload as { action: string }).action === "interview.decision")).toBe(true);
    // audit history: every step of the journey is on the application's timeline, actor kinds intact
    const detail = (await (await json("GET", `/api/v1/applications/${a.id}`)).json()) as { timeline: Array<{ type: string; actor: { kind: string } }>; interviews: Array<{ decision: string | null }> };
    expect(detail.interviews[0].decision).toBe("finalist");
    const kinds = new Set(detail.timeline.map((e) => e.actor.kind));
    expect(kinds.has("user")).toBe(true);
    expect(kinds.has("system") || kinds.has("agent")).toBe(true);
  });

  /** Deferred steps: each carries the reason, the risk to release 1, the owner and the target release (docs/spec/15). */
  const DEFERRED = [
    { step: "12b", what: "consented interview recording, transcript and draft scorecard confirmed by the interviewer", reason: "outside release-1 scope and the founder's restriction on activating recording", risk: "none to release 1: outcomes are recorded by a person", owner: "Nadine (scope), Claude (build)", release: 2, category: "product" },
    { step: "13b", what: "debrief showing disagreements and calibration memory", reason: "depends on scorecards (release 2)", risk: "none to release 1", owner: "Nadine (scope), Claude (build)", release: 2, category: "product" },
    { step: "14", what: "offer drafted within the ceiling, approved, sent, accepted; counter is human", reason: "outside release-1 scope (PRD §3)", risk: "none to release 1: offers happen outside the product and the decision is recorded", owner: "Nadine (scope), Claude (build)", release: 2, category: "product" },
    { step: "15", what: "onboarding handoff or HRIS creation, reminders, 30/60/90 outcomes", reason: "release 3 by scope", risk: "none to release 1", owner: "Nadine (scope), Claude (build)", release: 3, category: "product" },
    { step: "16", what: "recruiter takeover with a policy overlay and handback", reason: "release 3 by scope; scoped, time-limited recruiter access is already built and tested", risk: "none to release 1", owner: "Nadine (scope), Claude (build)", release: 3, category: "product" },
  ] as const;
  const NEVER_DEFERRED = ["security", "privacy", "tenant-isolation", "authentication", "communication", "scheduling", "accessibility", "audit"];

  it("Deferred steps are recorded with reason, risk, owner and release, and none is a security, privacy, tenant-isolation, authentication, communication, scheduling, accessibility or audit test", () => {
    for (const d of DEFERRED) {
      expect(d.reason.length).toBeGreaterThan(10);
      expect(d.risk.length).toBeGreaterThan(5);
      expect(d.owner).toMatch(/Nadine/);
      expect(d.release).toBeGreaterThan(1);
      expect(NEVER_DEFERRED).not.toContain(d.category);
    }
  });
  it.skip("Step 12b [deferred to release 2, see DEFERRED]: consented recording and a draft scorecard confirmed by the interviewer", () => {});
  it.skip("Step 13b [deferred to release 2, see DEFERRED]: debrief with disagreements and calibration memory", () => {});
  it.skip("Step 14 [deferred to release 2, see DEFERRED]: offer drafted within the ceiling, approved, sent, accepted; counter is human", () => {});
  it.skip("Step 15 [deferred to release 3, see DEFERRED]: onboarding handoff or HRIS, reminders, 30/60/90 outcomes", () => {});
  it.skip("Step 16 [deferred to release 3, see DEFERRED]: recruiter takeover overlay and handback", () => {});
});
