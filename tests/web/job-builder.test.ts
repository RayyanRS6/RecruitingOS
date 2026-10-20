import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { presetOf } from "../../apps/web/src/recruiter-access";
import { INTAKE_FIRST_MESSAGE_MAX, INTAKE_MESSAGE_MAX, IntakeAnswer, IntakeFactsPatch, RolePacket as RolePacketSchema, packetVisibility, type IntakeFacts, type IntakeQuestion, type IntakeServerState, type IntakeSessionView } from "../../packages/contracts/src/index";
import { SOMEONE_NEW as CORE_SOMEONE_NEW, applyAnswers, applyFactsPatch, draftFactsKey, intakeReadiness, normalizeFacts } from "../../packages/core/src/intake-builder";
import { VERTICAL_TO_PLAYBOOK, findPlaybook, matchPlaybookRole } from "../../packages/playbooks/src/index";
import { samplePacket } from "../../packages/agents/src/fixtures/sample-packet";
import {
  NEW_ROLE_FRESH_HREF, SOMEONE_NEW, addOwn, answerOf, answerPayload, answersPayload, approvalHelp, askFromDetails, basicsChips, cardsKey, cardsToShow, changedSections,
  composerPlaceholder, deckFor, draftOutOfDate, draftRecruiterAsk, draftSections, draftSteps, draftTitle, draftingNow, echoText, enterSends, errorWords, goTo, initialCards, isDiscardDraft,
  marketRange, marketSource, mayHireAgain, mayTakeOverDrafts, messageLimit, messageProblem, nextLabel, parseAmount, payFormFrom, payPayload, payProblem, pickHint, readinessList,
  redraftWarning, removeOwn, sectionOfPath, setDraft, setPayForm, startHireHref, togglePick, turnProblem, DRAFT_SEEN_BY, TAKEN_OVER_TOAST, type CardState,
} from "../../apps/web/src/pages/new-role/rules";
import { factsFormFrom, factsPatch } from "../../apps/web/src/pages/new-role/facts-form";
import { GUIDE_OF_VERTICAL, QUICK_STARTS, quickStartsFor } from "../../apps/web/src/pages/new-role/quick-starts";
import { CHANGE_REQUEST_MAX, asksBack, changeLine, checkSignature, openFlags, proposalSections, refinePaths, rewordInstruction, suggestionsBySection, takesEffectWords } from "../../apps/web/src/pages/new-role/refine-api";
import { partsLine } from "../../apps/web/src/pages/new-role/ProposalCard";
import { applyPacketForm, moveRow, packetFormFrom, packetFormProblem } from "../../apps/web/src/pages/new-role/packet-form";
import type { RolePacket as WebRolePacket } from "../../apps/web/src/api/client";

/**
 * The job builder's pure pieces (plan Wave C: C4 to C15): the question cards' state and what they send, the summary
 * line the picks are echoed as (checked against the server's own), the "what we know / still missing" list, the draft
 * panel's sections and who sees each, the drafting steps, when Enter sends, the hand-off addresses, the quick starts,
 * the panel's edits, "change it by asking" and the role editor's plain fields.
 */

const team = [
  { userId: "u-dana", name: "Dana Owner", role: "owner" },
  { userId: "u-sam", name: "Sam Lee", role: "interviewer" },
];
const teamOptions = (deciders: boolean) => [...team.filter((m) => !deciders || m.role === "owner").map((m) => ({ label: m.name, value: m.userId, origin: "team" as const })), { label: "Someone not on the team yet", value: SOMEONE_NEW, origin: "team" as const }];

const q = (over: Partial<IntakeQuestion> & Pick<IntakeQuestion, "id" | "field" | "mode">): IntakeQuestion => ({ prompt: "A question?", options: [], allowOwn: true, why: "Because.", ...over });
const reason = q({ id: "q1_1", field: "reason_for_hire", mode: "single", options: [{ label: "A new position", value: "new_position", origin: "assistant" }, { label: "Replacing someone who left", value: "replacement", origin: "assistant" }] });
const must = q({ id: "q1_2", field: "must_haves", mode: "multi", options: [{ label: "Active RDH license", value: "Active RDH license", origin: "playbook" }, { label: "Perio experience", value: "Periodontal therapy experience", origin: "playbook" }, { label: "Dentrix", value: "Dentrix experience", origin: "playbook" }] });
const interviewers = q({ id: "q1_3", field: "interviewers", mode: "team", options: teamOptions(false) });
const decider = q({ id: "q2_1", field: "decision_maker", mode: "team", options: teamOptions(true) });
const pay = q({ id: "q2_2", field: "compensation", mode: "pay" });
const start = q({ id: "q2_3", field: "timeline", mode: "single", allowOwn: false, options: [{ label: "As soon as possible", value: "asap", origin: "assistant" }, { label: "Within a month", value: "within_30_days", origin: "assistant" }] });
const facts = (over: Partial<IntakeFacts> = {}): IntakeFacts => normalizeFacts({ title: "Dental Hygienist", locationText: "Irvine, CA", ...over });
const state = (over: Partial<IntakeServerState> = {}): IntakeServerState => ({ openQuestions: [], answeredRounds: 0, removed: [], dealBreakersOffered: [], ...over });

