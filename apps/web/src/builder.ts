import {
  formatPayRange, INTAKE_FIRST_MESSAGE_MAX, INTAKE_MESSAGE_MAX,
  type DraftRolePacket, type IntakeAnswer, type IntakeFacts, type IntakePayCard, type IntakeProgressStage, type IntakeQuestion, type IntakeQuestionField,
  type IntakeReadiness, type IntakeRefusal, type IntakeSessionView, type IntakeTurnReply,
} from "@ros/contracts";
import type { StepState } from "@ros/ui";

/**
 * The job builder's rules that need no browser, kept out of the components so tests/web/builder.test.ts can check
 * them: the question cards' state and what they send, the one summary line the picks are echoed as, the essentials
 * list, the steps of writing the job, when Enter sends, and what is said when a turn fails. The server decides
 * everything that matters (what is missing, the pay, fairness, whether the job may be written or published); these
 * only show it.
 */

/** Where the pages keep a draft once it is read, and the first reply that came with a new draft (their query keys). */
export const sessionKey = (id: string) => ["intake", "session", id];
export const firstReplyKey = (id: string) => ["intake", "first-reply", id];

/** How the summary of tapped answers names each question, until the server's own copy of the message replaces it. */
export const FIELD_LABEL: Readonly<Record<IntakeQuestionField, string>> = {
  title: "Job title",
  location: "Where",
  remote_policy: "Work arrangement",
  employment_type: "Full time or part time",
  schedule: "Schedule",
  compensation_basis: "Paid",
  compensation: "Pay",
  must_haves: "Must-haves",
  deal_breakers: "Deal-breakers",
  benefits: "Benefits",
};

/** Questions whose answer is a list (several picks become several lines of the job). */
const LIST_FIELDS: ReadonlySet<IntakeQuestionField> = new Set<IntakeQuestionField>(["must_haves", "deal_breakers"]);

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/* ------------------------------------------------------------------------------------------------------------------ */
/* Question cards                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What the pay card's boxes hold, as typed ("45", "$60,000", "60k"). */
export type PayForm = { basis: "hourly" | "salary" | ""; min: string; max: string };
/** One card's answer so far: ticked values, words added as their own answers, the words still in the box, and the pay. */
export type CardAnswer = { selected: string[]; own: string[]; draft: string; pay: PayForm | null };
/** Which card is showing, and every card's answer. Cards are reset whenever the server sends new ones (`cardsKey`). */
export type CardState = { index: number; answers: Record<string, CardAnswer> };

const EMPTY_ANSWER: CardAnswer = { selected: [], own: [], draft: "", pay: null };

export function initialCards(): CardState {
  return { index: 0, answers: {} };
}

/** Changes when the server sends a different set of cards, so the page starts them afresh. */
export function cardsKey(questions: readonly Pick<IntakeQuestion, "id">[]): string {
  return questions.map((q) => q.id).join("|");
}

/** `carry`: "Or type your own answer…" sets it and the X clears it, so a closed deck knows whether its answers go along (`answersToCarry`). */
export type Deck = { key: string; state: CardState; closed: boolean; carry?: boolean };

/** The deck for the cards showing now: new cards start afresh, the same cards keep their picks. */
export function deckFor(prev: Deck, cards: readonly Pick<IntakeQuestion, "id">[]): Deck {
  const key = cardsKey(cards);
  return prev.key === key ? prev : { key, state: initialCards(), closed: false };
}

/** "Or type your own answer…": the deck folds away and what is answered on it goes with the typed words. */
export function typeInstead(deck: Deck): Deck {
  return { ...deck, closed: true, carry: true };
}

/** The X: the deck folds away and what is answered on it stays on the cards until new cards arrive; typed words go alone. */
export function closeDeck(deck: Deck): Deck {
  return { ...deck, closed: true, carry: false };
}

export function answerOf(state: CardState, q: Pick<IntakeQuestion, "id">): CardAnswer {
  return state.answers[q.id] ?? EMPTY_ANSWER;
}

function put(state: CardState, q: Pick<IntakeQuestion, "id">, a: CardAnswer): CardState {
  return { ...state, answers: { ...state.answers, [q.id]: a } };
}

