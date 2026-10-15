import {
  CHOICE_OPTIONS_MAX, CHOICE_OPTIONS_MIN, QUICK_QUESTIONS_MAX, WRITTEN_QUESTIONS_MAX,
  type CompanyQuestionRefusal, type CompanyQuestions, type CompanyQuestionsEdit, type QuickQuestion,
} from "@ros/contracts";
import type { RolePacket } from "../../api/client";

/**
 * "Questions every applicant answers" on the job's Scoring tab (Wave S7, apps/web/src/pages/role/ApplicantQuestions.tsx):
 * the rows the editor holds, what the card reads, the first thing wrong in plain words, and the body PUT
 * /roles/:id/company-questions takes. Pure, so apps/shell/components/applicant-questions-ui.test.ts checks it without a
 * browser. The server checks everything again, the fairness check first (a question about a protected characteristic is
 * refused there, with the reason; the page shows it beside the row).
 */

/** The packet as the role page holds it, with the company's questions (the API answers them; older packets have none). */
export type PacketWithQuestions = RolePacket & { companyQuestions?: CompanyQuestions | null };

/** A quick question as the editor holds it. "Yes or no" is a choice of Yes and No that holds nobody. */
export type QuickKind = "yes_no" | "choice" | "number";
export type QuickRow = { key: string | null; kind: QuickKind; question: string; help: string; required: boolean; options: string; unit: string; min: string; max: string };
export type WrittenRow = { key: string | null; question: string; lookFor: string; required: boolean };

export const QUICK_KINDS: ReadonlyArray<{ value: QuickKind; label: string }> = [
  { value: "yes_no", label: "Yes or no" },
  { value: "choice", label: "Choose one" },
  { value: "number", label: "A number" },
];

export const APPLICANT_QUESTIONS_LEDE = "Quick questions are on the application form, for every applicant. Written questions are asked in the chat when the job offers it right after the form, and each answer is written up from the applicant's own words for you to read; a chat sent by email after you review, or by text, asks your screening questions instead. None of them turns anyone down: a person decides.";
export const QUICK_HINT = "One tap or a number each. They never hold an application; only the yes/no questions below that may hold one do, for your decision.";
export const WRITTEN_HINT = "Asked one at a time in the chat. What a good answer shows helps the chat ask well and you read the answers; applicants never see it.";
export const FAIRNESS_LINE = "Each question passes the fairness check before it is saved: questions about age, sex, race, religion, family, health, national origin or a criminal record are refused, with the lawful way to ask about the real need.";
export const SCREENING_FALLBACK_LINE = "You have not set your own written questions, so the chat asks your screening questions. Change them here to set the questions every applicant answers in the chat.";

const YES_NO = ["Yes", "No"];
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const isYesNo = (options: readonly string[]) => options.length === 2 && same(options[0], "Yes") && same(options[1], "No");

export function questionsOf(p: PacketWithQuestions): { quick: CompanyQuestions["quick"]; written: CompanyQuestions["written"] } {
  return { quick: p.companyQuestions?.quick ?? [], written: p.companyQuestions?.written ?? [] };
}

/** Where the chat's written questions come from: the company's own, else the screening questions (as the chat reads them). */
export function writtenSource(p: PacketWithQuestions): "company" | "screening" | "none" {
  if (questionsOf(p).written.length) return "company";
  return p.screening.questions.length ? "screening" : "none";
}

/** The written questions the chat asks, as the card lists them (the same rule as `writtenQuestionsOf` in @ros/core). */
export function writtenList(p: PacketWithQuestions): Array<{ key: string; question: string; required: boolean; lookFor: string | null }> {
  const own = questionsOf(p).written;
  if (own.length) return own.map((q) => ({ key: q.key, question: q.question, required: q.required, lookFor: q.lookFor ?? null }));
  return p.screening.questions.map((q) => ({ key: q.key, question: q.question, required: true, lookFor: null }));
}

