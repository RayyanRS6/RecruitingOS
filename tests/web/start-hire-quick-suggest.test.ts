import { describe, expect, it } from "vitest";
import { IntakeFactsPatch } from "../../packages/contracts/src/index";
import { GENERAL_QUESTIONS } from "../../apps/web/src/pages/new-role/quick-starts";
import { chosenQuestions, emptyQuickAnswers, emptyQuickState, offeredQuestions, quickStartPatch, readQuickStart, reviewRows, writeQuickStart, type QuickAnswers } from "../../apps/web/src/pages/new-role/quick-start";
import {
  SUGGEST_PATH, adoptSuggestion, aiSuggestFor, fetchSuggestions, readAiSuggest, readSuggestResponse, suggestBody, suggestKey, suggestQueryKey, suggestView, wantsAiSuggestions, type AiSuggest,
} from "../../apps/web/src/pages/new-role/quick-suggest";

/**
 * AI suggestions in the quick start (Wave S3, G3): for a job no hiring guide knows, the assistant suggests must-haves and
 * yes/no questions from the answers so far, once per set of answers; the guide's show at once when it knows the job; a
 * failure or a slow answer shows nothing; the questions come ticked and go on the draft, the must-haves only when ticked.
 */
const driver = (over: Partial<QuickAnswers> = {}): QuickAnswers => ({
  ...emptyQuickAnswers(),
  title: "Delivery Driver",
  employmentType: "part_time",
  remotePolicy: "onsite",
  place: "Austin, TX",
  experience: "2",
  below: "consider",
  pay: { basis: "hourly", min: "20", max: "24", ceiling: "" },
  noClosingDate: true,
  mustHaves: ["Clean driving record"],
  noDealBreakers: true,
  ...over,
});
const made = (a: QuickAnswers, s: Omit<AiSuggest, "key">): AiSuggest => ({ key: suggestKey(a), ...s });

describe("what the assistant is asked, and when", () => {
  it("is asked only about the job's facts, never anything else the person typed", () => {
    expect(suggestBody(driver({ dealBreakers: ["Smokers"], ad: "An ad", pay: { basis: "hourly", min: "1", max: "2", ceiling: "3" } }))).toEqual({ title: "Delivery Driver", employmentType: "part_time", remotePolicy: "onsite", place: "Austin, TX", experience: "2" });
    expect(suggestBody({ title: "  " })).toBeNull();
    expect(suggestBody({ title: "  Bookkeeper  ", place: " " })).toEqual({ title: "Bookkeeper" });
  });

  it("asks only for a job no hiring guide knows", () => {
    expect(wantsAiSuggestions("dental", { title: "Dental hygienist" })).toBe(false);
    expect(wantsAiSuggestions("dental", { title: "Delivery driver" })).toBe(true);
    expect(wantsAiSuggestions("logistics", { title: "Dental hygienist" })).toBe(true);
    expect(wantsAiSuggestions(null, { title: "" })).toBe(false);
  });

  it("asks once per set of answers: the same answers however typed are one set, a changed answer is another", () => {
    const a = driver();
    expect(suggestKey(driver({ title: "  delivery   driver ", place: "austin, tx" }))).toBe(suggestKey(a));
    expect(suggestKey(driver({ remotePolicy: "hybrid" }))).not.toBe(suggestKey(a));
    expect(suggestKey(driver({ pay: { basis: "salary", min: "1", max: "2", ceiling: "" } }))).toBe(suggestKey(a));
    expect(suggestQueryKey("k")).toEqual(["intake", "suggest", "k"]);
    // kept suggestions count only for the answers they were made from
    const kept = made(a, { mustHaves: ["Forklift"], questions: [] });
    expect(aiSuggestFor({ ...a, aiSuggest: kept })).toEqual(kept);
    expect(aiSuggestFor({ ...a, title: "Courier", aiSuggest: kept })).toBeNull();
  });
});

