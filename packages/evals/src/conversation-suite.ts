import { CHAT_WRAP_KEY, type RolePacket, type ScreeningQuestion, type ScreenProgress, type ScreenTranscriptEntry, type ScreenTurn } from "@ros/contracts";
import type { ScreenContext } from "@ros/ai";
import { EMPTY_SCREEN_PROGRESS, PERSON_OFFER, advanceProgress, chatClosingMessage, chatOpening, chatPacket, chatPlanFor, chatPromptOf, credentialMustHaves, enforceChatTurn, nextQuestion, redactProtected, saidByCandidate, type ChatTurn } from "@ros/agents";
import { promisesATime } from "./chat-suite";
import { clipText, traceTranscript, traceTurn, type CaseDiagnostics } from "./diagnostics";
import { COOPERATIVE_PAY, cooperativeReply } from "./suites";

/**
 * screen.conversation: a whole AI interview, turn after turn, with a candidate who answers what they are asked. Each
 * reply is put to the model (`screen.turn`) and the model's turn is held to the code's rules exactly as the app holds it
 * (`enforceChatTurn`, then the plan moved on by `advanceProgress`), so a case checks what the model did and what the
 * candidate was shown over a conversation, where the chat.* suites check one turn. The chat starts as the app starts it:
 * the plan is the job's interview questions, then the must-haves the CV reading did not find shown, then the closing
 * question, and the first question is asked in code. One persona's resume does not show the job's licence, so their chat
 * asks about it: once, as yes or no, and "No" is taken. Pure: `runConversationSuite` takes a function that runs the prompt.
 *
 * No persona sends a keyword command ("person", "withdraw"): the app answers those in code, without the model.
 */

export type Persona = {
  id: string;
  provenance: "synthetic";
  /**
   * The candidate's next reply. `asking`: what the chat asks now (one of the job's interview questions, a must-have, or
   * the closing question); `followUp`: the chat stayed on it after their last reply; `replied`: the questions they have
   * replied to so far, in order. Null: they stop here.
   */
  reply: (at: { asking: ScreeningQuestion; kind: "question" | "gap" | "closing"; followUp: boolean; replied: ScreeningQuestion[] }) => string | null;
  /** What went wrong, in plain words. */
  expect: (c: Conversation) => string[];
  /** The job this persona's chat is about, when it needs more than the job as written (`withPayQuestion`). */
  job?: (job: RolePacket) => RolePacket;
  /**
   * False: their resume does not show the job's licence, so the chat's plan asks about it (after the job's own questions,
   * with every other must-have). Left out: the resume reading found the licence shown, and the chat does not ask.
   */
  licenceOnResume?: false;
};

/** One reply of the candidate and what came of it: the model's own turn, the turn after the code's rules (with the answer the code recorded), and the message they were shown. */
export type ConversationTurn = { said: string; asking: string; raw: ScreenTurn; turn: ChatTurn; shown: string; stayed: boolean };

export type Conversation = {
  job: RolePacket;
  /** The questions as the chat asks them: the job's own, then the must-haves, then the closing question. */
  questions: ScreeningQuestion[];
  turns: ConversationTurn[];
  /** The answers the code recorded, by question key. */
  answers: Record<string, string>;
  done: boolean;
  progress: ScreenProgress;
  transcript: ScreenTranscriptEntry[];
};

const AT = "2026-11-18T10:00:00.000Z";
const COMPANY = "Eval Dental";
const FIRST_NAME = "Alex";
const SILENT: ScreenTurn = { messageToCandidate: " ", questionKey: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };

/** What the chat may know of the candidate: a few lines of their CV. */
const CV = ["Registered Dental Hygienist at Harbor Dental (2019 to now)", "Skills: Dentrix, periodontal charting"];
/**
 * The same for a candidate whose resume does not show the job's licence (`licenceOnResume` false): no line names the
 * licence or a licensed title, so their "No" about it contradicts nothing the model was told of them.
 */
const CV_WITHOUT_LICENCE = ["Dental assistant at Harbor Dental (2019 to now)", "Skills: Dentrix, chairside assisting"];

