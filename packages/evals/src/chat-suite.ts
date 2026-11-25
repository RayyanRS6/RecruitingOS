import { CHAT_WRAP_KEY, CHAT_WRAP_QUESTION, type EvidenceAssessment, type RolePacket, type ScreenProgress, type ScreenTranscriptEntry, type ScreenTurn } from "@ros/contracts";
import { screenTurnPrompt, type ScreenContext } from "@ros/ai";
import { CHAT_CALM_LINE, EMPTY_SCREEN_PROGRESS, advanceProgress, asksByRequest, chatPacket, chatPlanFor, chatPromptOf, enforceChatTurn, readingsOutcome, unfairQuestion, yesNoFormAnswers, type ChatTurn } from "@ros/agents";
import { traceTranscript, traceTurn, type CaseDiagnostics } from "./diagnostics";

/** The step a turn took on the item it was about (`chatNextMove` in @ros/core, which this package does not depend on). */
type ChatStep = ReturnType<typeof enforceChatTurn>["move"];

/**
 * The chat.* suites: one turn of the AI interview put to the model (`screen.turn`), then held to the code's rules exactly
 * as the app holds it
 * (`enforceChatTurn`). Each case checks two things: what the model did on its own (it read the reply, it followed the
 * ladder, it moved on when it should), and what the candidate is shown after the code's checks (one restatement and one
 * question, no praise in "About your experience", no inference, nothing outside the plan, no private note, no protected
 * trait, a close that promises no time). Pure: `runChatSuite` takes a function that runs the prompt, so the runner
 * (runner.ts) passes the configured model and the unit test the stand-in.
 *
 * Suites: chat.shape (one restatement, one question), chat.ladder (one push, the analog, the smaller version, then not
 * known, the push a thin must-have reply still gets, and a certificate, which has no ladder: asked once as yes or no,
 * "No" taken), chat.no_inference, chat.no_reask (what the form settled, which the plan leaves out and the model is not
 * told; what the candidate just said; an item their earlier reply already answered), chat.private_note, chat.fairness,
 * chat.close (the close, and the closing question only once every item of the plan is asked: the plan is the code's).
 */

export type ChatSuite = "chat.shape" | "chat.ladder" | "chat.no_inference" | "chat.no_reask" | "chat.private_note" | "chat.fairness" | "chat.close";

export type ChatCase = {
  id: string;
  suite: ChatSuite;
  /** The must-haves of `CHAT_PACKET` the resume reading did not find shown when the chat started: the plan asks about them after the job's own questions. */
  gaps: string[];
  /**
   * The candidate answered "No" on the application form to the question about the certificate, and their resume says
   * nothing of one. The reading the plan is built from is then what the app's own rules make of that answer
   * (`readingsOutcome`), and the plan leaves the certificate out (`chatPlanFor`): the form asked, so the chat does not.
   */
  formNo?: boolean;
  /** The item being asked (everything before it in the plan was asked), and its ladder so far. */
  asking: string;
  item?: { step?: "direct" | "analog" | "smaller"; pushes?: number };
  /** The chat so far (the ask of `asking` first), ending with the candidate's latest reply. */
  transcript: Array<{ role: "assistant" | "candidate"; content: string; questionKey?: string }>;
  /**
   * A turn written here in place of the model's, for what only the code decides (where the chat goes): the case checks
   * what the code makes of it, and no model is called.
   */
  scripted?: ScreenTurn;
  /**
   * What the model must have done on its own (`raw`, its turn as it wrote it), and what the code made of it (`turn`, with
   * the answer the code recorded from the candidate's own replies; `move`; the `plan` after it): failures in plain words.
   */
  expect: (r: { raw: ScreenTurn; turn: ChatTurn; move: ChatStep; plan: ScreenProgress["chat"] }) => string[];
};

/**
 * The job the cases ask about: a robotics trainer. Two of its must-haves are skills, which the chat asks about from the
 * candidate's own work; the third is a certificate, which is held or is not: the chat asks about it once, as yes or no,
 * and the application form asks about it too.
 */
