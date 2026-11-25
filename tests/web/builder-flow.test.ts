import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IntakeSessionView, IntakeStartResponse, IntakeTurnResponse } from "../../packages/contracts/src/index";
import { createApp } from "../../apps/api/src/app";
import { createContainer, type Container } from "../../apps/api/src/container";
import { seedCompany, usePlan } from "../../apps/api/src/test-helpers";
import { addOwn, answerOf, answersPayload, cardsToShow, echoText, initialCards, payFormShown, setDraft, setPayForm, togglePick, writeHelp } from "../../apps/web/src/builder";

/**
 * The job builder's page and its API together, on the stand-in AI: the cards the API answers are held and sent with the
 * page's own helpers (apps/web/src/builder.ts), and what they send is posted to the real routes. For faults neither
 * side's own tests can see, because each side did what it said and the owner still could not write the job.
 */
describe("the job builder's cards, sent as the page sends them", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  const sessions = "/api/v1/intake/sessions";
  const post = async <T>(path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const r = await app.request(path, { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as T };
  };

  // Long enough, over enough lines, to be read as a pasted job ad. It states the pay; it does not say on site or remote.
  const AD = [
    "Dental Assistant",
    "Location: Irvine, CA",
    "Full time, Monday to Friday, 8am to 5pm",
    "Schedule: Monday to Friday, 8am to 5pm",
    "Pay: $24 - $28 per hour",
    "About us: Harbor Dental is a family practice that has served Irvine for twenty years.",
    "What you will do: seat patients, take digital x-rays and keep the operatories ready.",
    "Requirements: radiography certificate and two years of chairside experience.",
    "You will work chairside alongside our two hygienists, with a team that has been together for years.",
  ].join("\n");

  /** A draft started from the ad: its pay is stated, nobody has confirmed it, and three cards are open. */
  const fromTheAd = async (): Promise<IntakeSessionView> => {
    const started = await post<IntakeStartResponse>(sessions, { initialMessage: AD });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const view = started.body.session!;
    expect(view.pay).toMatchObject({ basis: "hourly", stated: { min: 24, max: 28 }, confirmed: null });
    expect(view.readiness).toMatchObject({ payConfirmed: false, mayDraft: false });
    expect(cardsToShow(view).map((q) => [q.field, q.mode])).toEqual([["remote_policy", "single"], ["compensation", "pay"], ["must_haves", "multi"]]);
    return view;
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const made = await seedCompany(app, { email: "owner@paycard.test", name: "Harbor Dental" });
    owner = made.owner;
    await usePlan(container, made.companyId, "ultra");
  });
  afterAll(async () => {
    await container.close();
  });

  // Found by two audits in November 2026: the pay card drew the ad's range, the owner pressed Send on the filled card,
  // the page sent it as skipped, and "Write the job" stayed grey with "Confirm the pay on the pay card".
  it("a pasted ad's pay, left on the pay card as it is drawn and sent, is confirmed by the person who sent it, and the job can be written", async () => {
    let view = await fromTheAd();
    const cards = cardsToShow(view);
    const [arrangement, payCard, mustHaves] = cards;
    // the card draws the ad's range
    expect(payFormShown(answerOf(initialCards(), payCard), view.pay)).toEqual({ basis: "hourly", min: "24", max: "28" });
    // the owner answers the other two cards, leaves the pay card as it is drawn, and presses Send
    let state = togglePick(initialCards(), arrangement, "onsite");
    state = addOwn(setDraft(state, mustHaves, "Radiography certificate"), mustHaves);
    const echoed = echoText(cards, state, view.pay);
    expect(echoed).toBe("On site, hybrid or remote: On site\nPay: $24–$28 an hour\nMust-haves: Radiography certificate");
    const turn = await post<IntakeTurnResponse>(`${sessions}/${view.id}/answers`, { answers: answersPayload(cards, state, view.pay) });
    expect(turn.status, JSON.stringify(turn.body)).toBe(200);
    expect(turn.body.summary).toEqual(["On site, hybrid or remote: On site", "Pay: $24–$28 an hour", "Must-haves: Radiography certificate"]);
    // the line the page showed at once is, word for word, the message the server then keeps in the conversation: both
    // name each answer by the contracts' one table
    expect(echoed.split("\n")).toEqual(turn.body.summary);
    expect(turn.body.session.messages.filter((m) => m.kind === "answers").at(-1)?.content).toBe(echoed);
    view = turn.body.session;
    expect(view.pay.confirmed).toMatchObject({ via: "confirmed" });
    expect(view.readiness).toMatchObject({ payConfirmed: true, missing: [], mayDraft: true, draftBlocker: null });
    expect(writeHelp(view.readiness)).toEqual({ ready: true, lines: [] });
    expect(cardsToShow(view).filter((q) => q.mode === "pay")).toEqual([]);
    // "Write the job" is allowed, and the job carries the pay with who confirmed it
    const written = await post<{ session: IntakeSessionView }>(`${sessions}/${view.id}/draft`);
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect(written.body.session.draft?.compensation).toMatchObject({ basis: "hourly", min: 24, max: 28 });
    expect(written.body.session.draft?.provenance.payConfirmedBy).toMatchObject({ via: "confirmed", by: { kind: "user" } });
  });

  it("a pay card the owner emptied is a real skip: it comes back with the ad's pay in its boxes, and sent as drawn it is confirmed", async () => {
    let view = await fromTheAd();
    const cards = cardsToShow(view);
    const [arrangement, payCard, mustHaves] = cards;
    // not sure of the pay yet: the owner clears the two boxes and answers the rest
    let state = togglePick(initialCards(), arrangement, "onsite");
    state = setPayForm(state, payCard, { ...payFormShown(answerOf(state, payCard), view.pay), min: "", max: "" });
    state = addOwn(setDraft(state, mustHaves, "Radiography certificate"), mustHaves);
    const skipped = answersPayload(cards, state, view.pay);
    expect(skipped.find((a) => a.questionId === payCard.id)).toMatchObject({ skipped: true });
    const turn = await post<IntakeTurnResponse>(`${sessions}/${view.id}/answers`, { answers: skipped });
    expect(turn.status, JSON.stringify(turn.body)).toBe(200);
    view = turn.body.session;
    // nothing but the pay holds the job, and the page says so
    expect(view.readiness).toMatchObject({ payConfirmed: false, missing: [], mayDraft: false });
    expect(writeHelp(view.readiness)).toEqual({ ready: false, lines: ["Confirm the pay on the pay card before the job is written."] });
    expect((await post(`${sessions}/${view.id}/draft`)).status).toBe(409);
    // so the pay card is there to confirm it on, still showing the ad's range
    const again = cardsToShow(view);
    expect(again.map((q) => [q.field, q.mode])).toEqual([["compensation", "pay"]]);
    expect(payFormShown(answerOf(initialCards(), again[0]), view.pay)).toEqual({ basis: "hourly", min: "24", max: "28" });
    // Send, with nothing touched
    const confirmed = await post<IntakeTurnResponse>(`${sessions}/${view.id}/answers`, { answers: answersPayload(again, initialCards(), view.pay) });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    view = confirmed.body.session;
    expect(view.pay.confirmed).toMatchObject({ via: "confirmed" });
    expect(view.readiness).toMatchObject({ payConfirmed: true, mayDraft: true });
    expect(cardsToShow(view)).toEqual([]);
    expect((await post(`${sessions}/${view.id}/draft`)).status).toBe(200);
  });
});
