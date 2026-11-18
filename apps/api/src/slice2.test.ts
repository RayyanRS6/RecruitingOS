import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RolePacket } from "@ros/contracts";
import { SCORECARD_READINGS, composeInterviewerBrief } from "@ros/agents";
import { and, eq } from "drizzle-orm";
import { aiRuns, applications, approvalRequests, assessments, auditRecords, candidates, entitlements, events, interventions, policies, screens, workflowRuns, companies, withTenant } from "@ros/db";
import type { FakeEmailAdapter, FakeSmsAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAs, useLaterApplyFlow, usePlan } from "./test-helpers";

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
  let firstQuestionKey = "";
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
    fd.set("acknowledged", "yes");
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

  // The owner signs in with an email link. A rule change (PUT /policies) is refused from a session older than thirty
  // minutes (audit finding A12), so after a step has moved the clock by days she signs in again before changing one.
  const signIn = async () => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dana@brightline.test" }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const consume = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(devLink).searchParams.get("token") }) });
    cookie = consume.headers.get("set-cookie")!.split(";")[0];
  };

  beforeAll(async () => {
    // Texting on: this file covers the SMS screening path (decision M2 keeps texting off by default).
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    setClock(0);
    await signIn();
    const co =(await (await json("POST", "/api/v1/companies", { name: "Brightline Dental Group", vertical: "dental", sizeBand: "100-199", ownerName: "Dana Whitfield", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    slug = co.slug;
    // More people apply to this one job here than Free's five, and each of them goes on to the AI interview: a plan with no candidate limit.
    await usePlan(container, co.id, "ultra");
    // ITS's old switch, kept on the company's settings: since 20 Oct 2026 nothing reads it (every applicant takes one path).
    await useLaterApplyFlow(container, co.id);
    const c1 = (await (await json("POST", "/api/v1/intake/conversation/messages", { message: "I need a dental hygienist in Irvine. Full time. $45 to $55 an hour. I need someone who can start within 30 days." })).json()) as { intakeSessionId: string };
    await json("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/messages`, { message: "It's a replacement, our hygienist moved. Ceiling is $58. Interviewers: Dr. Chen and me. I decide. Must-haves: active CA RDH license, perio experience. Deal-breakers: can't work Saturdays." });
    const compiled = (await (await json("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/compile`)).json()) as { roleId: string };
    roleId = compiled.roleId;
    await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1 });
    await container.drain();
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { status: string; currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> }; screening: { questions: Array<{ key: string }> } } } };
    expect(role.status).toBe("open");
    elig = role.currentPacket.packet.requirements.eligibility;
    firstQuestionKey = role.currentPacket.packet.screening.questions[0].key;
  });
  afterAll(async () => { await container.close(); });

  let mariaId = "";
  let mariaToken = "";

  it("every eligible applicant gets the AI interview by itself once the résumé is read: one email with the link, on the web, and no ping to the team (20 Oct 2026, R20-4, R20-5)", async () => {
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
    expect(scr).toMatchObject({ status: "invited", channel: "web", invitedVia: "with_application" });
    expect(scr.progress.flow).toBe("one_visit");
    // the one email: thank you, the next step, the link, how it works, a person instead, the status link, the disclosure
    const mine = emailOutbox().filter((m) => m.to === "maria.reyes@example.com");
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toMatch(/^Thank you for applying: your next step for /);
    expect(mine[0].text).toContain(`/c/screen/${scr.token}`);
    expect(mine[0].text).toContain(`/c/status/${a.statusToken}`);
    expect(mine[0].text).toMatch(/Your next step is a short interview with Brightline Dental Group's AI assistant/);
    expect(mine[0].text).not.toMatch(/to qualify/i);
    expect(mine[0].text).toMatch(/HUMAN/);
    expect(mine[0].text).toMatch(/AI recruiting assistant/);
    // texts were on and she gave no consent; an automatic interview never goes by text anyway (R20-6)
    expect(smsOutbox().length).toBe(0);
    // nobody approved anything and the team was not told per person: it hears once the interview is scored (R20-8)
    expect(await container.db.select().from(approvalRequests).where(eq(approvalRequests.applicationId, a.id))).toHaveLength(0);
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string; title: string }>;
    expect(notes.filter((n) => /Maria Reyes/.test(n.title))).toHaveLength(0);
    expect(await eventsOf("application.triaged")).toHaveLength(1);
    expect(await eventsOf("screen.invited")).toHaveLength(1);
  });

  it("runs the AI interview on the web: the fixed introduction first, then the chat, Send, a scorecard with grounded quotes, and the team told once (R20-8)", async () => {
    // The emailed link opens on the fixed introduction (plan E2): it says it is the company's AI assistant, and opening it writes nothing.
    const page = await app.request(`/c/screen/${mariaToken}`);
    expect(page.status).toBe(200);
    const intro = await page.text();
    expect(intro).toMatch(/AI assistant/);
    expect(intro).toContain(`/c/screen/${mariaToken}/start`);
    expect((await screenOf(mariaId)).transcript).toHaveLength(0);
    await finishScreen(mariaId);
    const scr = await screenOf(mariaId);
    expect(scr.status).toBe("completed");
    expect(scr.progress.submittedAt).toBeTruthy();

    // A person decides who to interview (6 November 2026): a good scorecard moves nobody under the default, "Only a person"
    const a = await reload(mariaId);
    expect(a.stage).toBe("screen_complete");
    const asmts = await container.db.select().from(assessments).where(eq(assessments.applicationId, mariaId));
    const screenAsmt = asmts.find((x) => x.kind === "screen")!;
    expect(screenAsmt).toBeTruthy();
    expect(["strong_interview", "interview"]).toContain((screenAsmt.result as { recommendation: string }).recommendation);
    const candidateText = scr.transcript.filter((t) => t.role === "candidate").map((t) => t.content).join("\n").toLowerCase();
    for (const f of (screenAsmt.result as { questionFindings: Array<{ evidence?: { quote?: string } }> }).questionFindings) if (f.evidence?.quote) expect(candidateText).toContain(f.evidence.quote.toLowerCase());
    expect(a.latestAssessmentId).toBe(screenAsmt.id);
    expect(await eventsOf("screen.started")).toHaveLength(1);
    expect(await eventsOf("screen.completed")).toHaveLength(1);
    expect(await eventsOf("screen.assessed")).toHaveLength(1);
    expect(await eventsOf("candidate.recommended")).toHaveLength(1);
    // the scorecard is read three times and keeps the middle answer, like the résumé (Wave S5)
    expect(await container.db.select().from(aiRuns).where(eq(aiRuns.task, "screen.assess"))).toHaveLength(SCORECARD_READINGS);
    // the team hears about Maria once, now that her interview is scored
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string; title: string; action: { label: string; href: string } }>;
    const told = notes.filter((n) => /Maria Reyes/.test(n.title));
    expect(told.map((n) => n.title)).toEqual(["Maria Reyes finished the AI interview"]);
    // the one notice opens her page, and never a step that sets an interview up
    expect(told[0]).toMatchObject({ kind: "screen.completed", action: { label: "Review", href: `/roles/${roleId}/talent?open=${mariaId}` } });
    // the assistant's suggestion is the team's business: the candidate's page says Review, never "Interview to set up"
    const status = await (await app.request(`/c/status/${a.statusToken}`)).text();
    expect(status).toMatch(/<span>Status<\/span><strong>Review<\/strong>/);
    expect(status).not.toMatch(/Interview to set up|Recommended for interview/);
    // she is in New, a person may shortlist her, and the stage menu's Offer line names no internal step
    const row = ((await (await json("GET", `/api/v1/roles/${roleId}/applications`)).json()) as Array<{ id: string; ownerStage: string; group: string; stageMoves: Array<{ to: string; allowed: boolean; blockedReason?: string }> }>).find((x) => x.id === mariaId)!;
    expect(row).toMatchObject({ ownerStage: "new", group: "waiting_on_you" });
    expect(row.stageMoves.find((m) => m.to === "shortlist")).toMatchObject({ allowed: true });
    expect(row.stageMoves.find((m) => m.to === "offer")).toMatchObject({ allowed: false, blockedReason: "Interview them first, or mark them Hired." });
    expect((await json("POST", `/api/v1/applications/${mariaId}/actions`, { action: "set_mark", mark: "shortlist" })).status).toBe(200);
    const marked = ((await (await json("GET", `/api/v1/roles/${roleId}/applications`)).json()) as Array<{ id: string; ownerStage: string }>).find((x) => x.id === mariaId)!;
    expect(marked.ownerStage).toBe("shortlist");
    expect((await json("POST", `/api/v1/applications/${mariaId}/actions`, { action: "clear_mark" })).status).toBe(200);
    const detail = (await (await json("GET", `/api/v1/applications/${mariaId}`)).json()) as { screens: Array<{ status: string; transcript: unknown[] }>; assessments: Array<{ kind: string }> };
    expect(detail.screens[0].status).toBe("completed");
    expect(detail.assessments.map((x) => x.kind).sort()).toEqual(["screen", "triage"]);
    const run = (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "screen")))[0];
    expect(run.status).toBe("completed");
  });

  let luisId = "";

  let priyaId = "";
  it("reminds once and then closes an AI interview nobody starts: she stays under 'No AI interview yet' (R20-7), told nothing else is needed", async () => {
    const a = await apply({ first: "Priya", last: "Shah", email: "priya@example.com", noResume: "Registered dental hygienist for six years with perio charting and Dentrix experience, active CA RDH license." });
    priyaId = a.id;
    expect(a.stage).toBe("screen_invited");
    const scr = await screenOf(a.id);
    expect(scr.status).toBe("invited");
    await advance(49 * 3600_000);
    const reminded = await screenOf(a.id);
    expect(reminded.status).toBe("reminded");
    const reminder = /your AI interview is still open/;
    expect(emailOutbox().find((m) => m.to === "priya@example.com" && reminder.test(m.subject))?.text).toContain(`/c/screen/${scr.token}`);
    // Maria's completed screen and Luis's handed-over screen are untouched by the timers
    expect((await screenOf(mariaId)).status).toBe("completed");
    await advance(73 * 3600_000);
    const expired = await screenOf(a.id);
    expect(expired.status).toBe("expired");
    expect((await eventsOf("screen.expired")).filter((e) => e.subjectId === expired.id)).toHaveLength(1);
    // the link lapses: she stays where she is, "Link expired" under "No AI interview yet", and is told nothing else is needed
    expect((await reload(a.id)).stage).toBe("screen_invited");
    expect(emailOutbox().find((m) => m.to === "priya@example.com" && /has gone to the hiring team without the AI interview/.test(m.text))).toBeTruthy();
    expect(emailOutbox().filter((m) => m.to === "priya@example.com" && reminder.test(m.subject))).toHaveLength(1);
  });

  it("the month's AI interviews used up (Q17, R20-11): the email says the link follows, ITS and the owner are told, nobody is paged, and the link goes once more are added", async () => {
    // a limit of the kind an older plan has: on the public plans the AI credit is the one meter, so this path never fires
    const [ent] = await container.db.select().from(entitlements).where(eq(entitlements.key, "text_screens"));
    await container.db.update(entitlements).set({ limit: 25, used: 25 }).where(eq(entitlements.id, ent.id));
    const a = await apply({ first: "Sam", last: "Nguyen", email: "sam@example.com", resume: "Sam Nguyen\nRegistered Dental Hygienist at Bright Smiles 2017 - present\nRDH license CA active\nPerio therapy, Dentrix" });
    expect(a.stage).toBe("eligible");
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, a.id))).toHaveLength(0);
    expect(await eventsOf("entitlement.exceeded")).toHaveLength(1);
    const first = emailOutbox().filter((m) => m.to === "sam@example.com");
    expect(first).toHaveLength(1);
    expect(first[0].subject).toMatch(/^Thank you for applying: your next step for /);
    expect(first[0].text).toContain("We will email you its link as soon as it is ready.");
    expect(first[0].text).not.toContain("/c/screen/");
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string }>;
    expect(notes.some((n) => n.kind === "entitlement.text_screens")).toBe(true);
    expect((await container.db.select().from(workflowRuns).where(eq(workflowRuns.status, "failed")))).toHaveLength(0);
    // more interviews are added: the run looks again within six hours and the link follows in an email of its own
    await container.db.update(entitlements).set({ used: 0 }).where(eq(entitlements.id, ent.id));
    await advance(6 * 3600_000 + 60_000);
    expect((await reload(a.id)).stage).toBe("screen_invited");
    const scr = await screenOf(a.id);
    expect(scr).toMatchObject({ invitedVia: "with_application", channel: "web" });
    const second = emailOutbox().filter((m) => m.to === "sam@example.com");
    expect(second).toHaveLength(2);
    expect(second[1].subject).toMatch(/^Your next step: a short AI interview for /);
    expect(second[1].text).toContain(`/c/screen/${scr.token}`);
  });

  let omarId = "";

  it("lists notifications and marks them read", async () => {
    const unread = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ id: string }>;
    expect(unread.length).toBeGreaterThan(3);
    const r = await json("POST", "/api/v1/notifications/read", { ids: unread.slice(0, 2).map((n) => n.id) });
    expect(((await r.json()) as { marked: number }).marked).toBe(2);
    const after = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ id: string }>;
    expect(after.length).toBe(unread.length - 2);
    void priyaId;
  });

  it("a Design Partner over its screen allowance keeps screening, and the owner is told (founder decision F8)", async () => {
    const { entitlements: ent } = await import("@ros/core");
    const [co] = await container.db.select().from(companies).limit(1);
    await ent.applyPlan(container.db, co.id, "design_partner");
    const [row] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, co.id), eq(entitlements.key, "text_screens")));
    await container.db.update(entitlements).set({ used: row.limit! }).where(eq(entitlements.id, row.id));
    await signIn(); // the nudges test moved the clock by days
    const a = await apply({ first: "Lena", last: "Park", email: "lena.park@example.com", resume: "Lena Park\nRegistered Dental Hygienist at Coastal Dental 2018 - present\nRDH license CA active\nPerio therapy and patient education" });
    expect(a.stage).toBe("screen_invited");
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, a.id))).toHaveLength(1);
    const notes = (await (await json("GET", "/api/v1/notifications?unread=1")).json()) as Array<{ kind: string; title: string }>;
    expect(notes.some((n) => n.kind === "entitlement.text_screens" && /pilot/.test(n.title))).toBe(true);
    // The conversation counts at Lena's first answer (plan E9), never at the invitation; over the line, she carries on.
    expect((await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, co.id), eq(entitlements.key, "text_screens"))))[0].used).toBe(row.limit!);
    expect((await form(`/c/screen/${(await screenOf(a.id)).token}`, { message: "Yes, my RDH license is active in California." })).status).toBe(302);
    expect((await screenOf(a.id)).status).toBe("in_progress");
    const current = (await (await json("GET", "/api/v1/companies/current")).json()) as { plan: { name: string }; usage: Record<string, { used: number; limit: number | null }> };
    expect(current.plan.name).toBe("Design Partner");
    expect(current.usage.text_screens.used).toBeGreaterThan(current.usage.text_screens.limit!);
  });

  /* The tests below move the clock by a week or more; they run last so the nudge ladder above keeps its own timing. */

  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  const SCREEN_ANSWERS: Record<string, string> = {
    license_confirm: "Yes, my RDH license is active in California, number RDH77777.",
    experience: "At Harbor Dental I see eight patients a day, do full perio charting and radiographs, and chart everything in Dentrix.",
    hard_moment: "A nervous patient wanted to stop halfway, so I paused, explained each step, and finished by hand; she rebooked with me.",
    availability: "Monday to Friday, any hours, and I can start in two weeks.",
    pay: "I'm looking for $50 an hour.",
    why: "A steady office with a consistent schedule.",
  };
  /**
   * The candidate starts the AI interview on the web, answers until it ends, checks the answers and presses Send (the
   * chat that comes with the application, 20 Oct 2026); the screen workflow then writes the scorecard and makes its suggestion.
   */
  const finishScreen = async (applicationId: string, answers: Record<string, string> = SCREEN_ANSWERS) => {
    const { token } = await screenOf(applicationId);
    expect((await form(`/c/screen/${token}/start`, {})).status).toBe(302);
    for (let i = 0; i < 30; i++) {
      const scr = await screenOf(applicationId);
      if (scr.status === "completed") break;
      if (scr.progress.phase === "review") {
        expect((await form(`/c/screen/${token}/review`, {})).status).toBe(302);
        expect((await form(`/c/screen/${token}/submit`, {})).status).toBe(302);
        continue;
      }
      const res = await form(`/c/screen/${token}`, { message: answers[scr.progress.currentQuestionKey ?? ""] ?? "Yes, that works for me: at Harbor Dental I see eight patients a day, do perio charting and use Dentrix." });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).not.toMatch(/error=/);
    }
    expect((await screenOf(applicationId)).status).toBe("completed");
    await container.drain();
  };
  const companyIdOf = async () => (await container.db.select().from(companies).limit(1))[0].id;

  it("'Stop this screen invitation' takes back an invitation the candidate has not started: a short note, a friendly link, no reminder, back with the owner (plan A7)", async () => {
    const a = await apply({ first: "Rosa", last: "Diaz", email: "rosa@example.com", resume: "Rosa Diaz\nRegistered Dental Hygienist at Harbor Dental 2017 - present\nRDH license CA active\nPerio charting, Dentrix" });
    expect(a.stage).toBe("screen_invited");
    const scr = await screenOf(a.id);
    const detail = (await (await json("GET", `/api/v1/applications/${a.id}`)).json()) as { allowedActions: string[] };
    expect(detail.allowedActions).toContain("cancel_screen");
    // HR may invite but not take an invitation back: the candidate is written to
    const hr = await signInAs(container, app, { companyId: await companyIdOf(), role: "hr" });
    const refused = await app.request(`/api/v1/applications/${a.id}/actions`, { method: "POST", headers: { "content-type": "application/json", cookie: hr }, body: JSON.stringify({ action: "cancel_screen" }) });
    expect(refused.status).toBe(403);
    const before = emailOutbox().filter((m) => m.to === "rosa@example.com").length;
    const r = await json("POST", `/api/v1/applications/${a.id}/actions`, { action: "cancel_screen", note: "Calling her instead." });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, stage: "triaged", ownerStage: "new", next: expect.stringMatching(/short note/) });
    await container.drain();
    expect((await screenOf(a.id)).status).toBe("cancelled");
    expect((await reload(a.id)).stage).toBe("triaged");
    expect((await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, scr.workflowRunId!)))[0].status).toBe("cancelled");
    expect((await eventsOf("screen.cancelled")).find((e) => e.subjectId === scr.id)?.payload).toMatchObject({ reason: "stopped_by_team", note: "Calling her instead." });
    const note = emailOutbox().filter((m) => m.to === "rosa@example.com").slice(before);
    expect(note).toHaveLength(1);
    expect(note[0].subject).toMatch(/^No need to do the AI interview for /);
    expect(note[0].text).toContain("You can ignore the AI interview we sent you");
    expect(note[0].text).toMatch(/AI recruiting assistant/);
    // the old link says the conversation is closed and offers nothing to type into
    const page = await (await app.request(`/c/screen/${scr.token}`)).text();
    expect(page).toContain("This screening conversation is closed");
    expect(page).not.toContain('name="message"');
    // the candidate's own page is back to Review, with no screen to start, and no chat ticked that never happened
    const status = await (await app.request(`/c/status/${a.statusToken}`)).text();
    expect(status).toMatch(/<span>Status<\/span><strong>Review<\/strong>/);
    expect(status).not.toContain("Start the screening chat");
    expect(status).not.toMatch(/<span>Screening chat<\/span><span class="sr-only"> \(done\)<\/span>/);
    // a second press explains instead of sending again, and no reminder ever follows
    const again = await json("POST", `/api/v1/applications/${a.id}/actions`, { action: "cancel_screen" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("no_screen_invitation");
    await advance(3 * DAY);
    expect(emailOutbox().filter((m) => m.to === "rosa@example.com").slice(before)).toHaveLength(1);
    // once a candidate has started, the conversation is theirs: it cannot be stopped from here
    const b = await apply({ first: "Tomas", last: "Berg", email: "tomas@example.com", resume: "Tomas Berg\nRegistered Dental Hygienist at Bright Smiles 2016 - present\nRDH license CA active\nPerio therapy, Dentrix" });
    const tb = await screenOf(b.id);
    expect((await form(`/c/screen/${tb.token}`, { message: SCREEN_ANSWERS.license_confirm })).status).toBe(302);
    expect((await screenOf(b.id)).status).toBe("in_progress");
    const started = await json("POST", `/api/v1/applications/${b.id}/actions`, { action: "cancel_screen" });
    expect(started.status).toBe(409);
    expect(((await started.json()) as { error: { code: string } }).error.code).toBe("screen_started");
    const blocked = (await (await json("GET", `/api/v1/applications/${b.id}`)).json()) as { blockedReasons: Record<string, string> };
    expect(blocked.blockedReasons.cancel_screen).toBe("They have started the AI interview, so it can't be stopped now.");
  });

  /**
   * The live test of 12 November 2026 and the second review of its fixes: a concern the scorecard writes with nothing
   * quoted, about a must-have the résumé shows, is the AI interview's silence only when it never asked about it. Every
   * concern is stored as written; where the team reads them, one about the licence the AI interview asked about stays,
   * even when the tapped "No" it rests on is too short to quote.
   */
  it("a scorecard keeps every concern it wrote, and one about a must-have the AI interview asked about is never read as its silence", async () => {
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: RolePacket } };
    const packet = role.currentPacket.packet;
    const licence = packet.requirements.mustHaves.find((m) => /licen/i.test(m.text))!;
    const notDiscussed = `${licence.text} was not discussed in the AI interview.`;
    const notActive = "RDH license is not active in this state";
    for (let i = 0; i < SCORECARD_READINGS; i++) container.fake!.scriptNext("screen.assess", { overall: "potential", confidence: "medium", summary: "Answered every question.", strengths: [], concerns: [{ claim: notDiscussed, evidence: { source: "screen" } }, { claim: notActive, evidence: { source: "screen", quote: "No" } }, { claim: "Sees eight patients a day", evidence: { source: "screen", quote: "I see eight patients a day" } }], unknowns: [], competencyFindings: [], requirementFindings: [], anomalies: [], questionFindings: [], compensationExpectation: { withinRange: "unknown" }, availability: { matchesSchedule: "unknown" }, eligibilityConfirmations: [], recommendation: "interview", rationale: "Scripted." });
    const a = await apply({ first: "Yara", last: "Shown", email: "yara.shown@example.com", resume: "Yara Shown\nRegistered Dental Hygienist at Harbor Dental 2019 - present\nRDH license CA active\nPerio charting, Dentrix" });
    // the AI interview asks the licence question, and she answers it "No"
    await finishScreen(a.id, { ...SCREEN_ANSWERS, license_confirm: "No" });
    container.fake!.clearScripts();
    // the résumé's AI review shows the licence on a checked quote
    const [resume] = await container.db.select().from(assessments).where(and(eq(assessments.applicationId, a.id), eq(assessments.kind, "triage")));
    expect(resume!.result.requirementFindings.find((f) => f.requirementKey === licence.key)).toMatchObject({ met: "yes", evidence: { quote: "RDH license CA active" } });
    expect((await screenOf(a.id)).transcript.some((t) => t.role === "assistant" && t.questionKey === "license_confirm" && t.content.includes("RDH license"))).toBe(true);
    // stored as the readings wrote them, the "No" too short to quote on its own
    const [card] = await container.db.select().from(assessments).where(and(eq(assessments.applicationId, a.id), eq(assessments.kind, "screen")));
    expect(card!.result.concerns).toEqual([{ claim: notDiscussed, evidence: { source: "screen", unquoted: true } }, { claim: notActive, evidence: { source: "screen", unquoted: true } }, { claim: "Sees eight patients a day", evidence: { source: "screen", quote: "I see eight patients a day" } }]);
    // the candidate's page and the interviewer's brief keep every one: the AI interview asked about the licence
    const detail = (await (await json("GET", `/api/v1/applications/${a.id}`)).json()) as { assessments: Array<{ kind: string; result: { concerns: Array<{ claim: string }> } }> };
    expect(detail.assessments[0]!.kind).toBe("screen");
    expect(detail.assessments[0]!.result.concerns.map((c) => c.claim)).toEqual([notDiscussed, notActive, "Sees eight patients a day"]);
    const brief = await withTenant(container.db, await companyIdOf(), (tx) => composeInterviewerBrief(tx, { applicationId: a.id, candidateFirstName: "Yara", packet, roundKey: packet.interviews.plan[0]!.key }));
    expect(brief!.concerns.map((c) => c.claim)).toEqual(expect.arrayContaining([notDiscussed, notActive, "Sees eight patients a day"]));
  });
});
