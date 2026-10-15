import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applications, assessments, rolePackets, roles, screens } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "../../apps/api/src/app";
import { createContainer, type Container } from "../../apps/api/src/container";
import { useOneVisitApplyFlow } from "../../apps/api/src/test-helpers";

/**
 * The founder context's own "single workflow that should be perfect" (docs/FOUNDER-CONTEXT.md §27):
 * a 60-person beauty brand says "I need a performance marketing manager", approves the Role Packet, the system
 * launches the role, handles inbound candidates, screens, and surfaces a qualified candidate with evidence.
 * Runs on the consumer playbook, the launch wedge. Scheduling, offer and close arrive with Slices 3 and 4.
 */
describe("End-to-end hiring scenario: Glow Theory (beauty brand, 60 people) hires a Performance Marketing Manager", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let slug = "";
  let roleId = "";
  const BASE = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return d.getTime(); })();
  const setClock = (ms: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + ms); };
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    setClock(0);
    const { devLink } = (await (await json("POST", "/api/v1/auth/magic-link", { email: "sasha@glowtheory.test" })).json()) as { devLink: string };
    const consume = await json("POST", "/api/v1/auth/magic-link/consume", { token: new URL(devLink).searchParams.get("token") });
    cookie = consume.headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json("POST", "/api/v1/companies", { name: "Glow Theory", vertical: "beauty", sizeBand: "50-99", ownerName: "Sasha Bell", locations: [{ city: "Los Angeles", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    slug = co.slug;
    // A pilot company: ITS switched on the conversation in the same visit as the form (plan Wave E, founder decision B1).
    await useOneVisitApplyFlow(container, co.id);
  });
  afterAll(async () => { await container.close(); });

  it("Intake on the consumer playbook: the assistant recognizes the role, uses the playbook's market range, and drafts a packet with lawful eligibility only", async () => {
    const r1 = (await (await json("POST", "/api/v1/intake/conversation/messages", { message: "I need a performance marketing manager in Los Angeles. $95,000 to $115,000 a year. Hybrid, three days in the office. Someone who can start within 45 days." })).json()) as { reply: string; intakeSessionId: string };
    expect(r1.reply).toMatch(/consumer playbook|playbook/i);
    expect(r1.reply).toMatch(/Performance Marketing Manager/);
    expect(r1.reply).toMatch(/market/);
    const r2 = await json("POST", `/api/v1/intake/sessions/${r1.intakeSessionId}/messages`, { message: "It's a new position, we spend $180k a month on Meta and Google and the agency is not working. Ceiling is $125,000. Interviewers: Sasha Bell and Priya Nair, our head of brand. Sasha Bell makes the final decision. Must-haves: owned paid budgets over $100k a month, ran creative tests, comfortable with Shopify analytics. Deal-breakers: agency-only experience." });
    const c2 = (await r2.json()) as { reply: { readyToCompile: boolean; factsExtracted: { compensationBasis: string; compensationCeiling: number; mustHaves: string[] } } };
    expect(c2.reply.readyToCompile).toBe(true);
    expect(c2.reply.factsExtracted.compensationBasis).toBe("salary");
    expect(c2.reply.factsExtracted.compensationCeiling).toBe(125000);
    expect(c2.reply.factsExtracted.mustHaves.length).toBeGreaterThanOrEqual(2);
    const compiled = (await (await json("POST", `/api/v1/intake/sessions/${r1.intakeSessionId}/compile`)).json()) as { roleId: string; packet: { identity: { title: string }; compensation: { basis: string; ceiling: number }; requirements: { eligibility: Array<{ type: string }> }; competencies: Array<{ key: string }>; screening: { questions: Array<{ key: string }> }; interviews: { plan: Array<{ title: string }> }; provenance: { playbookId?: string } } };
    roleId = compiled.roleId;
    expect(compiled.packet.identity.title).toBe("Performance Marketing Manager");
    expect(compiled.packet.compensation.basis).toBe("salary");
    expect(compiled.packet.compensation.ceiling).toBe(125000);
    // knowledge-worker role: no license rule; work authorization and schedule only
    expect(compiled.packet.requirements.eligibility.map((e) => e.type).sort()).toEqual(["schedule_availability", "start_date", "work_authorization"]);
    expect(compiled.packet.competencies.map((c) => c.key)).toContain("paid_acquisition_craft");
    expect(compiled.packet.screening.questions.length).toBeGreaterThanOrEqual(5);
    expect(compiled.packet.interviews.plan.some((p) => /Working session/.test(p.title))).toBe(true);
    expect(compiled.packet.provenance.playbookId).toBeTruthy();
    const [pv] = await container.db.select().from(rolePackets).where(eq(rolePackets.roleId, roleId));
    expect(pv.packet.compliance.jurisdictions).toContain("US-CA");
  });

  it("Approval opens the role and posts it; the job page shows the salary range California requires", async () => {
    expect((await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    expect(role.status).toBe("open");
    const html = await (await app.request(`/careers/${slug}/jobs/${roleId}`)).text();
    expect(html).toMatch(/\$95,000–\$115,000 a year/);
    expect(html).toMatch(/artificial intelligence/);
  });

  it("A strong applicant goes straight from the form to the screening conversation, is assessed against the packet with grounded evidence beside it, and is recommended after it", async () => {
    const form = new FormData();
    form.set("firstName", "Dev"); form.set("lastName", "Mehta"); form.set("email", "dev.mehta@example.com");
    form.set("resume", new File([
      "Dev Mehta\nPerformance Marketing Manager at Lumen Skincare 2022 - present\nOwned $220k monthly paid budgets across Meta and Google Ads; ran weekly creative tests; cut blended CAC 28% in twelve months\nGrowth Marketing Lead at Fable Home 2019 - 2022\nShopify analytics, Klaviyo retention flows, incrementality tests with geo holdouts\nSkills: Meta Ads, Google Ads, GA4, Shopify, Klaviyo, creative testing",
    ], "dev.txt", { type: "text/plain" }));
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> }; screening: { questions: Array<{ key: string; kind: string }> } } } };
    for (const r of role.currentPacket.packet.requirements.eligibility) form.set(`elig_${r.key}`, "yes");
    form.set("acknowledged", "yes");
    const applied = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: form });
    expect(applied.status).toBe(302);
    // one visit (plan E1): the form leads straight to the conversation's introduction
    expect(applied.headers.get("location")).toMatch(/^\/c\/screen\//);
    await container.drain();
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(a.stage).toBe("screen_invited");
    const triage = (await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).find((x) => x.kind === "triage")!;
    expect(["strong", "potential"]).toContain(triage.overall);
    expect(triage.result.recommendation).toBe("screen");
    for (const s of triage.result.strengths) expect(s.evidence.source).toBe("resume");
    expect(triage.result.requirementFindings.length).toBeGreaterThan(0);
    // the web screen, question by question, with the playbook's questions: the introduction, Start, the answers, then "check your answers" and Send
    const [scr] = await container.db.select().from(screens).where(eq(screens.applicationId, a.id));
    expect(applied.headers.get("location")).toBe(`/c/screen/${scr.token}`);
    expect(await (await app.request(`/c/screen/${scr.token}`)).text()).toContain(`/c/screen/${scr.token}/start`);
    const post = (path: string, fields: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
    expect((await post(`/c/screen/${scr.token}/start`)).status).toBe(302);
    const questions = role.currentPacket.packet.screening.questions;
    const answerFor = (key: string) => {
      const q = questions.find((x) => x.key === key);
      if (q?.kind === "compensation") return "I'm looking for $110,000 base with a modest bonus.";
      if (q?.kind === "availability") return "Hybrid three days a week works, and I can start in four weeks.";
      if (q?.kind === "motivation") return "I want to own the number in-house instead of through an agency.";
      return "At Lumen I owned $220k a month across Meta and Google, ran weekly creative tests against a blended CAC target, and cut CAC 28% in a year.";
    };
    for (let i = 0; i < 12; i++) {
      const [s] = await container.db.select().from(screens).where(eq(screens.id, scr.id));
      if (s.progress.phase === "review") break;
      const res = await post(`/c/screen/${scr.token}`, { message: answerFor(s.progress.currentQuestionKey ?? "") });
      expect(res.status).toBe(302);
    }
    // Wave S7: the chat ends with "Review and send", which writes the answers up from Dev's own replies; then
    // "Check what you're sending" and Send, as before
    expect(await (await app.request(`/c/screen/${scr.token}`)).text()).toContain(`<form method="post" action="/c/screen/${scr.token}/review">`);
    expect((await post(`/c/screen/${scr.token}/review`)).headers.get("location")).toBe(`/c/screen/${scr.token}`);
    expect(await (await app.request(`/c/screen/${scr.token}`)).text()).toMatch(/<h1>Check what you(&#39;|')re sending<\/h1>/);
    expect((await post(`/c/screen/${scr.token}/submit`)).status).toBe(302);
    await container.drain();
    const [done] = await container.db.select().from(screens).where(eq(screens.id, scr.id));
    expect(done.status).toBe("completed");
    // every one of the job's screening questions is answered (the chat also keeps its closing answer and any must-have
    // the CV did not show under their own keys)
    expect(Object.keys(done.answers)).toEqual(expect.arrayContaining(questions.map((q) => q.key)));
    const after = (await container.db.select().from(applications).where(eq(applications.id, a.id)))[0];
    expect(after.stage).toBe("interview_recommended");
    const screenAsmt = (await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).find((x) => x.kind === "screen")!;
    expect((screenAsmt.result as { compensationExpectation: { withinRange: string } }).compensationExpectation.withinRange).toBe("yes");
    // no separate invitation: the acknowledgment carried the conversation's link
    const mail = (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === "dev.mehta@example.com");
    expect(mail.some((m) => /screening conversation/.test(m.subject))).toBe(false);
    expect(mail.find((m) => /received your application/.test(m.subject))?.text).toContain(`/c/screen/${scr.token}`);
  });

  it("An applicant with no resume is assessed from their own words, never marked weak for a non-traditional path", async () => {
    const form = new FormData();
    form.set("firstName", "Rosa"); form.set("lastName", "Kim"); form.set("email", "rosa.kim@example.com");
    form.set("noResume", "I moved into performance marketing from finance three years ago. At a DTC candle brand I ran $60k a month on Meta and Google, built the creative testing calendar, and set up Shopify and GA4 reporting.");
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    for (const r of role.currentPacket.packet.requirements.eligibility) form.set(`elig_${r.key}`, "yes");
    form.set("acknowledged", "yes");
    await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: form });
    await container.drain();
    const rosa = (await container.db.select().from(applications).where(eq(applications.roleId, roleId))).find((x) => x.stage !== "interview_recommended")!;
    const asmt = (await container.db.select().from(assessments).where(eq(assessments.applicationId, rosa.id))).find((x) => x.kind === "triage")!;
    expect(asmt.overall).not.toBe("weak");
    expect(asmt.result.recommendation).not.toBe("hold");
    for (const s of asmt.result.strengths) expect(s.evidence.source).toBe("application");
  });

  it("Today answers the four questions and the owner can flag an assessment for review", async () => {
    const brief = (await (await json("GET", "/api/v1/brief")).json()) as { summary: string; cards: Array<{ kind: string }> };
    expect(brief.summary).toMatch(/needs? you · \d+ strong candidates? ready · \d+ at risk · \d+ handled for you since yesterday/);
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    const asmt = (await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id)))[0];
    const r = await json("POST", `/api/v1/applications/${a.id}/assessments/${asmt.id}/flag`, { kind: "missing_context", note: "We told it agency-only experience is a deal-breaker." });
    expect(r.status).toBe(200);
    const { aiRuns } = await import("@ros/db");
    const [run] = await container.db.select().from(aiRuns).where(eq(aiRuns.id, asmt.aiRunId!));
    expect((run.humanOverride as { kind: string }).kind).toBe("missing_context");
    // the reading is three model runs, each linked to the one it keeps, and the flag marks every one (known bugs 87, 109)
    const linked = (await container.db.select().from(aiRuns)).filter((x) => (x.finalOutcome as { readingOf?: string } | null)?.readingOf === asmt.aiRunId);
    expect(linked).toHaveLength(3);
    for (const x of linked) {
      expect((x.finalOutcome as { readings: string[] }).readings).toHaveLength(3);
      expect((x.humanOverride as { kind: string }).kind).toBe("missing_context");
    }
  });
});
