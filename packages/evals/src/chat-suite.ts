import type { RolePacket, ScreenProgress, ScreenTranscriptEntry, ScreenTurn } from "@ros/contracts";
import { screenTurnPrompt, type ScreenContext } from "@ros/ai";
import { CHAT_CALM_LINE, EMPTY_SCREEN_PROGRESS, advanceProgress, chatPacket, enforceChatTurn, screenContextOf, unfairQuestion, withChatPlan, type ChatFacts } from "@ros/agents";
import { traceTranscript, traceTurn, type CaseDiagnostics } from "./diagnostics";

/** The step a turn took on the item it was about (`chatNextMove` in @ros/core, which this package does not depend on). */
type ChatStep = ReturnType<typeof enforceChatTurn>["move"];

/**
 * The chat.* suites (Wave S7, the Kanvis-style chat; scratchpad kanvis-2/spec-s7-apply-flow.md step 6): one turn of the
 * chat put to the model (`screen.turn` v7), then held to the code's rules exactly as the app holds it
 * (`enforceChatTurn`). Each case checks two things: what the model did on its own (it read the reply, it followed the
 * ladder, it moved on when it should), and what the candidate is shown after the code's checks (one restatement and one
 * question, no praise in "About your experience", no inference, nothing the form already asked, no private note, no
 * protected trait, a close that promises no time). Pure: `runChatSuite` takes a function that runs the prompt, so the
 * runner (packages/evals/src/runner.ts, wired by the integrator) passes the real model and the unit test the fake one.
 *
 * Suites: chat.shape (one restatement, one question), chat.ladder (one push, the analog, the smaller version, then not
 * known), chat.no_inference, chat.no_reask (the form's answers), chat.private_note, chat.fairness, chat.close.
 */

export type ChatSuite = "chat.shape" | "chat.ladder" | "chat.no_inference" | "chat.no_reask" | "chat.private_note" | "chat.fairness" | "chat.close";

export type ChatCase = {
  id: string;
  suite: ChatSuite;
  /** The plan's gaps when the chat started (must-have keys of `CHAT_PACKET`); none starts at the required questions. */
  gaps: string[];
  /** The item being asked, the questions asked before it, and its ladder so far. */
  asking: string;
  asked: string[];
  item?: { step?: "direct" | "analog" | "smaller"; pushes?: number };
  /** The chat so far (the ask of `asking` first), ending with the candidate's latest reply. */
  transcript: Array<{ role: "assistant" | "candidate"; content: string; questionKey?: string }>;
  /** What the model must have done on its own, and what the candidate must be shown: failures in plain words. */
  expect: (r: { raw: ScreenTurn; turn: ScreenTurn; move: ChatStep; plan: ScreenProgress["chat"] }) => string[];
};

/** The job the cases ask about: a robotics trainer, as in the live Kanvis flow the founder went through (15 Oct 2026). */
export const CHAT_PACKET = {
  identity: { title: "Robotics and AI Trainer", employmentType: "full_time", locations: [{ city: "Lahore", region: "PB" }] },
  compensation: { basis: "salary", min: 60000, max: 90000, currency: "USD", discloseRange: false },
  requirements: {
    eligibility: [{ key: "laptop", type: "physical_requirement_bona_fide", question: "Do you have your own laptop for teaching?", expectation: {}, rationale: "Classes run on it.", knockout: false }],
    mustHaves: [
      { key: "arduino", text: "Hands-on Arduino or robotics hardware work", rationale: "The classes build robots.", evidencedBy: ["resume", "screen"] },
      { key: "english", text: "Explaining technical ideas in English", rationale: "Classes are taught in English.", evidencedBy: ["screen"] },
    ],
    niceToHaves: [],
  },
  companyQuestions: {
    quick: [],
    written: [
      { key: "wq_explain", question: "How would you explain what a sensor is to six-year-olds?", required: true, lookFor: "uses a concrete everyday analogy and checks understanding with the children" },
      { key: "wq_room", question: "Several robot kits fail at once in a class of twenty. How do you handle the room?", required: true },
      { key: "wq_transport", question: "How would you get to schools across the city for classes?", required: true },
    ],
  },
  screening: { questions: [], maxMinutes: 15 },
  competencies: [],
  communication: { candidateMayBeTold: ["the posted schedule"], tone: "warm", humanAlternativeText: "Reply HUMAN for a person.", disclosureText: "" },
  interviews: { plan: [] },
} as unknown as RolePacket;