/** What may be answered to a quick question, in a few words ("Choose one: Car · Bus · Bike", "A number, in years, 0 to 40"). */
export function quickAnswerWords(q: QuickQuestion): string {
  if (q.kind === "choice") return isYesNo(q.options) ? "Yes or no" : `Choose one: ${q.options.join(" · ")}`;
  const unit = q.unit ? `, in ${q.unit}` : "";
  const range = q.min !== undefined && q.max !== undefined ? `, ${q.min} to ${q.max}` : q.min !== undefined ? `, at least ${q.min}` : q.max !== undefined ? `, at most ${q.max}` : "";
  return `A number${unit}${range}`;
}

/** The yes/no questions that may hold an application (the eligibility questions), first on the form, as the card lists them. */
export function eligibilityList(p: RolePacket): Array<{ key: string; question: string; holds: boolean }> {
  return p.requirements.eligibility.map((e) => ({ key: e.key, question: e.question, holds: e.knockout }));
}

export function newQuickRow(kind: QuickKind = "yes_no"): QuickRow {
  return { key: null, kind, question: "", help: "", required: true, options: kind === "yes_no" ? YES_NO.join("\n") : "", unit: "", min: "", max: "" };
}

export function newWrittenRow(): WrittenRow {
  return { key: null, question: "", lookFor: "", required: true };
}

export function quickRowsFrom(p: PacketWithQuestions): QuickRow[] {
  return questionsOf(p).quick.map((q) =>
    q.kind === "choice"
      ? { key: q.key, kind: isYesNo(q.options) ? "yes_no" : "choice", question: q.question, help: q.help ?? "", required: q.required, options: q.options.join("\n"), unit: "", min: "", max: "" }
      : { key: q.key, kind: "number", question: q.question, help: q.help ?? "", required: q.required, options: "", unit: q.unit ?? "", min: q.min === undefined ? "" : String(q.min), max: q.max === undefined ? "" : String(q.max) },
  );
}

/** The company's written questions; without any, the screening questions the chat asks now, to start from (each a new question). */
export function writtenRowsFrom(p: PacketWithQuestions): WrittenRow[] {
  const own = questionsOf(p).written;
  if (own.length) return own.map((q) => ({ key: q.key, question: q.question, lookFor: q.lookFor ?? "", required: q.required }));
  return p.screening.questions.map((q) => ({ key: null, question: q.question, lookFor: "", required: true }));
}

/** A changed kind keeps the words; Yes or no fills its two answers. */
export function withKind(row: QuickRow, kind: QuickKind): QuickRow {
  if (kind === row.kind) return row;
  return { ...row, kind, options: kind === "yes_no" ? YES_NO.join("\n") : row.kind === "yes_no" ? "" : row.options };
}

