import type { EvidenceAssessment, RolePacket, ScreenProgress } from "@ros/contracts";
import { PROXY_RULES, screenAnswersOf } from "@ros/core";

/**
 * "Ask about this in a screen" (docs/spec/21 section 7, P1): the owner turns the résumé assessment's open questions
 * into the first questions of a screen. The questions are fixed on the screen when it is created
 * (`screens.progress.focusQuestions`, keys `unknown_1`, `unknown_2`, ...) and put in front of the packet's own
 * screening questions wherever the conversation reads the packet, so the prompt, the fake handler, the turn rules and
 * the scorecard treat them as ordinary questions. Their answers are recorded beside the question they answer, not in
 * `screens.answers`; the candidate page's "x of N answered" counts them through `answersOf` and `focusedPacket`, and
 * every reader, the access export and the anonymization go through `screenAnswersOf` / `withoutFocusAnswers` in @ros/core.
 */

export type FocusQuestion = NonNullable<ScreenProgress["focusQuestions"]>[number];

export const FOCUS_KEY_PREFIX = "unknown_";
const MAX_FOCUS_QUESTIONS = 4;

/** The sentence the invitation email and the opening message carry when a screen starts with the open questions. */
export const FOCUS_INTRO = "We will start with a few quick questions about your background, then the usual screening questions.";

export function isFocusKey(key: string | null | undefined): boolean {
  return !!key && key.startsWith(FOCUS_KEY_PREFIX);
}

/**
 * The open questions a screen starts with: the reading's own words, so each one passes the code's fairness check first
 * (`unfairQuestion`); one that touches a protected trait is never asked (known bug 29). The keys follow the questions kept.
 */
export function focusQuestionsFrom(unknowns: EvidenceAssessment["unknowns"]): FocusQuestion[] {
  return unknowns.filter((u) => !unfairQuestion(u.question)).slice(0, MAX_FOCUS_QUESTIONS).map((u, i) => ({ key: `${FOCUS_KEY_PREFIX}${i + 1}`, question: u.question, whyItMatters: u.whyItMatters }));
}

/**
 * Questions about a protected characteristic, or one that stands for it, in the words a question would use: age and
 * birth, family, pregnancy, religion, health and disability, origin and citizenship, marriage, sex and orientation,
 * graduation year, criminal history, workers' compensation claims. Work authorisation is asked in the packet's own words
 * and is not matched here. Health, medication and medical history count only as "your" (the candidate's): in a dental
 * chat "their medical history" is the patients'.
 */
const PROTECTED_QUESTION = new RegExp(
  [
    String.raw`\bhow old\b`,
    String.raw`\b(?:your|their) (?:age|birthday|date of birth|religion|faith|church|nationality|ethnicity|race|accent|native language|first language|mother tongue|husband|wife|spouse|boyfriend|girlfriend|kids|children|family plans|pregnan\w*|disabilit\w*|citizenship|immigration status|visa status|maiden name|sexual\w*|gender|marital status)\b`,
    String.raw`\byour (?:health|diagnos\w*|medications?|medical (?:history|conditions?|records?))\b`,
    String.raw`\b(?:ever been|have you been) (?:arrested|convicted|charged)\b`,
    String.raw`\bcriminal (?:record|history|background)\b`,
    String.raw`\bconvictions?\b`,
    String.raw`\b(?:do|did) you (?:have|suffer from) (?:any|a) (?:health|medical|mental health) (?:issues?|problems?|conditions?)\b`,
    String.raw`\bwhen did you graduate\b`,
    String.raw`\bwhat year did you (?:finish|complete)\b`,
    String.raw`\bhow many (?:kids|children) (?:do you have|have you got)\b`,
    String.raw`\bchild ?care\b`,
    String.raw`\bworkers['’]? comp(?:ensation)?\b`,
    String.raw`\bdate of birth\b`,
    String.raw`\bwhen were you born\b`,
    String.raw`\bwhere (?:were you born|are you (?:originally )?from)\b`,
    String.raw`\bare you (?:married|single|divorced|pregnant|a (?:citizen|veteran|mother|father|parent)|planning (?:a family|to have))\b`,
    String.raw`\b(?:do|will) you (?:have|plan to have|want) (?:any )?(?:kids|children)\b`,
    String.raw`\b(?:childcare|child care) (?:arrangements?|situation|plans?)\b`,
    String.raw`\b(?:maternity|paternity) leave\b`,
    String.raw`\b(?:do|did) you (?:attend|go to) (?:a )?(?:church|mosque|synagogue|temple)\b`,
    String.raw`\b(?:religio\w*|disabilit\w*|pregnan\w*|marital status|nationality|ethnicity|citizenship status|immigration status|sexual orientation)\b`,
    String.raw`\bwhat year did you graduate\b`,
    String.raw`\bgraduation year\b`,
  ].join("|"),
  "i",
);