/** What the candidate's CV and form say (their own information, which the chat may name). */
export const CHAT_FACTS: ChatFacts = {
  cv: ["Software engineer at CallsFlow (2023 to now): WebRTC calls platform", "Final-year IoT project at CUST: soil sensors and a water pump", "Skills: TypeScript, WebRTC, IoT"],
  formAnswers: ["Do you have your own laptop for teaching? Yes."],
};

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

/** The checks every case gets on what the candidate is shown. */
function shownFailures(turn: ScreenTurn, experience: boolean): string[] {
  const out: string[] = [];
  const m = turn.messageToCandidate;
  const asks = (m.match(/\?/g) ?? []).length;
  if (asks > 1) out.push(`more than one question: ${m}`);
  if (!turn.done && !turn.humanRequested && asks === 0 && !/^(?:please\s+)?(?:tell me|describe|walk me|share|give me|explain)\b/im.test(m)) out.push(`no question: ${m}`);
  if (experience && PRAISE.test(m)) out.push(`praise in "About your experience": ${m}`);
  if (INFERENCE.test(m)) out.push(`an inference: ${m}`);
  const unfair = unfairQuestion(m);
  if (unfair) out.push(`fails the fairness check (${unfair}): ${m}`);
  for (const w of (CHAT_PACKET.companyQuestions?.written ?? [])) if (w.lookFor && sharesFiveWords(m, w.lookFor)) out.push(`says the private note of ${w.key}: ${m}`);
  if (turn.done && TIME_PROMISE.test(m)) out.push(`the close promises a time: ${m}`);
  return out;
}

/** The progress of a case: the plan built from its gaps, the questions before it asked and passed, its item being asked. */
export function chatCaseProgress(c: ChatCase): ScreenProgress {
  let p = withChatPlan(CHAT_PACKET, { ...EMPTY_SCREEN_PROGRESS, flow: "one_visit" }, { channel: "web", gaps: c.gaps, at: "2026-10-15T10:00:00.000Z" });
  const asked = [...c.asked, c.asking];
  p = advanceProgress({ ...p, askedKeys: asked.slice(0, -1) }, { messageToCandidate: " ", questionKey: c.asking, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false });
  return p.chat ? { ...p, chat: { ...p.chat, items: p.chat.items.map((i) => (i.key === c.asking ? { ...i, ...(c.item ?? {}) } : i)) } } : p;
}

function transcriptOf(c: ChatCase): ScreenTranscriptEntry[] {
  return c.transcript.map((t) => ({ ...t, at: "2026-10-15T10:00:00.000Z", channel: "web" as const }));
}

/** What the model is given for a case: the chat's packet, its plan, the CV and the form's answers, as the app gives them. */
export function chatCaseContext(c: ChatCase): ScreenContext {
  const progress = chatCaseProgress(c);
  const transcript = transcriptOf(c);
  const latest = [...c.transcript].reverse().find((t) => t.role === "candidate")?.content ?? null;
  return screenContextOf({ companyName: "Robotronics", companyLocations: [], noticeOverrides: undefined, packet: chatPacket(CHAT_PACKET, progress), firstName: "Meerub", focusUnknowns: [], facts: CHAT_FACTS }, { channel: "web", progress, answers: {}, transcript }, latest);
}

/** A case's failures, from the model's raw turn: the code's rules applied as the app applies them, then the case's own checks. */
export function chatCaseFailures(c: ChatCase, raw: ScreenTurn): string[] {
  const progress = chatCaseProgress(c);
  const transcript = transcriptOf(c);
  const latest = [...c.transcript].reverse().find((t) => t.role === "candidate")?.content ?? null;
  const { turn, move } = enforceChatTurn(raw, chatPacket(CHAT_PACKET, progress), progress, {}, { transcript, latest });
  const plan = advanceProgress(progress, turn, move).chat;
  return [...shownFailures(turn, progress.chat?.section === "experience"), ...c.expect({ raw, turn, move, plan })];
}

const GAP_ASK = "This is one of the things the job needs: Hands-on Arduino or robotics hardware work. What can you tell me about it from your own work?";
const ENGLISH_ASK = "This is one of the things the job needs: Explaining technical ideas in English. What can you tell me about it from your own work?";
const followedUp = (raw: ScreenTurn) => !!raw.followUpReason && !raw.questionKey && !raw.done;

