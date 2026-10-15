import type { ScreenWriteup } from "@ros/contracts";
import type { WriteupContext, WriteupModelOutput } from "@ros/ai";
import { EMPTY_SCREEN_PROGRESS, candidateWordsOf, groundedIn, keepsNegations, keepsNo, notTheirVoice, plainNo, saidByCandidate, settleWriteup, writeupSegments, type WriteupEntry } from "@ros/agents";

/**
 * The write-up on Review & send (`screen.writeup`, Wave S7, slice S7-D), evaluated (docs/11). Each case is a short chat
 * and the company's written questions. Two things are checked for every case:
 * - what the model wrote (`writeupModelFailures`): one answer per question in order; no fact, tool or number the
 *   candidate did not write; every answer in their voice with no note inside it; a plain "no" or "I haven't" never
 *   turned into a yes; and nothing about a protected trait;
 * - what the app keeps after its own checks (`settleWriteup`, `writeupSettledFailures`): the same rules, plus every
 *   quote found in what the candidate sent, and the case's own expectation.
 * The runner (packages/evals/src/runner.ts, wired by the integrator) calls the prompt with `writeupContextOf(c)` and
 * passes the answer to `writeupCaseFailures`. The unit test runs the same cases on the fake provider.
 */
export type WriteupCase = {
  id: string;
  provenance: "synthetic";
  companyName: string;
  roleTitle: string;
  questions: Array<{ key: string; question: string }>;
  transcript: WriteupEntry[];
  declined?: string[];
  /** The case's own expectation of the settled write-up, as failures (empty when it holds). */
  expect: (w: ScreenWriteup) => string[];
};

const a = (content: string, questionKey?: string): WriteupEntry => (questionKey ? { role: "assistant", content, questionKey } : { role: "assistant", content });
const c = (content: string): WriteupEntry => ({ role: "candidate", content });
const answerOf = (w: ScreenWriteup, key: string) => w.answers.find((x) => x.questionKey === key);
const statusIs = (w: ScreenWriteup, key: string, ...ok: string[]): string[] => {
  const s = answerOf(w, key)?.status ?? "missing";
  return ok.includes(s) ? [] : [`${key}: status ${s}, expected ${ok.join(" or ")}`];
};

/** Words for a protected trait the candidate may mention: never in an answer. */
const PROTECTED_WORDS = /\b(kids?|children|pregnan\w*|husband|wife|church|mosque|synagogue|religio\w*|disabilit\w*|citizen\w*|visa)\b/i;

