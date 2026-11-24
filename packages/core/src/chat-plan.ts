import { CHAT_WRAP_KEY, type ChatCounter, type ChatItem, type ChatPlan, type ChatReading, type ChatSection, type RolePacket, type ScreeningQuestion, type ScreenProgress, type TapAnswer, type TapFormat } from "@ros/contracts";

/**
 * The AI interview's plan and its tap answers: which items the chat must close and in what order, what the chat does
 * next with the item being asked, which questions can be answered by tapping, and the words a tap is recorded as. Pure
 * rules: no model and no database here.
 */

/** At most this many must-haves the CV reading did not find shown are asked about. */
export const CHAT_GAP_LIMIT = 4;

/**
 * The plan when the chat starts, fixed in code (the model never writes it): the job's interview questions in the job's
 * order, then the must-haves the CV reading did not find shown (`gaps`, at most `CHAT_GAP_LIMIT`). The closing question
 * is asked after every item and is never one of them.
 */
export function buildChatPlan(input: { questions: readonly string[]; gaps: readonly string[]; at: string }): ChatPlan {
  const seen = new Set<string>([CHAT_WRAP_KEY]);
  const items: ChatItem[] = [];
  for (const key of input.questions) {
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, kind: "question", required: true, state: "open", step: "direct", pushes: 0 });
  }
  let gaps = 0;
  for (const key of input.gaps) {
    if (seen.has(key) || gaps >= CHAT_GAP_LIMIT) continue;
    seen.add(key);
    gaps += 1;
    items.push({ key, kind: "gap", required: false, state: "open", step: "direct", pushes: 0 });
  }
  return { v: 1, section: sectionOf(items[0] ?? null), items, current: null, builtAt: input.at };
}

/** The section an item belongs to; with no item, the close. */
function sectionOf(item: Pick<ChatItem, "kind"> | null): ChatSection {
  return !item ? "wrapping_up" : item.kind === "gap" ? "experience" : "required";
}

/** An item that needs nothing more: covered, settled as not known, or skipped. */
export function chatItemSettled(item: Pick<ChatItem, "state">): boolean {
  return item.state === "covered" || item.state === "unknown" || item.state === "skipped";
}

/**
 * What the chat does next with the item being asked, from how the latest reply reads (`ChatReading`). A concrete reply
 * covers it, and so does any reply to an item with no ladder (`ladder` false): a yes-or-no question, or a must-have that
 * names a licence, certificate, permit or registration, which is held or is not (which items those are is decided by
 * `ladderApplies` in packages/agents/src/screening.ts). A vague one gets one push for specifics, then counts as covered
 * (the team reads the words). "No" / "I haven't" climbs the ladder: the analog ("not done that? something similar from
 * your own work"), then, for a gap, the smaller version ("even a small moment?"), then the item is settled as not
 * known: never a "no" for a skill, and never read as one.
 */
export type ChatMove = "push" | "analog" | "smaller" | "covered" | "unknown";
export function chatNextMove(item: Pick<ChatItem, "kind" | "step" | "pushes">, reading: ChatReading, ladder: boolean): ChatMove {
  // An item with no ladder (a yes-or-no question, a licence the job needs) takes its answer as it is: "No", or a bare "Yes".
  if (reading === "concrete" || !ladder) return "covered";
  if (reading === "vague") return item.pushes < 1 ? "push" : "covered";
  if (item.step === "direct") return "analog";
  if (item.step === "analog" && item.kind === "gap") return "smaller";
  return "unknown";
}

/** Whether a move keeps asking about the same item (a follow-up) rather than moving on. */
export function chatMoveStays(move: ChatMove): boolean {
  return move === "push" || move === "analog" || move === "smaller";
}

const NOT_DONE = /^(?:no|nope|nah|not really|not yet|never|none|i haven['’]?t|i have not|i have never|i['’]?ve never|i don['’]?t|i do not|i didn['’]?t|i did not)\b[^.!?]{0,40}[.!]?$/i;
/** Words that turn a "no" into an answer ("No, but at my last job I…"). */
const BUT = /\b(?:but|however|though|although|similar|instead|except|once|when)\b/i;