/** One answer only: a single-choice card. */
export function picksOne(q: Pick<IntakeQuestion, "mode">): boolean {
  return q.mode === "single";
}

/** The line over the question: what kind of answer it takes. A card with nothing to pick takes typing. */
export function pickHint(q: Pick<IntakeQuestion, "mode"> & { options?: readonly unknown[] }): string {
  if (q.mode === "pay") return "Set the pay";
  if (q.mode === "free" || q.options?.length === 0) return "Type your answer";
  return picksOne(q) ? "Pick one" : "Pick any that apply";
}

/** Ticks or unticks an offered answer. On a pick-one card the new pick replaces the old one and any words typed as the answer. */
export function togglePick(state: CardState, q: Pick<IntakeQuestion, "id" | "mode">, value: string): CardState {
  const a = answerOf(state, q);
  const on = a.selected.includes(value);
  if (picksOne(q)) return put(state, q, { ...a, selected: on ? [] : [value], own: [], draft: "" });
  return put(state, q, { ...a, selected: on ? a.selected.filter((v) => v !== value) : [...a.selected, value] });
}

/** The words in the "Add your own…" box. On a pick-one card typing an answer clears the pick. */
export function setDraft(state: CardState, q: Pick<IntakeQuestion, "id" | "mode">, text: string): CardState {
  const a = answerOf(state, q);
  return put(state, q, { ...a, draft: text, selected: picksOne(q) && text.trim().length > 0 ? [] : a.selected });
}

/** Adds the typed words as one more answer on a pick-any card (Enter or the Add button); duplicates are ignored. */
export function addOwn(state: CardState, q: Pick<IntakeQuestion, "id">): CardState {
  const a = answerOf(state, q);
  const text = a.draft.trim();
  if (!text) return state;
  const own = a.own.some((x) => same(x, text)) ? a.own : [...a.own, text].slice(0, 6);
  return put(state, q, { ...a, own, draft: "" });
}

export function removeOwn(state: CardState, q: Pick<IntakeQuestion, "id">, text: string): CardState {
  const a = answerOf(state, q);
  return put(state, q, { ...a, own: a.own.filter((x) => x !== text) });
}

export function setPayForm(state: CardState, q: Pick<IntakeQuestion, "id">, pay: PayForm): CardState {
  return put(state, q, { ...answerOf(state, q), pay });
}

/** Moves to another card, staying inside the deck. */
export function goTo(state: CardState, index: number, total: number): CardState {
  return { ...state, index: Math.max(0, Math.min(index, Math.max(0, total - 1))) };
}

/** "Next" until the last card, where it sends every answer at once. */
export function nextLabel(index: number, total: number): "Next" | "Send" {
  return index >= total - 1 ? "Send" : "Next";
}

const skippedAnswer = (q: Pick<IntakeQuestion, "id">): IntakeAnswer => ({ questionId: q.id, selected: [], own: [], skipped: true });

/**
 * What one card sends (POST /intake/sessions/:id/answers). A card left alone is sent as skipped. Words still in the box
 * count as an answer. A card that takes no answers of the person's own sends none, except one that only takes typing.
 */
export function answerPayload(q: IntakeQuestion, a: CardAnswer): IntakeAnswer {
  if (q.mode === "pay") {
    const pay = a.pay ? payPayload(a.pay) : null;
    return pay ? { questionId: q.id, selected: [], own: [], skipped: false, pay } : skippedAnswer(q);
  }
  const typed = a.draft.trim().slice(0, 500);
  let own = picksOne(q) ? (typed ? [typed] : []) : [...a.own, ...(typed && !a.own.some((x) => same(x, typed)) ? [typed] : [])];
  if (!q.allowOwn && q.mode !== "free") own = [];
  const selected = a.selected.slice(0, 8);
  if (!selected.length && !own.length) return skippedAnswer(q);
  return { questionId: q.id, selected, own: own.slice(0, 6), skipped: false };
}

export function isAnswered(q: IntakeQuestion, a: CardAnswer): boolean {
  return !answerPayload(q, a).skipped;
}