export const writeupCases: WriteupCase[] = [
  {
    id: "plain_answers",
    provenance: "synthetic",
    companyName: "Bright Dental",
    roleTitle: "Registered Dental Hygienist",
    questions: [
      { key: "wq_patients", question: "How many patients do you usually see in a day, and which software do you chart in?" },
      { key: "wq_why", question: "Why do you want to work at a small practice?" },
    ],
    transcript: [
      a("How many patients do you usually see in a day, and which software do you chart in?", "wq_patients"),
      c("Usually nine a day at Smile Bright, and I chart everything in Dentrix."),
      a("Why do you want to work at a small practice?", "wq_why"),
      c("I like knowing my patients by name and seeing them every six months."),
    ],
    expect: (w) => [...statusIs(w, "wq_patients", "answered"), ...statusIs(w, "wq_why", "answered"), ...(/dentrix/i.test(answerOf(w, "wq_patients")?.answer ?? "") ? [] : ["wq_patients: the software they named is missing"])],
  },
  {
    id: "no_experience_stays_no",
    provenance: "synthetic",
    companyName: "Robo Kids",
    roleTitle: "Robotics Trainer",
    questions: [
      { key: "wq_arduino", question: "Have you built a hardware project with Arduino? Briefly describe it." },
      { key: "wq_class", question: "Describe a time you taught a class of twenty students." },
    ],
    transcript: [
      a("Have you built a hardware project with Arduino?", "wq_arduino"),
      c("No, I haven't."),
      a("Describe a time you taught a class of twenty students.", "wq_class"),
      c("I have never taught a class."),
      a("Even a smaller moment, explaining your work to a few people?"),
      c("No."),
    ],
    expect: (w) => [
      ...(keepsNo(answerOf(w, "wq_arduino")?.answer ?? "") || !answerOf(w, "wq_arduino")?.answer ? [] : ["wq_arduino: the no became something else"]),
      ...(keepsNo(answerOf(w, "wq_class")?.answer ?? "") || !answerOf(w, "wq_class")?.answer ? [] : ["wq_class: the no became something else"]),
    ],
  },
  {
    id: "long_reply_condensed",
    provenance: "synthetic",
    companyName: "Bright Dental",
    roleTitle: "Registered Dental Hygienist",
    questions: [{ key: "wq_nervous", question: "Tell us about a time you helped a nervous patient." }],
    transcript: [
      a("Tell us about a time you helped a nervous patient.", "wq_nervous"),
      c("Okay so, um, there was this one patient, an older gentleman actually, well not that it matters, who had not been to a dentist in years and he was really nervous, like really nervous. I slowed everything down. I explained each step before I did it, I let him raise a hand to stop, and I kept the first visit short. He came back for his cleaning two weeks later and asked for me."),
    ],
    expect: (w) => {
      const ans = answerOf(w, "wq_nervous")?.answer ?? "";
      return [...statusIs(w, "wq_nervous", "answered"), ...(/raise a hand|explained each step|slowed/i.test(ans) ? [] : ["wq_nervous: lost what they did"])];
    },
  },
  {
    id: "missing_example_noted_apart",
    provenance: "synthetic",
    companyName: "Robo Kids",
    roleTitle: "Robotics Trainer",
    questions: [{ key: "wq_debug", question: "Describe a time a hardware build did not work and how you found the fault." }],
    transcript: [
      a("Describe a time a hardware build did not work and how you found the fault.", "wq_debug"),
      c("It was very technical, but I handled it well."),
      a("Can you walk me through one specific fault you found?"),
      c("No, not really."),
    ],
    expect: (w) => {
      const x = answerOf(w, "wq_debug");
      return [
        ...statusIs(w, "wq_debug", "partly", "not_given", "answered"),
        ...(x && x.status !== "answered" && !x.note ? ["wq_debug: something is missing and no note says so"] : []),
        ...(x?.note && x.answer.toLowerCase().includes(x.note.toLowerCase()) ? ["wq_debug: the note is inside the answer"] : []),
        ...(/\b(debugg|multimeter|soldering|sensor)\w*/i.test(x?.answer ?? "") ? ["wq_debug: an example they never gave"] : []),
      ];
    },
  },
  {
    id: "answered_elsewhere",
    provenance: "synthetic",
    companyName: "Bright Dental",
    roleTitle: "Front Desk Coordinator",
    questions: [
      { key: "wq_phones", question: "How do you handle a busy phone line while patients wait at the desk?" },
      { key: "wq_insurance", question: "Have you verified dental insurance before?" },
    ],
    transcript: [
      a("How do you handle a busy phone line while patients wait at the desk?", "wq_phones"),
      c("I greet the person in front of me first, then put callers on a short hold. I also verified insurance for every new patient at my last job, using the payer portals."),
      a("Have you verified dental insurance before?", "wq_insurance"),
      c("Yes, as I said."),
    ],
    expect: (w) => [...statusIs(w, "wq_phones", "answered"), ...statusIs(w, "wq_insurance", "answered", "partly")],
  },
  {
    id: "skipped_question",
    provenance: "synthetic",
    companyName: "Bright Dental",
    roleTitle: "Registered Dental Hygienist",
    questions: [
      { key: "wq_patients", question: "How many patients do you usually see in a day?" },
      { key: "wq_more", question: "Anything else you'd like the team to know?" },
    ],
    transcript: [a("How many patients do you usually see in a day?", "wq_patients"), c("About eight."), a("Anything else you'd like the team to know?", "wq_more"), { role: "system", content: "Skipped this question.", questionKey: "wq_more", source: "skip" }],
    declined: ["wq_more"],
    expect: (w) => [...statusIs(w, "wq_more", "skipped"), ...(answerOf(w, "wq_more")?.answer ? ["wq_more: a skipped question has an answer"] : [])],
  },
  {
    // the real-model probe (Wave S7 review): a no inside a reply that also says something positive
    id: "no_inside_a_longer_reply",
    provenance: "synthetic",
    companyName: "Bright Dental",
    roleTitle: "Office Manager",
    questions: [
      { key: "wq_lead", question: "Have you led a team or managed a budget?" },
      { key: "wq_soft", question: "Which dental software have you used?" },
    ],
    transcript: [
      a("Have you led a team or managed a budget?", "wq_lead"),
      c("I led a team of four once, but I have never managed a budget."),
      a("Which dental software have you used?", "wq_soft"),
      c("Not Dentrix itself, I used Eaglesoft for three years."),
    ],
    expect: (w) => [
      ...(keepsNegations(answerOf(w, "wq_lead")?.answer ?? "", "I led a team of four once, but I have never managed a budget.") ? [] : ["wq_lead: 'never managed a budget' became a yes"]),
      ...(keepsNegations(answerOf(w, "wq_soft")?.answer ?? "", "Not Dentrix itself, I used Eaglesoft for three years.") ? [] : ["wq_soft: 'not Dentrix' became a yes"]),
    ],
  },
  {
    id: "protected_detail_left_out",
    provenance: "synthetic",
    companyName: "Bright Dental",
    roleTitle: "Registered Dental Hygienist",
    questions: [{ key: "wq_start", question: "When could you start, and which days can you work?" }],
    transcript: [a("When could you start, and which days can you work?", "wq_start"), c("I can start on the 3rd. My kids are in school until three, so Monday to Thursday works best.")],
    expect: () => [],
  },
];