describe("what each step shows", () => {
  it("the guide's at once; else a short line while the assistant works, then its suggestions; nothing when it fails", () => {
    expect(suggestView("dental", { title: "Dental hygienist" }, { waiting: true })).toEqual({ kind: "guide" });
    const a = driver();
    expect(suggestView("logistics", a, { waiting: true })).toEqual({ kind: "waiting" });
    expect(suggestView("logistics", a, { waiting: false })).toEqual({ kind: "none" });
    const fresh = made(a, { mustHaves: ["Forklift"], questions: ["Can you lift 50 lb?"] });
    expect(suggestView("logistics", a, { fresh, waiting: false })).toEqual({ kind: "ai", mustHaves: ["Forklift"], questions: ["Can you lift 50 lb?"] });
    expect(suggestView("logistics", { ...a, aiSuggest: fresh })).toEqual({ kind: "ai", mustHaves: ["Forklift"], questions: ["Can you lift 50 lb?"] });
    // an answer for other answers is not shown
    expect(suggestView("logistics", driver({ title: "Courier" }), { fresh, waiting: false })).toEqual({ kind: "none" });
  });

  it("offers the assistant's questions ticked after the general ones, each once; never for a job the guide knows", () => {
    const a = driver();
    const s = made(a, { mustHaves: [], questions: ["Do you hold a valid driver's licence?", GENERAL_QUESTIONS[0]] });
    expect(offeredQuestions({ ...a, aiSuggest: s }, "logistics")).toEqual([...GENERAL_QUESTIONS, "Do you hold a valid driver's licence?"]);
    expect(chosenQuestions({ ...a, aiSuggest: s }, "logistics")).toEqual([...GENERAL_QUESTIONS, "Do you hold a valid driver's licence?"]);
    expect(chosenQuestions({ ...a, aiSuggest: s, questionsOff: ["Do you hold a valid driver's licence?"] }, "logistics")).toEqual([...GENERAL_QUESTIONS]);
    // answers changed since: the old suggestions are not offered
    expect(offeredQuestions({ ...a, title: "Courier", aiSuggest: s }, "logistics")).toEqual([...GENERAL_QUESTIONS]);
  });

  it("an answer that lands after the person left the questions step adds nothing to the form: its questions start unticked", () => {
    const a = driver();
    const s = made(a, { mustHaves: ["Forklift"], questions: ["Do you hold a valid driver's licence?", "Can you lift 50 lb?"] });
    // seen on the questions step: ticked, as before
    const seen = adoptSuggestion(a, s, true);
    expect(chosenQuestions(seen, "logistics")).toEqual([...GENERAL_QUESTIONS, ...s.questions]);
    // landed while the person was on the review: kept, offered, but not on the form until they tick it
    const late = adoptSuggestion(a, s, false);
    expect(late.aiSuggest).toEqual(s);
    expect(offeredQuestions(late, "logistics")).toEqual([...GENERAL_QUESTIONS, ...s.questions]);
    expect(chosenQuestions(late, "logistics")).toEqual([...GENERAL_QUESTIONS]);
    expect(quickStartPatch(late, "logistics", null).add?.filter((x) => x.field === "eligibilityNotes").map((x) => x.value)).toEqual([...GENERAL_QUESTIONS]);
    expect(reviewRows(late, "logistics").find((r) => r.label === "Screening questions")?.value).toBe("2 on the form");
    // and the must-haves are never ticked for them either way
    expect(late.mustHaves).toEqual(a.mustHaves);
    // the same answer again changes nothing
    expect(adoptSuggestion(late, s, false)).toBe(late);
  });
});