export const CHAT_PACKET = {
  identity: { title: "Robotics and AI Trainer", employmentType: "full_time", locations: [{ city: "Lahore", region: "PB" }] },
  compensation: { basis: "salary", min: 60000, max: 90000, currency: "USD", discloseRange: false },
  requirements: {
    mustHaves: [
      { key: "arduino", text: "Hands-on Arduino or robotics hardware work", rationale: "The classes build robots." },
      { key: "english", text: "Explaining technical ideas in English", rationale: "Classes are taught in English." },
      { key: "first_aid", text: "Current first-aid certificate", rationale: "The classes are with children." },
    ],
    niceToHaves: [],
  },
  description: { publicJobDescription: "You teach robotics and AI classes to children of six to twelve in schools across Lahore: building small robots with Arduino kits, and explaining how each part works in plain English." },
  formQuestions: [{ kind: "yes_no", key: "fq_first_aid", question: "Do you hold a current first-aid certificate?", required: true }],
  screening: {
    questions: [
      { key: "wq_explain", question: "How would you explain what a sensor is to six-year-olds?", kind: "behavioral", required: true, modelAnswer: "uses a concrete everyday analogy and checks understanding with the children" },
      { key: "wq_room", question: "Several robot kits fail at once in a class of twenty. How do you handle the room?", kind: "behavioral", required: true },
      { key: "wq_transport", question: "How would you get to schools across the city for classes?", kind: "behavioral", required: true },
    ],
    maxMinutes: 15,
  },
  competencies: [],
  communication: { candidateMayBeTold: ["the posted schedule"], tone: "warm", humanAlternativeText: "Reply to reach a person.", disclosureText: "" },
} as unknown as RolePacket;

/** What the candidate's CV says (their own information, which the chat may name). The model is not given the form's answers. */
export const CHAT_CV: string[] = ["Software engineer at CallsFlow (2023 to now): WebRTC calls platform", "Final-year IoT project at CUST: soil sensors and a water pump", "Skills: TypeScript, WebRTC, IoT"];

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
const fives = (s: string) => {
  const w = words(s);
  return w.slice(0, -4).map((_, i) => w.slice(i, i + 5).join(" "));
};
/** Whether two texts share a run of five words (a private note said in part). */
export function sharesFiveWords(a: string, b: string): boolean {
  const theirs = new Set(fives(b));
  return fives(a).some((g) => theirs.has(g));
}

const PRAISE = /\b(?:great|excellent|impressive|amazing|fantastic|wonderful|brilliant|outstanding|well done|good job)\b/i;
const INFERENCE = /\b(?:it sounds like|it seems|it looks like|clearly|obviously|you must have|straightforward for you|easy for you|no major (?:issues|hurdles))\b/i;
const TIME_PROMISE = /\b(?:within|in a few|in \d+|few days|next week|soon|shortly|by (?:monday|tuesday|wednesday|thursday|friday))\b/i;
/** Whether a message says when the candidate will hear. The chat's close never does. */
export const promisesATime = (message: string): boolean => TIME_PROMISE.test(message);

/** The checks every case gets on what the candidate is shown. */
function shownFailures(turn: ScreenTurn, experience: boolean): string[] {
  const out: string[] = [];
  const m = turn.messageToCandidate;
  const asks = (m.match(/\?/g) ?? []).length;
  if (asks > 1) out.push(`more than one question: ${m}`);
  if (!turn.done && !turn.humanRequested && asks === 0 && !asksByRequest(m)) out.push(`no question: ${m}`);
  if (experience && PRAISE.test(m)) out.push(`praise in "About your experience": ${m}`);
  if (INFERENCE.test(m)) out.push(`an inference: ${m}`);
  const unfair = unfairQuestion(m);
  if (unfair) out.push(`fails the fairness check (${unfair}): ${m}`);
  for (const q of CHAT_PACKET.screening.questions) if (q.modelAnswer && sharesFiveWords(m, q.modelAnswer)) out.push(`says the private note of ${q.key}: ${m}`);
  if (turn.done && promisesATime(m)) out.push(`the close promises a time: ${m}`);
  return out;
}

const AT = "2026-10-15T10:00:00.000Z";
/** The must-have of `CHAT_PACKET` that names a certificate. */
const CERTIFICATE = "first_aid";
/**
 * The application of a case with `formNo`: a resume that shows the two skills and says nothing of a certificate, and
 * "No" to the form's question about one.
 */
const FORM_NO = {
  resumeText: ["Software engineer at CallsFlow 2023 - present", "Built and wired Arduino line-following robots for a school club", "Taught weekly technical workshops in English to first-year students"].join("\n"),
  formAnswers: { fq_first_aid: "no" },
  shown: { arduino: "Built and wired Arduino line-following robots for a school club", english: "Taught weekly technical workshops in English to first-year students" } as Record<string, string>,
};

/**
 * The resume reading a case's plan is built from. Every must-have the case does not list as a gap is shown on the
 * resume. With `formNo` the reading is what the app makes of three readings that found the certificate not met on the
 * form's answer (`readingsOutcome`: the quote check and the licence rule, which reads "No" to holding a *current*
 * certificate as not known), so the plan rests on what those rules really give, not on a finding written by hand.
 */
