import { describe, expect, it } from "vitest";
import {
  AI_HELP_UPGRADE_QUESTION, INTAKE_ESSENTIALS, INTAKE_ESSENTIAL_LABEL, INTAKE_FIRST_MESSAGE_MAX, INTAKE_MESSAGE_MAX, IntakeAnswer, IntakeAnswersRequest,
  type IntakeQuestion, type IntakeReadiness, type IntakeSessionView,
} from "../../packages/contracts/src/index";
import {
  DRAFT_STEP_LABELS, FIELD_LABEL, addOwn, answerOf, answerPayload, answersPayload, answersToCarry, cardsKey, cardsToShow, carriedLine, closeDeck, composerPlaceholder, deckFor, draftSteps, draftTitle,
  draftingNow, echoText, enterSends, essentialsList, firstReplyKey, goTo, initialCards, isAnswered, messageLimit, messageProblem, nextLabel, parseAmount, payCardProblem, payFormFrom, payFormShown,
  payPayload, payProblem, pickHint, publishHelp, redraftWarning, refusedLines, removeOwn, replyWords, sessionKey, setDraft, setPayForm, togglePick, turnProblem, typeInstead, typedWithCards, writeHelp,
  type CardState, type Deck, type PayForm,
} from "../../apps/web/src/builder";

/**
 * The job builder's pure pieces: the question cards' state and what they send, the one line the picks are echoed as,
 * the essentials list, what the two main buttons wait for, the steps of writing the job, when Enter sends, and what is
 * said when a turn fails. The server decides everything that matters; these only show it.
 */
const q = (over: Partial<IntakeQuestion> & Pick<IntakeQuestion, "id" | "field" | "mode">): IntakeQuestion => ({ prompt: "A question?", options: [], allowOwn: true, why: "Because.", ...over });
const arrangement = q({ id: "q1_1", field: "remote_policy", mode: "single", options: [{ label: "On site", value: "onsite", origin: "assistant" }, { label: "Hybrid", value: "hybrid", origin: "assistant" }] });
const must = q({ id: "q1_2", field: "must_haves", mode: "multi", options: [{ label: "Active RDH license", value: "Active RDH license", origin: "assistant" }, { label: "Perio experience", value: "Periodontal therapy experience", origin: "assistant" }, { label: "Dentrix", value: "Dentrix experience", origin: "assistant" }] });
const pay = q({ id: "q2_2", field: "compensation", mode: "pay" });
const type = q({ id: "q2_3", field: "employment_type", mode: "single", allowOwn: false, options: [{ label: "Full time", value: "full_time", origin: "assistant" }, { label: "Part time", value: "part_time", origin: "assistant" }] });
const schedule = q({ id: "q1_4", field: "schedule", mode: "free" });

