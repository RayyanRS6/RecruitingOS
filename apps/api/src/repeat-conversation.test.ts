import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RolePacket } from "@ros/contracts";
import { CHAT_CAP_CLOSING, REVIEW_MESSAGE, TURN_CAP_REVIEW_MESSAGE, chatClosingMessage, chatNextLine, chatPacket, modelTurnCap } from "@ros/agents";
import { applications, assessments, communications, companies, events, recruiterEscalations, rolePackets, roles, screens, unconfirmedScreens, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { createApplication } from "./services/applications";
import { CONVERSATIONS_PER_APPLICATION_PER_DAY, DETACHED_EMAILS_PER_DAY, applyVisitNext, confirmRepeat, conversationLater, conversationPerson, conversationStart, conversationSubmit, conversationTurn, conversationView, conversationWithdraw, findConversation, interviewWaitFor, repeatConfirmationView, type ConversationRef } from "./services/apply-conversation";
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

  /**
   * A first application gets its own AI interview once the résumé is read (20 Oct 2026). A repeat submission gets the same
   * waiting room, which opens a detached AI interview made for that visit (Q14 kept in full, founder 21 Oct); past the
   * day's conversations for the application it names nothing and ends on "check your email".
   */
  type Outcome = { kind: "conversation"; token: string } | { kind: "receipt"; reason: string };
  async function applyNow(p: { first: string; email: string }): Promise<{ outcome: Outcome; applicationId: string; duplicate: boolean }> {
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    const [company] = await container.db.select().from(companies).where(eq(companies.id, role.companyId));
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    const eligibilityAnswers = Object.fromEntries(elig.map((r) => [r.key, "yes"]));
    const result = await withTenant(container.db, company.id, async (tx) => {
      const created = await createApplication(tx, container, { companyId: company.id, roleId, source: "careers_page", firstName: p.first, lastName: "Applicant", email: p.email, phone: null, smsConsent: false, consentSource: "careers_page_apply", noticeVersionsShown: ["ai_use@2026-10-08", "privacy@2026-09-01"], eligibilityAnswers, noResumeAnswers: { summary: "Registered dental hygienist for six years, active CA RDH license, perio maintenance in Dentrix." } }, { kind: "candidate", id: "applicant" });
      const next = await applyVisitNext(tx, container, { application: created.application, duplicate: created.duplicate, knownPerson: created.knownPerson, company, role, packet: pv.packet as RolePacket, eligibilityAnswers, typedFirstName: p.first });
      return { next, applicationId: created.application.id, duplicate: created.duplicate };
    });
    await container.kick();
    await container.drain();
    if (result.next.kind !== "interview") throw new Error(`expected the waiting room, got ${result.next.reason}`);
    if (result.duplicate) {
      // the same waiting room as a first application, waiting for a detached interview instead of the application's own
      expect(result.next.applicationId).toBeNull();
      if (!result.next.conversationId) return { outcome: { kind: "receipt", reason: "conversation_by_email" }, applicationId: result.applicationId, duplicate: true };
      const wait = await interviewWaitFor(container.db, result.next.conversationId);
      if (wait.state !== "ready") throw new Error(`expected the detached interview, got ${wait.state}`);
      return { outcome: { kind: "conversation", token: wait.token }, applicationId: result.applicationId, duplicate: true };
    }
    const wait = await interviewWaitFor(container.db, result.applicationId);
    if (wait.state !== "ready") throw new Error(`expected the AI interview, got ${wait.state}`);
    return { outcome: { kind: "conversation", token: wait.token }, applicationId: result.applicationId, duplicate: false };
  }
  const refOf = async (outcome: Outcome): Promise<ConversationRef> => {
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
    // the chat's close, as a first application's: the typed name, one thing said, what happens next
    expect(view.transcript.at(-1)?.content).toMatch(/^Thank you, Rosa\. You told me "[^"]+"\.\n\n/);
    expect(view.transcript.at(-1)?.content.endsWith(chatNextLine("Repeat Dental"))).toBe(true);
    expect(view.transcript.at(-1)?.content).not.toBe(REVIEW_MESSAGE);
    // its chat names only what was typed in that visit: the form's answers, never anything on file
    const [typed] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, ref.id));
    expect(typed.progress.typedFacts?.cv).toEqual([]);
    expect(typed.progress.typedFacts?.formAnswers.length).toBe(elig.length);
    expect(typed.progress.chat?.items.every((i) => i.kind === "written")).toBe(true);
    expect(await conversationSubmit(container, ref)).toBe(true);
    // the real application still has its own untouched invitation, and nobody on the team heard anything
    expect((await screensOf(rosaId)).find((s) => s.id === rosaRealScreenId)?.status).toBe("invited");
    expect((await reload(rosaId)).stage).toBe("screen_invited");
    const token = confirmLink("rosa@repeat.test");
    expect(token).toBeTruthy();
    // the team sees that email on her page without its link's token (only its hash is kept), nor her status link's
    const detail = await (await json("GET", `/api/v1/applications/${rosaId}`)).text();
    expect(detail).not.toContain(token!);
    expect(detail).toContain("/c/confirm-answers/[link]");
    expect(detail).not.toContain((await reload(rosaId)).statusToken);
    const [row] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.token, ref.token));
    expect(row).toMatchObject({ status: "completed", confirmation: "sent", intent: "answers" });
    expect(row.confirmTokenHash).not.toBe(token); // only the hash is kept
    // opening the link changes nothing; pressing the button adds the answers
    expect(await repeatConfirmationView(container.db, token!, container.engine.clock())).toMatchObject({ state: "ready", intent: "answers", companyName: "Repeat Dental" });
    expect((await screensOf(rosaId)).find((s) => s.id === rosaRealScreenId)?.status).toBe("invited");
    // Review & send's write-up of her words rides on the copy until she confirms
    const writeup = { v: 1 as const, writtenAt: new Date(BASE).toISOString(), aiRunId: null, promptVersion: null, answers: [{ questionKey: "wq_x", answer: "I chart perio in Dentrix.", status: "answered" as const, quotes: [], note: null, by: "writeup" as const }] };
    await container.db.update(unconfirmedScreens).set({ progress: { ...row.progress, writeup } }).where(eq(unconfirmedScreens.id, row.id));
    expect(await confirmRepeat(container, token!)).toMatchObject({ state: "added" });
    await container.drain();
    const merged = (await screensOf(rosaId)).find((s) => s.id === rosaRealScreenId)!;
    // the merged screen holds the write-up; the copy keeps none of her words, condensed or not
    expect(merged.progress.writeup?.answers[0].answer).toBe("I chart perio in Dentrix.");
    expect(merged.status).toBe("completed");
    expect(merged.transcript.filter((t) => t.role === "candidate").length).toBeGreaterThan(0);
    expect((await container.db.select().from(assessments).where(and(eq(assessments.applicationId, rosaId), eq(assessments.kind, "screen"))))).toHaveLength(1);
    expect(["screen_complete", "interview_recommended"]).toContain((await reload(rosaId)).stage);
    const [after] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, row.id));
    expect(after).toMatchObject({ confirmation: "confirmed", transcript: [], answers: {}, mergedScreenId: rosaRealScreenId });
    // what was typed in that visit goes with the words, and never joins the real conversation
    expect(after.progress.typedFacts).toBeUndefined();
    expect(after.progress.writeup).toBeUndefined();
    expect(merged.progress.typedFacts).toBeUndefined();
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
    const [copyRow] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, ref.id));
    await container.db.update(unconfirmedScreens).set({ progress: { ...copyRow.progress, writeup: { v: 1, writtenAt: new Date(BASE).toISOString(), aiRunId: null, promptVersion: null, answers: [{ questionKey: "wq_x", answer: "Words that joined nothing.", status: "answered", quotes: [], note: null, by: "writeup" }] } } }).where(eq(unconfirmedScreens.id, ref.id));
    expect(await confirmRepeat(container, token)).toMatchObject({ state: "not_added" });
    // its page names neither the employer nor the job, so the "Company · Job" eyebrow stays above the heading (23 October 2026)
    expect(await (await app.request(`/c/confirm-answers/${token}`)).text()).toMatch(/<main><p class="eyebrow">Repeat Dental · [^<]+<\/p><h1>Nothing was added<\/h1>/);
    expect((await reload(rosaId)).stage).toBe(stage);
    expect((await screensOf(rosaId))).toHaveLength(1);
    // answers that were not added never joined any application: nothing of them is kept on the copy
    const [notAdded] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, ref.id));
    expect(notAdded.progress.writeup).toBeUndefined();
    expect(notAdded.progress.typedFacts).toBeUndefined();
    expect(JSON.stringify(notAdded.progress)).not.toContain("Words that joined nothing.");
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
    const refs: ConversationRef[] = [];
    for (let i = 0; i < 3; i++) refs.push(await refOf((await applyNow({ first: "Someone", email: "max@repeat.test" })).outcome));
    // five presses of "Do this later" across the three copies (the last one pressed three times)
    for (const ref of [...refs, refs[2], refs[2]]) expect(await conversationLater(container, ref)).toBe(true);
    await container.drain();
    const later = mail().filter((m) => m.to === "max@repeat.test" && /^Please check: an application for/.test(m.subject));
    expect(later).toHaveLength(DETACHED_EMAILS_PER_DAY);
    expect(later[0].text).toContain("someone using this email address applied again and chose to answer the screening questions later. Nothing has been changed.");
    expect(later[0].text).toContain("Nothing is added to your application unless you confirm it at the end.");
    expect(later[0].text).not.toMatch(/Here is the link to the short screening conversation/);
    // the copy's own "please confirm" falls under the same cap: recorded, and nothing sent
    const ref = refs[2];
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
    // past its seven days, before the clean-up runs, the link reads as expired; that page names neither the employer nor
    // the job, so the "Company · Job" eyebrow stays (23 October 2026). Only the clock moves here: no job runs.
    const at = offset;
    setClock(at + 8 * DAY);
    expect(await (await app.request(`/c/confirm-answers/${token}`)).text()).toMatch(/<main><p class="eyebrow">Repeat Dental · [^<]+<\/p><h1>This link has expired<\/h1>/);
    setClock(at);
    expect(await confirmRepeat(container, token)).toMatchObject({ state: "person" });
    // once confirmed, the line under the heading names the employer and the job, so no eyebrow repeats them
    expect(await (await app.request(`/c/confirm-answers/${token}`)).text()).toMatch(/<main><h1>A person will be in touch<\/h1><div class="card" role="status"><p>We have asked the hiring team at Repeat Dental to contact you about your application for [^<]+\./);
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

  it("one application opens a few conversations a day, its own and repeat submissions' together; past that a repeat's waiting room opens nothing and ends on 'check your email', after as many submissions whether or not the address applied before", async () => {
    const first = await applyNow({ first: "Noa", email: "noa@repeat.test" });
    expect(first.outcome.kind).toBe("conversation");
    const copies = () => container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.applicationId, first.applicationId));
    for (let i = 1; i < CONVERSATIONS_PER_APPLICATION_PER_DAY; i++) expect((await applyNow({ first: "Someone", email: "noa@repeat.test" })).outcome.kind).toBe("conversation");
    expect(await copies()).toHaveLength(CONVERSATIONS_PER_APPLICATION_PER_DAY - 1);
    // its waiting room names nothing and ends on "check your email": no copy, no link, nothing for the model
    expect((await applyNow({ first: "Someone", email: "noa@repeat.test" })).outcome).toEqual({ kind: "receipt", reason: "conversation_by_email" });
    expect(await copies()).toHaveLength(CONVERSATIONS_PER_APPLICATION_PER_DAY - 1);
    // more than a day on, an address that applied before opens as many as a new one did
    const dayAgo = new Date(Date.now() - 25 * 3600_000).toISOString();
    await container.db.update(unconfirmedScreens).set({ createdAt: dayAgo }).where(eq(unconfirmedScreens.applicationId, first.applicationId));
    await container.db.update(screens).set({ createdAt: dayAgo }).where(eq(screens.applicationId, first.applicationId));
    // the application's own interview counts from when the application was made (21 Oct), so it is older than a day too
    await container.db.update(applications).set({ createdAt: dayAgo }).where(eq(applications.id, first.applicationId));
    for (let i = 0; i < CONVERSATIONS_PER_APPLICATION_PER_DAY; i++) expect((await applyNow({ first: "Someone", email: "noa@repeat.test" })).outcome.kind).toBe("conversation");
    expect((await applyNow({ first: "Someone", email: "noa@repeat.test" })).outcome).toEqual({ kind: "receipt", reason: "conversation_by_email" });
  });

  it("a repeat submission's conversation has the same cap on model calls as a first one, and ends the same way: at checking the answers", async () => {
    await applyNow({ first: "Ezra", email: "ezra@repeat.test" });
    const again = await applyNow({ first: "Ezra", email: "ezra@repeat.test" });
    const ref = await refOf(again.outcome);
    expect(ref.kind).toBe("detached");
    await conversationStart(container, ref);
    const packet = ((await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: RolePacket } }).currentPacket.packet;
    // the same cap as a first application's chat (Wave S7): its questions and the closing question, four replies each
    const [row] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, ref.id));
    const cap = modelTurnCap(chatPacket(packet, row.progress), row.progress);
    expect(cap).toBe(4 * (packet.screening.questions.length + 1) + 5);
    const chat = { messageToCandidate: "The hiring team can tell you more about that.", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: "company", sentiment: "fine", done: false, humanRequested: false };
    for (let i = 0; i < cap + 2; i++) container.fake!.scriptNext("screen.turn", chat);
    const turns = () => container.fake!.calls.filter((c) => c.task === "screen.turn").length;
    const before = turns();
    for (let i = 0; i < cap + 2; i++) await conversationTurn(container, ref, { message: "Is there parking near the office?" });
    expect(turns()).toBe(before + cap);
    const view = (await conversationView(container.db, ref))!;
    expect(view.phase).toBe("review");
    expect(view.transcript.some((t) => t.role === "assistant" && t.content === chatClosingMessage(CHAT_CAP_CLOSING, "Repeat Dental"))).toBe(true);
    expect(view.transcript.some((t) => t.content === TURN_CAP_REVIEW_MESSAGE)).toBe(false);
    const [capped] = await container.db.select().from(events).where(and(eq(events.type, "screen.turn_cap_reached"), eq(events.subjectId, ref.id)));
    expect(capped.payload).toMatchObject({ detached: true, ending: "review", cap });
    container.fake!.clearScripts();
  });

  it("what the record holds from earlier chats (learned, or kept on an application) never reaches a repeat submission's chat: it names only what that visit typed (Wave S8)", async () => {
    const first = await applyNow({ first: "Lia", email: "lia@repeat.test" });
    const onFile = await reload(first.applicationId);
    const from = { applicationId: onFile.id, screenId: null, roleTitle: "Earlier Robotics Cohort", at: new Date(BASE).toISOString() };
    await container.db.update(applications).set({ answers: { ...onFile.answers, learned: [{ id: "lf_lia_learned", kind: "experience", text: "I ran perio maintenance for a whole county clinic.", quote: "I ran perio maintenance for a whole county clinic.", from }], kept: [{ id: "lf_lia_kept", kind: "logistics", text: "I bike to work along the river trail.", from, keptAt: new Date(BASE).toISOString() }] } }).where(eq(applications.id, onFile.id));
    // typing her address again, without the emailed link: a detached chat with nothing from her record
    const again = await applyNow({ first: "Someone", email: "lia@repeat.test" });
    const ref = await refOf(again.outcome);
    expect(ref.kind).toBe("detached");
    await conversationStart(container, ref);
    const [row] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, ref.id));
    expect(row.progress.typedFacts?.cv).toEqual([]);
    const view = (await conversationView(container.db, ref))!;
    for (const seen of [JSON.stringify(row), JSON.stringify(view)]) expect(seen).not.toMatch(/county clinic|river trail|Earlier Robotics Cohort|lf_lia_/);
  });
});