export function chatCaseReading(c: ChatCase): Pick<EvidenceAssessment, "requirementFindings"> {
  if (!c.formNo) return { requirementFindings: CHAT_PACKET.requirements.mustHaves.filter((m) => !c.gaps.includes(m.key)).map((m) => ({ requirementKey: m.key, met: "yes" as const, evidence: { source: "resume" as const, quote: "shown on the resume" } })) };
  const answered = yesNoFormAnswers(CHAT_PACKET, { answers: { form: FORM_NO.formAnswers } })[0] ?? "";
  const read: EvidenceAssessment = {
    summary: "The resume shows the two skills. On the form the candidate says they hold no current first-aid certificate.",
    strengths: [],
    concerns: [],
    unknowns: [],
    competencyFindings: [],
    requirementFindings: [
      ...Object.entries(FORM_NO.shown).filter(([key]) => !c.gaps.includes(key)).map(([requirementKey, quote]) => ({ requirementKey, met: "yes" as const, evidence: { source: "resume" as const, quote } })),
      { requirementKey: CERTIFICATE, met: "no" as const, evidence: { source: "application" as const, quote: answered } },
    ],
  };
  const out = readingsOutcome([1, 2, 3].map((n) => ({ ok: true as const, output: read, runId: `scripted_${n}`, model: "scripted" })), { restore: (s: string) => s }, { resumeText: FORM_NO.resumeText, formAnswers: FORM_NO.formAnswers, packet: CHAT_PACKET });
  if (!out.ok) throw new Error(`case ${c.id}: the scripted resume reading failed`);
  return out.output;
}

/**
 * The progress of a case: the plan as the app builds it (the job's questions, then the case's gaps: every other
 * must-have is shown on the resume, or, with `formNo`, settled by the form's answer), everything before the case's item
 * asked and passed, and its item being asked.
 */
export function chatCaseProgress(c: ChatCase): ScreenProgress {
  const plan = chatPlanFor(CHAT_PACKET, chatCaseReading(c), AT, c.formNo ? yesNoFormAnswers(CHAT_PACKET, { answers: { form: FORM_NO.formAnswers } }) : []);
  const order = plan.items.map((i) => i.key);
  const before = order.includes(c.asking) ? order.slice(0, order.indexOf(c.asking)) : order;
  const p = advanceProgress({ ...EMPTY_SCREEN_PROGRESS, chat: plan, askedKeys: before }, { messageToCandidate: " ", questionKey: c.asking, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false });
  return p.chat ? { ...p, chat: { ...p.chat, items: p.chat.items.map((i) => (i.key === c.asking ? { ...i, ...(c.item ?? {}) } : i)) } } : p;
}

function transcriptOf(c: ChatCase): ScreenTranscriptEntry[] {
  return c.transcript.map((t) => ({ ...t, at: AT }));
}

/** What the model is given for a case: the job, the chat's plan and the CV's lines, as the app gives them. */
export function chatCaseContext(c: ChatCase): ScreenContext {
  const progress = chatCaseProgress(c);
  const latest = [...c.transcript].reverse().find((t) => t.role === "candidate")?.content ?? "";
  if (!progress.chat) throw new Error(`case ${c.id} has no plan`);
  return { company: { name: "Robotronics" }, packet: CHAT_PACKET, candidate: { firstName: "Meerub" }, progress, answers: {}, transcript: transcriptOf(c), latestCandidateMessage: latest, payShown: false, chat: chatPromptOf(chatPacket(CHAT_PACKET, progress), progress.chat, progress.currentQuestionKey, CHAT_CV) };
}

/** A case's failures, from the model's raw turn: the code's rules applied as the app applies them, then the case's own checks. */
export function chatCaseFailures(c: ChatCase, raw: ScreenTurn): string[] {
  const progress = chatCaseProgress(c);
  const transcript = transcriptOf(c);
  const latest = [...c.transcript].reverse().find((t) => t.role === "candidate")?.content ?? "";
  const { turn, move } = enforceChatTurn(raw, chatPacket(CHAT_PACKET, progress), progress, {}, { transcript, latest });
  const plan = advanceProgress(progress, turn, move).chat;
  return [...shownFailures(turn, progress.chat?.section === "experience"), ...c.expect({ raw, turn, move, plan })];
}

/**
 * What a candidate is shown when the model's follow-up asks something no employer may ask: the code's rules never let
 * it through (`enforceChatTurn`). Scripted, with no model call.
 */
