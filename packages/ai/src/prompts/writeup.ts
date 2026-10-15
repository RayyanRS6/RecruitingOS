import { z } from "zod";
import type { ScreenTranscriptEntry, WrittenQuestionView } from "@ros/contracts";
import { FAIRNESS_RULES, withoutTag, type PromptDef } from "./registry";

/**
 * Wave S7, slice S7-D: the write-up on Review & send (scratchpad kanvis-2/s7-contracts.md, section 2c). From the chat a
 * candidate is about to send, one answer per written question (`writtenQuestionsOf` in @ros/core), in the candidate's
 * own words, lightly condensed and in the first person, with the pieces of their messages it rests on, and, kept apart,
 * a short note only when something is missing. The candidate reads it first and can change any of it; the team reads it
 * only after Send. Code checks every answer afterwards (`settleWriteup` in packages/agents): quotes against what the
 * candidate sent, no fact they did not write, no note inside an answer, and a "no" never turned into a "yes". The
 * private "what a good answer shows" (`lookFor`) is never given to this prompt: its note is read by the candidate.
 */
export type WriteupContext = {
  company: { name: string };
  roleTitle: string;
  /** The written questions in order, without their private `lookFor`. */
  questions: ReadonlyArray<Pick<WrittenQuestionView, "key" | "question">>;
  /** The conversation as the candidate had it (a recruiter's call notes are left out here). */
  transcript: ReadonlyArray<Pick<ScreenTranscriptEntry, "role" | "content" | "questionKey" | "source">>;
  /** Questions the candidate skipped (`progress.declined`). */
  skipped: readonly string[];
};

/**
 * What the model writes. Every field is required (a "skipped" status is the code's to set, from the skips on record):
 * `answer` is "" when the chat has none; `note` is null unless something is missing.
 */
export const WriteupModelOutput = z.object({
  answers: z
    .array(
      z.object({
        questionKey: z.string().min(1).max(100),
        answer: z.string().max(2000),
        status: z.enum(["answered", "partly", "not_given"]),
        quotes: z.array(z.string().min(1).max(500)).max(6),
        note: z.string().max(300).nullable(),
      }),
    )
    .max(20),
});
export type WriteupModelOutput = z.infer<typeof WriteupModelOutput>;

/**
 * One line of the conversation for this prompt, on one line (whitespace inside a message is folded), tagged with the
 * question it is about when the record says so: `assistant [asks k]`, `candidate [answers k]` (a tapped answer),
 * `candidate [changed k]` (an answer changed on the check page), `system [skipped k]`. The fake provider reads the same
 * tags back (packages/agents/src/fake-writeup.ts).
 */
export function writeupLine(t: Pick<ScreenTranscriptEntry, "role" | "content" | "questionKey" | "source">): string | null {
  if (t.role === "recruiter" || t.source === "recruiter_call") return null;
  const words = t.content.replace(/\s+/g, " ").trim();
  const key = t.questionKey;
  if (t.role === "system") return t.source === "skip" && key ? `system [skipped ${key}]: (the candidate skipped this question)` : `system: ${words}`;
  if (t.role === "assistant") return key ? `assistant [asks ${key}]: ${words}` : `assistant: ${words}`;
  if (t.source === "edit" && key) return `candidate [changed ${key}]: ${words}`;
  if (t.source === "tap" && key) return `candidate [answers ${key}]: ${words}`;
  return `candidate: ${words}`;
}

const WRITEUP_SYSTEM = `You write up a job candidate's answers to a company's written questions, from the short written chat they just had with the company's AI assistant. The candidate reads your write-up first and can change any of it before sending; after they send it, the hiring team reads it next to the chat itself.

Rules:
- Exactly one entry per question in the list, by its key, in the list's order.
- answer: the candidate's own answer to that question in the first person ("I ..."), in their own words, lightly condensed: keep their facts, numbers, names, examples and wording; leave out filler, repetition and greetings. Use only what the candidate wrote (lines starting "candidate"). Never add a fact, skill, number, example, tool, opinion or feeling they did not write, never improve or praise it, and never grade it. The assistant's lines are questions, not the candidate's words: nothing from them goes into an answer as if the candidate said it.
- An answer can come from anywhere in the chat: the reply to that question, a reply to another one, or a later message that added to it. When the candidate changed an answer ("candidate [changed key]"), the changed words are their answer.
- "No", "Not yet", "I haven't", "I don't know" and "I've never done that" stay what they are: say so plainly in the answer ("No, I have not ..."). Never turn a no, a not yet or an unknown into a yes, and never infer experience or ability they did not describe.
- status: "answered" when their words answer the question; "partly" when they answer some of it and not the rest (for example the question asks for an example and they gave none); "not_given" when the chat holds no answer to it, and then answer is "".
- quotes: up to 6 pieces copied character for character from the candidate's lines that the answer rests on, each a few words to a sentence. Code checks every quote against what the candidate sent and drops any it cannot find.
- note: null when the answer is complete. Only for "partly" or "not_given", one short neutral sentence in your own voice saying what is missing, for example "No example was given of a time this happened." Never inside the answer, never a judgement of the candidate, never advice, never about anything the question did not ask, and never about what the team is looking for. The candidate reads it.
- A question listed as skipped that the candidate never answered: status "not_given", answer "", note null.
- Leave out anything about age, family, health, pregnancy, religion, national origin, citizenship or any other protected characteristic the candidate may have mentioned: it is never part of an answer.

${FAIRNESS_RULES}`;

// Version 1 (Wave S7, 15 Oct 2026): first version.
export const screenWriteupPrompt: PromptDef<WriteupContext, WriteupModelOutput> = {
  key: "screen.writeup",
  version: 1,
  task: "screen.writeup",
  agent: "screening",
  schema: WriteupModelOutput,
  system: () => [{ text: WRITEUP_SYSTEM, cache: true }],
  messages: (ctx) => {
    const questions = JSON.stringify(ctx.questions.map((q) => ({ key: q.key, question: q.question })));
    const lines = ctx.transcript.map(writeupLine).filter((l): l is string => l !== null).join("\n");
    return [
      {
        role: "user",
        content: `Company: ${ctx.company.name}. Role: ${ctx.roleTitle}.\n\nQuestions (JSON): ${withoutTag(questions, "transcript")}\nSkipped (JSON): ${JSON.stringify(ctx.skipped)}\n\n<transcript>\n${withoutTag(lines, "transcript") || "(no messages)"}\n</transcript>\n\nWrite up one answer per question.`,
      },
    ];
  },
};