describe("question cards", () => {
  it("say what kind of answer each takes", () => {
    expect(pickHint(reason)).toBe("Pick one");
    expect(pickHint(must)).toBe("Pick any that apply");
    expect(pickHint(decider)).toBe("Pick one");
    expect(pickHint(interviewers)).toBe("Pick any that apply");
    expect(pickHint(pay)).toBe("Set the pay");
    expect(pickHint(q({ id: "f", field: "what_failure_looks_like", mode: "free" }))).toBe("Type your answer");
  });

  it("a pick-one card keeps one answer: a new pick replaces it, the same pick clears it, typed words replace the pick", () => {
    let s: CardState = initialCards();
    s = togglePick(s, reason, "new_position");
    s = togglePick(s, reason, "replacement");
    expect(answerOf(s, reason).selected).toEqual(["replacement"]);
    expect(answerPayload(reason, answerOf(s, reason))).toEqual({ questionId: "q1_1", selected: ["replacement"], own: [], skipped: false });
    s = setDraft(s, reason, "We are opening a second office");
    expect(answerOf(s, reason).selected).toEqual([]);
    expect(answerPayload(reason, answerOf(s, reason))).toMatchObject({ selected: [], own: ["We are opening a second office"], skipped: false });
    s = togglePick(s, reason, "new_position");
    expect(answerOf(s, reason).draft).toBe("");
    s = togglePick(s, reason, "new_position");
    expect(answerPayload(reason, answerOf(s, reason)).skipped).toBe(true);
  });

  it("a pick-any card ticks several and adds the person's own, once each; words still in the box count too", () => {
    let s = togglePick(initialCards(), must, "Active RDH license");
    s = togglePick(s, must, "Dentrix experience");
    s = togglePick(s, must, "Dentrix experience");
    s = addOwn(setDraft(s, must, "Local anesthesia permit"), must);
    s = addOwn(setDraft(s, must, "local anesthesia permit "), must);
    expect(answerOf(s, must).own).toEqual(["Local anesthesia permit"]);
    s = setDraft(s, must, "CPR certification");
    expect(answerPayload(must, answerOf(s, must))).toEqual({ questionId: "q1_2", selected: ["Active RDH license"], own: ["Local anesthesia permit", "CPR certification"], skipped: false });
    s = removeOwn(s, must, "Local anesthesia permit");
    expect(answerPayload(must, answerOf(s, must)).own).toEqual(["CPR certification"]);
  });

  it("team cards send team members by id, and someone not on the team only with their name", () => {
    let s = togglePick(initialCards(), decider, SOMEONE_NEW);
    expect(answerPayload(decider, answerOf(s, decider)).skipped).toBe(true);
    s = setDraft(s, decider, "Dr Chen");
    expect(answerPayload(decider, answerOf(s, decider))).toEqual({ questionId: "q2_1", selected: [], own: ["Dr Chen"], skipped: false });
    s = togglePick(s, decider, "u-dana");
    expect(answerPayload(decider, answerOf(s, decider))).toEqual({ questionId: "q2_1", selected: ["u-dana"], own: [], skipped: false });
    let t = togglePick(togglePick(initialCards(), interviewers, "u-sam"), interviewers, SOMEONE_NEW);
    t = addOwn(setDraft(t, interviewers, "Pat Rivera"), interviewers);
    expect(answerPayload(interviewers, answerOf(t, interviewers))).toEqual({ questionId: "q1_3", selected: ["u-sam"], own: ["Pat Rivera"], skipped: false });
    // unticking "someone new" drops the names typed for them
    t = togglePick(t, interviewers, SOMEONE_NEW);
    expect(answerPayload(interviewers, answerOf(t, interviewers))).toMatchObject({ selected: ["u-sam"], own: [] });
  });

  it("the pay card sends the pay only once it can be set; a card left alone, or one that takes no own words, sends nothing it should not", () => {
    let s = setPayForm(initialCards(), pay, { basis: "hourly", min: "45", max: "", ceiling: "" });
    expect(answerPayload(pay, answerOf(s, pay)).skipped).toBe(true);
    s = setPayForm(s, pay, { basis: "hourly", min: "$45", max: "55", ceiling: "58" });
    expect(answerPayload(pay, answerOf(s, pay))).toEqual({ questionId: "q2_2", selected: [], own: [], skipped: false, pay: { basis: "hourly", min: 45, max: 55, ceiling: 58 } });
    expect(answerPayload(start, answerOf(setDraft(initialCards(), start, "next spring"), start)).skipped).toBe(true);
    expect(answersPayload([reason, must], initialCards())).toEqual([{ questionId: "q1_1", selected: [], own: [], skipped: true }, { questionId: "q1_2", selected: [], own: [], skipped: true }]);
    // every payload is one the API accepts
    for (const a of answersPayload([reason, must, pay], s)) expect(IntakeAnswer.parse(a)).toEqual(a);
  });

  it("move one at a time, Next until the last card and Send on it, and start afresh when new cards arrive", () => {
    expect(goTo(initialCards(), 5, 3).index).toBe(2);
    expect(goTo(initialCards(), -1, 3).index).toBe(0);
    expect(nextLabel(0, 3)).toBe("Next");
    expect(nextLabel(2, 3)).toBe("Send");
    expect(nextLabel(0, 1)).toBe("Send");
    expect(cardsKey([reason, must])).not.toBe(cardsKey([must, reason]));
    const view = { status: "active", questions: [reason, pay], pay: { confirmed: { byName: "Dana", at: "", via: "typed" } } } as unknown as IntakeSessionView;
    expect(cardsToShow(view).map((x) => x.id)).toEqual(["q1_1"]);
    expect(cardsToShow({ ...view, status: "compiled" })).toEqual([]);
  });

  it("keep the picks on the other cards when one is answered on the draft panel, and start afresh for new cards", () => {
    const picked = togglePick(initialCards(), reason, reason.options[0]!.value);
    const deck = { key: cardsKey([reason, must, pay]), state: { ...picked, index: 2 }, closed: true };
    // the pay card was set on the panel and went: the reason pick, the card being looked at and the closed deck stay
    const after = deckFor(deck, [reason, must]);
    expect(after.key).toBe(cardsKey([reason, must]));
    expect(answerOf(after.state, reason).selected).toEqual([reason.options[0]!.value]);
    expect(after.state.index).toBe(1);
    expect(after.closed).toBe(true);
    expect(deckFor(deck, [reason, must, pay])).toBe(deck);
    // new cards from the assistant: afresh
    const fresh = deckFor(deck, [{ ...must, id: "q2_1" }]);
    expect(fresh).toEqual({ key: "q2_1", state: initialCards(), closed: false });
    expect(deckFor({ key: "", state: initialCards(), closed: false }, [reason])).toEqual({ key: cardsKey([reason]), state: initialCards(), closed: false });
  });
});