/** A plain "No" / "I haven't" (short, and nothing more): the reply that climbs the ladder, whatever the model read. */
export function saysNotDone(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return t.length > 0 && t.length <= 60 && NOT_DONE.test(t) && !BUT.test(t);
}

/**
 * The plan after a turn, kept in step with the progress the code already keeps: the item being asked is `asking`; one
 * asked and passed is `covered` (or stays `unknown` when the ladder settled it so); a skipped one is `skipped`; the rest
 * are `open`. `move`: the step the turn took on the item it was about (a push, the analog, the smaller version, or
 * settling it). The section follows the item being asked; once every item is settled, or on the closing question, it
 * is "Wrapping up".
 */
export function syncChatPlan(plan: ChatPlan, progress: Pick<ScreenProgress, "askedKeys" | "currentQuestionKey" | "declined">, move?: { key: string; move: ChatMove } | null): ChatPlan {
  const asked = new Set(progress.askedKeys);
  const declined = new Set(progress.declined ?? []);
  const current = progress.currentQuestionKey;
  const items = plan.items.map((item): ChatItem => {
    let next: ChatItem = item;
    if (move && move.key === item.key) {
      if (move.move === "push") next = { ...next, pushes: 1 };
      else if (move.move === "analog") next = { ...next, step: "analog" };
      else if (move.move === "smaller") next = { ...next, step: "smaller" };
      else if (move.move === "unknown") next = { ...next, state: "unknown" };
      else next = { ...next, state: "covered" };
    }
    if (declined.has(item.key)) return { ...next, state: "skipped" };
    if (current === item.key) return { ...next, state: next.state === "unknown" ? "unknown" : "asking" };
    if (asked.has(item.key)) return { ...next, state: next.state === "unknown" ? "unknown" : "covered" };
    return { ...next, state: next.state === "unknown" ? "unknown" : "open" };
  });
  // An item settled as not known while it is still the current question (the move came with this turn) stays so.
  const at = items.find((i) => i.key === current) ?? null;
  const section: ChatSection = at ? sectionOf(at) : current === CHAT_WRAP_KEY || items.every(chatItemSettled) ? "wrapping_up" : sectionOf(items.find((i) => !chatItemSettled(i)) ?? null);
  return { ...plan, items, section, current: at ? at.key : null };
}

/**
 * The one line above the chat: which question is being asked, of how many the chat asks ("Question 2 of 6"), and "All 6
 * questions done" once every one is closed (answered, settled as not known, or skipped) and only the closing question
 * is left. Every item of the plan counts, the job's interview questions and the must-haves asked about alike; the
 * closing question never does. Null before the chat has a plan.
 */