/** Every card's answer, in the order the cards were asked. */
export function answersPayload(questions: readonly IntakeQuestion[], state: CardState): IntakeAnswer[] {
  return questions.map((q) => answerPayload(q, answerOf(state, q)));
}

/**
 * A pay card on the deck with figures typed that cannot be sent, as words and where it is, or null. Sending would count
 * it as skipped, so the figures would be gone with nothing to say why. Boxes left empty are a real skip.
 */
export function payCardProblem(questions: readonly IntakeQuestion[], state: CardState): { index: number; words: string } | null {
  for (const [index, q] of questions.entries()) {
    const form = q.mode === "pay" ? answerOf(state, q).pay : undefined;
    if (!form || ![form.min, form.max].some((v) => v.trim())) continue;
    const words = payProblem(form);
    if (words) return { index, words };
  }
  return null;
}

/** The picks as the one short message the conversation shows straight away; the server's own copy replaces it when the answer comes back. */
export function echoText(questions: readonly IntakeQuestion[], state: CardState): string {
  const lines: string[] = [];
  for (const q of questions) {
    const a = answerPayload(q, answerOf(state, q));
    if (a.skipped) continue;
    if (a.pay) {
      lines.push(`${FIELD_LABEL.compensation}: ${formatPayRange(a.pay)}`);
      continue;
    }
    const label = (v: string) => q.options.find((o) => o.value === v)?.label ?? v;
    const values = [...a.selected, ...a.own].map(label);
    lines.push(`${FIELD_LABEL[q.field]}: ${LIST_FIELDS.has(q.field) ? values.join("; ") : values[0]}`);
  }
  return lines.length ? lines.join("\n") : "Skipped those questions.";
}

/** The cards' answers without words still waiting for "Add" on a pick-any card. A pick-one or free card has no Add: its box is the answer. */
function addedOnly(questions: readonly IntakeQuestion[], state: CardState): CardState {
  const answers = { ...state.answers };
  for (const q of questions) {
    const a = answers[q.id];
    if (a && !picksOne(q) && q.mode !== "free") answers[q.id] = { ...a, draft: "" };
  }
  return { ...state, answers };
}

/**
 * What is answered on the cards when something else is about to be sent (typed words, "Write the job"): it goes along,
 * or the reply's new cards would lose it. Only the cards answered: one left alone is not skipped. A half-typed "Add your
 * own" word is not an answer yet. Nothing from a deck closed with the X. Null when nothing goes.
 */
export function answersToCarry(questions: readonly IntakeQuestion[], deck: Pick<Deck, "state" | "closed" | "carry">): { answers: IntakeAnswer[]; echo: string } | null {
  if (deck.closed && !deck.carry) return null;
  const state = addedOnly(questions, deck.state);
  const answered = questions.filter((q) => isAnswered(q, answerOf(state, q)));
  return answered.length ? { answers: answersPayload(answered, state), echo: echoText(answered, state) } : null;
}

/** Words typed in the message box, with what goes along. Null when nothing does, so the words go as a plain message. */
export function typedWithCards(questions: readonly IntakeQuestion[], deck: Pick<Deck, "state" | "closed" | "carry">, note: string): { answers: IntakeAnswer[]; note: string; echo: string } | null {
  const carried = answersToCarry(questions, deck);
  return carried ? { answers: carried.answers, note, echo: `${carried.echo}\n${note}` } : null;
}

/** The one line above the message box naming what goes with the words, so the person sees it before pressing Send. */
export function carriedLine(questions: readonly IntakeQuestion[], deck: Pick<Deck, "state" | "closed" | "carry">): string | null {
  const carried = answersToCarry(questions, deck);
  return carried ? `Sent with your message: ${carried.echo.replace(/\n+/g, " · ")}` : null;
}

/** Words the fairness check refused from an answer, as the page says them. */
export function refusedLines(refused: readonly Pick<IntakeRefusal, "text" | "reason" | "alternative">[]): string[] {
  return refused.map((r) => `Not used: "${r.text}". ${r.reason}${r.alternative ? ` ${r.alternative}` : ""}`);
}