const optionsOf = (r: QuickRow) => (r.kind === "yes_no" ? [...YES_NO] : r.options.split(/\r?\n/).map((o) => o.trim()).filter(Boolean));
const numberOf = (s: string): number | null => {
  const t = s.trim().replace(/,/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
};

/** The first thing in the rows that cannot be saved, in plain words, or null. Empty rows are dropped, not counted. */
export function questionsProblem(quick: readonly QuickRow[], written: readonly WrittenRow[]): string | null {
  const q = quick.filter((r) => r.question.trim());
  const w = written.filter((r) => r.question.trim());
  if (q.length > QUICK_QUESTIONS_MAX) return `Keep at most ${QUICK_QUESTIONS_MAX} quick questions.`;
  if (w.length > WRITTEN_QUESTIONS_MAX) return `Keep at most ${WRITTEN_QUESTIONS_MAX} written questions.`;
  for (const [i, r] of q.entries()) {
    const n = i + 1;
    if (r.question.trim().length < 3) return `Quick question ${n}: write the question.`;
    if (r.kind === "choice") {
      const opts = optionsOf(r).filter((o, j, all) => all.findIndex((x) => same(x, o)) === j);
      if (opts.length < CHOICE_OPTIONS_MIN || opts.length > CHOICE_OPTIONS_MAX) return `Quick question ${n}: give between ${CHOICE_OPTIONS_MIN} and ${CHOICE_OPTIONS_MAX} different answers to choose from, one a line.`;
    }
    if (r.kind === "number") {
      const min = numberOf(r.min);
      const max = numberOf(r.max);
      if (Number.isNaN(min) || Number.isNaN(max)) return `Quick question ${n}: the smallest and largest numbers must be numbers.`;
      if (min !== null && max !== null && min > max) return `Quick question ${n}: the smallest number is above the largest.`;
    }
    if (q.some((o, j) => j < i && same(o.question, r.question))) return `Quick question ${n} is the same as an earlier one.`;
  }
  for (const [i, r] of w.entries()) {
    if (r.question.trim().length < 5) return `Written question ${i + 1}: write the question.`;
    if (w.some((o, j) => j < i && same(o.question, r.question))) return `Written question ${i + 1} is the same as an earlier one.`;
  }
  return null;
}

/**
 * The body PUT /roles/:id/company-questions takes, with only the lists that were changed (a list left out stays as it is:
 * opening the editor and saving the quick questions never turns the screening questions into written ones).
 */
export function questionsPayload(input: { baseVersion: number; quick: readonly QuickRow[]; written: readonly WrittenRow[]; quickChanged: boolean; writtenChanged: boolean }): CompanyQuestionsEdit {
  const quick: NonNullable<CompanyQuestionsEdit["quick"]> = input.quick.filter((r) => r.question.trim()).map((r) => {
    const base = { ...(r.key ? { key: r.key } : {}), question: r.question.trim(), ...(r.help.trim() ? { help: r.help.trim() } : {}), required: r.required };
    if (r.kind !== "number") return { kind: "choice" as const, ...base, options: optionsOf(r) };
    const min = numberOf(r.min);
    const max = numberOf(r.max);
    return { kind: "number" as const, ...base, ...(r.unit.trim() ? { unit: r.unit.trim() } : {}), ...(min !== null && !Number.isNaN(min) ? { min } : {}), ...(max !== null && !Number.isNaN(max) ? { max } : {}) };
  });
  const written: NonNullable<CompanyQuestionsEdit["written"]> = input.written.filter((r) => r.question.trim()).map((r) => ({ ...(r.key ? { key: r.key } : {}), question: r.question.trim(), required: r.required, ...(r.lookFor.trim() ? { lookFor: r.lookFor.trim() } : {}) }));
  return { baseVersion: input.baseVersion, ...(input.quickChanged ? { quick } : {}), ...(input.writtenChanged ? { written } : {}) };
}

/**
 * The server's refusals (422 `question_not_allowed`, `details.problems`) by row, so each refused question says why beside
 * it: "quick:0" or "written:2" to the plain words. Indexes are of the rows as sent, so empty rows are skipped the same way.
 */
export function refusalsByRow(details: unknown, rows: { quick: readonly QuickRow[]; written: readonly WrittenRow[] }): Map<string, string> {
  const out = new Map<string, string>();
  const problems = (details as { problems?: unknown } | null | undefined)?.problems;
  if (!Array.isArray(problems)) return out;
  const sentIndex = (list: readonly { question: string }[]) => list.map((r, i) => (r.question.trim() ? i : -1)).filter((i) => i >= 0);
  const sent = { quick: sentIndex(rows.quick), written: sentIndex(rows.written) };
  for (const p of problems as CompanyQuestionRefusal[]) {
    if ((p.list !== "quick" && p.list !== "written") || typeof p.index !== "number") continue;
    const row = sent[p.list][p.index];
    if (row === undefined) continue;
    const id = `${p.list}:${row}`;
    if (!out.has(id)) out.set(id, `${p.reason} ${p.alternative}`);
  }
  return out;
}
