import { describe, expect, it } from "vitest";
import { INTAKE_FIRST_MESSAGE_MAX, IntakeAnswer, IntakeFactsPatch, ownersCall, type IntakeQuestion, type IntakeServerState } from "../../packages/contracts/src/index";
import { applyFactsPatch, intakeReadiness, normalizeFacts } from "../../packages/core/src/intake-builder";
import { ALL_PLAYBOOKS, findPlaybook, matchPlaybookRole } from "../../packages/playbooks/src/index";
import { NEW_ROLE_FRESH_HREF } from "../../apps/web/src/pages/new-role/rules";
import { GENERAL_QUESTIONS, GUIDE_ROLES, guideRoleFor } from "../../apps/web/src/pages/new-role/quick-starts";
import {
  FORM_QUESTIONS_HOLD, QUICK_STEPS, QUICK_START_STORAGE_KEY, STEP_QUESTION, addItem, allMustHaves, chosenQuestions, clearAllQuickStarts, clearQuickStart, dealBreakerMustHave, dealBreakerWording, emptyQuickAnswers, emptyQuickState, enterMovesOn, experienceMustHave,
  experienceNiceToHave, fillFromAd, firstMessage, firstUnfinished, hasAnswers, isDealBreakerCard, mustHavesFromDealBreakers, mustHavesRoom, offeredQuestions, openDealBreakers, questionOn, quickStartDraftKey, quickStartPatch, quickStartStorageKey, readAd, readQuickStart,
  removeDealBreaker, reviewRows, skippedAnswers, stepProblem, suggestedMustHaves, suggestedQuestions, toggleItem, toggleQuestion, writeQuickStart, type QuickAnswers,
} from "../../apps/web/src/pages/new-role/quick-start";
import { QUICK_START_HREF, START_HIRE_HREF } from "../../apps/web/src/start-hire";

/**
 * The quick start for a new job (Wave S2, K2): ten small steps, one question a screen, then "Write the job post", which
 * hands the answers to the existing job builder. Checked here: the steps, when each may move on, the review, the first
 * message and the one edit that carry the answers (through the server's own fairness check), the suggestions from our
 * hiring guides, a pasted job ad filling in the steps, and the copy kept in this browser.
 */

const TODAY = "2026-10-14";
const filled = (over: Partial<QuickAnswers> = {}): QuickAnswers => ({
  ...emptyQuickAnswers(),
  title: "Dental Hygienist",
  employmentType: "full_time",
  remotePolicy: "onsite",
  place: "Irvine, CA",
  experience: "3",
  below: "must",
  pay: { basis: "hourly", min: "45", max: "55", ceiling: "" },
  closesOn: "2026-11-30",
  mustHaves: ["Digital radiography and intraoral scanning"],
  dealBreakers: ["Cannot work Saturdays"],
  ...over,
});

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe("where the quick start lives", () => {
  it("is the job builder's own page with ?way=quick, beside the other way to start", () => {
    expect(QUICK_START_HREF).toBe(`${START_HIRE_HREF}?way=quick`);
    expect(NEW_ROLE_FRESH_HREF).toBe("/roles/new?new=1");
  });

  it("has ten steps, one question each, ending on the review", () => {
    expect(QUICK_STEPS).toHaveLength(10);
    expect(QUICK_STEPS[0]).toBe("title");
    expect(QUICK_STEPS[9]).toBe("review");
    expect(new Set(QUICK_STEPS.map((s) => STEP_QUESTION[s])).size).toBe(10);
    for (const s of QUICK_STEPS) expect(STEP_QUESTION[s].split(" ").length, s).toBeLessThanOrEqual(12);
  });
});

describe("moving on", () => {
  it("asks for each answer in plain words, and lets a finished step move on", () => {
    const empty = emptyQuickAnswers();
    expect(stepProblem("title", empty, TODAY)).toBe("Type the job title, or paste a job ad.");
    expect(stepProblem("type", empty, TODAY)).toBe("Pick the kind of job.");
    expect(stepProblem("where", empty, TODAY)).toBe("Pick on site, hybrid or remote.");
    expect(stepProblem("where", { ...empty, remotePolicy: "remote" }, TODAY)).toMatch(/Anywhere in the US/);
    expect(stepProblem("experience", empty, TODAY)).toMatch(/least experience/);
    expect(stepProblem("experience", { ...empty, experience: "3" }, TODAY)).toMatch(/still consider/);
    expect(stepProblem("experience", { ...empty, experience: "none" }, TODAY)).toBeNull();
    expect(stepProblem("pay", empty, TODAY)).toBe("Choose by the hour or a yearly salary.");
    expect(stepProblem("closing", empty, TODAY)).toBe("Pick a date, or choose No closing date.");
    expect(stepProblem("closing", { ...empty, closesOn: "2026-10-01" }, TODAY)).toMatch(/today or a later date/);
    expect(stepProblem("closing", { ...empty, noClosingDate: true }, TODAY)).toBeNull();
    expect(stepProblem("musts", empty, TODAY)).toBe("Tick or add at least one must-have.");
    expect(stepProblem("dealbreakers", empty, TODAY)).toBe("Add what rules someone out, or choose None.");
    expect(stepProblem("dealbreakers", { ...empty, noDealBreakers: true }, TODAY)).toBeNull();
    expect(stepProblem("questions", empty, TODAY)).toBeNull();
    for (const s of QUICK_STEPS) expect(stepProblem(s, filled(), TODAY), s).toBeNull();
    expect(firstUnfinished(filled(), TODAY)).toBeNull();
    expect(firstUnfinished(filled({ pay: { basis: "", min: "", max: "", ceiling: "" } }), TODAY)).toBe(QUICK_STEPS.indexOf("pay"));
  });

  it("keeps the must-haves to six, counting the experience when it is one", () => {
    const six = ["a", "b", "c", "d", "e", "f"];
    expect(mustHavesRoom({ experience: "3", below: "must" })).toBe(5);
    expect(mustHavesRoom({ experience: "3", below: "consider" })).toBe(6);
    expect(stepProblem("musts", filled({ mustHaves: six, dealBreakers: [] }), TODAY)).toBe("Keep it to 5. Anything else can wait for the draft.");
    expect(stepProblem("musts", filled({ mustHaves: six, below: "consider", dealBreakers: [] }), TODAY)).toBeNull();
    // the experience alone is enough when it is a must-have
    expect(stepProblem("musts", filled({ mustHaves: [] }), TODAY)).toBeNull();
    expect(experienceMustHave({ experience: "1", below: "must" })).toBe("At least 1 year of relevant experience");
    expect(experienceNiceToHave({ experience: "5", below: "consider" })).toBe("5+ years of relevant experience");
    expect(experienceMustHave({ experience: "none", below: "" })).toBeNull();
  });

  it("adds an item once, within the limit, and ticks or unticks", () => {
    expect(addItem(["Dentrix"], " dentrix ", 6)).toEqual(["Dentrix"]);
    expect(addItem(["a"], "  Two   years  ", 6)).toEqual(["a", "Two years"]);
    expect(addItem(["a", "b"], "c", 2)).toEqual(["a", "b"]);
    expect(addItem([], "   ", 6)).toEqual([]);
    expect(toggleItem(["a", "b"], "A")).toEqual(["b"]);
    expect(toggleItem(["a"], "b")).toEqual(["a", "b"]);
  });

  it("moves on with Enter on a field or a choice, never in a text box, on a button, or mid-word", () => {
    expect(enterMovesOn({ key: "Enter" }, { tagName: "INPUT", type: "text" })).toBe(true);
    expect(enterMovesOn({ key: "Enter" }, { tagName: "INPUT", type: "radio" })).toBe(true);
    expect(enterMovesOn({ key: "Enter" }, { tagName: "TEXTAREA" })).toBe(false);
    expect(enterMovesOn({ key: "Enter" }, { tagName: "BUTTON" })).toBe(false);
    expect(enterMovesOn({ key: "Enter" }, { tagName: "SUMMARY" })).toBe(false);
    expect(enterMovesOn({ key: "Enter", isComposing: true }, { tagName: "INPUT" })).toBe(false);
    expect(enterMovesOn({ key: "Enter", shiftKey: true }, { tagName: "INPUT" })).toBe(false);
    expect(enterMovesOn({ key: "a" }, { tagName: "INPUT" })).toBe(false);
  });
});