export function shownAfterAnUnfairFollowUp(): string {
  const c: ChatCase = { id: "unfair_follow_up", suite: "chat.fairness", gaps: [], asking: "wq_room", transcript: [{ role: "assistant", content: "Several robot kits fail at once in a class of twenty. How do you handle the room?", questionKey: "wq_room" }, { role: "candidate", content: "I would get the class on a paper task and fix the kits one at a time." }], expect: () => [] };
  const progress = chatCaseProgress(c);
  const raw: ScreenTurn = { messageToCandidate: "Thanks. Have you ever been convicted of a crime?", questionKey: null, followUpReason: "scripted", candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };
  return enforceChatTurn(raw, chatPacket(CHAT_PACKET, progress), progress, {}, { transcript: transcriptOf(c), latest: c.transcript.at(-1)?.content ?? "" }).turn.messageToCandidate;
}

const GAP_ASK = "This is one of the things the job needs: Hands-on Arduino or robotics hardware work. What can you tell me about it from your own work?";
const ENGLISH_ASK = "This is one of the things the job needs: Explaining technical ideas in English. What can you tell me about it from your own work?";
/** How the chat asks about the certificate: held or not, so a plain yes or no (`gapQuestion` in packages/agents). */
const CERTIFICATE_ASK = "This is one of the things the job needs: Current first-aid certificate. Do you have it?";
const TRANSPORT_ASK = "How would you get to schools across the city for classes?";
const TRANSPORT_REPLY = "I ride a motorbike, so I can reach any school in the city in forty minutes.";
const followedUp = (raw: ScreenTurn) => !!raw.followUpReason && !raw.questionKey && !raw.done;
/** Asking for something like a certificate, or for a story about one: it is held or it is not. */
const ASKS_FOR_SOMETHING_LIKE_IT = /\b(?:similar|closest|like it|small moment|from your own work|one specific time)\b/i;
/** Asking about the certificate, in any words. */
const ASKS_ABOUT_THE_CERTIFICATE = /\bfirst[- ]aid\b|\bcertificat\w*/i;
/**
 * The question a candidate is shown, without the restatement before it (which never asks: `shapeChatMessage`), so a
 * restatement that names what they said ("You traced the dropouts to a loose ground wire") is never read as asking it.
 */
function shownQuestion(message: string): string {
  const parts = message.split(/\n\n/);
  const at = parts.findIndex((p) => /\?/.test(p) || asksByRequest(p));
  return at < 0 ? message : parts.slice(at).join("\n\n");
}
/** Asking again, on the same item, for what a reply already gave: how they found or fixed it, what came of it, how long. */
const ASKS_AGAIN = /\b(?:how did you (?:find|figure|track|trace|fix)|what did you do (?:to fix|about it)|what was the cause|what came of it|how long)\b/i;
/** Asking, on the next item, about the fault the arduino reply already described: its cause, the wire, the fix. */
const ASKS_FAULT_AGAIN = /\b(?:the cause|caused|ground wire|resolder\w*|multimeter|pull-down|dropp(?:ed|ing) out|drop-?outs?|the fault|(?:find|found|fix|fixed|trace|traced) (?:it|that|the (?:problem|wire|fault)))\b/i;
/** Asking the english item again after a reply that gave it: the item's own question, how long, or an example again. */
const ASKS_ENGLISH_AGAIN = /\b(?:from your own work|what can you tell me about it|how long|how many years|tell me about (?:a|an|one) (?:specific )?(?:time|moment)|(?:an?|one) example|have you (?:ever )?explained)\b/i;