/**
 * The code's fairness check for words the AI wrote that a candidate will read as a question (an open question from the
 * résumé reading, a follow-up in the screening chat): the phrase list every job is checked against (`PROXY_RULES`, as
 * `screenCriterion` applies it) and the protected-question words above. The rule broken, in plain words, or null.
 */
export function unfairQuestion(text: string): string | null {
  // the rules `screenCriterion` applies, but a long minimum of years: that one is for job ads, and a question may repeat
  // the candidate's own "12 years of experience"
  for (const rule of PROXY_RULES) {
    if (rule.rule === "experience_floor") continue;
    const hit = rule.find(text);
    if (!hit) continue;
    // pay history is asked of the candidate ("your current pay", "how much do you make"); "the current pay range for this
    // role" is the job's own
    if (rule.rule === "pay_history" && !aboutTheCandidate(text, hit)) continue;
    return rule.reason;
  }
  return PROTECTED_QUESTION.test(text) ? "It asks about a protected characteristic, which is never part of hiring." : null;
}

/** Whether the words `hit` in `text` are about the candidate: "you" or "your" in them or just before them. */
function aboutTheCandidate(text: string, hit: string): boolean {
  const at = text.toLowerCase().indexOf(hit.toLowerCase());
  const around = at < 0 ? text : text.slice(Math.max(0, at - 20), at + hit.length);
  return /\byou(?:r)?\b/i.test(around);
}

/** The packet as the conversation sees it: the focus questions first, then the packet's own. The packet itself when there are none. */
export function focusedPacket(packet: RolePacket, progress: Pick<ScreenProgress, "focusQuestions"> | null | undefined): RolePacket {
  const focus = progress?.focusQuestions ?? [];
  if (!focus.length) return packet;
  const own = packet.screening.questions.filter((q) => !focus.some((f) => f.key === q.key));
  return { ...packet, screening: { ...packet.screening, questions: [...focus.map((f) => ({ key: f.key, question: f.question, kind: "skills" as const })), ...own] } };
}

/**
 * The packet handed to the screen invitation: the focus questions counted in "N questions", and the intro sentence at
 * the head of the human-alternative line, which the invitation prints right after the link. The message templates live
 * in coordinator.ts and are shared by every screen; this keeps one template.
 */
export function packetForFocusedInvite(packet: RolePacket, progress: Pick<ScreenProgress, "focusQuestions"> | null | undefined): RolePacket {
  const p = focusedPacket(packet, progress);
  if (p === packet) return packet;
  return { ...p, communication: { ...p.communication, humanAlternativeText: `${FOCUS_INTRO}\n\n${p.communication.humanAlternativeText}` } };
}

/** Every recorded answer, the focus questions' included, by question key (the one definition lives in @ros/core). */
export function answersOf(screen: { answers: Record<string, string>; progress: Pick<ScreenProgress, "focusQuestions"> }): Record<string, string> {
  return screenAnswersOf(screen);
}

/** Records an answer to a focus question beside the question; returns the progress unchanged for any other key. */
export function withFocusAnswer(progress: ScreenProgress, key: string, answer: string): ScreenProgress {
  const focus = progress.focusQuestions;
  if (!focus?.some((f) => f.key === key)) return progress;
  return { ...progress, focusQuestions: focus.map((f) => (f.key === key ? { ...f, answer } : f)) };
}
