import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addBusinessHours } from "@ros/core";
import { and, eq } from "drizzle-orm";
import { aiRuns, applications, approvalRequests, assessments, candidates, entitlements, events, interventions, recruiterEscalations, screens, workflowRuns, companies } from "@ros/db";
import type { FakeEmailAdapter, FakeSmsAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * Slice 2 through the HTTP layer: evidence-based assessment → screening (web chat and SMS) → scorecard →
 * recommendation under policy → nudges when a role goes quiet. Every AI action is information; people decide.
 */
describe("Slice 2 API: assessment, screening, nudges", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let slug = "";
  let roleId = "";
  let elig: Array<{ key: string }> = [];
  const BASE = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return d.getTime(); })(); // noon Pacific: inside texting hours
  let offset = 0;
  const setClock = (ms: number) => { offset = ms; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset); };
  const advance = async (ms: number) => { setClock(offset + ms); await container.drain(); };

  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const form = (path: string, fields: Record<string, string>) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: "" }, body: new URLSearchParams(fields) });
  const eventsOf = async (type: string) => container.db.select().from(events).where(eq(events.type, type));
  const emailOutbox = () => (container.integrations.email as FakeEmailAdapter).sent;
  const smsOutbox = () => (container.integrations.sms as FakeSmsAdapter).sent;

  async function apply(p: { first: string; last: string; email: string; phone?: string; sms?: boolean; resume?: string; noResume?: string; answers?: Record<string, string> }) {
    const fd = new FormData();
    fd.set("firstName", p.first); fd.set("lastName", p.last); fd.set("email", p.email);
    if (p.phone) fd.set("phone", p.phone);
    if (p.sms) fd.set("smsConsent", "yes");
    if (p.resume) fd.set("resume", new File([p.resume], `${p.first.toLowerCase()}.txt`, { type: "text/plain" }));
    if (p.noResume) fd.set("noResume", p.noResume);
    for (const r of elig) fd.set(`elig_${r.key}`, p.answers?.[r.key] ?? "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    const res = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    expect(res.status).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, p.email.toLowerCase()));
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id)));
    return a;
  }
  const reload = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];
  const screenOf = async (applicationId: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, applicationId))).sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))[0];

  const MARIA_RESUME = `Maria Reyes, RDH\nmaria.reyes@example.com | (949) 555-0100\n\nRegistered Dental Hygienist at Smile Bright Dental 2019 - present\nDental Hygienist at Coastal Family Dentistry 2015 - 2019\n\nLicenses: RDH license CA #RDH12345, active\nCertifications: BLS/CPR current\nSkills: Dentrix, periodontal charting, digital radiography, perio maintenance`;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    setClock(0);
    const { devLink } = (await (await json("POST", "/api/v1/auth/magic-link", { email: "dana@brightline.test" })).json()) as { devLink: string };
    const consume = await json("POST", "/api/v1/auth/magic-link/consume", { token: new URL(devLink).searchParams.get("token") });
    cookie = consume.headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json("POST", "/api/v1/companies", { name: "Brightline Dental Group", vertical: "dental", sizeBand: "100-199", ownerName: "Dana Whitfield", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { slug: string };
    slug = co.slug;
    const c1 = (await (await json("POST", "/api/v1/intake/conversation/messages", { message: "I need a dental hygienist in Irvine. Full time. $45 to $55 an hour. I need someone who can start within 30 days." })).json()) as { intakeSessionId: string };
    await json("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/messages`, { message: "It's a replacement, our hygienist moved. Ceiling is $58. Interviewers: Dr. Chen and me. I decide. Must-haves: active CA RDH license, perio experience. Deal-breakers: can't work Saturdays." });
    const compiled = (await (await json("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/compile`)).json()) as { roleId: string };
    roleId = compiled.roleId;
    await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1 });
    await container.drain();
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { status: string; currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    expect(role.status).toBe("open");
    elig = role.currentPacket.packet.requirements.eligibility;
  });
  afterAll(async () => { await container.close(); });

  let mariaId = "";
  let mariaToken = "";

  it("assesses an eligible applicant with grounded evidence and invites them to a screen by email (no SMS consent)", async () => {
    const a = await apply({ first: "Maria", last: "Reyes", email: "maria.reyes@example.com", resume: MARIA_RESUME });
    mariaId = a.id;
    expect(a.stage).toBe("screen_invited");
    const [asmt] = await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id));
    expect(asmt.kind).toBe("triage");
    expect(asmt.result.recommendation).toBe("screen");
    expect(asmt.result.strengths.length).toBeGreaterThan(0);
    for (const s of asmt.result.strengths) expect(MARIA_RESUME.toLowerCase().replace(/\s+/g, " ")).toContain(s.evidence.quote!.toLowerCase().replace(/\s+/g, " "));
    const scr = await screenOf(a.id);
    mariaToken = scr.token;
    expect(scr.status).toBe("invited");
    expect(scr.channel).toBe("web");
    const invite = emailOutbox().find((m) => m.to === "maria.reyes@example.com" && /screening conversation/.test(m.subject))!;
    expect(invite.text).toContain(`/c/screen/${scr.token}`);
    expect(invite.text).toMatch(/HUMAN/);
    expect(invite.text).toMatch(/AI recruiting assistant/);
    expect(smsOutbox().length).toBe(0);
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string; title: string }>;
    expect(notes.some((n) => n.kind === "screen.invited" && /Maria Reyes/.test(n.title))).toBe(true);
    const brief = (await (await json("GET", "/api/v1/brief")).json()) as { cards: Array<{ kind: string; title: string }> };
    expect(brief.cards.some((c) => c.kind === "screening" && /1 invited/.test(c.title))).toBe(true);
    expect(await eventsOf("application.triaged")).toHaveLength(1);
    expect(await eventsOf("screen.invited")).toHaveLength(1);
  });

  it("runs the web screening conversation: disclosure first, one question at a time, answers recorded, scorecard with grounded quotes, recommendation under policy", async () => {
    const page = await app.request(`/c/screen/${mariaToken}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toMatch(/AI assistant/);
    expect(html).toMatch(/HUMAN/);
    expect(html).toMatch(/0 of \d+ answered/);
    let scr = await screenOf(mariaId);
    expect(scr.transcript[0].role).toBe("assistant");
    expect(scr.transcript.filter((t) => t.role === "assistant")).toHaveLength(1);
    expect(scr.progress.askedKeys).toHaveLength(1);

    const answers: Record<string, string> = {
      license_confirm: "Yes, my RDH license is active in California, number RDH12345.",
      experience: "At Smile Bright I see eight to ten patients a day, do full perio charting and radiographs, and chart everything in Dentrix.",
      hard_moment: "A patient was terrified of the ultrasonic scaler, so I slowed down, explained each step, and hand scaled; she rebooked with me.",
      availability: "Monday to Friday, any hours, and I can start in two weeks.",
      pay: "I'm looking for $52 an hour.",
      why: "A stable office that respects hygienists and a consistent schedule.",
    };
    for (let i = 0; i < 10; i++) {
      scr = await screenOf(mariaId);
      if (scr.status === "completed") break;
      const key = scr.progress.currentQuestionKey ?? "";
      const res = await form(`/c/screen/${mariaToken}`, { message: answers[key] ?? "Yes, that works for me, and I am happy to share more if it helps." });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).not.toMatch(/error=/);
    }
    scr = await screenOf(mariaId);
    expect(scr.status).toBe("completed");
    expect(Object.keys(scr.answers).sort()).toEqual(Object.keys(answers).sort());
    expect(scr.answers.pay).toBe(answers.pay);
    // one question per assistant message, in the packet's order
    const asked = scr.transcript.filter((t) => t.role === "assistant" && t.questionKey).map((t) => t.questionKey);
    expect(asked).toEqual(Object.keys(answers));

    const a = await reload(mariaId);
    expect(a.stage).toBe("interview_recommended");
    const asmts = await container.db.select().from(assessments).where(eq(assessments.applicationId, mariaId));
    const screenAsmt = asmts.find((x) => x.kind === "screen")!;
    expect(screenAsmt).toBeTruthy();
    expect(["strong_interview", "interview"]).toContain((screenAsmt.result as { recommendation: string }).recommendation);
    const candidateText = scr.transcript.filter((t) => t.role === "candidate").map((t) => t.content).join("\n").toLowerCase();
    for (const f of (screenAsmt.result as { questionFindings: Array<{ evidence?: { quote?: string } }> }).questionFindings) if (f.evidence?.quote) expect(candidateText).toContain(f.evidence.quote.toLowerCase());
    expect((screenAsmt.result as { compensationExpectation: { withinRange: string } }).compensationExpectation.withinRange).toBe("yes");
    expect(a.latestAssessmentId).toBe(screenAsmt.id);
    expect(await eventsOf("screen.started")).toHaveLength(1);
    expect(await eventsOf("screen.completed")).toHaveLength(1);
    expect(await eventsOf("screen.assessed")).toHaveLength(1);
    expect(await eventsOf("candidate.recommended")).toHaveLength(1);
    const turns = await container.db.select().from(aiRuns).where(eq(aiRuns.task, "screen.turn"));
    expect(turns).toHaveLength(Object.keys(answers).length + 1);
    expect(await container.db.select().from(aiRuns).where(eq(aiRuns.task, "screen.assess"))).toHaveLength(1);
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string; title: string }>;
    expect(notes.some((n) => n.kind === "candidate.recommended" && /Maria Reyes/.test(n.title))).toBe(true);
    expect(await (await app.request(`/c/screen/${mariaToken}`)).text()).toMatch(/that is everything/i);
    expect(await (await app.request(`/c/status/${a.statusToken}`)).text()).toMatch(/Recommended for interview/);
    const detail = (await (await json("GET", `/api/v1/applications/${mariaId}`)).json()) as { screens: Array<{ status: string; transcript: unknown[] }>; assessments: Array<{ kind: string }> };
    expect(detail.screens[0].status).toBe("completed");
    expect(detail.assessments.map((x) => x.kind).sort()).toEqual(["screen", "triage"]);
    const run = (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "screen")))[0];
    expect(run.status).toBe("completed");
  });

  let luisId = "";
  it("invites a consenting candidate by text inside contact hours, and hands over to a person when they reply HUMAN (4-hour SLA)", async () => {
    const a = await apply({ first: "Luis", last: "Ortega", email: "luis@example.com", phone: "949-555-0199", sms: true, resume: "Luis Ortega\nRegistered Dental Hygienist at Harbor Dental 2020 - present\nRDH license CA active\nPerio maintenance, Dentrix" });
    luisId = a.id;
    expect(a.stage).toBe("screen_invited");
    const scr = await screenOf(a.id);
    expect(scr.channel).toBe("sms");
    const opening = smsOutbox().find((m) => m.to === "+19495550199")!;
    expect(opening.body).toMatch(/AI assistant/);
    expect(opening.body).toMatch(/HUMAN/);
    expect(scr.transcript[0].role).toBe("assistant");
    const r = await form("/webhooks/twilio/inbound", { From: "+19495550199", To: "+15550001111", Body: "HUMAN", MessageSid: "SM1" });
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/<Response>/);
    const after = await screenOf(a.id);
    expect(after.status).toBe("human_requested");
    expect(after.transcript.map((t) => t.role)).toEqual(["assistant", "candidate", "assistant"]);
    const [esc] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, a.id));
    expect(esc.kind).toBe("candidate_issue");
    // Four business hours (Monday to Friday, 9 to 5 Pacific), never wall-clock hours (founder decision F12).
    expect(Math.abs(Date.parse(esc.slaDueAt!) - addBusinessHours(new Date(), 4).getTime())).toBeLessThanOrEqual(2 * 60_000);
    expect(Date.parse(esc.slaDueAt!)).toBeGreaterThan(Date.now());
    expect(smsOutbox().filter((m) => m.to === "+19495550199").at(-1)!.body).toMatch(/person/);
    expect(await eventsOf("screen.human_requested")).toHaveLength(1);
    const run = (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "screen"))).find((x) => (x.state as { applicationId: string }).applicationId === a.id)!;
    expect(run.status).toBe("completed");
    expect((await reload(a.id)).stage).toBe("screening"); // he started the conversation; a person finishes it
  });

  it("honors STOP: opts the candidate out, revokes consent, and a new invitation falls back to the web", async () => {
    const before = smsOutbox().length;
    const r = await form("/webhooks/twilio/inbound", { From: "+19495550199", To: "+15550001111", Body: "STOP", MessageSid: "SM2" });
    expect(r.status).toBe(200);
    const [luis] = await container.db.select().from(candidates).where(eq(candidates.email, "luis@example.com"));
    expect(luis.preferences.smsOptOut).toBe(true);
    expect(luis.consent.sms?.granted).toBe(false);
    expect(await eventsOf("candidate.opted_out")).toHaveLength(1);
    expect(await eventsOf("consent.revoked")).toHaveLength(1);
    // the owner re-invites after the recruiter talked to him: web only now
    const inv = await json("POST", `/api/v1/applications/${luisId}/actions`, { action: "invite_screen", channel: "sms" });
    expect(inv.status).toBe(200);
    await container.drain();
    const scr = await screenOf(luisId);
    expect(scr.channel).toBe("web");
    expect(smsOutbox().length).toBe(before);
    expect((await json("POST", `/api/v1/applications/${luisId}/actions`, { action: "invite_screen" })).status).toBe(409);
  });

  it("asks first when the policy says so: invite_screen = approval becomes a decision the owner approves from the brief", async () => {
    expect((await json("PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "approval", approverRoles: ["owner"] })).status).toBe(200);
    const a = await apply({ first: "Ana", last: "Lopez", email: "ana@example.com", resume: "Ana Lopez\nRegistered Dental Hygienist at Coastal Dental 2018 - present\nRDH license CA active\nPerio charting, Eaglesoft" });
    expect(a.stage).toBe("triaged");
    const [req] = await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.applicationId, a.id), eq(approvalRequests.status, "pending")));
    expect(req.actionType).toBe("application.invite_screen");
    const brief = (await (await json("GET", "/api/v1/brief")).json()) as { cards: Array<{ kind: string; title: string; actions: Array<{ path: string; body?: Record<string, unknown> }> }> };
    const card = brief.cards.find((c) => c.kind === "decision" && /Invite to a screen/.test(c.title))!;
    expect(card).toBeTruthy();
    const decide = await json("POST", card.actions[0].path, card.actions[0].body);
    expect(decide.status).toBe(200);
    await container.drain();
    expect((await reload(a.id)).stage).toBe("screen_invited");
    expect((await screenOf(a.id)).status).toBe("invited");
    expect((await json("PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "auto_notify", approverRoles: [] })).status).toBe(200);
  });

  let priyaId = "";
  it("reminds once and then expires a screen nobody answers, and tells the owner", async () => {
    const a = await apply({ first: "Priya", last: "Shah", email: "priya@example.com", noResume: "Registered dental hygienist for six years with perio charting and Dentrix experience, active CA RDH license." });
    priyaId = a.id;
    expect(a.stage).toBe("screen_invited");
    const scr = await screenOf(a.id);
    expect(scr.status).toBe("invited");
    await advance(49 * 3600_000);
    const reminded = await screenOf(a.id);
    expect(reminded.status).toBe("reminded");
    expect(emailOutbox().find((m) => m.to === "priya@example.com" && /Reminder/.test(m.subject))).toBeTruthy();
    // Maria's completed screen and Luis's handed-over screen are untouched by the timers
    expect((await screenOf(mariaId)).status).toBe("completed");
    await advance(73 * 3600_000);
    const expired = await screenOf(a.id);
    expect(expired.status).toBe("expired");
    expect((await eventsOf("screen.expired")).filter((e) => e.subjectId === expired.id)).toHaveLength(1);
    expect((await reload(a.id)).stage).toBe("screen_invited");
    expect(await (await app.request(`/c/screen/${expired.token}`)).text()).toMatch(/expired/);
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string; title: string }>;
    expect(notes.some((n) => n.kind === "screen.expired" && /Priya Shah/.test(n.title))).toBe(true);
    expect(emailOutbox().filter((m) => m.to === "priya@example.com" && /Reminder/.test(m.subject))).toHaveLength(1);
  });

  let samId = "";
  it("stops inviting when the plan's text screens are used up, tells the owner, and does not page a recruiter", async () => {
    const [ent] = await container.db.select().from(entitlements).where(eq(entitlements.key, "text_screens"));
    await container.db.update(entitlements).set({ used: ent.limit! }).where(eq(entitlements.id, ent.id));
    const a = await apply({ first: "Sam", last: "Nguyen", email: "sam@example.com", resume: "Sam Nguyen\nRegistered Dental Hygienist at Bright Smiles 2017 - present\nRDH license CA active\nPerio therapy, Dentrix" });
    samId = a.id;
    expect(a.stage).toBe("triaged");
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, a.id))).toHaveLength(0);
    expect(await eventsOf("entitlement.exceeded")).toHaveLength(1);
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string }>;
    expect(notes.some((n) => n.kind === "entitlement.text_screens")).toBe(true);
    expect((await container.db.select().from(recruiterEscalations)).filter((e) => e.kind !== "candidate_issue")).toHaveLength(0);
    expect((await container.db.select().from(workflowRuns).where(eq(workflowRuns.status, "failed")))).toHaveLength(0);
    await container.db.update(entitlements).set({ used: 0 }).where(eq(entitlements.id, ent.id));
  });

  let omarId = "";
  it("lets the owner decide directly when the policy is human-only: mark for interview, and refuse an invite at the wrong stage", async () => {
    await json("PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "human_only", approverRoles: [] });
    const a = await apply({ first: "Omar", last: "Haddad", email: "omar@example.com", resume: "Omar Haddad\nRegistered Dental Hygienist at Lakeside Dental 2016 - present\nRDH license CA active\nPerio charting, Open Dental" });
    omarId = a.id;
    expect(a.stage).toBe("triaged");
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string; title: string }>;
    expect(notes.some((n) => n.kind === "application.ready" && /Omar Haddad/.test(n.title))).toBe(true);
    const adv = await json("POST", `/api/v1/applications/${a.id}/actions`, { action: "advance_to_interview", note: "Strong resume, skip the screen." });
    expect(adv.status).toBe(200);
    expect((await reload(a.id)).stage).toBe("interview_recommended");
    expect((await eventsOf("candidate.recommended")).some((e) => e.subjectId === a.id && e.actor.kind === "user")).toBe(true);
    expect((await json("POST", `/api/v1/applications/${a.id}/actions`, { action: "invite_screen" })).status).toBe(409);
    await json("PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "auto_notify", approverRoles: [] });
  });

  it("nudges up the ladder when candidates wait on the owner, ends with a recruiter, and resolves when the owner acts", async () => {
    const days = 86_400_000;
    const LADDER = ["brief", "message", "offer_recruiter", "escalation"];
    const level = async (detector: string) => (await container.db.select().from(interventions).where(eq(interventions.detector, detector))).sort((x, y) => (x.sentAt < y.sentAt ? -1 : 1)).map((i) => `${i.ladderLevel}:${i.status}`);
    // Maria and Omar have been waiting on the owner since the earlier tests; the daily run may already have started the ladder.
    let rungs = await level("candidates_waiting");
    if (rungs.length === 0) { await advance(4 * days); rungs = await level("candidates_waiting"); }
    expect(rungs[0]).toBe("brief:sent");
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string; title: string }>;
    expect(notes.some((n) => n.kind === "stuck.candidates_waiting" && /waiting on you/.test(n.title))).toBe(true);
    // the cooldown (policy intervention.nudge, 48h) holds the next rung back
    const before = rungs.length;
    await advance(24 * 3600_000);
    expect((await level("candidates_waiting")).length).toBe(before);
    while (rungs.length < LADDER.length) {
      const n = rungs.length;
      await advance(49 * 3600_000);
      rungs = await level("candidates_waiting");
      expect(rungs).toEqual(LADDER.slice(0, n + 1).map((l) => `${l}:sent`));
    }
    expect(emailOutbox().find((m) => m.to === "dana@brightline.test" && /waiting on you/.test(m.subject))).toBeTruthy();
    expect(emailOutbox().find((m) => m.to === "dana@brightline.test" && /Want a recruiter/.test(m.subject))).toBeTruthy();
    const stuck = (await container.db.select().from(recruiterEscalations)).filter((e) => e.kind === "stuck_role");
    expect(stuck).toHaveLength(1);
    expect(stuck[0].question).toMatch(/waiting on you/);
    await advance(49 * 3600_000); // already escalated: no fifth rung
    expect((await level("candidates_waiting")).length).toBe(4);
    // the owner acts on everyone who was waiting; the next daily run closes the interventions
    for (const id of [mariaId, omarId, samId]) expect((await json("POST", `/api/v1/applications/${id}/actions`, { action: "reject", reason: "position_filled", note: "Hired internally." })).status).toBe(200);
    await advance(25 * 3600_000);
    expect(await level("candidates_waiting")).toEqual(["brief:resolved", "message:resolved", "offer_recruiter:resolved", "escalation:resolved"]);
    expect((await eventsOf("intervention.responded")).length).toBeGreaterThanOrEqual(4);
  });

  it("lists notifications and marks them read", async () => {
    const unread = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ id: string }>;
    expect(unread.length).toBeGreaterThan(3);
    const r = await json("POST", "/api/v1/notifications/read", { ids: unread.slice(0, 2).map((n) => n.id) });
    expect(((await r.json()) as { marked: number }).marked).toBe(2);
    const after = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ id: string }>;
    expect(after.length).toBe(unread.length - 2);
    void priyaId;
  });

  it("a Design Partner over its screen allowance keeps screening; the owner is told and nobody is paged (founder decision F8)", async () => {
    const { entitlements: ent } = await import("@ros/core");
    const [co] = await container.db.select().from(companies).limit(1);
    await ent.applyPlan(container.db, co.id, "design_partner");
    const [row] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, co.id), eq(entitlements.key, "text_screens")));
    await container.db.update(entitlements).set({ used: row.limit! }).where(eq(entitlements.id, row.id));
    await json("PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "auto_notify", approverRoles: [] });
    const a = await apply({ first: "Lena", last: "Park", email: "lena.park@example.com", resume: "Lena Park\nRegistered Dental Hygienist at Coastal Dental 2018 - present\nRDH license CA active\nPerio therapy and patient education" });
    expect(a.stage).toBe("screen_invited");
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, a.id))).toHaveLength(1);
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string; title: string }>;
    expect(notes.some((n) => n.kind === "entitlement.text_screens" && /pilot/.test(n.title))).toBe(true);
    expect((await container.db.select().from(recruiterEscalations)).filter((e) => e.kind !== "candidate_issue" && e.kind !== "stuck_role")).toHaveLength(0);
    const current = (await (await json("GET", "/api/v1/companies/current")).json()) as { plan: { name: string }; usage: Record<string, { used: number; limit: number | null }> };
    expect(current.plan.name).toBe("Design Partner");
    expect(current.usage.text_screens.used).toBeGreaterThan(current.usage.text_screens.limit!);
  });
});