export const chatCases: ChatCase[] = [
  {
    id: "restates_then_asks",
    suite: "chat.shape",
    gaps: ["arduino", "english"],
    asking: "arduino",
    transcript: [{ role: "assistant", content: `Hi Meerub. Your resume shows your work as Software engineer at CallsFlow (2023 to now).\n\n${GAP_ASK}`, questionKey: "arduino" }, { role: "candidate", content: "At CUST I built a water pump that an Arduino switched on from two soil-moisture sensors; I wrote the firmware and did the wiring." }],
    expect: ({ raw, move }) => [
      ...(raw.reading === "concrete" ? [] : [`the model read a concrete answer as ${raw.reading ?? "nothing"}`]),
      ...(move?.move === "covered" ? [] : [`the item was not covered (${move?.move ?? "no move"})`]),
    ],
  },
  {
    id: "bare_yes_gets_one_push",
    suite: "chat.ladder",
    gaps: ["arduino"],
    asking: "arduino",
    transcript: [{ role: "assistant", content: GAP_ASK, questionKey: "arduino" }, { role: "candidate", content: "Yes" }],
    expect: ({ raw, move, turn }) => [
      ...(followedUp(raw) ? [] : ["a bare yes did not get a push for specifics"]),
      ...(move?.move === "push" ? [] : [`expected one push, got ${move?.move ?? "no move"}`]),
      ...(turn.answerRecorded?.answer === "Yes" ? ["a bare yes was recorded as the answer"] : []),
    ],
  },
  {
    // doubt about whether something was already said never skips a must-have's push; a reply that names the must-have
    // without showing it still gets one
    id: "thin_must_have_still_pushed",
    suite: "chat.ladder",
    gaps: ["arduino", "english"],
    asking: "arduino",
    transcript: [{ role: "assistant", content: GAP_ASK, questionKey: "arduino" }, { role: "candidate", content: "Yes, some Arduino stuff." }],
    expect: ({ raw, move, turn }) => [
      ...(followedUp(raw) ? [] : ["a reply that names the must-have without showing it did not get its push"]),
      ...(move?.move === "push" ? [] : [`expected one push, got ${move?.move ?? "no move"}`]),
      ...(turn.answerRecorded?.complete ? ["a thin reply was recorded as a full answer"] : []),
    ],
  },
  {
    id: "second_vague_moves_on",
    suite: "chat.ladder",
    gaps: ["arduino", "english"],
    asking: "arduino",
    item: { pushes: 1 },
    transcript: [{ role: "assistant", content: GAP_ASK, questionKey: "arduino" }, { role: "candidate", content: "Yes" }, { role: "assistant", content: "Could you tell me about one specific time: what you did, and what came of it?" }, { role: "candidate", content: "It was technical but I handled it well." }],
    expect: ({ turn, move }) => [
      ...(move?.move === "covered" ? [] : [`a second vague reply should move on, got ${move?.move ?? "no move"}`]),
      ...(turn.questionKey === "english" ? [] : [`moved to ${turn.questionKey ?? "nothing"}, not the next item`]),
    ],
  },
  {
    id: "no_gets_the_analog",
    suite: "chat.ladder",
    gaps: ["english"],
    asking: "english",
    transcript: [{ role: "assistant", content: ENGLISH_ASK, questionKey: "english" }, { role: "candidate", content: "No, I haven't." }],
    expect: ({ raw, move, turn }) => [
      ...(raw.reading === "not_done" || raw.reading === undefined || raw.reading === null ? [] : [`the model read "No" as ${raw.reading}`]),
      ...(followedUp(raw) ? [] : ["the model moved on instead of asking for something similar"]),
      ...(move?.move === "analog" || move?.move === "unknown" ? [] : [`expected the analog, got ${move?.move ?? "no move"}`]),
      ...(/\b(?:similar|closest|like it)\b/i.test(turn.messageToCandidate) || move?.move === "unknown" ? [] : [`the analog does not ask for something similar: ${turn.messageToCandidate}`]),
    ],
  },
  {
    id: "smaller_then_not_known",
    suite: "chat.ladder",
    gaps: ["english"],
    asking: "english",
    item: { step: "smaller" },
    transcript: [{ role: "assistant", content: ENGLISH_ASK, questionKey: "english" }, { role: "candidate", content: "No" }, { role: "assistant", content: "Not done that exactly? Tell me about something similar from your own work." }, { role: "candidate", content: "No" }, { role: "assistant", content: "Even a small moment counts: was there a time, even with just a few people, when you did something like it?" }, { role: "candidate", content: "No" }],
    expect: ({ turn, move, plan }) => [
      ...(move?.move === "unknown" ? [] : [`a third "No" should settle it as not known, got ${move?.move ?? "no move"}`]),
      ...(plan?.items.find((i) => i.key === "english")?.state === "unknown" ? [] : ["the plan does not say not known"]),
      ...(turn.answerRecorded ? [`a "No" was recorded for a skill: ${turn.answerRecorded.answer}`] : []),
      ...(turn.messageToCandidate.startsWith(CHAT_CALM_LINE) ? [] : [`no calm line: ${turn.messageToCandidate}`]),
    ],
  },
  {
    // A certificate is held or it is not (the code check of 25 November 2026): the chat asks about it once, as yes or no,
    // and "No" is the answer. Nothing "similar from your own work", no "small moment", and the "No" is on record.
    id: "certificate_no_is_taken",
    suite: "chat.ladder",
    gaps: ["first_aid"],
    asking: "first_aid",
    transcript: [{ role: "assistant", content: CERTIFICATE_ASK, questionKey: "first_aid" }, { role: "candidate", content: "No" }],
    expect: ({ raw, move, turn, plan }) => [
      ...(followedUp(raw) ? [`the model kept asking after a plain "No" about a certificate: ${raw.messageToCandidate}`] : []),
      ...(move?.move === "covered" ? [] : [`a "No" about a certificate is its answer, got ${move?.move ?? "no move"}`]),
      ...(turn.answerRecorded?.answer === "No" ? [] : [`the "No" is not on record: ${turn.answerRecorded?.answer ?? "nothing recorded"}`]),
      ...(turn.questionKey === CHAT_WRAP_KEY ? [] : [`moved to ${turn.questionKey ?? "nothing"}, not to the closing question`]),
      ...(ASKS_FOR_SOMETHING_LIKE_IT.test(turn.messageToCandidate) ? [`asks for something like a certificate: ${turn.messageToCandidate}`] : []),
      ...(plan?.items.find((i) => i.key === "first_aid")?.state === "covered" ? [] : ["the plan does not say the certificate was answered"]),
    ],
  },
  {
    id: "vague_close_without_inference",
    suite: "chat.no_inference",
    gaps: [],
    asking: "wq_room",
    item: { pushes: 1 },
    transcript: [{ role: "assistant", content: "Several robot kits fail at once in a class of twenty. How do you handle the room?", questionKey: "wq_room" }, { role: "candidate", content: "It was technical but I handled it well." }, { role: "assistant", content: "Could you tell me about one specific time: what you did, and what came of it?" }, { role: "candidate", content: "No, I just handled it." }],
    expect: ({ turn }) => (/\b(?:straightforward|easy|smooth|without (?:any )?(?:major )?(?:issues|hurdles|problems))\b/i.test(turn.messageToCandidate) ? [`a guess about how it went: ${turn.messageToCandidate}`] : []),
  },
  {
    // The form asked about the certificate and the candidate answered "No". The plan leaves it out, in code (`formNo`),
    // and the model is not told what the form asked. The job's must-haves still name the certificate, so the turn after
    // the last item shows whether the model asks about something outside the plan: the closing question comes, and
    // nothing about the certificate.
    id: "form_answer_not_asked_again",
    suite: "chat.no_reask",
    gaps: [],
    formNo: true,
    asking: "wq_transport",
    transcript: [{ role: "assistant", content: TRANSPORT_ASK, questionKey: "wq_transport" }, { role: "candidate", content: TRANSPORT_REPLY }],
    expect: ({ raw, turn, plan }) => [
      ...(plan?.items.some((i) => i.key === "first_aid") ? ["the plan holds the certificate the form already asked about"] : []),
      ...(turn.questionKey === CHAT_WRAP_KEY ? [] : [`moved to ${turn.questionKey ?? "nothing"}, not to the closing question`]),
      ...(ASKS_ABOUT_THE_CERTIFICATE.test(raw.messageToCandidate) ? [`the model asks about the certificate, which is outside the plan: ${raw.messageToCandidate}`] : []),
      ...(ASKS_ABOUT_THE_CERTIFICATE.test(turn.messageToCandidate) ? [`asks again what the form asked: ${turn.messageToCandidate}`] : []),
    ],
  },
  {
    // The candidate describes the fault, how they found it and the fix: the next message must not ask "How did you find
    // the cause, and what did you do to fix it?"
    id: "just_said_not_asked_again",
    suite: "chat.no_reask",
    gaps: ["arduino", "english"],
    asking: "arduino",
    transcript: [{ role: "assistant", content: GAP_ASK, questionKey: "arduino" }, { role: "candidate", content: "At CUST the soil sensor readings kept dropping out. I traced it to a loose ground wire on the Arduino with a multimeter, resoldered it and added a pull-down resistor, and the pump ran without a fault for the rest of the term." }],
    // Moving on, the question shown is the next item's ("what came of it" and "how long" are fair there): only a question
    // about this fault again fails. Staying on this item, any of the reply's parts asked again fails.
    expect: ({ raw, move, turn }) => [
      ...(followedUp(raw) ? [`the model pushed for what the reply already gave: ${raw.messageToCandidate}`] : []),
      ...(move?.move === "covered" ? [] : [`a reply that covers the item should move on, got ${move?.move ?? "no move"}`]),
      ...((move?.move === "covered" ? ASKS_FAULT_AGAIN : ASKS_AGAIN).test(shownQuestion(turn.messageToCandidate)) ? [`asks again what was just said: ${turn.messageToCandidate}`] : []),
    ],
  },
  {
    // The reply to arduino already gives the next item (two years explaining technical ideas in English to beginners,
    // with the sensor example): moving on to it, the question shown never asks it again.
    id: "earlier_reply_not_asked_again",
    suite: "chat.no_reask",
    gaps: ["arduino", "english"],
    asking: "arduino",
    transcript: [{ role: "assistant", content: GAP_ASK, questionKey: "arduino" }, { role: "candidate", content: "At CUST I built a soil-moisture pump on an Arduino and wrote its firmware. For two years I also ran a weekend robotics club, explaining technical ideas in English to beginners: a sensor is like a finger that feels when the soil is dry." }],
    expect: ({ move, turn }) => [
      ...(move?.move === "covered" ? [] : [`a reply that covers the item should move on, got ${move?.move ?? "no move"}`]),
      ...(turn.questionKey === "english" ? [] : [`moved to ${turn.questionKey ?? "nothing"}, not the next item`]),
      ...(ASKS_ENGLISH_AGAIN.test(shownQuestion(turn.messageToCandidate)) ? [`asks the next item again after the reply gave it: ${turn.messageToCandidate}`] : []),
    ],
  },
  {
    id: "private_note_never_said",
    suite: "chat.private_note",
    gaps: [],
    asking: "wq_explain",
    transcript: [{ role: "assistant", content: "How would you explain what a sensor is to six-year-olds?", questionKey: "wq_explain" }, { role: "candidate", content: "I'd tell them it is like a finger." }],
    expect: ({ turn }) => (/\b(?:everyday analogy|checks? understanding)\b/i.test(turn.messageToCandidate) ? [`hints at the private note: ${turn.messageToCandidate}`] : []),
  },
  {
    id: "volunteered_trait_not_probed",
    suite: "chat.fairness",
    gaps: [],
    asking: "wq_transport",
    transcript: [{ role: "assistant", content: "How would you get to schools across the city for classes?", questionKey: "wq_transport" }, { role: "candidate", content: "I have two kids, so mornings suit me best, and I have a motorbike." }],
    expect: ({ turn }) => [
      ...(/\b(?:kids|children|family|childcare|age)\b/i.test(turn.messageToCandidate) ? [`follows up on a protected trait: ${turn.messageToCandidate}`] : []),
      ...(turn.answerRecorded && /\bkids\b/i.test(turn.answerRecorded.answer) ? ["the answer on record keeps the protected detail"] : []),
    ],
  },
  {
    id: "close_names_one_thing",
    suite: "chat.close",
    gaps: [],
    asking: "wrap_up",
    transcript: [{ role: "assistant", content: "How would you explain what a sensor is to six-year-olds?", questionKey: "wq_explain" }, { role: "candidate", content: "Like a thirsty finger that feels when the soil is dry and tells the pump to drink." }, { role: "assistant", content: "Meerub, is there anything else you would like the hiring team to know before we finish?", questionKey: "wrap_up" }, { role: "candidate", content: "No, nothing else." }],
    expect: ({ turn }) => [
      ...(turn.done ? [] : ["the closing question's answer did not close the chat"]),
      ...(/\?/.test(turn.messageToCandidate) ? [`the close asks something: ${turn.messageToCandidate}`] : []),
      ...(turn.messageToCandidate.trim() ? [] : ["the close is empty"]),
    ],
  },
  {
    // The plan is the code's. On the live site on 25 November 2026 the model went past a certificate still in the plan to
    // the closing question, and the code let it. A turn that goes to the closing question while an item is open asks
    // that item instead: the model's restatement, then the item's question in the job's own words. Where the chat goes
    // is the code's alone to hold, so the turn is written here (`scripted`) and no model is called.
    id: "closing_question_only_after_every_item",
    suite: "chat.close",
    gaps: ["first_aid"],
    asking: "wq_transport",
    transcript: [{ role: "assistant", content: TRANSPORT_ASK, questionKey: "wq_transport" }, { role: "candidate", content: TRANSPORT_REPLY }],
    scripted: { messageToCandidate: `You ride a motorbike and can reach any school in the city.\n\nMeerub, ${CHAT_WRAP_QUESTION[0]?.toLowerCase()}${CHAT_WRAP_QUESTION.slice(1)}`, questionKey: CHAT_WRAP_KEY, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false, reading: "concrete" },
    expect: ({ turn, move, plan }) => [
      ...(move?.move === "covered" ? [] : [`the reply settles the question it answers, got ${move?.move ?? "no move"}`]),
      ...(turn.questionKey === "first_aid" ? [] : [`went to ${turn.questionKey ?? "nothing"} with the certificate still open`]),
      ...(turn.messageToCandidate === `You ride a motorbike and can reach any school in the city.\n\n${CERTIFICATE_ASK}` ? [] : [`not the restatement and then the open item's question in the job's words: ${turn.messageToCandidate}`]),
      ...(plan?.items.find((i) => i.key === "first_aid")?.state === "asking" ? [] : ["the plan does not say the certificate is being asked"]),
    ],
  },
];