describe("question cards", () => {
  it("say what kind of answer each takes", () => {
    expect(pickHint(arrangement)).toBe("Pick one");
    expect(pickHint(must)).toBe("Pick any that apply");
    expect(pickHint(pay)).toBe("Set the pay");
    expect(pickHint(schedule)).toBe("Type your answer");
    // nothing to pick, only the box for the person's own words
    expect(pickHint(q({ id: "deal", field: "deal_breakers", mode: "multi" }))).toBe("Type your answer");
  });

  it("a pick-one card keeps one answer: a new pick replaces it, the same pick clears it, typed words replace the pick", () => {
    let s: CardState = initialCards();
    s = togglePick(s, arrangement, "onsite");
    s = togglePick(s, arrangement, "hybrid");
    expect(answerOf(s, arrangement).selected).toEqual(["hybrid"]);
    expect(answerPayload(arrangement, answerOf(s, arrangement))).toEqual({ questionId: "q1_1", selected: ["hybrid"], own: [], skipped: false });
    s = setDraft(s, arrangement, "Two days a week in the office");
    expect(answerOf(s, arrangement).selected).toEqual([]);
    expect(answerPayload(arrangement, answerOf(s, arrangement))).toMatchObject({ selected: [], own: ["Two days a week in the office"], skipped: false });
    s = togglePick(s, arrangement, "onsite");
    expect(answerOf(s, arrangement).draft).toBe("");
    s = togglePick(s, arrangement, "onsite");
    expect(answerPayload(arrangement, answerOf(s, arrangement)).skipped).toBe(true);
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

  it("the pay card sends the pay only once it can be set; a card left alone, or one that takes no own words, sends nothing it should not", () => {
    let s = setPayForm(initialCards(), pay, { basis: "hourly", min: "45", max: "" });
    expect(answerPayload(pay, answerOf(s, pay)).skipped).toBe(true);
    expect(isAnswered(pay, answerOf(s, pay))).toBe(false);
    s = setPayForm(s, pay, { basis: "hourly", min: "$45", max: "55" });
    expect(answerPayload(pay, answerOf(s, pay))).toEqual({ questionId: "q2_2", selected: [], own: [], skipped: false, pay: { basis: "hourly", min: 45, max: 55 } });
    // a card that takes no words of the person's own never sends any
    expect(answerPayload(type, answerOf(setDraft(initialCards(), type, "seasonal"), type)).skipped).toBe(true);
    expect(answersPayload([arrangement, must], initialCards())).toEqual([{ questionId: "q1_1", selected: [], own: [], skipped: true }, { questionId: "q1_2", selected: [], own: [], skipped: true }]);
    // every payload is one the API accepts
    for (const a of answersPayload([arrangement, must, pay], s)) expect(IntakeAnswer.parse(a)).toEqual(a);
  });

  // Found by two audits in November 2026: a pasted ad's pay was drawn in the pay card's boxes, the owner pressed Send on
  // the filled card, and the card went as skipped, so the pay stayed unconfirmed and "Write the job" stayed grey.
  it("a pay card that shows the draft's pay, sent as it was drawn, sends the figures it shows; with empty boxes it is still a skip", () => {
    const fromAd = { basis: "hourly" as const, stated: { min: 24, max: 28 } };
    const nothing = { basis: null, stated: { min: null, max: null } };
    // the deck's own Send with nothing touched: the figures in the boxes go, so the person who pressed Send has confirmed them
    const sent = answersPayload([arrangement, pay], initialCards(), fromAd);
    expect(sent).toEqual([{ questionId: "q1_1", selected: [], own: [], skipped: true }, { questionId: "q2_2", selected: [], own: [], skipped: false, pay: { basis: "hourly", min: 24, max: 28 } }]);
    for (const a of sent) expect(IntakeAnswer.parse(a)).toEqual(a);
    // and the conversation says so at once
    expect(echoText([arrangement, pay], initialCards(), fromAd)).toBe("Pay: $24–$28 an hour");
    // figures the person changed on the card go as they typed them, never the ad's
    const changed = setPayForm(initialCards(), pay, { basis: "hourly", min: "26", max: "30" });
    expect(answerPayload(pay, answerOf(changed, pay), fromAd).pay).toEqual({ basis: "hourly", min: 26, max: 30 });
    // boxes the person emptied are a skip: the ad's figures are not sent behind their back
    const emptied = setPayForm(initialCards(), pay, { basis: "hourly", min: "", max: "" });
    expect(answerPayload(pay, answerOf(emptied, pay), fromAd).skipped).toBe(true);
    // a card with nothing in its boxes, left alone, is skipped as before
    expect(answersPayload([pay], initialCards(), nothing)).toEqual([{ questionId: "q2_2", selected: [], own: [], skipped: true }]);
    expect(answersPayload([pay], initialCards())).toEqual([{ questionId: "q2_2", selected: [], own: [], skipped: true }]);
    expect(echoText([pay], initialCards(), nothing)).toBe("Skipped those questions.");
  });

  it("a pay card nobody touched is confirmed only by the deck's own Send, never by typed words or 'Write the job' taking the answers along", () => {
    const untouched: Deck = { key: "", state: togglePick(initialCards(), arrangement, "hybrid"), closed: false };
    expect(isAnswered(pay, answerOf(untouched.state, pay))).toBe(false);
    expect(answersToCarry([arrangement, pay], untouched)?.answers).toEqual([{ questionId: "q1_1", selected: ["hybrid"], own: [], skipped: false }]);
    expect(typedWithCards([arrangement, pay], typeInstead(untouched), "The office is in Irvine.")?.echo).toBe("Work arrangement: Hybrid\nThe office is in Irvine.");
    expect(carriedLine([arrangement, pay], typeInstead(untouched))).toBe("Sent with your message: Work arrangement: Hybrid");
    expect(answersToCarry([pay], { key: "", state: initialCards(), closed: false })).toBeNull();
  });

  it("move one at a time, Next until the last card and Send on it, and are shown only while the draft is being built", () => {
    expect(goTo(initialCards(), 5, 3).index).toBe(2);
    expect(goTo(initialCards(), -1, 3).index).toBe(0);
    expect(nextLabel(0, 3)).toBe("Next");
    expect(nextLabel(2, 3)).toBe("Send");
    expect(nextLabel(0, 1)).toBe("Send");
    expect(cardsKey([arrangement, must])).not.toBe(cardsKey([must, arrangement]));
    const view = { status: "active", questions: [arrangement, pay] } as unknown as IntakeSessionView;
    expect(cardsToShow(view).map((x) => x.id)).toEqual(["q1_1", "q2_2"]);
    expect(cardsToShow({ ...view, status: "compiled" })).toEqual([]);
    expect(cardsToShow({ ...view, status: "abandoned" })).toEqual([]);
  });

  it("keep their picks while the same cards are showing, and start afresh when new cards arrive", () => {
    const picked = togglePick(initialCards(), arrangement, "onsite");
    const deck: Deck = { key: cardsKey([arrangement, must]), state: { ...picked, index: 1 }, closed: true };
    expect(deckFor(deck, [arrangement, must])).toBe(deck);
    expect(deckFor(deck, [{ ...must, id: "q2_1" }])).toEqual({ key: "q2_1", state: initialCards(), closed: false });
    expect(deckFor({ key: "", state: initialCards(), closed: false }, [arrangement])).toEqual({ key: cardsKey([arrangement]), state: initialCards(), closed: false });
  });

  const openDeck = (s: CardState): Deck => ({ key: "", state: s, closed: false });

  it("after 'Or type your own answer…' typed words take what is already answered on the cards with them, leave the other cards alone, and say so above the box first", () => {
    let d = typeInstead(openDeck(togglePick(initialCards(), arrangement, "hybrid")));
    expect(d).toMatchObject({ closed: true, carry: true });
    expect(typedWithCards([arrangement, must], d, "The office is in Irvine.")).toEqual({
      answers: [{ questionId: "q1_1", selected: ["hybrid"], own: [], skipped: false }],
      note: "The office is in Irvine.",
      echo: "Work arrangement: Hybrid\nThe office is in Irvine.",
    });
    expect(carriedLine([arrangement, must], d)).toBe("Sent with your message: Work arrangement: Hybrid");
    // words added on a card are an answer too, and pay once it can be set
    const s = setPayForm(addOwn(setDraft(d.state, must, "Local anesthesia permit"), must), pay, { basis: "hourly", min: "45", max: "55" });
    d = { ...d, state: s };
    const sent = typedWithCards([arrangement, must, pay], d, "Start soon.");
    expect(sent?.answers.map((a) => a.questionId)).toEqual(["q1_1", "q1_2", "q2_2"]);
    expect(sent?.echo).toBe("Work arrangement: Hybrid\nMust-haves: Local anesthesia permit\nPay: $45–$55 an hour\nStart soon.");
    // the request is one the API accepts
    expect(IntakeAnswersRequest.parse({ answers: sent?.answers, note: sent?.note })).toMatchObject({ note: "Start soon." });
    // nothing on any card: a plain message, and no line
    const nothing = typeInstead(openDeck(initialCards()));
    expect(typedWithCards([arrangement, must], nothing, "Hello")).toBeNull();
    expect(carriedLine([arrangement, must], nothing)).toBeNull();
    expect(typedWithCards([], d, "Hello")).toBeNull();
    // a pay card with figures that cannot be set yet is no answer
    expect(typedWithCards([pay], typeInstead(openDeck(setPayForm(initialCards(), pay, { basis: "hourly", min: "45", max: "" }))), "Hello")).toBeNull();
  });

  it("the X leaves what is answered on the cards: typed words go alone, with no line, until the deck is folded the other way", () => {
    let s = togglePick(initialCards(), must, "Active RDH license");
    s = setPayForm(s, pay, { basis: "hourly", min: "24", max: "28" });
    const closed = closeDeck(openDeck(s));
    expect(closed.closed).toBe(true);
    expect(typedWithCards([must, pay], closed, "A question first.")).toBeNull();
    expect(carriedLine([must, pay], closed)).toBeNull();
    expect(answersToCarry([must, pay], closed)).toBeNull();
    // still on the card, for when it is opened again
    expect(answerOf(closed.state, must).selected).toEqual(["Active RDH license"]);
    expect(answerOf(closed.state, pay).pay).toMatchObject({ min: "24", max: "28" });
    // the X clears what "Or type your own answer…" set, and the other way round
    expect(typedWithCards([must], closeDeck(typeInstead(openDeck(s))), "Hello")).toBeNull();
    expect(typedWithCards([must], typeInstead(closed), "Hello")?.answers).toEqual([{ questionId: "q1_2", selected: ["Active RDH license"], own: [], skipped: false }]);
  });

  it("a half-typed 'Add your own' word is not an answer when something else is sent; the card's own Send still takes it, and a box with no Add is the answer", () => {
    const half = typeInstead(openDeck(setDraft(initialCards(), must, "Dent")));
    expect(typedWithCards([must], half, "Hello")).toBeNull();
    expect(carriedLine([must], half)).toBeNull();
    // beside a tick or an added word, only those go
    const ticked = { ...half, state: addOwn(setDraft(togglePick(half.state, must, "Active RDH license"), must, "CPR certification"), must) };
    const both = { ...ticked, state: setDraft(ticked.state, must, "Dent") };
    expect(typedWithCards([must], both, "Hello")?.answers).toEqual([{ questionId: "q1_2", selected: ["Active RDH license"], own: ["CPR certification"], skipped: false }]);
    expect(carriedLine([must], both)).toBe("Sent with your message: Must-haves: Active RDH license; CPR certification");
    // the card's own Send counts the words in the box
    expect(answerPayload(must, answerOf(both.state, must)).own).toEqual(["CPR certification", "Dent"]);
    // a pick-one or a free card has no Add: the words in the box are the answer, and the line names them before Send
    const words = typeInstead(openDeck(setDraft(setDraft(initialCards(), arrangement, "Two days in the office"), schedule, "Weekdays, 8 to 5")));
    expect(typedWithCards([arrangement, schedule], words, "Hello")?.answers).toEqual([{ questionId: "q1_1", selected: [], own: ["Two days in the office"], skipped: false }, { questionId: "q1_4", selected: [], own: ["Weekdays, 8 to 5"], skipped: false }]);
    expect(carriedLine([arrangement, schedule], words)).toBe("Sent with your message: Work arrangement: Two days in the office · Schedule: Weekdays, 8 to 5");
  });

  it("'Write the job' takes what is answered on the open cards with it, only the cards answered, and never what the X left on a card", () => {
    const s = togglePick(togglePick(initialCards(), must, "Active RDH license"), arrangement, "hybrid");
    const first = answersToCarry([arrangement, must, pay], openDeck(s));
    expect(first?.answers).toEqual([{ questionId: "q1_1", selected: ["hybrid"], own: [], skipped: false }, { questionId: "q1_2", selected: ["Active RDH license"], own: [], skipped: false }]);
    // a card left alone stays open, unsent; a deck with nothing on it sends nothing at all
    expect(first?.answers.map((a) => a.questionId)).not.toContain(pay.id);
    expect(answersToCarry([arrangement, must], openDeck(initialCards()))).toBeNull();
    expect(answersToCarry([arrangement, must], typeInstead(openDeck(s)))?.answers).toEqual(first?.answers);
    expect(answersToCarry([arrangement, must], closeDeck(openDeck(s)))).toBeNull();
  });

  it("says in the conversation which words the fairness check did not use, with the reason and the lawful alternative", () => {
    expect(refusedLines([{ text: "Recent graduates only", reason: "That is a proxy for age.", alternative: null }])).toEqual(['Not used: "Recent graduates only". That is a proxy for age.']);
    expect(refusedLines([{ text: "Native English speaker", reason: "That stands in for national origin.", alternative: "Ask for fluent English instead." }])).toEqual(['Not used: "Native English speaker". That stands in for national origin. Ask for fluent English instead.']);
  });
});

describe("the picks echoed as one message", () => {
  it("names each answered card by what it asks, a list on one line, the pay as a range", () => {
    let s = togglePick(initialCards(), arrangement, "hybrid");
    s = togglePick(s, must, "Active RDH license");
    s = setDraft(s, must, "Local anesthesia permit");
    s = setPayForm(s, pay, { basis: "hourly", min: "45", max: "55" });
    s = togglePick(s, type, "full_time");
    expect(echoText([arrangement, must, pay, type], s)).toBe("Work arrangement: Hybrid\nMust-haves: Active RDH license; Local anesthesia permit\nPay: $45–$55 an hour\nFull time or part time: Full time");
    // every question the builder can ask has its words
    expect(Object.keys(FIELD_LABEL).sort()).toEqual(["benefits", "compensation", "compensation_basis", "deal_breakers", "employment_type", "location", "must_haves", "remote_policy", "schedule", "title"]);
  });

  it("says the questions were skipped when nothing was picked", () => {
    expect(echoText([arrangement, must], initialCards())).toBe("Skipped those questions.");
  });
});

describe("what we know and what is still needed", () => {
  const essentials = (done: Partial<Record<(typeof INTAKE_ESSENTIALS)[number], string>>): IntakeReadiness["essentials"] => INTAKE_ESSENTIALS.map((key) => ({ key, label: INTAKE_ESSENTIAL_LABEL[key], done: key in done, value: done[key] ?? null }));

  it("lists the seven essentials as the server sees them; pay read from an ad counts only once a person confirms it", () => {
    const some = essentials({ title: "Dental Hygienist", location: "Irvine, CA", compensation_range: "$45–$55 an hour" });
    const unconfirmed = essentialsList({ essentials: some, payConfirmed: false });
    expect(unconfirmed.known.map((i) => i.key)).toEqual(["title", "location"]);
    expect(unconfirmed.missing.map((i) => i.key)).toEqual(["remote_policy", "compensation_range", "employment_type", "schedule", "must_haves"]);
    expect(unconfirmed.missing.find((i) => i.key === "compensation_range")).toMatchObject({ value: "$45–$55 an hour", note: "Confirm it on the pay card.", done: false });
    expect(unconfirmed.complete).toBe(false);
    const confirmed = essentialsList({ essentials: some, payConfirmed: true });
    expect(confirmed.known.map((i) => i.key)).toEqual(["title", "location", "compensation_range"]);
    expect(confirmed.known.every((i) => i.note === null)).toBe(true);
    const all = essentialsList({ essentials: essentials({ title: "t", location: "l", remote_policy: "r", compensation_range: "c", employment_type: "e", schedule: "s", must_haves: "m" }), payConfirmed: true });
    expect(all).toMatchObject({ complete: true, missing: [] });
    expect(all.known).toHaveLength(7);
  });

  it("'Write the job' waits for the server's word, and says its reason until then", () => {
    expect(writeHelp({ mayDraft: true, draftBlocker: null })).toEqual({ ready: true, lines: [] });
    expect(writeHelp({ mayDraft: false, draftBlocker: "Still needed: the pay and a must-have." })).toEqual({ ready: false, lines: ["Still needed: the pay and a must-have."] });
    expect(writeHelp({ mayDraft: false, draftBlocker: null })).toEqual({ ready: false, lines: ["A few things are still needed."] });
  });

  it("'Publish job' lists every reason the server gives, in its words, until its checks pass", () => {
    expect(publishHelp({ publish: { allowed: true, blockers: [] } })).toEqual({ ready: true, lines: [] });
    const blocked = publishHelp({ publish: { allowed: false, blockers: [{ code: "open_flags", message: "Change or keep the flagged wording first." }, { code: "legal_check", message: "Add the benefits: California asks for them." }] } });
    expect(blocked).toEqual({ ready: false, lines: ["Change or keep the flagged wording first.", "Add the benefits: California asks for them."] });
    expect(publishHelp({ publish: { allowed: false, blockers: [] } }).lines).toEqual(["A few things are still needed."]);
  });

  it("names the draft by its written title, else the title it was told, else nothing yet", () => {
    expect(draftTitle({ facts: { title: "Hygienist" }, draft: { identity: { title: " Dental Hygienist " } } as never })).toBe("Dental Hygienist");
    expect(draftTitle({ facts: { title: "Hygienist" }, draft: null })).toBe("Hygienist");
    expect(draftTitle({ facts: { title: undefined }, draft: null })).toBeNull();
  });

  it("warns before writing the job again replaces edits a person saved on it", () => {
    expect(redraftWarning({ draftEdits: 0 })).toBeNull();
    expect(redraftWarning({ draftEdits: 1 })).toBe("Writing the job again replaces the edit you saved on it.");
    expect(redraftWarning({ draftEdits: 3 })).toBe("Writing the job again replaces the 3 edits you saved on it.");
  });
});

describe("writing the job", () => {
  it("shows the step the server last recorded, truthfully: one step for each stage it records, none it never does", () => {
    const states = (stage: Parameters<typeof draftSteps>[0]) => draftSteps(stage).map((s) => s.state);
    expect(DRAFT_STEP_LABELS).toEqual(["Writing the job", "Checking the wording and saving"]);
    expect(draftSteps("starting").map((s) => s.label)).toEqual(["Writing the job", "Checking the wording and saving"]);
    expect(states("starting")).toEqual(["active", "waiting"]);
    expect(states(null)).toEqual(["active", "waiting"]);
    expect(states("writing")).toEqual(["active", "waiting"]);
    expect(states("checking")).toEqual(["done", "active"]);
    expect(states("done")).toEqual(["done", "done"]);
    expect(states("failed")).toEqual(["failed", "waiting"]);
  });

  it("knows a job is being written right now only while it is recent and unfinished", () => {
    const now = Date.parse("2026-11-18T10:00:00Z");
    expect(draftingNow({ stage: "writing", startedAt: "2026-11-18T09:59:00Z", at: "2026-11-18T09:59:30Z" }, now)).toBe(true);
    expect(draftingNow({ stage: "checking", startedAt: "2026-11-18T09:59:00Z", at: "2026-11-18T09:59:50Z" }, now)).toBe(true);
    expect(draftingNow({ stage: "writing", startedAt: "2026-11-18T09:00:00Z", at: "2026-11-18T09:01:00Z" }, now)).toBe(false);
    expect(draftingNow({ stage: "done", startedAt: "2026-11-18T09:59:00Z", at: "2026-11-18T09:59:30Z" }, now)).toBe(false);
    expect(draftingNow({ stage: "failed", startedAt: "2026-11-18T09:59:00Z", at: "2026-11-18T09:59:30Z" }, now)).toBe(false);
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

  it("shows an example of a first sentence in the empty box, then what the box is for", () => {
    expect(composerPlaceholder(false)).toMatch(/^For example: /);
    expect(composerPlaceholder(true)).toBe("Answer here, or add anything about the job");
  });

  it("keeps a draft and the first reply that came with it under the draft's own id, never the person's words", () => {
    expect(sessionKey("abc-123")).toEqual(["intake", "session", "abc-123"]);
    expect(firstReplyKey("abc-123")).toEqual(["intake", "first-reply", "abc-123"]);
  });
});

describe("pay", () => {
  it("reads figures the way people type them and refuses what cannot be right", () => {
    expect(parseAmount("$60,000")).toBe(60000);
    expect(parseAmount("60k")).toBe(60000);
    expect(parseAmount("45.50")).toBe(45.5);
    expect(Number.isNaN(parseAmount(""))).toBe(true);
    expect(payProblem({ basis: "", min: "1", max: "2" })).toMatch(/hour or a yearly salary/);
    expect(payProblem({ basis: "hourly", min: "55", max: "45" })).toMatch(/lowest pay must not be above/);
    expect(payProblem({ basis: "hourly", min: "60000", max: "70000" })).toMatch(/yearly figure/);
    expect(payProblem({ basis: "salary", min: "45", max: "55" })).toMatch(/hourly rate/);
    expect(payProblem({ basis: "hourly", min: "45", max: "" })).toMatch(/lowest and the highest/);
    // the API's cap, in plain words
    expect(payProblem({ basis: "salary", min: "20000000", max: "20000000" })).toMatch(/too high/);
    expect(payProblem({ basis: "salary", min: "10000000", max: "10000000" })).toBeNull();
    expect(payPayload({ basis: "salary", min: "60k", max: "$70,000" })).toEqual({ basis: "salary", min: 60000, max: 70000 });
    expect(payPayload({ basis: "salary", min: "60k", max: "" })).toBeNull();
  });

  it("on a question card, figures that cannot be sent are said and held, never counted as skipped; empty boxes are a real skip", () => {
    const other = q({ id: "q_other", field: "schedule", mode: "free" });
    const card = q({ id: "q_pay", field: "compensation", mode: "pay" });
    const holding = (form: PayForm): CardState => ({ index: 0, answers: { q_pay: { selected: [], own: [], draft: "", pay: form } } });
    expect(payCardProblem([other, card], holding({ basis: "salary", min: "20000000", max: "20000000" }))).toEqual({ index: 1, words: "That figure is too high. Enter $10,000,000 or less." });
    expect(payCardProblem([card], holding({ basis: "hourly", min: "55", max: "45" }))?.words).toMatch(/lowest pay must not be above/);
    expect(payCardProblem([card], holding({ basis: "", min: "", max: "" }))).toBeNull();
    expect(payCardProblem([card], holding({ basis: "salary", min: "50000", max: "60000" }))).toBeNull();
    expect(payCardProblem([other], { index: 0, answers: {} })).toBeNull();
  });

  it("on a question card, figures drawn from the draft that cannot be sent as they stand are said and held too, never sent as skipped", () => {
    const other = q({ id: "q_other", field: "schedule", mode: "free" });
    const card = q({ id: "q_pay", field: "compensation", mode: "pay" });
    const untouched: CardState = { index: 0, answers: {} };
    // a range read from an ad that did not say by the hour or a year: the boxes show it, with neither chosen
    const noBasis = { basis: null, stated: { min: 24, max: 28 } };
    expect(payCardProblem([other, card], untouched, noBasis)).toEqual({ index: 1, words: "Choose by the hour or a yearly salary." });
    expect(answersPayload([card], untouched, noBasis)).toEqual([{ questionId: "q_pay", selected: [], own: [], skipped: true }]);
    // once the person chooses, the card can go
    const chosen = setPayForm(untouched, card, { ...payFormShown(answerOf(untouched, card), noBasis), basis: "hourly" });
    expect(payCardProblem([card], chosen, noBasis)).toBeNull();
    expect(answersPayload([card], chosen, noBasis)[0].pay).toEqual({ basis: "hourly", min: 24, max: 28 });
    // drawn figures that can go as they stand hold nothing; a basis alone, with empty boxes, is a real skip
    expect(payCardProblem([card], untouched, { basis: "hourly", stated: { min: 24, max: 28 } })).toBeNull();
    expect(payCardProblem([card], untouched, { basis: "hourly", stated: { min: null, max: null } })).toBeNull();
    // without the draft's pay (answers that only go along with something else) an untouched card is never a problem
    expect(payCardProblem([card], untouched)).toBeNull();
  });

  it("fills the pay card from what the draft already says, so a range read from an ad is shown to be confirmed", () => {
    expect(payFormFrom({ basis: "hourly", stated: { min: 45, max: 55 } })).toEqual({ basis: "hourly", min: "45", max: "55" });
    expect(payFormFrom({ basis: null, stated: { min: null, max: null } })).toEqual({ basis: "", min: "", max: "" });
    // the boxes as drawn: the draft's pay until the person changes them, then what they typed
    const card = q({ id: "q_pay", field: "compensation", mode: "pay" });
    expect(payFormShown(answerOf(initialCards(), card), { basis: "hourly", stated: { min: 45, max: 55 } })).toEqual({ basis: "hourly", min: "45", max: "55" });
    expect(payFormShown(answerOf(setPayForm(initialCards(), card, { basis: "salary", min: "60k", max: "" }), card), { basis: "hourly", stated: { min: 45, max: 55 } })).toEqual({ basis: "salary", min: "60k", max: "" });
    expect(payFormShown(answerOf(initialCards(), card))).toEqual({ basis: "", min: "", max: "" });
  });
});

describe("a turn that fails", () => {
  it("says what to do, never the model's error, and offers the Upgrade when the plan's AI help is what ran out", () => {
    const p = turnProblem({ error: "schema_violation: missing assistantMessage", recovery: "Try again.", upgrade: false, ask: null });
    expect(p).toEqual({ message: "The assistant could not reply just now. Try again.", ask: null });
    expect(p?.message).not.toMatch(/schema/);
    // used up: the server's own line and the server's own request (on the top plan it is "Talk to ITS"), and never "try again"
    const used = turnProblem({ error: "ai_credit_used_up", recovery: "Your plan's AI help is used up. Upgrade to keep going.", upgrade: true, ask: { label: "Talk to ITS", reason: AI_HELP_UPGRADE_QUESTION } });
    expect(used).toEqual({ message: "Your plan's AI help is used up. Upgrade to keep going.", ask: { label: "Talk to ITS", reason: AI_HELP_UPGRADE_QUESTION } });
    // someone who may not ask about the plan reads the line and gets no button
    expect(turnProblem({ error: "ai_credit_used_up", recovery: "Your plan's AI help is used up.", upgrade: true, ask: null })).toEqual({ message: "Your plan's AI help is used up.", ask: null });
    const ok = { assistantMessage: "Got it.", readyToCompile: false, takenFromAd: [], notARole: false };
    expect(turnProblem(ok)).toBeNull();
    expect(turnProblem(null)).toBeNull();
    expect(replyWords(ok)).toBe("Got it.");
    expect(replyWords({ error: "x", recovery: "Try again.", upgrade: false, ask: null })).toBeNull();
    expect(replyWords(undefined)).toBeNull();
  });
});
