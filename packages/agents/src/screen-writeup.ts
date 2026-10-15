import type { ScreenTranscriptEntry, ScreenWriteup, WriteupAnswer, WrittenQuestionView } from "@ros/contracts";
import type { WriteupModelOutput } from "@ros/ai";
import { unfairQuestion } from "./screen-focus";
import { EMPTY_SCREEN_PROGRESS, candidateWordsOf, redactProtected, saidByCandidate } from "./screening";

/**
 * The write-up on Review & send (Wave S7, slice S7-D; contract in scratchpad kanvis-2/s7-contracts.md, section 2c): one
 * answer per written question in the candidate's own words, with a separate "Note from the assistant" only when
 * something is missing. The model drafts it (`screen.writeup`, packages/ai/src/prompts/writeup.ts) and this file holds
 * it to the rules in code, so what the candidate checks, and the team later reads, is never more than they said:
 * - every quote is found in the candidate's own sent messages (`saidByCandidate`), or dropped;
 * - an answer must rest on a quote (or be their words as they are), use their content words and numbers, speak in
 *   their voice (never "the candidate said"), and carry no note inside it; otherwise their own words stand in for it;
 * - a reply that was a plain "no" or "I haven't" stays a no: an answer that lost the no is replaced by their words;
 * - a reply on record is never lost: the model saying "not given" where the chat holds one gives their words instead;
 * - a skip on record is "skipped", and a note never names a protected trait (`unfairQuestion`);
 * - an answer with a sentence about a protected trait gives their words with that sentence left out (`redactProtected`,
 *   as recorded answers do).
 * Without the model (an outage, an invalid reply) the same rules give the "code draft": their own replies to each
 * question, as they wrote them. The fake provider writes that draft too (fake-writeup.ts).
 */

/** The parts of a transcript entry the write-up reads. */
export type WriteupEntry = Pick<ScreenTranscriptEntry, "role" | "content" | "questionKey" | "source">;
type ModelAnswer = WriteupModelOutput["answers"][number];

/** The note when the chat holds no answer at all, and when the answer covers only part of the question. */
export const WRITEUP_NOT_GIVEN_NOTE = "No answer to this question was given in the chat.";
export const WRITEUP_PARTLY_NOTE = "Part of this question was not answered in the chat.";

const MAX_ANSWER = 2000;
const MAX_QUOTE = 500;
const MAX_QUOTES = 6;

/**
 * What the candidate said about each question, from the transcript: a reply belongs to the question the assistant last
 * asked (an assistant line with one of `keys`), or to the question its own record names (a tapped or changed answer);
 * an answer changed on the check page replaces what came before. Skips on record are listed too. A recruiter's notes
 * are never the candidate's words.
 */
export function writeupSegments(transcript: ReadonlyArray<WriteupEntry>, keys: ReadonlySet<string>): { said: Map<string, string[]>; skipped: Set<string> } {
  const said = new Map<string, string[]>();
  const skipped = new Set<string>();
  let current: string | null = null;
  for (const t of transcript) {
    if (t.role === "recruiter" || t.source === "recruiter_call") continue;
    if (t.role === "assistant") {
      if (t.questionKey && keys.has(t.questionKey)) current = t.questionKey;
      continue;
    }
    if (t.role === "system") {
      if (t.source === "skip" && t.questionKey) skipped.add(t.questionKey);
      continue;
    }
    const key = t.questionKey && keys.has(t.questionKey) ? t.questionKey : current;
    const words = t.content.trim();
    if (!key || !words) continue;
    if (t.source === "edit") {
      said.set(key, [words]);
      skipped.delete(key);
      continue;
    }
    said.set(key, [...(said.get(key) ?? []), words]);
  }
  return { said, skipped };
}

/** Their replies to one question as one answer, as they wrote them, cut at a sentence end when very long. */
function joinedWords(own: readonly string[]): string {
  const all = own.join(" ").replace(/\s+/g, " ").trim();
  if (all.length <= MAX_ANSWER) return all;
  const cut = all.slice(0, MAX_ANSWER);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > MAX_ANSWER / 2 ? cut.slice(0, end + 1) : cut;
}

/** Pieces of their own messages, each one found as it is (a long one cut, which keeps it a piece of what they sent). */
function ownQuotes(own: readonly string[]): string[] {
  return own.map((m) => m.replace(/\s+/g, " ").trim().slice(0, MAX_QUOTE).trim()).filter((q) => q && redactProtected(q) === q).slice(0, MAX_QUOTES);
}

/**
 * The code draft, shaped as the model's answer: for each question the candidate's own replies as they wrote them, or
 * nothing with the "not given" note (none for a skipped question). What the fake provider returns, and what stands in
 * for the model when it cannot answer.
 */
