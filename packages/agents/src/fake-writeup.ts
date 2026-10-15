import type { StructuredRequest, WriteupModelOutput } from "@ros/ai";
import { draftWriteup, type WriteupEntry } from "./screen-writeup";

/**
 * The fake provider's `screen.writeup` (Wave S7, slice S7-D; contract in scratchpad kanvis-2/s7-contracts.md): reads the
 * prompt's own message back (the questions, the skips and the tagged transcript lines that `writeupLine` writes) and
 * returns the code draft, the candidate's own replies to each question as they wrote them, with the "not given" note
 * where the chat holds none. Deterministic, so the tests and the evaluations run without a model.
 */
export function fakeScreenWriteup(req: StructuredRequest<unknown>): WriteupModelOutput {
  const text = req.messages[0]?.content ?? "";
  const questions = listOf(text.match(/Questions \(JSON\): (\[.*\])\n/)?.[1]).filter((q): q is { key: string } => !!q && typeof (q as { key?: unknown }).key === "string");
  const skipped = listOf(text.match(/Skipped \(JSON\): (\[.*\])\n/)?.[1]).filter((k): k is string => typeof k === "string");
  const body = text.match(/<transcript>\n([\s\S]*?)\n<\/transcript>/)?.[1] ?? "";
  const entries = body.split("\n").map(entryOf).filter((e): e is WriteupEntry => e !== null);
  return draftWriteup(questions, entries, skipped);
}

function listOf(json: string | undefined): unknown[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const LINE = /^(assistant|candidate|system)(?: \[(asks|answers|changed|skipped) ([A-Za-z0-9_-]+)\])?: (.*)$/;

/** One tagged line back into the parts of a transcript entry the draft reads. */
function entryOf(line: string): WriteupEntry | null {
  const m = LINE.exec(line);
  if (!m) return null;
  const role = m[1] as "assistant" | "candidate" | "system";
  const tag = m[2];
  const questionKey = m[3];
  const content = m[4] ?? "";
  if (tag === "skipped") return { role: "system", content, questionKey, source: "skip" };
  if (tag === "changed") return { role, content, questionKey, source: "edit" };
  if (tag === "answers") return { role, content, questionKey, source: "tap" };
  return questionKey ? { role, content, questionKey } : { role, content };
}
