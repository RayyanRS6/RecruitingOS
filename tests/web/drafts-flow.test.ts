import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { draftStillNeeds, type IntakeDraftAnswer, type IntakeSessionList, type IntakeSessionResponse, type IntakeStartResponse, type IntakeTurnResponse } from "../../packages/contracts/src/index";
import { createApp } from "../../apps/api/src/app";
import { createContainer, type Container } from "../../apps/api/src/container";
import { seedCompany, usePlan } from "../../apps/api/src/test-helpers";
import { addOwn, answerOf, answersPayload, cardsToShow, essentialsList, initialCards, payFormShown, setDraft, setPayForm, togglePick } from "../../apps/web/src/builder";
import { todayIn } from "../../apps/web/src/dates";
import { closingDateProblem, draftRow } from "../../apps/web/src/jobs";

/**
 * A draft of the job builder as its pages read it, the pages and the API together on the stand-in AI: what the API
 * answers about a draft is handed to the pages' own helpers (apps/web/src), so a rule kept on both sides is held to one
 * answer. For the small rules that were once decided twice: what "today" is for a draft's closing date, and what a
 * draft still needs.
 */
describe("a draft, as its pages and the API read it together", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  /** The engine's clock, which the API reads "now" from; each test sets it. */
  let clock = new Date("2026-11-18T18:00:00.000Z");
  const sessions = "/api/v1/intake/sessions";
  const send = async <T>(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const r = await app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as T };
  };
  /** An owner's first sentence with every essential in it, the pay typed by them. */
  const HYGIENIST = "I need a registered dental hygienist in Tustin, CA, on site, full time, Monday to Friday, $45 to $55 an hour. Must-haves: active CA RDH license, periodontal charting.";
  /** A draft started with these words, as the builder's first box sends them: the draft, and the company's time zone beside it. */
  const start = async (cookie: string, words: string): Promise<IntakeDraftAnswer> => {
    const started = await send<IntakeStartResponse>(cookie, "POST", sessions, { initialMessage: words });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    if (!started.body.session) throw new Error("no draft was started");
    return { session: started.body.session, timeZone: started.body.timeZone };
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, now: () => clock, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    // a company on the East Coast: its day ends hours before a device set to UTC, and hours after one in Los Angeles
    const made = await seedCompany(app, { email: "owner@drafts.test", name: "Harbor Dental", timezone: "America/New_York" });
    owner = made.owner;
    await usePlan(container, made.companyId, "ultra");
  });
  afterAll(async () => {
    await container.close();
  });

  it("counts today for a draft's closing date in the company's time zone on both sides: the earliest day the page offers is one the server takes", async () => {
    // half past eleven at night on 18 November in New York; already the 19th on a device set to UTC
    clock = new Date("2026-11-19T04:30:00.000Z");
    const { session: draft, timeZone } = await start(owner, HYGIENIST);
    expect(timeZone).toBe("America/New_York");
    const today = todayIn(timeZone, clock);
    expect(today).toBe("2026-11-18");
    // the page lets that day through, and the server takes it; its answer carries the time zone again
    expect(closingDateProblem(today, timeZone, clock)).toBeNull();
    const set = await send<IntakeSessionResponse>(owner, "PUT", `${sessions}/${draft.id}/closing-date`, { closesOn: today });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ session: { closesOn: today }, timeZone: "America/New_York" });
    expect((await send<IntakeSessionResponse>(owner, "GET", `${sessions}/${draft.id}`)).body.timeZone).toBe("America/New_York");
    // the day before is refused on both sides
    expect(closingDateProblem("2026-11-17", timeZone, clock)).toBe("Choose today or a later date.");
    expect((await send(owner, "PUT", `${sessions}/${draft.id}/closing-date`, { closesOn: "2026-11-17" })).status).toBe(400);
    // counted on a device's own calendar instead (UTC here), the page would have refused the 18th, a day the server takes
    expect(closingDateProblem(today, "UTC", clock)).toBe("Choose today or a later date.");
  });

  // Found by the check of 24 November 2026: a draft read "ready" in the list and "still needed" when opened, because the
  // builder counted pay nobody had confirmed and the draft's line did not.
  it("says the same of what a draft still needs in its line of a list and in the builder: pay a pasted ad stated waits for a person on both", async () => {
    clock = new Date("2026-11-18T18:00:00.000Z");
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
    let { session: view } = await start(owner, AD);
    const lineOf = async () => {
      const mine = (await send<IntakeSessionList>(owner, "GET", `${sessions}?mine=1`)).body.sessions.find((d) => d.id === view.id);
      if (!mine) throw new Error("the draft is not in its starter's list");
      return mine;
    };
    /** "N things still needed" as the draft's line says it, or null when the line says nothing of the kind. */
    const neededOnTheLine = async () => draftRow(await lineOf(), clock).facts.find((f) => f.endsWith("still needed")) ?? null;
    /** What the builder lists under "Still needed" when the draft is opened. */
    const neededInTheBuilder = () => essentialsList(view.readiness).missing.map((i) => i.key);

    // as started: the arrangement and a must-have are missing, and the ad's pay waits to be confirmed
    expect(view.readiness).toMatchObject({ missing: ["remote_policy", "must_haves"], payConfirmed: false });
    expect(neededInTheBuilder()).toEqual(["remote_policy", "compensation_range", "must_haves"]);
    expect(await neededOnTheLine()).toBe("3 things still needed");

    // the owner answers the two cards and empties the pay card: every essential is in, and only the pay waits
    const cards = cardsToShow(view);
    const [arrangement, payCard, mustHaves] = cards;
    let state = togglePick(initialCards(), arrangement, "onsite");
    state = setPayForm(state, payCard, { ...payFormShown(answerOf(state, payCard), view.pay), min: "", max: "" });
    state = addOwn(setDraft(state, mustHaves, "Radiography certificate"), mustHaves);
    const turn = await send<IntakeTurnResponse>(owner, "POST", `${sessions}/${view.id}/answers`, { answers: answersPayload(cards, state, view.pay) });
    expect(turn.status, JSON.stringify(turn.body)).toBe(200);
    view = turn.body.session;
    expect(view.readiness).toMatchObject({ missing: [], payConfirmed: false, mayDraft: false });
    // the builder still asks for the pay, and the line says one thing is still needed: neither reads as ready
    expect(neededInTheBuilder()).toEqual(["compensation_range"]);
    expect(await neededOnTheLine()).toBe("1 thing still needed");
    expect(await lineOf()).toMatchObject({ missing: [], payConfirmed: false });
    expect(draftStillNeeds(await lineOf())).toEqual(draftStillNeeds(view.readiness));

    // the pay card sent as drawn confirms the pay: nothing is still needed, on either side
    const again = cardsToShow(view);
    const confirmed = await send<IntakeTurnResponse>(owner, "POST", `${sessions}/${view.id}/answers`, { answers: answersPayload(again, initialCards(), view.pay) });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    view = confirmed.body.session;
    expect(view.readiness).toMatchObject({ missing: [], payConfirmed: true, mayDraft: true });
    expect(neededInTheBuilder()).toEqual([]);
    expect(await neededOnTheLine()).toBeNull();
  });
});
