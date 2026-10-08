import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RolePacket } from "@ros/contracts";
import { REVIEW_MESSAGE } from "@ros/agents";
import { applications, assessments, communications, companies, events, recruiterEscalations, rolePackets, roles, screens, unconfirmedScreens, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { createApplication } from "./services/applications";
import { DETACHED_EMAILS_PER_DAY, confirmRepeat, conversationLater, conversationPerson, conversationStart, conversationSubmit, conversationTurn, conversationView, conversationWithdraw, findConversation, repeatConfirmationView, startApplyConversation, type ApplyVisitOutcome, type ConversationRef } from "./services/apply-conversation";
import { useOneVisitApplyFlow } from "./test-helpers";

/**
 * Repeat submissions in the one-visit flow (Q14 x Q15, design (a)): a second application from an address that already
 * applied looks exactly like a first one, conversation included, and changes nothing on the real application. Its
 * answers reach the application only if the owner of the address on file confirms by email; unconfirmed, they are
 * wiped after seven days.
 */
describe("a repeat submission's conversation is detached until the address owner confirms it", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let roleId = "";
  let elig: Array<{ key: string }> = [];
  const BASE = Math.floor(Date.now() / 60_000) * 60_000;
  let offset = 0;
  const setClock = (ms: number) => { offset = ms; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset); };
  const advance = async (ms: number) => { setClock(offset + ms); await container.drain(); };
  const DAY = 24 * 3600_000;

  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const mail = () => (container.integrations.email as FakeEmailAdapter).sent;
  const reload = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];
  const screensOf = async (applicationId: string) => container.db.select().from(screens).where(eq(screens.applicationId, applicationId));
  const eventsOn = async (applicationId: string) => container.db.select().from(events).where(eq(events.subjectId, applicationId));
  const confirmLink = (to: string) => mail().filter((m) => m.to === to && /^Please confirm/.test(m.subject)).at(-1)?.text.match(/\/c\/confirm-answers\/([A-Za-z0-9_-]+)/)?.[1] ?? null;

  async function applyNow(p: { first: string; email: string }): Promise<{ outcome: ApplyVisitOutcome; applicationId: string; duplicate: boolean }> {
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    const [company] = await container.db.select().from(companies).where(eq(companies.id, role.companyId));
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    const eligibilityAnswers = Object.fromEntries(elig.map((r) => [r.key, "yes"]));
    const result = await withTenant(container.db, company.id, async (tx) => {
      const created = await createApplication(tx, container, { companyId: company.id, roleId, source: "careers_page", firstName: p.first, lastName: "Applicant", email: p.email, phone: null, smsConsent: false, consentSource: "careers_page_apply", noticeVersionsShown: ["ai_use@2026-10-08", "privacy@2026-09-01"], eligibilityAnswers, noResumeAnswers: { summary: "Registered dental hygienist for six years, active CA RDH license, perio maintenance in Dentrix." } }, { kind: "candidate", id: "applicant" });
      const outcome = await startApplyConversation(tx, container, { ...created, role, company, packet: pv.packet as RolePacket, typedFirstName: p.first, eligibilityAnswers });
      return { outcome, applicationId: created.application.id, duplicate: created.duplicate };
    });
    await container.kick();
    await container.drain();
    return result;
  }
  const refOf = async (outcome: ApplyVisitOutcome): Promise<ConversationRef> => {
    if (outcome.kind !== "conversation") throw new Error("expected a conversation");
    return (await findConversation(container.db, outcome.token))!;
  };
  /** Answers every question in words, then lands on "check your answers". */
  const answerAll = async (ref: ConversationRef) => {
    for (let i = 0; i < 14; i++) {
      const v = (await conversationView(container.db, ref))!;
      if (v.phase !== "conversation") return v;
      await conversationTurn(container, ref, { message: "At Smile Bright I see nine patients a day, chart in Dentrix and do perio maintenance; my license is active." });
    }
    return (await conversationView(container.db, ref))!;
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake" } });
    app = createApp(container);
    setClock(0);
    const r1 = await json("POST", "/api/v1/auth/magic-link", { email: "dana@repeat.test" });
    const { devLink } = (await r1.json()) as { devLink: string };
    const consume = await json("POST", "/api/v1/auth/magic-link/consume", { token: new URL(devLink).searchParams.get("token") });
    cookie = consume.headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json("POST", "/api/v1/companies", { name: "Repeat Dental", vertical: "dental", sizeBand: "50-99", ownerName: "Dana Whitfield", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    // A pilot company: ITS switched the one-visit flow on for it.
    await useOneVisitApplyFlow(container, co.id);
    const c1 = (await (await json("POST", "/api/v1/intake/conversation/messages", { message: "I need a dental hygienist in Irvine. Full time. $45 to $55 an hour. I need someone who can start within 30 days." })).json()) as { intakeSessionId: string };
    await json("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/messages`, { message: "It's a replacement. Interviewers: Dr. Chen and me. I decide. Must-haves: active CA RDH license, perio experience." });
    const compiled = (await (await json("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/compile`)).json()) as { roleId: string };
    roleId = compiled.roleId;
    await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1 });
    await container.drain();
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: RolePacket } };
    elig = role.currentPacket.packet.requirements.eligibility;
  });
  afterAll(async () => { await container.close(); });

  let rosaId = "";
  let rosaRealScreenId = "";

  it("looks exactly like a first application, greets the name typed, and touches nothing on the real application", async () => {
    const first = await applyNow({ first: "Rosa", email: "rosa@repeat.test" });
    rosaId = first.applicationId;
    const firstRef = await refOf(first.outcome);
    expect(firstRef.kind).toBe("screen");
    rosaRealScreenId = firstRef.id;
    const before = { stage: (await reload(rosaId)).stage, screens: (await screensOf(rosaId)).length, events: (await eventsOn(rosaId)).length };
    const again = await applyNow({ first: "Someone", email: "ROSA@repeat.test" });
    expect(again.duplicate).toBe(true);
    expect(again.applicationId).toBe(rosaId);
    expect(again.outcome.kind).toBe("conversation");
    const ref = await refOf(again.outcome);
    expect(ref.kind).toBe("detached");
    const [real, copy] = [(await conversationView(container.db, firstRef))!, (await conversationView(container.db, ref))!];
    // the same page, field by field, apart from the link and the name that was typed
    expect({ ...copy, token: "", firstName: "", intro: { ...copy.intro, disclosure: copy.intro.disclosure.replace("Someone", "X") } }).toEqual({ ...real, token: "", firstName: "", intro: { ...real.intro, disclosure: real.intro.disclosure.replace("Rosa", "X") } });
    expect(copy.firstName).toBe("Someone");
    // nothing about the application changed: stage, screens, history (the repeat itself is recorded, as before Wave E)
    expect((await reload(rosaId)).stage).toBe(before.stage);
    expect(await screensOf(rosaId)).toHaveLength(before.screens);
    expect((await eventsOn(rosaId)).map((e) => e.type).slice(before.events)).toEqual(["application.duplicate_detected"]);
  });

  it("its answers wait for the address owner, who confirms by email; then they become the application's screening conversation", async () => {
    const again = await applyNow({ first: "Rosa", email: "rosa@repeat.test" });
    const ref = await refOf(again.outcome);
    await conversationStart(container, ref);
    const view = await answerAll(ref);
    expect(view.phase).toBe("review");
    expect(view.transcript.at(-1)?.content).toBe(REVIEW_MESSAGE);
    expect(await conversationSubmit(container, ref)).toBe(true);
    // the real application still has its own untouched invitation, and nobody on the team heard anything
    expect((await screensOf(rosaId)).find((s) => s.id === rosaRealScreenId)?.status).toBe("invited");
    expect((await reload(rosaId)).stage).toBe("screen_invited");
    const token = confirmLink("rosa@repeat.test");
    expect(token).toBeTruthy();
    const [row] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.token, ref.token));
    expect(row).toMatchObject({ status: "completed", confirmation: "sent", intent: "answers" });
    expect(row.confirmTokenHash).not.toBe(token); // only the hash is kept
    // opening the link changes nothing; pressing the button adds the answers
    expect(await repeatConfirmationView(container.db, token!, container.engine.clock())).toMatchObject({ state: "ready", intent: "answers", companyName: "Repeat Dental" });
    expect((await screensOf(rosaId)).find((s) => s.id === rosaRealScreenId)?.status).toBe("invited");
    expect(await confirmRepeat(container, token!)).toMatchObject({ state: "added" });
    await container.drain();
    const merged = (await screensOf(rosaId)).find((s) => s.id === rosaRealScreenId)!;
    expect(merged.status).toBe("completed");
    expect(merged.transcript.filter((t) => t.role === "candidate").length).toBeGreaterThan(0);
    expect((await container.db.select().from(assessments).where(and(eq(assessments.applicationId, rosaId), eq(assessments.kind, "screen"))))).toHaveLength(1);
    expect(["screen_complete", "interview_recommended"]).toContain((await reload(rosaId)).stage);
    const [after] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, row.id));
    expect(after).toMatchObject({ confirmation: "confirmed", transcript: [], answers: {}, mergedScreenId: rosaRealScreenId });
    // a second press is the same answer, and adds nothing more
    expect(await confirmRepeat(container, token!)).toMatchObject({ state: "added" });
    expect((await container.db.select().from(assessments).where(and(eq(assessments.applicationId, rosaId), eq(assessments.kind, "screen"))))).toHaveLength(1);
    expect(await confirmRepeat(container, "not-a-real-token")).toBeNull();
  });

  it("an application that already has answers keeps them: a confirmed repeat adds nothing, and says so", async () => {
    const again = await applyNow({ first: "Rosa", email: "rosa@repeat.test" });
    const ref = await refOf(again.outcome);
    await conversationStart(container, ref);
    await answerAll(ref);
    await conversationSubmit(container, ref);
    const token = confirmLink("rosa@repeat.test")!;
    const stage = (await reload(rosaId)).stage;
    expect(await confirmRepeat(container, token)).toMatchObject({ state: "not_added" });
    expect((await reload(rosaId)).stage).toBe(stage);
    expect((await screensOf(rosaId))).toHaveLength(1);
  });

  it("WITHDRAW says the same as in a first application, but withdraws nothing: the address owner is pointed to their own status page", async () => {
    const first = await applyNow({ first: "Tomas", email: "tomas@repeat.test" });
    const again = await applyNow({ first: "Tomas", email: "tomas@repeat.test" });
    const ref = await refOf(again.outcome);
    await conversationStart(container, ref);
    const ask = await conversationTurn(container, ref, { message: "WITHDRAW" });
    expect(ask).toMatchObject({ kind: "reply", message: expect.stringMatching(/^Do you want to withdraw your application/) });
    expect((await conversationView(container.db, ref))!.withdrawPending).toBe(true);
    expect(await conversationWithdraw(container, ref, true)).toMatch(/^Understood, we have withdrawn your application for /);
    expect((await reload(first.applicationId)).stage).toBe("screen_invited");
    const email = mail().filter((m) => m.to === "tomas@repeat.test" && /^Please confirm/.test(m.subject)).at(-1)!;
    expect(email.text).toContain("/c/status/");
    expect(email.text).not.toContain("/c/confirm-answers/");
  });

  it("'Have a person contact me' is passed on only once the address owner confirms it", async () => {
    const first = await applyNow({ first: "Ivy", email: "ivy@repeat.test" });
    const again = await applyNow({ first: "Ivy", email: "ivy@repeat.test" });
    const ref = await refOf(again.outcome);
    expect(await conversationPerson(container, ref, "contact_me")).toMatchObject({ message: expect.stringMatching(/A person from Repeat Dental will follow up with you/) });
    expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, first.applicationId))).toHaveLength(0);
    expect(await confirmRepeat(container, confirmLink("ivy@repeat.test")!)).toMatchObject({ state: "person" });
    expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, first.applicationId))).toHaveLength(1);
  });

  it("'Do this later' in a repeat submission's copy is worded for what it is, and repeat submissions cannot fill someone's mailbox: three such emails a day at most, the page the same", async () => {
    await applyNow({ first: "Max", email: "max@repeat.test" });
    for (let i = 0; i < 5; i++) {
      const again = await applyNow({ first: "Someone", email: "max@repeat.test" });
      expect(await conversationLater(container, await refOf(again.outcome))).toBe(true);
    }
    await container.drain();
    const later = mail().filter((m) => m.to === "max@repeat.test" && /^Please check: an application for/.test(m.subject));
    expect(later).toHaveLength(DETACHED_EMAILS_PER_DAY);
    expect(later[0].text).toContain("someone using this email address applied again and chose to answer the screening questions later. Nothing has been changed.");
    expect(later[0].text).toContain("Nothing is added to your application unless you confirm it at the end.");
    expect(later[0].text).not.toMatch(/Here is the link to the short screening conversation/);
    // the copy's own "please confirm" falls under the same cap: recorded, and nothing sent
    const again = await applyNow({ first: "Someone", email: "max@repeat.test" });
    const ref = await refOf(again.outcome);
    await conversationStart(container, ref);
    await answerAll(ref);
    expect(await conversationSubmit(container, ref)).toBe(true);
    await container.drain();
    expect(mail().filter((m) => m.to === "max@repeat.test" && /^Please confirm/.test(m.subject))).toHaveLength(0);
    expect((await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, ref.id)))[0]).toMatchObject({ status: "completed", confirmation: "sent" });
    expect((await conversationView(container.db, ref))!).toMatchObject({ phase: "closed", status: "completed" });
  });

  it("after a day without the assistant, the address owner is offered a person in words that say why (nobody asked); confirming brings one in", async () => {
    const first = await applyNow({ first: "Lou", email: "lou@repeat.test" });
    const again = await applyNow({ first: "Lou", email: "lou@repeat.test" });
    const ref = await refOf(again.outcome);
    await conversationStart(container, ref);
    container.fake!.failNext("screen.turn", "throw");
    container.fake!.failNext("screen.turn", "throw");
    expect((await conversationTurn(container, ref, { message: "At Smile Bright I see nine patients a day." })).kind).toBe("error");
    expect(await conversationTurn(container, ref, { message: "At Smile Bright I see nine patients a day." })).toMatchObject({ paused: true });
    // a day on, the assistant still does not answer
    const [row] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, ref.id));
    await container.db.update(unconfirmedScreens).set({ progress: { ...row.progress, pausedAt: new Date(container.engine.clock().getTime() - 25 * 3600_000).toISOString() } }).where(eq(unconfirmedScreens.id, ref.id));
    container.fake!.failNext("screen.turn", "throw");
    await advance(31 * 60_000);
    const [after] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, ref.id));
    expect(after).toMatchObject({ status: "human_requested", intent: "outage", confirmation: "sent" });
    const email = mail().filter((m) => m.to === "lou@repeat.test" && /^Please confirm/.test(m.subject)).at(-1)!;
    expect(email.text).toContain("our assistant stopped working before they finished");
    expect(email.text).not.toContain("asked for a person");
    expect(mail().filter((m) => m.to === "lou@repeat.test" && /^Please check/.test(m.subject))).toHaveLength(0); // never "it works again"
    const token = confirmLink("lou@repeat.test")!;
    expect(await repeatConfirmationView(container.db, token, container.engine.clock())).toMatchObject({ state: "ready", intent: "outage" });
    expect(await confirmRepeat(container, token)).toMatchObject({ state: "person" });
    expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, first.applicationId))).toHaveLength(1);
    container.fake!.clearScripts();
  });

  it("unconfirmed, what was typed is wiped after seven days; the link then reads as expired", async () => {
    await applyNow({ first: "Kai", email: "kai@repeat.test" });
    const again = await applyNow({ first: "Kai", email: "kai@repeat.test" });
    const ref = await refOf(again.outcome);
    await conversationStart(container, ref);
    await conversationTurn(container, ref, { message: "At Smile Bright I see nine patients a day." });
    await advance(6 * DAY);
    expect((await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, ref.id)))[0].transcript.length).toBeGreaterThan(0);
    await advance(DAY + 3600_000);
    const [row] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, ref.id));
    expect(row).toMatchObject({ transcript: [], answers: {}, firstName: "", confirmation: "discarded" });
    expect(row.discardedAt).toBeTruthy();
    expect((await conversationView(container.db, ref))!).toMatchObject({ phase: "closed", status: "expired", transcript: [] });
    // nothing about it was ever written to the application's messages but the emails to the address on file
    const kai = (await container.db.select().from(applications)).filter((a) => a.id === row.applicationId)[0];
    const comms = await container.db.select().from(communications).where(eq(communications.applicationId, kai.id));
    expect(comms.every((c) => c.direction === "outbound")).toBe(true);
  });
});
