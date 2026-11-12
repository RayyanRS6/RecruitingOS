import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entitlements } from "../../packages/core/src/index";
import type { IntakeSessionView } from "../../packages/contracts/src/index";
import { createApp } from "../../apps/api/src/app";
import { createContainer, type Container } from "../../apps/api/src/container";
import { emptyQuickAnswers, firstMessage, isDealBreakerCard, quickStartPatch, skippedAnswers, toggleQuestion, type QuickAnswers } from "../../apps/web/src/pages/new-role/quick-start";

/**
 * "Write the job post" from the quick start (Wave S2, K2), through the real routes with the fake AI: the first message
 * starts a draft, one edit puts every answer on it (the fairness check refuses a proxy, the cards already answered are
 * skipped, pay counts as set by the person, "draft it" is asked), and the existing builder writes the draft at once.
 */
describe("the quick start hands its answers to the job builder", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@quickstart.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const company = (await (await json("POST", "/api/v1/companies", { name: "Harbor Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    await entitlements.applyPlan(container.db, company.id, "growth");
  });
  afterAll(async () => {
    await container.close();
  });

  it("starts a draft, sets every answer in one edit, and the draft can be written straight away", async () => {
    const a: QuickAnswers = {
      ...emptyQuickAnswers(),
      title: "Dental Hygienist",
      employmentType: "part_time",
      remotePolicy: "onsite",
      place: "Irvine, CA",
      experience: "2",
      below: "must",
      pay: { basis: "hourly", min: "45", max: "55", ceiling: "58" },
      closesOn: "2026-12-01",
      mustHaves: ["Digital radiography and intraoral scanning", "Periodontal charting and non-surgical periodontal therapy"],
      dealBreakers: ["Cannot work Saturdays", "No recent grads"],
      ownQuestions: ["Which practice software have you used?"],
    };
    const started = await json("POST", "/api/v1/intake/sessions", { initialMessage: firstMessage(a) });
    expect(started.status).toBe(201);
    const { session } = (await started.json()) as { session: IntakeSessionView };
    expect(session.messages[0]).toMatchObject({ role: "owner", content: firstMessage(a) });

    const edited = await json("POST", `/api/v1/intake/sessions/${session.id}/answers`, { answers: skippedAnswers(session.questions), patch: quickStartPatch(a, "dental", session.facts), draftIt: true, reply: false });
    expect(edited.status).toBe(200);
    const body = (await edited.json()) as { session: IntakeSessionView; reply: unknown; refused: Array<{ text: string }> };
    expect(body.reply).toBeNull();
    expect([...new Set(body.refused.map((r) => r.text))]).toEqual(["No recent grads"]);
    const f = body.session.facts;
    expect(f).toMatchObject({ title: "Dental Hygienist", employmentType: "part_time", remotePolicy: "onsite", locationText: "Irvine, CA", compensationBasis: "hourly", compensationMin: 45, compensationMax: 55, compensationCeiling: 58 });
    // the must-haves are exactly the person's: the skills, the experience, and the deal-breaker counted openly (Q19), as
    // the requirement it rules people out on; the refused one is a must-have nowhere
    expect([...f.mustHaves].sort()).toEqual([...a.mustHaves, "At least 2 years of relevant experience", "Able to work Saturdays"].sort());
    expect(f.mustHaves).not.toContain("No recent grads");
    expect(f.dealBreakers).toContain("Cannot work Saturdays");
    expect(f.dealBreakers).not.toContain("No recent grads");
    expect(f.screeningQuestions).toEqual(["Which practice software have you used?"]);
    expect(f.eligibilityNotes.length).toBeGreaterThan(0);
    expect(body.session.pay.confirmed?.via).toBe("edited");
    expect(body.session.readiness.payConfirmed).toBe(true);
    expect(body.session.readiness.mayDraft).toBe(true);
    // the cards about what the quick start already asked are gone; the others (why, who interviews) stay to answer
    const covered = ["title", "location", "employment_type", "remote_policy", "compensation_basis", "compensation", "must_haves", "nice_to_haves", "deal_breakers", "screening_questions", "eligibility"];
    const before = session.questions.filter((q) => covered.includes(q.field)).slice(0, 3).map((q) => q.id);
    expect(body.session.questions.some((q) => before.includes(q.id))).toBe(false);
    // every answer is in the conversation, in the person's name
    const echo = body.session.messages.filter((m) => m.kind === "answers").map((m) => m.content).join("\n");
    expect(echo).toMatch(/Job title: Dental Hygienist/);
    expect(echo).toMatch(/Not used: "No recent grads"/);
    expect(echo).toMatch(/Draft it\./);

    // the job builder writes the post with all of it
    const drafted = await json("POST", `/api/v1/intake/sessions/${session.id}/draft`);
    expect(drafted.status).toBe(200);
    const written = ((await drafted.json()) as { session: IntakeSessionView }).session;
    expect(written.readiness.hasDraft).toBe(true);
    expect(written.draft?.identity.title).toBeTruthy();
    expect(written.draft?.compensation).toMatchObject({ basis: "hourly", min: 45, max: 55 });
    const draftMusts = (written.draft?.requirements.mustHaves ?? []).map((m) => m.text);
    expect(draftMusts).toContain("Able to work Saturdays");
    expect(draftMusts).not.toContain("Cannot work Saturdays");
    expect(draftMusts).not.toContain("No recent grads");
    // the stand-in AI writes the CPR/BLS question as holding nobody; on a draft every question on the form holds a "no"
    // for the owner's decision (live test, 12 Nov 2026)
    const rules = written.draft?.requirements.eligibility ?? [];
    expect(rules.some((e) => e.key === "bls")).toBe(true);
    expect(rules.every((e) => e.knockout)).toBe(true);
  });

  const RDA = "Do you hold an active Registered Dental Assistant (RDA) license in the state where this office is located?";
  const assistant = (over: Partial<QuickAnswers> = {}): QuickAnswers => ({
    ...emptyQuickAnswers(),
    title: "Dental Assistant",
    employmentType: "full_time",
    remotePolicy: "onsite",
    place: "Irvine, CA",
    experience: "none",
    pay: { basis: "hourly", min: "24", max: "28", ceiling: "" },
    noClosingDate: true,
    mustHaves: ["Four-handed dentistry", "Digital radiography"],
    ...over,
  });
  /** Starts a draft from the quick start's answers and writes it, as "Write the job post" does. */
  const quickStart = async (a: QuickAnswers, dealBreakersOffered = true) => {
    const { session } = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: firstMessage(a) })).json()) as { session: IntakeSessionView };
    const edited = await json("POST", `/api/v1/intake/sessions/${session.id}/answers`, { answers: skippedAnswers(session.questions), patch: quickStartPatch(a, "dental", session.facts), draftIt: true, reply: false, dealBreakersOffered });
    expect(edited.status).toBe(200);
    const facts = ((await edited.json()) as { session: IntakeSessionView }).session.facts;
    const drafted = await json("POST", `/api/v1/intake/sessions/${session.id}/draft`);
    expect(drafted.status).toBe(200);
    return { id: session.id, facts, written: ((await drafted.json()) as { session: IntakeSessionView }).session };
  };
  /** The builder's next cards after the remaining ones are answered (skipped) or, with none left, after a word. */
  const nextCards = async (s: IntakeSessionView) => {
    const body = s.questions.length ? { answers: s.questions.map((q) => ({ questionId: q.id, skipped: true })), reply: true } : { note: "Thanks.", reply: true };
    const r = await json("POST", `/api/v1/intake/sessions/${s.id}/answers`, body);
    expect(r.status).toBe(200);
    return ((await r.json()) as { session: IntakeSessionView }).session.questions;
  };

  it("a missing licence as a deal-breaker: the licence is the must-have, its question is on the form and holds a 'no', and the builder does not ask again (live test, 12 Nov 2026)", async () => {
    const a = assistant({ dealBreakers: ["No active California RDA license", "Smokers"], dealBreakersPrivate: ["Smokers"] });
    const { facts, written } = await quickStart(a);
    expect(facts.mustHaves).toEqual(["Four-handed dentistry", "Digital radiography", "Active California RDA license"]);
    expect(facts.dealBreakers).toEqual(["No active California RDA license", "Smokers"]);
    // the licence question ticked itself on step 9: a must-have names the licence
    expect(facts.eligibilityNotes).toContain(RDA);
    expect(facts.suggestions ?? []).toEqual([]);
    const draft = written.draft!;
    expect(draft.requirements.mustHaves.map((m) => m.text)).toContain("Active California RDA license");
    expect(draft.requirements.mustHaves.some((m) => /^(?:no|without|cannot|not)\b/i.test(m.text))).toBe(false);
    expect(draft.requirements.eligibility.filter((e) => e.type === "license" && /\bRDA\b/.test(e.question))).toEqual([expect.objectContaining({ question: RDA, knockout: true })]);
    expect(draft.requirements.eligibility.every((e) => e.knockout)).toBe(true);
    // step 8 already said which deal-breakers count openly: the builder's card never offers the unticked one again
    expect((await nextCards(written)).some(isDealBreakerCard)).toBe(false);
    // without that word from the quick start, the builder would have asked about it
    const asked = (await nextCards((await quickStart(a, false)).written)).find(isDealBreakerCard);
    expect(asked?.options.map((o) => o.label)).toEqual(["Smokers"]);
  });

  it("a licence question the owner unticked never goes on the form, even when a must-have names the licence (live test, 12 Nov 2026)", async () => {
    const named = assistant({ mustHaves: ["Four-handed dentistry", "RDA license"], noDealBreakers: true });
    const a = { ...named, ...toggleQuestion(named, RDA, "dental") };
    const { facts, written } = await quickStart(a);
    expect(facts.eligibilityNotes).not.toContain(RDA);
    expect(facts.suggestions).toEqual([{ field: "eligibility", text: RDA, origin: "playbook" }]);
    expect(written.draft!.requirements.eligibility.some((e) => /\bRDA\b/.test(e.question))).toBe(false);
    expect(written.draft!.requirements.eligibility.every((e) => e.knockout)).toBe(true);
  });

  it("a question for every applicant that asks about a protected characteristic is refused on the questions step (Wave S7)", async () => {
    const a: QuickAnswers = {
      ...emptyQuickAnswers(),
      title: "Dental Hygienist",
      employmentType: "full_time",
      remotePolicy: "onsite",
      place: "Irvine, CA",
      experience: "none",
      pay: { basis: "hourly", min: "45", max: "55", ceiling: "" },
      noClosingDate: true,
      mustHaves: ["Active CA RDH license"],
      noDealBreakers: true,
      ownQuestions: ["Which practice software have you used?", "Are you married?", "Is English your first language?"],
    };
    const started = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: firstMessage(a) })).json()) as { session: IntakeSessionView };
    const edited = await json("POST", `/api/v1/intake/sessions/${started.session.id}/answers`, { answers: skippedAnswers(started.session.questions), patch: quickStartPatch(a, "dental", started.session.facts), reply: false });
    expect(edited.status).toBe(200);
    const body = (await edited.json()) as { session: IntakeSessionView; refused: Array<{ text: string; reason: string; alternative: string }> };
    expect(body.refused.map((r) => r.text)).toEqual(["Are you married?", "Is English your first language?"]);
    expect(body.refused[1].alternative).toMatch(/level of a language the job needs/);
    // the job's own question stays, and so do the guide's yes/no questions on the form
    expect(body.session.facts.screeningQuestions).toEqual(["Which practice software have you used?"]);
    expect(body.session.facts.eligibilityNotes.length).toBeGreaterThan(0);
    const echo = body.session.messages.filter((m) => m.kind === "answers").map((m) => m.content).join("\n");
    expect(echo).toMatch(/Not used: "Are you married\?"/);
  });
});