describe("the picks echoed as one message", () => {
  it("reads line for line as the server's own summary of the same answers", () => {
    let s = togglePick(initialCards(), reason, "replacement");
    s = togglePick(s, must, "Active RDH license");
    s = setDraft(s, must, "Local anesthesia permit");
    s = togglePick(togglePick(s, interviewers, "u-dana"), interviewers, SOMEONE_NEW);
    s = setDraft(s, interviewers, "Pat Rivera");
    const questions = [reason, must, interviewers];
    const server = applyAnswers(facts(), questions, answersPayload(questions, s), team);
    expect(echoText(questions, s)).toBe(server.summary.join("\n"));
    expect(echoText(questions, s)).toBe("Why you are hiring: Replacing someone who left\nMust-haves: Active RDH license; Local anesthesia permit\nWho interviews: Dana Owner, Pat Rivera");

    let p = togglePick(initialCards(), decider, "u-dana");
    p = setPayForm(p, pay, { basis: "hourly", min: "45", max: "55", ceiling: "58" });
    p = togglePick(p, start, "asap");
    const round2 = [decider, pay, start];
    expect(echoText(round2, p)).toBe(applyAnswers(facts(), round2, answersPayload(round2, p), team).summary.join("\n"));
    expect(echoText(round2, p)).toBe("Final decision: Dana Owner\nPay: $45–$55 an hour, at most $58\nStart: As soon as possible");
  });

  it("says the questions were skipped when nothing was picked, and uses the same 'someone new' value as the server", () => {
    expect(echoText([reason, must], initialCards())).toBe("Skipped those questions.");
    expect(SOMEONE_NEW).toBe(CORE_SOMEONE_NEW);
  });
});

describe("what we know and what is still missing", () => {
  it("lists the six essentials as the server sees them; pay read from somewhere counts only once a person confirms it", () => {
    const f = facts({ compensationBasis: "hourly", compensationMin: 45, compensationMax: 55, reason: "replacement" });
    const unconfirmed = readinessList(intakeReadiness({ facts: f, state: state(), messages: [], draft: null }));
    expect(unconfirmed.known.map((i) => i.key)).toEqual(["title", "location", "reason_for_hire"]);
    expect(unconfirmed.missing.map((i) => i.key)).toEqual(["compensation_range", "interviewers", "decision_maker"]);
    expect(unconfirmed.missing[0]).toMatchObject({ value: "$45–$55 an hour", note: "Confirm it on the pay card." });
    const confirmed = readinessList(intakeReadiness({ facts: { ...f, decisionMaker: "Dana Owner" }, state: state({ pay: { by: { kind: "user", id: "u-dana" }, at: "2026-10-08T00:00:00Z", via: "pay_card", basis: "hourly", min: 45, max: 55 } }), messages: [], draft: null }));
    expect(confirmed.complete).toBe(true);
    expect(confirmed.known.find((i) => i.key === "interviewers")?.note).toMatch(/decides interviews/);
  });

  it("'Ask for approval' lists what is still in the way, in the server's words, until it is ready", () => {
    const r = intakeReadiness({ facts: facts(), state: state(), messages: [], draft: null });
    const help = approvalHelp(r);
    expect(help.ready).toBe(false);
    expect(help.heading).toBe("Before you can ask for approval:");
    expect(help.lines).toEqual(r.approvalBlockers);
    expect(help.lines).toContain("Set the pay on the pay card.");
    expect(help.title).toMatch(/^Still needed: /);
    expect(approvalHelp({ mayAskForApproval: true, approvalBlockers: [] })).toMatchObject({ ready: true, lines: [] });
  });
});

