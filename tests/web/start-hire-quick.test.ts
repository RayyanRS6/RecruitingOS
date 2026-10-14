import { describe, expect, it } from "vitest";
import { INTAKE_FIRST_MESSAGE_MAX, IntakeAnswer, IntakeFactsPatch, type IntakeQuestion, type IntakeServerState } from "../../packages/contracts/src/index";
import { applyFactsPatch, intakeReadiness, normalizeFacts } from "../../packages/core/src/intake-builder";
import { findPlaybook, matchPlaybookRole } from "../../packages/playbooks/src/index";
import { NEW_ROLE_FRESH_HREF } from "../../apps/web/src/pages/new-role/rules";
import { GENERAL_QUESTIONS, GUIDE_ROLES, guideRoleFor } from "../../apps/web/src/pages/new-role/quick-starts";
import {
  QUICK_STEPS, QUICK_START_STORAGE_KEY, STEP_QUESTION, addItem, allMustHaves, chosenQuestions, clearAllQuickStarts, clearQuickStart, emptyQuickAnswers, emptyQuickState, enterMovesOn, experienceMustHave,
  experienceNiceToHave, fillFromAd, firstMessage, firstUnfinished, hasAnswers, isDealBreakerCard, mustHavesRoom, openDealBreakers, quickStartDraftKey, quickStartPatch, quickStartStorageKey, readAd, readQuickStart, reviewRows,
  skippedAnswers, stepProblem, suggestedMustHaves, suggestedQuestions, toggleItem, writeQuickStart, type QuickAnswers,
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
      }
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
    // where each question is asked: the suggested ones on the form, the person's own in the screening chat
    expect(rows.find((r) => r.label === "Screening questions")?.value).toBe(`${suggestedQuestions("dental", "Dental Hygienist").length} on the form · 1 in the screening chat`);
    expect(reviewRows(filled({ noClosingDate: true, noDealBreakers: true, dealBreakers: [] }), "dental").find((r) => r.label === "Deal-breakers")?.value).toBe("None");
    // a deal-breaker left ticked shows among the must-haves, and says which way it counts
    expect(rows.find((r) => r.label === "Must-have skills")?.value).toBe("Digital radiography and intraoral scanning; At least 3 years of relevant experience; Cannot work Saturdays");
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
    expect(allMustHaves(filled())).toEqual(["Digital radiography and intraoral scanning", "At least 3 years of relevant experience", "Cannot work Saturdays"]);
    // too many in all: the deal-breakers step says so, and so does the must-haves step
    const full = filled({ mustHaves: ["a", "b", "c", "d", "e"] });
    expect(stepProblem("dealbreakers", full, TODAY)).toMatch(/Six must-haves at most/);
    expect(stepProblem("musts", full, TODAY)).toMatch(/Keep it to 4, with your deal-breakers counted/);
    expect(stepProblem("dealbreakers", { ...full, dealBreakersPrivate: ["Cannot work Saturdays"] }, TODAY)).toBeNull();
  });

  it("puts the ticked ones on the draft as must-haves, through the fairness check, and leaves the unticked ones out", () => {
    const a = filled({ dealBreakers: ["Cannot work Saturdays", "No recent grads", "Smokers"], dealBreakersPrivate: ["Smokers"] });
    const patch = quickStartPatch(a, "dental", { mustHaves: [] });
    expect(patch.add).toContainEqual({ field: "mustHaves", value: "Cannot work Saturdays" });
    expect(patch.add).not.toContainEqual({ field: "mustHaves", value: "Smokers" });
    expect(patch.add).toContainEqual({ field: "dealBreakers", value: "Smokers" });
    const edit = applyFactsPatch(normalizeFacts({}), patch, []);
    expect(edit.facts.mustHaves).toContain("Cannot work Saturdays");
    expect(edit.facts.mustHaves).not.toContain("No recent grads");
    expect(edit.facts.mustHaves).not.toContain("Smokers");
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
    // the deal-breaker left ticked counts openly as a must-have (Q19)
    expect(edit.facts.mustHaves).toEqual(["Digital radiography and intraoral scanning", "At least 3 years of relevant experience", "Cannot work Saturdays"]);
    expect(edit.facts.dealBreakers).toEqual(["Cannot work Saturdays"]);
    // the fairness check refuses a proxy for age, with the reason, both as a must-have and as a deal-breaker
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
    expect(after.facts.mustHaves).toEqual(["Digital radiography and intraoral scanning", "Cannot work Saturdays"]);
    expect(after.facts.niceToHaves).toEqual(["Spanish", "3+ years of relevant experience"]);
    // nothing to take out when the assistant read only what the person chose
    expect(quickStartPatch(filled(), "dental", { mustHaves: ["Digital radiography and intraoral scanning"] }).remove).toBeUndefined();
  });

  it("skips only the open cards the quick start already answered, at most three, never the deal-breaker card", () => {
    const q = (id: string, field: IntakeQuestion["field"], prompt = "") => ({ id, field, prompt });
    const out = skippedAnswers([q("a", "compensation"), q("b", "reason_for_hire"), q("c", "must_haves"), q("d", "interviewers"), q("e", "screening_questions"), q("f", "deal_breakers")]);
    expect(out.map((x) => x.questionId)).toEqual(["a", "c", "e"]);
    for (const x of out) expect(IntakeAnswer.parse(x)).toEqual({ questionId: x.questionId, selected: [], own: [], skipped: true });
    // the server's card offering deal-breakers (from a pasted ad) back as must-haves stays open in the builder
    const deal = q("q1_2", "must_haves", "You named these as deal-breakers. Which should count openly as must-haves?");
    expect(isDealBreakerCard(deal)).toBe(true);
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

  it("knows a fresh page from work in progress", () => {
    expect(hasAnswers(emptyQuickAnswers())).toBe(false);
    expect(hasAnswers({ ...emptyQuickAnswers(), noDealBreakers: true })).toBe(true);
    expect(hasAnswers(filled())).toBe(true);
  });
});