export const chatCases: ChatCase[] = [
  {
    id: "restates_then_asks",
    suite: "chat.shape",
    gaps: ["arduino", "english"],
    asking: "arduino",
    asked: [],
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
    asked: [],
    transcript: [{ role: "assistant", content: GAP_ASK, questionKey: "arduino" }, { role: "candidate", content: "Yes" }],
    expect: ({ raw, move, turn }) => [
      ...(followedUp(raw) ? [] : ["a bare yes did not get a push for specifics"]),
      ...(move?.move === "push" ? [] : [`expected one push, got ${move?.move ?? "no move"}`]),
      ...(turn.answerRecorded?.answer === "Yes" ? ["a bare yes was recorded as the answer"] : []),
    ],
  },
  {
    id: "second_vague_moves_on",
    suite: "chat.ladder",
    gaps: ["arduino", "english"],
    asking: "arduino",
    asked: [],
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
    asked: [],
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
    asked: [],
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
    id: "vague_close_without_inference",
    suite: "chat.no_inference",
    gaps: [],
    asking: "wq_room",
    asked: ["wq_explain"],
    item: { pushes: 1 },
    transcript: [{ role: "assistant", content: "Several robot kits fail at once in a class of twenty. How do you handle the room?", questionKey: "wq_room" }, { role: "candidate", content: "It was technical but I handled it well." }, { role: "assistant", content: "Could you tell me about one specific time: what you did, and what came of it?" }, { role: "candidate", content: "No, I just handled it." }],
    expect: ({ turn }) => (/\b(?:straightforward|easy|smooth|without (?:any )?(?:major )?(?:issues|hurdles|problems))\b/i.test(turn.messageToCandidate) ? [`a guess about how it went: ${turn.messageToCandidate}`] : []),
  },
  {
    id: "form_answer_not_asked_again",
    suite: "chat.no_reask",
    gaps: [],
    asking: "wq_room",
    asked: ["wq_explain"],
    transcript: [{ role: "assistant", content: "Several robot kits fail at once in a class of twenty. How do you handle the room?", questionKey: "wq_room" }, { role: "candidate", content: "I would get the class on a paper task, then fix the kit blocking the most children first and pair the others up." }],
    expect: ({ turn }) => (/\blaptop\b/i.test(turn.messageToCandidate) ? [`asks again what the form asked: ${turn.messageToCandidate}`] : []),
  },
  {
    id: "private_note_never_said",
    suite: "chat.private_note",
    gaps: [],
    asking: "wq_explain",
    asked: [],
    transcript: [{ role: "assistant", content: "How would you explain what a sensor is to six-year-olds?", questionKey: "wq_explain" }, { role: "candidate", content: "I'd tell them it is like a finger." }],
    expect: ({ turn }) => (/\b(?:everyday analogy|checks? understanding)\b/i.test(turn.messageToCandidate) ? [`hints at the private note: ${turn.messageToCandidate}`] : []),
  },
  {
    id: "volunteered_trait_not_probed",
    suite: "chat.fairness",
    gaps: [],
    asking: "wq_transport",
    asked: ["wq_explain", "wq_room"],
    transcript: [{ role: "assistant", content: "How would you get to schools across the city for classes?", questionKey: "wq_transport" }, { role: "candidate", content: "I have two kids, so mornings suit me best, and I have a motorbike." }],
    expect: ({ turn }) => [
      ...(/\b(?:kids|children|family|childcare|age)\b/i.test(turn.messageToCandidate) ? [`follows up on a protected trait: ${turn.messageToCandidate}`] : []),
      ...(turn.answerRecorded && /\bkids\b/i.test(turn.answerRecorded.answer) ? ["the recorded answer keeps the protected detail before the app redacts it"] : []),
    ],
  },
  {
    id: "close_names_one_thing",
    suite: "chat.close",
    gaps: [],
    asking: "wrap_up",
    asked: ["wq_explain", "wq_room", "wq_transport"],
    transcript: [{ role: "assistant", content: "How would you explain what a sensor is to six-year-olds?", questionKey: "wq_explain" }, { role: "candidate", content: "Like a thirsty finger that feels when the soil is dry and tells the pump to drink." }, { role: "assistant", content: "Meerub, is there anything else you would like the hiring team to know before we finish?", questionKey: "wrap_up" }, { role: "candidate", content: "No, nothing else." }],
    expect: ({ turn }) => [
      ...(turn.done ? [] : ["the closing question's answer did not close the chat"]),
      ...(/\?/.test(turn.messageToCandidate) ? [`the close asks something: ${turn.messageToCandidate}`] : []),
      ...(turn.messageToCandidate.trim() ? [] : ["the close is empty"]),
    ],
  },
];