/** The cards to show: the open ones of a draft still being built. */
export function cardsToShow(view: Pick<IntakeSessionView, "questions" | "status">): IntakeQuestion[] {
  return view.status === "active" ? view.questions : [];
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Pay                                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A figure as people type it: "$60,000", "60k", "45.50". NaN when there is none. */
export function parseAmount(text: string): number {
  const t = text.replace(/[$,\s]/g, "");
  if (!t) return Number.NaN;
  const k = /k$/i.test(t);
  const n = Number(k ? t.slice(0, -1) : t);
  return Number.isFinite(n) ? n * (k ? 1000 : 1) : Number.NaN;
}

const amountText = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

/** The pay card's boxes, filled from what the draft already says (a range read from an ad is shown, to be confirmed). */
export function payFormFrom(card: Pick<IntakePayCard, "basis" | "stated">): PayForm {
  return { basis: card.basis ?? "", min: amountText(card.stated.min), max: amountText(card.stated.max) };
}

/** The most the API takes for a pay figure. */
const PAY_LIMIT = 10_000_000;

/** The first thing wrong with the pay as typed, in plain words, or null when it can be set. */
export function payProblem(f: PayForm): string | null {
  if (!f.basis) return "Choose by the hour or a yearly salary.";
  const min = parseAmount(f.min);
  const max = parseAmount(f.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) return "Enter the lowest and the highest pay you will advertise.";
  if (min > max) return "The lowest pay must not be above the highest.";
  if (f.basis === "hourly" && max >= 1000) return "That looks like a yearly figure. Choose a yearly salary, or enter an hourly rate.";
  if (f.basis === "salary" && max < 1000) return "That looks like an hourly rate. Choose by the hour, or enter a yearly figure.";
  if (max > PAY_LIMIT) return "That figure is too high. Enter $10,000,000 or less.";
  return null;
}

/** The pay as it is sent, or null while it cannot be (see `payProblem`). */
export function payPayload(f: PayForm): { basis: "hourly" | "salary"; min: number; max: number } | null {
  if (payProblem(f) || !f.basis) return null;
  return { basis: f.basis, min: parseAmount(f.min), max: parseAmount(f.max) };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* What is known, and what the two main buttons wait for                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

export type ChecklistItem = { key: string; label: string; done: boolean; value: string | null; note: string | null };

/**
 * The essentials the server checks, in its words, as two lists. Pay counts as known only once a person has set or
 * confirmed it (`payConfirmed`): a range read from a pasted ad is listed as still needed, with the range, until then.
 */
export function essentialsList(r: Pick<IntakeReadiness, "essentials" | "payConfirmed">): { known: ChecklistItem[]; missing: ChecklistItem[]; complete: boolean } {
  const items: ChecklistItem[] = r.essentials.map((e) => {
    if (e.key === "compensation_range" && e.done && !r.payConfirmed) return { key: e.key, label: e.label, done: false, value: e.value, note: "Confirm it on the pay card." };
    return { key: e.key, label: e.label, done: e.done, value: e.value, note: null };
  });
  const missing = items.filter((i) => !i.done);
  return { known: items.filter((i) => i.done), missing, complete: missing.length === 0 };
}

/** What a main button of the builder shows: whether it may be pressed now, and each plain reason from the server when not. */
export type ButtonHelp = { ready: boolean; lines: string[] };

/** "Write the job": ready once every essential is in and a person set or confirmed the pay. */
export function writeHelp(r: Pick<IntakeReadiness, "mayDraft" | "draftBlocker">): ButtonHelp {
  return r.mayDraft ? { ready: true, lines: [] } : { ready: false, lines: [r.draftBlocker ?? "A few things are still needed."] };
}

/** "Publish job": ready when the server's checks pass, else every reason it gives. */
export function publishHelp(r: Pick<IntakeReadiness, "publish">): ButtonHelp {
  if (r.publish.allowed) return { ready: true, lines: [] };
  const lines = r.publish.blockers.map((b) => b.message);
  return { ready: false, lines: lines.length ? lines : ["A few things are still needed."] };
}

/** The title the draft has so far, or null ("Untitled job", in grey, until it is known). */
export function draftTitle(view: { facts: Pick<IntakeFacts, "title">; draft: Pick<DraftRolePacket, "identity"> | null }): string | null {
  return view.draft?.identity.title?.trim() || view.facts.title?.trim() || null;
}

/**
 * What "Write the job again" says before it replaces anything: the edits a person saved on the written job since, which
 * the new words would replace. Null when there is nothing to lose.
 */
export function redraftWarning(r: Pick<IntakeReadiness, "draftEdits">): string | null {
  if (!r.draftEdits) return null;
  return `Writing the job again replaces the ${r.draftEdits === 1 ? "edit" : `${r.draftEdits} edits`} you saved on it.`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Writing the job: the steps the server records                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/** One step per stage the server records while it writes the job, in order. */
export const DRAFT_STEP_LABELS = ["Writing the job", "Checking the wording and saving"] as const;

const STAGE_STEP: Record<IntakeProgressStage, number> = { writing: 0, checking: 1, done: 2, failed: 0 };

/**
 * The steps for the stage the server last recorded (`progress.stage` on the draft): "starting" before its first word,
 * when the first step shows as under way. A failed writing failed while the job was being written.
 */
export function draftSteps(stage: IntakeProgressStage | "starting" | null): Array<{ label: string; state: StepState }> {
  const at = stage === null || stage === "starting" ? 0 : STAGE_STEP[stage];
  return DRAFT_STEP_LABELS.map((label, i) => {
    if (stage === "failed") return { label, state: i < at ? "done" : i === at ? "failed" : "waiting" };
    if (stage === "done") return { label, state: "done" };
    return { label, state: i < at ? "done" : i === at ? "active" : "waiting" };
  });
}

const RUNNING: ReadonlySet<IntakeProgressStage> = new Set<IntakeProgressStage>(["writing", "checking"]);

/** Whether the job is being written right now (say, someone reloaded the page mid-way): recent, and not done or failed. */
export function draftingNow(progress: IntakeSessionView["progress"], now = Date.now()): boolean {
  return !!progress && RUNNING.has(progress.stage) && now - Date.parse(progress.at) < 180_000;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The message box                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Whether a key press sends the message: Enter at a desk; Shift+Enter is a new line; on a touch screen Enter is always a
 * new line and the button sends; a key that finishes an accented letter or a word in an input method never sends.
 */
export function enterSends(e: { key: string; shiftKey: boolean; isComposing?: boolean }, touch: boolean): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && !touch;
}

/** What the box says before anything is typed: an example of a first sentence, then what the box is for. */
export function composerPlaceholder(started: boolean): string {
  return started ? "Answer here, or add anything about the job" : "For example: a dental assistant for our Irvine office, full time, $24 to $28 an hour";
}

/** The first message may be a whole job ad (20,000 characters); every later one is a turn (4,000). */
export function messageLimit(first: boolean): number {
  return first ? INTAKE_FIRST_MESSAGE_MAX : INTAKE_MESSAGE_MAX;
}

/** Said before sending, instead of a refusal after: too long for one message, with the limit. */
export function messageProblem(text: string, first: boolean): string | null {
  const max = messageLimit(first);
  if (text.trim().length <= max) return null;
  return `That is too long to send in one go: up to ${max.toLocaleString("en-US")} characters${first ? "" : " after the first message"}. Shorten it, or send it in parts.`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Turns that fail                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What the page says and offers when something stops: the words, and the request about the plan to offer with them. */
export type Problem = { message: string; ask: { label: string; reason: string } | null };

/**
 * A turn the assistant could not take: what to say, and the server's own request to offer when the plan's AI help is
 * what ran out (never "try again" then). The model's own error text is never shown; it means nothing to the person.
 */
export function turnProblem(reply: IntakeTurnReply | null | undefined): Problem | null {
  if (!reply || !("error" in reply)) return null;
  if (reply.upgrade) return { message: reply.recovery, ask: reply.ask };
  return { message: `The assistant could not reply just now. ${reply.recovery}`, ask: null };
}

/** The assistant's words of a turn, or null for a turn that failed. */
export function replyWords(reply: IntakeTurnReply | null | undefined): string | null {
  return reply && "assistantMessage" in reply ? reply.assistantMessage : null;
}