describe("suggestions from our hiring guides", () => {
  it("mirror each guide role's title, aliases, common qualifications and yes/no questions exactly", () => {
    for (const [guide, roles] of Object.entries(GUIDE_ROLES)) {
      const playbook = findPlaybook(guide)!;
      expect(roles.map((r) => r.key), guide).toEqual(playbook.roles.map((r) => r.key));
      for (const r of roles) {
        const p = playbook.roles.find((x) => x.key === r.key)!;
        expect(r.title).toBe(p.title);
        expect([...r.aliases]).toEqual(p.aliases);
        expect([...r.mustHaves]).toEqual(p.commonQualifications);
        expect([...r.questions]).toEqual(p.eligibility.map((e) => e.question));
        // the questions that are the owner's call (every expectation optional) are the ones offered unticked
        expect((r.optional ?? []).map((o) => o.question), r.key).toEqual(p.eligibility.filter(ownersCall).map((e) => e.question));
      }
    }
    expect(GUIDE_ROLES.dental.find((r) => r.key === "da")?.optional?.map((o) => o.mentions)).toEqual([["RDA", "registered dental assistant"]]);
  });

  it("offer questions written for candidates, never words for the assistant about the owner (live test, 12 Nov 2026)", () => {
    const AI_WORDS = /\b(?:owner|packet|playbook)\b|\(answer\b|\bif this (?:role|job) requires\b/i;
    const questions = [...ALL_PLAYBOOKS.flatMap((p) => p.roles.flatMap((r) => r.eligibility.map((e) => e.question))), ...Object.values(GUIDE_ROLES).flatMap((roles) => roles.flatMap((r) => r.questions)), ...GENERAL_QUESTIONS];
    expect(questions.length).toBeGreaterThan(10);
    for (const q of questions) {
      expect(q, q).not.toMatch(AI_WORDS);
      expect(q.endsWith("?"), q).toBe(true);
    }
  });

  it("find the guide role the way the server does, and only for a business type a guide serves", () => {
    for (const title of ["Dental hygienist", "Lead dental assistant (RDA)", "Front desk coordinator", "Associate dentist", "Hygienist, part time"]) {
      expect(guideRoleFor("dental", title)?.key, title).toBe(matchPlaybookRole(findPlaybook("dental")!, title)?.key);
    }
    for (const title of ["Social media manager", "Ecommerce manager", "Senior account executive"]) {
      expect(guideRoleFor("ecommerce", title)?.key, title).toBe(matchPlaybookRole(findPlaybook("consumer")!, title)?.key);
    }
    expect(guideRoleFor("veterinary", "Dental hygienist")).toBeNull();
    expect(suggestedMustHaves("dental", "Dental hygienist")).toContain("Digital radiography and intraoral scanning");
    expect(suggestedMustHaves("veterinary", "Vet tech")).toEqual([]);
    expect(suggestedQuestions("veterinary", "Vet tech")).toEqual(GENERAL_QUESTIONS);
  });

  it("offer the questions ticked, and leave out the ones unticked", () => {
    const all = suggestedQuestions("dental", "Dental hygienist");
    expect(chosenQuestions({ title: "Dental hygienist", questionsOff: [] }, "dental")).toEqual([...all]);
    expect(chosenQuestions({ title: "Dental hygienist", questionsOff: [all[0]] }, "dental")).toEqual(all.slice(1));
  });
});

describe("the review", () => {
  it("shows one row a step, each opening its own step", () => {
    const rows = reviewRows(filled({ ownQuestions: ["Which software do you use?"] }), "dental");
    expect(rows.map((r) => r.label)).toEqual(["Job title", "Employment type", "Where", "Minimum experience", "Pay", "Closing date", "Must-have skills", "Deal-breakers", "Screening questions"]);
    expect(rows.map((r) => r.step)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows.find((r) => r.label === "Where")?.value).toBe("On site · Irvine, CA");
    expect(rows.find((r) => r.label === "Minimum experience")?.value).toBe("3+ years · counts as a must-have");
    expect(rows.find((r) => r.label === "Pay")?.value).toBe("$45–$55 an hour");
    expect(rows.find((r) => r.label === "Closing date")?.value).toBe("November 30, 2026");
    // where each question is asked: the suggested ones on the form, where a "no" holds the application for the owner
    // (review of the live-test fixes, 12 Nov 2026), the person's own in the screening chat, which holds nobody
    expect(rows.find((r) => r.label === "Screening questions")?.value).toBe(`${suggestedQuestions("dental", "Dental Hygienist").length} on the form (a "no" holds the application for your decision) · 1 in the AI interview`);
    expect(FORM_QUESTIONS_HOLD).toBe('(a "no" holds the application for your decision)');
    expect(reviewRows(filled({ questionsOff: [...suggestedQuestions("dental", "Dental Hygienist")], ownQuestions: ["Which software do you use?"] }), "dental").find((r) => r.label === "Screening questions")?.value).toBe("1 in the AI interview");
    expect(reviewRows(filled({ noClosingDate: true, noDealBreakers: true, dealBreakers: [] }), "dental").find((r) => r.label === "Deal-breakers")?.value).toBe("None");
    // a deal-breaker left ticked shows among the must-haves as the must-have it counts as, and says which way it counts
    expect(rows.find((r) => r.label === "Must-have skills")?.value).toBe("Digital radiography and intraoral scanning; At least 3 years of relevant experience; Able to work Saturdays");
    expect(rows.find((r) => r.label === "Deal-breakers")?.value).toBe("Cannot work Saturdays (must-have)");
    const priv = reviewRows(filled({ dealBreakersPrivate: ["Cannot work Saturdays"] }), "dental");
    expect(priv.find((r) => r.label === "Deal-breakers")?.value).toBe("Cannot work Saturdays (not used to judge)");
    expect(priv.find((r) => r.label === "Must-have skills")?.value).not.toContain("Saturdays");
  });
});

describe("deal-breakers count openly as must-haves (founder decision Q19)", () => {
  it("ticks each one by default, counts it toward the six, and lets the person untick it", () => {
    expect(openDealBreakers(filled())).toEqual(["Cannot work Saturdays"]);
    expect(openDealBreakers(filled({ dealBreakersPrivate: ["cannot work saturdays"] }))).toEqual([]);
    expect(openDealBreakers(filled({ noDealBreakers: true }))).toEqual([]);
    // already a must-have: counted once
    expect(openDealBreakers(filled({ mustHaves: ["Cannot work Saturdays"] }))).toEqual([]);
    expect(mustHavesRoom(filled())).toBe(4);
    expect(allMustHaves(filled())).toEqual(["Digital radiography and intraoral scanning", "At least 3 years of relevant experience", "Able to work Saturdays"]);
    // too many in all: the deal-breakers step says so, and so does the must-haves step
    const full = filled({ mustHaves: ["a", "b", "c", "d", "e"] });
    expect(stepProblem("dealbreakers", full, TODAY)).toMatch(/Six must-haves at most/);
    expect(stepProblem("musts", full, TODAY)).toMatch(/Keep it to 4, with your deal-breakers counted/);
    expect(stepProblem("dealbreakers", { ...full, dealBreakersPrivate: ["Cannot work Saturdays"] }, TODAY)).toBeNull();
  });

  it("puts the ticked ones on the draft as must-haves, through the fairness check, and leaves the unticked ones out", () => {
    const a = filled({ dealBreakers: ["Cannot work Saturdays", "No recent grads", "Smokers"], dealBreakersPrivate: ["Smokers"] });
    const patch = quickStartPatch(a, "dental", { mustHaves: [] });
    // as the must-have each counts as; the deal-breakers keep the person's words
    expect(patch.add).toContainEqual({ field: "mustHaves", value: "Able to work Saturdays" });
    expect(patch.add).toContainEqual({ field: "dealBreakers", value: "Cannot work Saturdays" });
    expect(patch.add).not.toContainEqual({ field: "mustHaves", value: "Cannot work Saturdays" });
    expect(patch.add).not.toContainEqual({ field: "mustHaves", value: "Smokers" });
    expect(patch.add).toContainEqual({ field: "dealBreakers", value: "Smokers" });
    const edit = applyFactsPatch(normalizeFacts({}), patch, []);
    expect(edit.facts.mustHaves).toContain("Able to work Saturdays");
    expect(edit.facts.mustHaves).not.toContain("No recent grads");
    expect(edit.facts.mustHaves).not.toContain("Smokers");
  });
});

describe("a deal-breaker counts as the requirement it rules people out on (live test, 12 Nov 2026)", () => {
  const assistant = (over: Partial<QuickAnswers> = {}) => filled({ title: "Dental assistant", mustHaves: ["Four-handed dentistry", "Digital radiography"], dealBreakers: ["No active California RDA license"], ...over });

  it("goes on the draft as the requirement, never in the words that rule someone out, and keeps those words as the deal-breaker", () => {
    const a = assistant();
    expect(allMustHaves(a)).toEqual(["Four-handed dentistry", "Digital radiography", "At least 3 years of relevant experience", "Active California RDA license"]);
    expect(allMustHaves(a).some((m) => /^no\b/i.test(m))).toBe(false);
    const patch = quickStartPatch(a, "dental", { mustHaves: [] });
    expect(patch.add).toContainEqual({ field: "mustHaves", value: "Active California RDA license" });
    expect(patch.add).toContainEqual({ field: "dealBreakers", value: "No active California RDA license" });
    expect(patch.add?.filter((x) => x.field === "mustHaves").map((x) => x.value)).not.toContain("No active California RDA license");
    const rows = reviewRows(a, "dental");
    expect(rows.find((r) => r.label === "Must-have skills")?.value).toBe("Four-handed dentistry; Digital radiography; At least 3 years of relevant experience; Active California RDA license");
    expect(rows.find((r) => r.label === "Deal-breakers")?.value).toBe("No active California RDA license (must-have)");
  });

  it("takes the person's own wording first; an empty wording stops the step, and taking the deal-breaker off forgets it", () => {
    const own = assistant({ dealBreakerMusts: { "no active california rda license": "  Active RDA license   (California) " } });
    expect(dealBreakerMustHave(own, "No active California RDA license")).toBe("Active RDA license (California)");
    expect(allMustHaves(own).at(-1)).toBe("Active RDA license (California)");
    expect(stepProblem("dealbreakers", own, TODAY)).toBeNull();
    const cleared = assistant({ dealBreakerMusts: { "no active california rda license": "  " } });
    expect(stepProblem("dealbreakers", cleared, TODAY)).toBe("Write each ticked deal-breaker as what they need, for example Able to work Saturdays.");
    expect(allMustHaves(cleared)).toEqual(["Four-handed dentistry", "Digital radiography", "At least 3 years of relevant experience"]);
    // unticked, it needs no wording
    expect(stepProblem("dealbreakers", { ...cleared, dealBreakersPrivate: ["No active California RDA license"] }, TODAY)).toBeNull();
    expect(removeDealBreaker({ ...own, dealBreakersPrivate: ["no active california rda license"] }, "No active California RDA license")).toEqual({ dealBreakers: [], dealBreakersPrivate: [], dealBreakerMusts: {} });
    // a wording kept for "constructor" or the like is never read off the object's prototype
    expect(dealBreakerMustHave(emptyQuickAnswers(), "constructor")).toBe("constructor");
  });

  it("is counted once when a skill already is that requirement, and still says it judges (critic, 12 Nov 2026)", () => {
    const a = assistant({ mustHaves: ["Four-handed dentistry", "Active California RDA license"] });
    expect(openDealBreakers(a)).toEqual([]);
    expect(allMustHaves(a)).toEqual(["Four-handed dentistry", "Active California RDA license", "At least 3 years of relevant experience"]);
    expect(reviewRows(a, "dental").find((r) => r.label === "Deal-breakers")?.value).toBe("No active California RDA license (must-have)");
  });

  // review of the live test, 12 Nov 2026: "No RDA" stayed as the must-have, prefilled, and the step let it through
  it("asks for what they need when its words cannot be turned round and still rule someone out, and never takes such words", () => {
    const rda = assistant({ dealBreakers: ["No RDA"] });
    // the field starts empty, so its example shows; the step asks for the requirement, and so does "Write the job post"
    expect(dealBreakerWording(rda, "No RDA")).toBe("");
    expect(dealBreakerMustHave(rda, "No RDA")).toBe("");
    const line = "Write each ticked deal-breaker as what they need, for example Able to work Saturdays.";
    expect(stepProblem("dealbreakers", rda, TODAY)).toBe(line);
    expect(firstUnfinished(rda, TODAY)).toBe(QUICK_STEPS.indexOf("dealbreakers"));
    expect(allMustHaves(rda)).toEqual(["Four-handed dentistry", "Digital radiography", "At least 3 years of relevant experience"]);
    for (const d of ["No x-ray cert", "Cant work weekends", "No experience", "No expired RDH license", "No felonies or license suspensions"]) expect(stepProblem("dealbreakers", assistant({ dealBreakers: [d] }), TODAY), d).toBe(line);
    // the person's own wording as what they need goes on; one that still rules someone out does not
    const own = assistant({ dealBreakers: ["No RDA"], dealBreakerMusts: { "no rda": "Active RDA license" } });
    expect(stepProblem("dealbreakers", own, TODAY)).toBeNull();
    expect(allMustHaves(own).at(-1)).toBe("Active RDA license");
    for (const typed of ["No RDA license", "not certified", "Cant work weekends", "Without an RDA"]) expect(stepProblem("dealbreakers", { ...own, dealBreakerMusts: { "no rda": typed } }, TODAY), typed).toBe(line);
    // unticked, it judges nobody and needs no wording; a shape that is turned round still fills the field
    expect(stepProblem("dealbreakers", { ...rda, dealBreakersPrivate: ["No RDA"] }, TODAY)).toBeNull();
    expect(dealBreakerWording(rda, "No RDA license")).toBe("RDA license");
    expect(stepProblem("dealbreakers", assistant(), TODAY)).toBeNull();
  });

  // review of the live test, 12 Nov 2026: step 7 and the review counted a deal-breaker that added no must-have
  it("counts a ticked deal-breaker as a must-have only when it adds one, on step 7, in the room it leaves and on the review", () => {
    const cleared = assistant({ dealBreakerMusts: { "no active california rda license": "" } });
    const unticked = { ...cleared, dealBreakersPrivate: ["No active California RDA license"] };
    expect(mustHavesFromDealBreakers(cleared)).toEqual([]);
    expect(mustHavesRoom(cleared)).toBe(5);
    expect(mustHavesRoom(cleared)).toBe(mustHavesRoom(unticked));
    const rows = reviewRows(cleared, "dental");
    expect(rows.find((r) => r.label === "Deal-breakers")?.value).toBe("No active California RDA license (not used to judge)");
    expect(rows.find((r) => r.label === "Must-have skills")?.value).toBe("Four-handed dentistry; Digital radiography; At least 3 years of relevant experience");
    expect(reviewRows({ ...cleared, mustHaves: [], below: "consider" }, "dental").find((r) => r.label === "Must-have skills")?.value).toBe("Not answered");
    // two worded as one requirement add it once: six in all is allowed, and both say they judge
    const twins = assistant({ mustHaves: ["a", "b", "c", "d"], dealBreakers: ["No RDA license", "Without an RDA license"] });
    expect(mustHavesFromDealBreakers(twins)).toEqual(["RDA license"]);
    expect(allMustHaves(twins)).toHaveLength(6);
    expect(mustHavesRoom(twins)).toBe(4);
    expect(stepProblem("musts", twins, TODAY)).toBeNull();
    expect(stepProblem("dealbreakers", twins, TODAY)).toBeNull();
    expect(firstUnfinished(twins, TODAY)).toBeNull();
    expect(reviewRows(twins, "dental").find((r) => r.label === "Deal-breakers")?.value).toBe("No RDA license (must-have); Without an RDA license (must-have)");
  });
});

describe("the fairness check covers the must-have a deal-breaker counts as (review of the live test, 12 Nov 2026)", () => {
  it("never stores a refused deal-breaker as the must-have it restates, however it is worded", () => {
    const a = filled({ dealBreakers: ["No felonies or license suspensions"] });
    // its words cannot be turned round, so no must-have goes for it until the person writes one
    expect(quickStartPatch(a, "dental", { mustHaves: [] }).add?.filter((x) => x.field === "mustHaves").map((x) => x.value)).toEqual(["Digital radiography and intraoral scanning", "At least 3 years of relevant experience"]);
    const edit = applyFactsPatch(normalizeFacts({}), quickStartPatch(a, "dental", { mustHaves: [] }), []);
    expect(edit.facts.mustHaves).not.toContain("Felonies or license suspensions");
    expect([...new Set(edit.refused.map((r) => r.text))]).toEqual(["No felonies or license suspensions"]);
    // its opposite typed as the must-have is refused with it, for the same reason
    const typed = applyFactsPatch(normalizeFacts({}), quickStartPatch({ ...a, dealBreakerMusts: { "no felonies or license suspensions": "Felonies or license suspensions" } }, "dental", { mustHaves: [] }), []);
    expect(typed.facts.mustHaves).toEqual(["Digital radiography and intraoral scanning", "At least 3 years of relevant experience"]);
    expect(typed.refused.map((r) => [r.field, r.text])).toEqual([["mustHaves", "Felonies or license suspensions"], ["dealBreakers", "No felonies or license suspensions"]]);
    expect(new Set(typed.refused.map((r) => r.reason)).size).toBe(1);
    // a requirement in the person's own words is theirs, and is checked on its own words
    const fair = applyFactsPatch(normalizeFacts({}), quickStartPatch({ ...a, dealBreakerMusts: { "no felonies or license suspensions": "Active license with no suspensions" } }, "dental", { mustHaves: [] }), []);
    expect(fair.facts.mustHaves).toContain("Active license with no suspensions");
    // a proxy written as the must-have is refused in its own words too
    const grads = applyFactsPatch(normalizeFacts({}), quickStartPatch(filled({ dealBreakers: ["No recent grads"], dealBreakerMusts: { "no recent grads": "Recent grads" } }), "dental", { mustHaves: [] }), []);
    expect(grads.facts.mustHaves).not.toContain("Recent grads");
    expect(grads.refused.map((r) => r.text)).toEqual(["Recent grads", "No recent grads"]);
  });
});

describe("a question that is the owner's call (live test, 12 Nov 2026)", () => {
  const RDA = "Do you hold an active Registered Dental Assistant (RDA) license in the state where this office is located?";
  const assistant = (over: Partial<QuickAnswers> = {}) => filled({ title: "Dental assistant", mustHaves: ["Four-handed dentistry"], dealBreakers: [], noDealBreakers: true, ...over });

  it("is offered unticked, so an applicant without the licence is never held for it unless the owner wants it", () => {
    const a = assistant();
    expect(offeredQuestions(a, "dental")[0]).toBe(RDA);
    expect(questionOn(a, RDA, "dental")).toBe(false);
    expect(chosenQuestions(a, "dental")).toEqual(offeredQuestions(a, "dental").slice(1));
    // the others start ticked, as before
    for (const q of offeredQuestions(a, "dental").slice(1)) expect(questionOn(a, q, "dental"), q).toBe(true);
    // it goes to the draft as a question left unticked, which the server keeps as one never to use
    const patch = quickStartPatch(a, "dental", { mustHaves: [] });
    expect(patch.unticked).toEqual([{ field: "eligibility", value: RDA, origin: "playbook" }]);
    expect(IntakeFactsPatch.parse(patch)).toEqual(patch);
    const edit = applyFactsPatch(normalizeFacts({}), patch, []);
    expect(edit.facts.eligibilityNotes).not.toContain(RDA);
    expect(edit.facts.suggestions).toEqual([{ field: "eligibility", text: RDA, origin: "playbook" }]);
  });

  it("ticks itself once a must-have names the licence, a deal-breaker counted openly too, never one that judges nobody", () => {
    expect(questionOn(assistant({ mustHaves: ["Four-handed dentistry", "RDA license"] }), RDA, "dental")).toBe(true);
    expect(questionOn(assistant({ mustHaves: ["Registered dental assistant license"] }), RDA, "dental")).toBe(true);
    const open = assistant({ dealBreakers: ["No active California RDA license"], noDealBreakers: false });
    expect(questionOn(open, RDA, "dental")).toBe(true);
    expect(chosenQuestions(open, "dental")).toContain(RDA);
    expect(quickStartPatch(open, "dental", null).unticked).toBeUndefined();
    expect(questionOn({ ...open, dealBreakersPrivate: ["No active California RDA license"] }, RDA, "dental")).toBe(false);
    // a word that only contains the letters is not the licence
    expect(questionOn(assistant({ mustHaves: ["Ardashir charting"] }), RDA, "dental")).toBe(false);
  });

  // review of the live-test fixes, 12 Nov 2026: a job titled "Registered Dental Assistant" started with its own licence
  // question unticked, so the draft left it off the form
  it("ticks itself when the job title names the licence, and the person's own untick still stands", () => {
    for (const title of ["Registered Dental Assistant", "Registered Dental Assistant (RDA)", "RDA", "Lead dental assistant (RDA)"]) {
      const a = assistant({ title });
      expect(questionOn(a, RDA, "dental"), title).toBe(true);
      expect(chosenQuestions(a, "dental"), title).toContain(RDA);
      expect(quickStartPatch(a, "dental", null).unticked, title).toBeUndefined();
      expect(questionOn({ ...a, ...toggleQuestion(a, RDA, "dental") }, RDA, "dental"), title).toBe(false);
    }
    expect(questionOn(assistant({ title: "Dental assistant" }), RDA, "dental")).toBe(false);
  });

  it("stays as the person ticks it: on when ticked, off when unticked even once a must-have names it, and kept in this browser", () => {
    const a = assistant();
    const ticked = { ...a, ...toggleQuestion(a, RDA, "dental") };
    expect(questionOn(ticked, RDA, "dental")).toBe(true);
    expect(chosenQuestions(ticked, "dental")[0]).toBe(RDA);
    const named = assistant({ mustHaves: ["RDA license"] });
    const unticked = { ...named, ...toggleQuestion(named, RDA, "dental") };
    expect(questionOn(unticked, RDA, "dental")).toBe(false);
    expect({ ...unticked, ...toggleQuestion(unticked, RDA, "dental") }.questionsOff).toEqual([]);
    // another question unticks and ticks as before
    const xray = offeredQuestions(a, "dental")[1];
    const off = { ...a, ...toggleQuestion(a, xray, "dental") };
    expect(questionOn(off, xray, "dental")).toBe(false);
    expect(questionOn({ ...off, ...toggleQuestion(off, xray, "dental") }, xray, "dental")).toBe(true);
    const s = memoryStorage();
    const state = { ...emptyQuickState(), step: 8, answers: { ...ticked, dealBreakerMusts: { "no rda license": "RDA license" } } };
    writeQuickStart(s, state);
    expect(readQuickStart(s)).toEqual(state);
  });
});

describe("handing over to the job builder", () => {
  it("starts the draft with the plain facts as the person's first message, and the pasted ad after them", () => {
    const m = firstMessage(filled());
    expect(m).toBe([
      "Quick start for a new job.",
      "Job title: Dental Hygienist",
      "Employment type: Full time",
      "Where: On site, Irvine, CA",
      "Minimum experience: 3+ years, required",
      "Pay: $45–$55 an hour",
      "Closing date: November 30, 2026",
    ].join("\n"));
    // lists go in the edit that follows, item by item, never in this message
    expect(m).not.toContain("Digital radiography");
    expect(m).not.toMatch(/must[\s-]?have/i);
    const withAd = firstMessage(filled({ ad: "We are a friendly practice.", noClosingDate: true }));
    expect(withAd).toContain("Closing date: None");
    expect(withAd).toMatch(/The job ad we already have:\nWe are a friendly practice\.$/);
    expect(firstMessage(filled({ ad: "x".repeat(30_000) })).length).toBe(INTAKE_FIRST_MESSAGE_MAX);
  });

  it("puts every answer on the draft in one edit the API accepts, through the server's own fairness check", () => {
    const a = filled({ dealBreakers: ["Cannot work Saturdays", "No recent grads"], ownQuestions: ["Which software do you use?"] });
    const patch = quickStartPatch(a, "dental", { mustHaves: [] });
    expect(IntakeFactsPatch.parse(patch)).toEqual(patch);
    expect(patch.set).toEqual({ title: "Dental Hygienist", employmentType: "full_time", remotePolicy: "onsite", locationText: "Irvine, CA", pay: { basis: "hourly", min: 45, max: 55 } });
    expect(patch.add).toContainEqual({ field: "mustHaves", value: "At least 3 years of relevant experience" });
    expect(patch.add).toContainEqual({ field: "screeningQuestions", value: "Which software do you use?" });
    expect(patch.add?.filter((x) => x.field === "eligibilityNotes").map((x) => x.value)).toEqual([...suggestedQuestions("dental", "Dental Hygienist")]);
    const edit = applyFactsPatch(normalizeFacts({}), patch, []);
    expect(edit.facts.title).toBe("Dental Hygienist");
    expect(edit.facts.employmentType).toBe("full_time");
    expect(edit.facts.remotePolicy).toBe("onsite");
    expect(edit.facts.compensationMin).toBe(45);
    expect(edit.pay?.via).toBe("edited");
    // the deal-breaker left ticked counts openly as a must-have (Q19), as the requirement it rules people out on
    expect(edit.facts.mustHaves).toEqual(["Digital radiography and intraoral scanning", "At least 3 years of relevant experience", "Able to work Saturdays"]);
    expect(edit.facts.dealBreakers).toEqual(["Cannot work Saturdays"]);
    // the fairness check refuses a proxy for age, with the reason, as a deal-breaker; it goes as no must-have, since its
    // words still rule someone out (the person writes what they need, and that is checked too: see the fairness describe)
    expect(patch.add?.filter((x) => x.field === "mustHaves").map((x) => x.value)).not.toContain("No recent grads");
    expect([...new Set(edit.refused.map((r) => r.text))]).toEqual(["No recent grads"]);
    // and the draft may be written straight away: the title is in, and "draft it" is asked with the edit
    const state: IntakeServerState = { openQuestions: [], answeredRounds: 0, removed: [], dealBreakersOffered: [], draftRequestedAt: "2026-10-14T09:00:00Z" };
    const owner = (content: string) => ({ role: "owner" as const, content, at: "2026-10-14T09:00:00Z" });
    expect(intakeReadiness({ facts: edit.facts, state, messages: [owner(firstMessage(a)), owner("Job title: Dental Hygienist")], draft: null }).mayDraft).toBe(true);
  });

  it("keeps the experience as a nice-to-have when people with less are still considered, and adds nothing for None", () => {
    const patch = quickStartPatch(filled({ below: "consider", noDealBreakers: true, dealBreakers: [] }), "dental", null);
    expect(patch.add).toContainEqual({ field: "niceToHaves", value: "3+ years of relevant experience" });
    expect(patch.add?.some((x) => x.field === "dealBreakers")).toBe(false);
    expect(patch.add?.some((x) => x.value.startsWith("At least"))).toBe(false);
    expect(quickStartPatch(filled({ experience: "none", below: "" }), "dental", null).add?.some((x) => /experience/.test(x.value))).toBe(false);
  });

  it("makes the must-haves the person's own choice, always: anything else the assistant read is taken out", () => {
    const a = filled({ mustHaves: ["a", "b", "c", "d"], dealBreakers: [], noDealBreakers: true });
    const patch = quickStartPatch(a, "dental", { mustHaves: ["read 1", "A"] });
    expect(patch.remove).toEqual([{ field: "mustHaves", value: "read 1" }]);
    const edit = applyFactsPatch(normalizeFacts({ mustHaves: ["read 1", "A"] }), patch, []);
    expect(edit.facts.mustHaves).toHaveLength(5);
    expect(edit.facts.mustHaves).not.toContain("read 1");
    // with room to spare too: a degree the ad mentioned, or the experience read as a must-have when less is still considered
    const consider = quickStartPatch(filled({ below: "consider" }), "dental", { mustHaves: ["Bachelor's degree", "3+ years of experience"], niceToHaves: ["3+ years of experience", "Spanish"] });
    expect(consider.remove).toEqual([
      { field: "mustHaves", value: "Bachelor's degree" },
      { field: "mustHaves", value: "3+ years of experience" },
      { field: "niceToHaves", value: "3+ years of experience" },
    ]);
    const after = applyFactsPatch(normalizeFacts({ mustHaves: ["Bachelor's degree", "3+ years of experience"], niceToHaves: ["3+ years of experience", "Spanish"] }), consider, []);
    expect(after.facts.mustHaves).toEqual(["Digital radiography and intraoral scanning", "Able to work Saturdays"]);
    expect(after.facts.niceToHaves).toEqual(["Spanish", "3+ years of relevant experience"]);
    // nothing to take out when the assistant read only what the person chose
    expect(quickStartPatch(filled(), "dental", { mustHaves: ["Digital radiography and intraoral scanning"] }).remove).toBeUndefined();
  });

  // review of the live-test fixes, 12 Nov 2026: a note the assistant read from a sentence or an ad was taken for the
  // owner's choice, and made the form "exactly" that question
  it("says the person went through the questions for the form, with every one ticked or every one unticked, and only the edit sets it", () => {
    const all = filled({ dealBreakers: [], noDealBreakers: true });
    const ticked = quickStartPatch(all, "dental", null);
    expect(ticked.formQuestionsChosen).toBe(true);
    expect(ticked.unticked).toBeUndefined();
    expect(IntakeFactsPatch.parse(ticked)).toEqual(ticked);
    expect(applyFactsPatch(normalizeFacts({}), ticked, []).facts.formQuestionsChosen).toBe(true);
    const none = { ...all, questionsOff: [...suggestedQuestions("dental", "Dental Hygienist")] };
    const unticked = quickStartPatch(none, "dental", null);
    expect(unticked.add?.some((x) => x.field === "eligibilityNotes")).toBe(false);
    expect(unticked.unticked).toHaveLength(3);
    const edit = applyFactsPatch(normalizeFacts({}), unticked, []);
    expect(edit.facts).toMatchObject({ formQuestionsChosen: true, eligibilityNotes: [] });
    // a panel edit without step 9 never sets it
    expect(applyFactsPatch(normalizeFacts({}), { add: [{ field: "eligibilityNotes", value: "Are you available on Saturdays?" }] }, []).facts.formQuestionsChosen).toBeUndefined();
  });

  it("takes out an eligibility note the assistant read that the person did not choose, as it does a must-have", () => {
    const a = filled({ title: "Dental assistant", mustHaves: ["Four-handed dentistry"], dealBreakers: [], noDealBreakers: true });
    const chosen = chosenQuestions(a, "dental");
    const read = { mustHaves: [], eligibilityNotes: ["Current RDA license required", chosen[0]] };
    const patch = quickStartPatch(a, "dental", read);
    expect(patch.remove).toEqual([{ field: "eligibilityNotes", value: "Current RDA license required" }]);
    // the licence question the ad named stays unticked: nobody chose it
    expect(patch.add?.filter((x) => x.field === "eligibilityNotes").map((x) => x.value)).toEqual(chosen);
    expect(chosen.some((q) => /\bRDA\b/.test(q))).toBe(false);
    const edit = applyFactsPatch(normalizeFacts(read), patch, []);
    expect(edit.facts.eligibilityNotes).toEqual(chosen);
    expect(edit.facts.formQuestionsChosen).toBe(true);
    // the assistant may not put it back
    expect(edit.removed).toContainEqual({ field: "eligibilityNotes", value: "Current RDA license required" });
  });

  it("skips only the open cards the quick start already answered, at most three, never the deal-breaker card", () => {
    const q = (id: string, field: IntakeQuestion["field"], prompt = "") => ({ id, field, prompt });
    const out = skippedAnswers([q("a", "compensation"), q("b", "reason_for_hire"), q("c", "must_haves"), q("d", "interviewers"), q("e", "screening_questions"), q("f", "deal_breakers")]);
    expect(out.map((x) => x.questionId)).toEqual(["a", "c", "e"]);
    for (const x of out) expect(IntakeAnswer.parse(x)).toEqual({ questionId: x.questionId, selected: [], own: [], skipped: true });
    // the server's card offering deal-breakers (from a pasted ad) back as must-haves stays open in the builder, in its
    // words since 12 Nov 2026 and in those before (a card stored then)
    const deal = q("q1_2", "must_haves", "From your deal-breakers: which should count openly as must-haves?");
    expect(isDealBreakerCard(deal)).toBe(true);
    expect(isDealBreakerCard(q("q1_3", "must_haves", "You named these as deal-breakers. Which should count openly as must-haves?"))).toBe(true);
    expect(skippedAnswers([q("q1_1", "compensation"), deal]).map((x) => x.questionId)).toEqual(["q1_1"]);
  });

  it("marks the new draft for the builder in the page only, never in the address", () => {
    expect(quickStartDraftKey("s1")).toEqual(["intake", "quick-start", "s1"]);
  });
});

describe("a pasted job ad", () => {
  const ad = [
    "Now hiring: Registered Dental Hygienist",
    "Bright Dental is growing! Join our team in Irvine, CA.",
    "Full-time, on-site, Monday to Thursday.",
    "Pay: $48 - $56 per hour",
    "You have 4+ years of clinical experience.",
  ].join("\n");

  it("fills in what it states plainly, nothing more", () => {
    expect(readAd(ad)).toEqual({ title: "Registered Dental Hygienist", employmentType: "full_time", remotePolicy: "onsite", place: "Irvine, CA", pay: { basis: "hourly", min: "48", max: "56", ceiling: "" }, experience: "3" });
    expect(readAd("Job title: Bookkeeper\nLocation: Austin, TX\nHybrid. $60k to $70k a year.")).toMatchObject({ title: "Bookkeeper", remotePolicy: "hybrid", place: "Austin, TX", pay: { basis: "salary", min: "60000", max: "70000" } });
    expect(readAd("We are a friendly team. Come work with us.")).toEqual({});
  });

  it("fills only the steps still empty, says which, and keeps the ad for the first message", () => {
    const r = fillFromAd({ ...emptyQuickAnswers(), title: "Hygienist" }, ad);
    expect(r.answers.title).toBe("Hygienist");
    expect(r.answers.employmentType).toBe("full_time");
    expect(r.answers.ad).toBe(ad);
    expect(r.filled).toEqual(["Employment type", "Where", "Minimum experience", "Pay"]);
  });

  it("offers the ad's requirements on the must-haves step to tick, never ticked for the person", () => {
    const withList = `${ad}\n\nRequirements:\n- California RDH license\n- Bachelor's degree\n\nBenefits\n- Dental plan`;
    expect(readAd(withList).mustHaves).toEqual(["California RDH license", "Bachelor's degree"]);
    const r = fillFromAd(emptyQuickAnswers(), withList);
    expect(r.answers.adMustHaves).toEqual(["California RDH license", "Bachelor's degree"]);
    expect(r.answers.mustHaves).toEqual([]);
    expect(r.filled).toContain("Must-have skills (to tick)");
  });
});

describe("kept in this browser", () => {
  it("comes back after a reload, and Start over clears it", () => {
    const s = memoryStorage();
    expect(readQuickStart(s)).toBeNull();
    const state = { ...emptyQuickState(), step: 4, answers: filled(), sessionId: "abc-123" };
    writeQuickStart(s, state);
    expect(readQuickStart(s)).toEqual(state);
    clearQuickStart(s);
    expect(s.m.has(QUICK_START_STORAGE_KEY)).toBe(false);
  });

  it("reads nothing strange, and storage that fails never breaks the page", () => {
    const s = memoryStorage();
    s.setItem(QUICK_START_STORAGE_KEY, "not json");
    expect(readQuickStart(s)).toBeNull();
    s.setItem(QUICK_START_STORAGE_KEY, JSON.stringify({ step: 99, answers: { title: 5, employmentType: "forever", remotePolicy: "remote", mustHaves: ["ok", 3, ""] }, sessionId: "../x" }));
    const back = readQuickStart(s)!;
    expect(back.step).toBe(9);
    expect(back.answers.title).toBe("");
    expect(back.answers.employmentType).toBe("");
    expect(back.answers.remotePolicy).toBe("remote");
    expect(back.answers.mustHaves).toEqual(["ok"]);
    expect(back.sessionId).toBeNull();
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(readQuickStart(broken)).toBeNull();
    expect(() => writeQuickStart(broken, emptyQuickState())).not.toThrow();
    expect(() => clearQuickStart(broken)).not.toThrow();
    expect(readQuickStart(null)).toBeNull();
  });

  it("keeps one copy per company and person, never showing one company's answers in another, and forgets them all at sign-out", () => {
    const s = memoryStorage();
    const a = { companyId: "co-a", userId: "u1" };
    const b = { companyId: "co-b", userId: "u1" };
    const state = { ...emptyQuickState(), step: 3, answers: filled({ pay: { basis: "hourly", min: "45", max: "55", ceiling: "60" } }) };
    writeQuickStart(s, state, a);
    expect(quickStartStorageKey(a)).toBe(`${QUICK_START_STORAGE_KEY}:co-a:u1`);
    expect(readQuickStart(s, a)).toEqual({ ...state, companyId: "co-a" });
    expect(readQuickStart(s, b)).toBeNull();
    expect(readQuickStart(s, { companyId: "co-a", userId: "u2" })).toBeNull();
    // a copy that says it was for another company is ignored even under this key
    s.setItem(quickStartStorageKey(b), JSON.stringify({ ...state, companyId: "co-a" }));
    expect(readQuickStart(s, b)).toBeNull();
    s.setItem("ros:other", "keep");
    const all = { removeItem: s.removeItem, get length() { return s.m.size; }, key: (i: number) => [...s.m.keys()][i] ?? null };
    clearAllQuickStarts(all);
    expect([...s.m.keys()]).toEqual(["ros:other"]);
  });

  // review of the live-test fixes, 12 Nov 2026: a copy kept before the release reopened on the review with the RDA
  // question, ticked then, silently unticked now
  it("opens a copy kept before 12 Nov 2026 on the questions step when its job has a question that is the owner's call, never keeping the old tick", () => {
    const s = memoryStorage();
    const RDA = "Do you hold an active Registered Dental Assistant (RDA) license in the state where this office is located?";
    const { questionsOn: _new, ...before } = filled({ title: "Dental assistant", mustHaves: ["Four-handed dentistry"], dealBreakers: [], noDealBreakers: true });
    s.setItem(QUICK_START_STORAGE_KEY, JSON.stringify({ step: 9, answers: before, fromReview: false, sessionId: null }));
    const back = readQuickStart(s)!;
    expect(back.step).toBe(QUICK_STEPS.indexOf("questions"));
    expect(back.fromReview).toBe(true);
    expect(questionOn(back.answers, RDA, "dental")).toBe(false);
    // written back by this release (with questionsOn), it opens where it was left
    const now = { ...emptyQuickState(), step: 9, answers: filled({ title: "Dental assistant", mustHaves: ["Four-handed dentistry"], dealBreakers: [], noDealBreakers: true }) };
    writeQuickStart(s, now);
    expect(readQuickStart(s)).toEqual(now);
    // a job with no such question, or a copy not past the questions step, opens where it was left
    const { questionsOn: _rdh, ...hygienist } = filled();
    s.setItem(QUICK_START_STORAGE_KEY, JSON.stringify({ step: 9, answers: hygienist, fromReview: false, sessionId: null }));
    expect(readQuickStart(s)).toMatchObject({ step: 9, fromReview: false });
    s.setItem(QUICK_START_STORAGE_KEY, JSON.stringify({ step: 6, answers: before, fromReview: false, sessionId: null }));
    expect(readQuickStart(s)).toMatchObject({ step: 6, fromReview: false });
    // review of the form-questions fix, 12 Nov 2026: one sent back from the review to an earlier step (Edit on the pay,
    // or a step left unfinished) opens on the questions step too, since Next and Back go straight to the review from there
    s.setItem(QUICK_START_STORAGE_KEY, JSON.stringify({ step: 4, answers: before, fromReview: true, sessionId: null }));
    const edited = readQuickStart(s)!;
    expect(edited).toMatchObject({ step: QUICK_STEPS.indexOf("questions"), fromReview: true });
    expect(questionOn(edited.answers, RDA, "dental")).toBe(false);
    // a job with no such question opens on the step it was sent back to
    s.setItem(QUICK_START_STORAGE_KEY, JSON.stringify({ step: 4, answers: hygienist, fromReview: true, sessionId: null }));
    expect(readQuickStart(s)).toMatchObject({ step: 4, fromReview: true });
  });

  it("knows a fresh page from work in progress", () => {
    expect(hasAnswers(emptyQuickAnswers())).toBe(false);
    expect(hasAnswers({ ...emptyQuickAnswers(), noDealBreakers: true })).toBe(true);
    expect(hasAnswers(filled())).toBe(true);
  });
});