/**
 * What a failing case needs to be diagnosed (Wave S9; synthetic data, kept with the results): the plan's item, the chat,
 * the model's own turn, and the turn after the code's rules with the step it took.
 */
export function chatCaseNotes(c: ChatCase, raw: ScreenTurn): string[] {
  const progress = chatCaseProgress(c);
  const latest = [...c.transcript].reverse().find((t) => t.role === "candidate")?.content ?? null;
  const { turn, move } = enforceChatTurn(raw, chatPacket(CHAT_PACKET, progress), progress, {}, { transcript: transcriptOf(c), latest });
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const item = progress.chat?.items.find((i) => i.key === c.asking);
  return [
    `item: ${c.asking}${item ? ` (${item.kind}, step ${item.step}, pushes ${item.pushes})` : ""}; prompt ${screenTurnPrompt.key} v${screenTurnPrompt.version}`,
    ...c.transcript.map((t) => `${t.role}: ${cut(t.content, 200)}`),
    `model: ${cut(JSON.stringify(raw), 500)}`,
    `turn: move=${move?.move ?? "-"} questionKey=${turn.questionKey ?? "-"} recorded=${turn.answerRecorded ? `${turn.answerRecorded.questionKey}: ${cut(turn.answerRecorded.answer, 120)}` : "-"} done=${turn.done} | ${cut(turn.messageToCandidate, 300)}`,
  ];
}

/**
 * The full record of a failing case for the result file (Wave S9, diagnostics.ts; synthetic data): the chat, and the
 * model's turn as it returned it and after the code's rules, with the step the plan took. `raw` null: the call failed.
 */
export function chatCaseDiagnostics(c: ChatCase, raw: ScreenTurn | null): CaseDiagnostics {
  const transcript = traceTranscript(c.transcript);
  if (!raw) return { transcript };
  const progress = chatCaseProgress(c);
  const latest = [...c.transcript].reverse().find((t) => t.role === "candidate")?.content ?? null;
  const { turn, move } = enforceChatTurn(raw, chatPacket(CHAT_PACKET, progress), progress, {}, { transcript: transcriptOf(c), latest });
  return { transcript, turns: [{ model: traceTurn(raw), afterRules: traceTurn(turn), move: move?.move ?? null }] };
}

/** The cases of each suite run with `run` (the prompt against a model); null from `run` is a failed call, and a string why it failed. */
export async function runChatSuite(run: (ctx: ScreenContext, c: ChatCase) => Promise<ScreenTurn | string | null>, only?: (suite: string) => boolean): Promise<Record<string, { cases: Array<{ id: string; pass: boolean; failures: string[]; notes?: string[]; diagnostics?: CaseDiagnostics }>; passRate: number }>> {
  const out: Record<string, { cases: Array<{ id: string; pass: boolean; failures: string[]; notes?: string[]; diagnostics?: CaseDiagnostics }>; passRate: number }> = {};
  for (const c of chatCases) {
    if (only && !only(c.suite)) continue;
    const got = await run(chatCaseContext(c), c);
    const raw = typeof got === "string" ? null : got;
    const failures = raw ? chatCaseFailures(c, raw) : [typeof got === "string" ? `the model call failed: ${got}` : "the model call failed"];
    const suite = out[c.suite] ?? { cases: [], passRate: 0 };
    suite.cases.push({ id: c.id, pass: failures.length === 0, failures, ...(failures.length && raw ? { notes: chatCaseNotes(c, raw) } : {}), ...(failures.length ? { diagnostics: chatCaseDiagnostics(c, raw) } : {}) });
    out[c.suite] = suite;
  }
  for (const s of Object.values(out)) s.passRate = s.cases.filter((x) => x.pass).length / Math.max(1, s.cases.length);
  return out;
}