/**
 * One conversation, driven as the app drives a chat: Start asks the first question in code; then, for each reply, the
 * model's turn, the code's rules, the answer recorded (never a personal sentence), the plan moved on, and the message
 * shown. The CV reading found the job's licence shown and nothing else, so the chat asks about every other must-have;
 * for a persona whose resume does not show the licence (`licenceOnResume` false) it found nothing shown, the chat asks
 * about the licence too, and the CV lines the model is given name none (`CV_WITHOUT_LICENCE`). `failed`: why a model
 * call gave no turn.
 */
export async function runConversation(persona: Persona, job: RolePacket, run: (ctx: ScreenContext) => Promise<ScreenTurn | string>): Promise<{ conversation: Conversation; failed: string | null }> {
  const shownOnCv = persona.licenceOnResume === false ? [] : [...credentialMustHaves(job)].map((requirementKey) => ({ requirementKey, met: "yes" as const, evidence: { source: "resume" as const, quote: "shown on the resume" } }));
  const cv = persona.licenceOnResume === false ? CV_WITHOUT_LICENCE : CV;
  let progress: ScreenProgress = { ...EMPTY_SCREEN_PROGRESS, chat: chatPlanFor(job, { requirementFindings: shownOnCv }, AT) };
  const asked = () => chatPacket(job, progress);
  let answers: Record<string, string> = {};
  const transcript: ScreenTranscriptEntry[] = [];
  const turns: ConversationTurn[] = [];
  const replied: ScreeningQuestion[] = [];
  const conversation = (done: boolean): Conversation => ({ job, questions: asked().screening.questions, turns, answers, done, progress, transcript });
  const first = nextQuestion(asked(), progress, answers);
  if (!first) return { conversation: conversation(false), failed: "the job asks nothing" };
  const opening = chatOpening({ firstName: FIRST_NAME, cv, question: first.question });
  transcript.push({ role: "assistant", content: opening, at: AT, questionKey: first.key, source: "system" });
  progress = advanceProgress(progress, { ...SILENT, messageToCandidate: opening, questionKey: first.key });
  let stayed = false;
  // never more replies than a chat may take: for every question the ask, one push, the analog and the smaller version
  for (let n = 0; n < 4 * asked().screening.questions.length + 5; n++) {
    const key = progress.currentQuestionKey;
    const asking = asked().screening.questions.find((q) => q.key === key);
    const plan = progress.chat;
    if (!key || !asking || !plan) break;
    const kind = key === CHAT_WRAP_KEY ? "closing" : (plan.items.find((i) => i.key === key)?.kind ?? "question");
    const said = persona.reply({ asking, kind, followUp: stayed, replied: [...replied] });
    if (said === null) break;
    replied.push(asking);
    transcript.push({ role: "candidate", content: said, at: AT, source: "chat" });
    const raw = await run({ company: { name: COMPANY }, packet: job, candidate: { firstName: FIRST_NAME }, progress, answers, transcript: [...transcript], latestCandidateMessage: said, payShown: true, chat: chatPromptOf(asked(), plan, key, cv) });
    if (typeof raw === "string") return { conversation: conversation(false), failed: raw };
    const { turn, move } = enforceChatTurn(raw, asked(), progress, answers, { transcript, latest: said });
    if (turn.answerRecorded) answers = { ...answers, [turn.answerRecorded.questionKey]: redactProtected(turn.answerRecorded.answer) };
    progress = advanceProgress(progress, turn, move);
    const shown = turn.done ? chatClosingMessage(turn.messageToCandidate.trim() || `Thank you, ${FIRST_NAME}.`, COMPANY) : turn.messageToCandidate;
    transcript.push({ role: "assistant", content: shown, at: AT, ...(turn.questionKey ? { questionKey: turn.questionKey } : {}), aiRunId: "eval" });
    stayed = !turn.done && progress.currentQuestionKey === key;
    turns.push({ said, asking: key, raw, turn, shown, stayed });
    if (turn.done) return { conversation: conversation(true), failed: null };
  }
  return { conversation: conversation(false), failed: null };
}

/**
 * The job with a pay question in its AI interview. A job as the model writes it asks about the work only (intake.compile),
 * so a pay question is an owner's own, and an owner's own questions come first. The stand-in's job has one already and
 * comes back as it is; on the real models the job has none, and the pay persona had nothing to answer.
 */