describe("the draft beside the conversation", () => {
  it("fills in from the answers before the draft is written, each part saying who sees it", () => {
    const view = { facts: facts({ responsibilities: ["Run the hygiene schedule"], mustHaves: ["Active RDH license"], screeningQuestions: ["Which days can you work?"], reason: "replacement", interviewers: ["Dana Owner"], decisionMaker: "Dana Owner", targetStartDate: "2026-11-03", dealBreakers: ["No weekends"] }), draft: null };
    const s = draftSections(view);
    const by = (id: string) => s.find((x) => x.id === id)!;
    expect(by("about").items).toEqual(["Run the hygiene schedule"]);
    // the must-haves and nice-to-haves are listed on the job page in their own words (plan D10), and the panel says so;
    // why each matters stays with the team
    expect(by("must")).toMatchObject({ items: ["Active RDH license"], seenBy: "Candidates see this", visibility: "public" });
    expect(by("nice")).toMatchObject({ visibility: "public" });
    expect(packetVisibility("requirements.mustHaves[0].text")).toBe("public");
    expect(packetVisibility("requirements.mustHaves[0].rationale")).toBe("reviewed");
    expect(by("about")).toMatchObject({ seenBy: "Candidates see this", visibility: "public" });
    expect(by("screening")).toMatchObject({ seenBy: "Candidates are asked this" });
    expect(by("why")).toMatchObject({ text: "Replacing someone who left", seenBy: "Only your team sees this" });
    expect(by("team").items).toEqual(["Interviews: Dana Owner", "Final decision: Dana Owner"]);
    expect(by("start").text).toBe("Start by November 3, 2026");
    expect(by("dealbreakers").seenBy).toBe("Only your team sees this");
    expect(s.some((x) => x.id === "eligibility")).toBe(false);
    expect(draftTitle(view)).toBe("Dental Hygienist");
    expect(draftTitle({ facts: facts({ title: undefined }), draft: null })).toBeNull();
    expect(basicsChips(view).find((c) => c.name === "Pay")).toMatchObject({ text: "Pay not set yet", missing: true });
  });

  it("reads the written draft for what candidates see, and the answers for what only the team sees", () => {
    const d = samplePacket();
    const s = draftSections({ facts: facts({ reason: "growth" }), draft: d });
    expect(s.find((x) => x.id === "about")?.text).toBe(d.description.publicJobDescription);
    expect(s.find((x) => x.id === "must")?.items).toEqual(d.requirements.mustHaves.map((m) => m.text));
    expect(s.find((x) => x.id === "eligibility")?.items).toEqual(["Are you available Monday to Friday, 8 to 5?"]);
    expect(s.find((x) => x.id === "why")?.text).toBe("The team is growing");
    expect(basicsChips({ facts: facts(), draft: d }).map((c) => c.text)).toEqual(["Irvine, CA", "On site", "Full time", "$24–$28 an hour", "Monday to Friday, 8 to 5"]);
  });

  it("lights up only the parts that changed, never on the first look", () => {
    const a = draftSections({ facts: facts({ mustHaves: ["Active RDH license"] }), draft: null });
    const b = draftSections({ facts: facts({ mustHaves: ["Active RDH license", "CPR"] }), draft: null });
    expect(changedSections(null, a)).toEqual([]);
    expect(changedSections(a, a)).toEqual([]);
    expect(changedSections(a, b)).toEqual(["must"]);
  });

  it("knows which part a packet path belongs to", () => {
    expect(sectionOfPath("requirements.mustHaves[2].text")).toBe("must");
    expect(sectionOfPath("requirements.mustHaves[mh_2]")).toBe("must");
    expect(sectionOfPath("description.publicJobDescription")).toBe("about");
    expect(sectionOfPath("compensation.max")).toBe("basics");
    expect(sectionOfPath("screening.questions[0].question")).toBe("screening");
    expect(sectionOfPath("business.timeline.targetStartDate")).toBe("start");
    expect(sectionOfPath("business.reason")).toBe("why");
    expect(sectionOfPath("provenance.flags")).toBeNull();
  });

  it("notices answers changed after the draft was written, as the server says, and warns before writing it again replaces saved changes", () => {
    const readiness = (over: Partial<IntakeSessionView["readiness"]>) => ({ readiness: { hasDraft: true, draftOutOfDate: false, draftEdits: 0, ...over } as IntakeSessionView["readiness"] });
    expect(draftOutOfDate(readiness({ draftOutOfDate: true }))).toBe(true);
    expect(draftOutOfDate(readiness({}))).toBe(false);
    expect(draftOutOfDate(readiness({ hasDraft: false, draftOutOfDate: true }))).toBe(false);
    // with nothing saved on the draft since, it is written again at once; otherwise the person is told what is replaced
    expect(redraftWarning({ draftEdits: 0 })).toBeNull();
    expect(redraftWarning({ draftEdits: 1 })).toMatch(/^Writing it again replaces the change you saved on the draft/);
    expect(redraftWarning({ draftEdits: 3 })).toMatch(/replaces the 3 changes you saved/);
    expect(redraftWarning({ draftEdits: 3 })).toMatch(/Pay, who interviews and decides, and the deal-breakers carry over/);
  });

  it("the server's readiness drives it: changing pay or the decision maker after drafting is carried by rule, other answers are not", () => {
    const six = facts({ reason: "replacement", decisionMaker: "Dana Owner", compensationBasis: "hourly", compensationMin: 45, compensationMax: 55 });
    const pay = { by: { kind: "user" as const, id: "u-dana" }, at: "x", via: "pay_card" as const, basis: "hourly" as const, min: 45, max: 55 };
    const written = state({ pay, draft: { at: "x", aiRunId: "r", by: { kind: "user", id: "u-dana" }, payKey: null, factsKey: draftFactsKey(six), edits: 1 } });
    const draft = samplePacket();
    expect(intakeReadiness({ facts: { ...six, decisionMaker: "Sam Lee", compensationMax: 55 }, state: written, messages: [], draft }).draftOutOfDate).toBe(false);
    expect(intakeReadiness({ facts: { ...six, title: "Office manager" }, state: written, messages: [], draft })).toMatchObject({ draftOutOfDate: true, draftEdits: 1, mayAskForApproval: false });
  });
});