export function draftWriteup(questions: ReadonlyArray<Pick<WrittenQuestionView, "key">>, transcript: ReadonlyArray<WriteupEntry>, skipped: readonly string[] = []): WriteupModelOutput {
  const segs = writeupSegments(transcript, new Set(questions.map((q) => q.key)));
  const skips = new Set([...skipped, ...segs.skipped]);
  return {
    answers: questions.map((q): ModelAnswer => {
      const own = segs.said.get(q.key) ?? [];
      if (own.length) return { questionKey: q.key, answer: redactProtected(joinedWords(own)), status: "answered", quotes: ownQuotes(own), note: null };
      return { questionKey: q.key, answer: "", status: "not_given", quotes: [], note: skips.has(q.key) ? null : WRITEUP_NOT_GIVEN_NOTE };
    }),
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The checks                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/** Words that say nothing about what the candidate did: a condensed answer may add or drop them freely. */
const PLAIN = new Set([
  "about", "after", "again", "also", "always", "because", "been", "before", "being", "both", "could", "does", "doing", "done", "during", "each", "even", "every", "example", "experience", "from", "have", "having", "here", "into", "just", "kind", "like", "made", "make", "many", "more", "most", "much", "myself", "need", "only", "other", "over", "really", "same", "should", "since", "some", "something", "such", "than", "that", "their", "them", "then", "there", "these", "they", "thing", "things", "this", "those", "through", "time", "times", "very", "want", "were", "what", "when", "where", "which", "while", "will", "with", "within", "without", "would", "your", "yours", "year", "years", "work", "worked", "working", "role", "used", "using", "well", "once", "still", "able", "around", "went", "came", "think", "know", "sure", "yes", "yeah",
]);

const wordsOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const stem = (w: string): string => (w.length >= 6 ? w.slice(0, 5) : w);

/**
 * Whether an answer stays within what the candidate wrote: every number in it is one they wrote, and at least four in
 * five of its content words (four letters or more, not a plain word) are theirs, or share a stem with one of theirs
 * ("managed" and "manage"). A light condensation passes; a new skill, tool, place or number does not.
 */
export function groundedIn(answer: string, candidateText: string): boolean {
  const theirs = wordsOf(candidateText);
  const exact = new Set(theirs);
  const stems = new Set(theirs.map(stem));
  const numbers = new Set(theirs.filter((w) => /\d/.test(w)));
  const words = wordsOf(answer);
  if (words.some((w) => /\d/.test(w) && !numbers.has(w))) return false;
  const content = words.filter((w) => w.length >= 4 && !/\d/.test(w) && !PLAIN.has(w));
  if (!content.length) return true;
  const found = content.filter((w) => exact.has(w) || stems.has(stem(w))).length;
  return found / content.length >= 0.8;
}

/** An answer written about the candidate rather than in their voice, or with a note written into it. */
const NOT_THEIR_VOICE = /\b(the candidate|the applicant|candidate's|applicant's|(he|she|they) (said|stated|mentioned|explained|described|noted|reported|indicated)|note from the assistant)\b|(?:^|[.!?)]\s*)note\s*:|\(note\b/i;

/** Whether an answer is written about the candidate ("the candidate said") or has a note written into it ("Note: ..."). */
export function notTheirVoice(answer: string): boolean {
  return NOT_THEIR_VOICE.test(answer);
}

/** Whether an answer keeps a no a no ("No", "not", "never", "haven't"). */
export function keepsNo(answer: string): boolean {
  return NEGATION.test(answer);
}

/** A reply that is a plain no and nothing more: "No", "Not yet", "I haven't", "I've never done that". */
const NEGATIVE_START = /^\s*(no|nope|not (yet|really|that i know)|never|none|nothing|i\s*(['’]ve never|['’]m not|have not|haven['’]?t|have never|never|do not|don['’]?t|did not|didn['’]?t|am not|can['’]?t|cannot))\b/i;
/** Any word that keeps a no a no. */
const NEGATION = /\b(no|not|never|none|nothing|cannot)\b|n['’]t\b/i;

/** A word that says no: "no", "not", "never", "none", "nothing", "cannot", "without", or any "…n't". */
const isNegation = (w: string): boolean => /^(no|not|never|none|nothing|cannot|without)$/.test(w) || /n['’]t$/.test(w);
const tokensOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}'’]+/gu) ?? [];
/** How far a no reaches: the words within this many after it are what it says no to. */
const NEGATION_REACH = 4;

/**
 * Whether an answer keeps every no the candidate said, even inside a reply that also says something positive ("I led a
 * team once, but I have never managed a budget"; "Not Dentrix itself, I used Eaglesoft"): each content word that came
 * within four words after a no in their reply must, if the answer uses it, have a no within the four words before it.
 * A light condensation that keeps the no, or leaves out what the no was about, passes; one that turns it into a yes
 * does not. (Counting the noes as well was tried and left out: a long reply's passing "not that it matters" would then
 * refuse every honest condensation of it.)
 */
export function keepsNegations(answer: string, candidateReply: string): boolean {
  const said = tokensOf(candidateReply);
  const negated = new Set<string>();
  for (let i = 0; i < said.length; i++) {
    if (!isNegation(said[i])) continue;
    for (const next of said.slice(i + 1, i + 1 + NEGATION_REACH)) {
      if (next.length >= 4 && !PLAIN.has(next) && !isNegation(next) && !/\d/.test(next)) negated.add(stem(next));
    }
  }
  if (!negated.size) return true;
  const words = tokensOf(answer);
  return words.every((w, j) => !negated.has(stem(w)) || words.slice(Math.max(0, j - NEGATION_REACH), j).some(isNegation));
}

export function plainNo(reply: string): boolean {
  const words = wordsOf(reply);
  return NEGATIVE_START.test(reply) && words.length <= 12 && !/\bbut\b/i.test(reply);
}

/** A note as the candidate may read it: one short line, null when empty or when it touches a protected trait. */
function noteOf(note: string | null | undefined): string | null {
  const text = (note ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text || unfairQuestion(text)) return null;
  return text;
}

/**
 * The model's write-up held to the rules (see the top of this file), one answer per question in order. `output` null:
 * the model gave nothing usable, and the code draft is used. `declined`: the skips on record (`progress.declined`).
 * `meta`: when it was written and by which run (null for the code draft).
 */
export function settleWriteup(
  output: WriteupModelOutput | null,
  input: { questions: ReadonlyArray<Pick<WrittenQuestionView, "key">>; transcript: ReadonlyArray<WriteupEntry>; declined?: readonly string[] },
  meta: { at: string; aiRunId: string | null; promptVersion: number | null },
): ScreenWriteup {
  const keys = new Set(input.questions.map((q) => q.key));
  const segs = writeupSegments(input.transcript, keys);
  const said = candidateWordsOf({ transcript: input.transcript.map((t) => ({ ...t, at: "" })), answers: {}, progress: EMPTY_SCREEN_PROGRESS });
  const skips = new Set([...(input.declined ?? []), ...segs.skipped]);
  const draft = draftWriteup(input.questions, input.transcript, [...skips]);
  const answers = input.questions.map((q, i): WriteupAnswer => {
    const own = segs.said.get(q.key) ?? [];
    const fallback = { ...draft.answers[i], by: "writeup" as const };
    if (!own.length && skips.has(q.key)) return { questionKey: q.key, answer: "", status: "skipped", quotes: [], note: null, by: "writeup" };
    const m = output?.answers.find((a) => a.questionKey === q.key);
    if (!m) return fallback;
    const quotes = [...new Set(m.quotes.map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x && saidByCandidate(x, said) && redactProtected(x) === x))].slice(0, MAX_QUOTES);
    const answer = m.answer.replace(/[ \t]+/g, " ").trim();
    // nothing given: their reply on record wins over the model's "not given"
    if (m.status === "not_given" || !answer) return own.length ? fallback : { questionKey: q.key, answer: "", status: "not_given", quotes: [], note: noteOf(m.note) ?? WRITEUP_NOT_GIVEN_NOTE, by: "writeup" };
    const note = m.status === "partly" ? noteOf(m.note) ?? WRITEUP_PARTLY_NOTE : null;
    // a sentence about a protected trait: their own words, with that sentence left out as recorded answers do, instead
    const sound =
      redactProtected(answer) === answer &&
      (quotes.length > 0 || saidByCandidate(answer, said)) &&
      groundedIn(answer, said) &&
      !NOT_THEIR_VOICE.test(answer) &&
      !(note && answer.toLowerCase().includes(note.toLowerCase())) &&
      !(own.length && plainNo(own.join(" ")) && !NEGATION.test(answer)) &&
      // a no inside a longer reply stays a no: never "managed a budget" from "never managed a budget"
      (!own.length || keepsNegations(answer, own.join(" ")));
    if (!sound) return own.length ? fallback : { questionKey: q.key, answer: "", status: "not_given", quotes: [], note: WRITEUP_NOT_GIVEN_NOTE, by: "writeup" };
    return { questionKey: q.key, answer, status: m.status, quotes, note, by: "writeup" };
  });
  return { v: 1, writtenAt: meta.at, aiRunId: meta.aiRunId, promptVersion: meta.promptVersion, answers };
}

/**
 * The candidate changed one written-up answer on Review & send: `answer` is what they saved (as the answer is recorded),
 * theirs from now on. The assistant's note goes (it was about what the chat had not given, and they have now answered),
 * and the quotes it rested on stay.
 */
export function withWrittenAnswer(writeup: ScreenWriteup, questionKey: string, answer: string, at: string): ScreenWriteup {
  return {
    ...writeup,
    answers: writeup.answers.map((a): WriteupAnswer => (a.questionKey === questionKey ? { ...a, answer, status: answer.trim() ? "answered" : a.status, note: answer.trim() ? null : a.note, by: "candidate", editedAt: at } : a)),
  };
}

/** "N of M answered" on Review & send: answers with words in them (a partly answered one counts), of every question. */
export function writeupCounts(writeup: Pick<ScreenWriteup, "answers">): { answered: number; total: number } {
  return { answered: writeup.answers.filter((a) => a.answer.trim() && a.status !== "skipped" && a.status !== "not_given").length, total: writeup.answers.length };
}