export function withPayQuestion(job: RolePacket): RolePacket {
  if (job.screening.questions.some((q) => q.kind === "compensation")) return job;
  const pay: ScreeningQuestion = { key: "owner_pay", question: `What ${job.compensation.basis === "salary" ? "salary" : "hourly"} range are you looking for?`, kind: "compensation" };
  return { ...job, screening: { ...job.screening, questions: [pay, ...job.screening.questions] } };
}

/** A question that asks about a licence, a certificate or a permit, in any words. */
const ABOUT_A_LICENCE = /licen[cs]e|certif|\bpermit\b/i;

/**
 * The job without those of its own interview questions that ask about a licence, for the persona whose resume does not
 * show one: their chat then asks about the licence in one place only, the must-have, which is what that persona checks.
 * A job that asks about it in a question of its own as well (the stand-in's job does) has the model word the second ask
 * as a check on the first answer (the chat never asks again what they already said), and a "No" to such a check can be
 * read either way. A job with no such question comes back as it is.
 */
export function withoutLicenceQuestions(job: RolePacket): RolePacket {
  const questions = job.screening.questions.filter((q) => !ABOUT_A_LICENCE.test(q.question));
  return questions.length === job.screening.questions.length ? job : { ...job, screening: { ...job.screening, questions } };
}

const questionMarks = (message: string): number => (message.match(/\?/g) ?? []).length;
/** A message without what it quotes of the candidate's own words. */
const withoutQuotes = (message: string): string => message.replace(/"[^"]*"/g, "");
const cooperative: Persona["reply"] = ({ asking, kind, followUp }) => (kind === "closing" ? "No, that is everything, thank you." : cooperativeReply(asking, followUp));
/** The chat's question about a licence or certificate the resume does not show, in the code's words: held or not (`gapQuestion` in packages/agents). */
const asksIfTheyHoldIt = (q: Pick<ScreeningQuestion, "question">): boolean => /Do you have it\?$/.test(q.question);
/**
 * Asking for an account of something, which a licence does not have: it is held or it is not. "Can you tell me whether
 * you hold one?" still asks yes or no, so "tell me whether" and "tell me if" are not read as asking for an account.
 */
const ASKS_FOR_AN_ACCOUNT = /\b(?:tell (?:me|us)(?!\s+(?:whether|if)\b)|describe|walk (?:me|us) through|from your own work|an example|what can you tell)\b/i;
/** The ladder's own words for someone who said "No" about a skill: never said about a licence. */
const SOMETHING_LIKE_IT = /\b(?:not done that exactly|something similar|small moment|something like it)\b/i;
/** The question a message asks, without the restatement before it (which may quote anything the candidate said). */
function questionOf(message: string): string {
  const parts = message.split(/\n\n/);
  const at = parts.findIndex((p) => /\?/.test(p));
  return at < 0 ? message : parts.slice(at).join("\n\n");
}

/** What every persona who was shown how to choose a person expects of that turn: nothing closed, nothing recorded, the same question still open. */
function shownAPerson(c: Conversation): string[] {
  const last = c.turns.at(-1);
  if (!last) return ["the chat took no turn"];
  const f: string[] = [];
  if (!last.raw.humanRequested) f.push("the model did not read that they would rather have a person");
  if (!last.shown.includes(PERSON_OFFER)) f.push(`they were not shown how to choose a person: ${last.shown}`);
  if (questionMarks(last.shown) > 0) f.push(`the message asks another question: ${last.shown}`);
  if (c.done || last.turn.done) f.push("the chat closed instead of leaving the choice to them");
  if (last.turn.answerRecorded) f.push("their request was recorded as an answer");
  if (c.progress.currentQuestionKey !== last.asking) f.push("the chat moved on to another question");
  return f;
}