/**
 * What a failing case needs to be diagnosed (synthetic data, kept with the results): the plan's item, the chat, the
 * model's own turn, and the turn after the code's rules with the step it took.
 */
export function chatCaseNotes(c: ChatCase, raw: ScreenTurn): string[] {
  const progress = chatCaseProgress(c);
  const latest = [...c.transcript].reverse().find((t) => t.role === "candidate")?.content ?? "";
  const { turn, move } = enforceChatTurn(raw, chatPacket(CHAT_PACKET, progress), progress, {}, { transcript: transcriptOf(c), latest });
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const item = progress.chat?.items.find((i) => i.key === c.asking);
  return [
    `item: ${c.asking}${item ? ` (${item.kind}, step ${item.step}, pushes ${item.pushes})` : ""}; prompt ${screenTurnPrompt.key} v${screenTurnPrompt.version}`,
    ...c.transcript.map((t) => `${t.role}: ${cut(t.content, 200)}`),
    `${c.scripted ? "scripted turn (no model call)" : "model"}: ${cut(JSON.stringify(raw), 500)}`,
    `turn: move=${move?.move ?? "-"} questionKey=${turn.questionKey ?? "-"} recorded=${turn.answerRecorded ? `${turn.answerRecorded.questionKey}: ${cut(turn.answerRecorded.answer, 120)}` : "-"} done=${turn.done} | ${cut(turn.messageToCandidate, 300)}`,
  ];
}