export function chatCounter(plan: ChatPlan | null | undefined): ChatCounter | null {
  if (!plan) return null;
  const total = plan.items.length;
  const done = plan.items.filter(chatItemSettled).length;
  const label = done < total ? `Question ${done + 1} of ${total}` : total > 1 ? `All ${total} questions done` : total === 1 ? "All questions done" : "One question";
  return { done, total, label };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Tap answers                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

export const WEEK_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

const YES_NO = /^(do|does|are|is|can|could|will|would|have|has|did)\b/i;
const OPEN_ENDED = /\b(what|which|when|how|why|where|who|whose|whether|tell (?:me|us)|describe|walk (?:me|us)|explain|list|share)\b/i;
/**
 * A relative clause that only places a noun, after in, at, on, to, near or within ("in the state where this office is
 * located", "to the office where you would work"): it says which state or office is meant and asks nothing open. The
 * preposition, a determiner, one or two words of the noun (never "and", "or" or a preposition: "a preference for which
 * days" asks which), then where, when, which, who, whom or whose. Without the preposition the clause is what the question
 * asks ("Can you confirm the state where you are licensed?", "Are there any days when you cannot work?"), so it stays and
 * the question is typed. It runs to a comma, a semicolon, the question mark or an "and", "or" or "but", so a second
 * question after it ("…, and which number is it?") is still read.
 */
const RELATIVE_CLAUSE = /\b(?:in|at|on|to|near|within)\s+(?:the|a|an|any|this|that|these|those|your|our|their|its|each|every)\s+(?:(?!(?:and|or|but|nor|of|in|on|at|to|for|from|with|by|about|as|than|if|whether)\b)[\w-]+\s+){1,2}(?:where|when|which|who|whom|whose)\b.*?(?=[,;?]|\s(?:and|or|but)\b|$)/gi;
const START = /\b(start|begin|starting|earliest)\b/i;
const DAYS = /\b(days?|weekends?|weekdays?|which shifts?|schedule)\b/i;
/** The kinds of a question about a fact: the ones that can offer Yes and No, and whose "No" is an answer, never followed up. */
const FACTUAL_KINDS: ReadonlyArray<ScreeningQuestion["kind"]> = ["availability", "logistics", "eligibility"];

/**
 * Whether a question's own words can only be answered yes or no: it starts "Do you", "Are you", "Can you"… and asks
 * nothing open after that (`OPEN_ENDED`, less a clause that only places a noun: `RELATIVE_CLAUSE`). The one test for it:
 * the Yes and No buttons go by it (`tapFormatFor`), and so does the kind of a question a person writes in the job editor
 * (`screeningKindFor`).
 */
export function asksYesOrNo(question: string): boolean {
  const text = question.trim();
  return YES_NO.test(text) && !OPEN_ENDED.test(text.replace(/^\S+\s/, "").replace(RELATIVE_CLAUSE, " "));
}

/**
 * The tap answer a question offers, or null for a free answer only. Worked out from the question's kind and its wording:
 * pay questions take a range; "when could you start" a date; "which days" the days of the week; a factual question
 * (eligibility, availability, logistics) that can only be answered yes or no, because it starts "Do you", "Are you",
 * "Can you"… and asks nothing open, two buttons. Its kind alone never makes it one: "Which certifications do you hold…?"
 * asks them to list, so it is typed, and so is one that asks "whether" beside something else ("Can you confirm your RDH
 * license state and whether it is currently active?"), which a bare Yes does not answer. A relative clause that only
 * places a noun after in, at, on, to, near or within asks nothing open (`RELATIVE_CLAUSE`): "Do you hold an active RDA
 * license in the state where this office is located?" keeps its buttons, while "Can you confirm the state where you are
 * licensed?" asks which state and is typed. Skills, examples and motivation are always typed: they need the candidate's
 * own words.
 */
export function tapFormatFor(question: Pick<ScreeningQuestion, "kind" | "question">, compensation: Pick<RolePacket["compensation"], "basis" | "currency">): TapFormat | null {
  const text = question.question.trim();
  if (question.kind === "compensation") return { kind: "pay_range", basis: compensation.basis, currency: compensation.currency || "USD" };
  if (!FACTUAL_KINDS.includes(question.kind)) return null;
  const asksStart = START.test(text) && /\b(when|date|how soon|earliest)\b/i.test(text);
  const asksDays = question.kind === "availability" && DAYS.test(text) && /\b(which|what)\b/i.test(text);
  // A question that asks two things ("which days, and when could you start?") is answered in the candidate's own words.
  if (asksStart && asksDays) return null;
  if (asksStart) return { kind: "start_date" };
  if (asksDays) return { kind: "days", options: [...WEEK_DAYS] };
  return asksYesOrNo(text) ? { kind: "yes_no" } : null;
}

/**
 * A request for their own words that only opens like a yes-or-no question ("Can you give an example of a time…?",
 * "Could you talk us through…?"): a "Yes" would answer none of it, so it is an open question (`screeningKindFor`).
 */
const ASKS_FOR_AN_ACCOUNT = /\bgive (?:(?:me|us) )?(?:(?:an?|one|some|two|a few) )?(?:\w+ )?examples?\b|\btalk (?:(?:me|us) through|about)\b|\bsay more\b/i;
/** Words of a question about the pay someone is looking for: a pay question that is reworded keeps its pay-range answer only while it has one of them. */
const ABOUT_PAY = /\b(?:pay|paid|salary|salaries|wages?|compensation|hourly|rate|range|earn(?:ings?)?|income)\b|\$/i;

/**
 * The kind of an AI interview question whose words a person wrote or changed in the job editor, which shows no kind and
 * sets none. The kind decides what the chat does with the question: the tap answer it offers (`tapFormatFor`), and
 * whether a bare "No" or a vague reply is followed up (an open question, "skills" or "behavioral") or is its answer
 * (`ladderApplies` in packages/agents/src/screening.ts). So the kind follows the words, with the kind the question had
 * (`was`; none for a new question):
 * - words that can only be answered yes or no (`asksYesOrNo`, and no request for an account: `ASKS_FOR_AN_ACCOUNT`) make
 *   it a question about a fact: the kind it had when that was one of those (availability, logistics, eligibility),
 *   "eligibility" otherwise. It gets Yes and No, and "No" is its answer: "Can you work Saturdays?" is never followed by
 *   "tell me about something similar";
 * - any other words leave it the kind it had, and make a new question "skills", the open kind. Nothing in an open
 *   question's words tells one about a fact ("Which certifications do you hold?") from one about a skill, so the words
 *   alone never take a kind away. The one exception is a pay question, whose answer is a pay range whatever its words:
 *   it keeps that kind only while its words still speak of pay (`ABOUT_PAY`), and is an open question otherwise.
 */
export function screeningKindFor(question: string, was?: ScreeningQuestion["kind"]): ScreeningQuestion["kind"] {
  if (asksYesOrNo(question) && !ASKS_FOR_AN_ACCOUNT.test(question)) return was && FACTUAL_KINDS.includes(was) ? was : "eligibility";
  if (was === "compensation" && !ABOUT_PAY.test(question)) return "skills";
  return was ?? "skills";
}

function money(n: number, currency: string): string {
  const whole = Number.isInteger(n);
  const s = n.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return currency === "USD" ? `$${s}` : `${s} ${currency}`;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * The words a tap is recorded as: the candidate's answer, verbatim in the transcript and in the answers, so the
 * scorecard quotes it like anything they typed. Null when the tap does not fit the question (a stale page, a forged post).
 */
export function tapAnswerText(format: TapFormat, answer: TapAnswer, now: Date = new Date()): string | null {
  if (format.kind !== answer.kind) return null;
  switch (answer.kind) {
    case "yes_no":
      return answer.choice === "yes" ? "Yes" : "No";
    case "days": {
      const picked = WEEK_DAYS.filter((d) => answer.days.some((x) => x.toLowerCase() === d.toLowerCase()));
      return picked.length ? `I can work ${joinWords([...picked])}.` : null;
    }
    case "start_date": {
      const t = Date.parse(`${answer.date}T12:00:00Z`);
      if (Number.isNaN(t) || t < now.getTime() - 2 * 86_400_000 || t > now.getTime() + 2 * 365 * 86_400_000) return null;
      return `I can start on ${new Date(t).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" })}.`;
    }
    case "pay_range": {
      if (format.kind !== "pay_range") return null;
      const per = format.basis === "hourly" ? "an hour" : "a year";
      if (answer.max !== undefined && answer.max < answer.min) return null;
      return answer.max !== undefined && answer.max !== answer.min ? `I'm looking for ${money(answer.min, format.currency)} to ${money(answer.max, format.currency)} ${per}.` : `I'm looking for ${money(answer.min, format.currency)} ${per}.`;
    }
  }
}

/** The tap shapes `tapAnswerText` writes in the candidate's voice, and the same in the assistant's. */
const TAP_ECHO: ReadonlyArray<[RegExp, (rest: string) => string]> = [
  [/^I'm looking for (.+)$/, (rest) => rest],
  [/^I can start on (.+)$/, (rest) => `you could start on ${rest}`],
  [/^I can work (.+)$/, (rest) => `you can work ${rest}`],
];
const FIRST_PERSON = /\b(?:I|I'm|I've|I'd|I'll|me|my|mine|myself)\b/i;

/**
 * A tap said back in the chat's "Noted: …" line, in the assistant's voice: the bare value for pay ("$18 to $20 an
 * hour"), "you could start on Monday, November 16, 2026", "you can work Monday and Friday", and "Yes" or "No" as they
 * are. The recorded answer stays the candidate's own sentence. Null for words of any other shape that speak in the first
 * person, so the line says only "Noted." rather than say their "I" back to them.
 */
export function tapEcho(words: string): string | null {
  const w = words.trim().replace(/[.!?]+$/, "");
  if (!w) return null;
  for (const [shape, said] of TAP_ECHO) {
    const m = shape.exec(w);
    if (m) return said(m[1]);
  }
  return FIRST_PERSON.test(w) ? null : w;
}