describe("drafting progress", () => {
  it("shows the step the server last recorded, truthfully: one step for each stage it records, none it never does", () => {
    const states = (stage: Parameters<typeof draftSteps>[0]) => draftSteps(stage).map((s) => s.state);
    expect(draftSteps("starting").map((s) => s.label)).toEqual(["Checking market pay", "Writing the draft", "Checking the wording and saving"]);
    expect(states("starting")).toEqual(["active", "waiting", "waiting"]);
    expect(states("benchmark")).toEqual(["active", "waiting", "waiting"]);
    expect(states("writing")).toEqual(["done", "active", "waiting"]);
    expect(states("checking")).toEqual(["done", "done", "active"]);
    expect(states("done")).toEqual(["done", "done", "done"]);
    expect(states("failed")).toEqual(["done", "failed", "waiting"]);
  });

  it("knows a draft is being written right now only while it is recent and unfinished", () => {
    const now = Date.parse("2026-10-08T10:00:00Z");
    expect(draftingNow({ stage: "writing", startedAt: "2026-10-08T09:59:00Z", at: "2026-10-08T09:59:30Z" }, now)).toBe(true);
    expect(draftingNow({ stage: "writing", startedAt: "2026-10-08T09:00:00Z", at: "2026-10-08T09:01:00Z" }, now)).toBe(false);
    expect(draftingNow({ stage: "done", startedAt: "2026-10-08T09:59:00Z", at: "2026-10-08T09:59:30Z" }, now)).toBe(false);
    expect(draftingNow(null, now)).toBe(false);
  });
});

describe("the message box", () => {
  it("sends on Enter at a desk; Shift+Enter, a touch screen and an unfinished accented letter never send", () => {
    expect(enterSends({ key: "Enter", shiftKey: false }, false)).toBe(true);
    expect(enterSends({ key: "Enter", shiftKey: true }, false)).toBe(false);
    expect(enterSends({ key: "Enter", shiftKey: false }, true)).toBe(false);
    expect(enterSends({ key: "Enter", shiftKey: false, isComposing: true }, false)).toBe(false);
    expect(enterSends({ key: "a", shiftKey: false }, false)).toBe(false);
  });

  it("takes a whole pasted ad first and a turn after, and says so before sending", () => {
    expect(messageLimit(true)).toBe(INTAKE_FIRST_MESSAGE_MAX);
    expect(messageLimit(false)).toBe(INTAKE_MESSAGE_MAX);
    expect(messageProblem("x".repeat(INTAKE_FIRST_MESSAGE_MAX), true)).toBeNull();
    expect(messageProblem("x".repeat(INTAKE_FIRST_MESSAGE_MAX + 1), true)).toMatch(/up to 20,000 characters/);
    expect(messageProblem("x".repeat(INTAKE_MESSAGE_MAX + 1), false)).toMatch(/4,000 characters after the first message/);
  });

  it("asks for a change once the draft is written", () => {
    expect(composerPlaceholder({ started: false, hasDraft: false })).toMatch(/^For example/);
    expect(composerPlaceholder({ started: true, hasDraft: false })).toMatch(/draft it/);
    expect(composerPlaceholder({ started: true, hasDraft: true })).toBe("Ask me to change anything: make it warmer, drop the weekend requirement…");
  });
});