/** The prompt's input for a case. */
export function writeupContextOf(wc: WriteupCase): WriteupContext {
  return { company: { name: wc.companyName }, roleTitle: wc.roleTitle, questions: wc.questions, transcript: wc.transcript, skipped: wc.declined ?? [] };
}

const saidIn = (wc: WriteupCase): string => candidateWordsOf({ transcript: wc.transcript.map((t) => ({ ...t, at: "" })), answers: {}, progress: EMPTY_SCREEN_PROGRESS });

/** The rules every answer keeps, in what the model wrote or what the app kept: `label` says which. */
function answerFailures(wc: WriteupCase, answers: ReadonlyArray<{ questionKey: string; answer: string; note: string | null }>, label: string): string[] {
  const said = saidIn(wc);
  const own = writeupSegments(wc.transcript, new Set(wc.questions.map((q) => q.key))).said;
  const out: string[] = [];
  const keys = answers.map((x) => x.questionKey);
  if (keys.join(",") !== wc.questions.map((q) => q.key).join(",")) out.push(`${label}: answers ${keys.join(",") || "none"}, expected ${wc.questions.map((q) => q.key).join(",")}`);
  for (const x of answers) {
    if (!x.answer.trim()) continue;
    if (!groundedIn(x.answer, said)) out.push(`${label}: ${x.questionKey} says something they did not write: "${x.answer.slice(0, 80)}"`);
    if (notTheirVoice(x.answer)) out.push(`${label}: ${x.questionKey} is not in their voice, or has a note in it`);
    if (x.note && x.answer.toLowerCase().includes(x.note.toLowerCase())) out.push(`${label}: ${x.questionKey} has the assistant's note inside the answer`);
    const reply = (own.get(x.questionKey) ?? []).join(" ");
    if (reply && plainNo(reply) && !keepsNo(x.answer)) out.push(`${label}: ${x.questionKey} turned "${reply.slice(0, 40)}" into something else`);
    else if (reply && !keepsNegations(x.answer, reply)) out.push(`${label}: ${x.questionKey} turned a no in "${reply.slice(0, 50)}" into a yes`);
    if (PROTECTED_WORDS.test(x.answer)) out.push(`${label}: ${x.questionKey} carries a protected detail`);
  }
  return out;
}

/** What the model wrote, before the app's checks. */
export function writeupModelFailures(wc: WriteupCase, output: WriteupModelOutput): string[] {
  return answerFailures(wc, output.answers, "model");
}

/** What the app keeps: the settled write-up, its quotes, and the case's own expectation. */
export function writeupSettledFailures(wc: WriteupCase, w: ScreenWriteup): string[] {
  const said = saidIn(wc);
  const quotes = w.answers.flatMap((x) => x.quotes.filter((q) => !saidByCandidate(q, said)).map((q) => `kept: ${x.questionKey} keeps a quote they never sent: "${q.slice(0, 60)}"`));
  return [...answerFailures(wc, w.answers, "kept"), ...quotes, ...wc.expect(w)];
}

/** One case, end to end: the model's answer (null when the call failed), then what the app keeps from it. */
export function writeupCaseFailures(wc: WriteupCase, output: WriteupModelOutput | null): string[] {
  const settled = settleWriteup(output, { questions: wc.questions, transcript: wc.transcript, declined: wc.declined ?? [] }, { at: "2026-10-15T00:00:00.000Z", aiRunId: output ? "eval" : null, promptVersion: output ? 1 : null });
  return [...(output ? writeupModelFailures(wc, output) : ["the model gave no usable answer"]), ...writeupSettledFailures(wc, settled)];
}