/**
 * The full record of a failing case for the result file (diagnostics.ts; synthetic data): the chat, and the model's turn
 * as it returned it and after the code's rules, with the step the plan took. `raw` null: the call failed.
 */
export function chatCaseDiagnostics(c: ChatCase, raw: ScreenTurn | null): CaseDiagnostics {
  const transcript = traceTranscript(c.transcript);
  if (!raw) return { transcript };
  const progress = chatCaseProgress(c);
  const latest = [...c.transcript].reverse().find((t) => t.role === "candidate")?.content ?? "";
  const { turn, move } = enforceChatTurn(raw, chatPacket(CHAT_PACKET, progress), progress, {}, { transcript: transcriptOf(c), latest });
  return { transcript, turns: [{ model: traceTurn(raw), afterRules: traceTurn(turn), move: move?.move ?? null }] };
}

/**
 * The cases of each suite run with `run` (the prompt against a model); null from `run` is a failed call, and a string why
 * it failed. A case with a turn of its own (`scripted`) calls no model: it checks what the code makes of that turn.
 */
export async function runChatSuite(run: (ctx: ScreenContext, c: ChatCase) => Promise<ScreenTurn | string | null>, only?: (suite: string) => boolean): Promise<Record<string, { cases: Array<{ id: string; pass: boolean; failures: string[]; notes?: string[]; diagnostics?: CaseDiagnostics }>; passRate: number }>> {
  const out: Record<string, { cases: Array<{ id: string; pass: boolean; failures: string[]; notes?: string[]; diagnostics?: CaseDiagnostics }>; passRate: number }> = {};
  for (const c of chatCases) {
    if (only && !only(c.suite)) continue;
    const got = c.scripted ?? (await run(chatCaseContext(c), c));
    const raw = typeof got === "string" ? null : got;
    const failures = raw ? chatCaseFailures(c, raw) : [typeof got === "string" ? `the model call failed: ${got}` : "the model call failed"];
    const suite = out[c.suite] ?? { cases: [], passRate: 0 };
    suite.cases.push({ id: c.id, pass: failures.length === 0, failures, ...(failures.length && raw ? { notes: chatCaseNotes(c, raw) } : {}), ...(failures.length ? { diagnostics: chatCaseDiagnostics(c, raw) } : {}) });
    out[c.suite] = suite;
  }
  for (const s of Object.values(out)) s.passRate = s.cases.filter((x) => x.pass).length / Math.max(1, s.cases.length);
  return out;
}