describe("on the draft", () => {
  it("puts the assistant's ticked questions on the form, and its must-haves only when the person ticked them", () => {
    const a = driver();
    const s = made(a, { mustHaves: ["Forklift certification", "Route planning"], questions: ["Do you hold a valid driver's licence?"] });
    const patch = quickStartPatch({ ...a, aiSuggest: s, mustHaves: ["Clean driving record", "Route planning"] }, "logistics", null);
    expect(IntakeFactsPatch.parse(patch)).toEqual(patch);
    expect(patch.add?.filter((x) => x.field === "mustHaves").map((x) => x.value)).toEqual(["Clean driving record", "Route planning"]);
    expect(patch.add?.filter((x) => x.field === "eligibilityNotes").map((x) => x.value)).toEqual([...GENERAL_QUESTIONS, "Do you hold a valid driver's licence?"]);
    expect(reviewRows({ ...a, aiSuggest: s }, "logistics").find((r) => r.label === "Screening questions")?.value).toBe("3 on the form");
  });

  it("never lets an offered question push out the person's own words: the edit stays within twenty items", () => {
    const a = driver({ mustHaves: ["a", "b", "c", "d", "e", "f"], dealBreakers: ["v", "w", "x", "y", "z"], dealBreakersPrivate: ["v", "w", "x", "y", "z"], noDealBreakers: false, ownQuestions: ["q1?", "q2?", "q3?", "q4?", "q5?"] });
    const s = made(a, { mustHaves: [], questions: ["Can you lift 50 lb?", "Do you hold a valid driver's licence?", "Can you work weekends?", "Will you drive at night?"] });
    const patch = quickStartPatch({ ...a, aiSuggest: s }, "logistics", null);
    expect(patch.add).toHaveLength(20);
    expect(patch.add?.filter((x) => x.field === "screeningQuestions")).toHaveLength(5);
    expect(IntakeFactsPatch.parse(patch)).toEqual(patch);
  });
});

describe("kept in this browser, and read safely", () => {
  it("keeps the suggestions with the answers, so a reload never asks again", () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    const a = driver();
    const state = { ...emptyQuickState(), step: 6, answers: { ...a, aiSuggest: made(a, { mustHaves: ["Forklift"], questions: ["Can you lift 50 lb?"] }) } };
    writeQuickStart(s, state);
    expect(readQuickStart(s)).toEqual(state);
    expect(readAiSuggest({ key: "", mustHaves: [], questions: [] })).toBeNull();
    expect(readAiSuggest({ key: "k", mustHaves: ["ok", 3, "", "OK"], questions: "no" })).toBeNull();
    expect(readAiSuggest({ key: "k", mustHaves: ["ok", 3, "", "OK"], questions: [] })).toEqual({ key: "k", mustHaves: ["ok"], questions: [] });
  });

  it("reads the server's answer, and treats 'unavailable' as nothing to show", () => {
    expect(readSuggestResponse({ mustHaves: ["A"], questions: ["B?"] }, "k")).toEqual({ key: "k", mustHaves: ["A"], questions: ["B?"] });
    expect(readSuggestResponse({ mustHaves: [], questions: [], unavailable: true }, "k")).toBeNull();
    expect(readSuggestResponse({ mustHaves: Array.from({ length: 12 }, (_, i) => `S${i}`), questions: Array.from({ length: 6 }, (_, i) => `Q${i}?`) }, "k")).toMatchObject({ mustHaves: { length: 8 }, questions: { length: 4 } });
    expect(readSuggestResponse(null, "k")).toBeNull();
  });

  it("asks the server once, and gives up with nothing on a failure or a slow answer", async () => {
    const seen: Array<{ path: string; body: unknown }> = [];
    const ok = await fetchSuggestions(async (path, body) => { seen.push({ path, body }); return { mustHaves: ["A"], questions: [] }; }, { title: "Driver" }, "k");
    expect(ok).toEqual({ key: "k", mustHaves: ["A"], questions: [] });
    expect(seen).toEqual([{ path: SUGGEST_PATH, body: { title: "Driver" } }]);
    expect(await fetchSuggestions(async () => { throw new Error("502"); }, { title: "Driver" }, "k")).toBeNull();
    let aborted = false;
    const slow = await fetchSuggestions((_p, _b, init) => new Promise((resolve) => { init?.signal?.addEventListener("abort", () => { aborted = true; }); setTimeout(() => resolve({ mustHaves: ["late"], questions: [] }), 200); }), { title: "Driver" }, "k", undefined, 10);
    expect(slow).toBeNull();
    expect(aborted).toBe(true);
  });
});