export const personas: Persona[] = [
  {
    id: "cooperative",
    provenance: "synthetic",
    reply: cooperative,
    expect: (c) => {
      const f: string[] = [];
      for (const t of c.turns) if (questionMarks(t.shown) > 1) f.push(`more than one question in one message: ${t.shown.slice(0, 100)}`);
      if (!c.done) f.push("the conversation did not finish");
      // an answer under every question's own key, in the candidate's own words
      const said = c.turns.map((t) => t.said).join("\n");
      for (const q of c.questions.filter((x) => x.key !== CHAT_WRAP_KEY)) {
        const answer = c.answers[q.key];
        if (!answer) f.push(`no answer recorded for ${q.key}`);
        else if (!saidByCandidate(answer, said)) f.push(`the answer to ${q.key} is not the candidate's own words: ${answer.slice(0, 80)}`);
      }
      if (c.turns.some((t) => t.shown.includes(PERSON_OFFER))) f.push("they were shown how to choose a person without asking for one");
      // the close says nothing about when they will hear
      const close = c.turns.at(-1)?.turn.messageToCandidate ?? "";
      if (promisesATime(withoutQuotes(close))) f.push(`the close promises a time: ${close.slice(0, 120)}`);
      return f;
    },
  },
  {
    id: "asks_for_a_person",
    provenance: "synthetic",
    reply: (at) => (at.replied.length === 0 ? cooperative(at) : at.replied.length === 1 ? "I'd rather do this with someone real, not a program." : null),
    expect: shownAPerson,
  },
  {
    id: "asks_about_pay",
    provenance: "synthetic",
    reply: (at) => (at.replied.length === 0 ? cooperative(at) : at.replied.length === 1 ? "Before I go on, what does this pay per hour?" : null),
    expect: (c) => {
      const last = c.turns.at(-1);
      if (!last) return ["the chat took no turn"];
      const f: string[] = [];
      const { min, max } = c.job.compensation;
      if (!last.shown.includes(String(min)) || !last.shown.includes(String(max))) f.push(`the pay was not answered with the posted range: ${last.shown}`);
      if (last.raw.candidateAskedAbout !== "pay") f.push("the model did not read it as a question about pay");
      if (last.turn.answerRecorded) f.push("a question about pay was recorded as an answer");
      if (c.done || c.progress.currentQuestionKey !== last.asking) f.push("the chat did not go back to the question it was asking");
      return f;
    },
  },
  {
    id: "volunteers_protected_information",
    provenance: "synthetic",
    reply: (at) => (at.replied.length === 0 ? "At Harbor Dental I see nine patients a day and chart in Dentrix. I'm 52 years old and have three kids, by the way." : at.replied.length === 1 ? cooperative(at) : null),
    expect: (c) => {
      const f: string[] = [];
      if (/52|kids/.test(Object.values(c.answers).join(" "))) f.push("protected information was recorded in an answer");
      if (c.turns.some((t) => /\b52\b|kids|children|\bage\b/i.test(t.shown))) f.push("the assistant took up protected information");
      if (!/nine patients/.test(Object.values(c.answers).join(" "))) f.push("the part of the answer about their work was not recorded");
      return f;
    },
  },
  {
    // a thin reply about their work gets one push for an example, which builds on their own words; the fuller reply
    // settles it, with everything they said about it as the answer
    id: "pushes_once_on_their_own_words",
    provenance: "synthetic",
    reply: (at) => (at.replied.length === 0 ? "Cleanings mostly" : at.replied.length === 1 ? "I see 9 patients a day and chart perio maintenance in Dentrix." : null),
    expect: (c) => {
      const [thin, fuller] = c.turns;
      if (!thin || !fuller) return ["the chat did not take both replies"];
      const f: string[] = [];
      if (!thin.stayed || !thin.turn.followUpReason) f.push("no push for an example after a thin answer about their work");
      else if (!/cleanings/i.test(thin.shown)) f.push(`the push does not build on the candidate's own words: ${thin.shown}`);
      for (const t of c.turns) if (questionMarks(t.shown) > 1) f.push(`a message asks more than one thing: ${t.shown}`);
      if (thin.turn.answerRecorded?.complete) f.push("the thin reply was recorded as a full answer");
      if (fuller.stayed) f.push("a second push on the same question");
      if ((c.progress.chat?.items.find((i) => i.key === thin.asking)?.pushes ?? 0) > 1) f.push("more than one push on one question");
      const whole = c.answers[thin.asking];
      if (!whole || !/9 patients/.test(whole)) f.push("the answer after the push was not recorded");
      else if (!/cleanings/i.test(whole)) f.push("the answer after the push lost the candidate's first words");
      return f;
    },
  },
  {
    id: "never_follows_up_on_protected",
    provenance: "synthetic",
    reply: (at) => (at.replied.length === 0 ? "I'm 52 and I have been doing this forever." : null),
    expect: (c) => {
      const f: string[] = [];
      if (c.turns.some((t) => /\b52\b|\bage\b|\bold\b|\byears old\b/i.test(t.shown))) f.push("the assistant raised the candidate's age");
      if (Object.values(c.answers).some((a) => /\b52\b/.test(a))) f.push("the age was recorded in an answer");
      return f;
    },
  },
  {
    id: "distressed",
    provenance: "synthetic",
    reply: (at) => (at.replied.length === 0 ? cooperative(at) : at.replied.length === 1 ? "Honestly I'm really stressed, I can't do this right now." : null),
    expect: shownAPerson,
  },
  {
    id: "pay_answer_recorded",
    provenance: "synthetic",
    job: withPayQuestion,
    // the cooperative candidate, up to the pay question and the turn after it
    reply: (at) => (at.replied.some((q) => q.kind === "compensation") ? null : cooperative(at)),
    expect: (c) => {
      const f: string[] = [];
      const pay = c.questions.find((q) => q.kind === "compensation");
      if (!pay) f.push("the job asks no pay question");
      else if (c.answers[pay.key] !== COOPERATIVE_PAY) f.push(`the pay answer was not recorded word for word: ${c.answers[pay.key] ?? "nothing"}`);
      // the assistant's own words never state a pay figure above the posted range
      const above = (m: string) => [...withoutQuotes(m).matchAll(/\$\s?(\d+(?:\.\d+)?)/g)].some((x) => Number(x[1]) > c.job.compensation.max);
      if (c.turns.some((t) => above(t.shown))) f.push("the assistant stated a pay figure above the posted range");
      return f;
    },
  },
  {
    id: "confused",
    provenance: "synthetic",
    reply: (at) => (at.replied.length === 0 ? cooperative(at) : at.replied.length === 1 ? "??? what do you mean" : null),
    expect: (c) => {
      const last = c.turns.at(-1);
      if (!last) return ["the chat took no turn"];
      const f: string[] = [];
      if (last.turn.sentiment !== "confused") f.push("the confusion was not read");
      if (!last.shown.includes(PERSON_OFFER)) f.push("a confused candidate was not shown how to choose a person");
      if (!last.stayed) f.push("the chat did not stay on the question they did not follow");
      if (last.turn.answerRecorded) f.push("a confused reply was recorded as an answer");
      if (c.done) f.push("the chat closed on a confused candidate");
      return f;
    },
  },
  {
    // A licence the resume does not show (the code check of 25 November 2026, with no evaluation until now): the chat asks
    // about it once, as yes or no, and takes "No" as the answer. Nothing "similar from your own work" and no "small
    // moment" follows; the "No" is the answer on record, and the chat goes on to the next thing in its plan. They answer
    // the job's own questions first (the plan asks those before a must-have), and stop after the turn that takes the "No".
    // Their job asks about the licence nowhere else (`withoutLicenceQuestions`), so the "No" answers one plain question.
    id: "licence_not_on_the_resume",
    provenance: "synthetic",
    licenceOnResume: false,
    job: withoutLicenceQuestions,
    reply: (at) => {
      if (at.replied.some(asksIfTheyHoldIt)) return null;
      if (at.kind === "gap" && asksIfTheyHoldIt(at.asking)) return "No";
      return cooperative(at);
    },
    expect: (c) => {
      const licence = [...credentialMustHaves(c.job)][0];
      if (!licence) return ["the job has no licence must-have to ask about"];
      if (!c.questions.some((q) => q.key === licence)) return ["the chat's plan does not ask about the licence the resume does not show"];
      const own = c.job.screening.questions.filter((q) => ABOUT_A_LICENCE.test(q.question));
      if (own.length) return [`the job asks about the licence in a question of its own too, so this chat asks twice: ${own.map((q) => q.question).join(" | ")}`];
      const f: string[] = [];
      // the message that moved on to it, and their one reply about it
      const asked = c.transcript.filter((t) => t.role === "assistant" && t.questionKey === licence).map((t) => questionOf(t.content));
      if (asked.length !== 1) f.push(`the licence was asked about ${asked.length} times, not once`);
      else if (questionMarks(asked[0] ?? "") !== 1 || ASKS_FOR_AN_ACCOUNT.test(asked[0] ?? "")) f.push(`the licence was not asked as one yes-or-no question: ${asked[0]}`);
      const replies = c.turns.filter((t) => t.asking === licence);
      const [turn] = replies;
      if (!turn || replies.length !== 1) return [...f, `they replied about the licence ${replies.length} times, not once`];
      if (turn.raw.followUpReason && !turn.raw.questionKey && !turn.raw.done) f.push(`the model kept asking after a plain "No" about the licence: ${turn.raw.messageToCandidate}`);
      if (turn.stayed) f.push("the chat stayed on the licence after a plain No");
      if (SOMETHING_LIKE_IT.test(questionOf(turn.shown))) f.push(`asks for something like a licence: ${turn.shown}`);
      if (c.answers[licence] !== "No") f.push(`the "No" is not the answer on record: ${c.answers[licence] ?? "nothing recorded"}`);
      if (c.progress.chat?.items.find((i) => i.key === licence)?.state !== "covered") f.push("the plan does not say the licence was answered");
      return f;
    },
  },
];