describe("pay", () => {
  it("reads figures the way people type them and refuses what cannot be right", () => {
    expect(parseAmount("$60,000")).toBe(60000);
    expect(parseAmount("60k")).toBe(60000);
    expect(parseAmount("45.50")).toBe(45.5);
    expect(Number.isNaN(parseAmount(""))).toBe(true);
    expect(payProblem({ basis: "", min: "1", max: "2", ceiling: "" })).toMatch(/hour or a yearly salary/);
    expect(payProblem({ basis: "hourly", min: "55", max: "45", ceiling: "" })).toMatch(/lowest pay must not be above/);
    expect(payProblem({ basis: "hourly", min: "60000", max: "70000", ceiling: "" })).toMatch(/yearly figure/);
    expect(payProblem({ basis: "salary", min: "45", max: "55", ceiling: "" })).toMatch(/hourly rate/);
    expect(payProblem({ basis: "hourly", min: "45", max: "55", ceiling: "50" })).toMatch(/must not be below the top/);
    expect(payPayload({ basis: "salary", min: "60k", max: "$70,000", ceiling: "" })).toEqual({ basis: "salary", min: 60000, max: 70000 });
  });

  it("shows the market figure with its source and year, and calls ITS's own table an estimate", () => {
    const market = { benchmark: { basis: "hourly" as const, p25: 24, p50: 27, p75: 31, source: "BLS OEWS", metro: "Anaheim metro", asOf: "2025", origin: "market" as const, label: "Market pay, 2025" } };
    expect(marketRange(market)).toBe("$24–$31 an hour, middle $27");
    expect(marketSource(market)).toBe("BLS OEWS, Anaheim metro, 2025");
    expect(marketSource({ benchmark: { ...market.benchmark, origin: "its_estimate" } })).toMatch(/^ITS estimate for Anaheim metro, 2025\. ITS's own pay table/);
    // a figure for a broader group of jobs says it is a rough guide (polish list)
    expect(marketSource({ benchmark: { ...market.benchmark, approximate: true, occupation: "Market research analysts and marketing specialists" } })).toBe("BLS OEWS, Anaheim metro, 2025. A rough guide: there is no figure for this exact job, so it is for market research analysts and marketing specialists.");
    expect(marketRange({ benchmark: null })).toBeNull();
    expect(payFormFrom({ basis: "hourly", stated: { min: 45, max: 55, ceiling: null } })).toEqual({ basis: "hourly", min: "45", max: "55", ceiling: "" });
  });
});

describe("failures, the hand-off and Today", () => {
  it("a failed turn says what to do, never the model's error, and carries the recruiter hand-off with the draft", () => {
    const reply = { error: "schema_violation: missing assistantMessage", recovery: "Try again, or bring in a recruiter to finish it with you.", proposedActions: [{ kind: "ask_recruiter", label: "Bring in a recruiter", method: "POST", path: "/api/v1/escalations", body: { kind: "ask", scope: "company", intakeSessionId: "s1", question: "Please help" } }] };
    const p = turnProblem(reply)!;
    expect(p.message).not.toMatch(/schema/);
    expect(p.message).toMatch(/bring in a recruiter/);
    expect(p.ask).toEqual({ label: "Bring in a recruiter", body: { kind: "ask", scope: "company", intakeSessionId: "s1", question: "Please help" } });
    expect(turnProblem({ assistantMessage: "Hi" })).toBeNull();
    expect(turnProblem(null)).toBeNull();
    expect(askFromDetails({ aiRunId: "r", actions: reply.proposedActions })?.body).toMatchObject({ intakeSessionId: "s1" });
    expect(askFromDetails(undefined)).toBeNull();
    expect(errorWords({ status: 409, message: "This draft has already produced a role." })).toBe("This draft has already produced a role.");
    expect(errorWords(new TypeError("Failed to fetch"))).toMatch(/Check your connection/);
    // offered on every failure, even one that carries no offer: the same request the server makes, with the draft
    const own = draftRecruiterAsk("s1");
    expect(own).toEqual({ label: "Bring in a recruiter", body: { kind: "ask", scope: "company", intakeSessionId: "s1", question: "Please help me finish drafting this role. The assistant could not finish it with me." } });
    expect(presetOf(own.body)).toMatchObject({ kind: "ask", about: "all", intakeSessionId: "s1" });
    const server = readFileSync(new URL("../../apps/api/src/routes/intake.ts", import.meta.url), "utf8");
    expect(server).toContain(`const DRAFT_HELP_QUESTION = "${own.body.question}";`);
  });

  it("names the draft in the address, never the person's words", () => {
    expect(startHireHref()).toBe("/roles/new");
    expect(startHireHref("abc-123")).toBe("/roles/new?session=abc-123");
    expect(NEW_ROLE_FRESH_HREF).toBe("/roles/new?new=1");
  });

  it("asks first before Today's card discards a draft, and offers 'hire again' only for roles that ran their course", () => {
    expect(isDiscardDraft({ method: "POST", path: "/api/v1/intake/sessions/abc/abandon" })).toBe(true);
    expect(isDiscardDraft({ method: "GET", path: "/roles/new?session=abc" })).toBe(false);
    expect(isDiscardDraft({ method: "POST", path: "/api/v1/approvals/x/decide" })).toBe(false);
    expect(["filled", "closed"].every(mayHireAgain)).toBe(true);
    expect(["draft", "pending_approval", "open", "paused"].some(mayHireAgain)).toBe(false);
  });

  it("says truthfully who sees a draft, lets owners and admins find and take over the team's drafts, and words the take-over for every starter (Q6)", () => {
    expect(DRAFT_SEEN_BY).toBe("you, owners and admins can see it");
    expect(["owner", "admin"].every(mayTakeOverDrafts)).toBe(true);
    expect(["hiring_manager", "hr", "recruiter", "interviewer", null, undefined].some(mayTakeOverDrafts)).toBe(false);
    expect(TAKEN_OVER_TOAST.body).toMatch(/Unless they are an owner or an admin, they can no longer work on it/);
    const roles = readFileSync(new URL("../../apps/web/src/pages/Roles.tsx", import.meta.url), "utf8");
    expect(roles).not.toContain("only you see this");
    expect(roles).toContain('api.get<{ sessions: IntakeSessionSummary[] }>("/api/v1/intake/sessions")');
    expect(roles).toContain("Drafts on your team");
    // "Hire for this role again" spins on the role pressed, not on every role
    expect(roles).toContain("loading={again.pendingRoleId === r.id}");
    const builder = readFileSync(new URL("../../apps/web/src/pages/new-role/Builder.tsx", import.meta.url), "utf8");
    expect(builder).toContain("{mayTakeOver ? <Button");
    expect(builder).not.toContain("no longer sees it");
  });

  it("the approval card lists the flagged wording with a way to keep it, and keeps Send back whatever the flags (C1)", () => {
    const plan = readFileSync(new URL("../../apps/web/src/pages/RolePlan.tsx", import.meta.url), "utf8");
    expect(plan).toContain("<ApprovalFlags");
    expect(plan).toContain("/flags/keep`");
    expect(plan).toContain("pending.viewer.maySendBack ? <Button onClick={() => setSendingBack(true)}>Send back with a note</Button>");
  });
});

describe("quick starts", () => {
  it("are offered for exactly the business types a hiring guide serves", () => {
    expect(GUIDE_OF_VERTICAL).toEqual(VERTICAL_TO_PLAYBOOK);
    expect(quickStartsFor("veterinary")).toEqual([]);
    expect(quickStartsFor("")).toEqual([]);
    expect(quickStartsFor("Dental").length).toBeGreaterThan(0);
  });

  it("each start a different role the guide knows", () => {
    for (const [guide, starts] of Object.entries(QUICK_STARTS)) {
      const playbook = findPlaybook(guide)!;
      const keys = starts.map((s) => matchPlaybookRole(playbook, s.text)?.key);
      expect(keys.every(Boolean), guide).toBe(true);
      expect(new Set(keys).size, guide).toBe(keys.length);
    }
  });
});

describe("the draft panel's Edit", () => {
  const f = facts({ schedule: "Mon to Thu", mustHaves: ["Active RDH license"], interviewers: ["Sam Lee", "Pat Rivera"], interviewerUserIds: ["u-sam"], decisionMaker: "Dana Owner", decisionMakerUserId: "u-dana" });

  it("sends nothing when nothing changed", () => {
    expect(factsPatch(factsFormFrom(f, team), factsFormFrom(f, team))).toBeNull();
  });

  it("sends exactly what changed: set, clear, add and remove, one person or a name", () => {
    const before = factsFormFrom(f, team);
    expect(before.otherInterviewers).toEqual(["Pat Rivera"]);
    const after = structuredClone(before);
    after.text.title = "Registered Dental Hygienist";
    after.text.schedule = " ";
    after.lists.mustHaves = ["Active RDH license", "CPR certification"];
    after.interviewerUserIds = ["u-sam", "u-dana"];
    after.otherInterviewers = [];
    after.decisionMakerUserId = "";
    after.decisionMakerName = "Dr Chen";
    const patch = factsPatch(before, after)!;
    expect(patch).toEqual({
      set: { title: "Registered Dental Hygienist", decisionMaker: "Dr Chen", interviewerUserIds: ["u-sam", "u-dana"] },
      add: [{ field: "mustHaves", value: "CPR certification" }],
      remove: [{ field: "interviewers", value: "Pat Rivera" }],
      clear: ["schedule"],
    });
    expect(IntakeFactsPatch.parse(patch)).toEqual(patch);
    // the server applies it as meant
    const applied = applyFactsPatch(f, patch, team).facts;
    expect(applied).toMatchObject({ title: "Registered Dental Hygienist", decisionMaker: "Dr Chen", mustHaves: ["Active RDH license", "CPR certification"] });
    expect(applied.schedule).toBeUndefined();
    expect(applied.decisionMakerUserId).toBeUndefined();
    expect(applied.interviewers).toEqual(["Sam Lee", "Dana Owner"]);
  });

  it("names a team member for the final say by id", () => {
    const before = factsFormFrom(facts(), team);
    expect(factsPatch(before, { ...before, decisionMakerUserId: "u-dana" })).toEqual({ set: { decisionMakerUserId: "u-dana" } });
    expect(factsPatch(factsFormFrom(f, team), { ...factsFormFrom(f, team), decisionMakerUserId: "", decisionMakerName: "" })).toEqual({ clear: ["decisionMaker"] });
  });
});

describe("change it by asking", () => {
  it("has one place for every address, for a draft and for a role", () => {
    const d = refinePaths({ kind: "draft", sessionId: "s1" });
    expect(d).toMatchObject({ revise: "/api/v1/intake/sessions/s1/revisions", check: "/api/v1/intake/sessions/s1/requirements-check", applyFixes: "/api/v1/intake/sessions/s1/requirements-check/apply", preview: "/api/v1/intake/sessions/s1/preview" });
    expect(d.apply("p 1")).toBe("/api/v1/intake/sessions/s1/revisions/p%201/apply");
    const r = refinePaths({ kind: "role", roleId: "r1" });
    expect(r.revise).toBe("/api/v1/roles/r1/revisions");
    expect(r.discard("p1")).toBe("/api/v1/roles/r1/revisions/p1/discard");
    expect(r.preview).toBe("/api/v1/roles/r1/preview");
    expect(CHANGE_REQUEST_MAX).toBe(2_000);
    expect(messageProblem("x".repeat(2_001), false, CHANGE_REQUEST_MAX)).toMatch(/up to 2,000 characters\. Say the change in a sentence or two/);
  });

  const change = (path: string, kind: "added" | "removed" | "changed" = "changed") => ({ path, label: path, kind, before: kind === "added" ? null : "old", after: kind === "removed" ? null : "new", visibility: "public" as const });
  const diff = (paths: string[]) => ({ from: null, to: null, total: paths.length, sections: [{ section: "x", label: "X", changes: paths.map((p) => change(p)) }] });

  it("names the parts a proposal changes, once each, from the fields it changes", () => {
    const ids = proposalSections({ sections: ["description", "requirements"], diff: diff(["description.publicJobDescription", "requirements.niceToHaves[nh_1]", "requirements.niceToHaves[nh_2]", "provenance.aiRunIds"]) });
    expect(ids).toEqual(["about", "nice"]);
    expect(partsLine(ids)).toBe("Changes What you'll do and Nice to have.");
    expect(partsLine(["must"])).toBe("Changes What we're looking for.");
    // a change that names no field is placed by its section
    expect(proposalSections({ sections: ["screening", "competencies"], diff: diff([]) })).toEqual(["screening"]);
    expect(proposalSections(null)).toEqual([]);
  });

  it("shows each changed field plainly, says what Confirm does, and treats a question back as a reply", () => {
    expect(changeLine({ kind: "added", before: null, after: "Dentrix experience" })).toBe("Added: Dentrix experience");
    expect(changeLine({ kind: "removed", before: "Weekends", after: null })).toBe("Taken out: Weekends");
    expect(changeLine({ kind: "changed", before: "Warm", after: "Formal" })).toBe("Warm → Formal");
    expect(changeLine({ kind: "changed", before: "a".repeat(200), after: "b" }, 20)).toBe(`${"a".repeat(19)}… → b`);
    expect(takesEffectWords("draft")).toMatch(/changes the draft/);
    expect(takesEffectWords("after_approval")).toMatch(/once it is approved/);
    expect(takesEffectWords("now")).toMatch(/used straight away/);
    expect(asksBack({ question: "Which weekend days?", sections: [] })).toBe(true);
    expect(asksBack({ question: null, sections: ["screening"] })).toBe(false);
  });

  it("places each requirements-check suggestion under the part it is about, leaving out what was set aside", () => {
    const sg = (id: string, path: string) => ({ id, kind: "trait_as_skill" as const, title: "A personality trait, not a skill", path, text: "Team player", why: "Hard to check.", fixes: [{ id: `${id}-f`, label: "Ask about it in the interview", op: "to_interview" as const, after: null }], flagId: null });
    const by = suggestionsBySection({ suggestions: [sg("a", "requirements.mustHaves[mh_2]"), sg("b", "screening.questions[pay]"), sg("c", "evaluation.criteria[0]"), sg("d", "requirements.mustHaves[mh_3]")] }, ["d"]);
    expect(by.get("must")?.map((s) => s.id)).toEqual(["a"]);
    expect(by.get("screening")?.map((s) => s.id)).toEqual(["b"]);
    expect(by.get("other")?.map((s) => s.id)).toEqual(["c"]);
    expect(suggestionsBySection(null, []).size).toBe(0);
  });

  it("asks to reword a flagged phrase, keeps only the open flags, and runs the check again only when the requirements change", () => {
    expect(rewordInstruction({ text: "recent graduates", alternative: "Say what the job needs instead, like 'new to the field welcome'." })).toBe("Reword \"recent graduates\" so it no longer says that. Say what the job needs instead, like 'new to the field welcome'. Keep everything else as it is.");
    const flag = { id: "f1", path: "description.publicJobDescription", rule: "recent_graduate", text: "recent graduates", reason: "Age proxy." };
    expect(openFlags([flag, { ...flag, id: "f2", kept: { reason: "ok", by: { kind: "user", id: "u" }, at: "" } }]).map((f) => f.id)).toEqual(["f1"]);
    const a = samplePacket();
    const b = samplePacket((p) => { p.requirements.mustHaves[0].text = "X-ray certificate"; });
    const c = samplePacket((p) => { p.identity.schedule = "Weekends"; });
    expect(checkSignature(a)).toBe(checkSignature(samplePacket()));
    expect(checkSignature(a)).not.toBe(checkSignature(b));
    expect(checkSignature(a)).toBe(checkSignature(c));
    expect(checkSignature(null)).toBe("none");
  });

});

describe("the role editor's plain fields", () => {
  const packet = samplePacket() as unknown as WebRolePacket;

  it("keeps the questions every applicant answers (Wave S7), which it does not show, through any save", () => {
    const withQuestions = samplePacket((p) => {
      p.companyQuestions = { quick: [{ kind: "choice", key: "cq_transport", question: "How will you get to work?", required: true, options: ["My own car", "Public transport"] }], written: [{ key: "wq_calm", question: "Tell us about a time you calmed a nervous patient.", required: true, lookFor: "A real example" }] };
    }) as unknown as WebRolePacket;
    const form = packetFormFrom(withQuestions);
    form.title = "Registered Dental Assistant";
    const next = RolePacketSchema.parse(applyPacketForm(withQuestions, form));
    expect(next.identity.title).toBe("Registered Dental Assistant");
    expect(next.companyQuestions).toEqual((withQuestions as unknown as { companyQuestions: unknown }).companyQuestions);
  });

  it("saves a valid packet that keeps everything the form does not show", () => {
    const form = packetFormFrom(packet);
    expect(packetFormProblem(form)).toBeNull();
    const same = applyPacketForm(packet, form);
    expect(same).toEqual(packet);
    form.title = "Registered Dental Assistant";
    form.places = [{ city: "Irvine", region: "ca" }, { city: "Tustin", region: "CA" }];
    form.basis = "hourly";
    form.ceiling = "";
    form.questions = moveRow([...form.questions, { key: null, question: "Do you have a radiography certificate?", kind: "eligibility" }], 4, -1);
    form.questions[0] = { ...form.questions[0], question: "Tell me about your most recent chairside work." };
    form.eligibility = [...form.eligibility, { key: null, type: "certification", question: "Do you hold a radiography certificate?", rationale: "Required to take x-rays", knockout: true }];
    form.dealBreakers = ["No weekend work", " "];
    form.decisionMakerUserId = "";
    form.decisionMakerName = "Dr Chen";
    form.tone = "direct";
    const next = applyPacketForm(packet, form);
    const parsed = RolePacketSchema.parse(next);
    expect(parsed.identity.locations).toEqual([{ city: "Irvine", region: "CA", country: "US" }, { city: "Tustin", region: "CA", country: "US" }]);
    expect(parsed.compensation.ceiling).toBe(28);
    expect(parsed.screening.questions.map((x) => x.key)).toEqual(["recent", "nervous", "available", "q_4_do_you_have_a_radiography_cert", "pay"]);
    // reworded: the model answer written for the old words is dropped; untouched questions keep theirs
    expect(parsed.screening.questions[0].modelAnswer).toBeUndefined();
    expect(parsed.requirements.eligibility[1]).toMatchObject({ type: "certification", expectation: {}, knockout: true });
    expect(parsed.preferences).toMatchObject({ decisionMakerName: "Dr Chen", dealBreakersInTheirWords: ["No weekend work"] });
    expect(parsed.preferences.decisionMakerUserId).toBeUndefined();
    expect(parsed.communication.tone).toBe("direct");
    expect(parsed.competencies).toEqual((packet as unknown as ReturnType<typeof samplePacket>).competencies);
  });

  it("says plainly what cannot be saved", () => {
    const form = packetFormFrom(packet);
    expect(packetFormProblem({ ...form, title: " " })).toMatch(/title/);
    expect(packetFormProblem({ ...form, places: [{ city: "", region: "" }] })).toMatch(/where the job is/);
    expect(packetFormProblem({ ...form, min: "30", max: "20" })).toMatch(/minimum is above/);
    expect(packetFormProblem({ ...form, ceiling: "10" })).toMatch(/must not be below the top/);
    expect(packetFormProblem({ ...form, questions: form.questions.slice(0, 2) })).toMatch(/at least 3 screening questions/);
    expect(packetFormProblem({ ...form, eligibility: [{ key: null, type: "license", question: "Licensed?", rationale: "", knockout: true }] })).toMatch(/why it is asked/);
    expect(moveRow([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveRow([1, 2, 3], 2, -1)).toEqual([1, 3, 2]);
  });
});