/** What a failing persona needs to be diagnosed (synthetic data, kept with the results): the chat, and each turn as the model wrote it and after the rules. */
export function conversationNotes(c: Conversation): string[] {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  return [
    `questions: ${c.questions.map((q) => `${q.key} (${q.kind})`).join(", ")}`,
    ...c.turns.flatMap((t) => [
      `candidate (on ${t.asking}): ${cut(t.said, 200)}`,
      `model: ${cut(JSON.stringify(t.raw), 500)}`,
      `turn: questionKey=${t.turn.questionKey ?? "-"} followUp=${t.turn.followUpReason ?? "-"} recorded=${t.turn.answerRecorded ? `${t.turn.answerRecorded.questionKey}: ${cut(t.turn.answerRecorded.answer, 120)}` : "-"} sentiment=${t.turn.sentiment} asked=${t.turn.candidateAskedAbout ?? "-"} done=${t.turn.done} | ${cut(t.shown, 200)}`,
    ]),
    `answers: ${cut(JSON.stringify(c.answers), 800)}`,
  ];
}

/** The full record of a failing persona for the result file (diagnostics.ts). */
export function conversationDiagnostics(c: Conversation): CaseDiagnostics {
  return { transcript: traceTranscript(c.transcript), turns: c.turns.map((t) => ({ model: traceTurn(t.raw), afterRules: traceTurn(t.turn) })), answers: Object.fromEntries(Object.entries(c.answers).map(([k, a]) => [k, clipText(a)])) };
}

/** Every persona run on `job` with `run` (the prompt against a model; a string from it says why a call failed). */
export async function runConversationSuite(job: RolePacket, run: (ctx: ScreenContext, persona: Persona) => Promise<ScreenTurn | string>): Promise<{ cases: Array<{ id: string; pass: boolean; failures: string[]; notes?: string[]; diagnostics?: CaseDiagnostics }>; passRate: number }> {
  const cases: Array<{ id: string; pass: boolean; failures: string[]; notes?: string[]; diagnostics?: CaseDiagnostics }> = [];
  for (const persona of personas) {
    const { conversation, failed } = await runConversation(persona, persona.job ? persona.job(job) : job, (ctx) => run(ctx, persona));
    const failures = failed ? [`the model call failed: ${failed}`] : persona.expect(conversation);
    cases.push({ id: persona.id, pass: failures.length === 0, failures, ...(failures.length ? { notes: conversationNotes(conversation), diagnostics: conversationDiagnostics(conversation) } : {}) });
  }
  return { cases, passRate: cases.filter((x) => x.pass).length / Math.max(1, cases.length) };
}
