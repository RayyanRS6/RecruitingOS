import { inArray } from "drizzle-orm";
import type { Evidence, EvidenceAssessment, EvidenceSource, ResumeExtraction, RolePacket } from "@ros/contracts";
import { outOfCredit, resumeExtractPrompt, runPromptDetached, runPromptsDetached, triageAssessPrompt, type AiRuntime, type RunMeta, type RunOutcome, type TriageInput } from "@ros/ai";
import { errorForLog, formAnswerSentences } from "@ros/core";
import { aiRuns, withTenant, type Db } from "@ros/db";
import { SCORING_VIEW_VERSION, restoreQuotes, scoringView, withoutPlaceholders, type ScoringIdentity, type ScoringView } from "./scoring-view";

export { PLACEHOLDER as SCORING_PLACEHOLDER, SCORING_VIEW_VERSION, hasPlaceholder, restoreQuotes, scoringView, withoutPlaceholders, type HiddenKind, type ScoringIdentity, type ScoringView } from "./scoring-view";

/**
 * The CV's facts, read by the model once per application. Quotes are verified against the source text in code: any quote
 * that is not in the CV is dropped, so nothing the model invented can be presented as evidence. The model is called with
 * no transaction open; the run is recorded in its own short one. The model is sent the CV's text and never the file's
 * name, which is whatever the candidate typed: `filename` is not read, and stays only while the caller still passes it.
 */
export async function extractResume(db: Db, ai: AiRuntime, input: { companyId: string; workflowRunId?: string | null; text: string; filename?: string; documentId: string }): Promise<RunOutcome<ResumeExtraction>> {
  const out = await runPromptDetached(db, ai, resumeExtractPrompt, { text: input.text }, { companyId: input.companyId, workflowRunId: input.workflowRunId ?? null, inputRef: { documentId: input.documentId, chars: input.text.length } });
  if (!out.ok) return out;
  return { ...out, output: verifyQuotes(out.output, input.text) };
}

export function verifyQuotes(ex: ResumeExtraction, source: string): ResumeExtraction {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const src = norm(source);
  const check = (quote?: string) => (quote && src.includes(norm(quote)) ? quote : undefined);
  return {
    ...ex,
    positions: ex.positions.map((p) => ({ ...p, quote: check(p.quote) })),
    licenses: ex.licenses.map((l) => ({ ...l, quote: check(l.quote) })),
    certifications: ex.certifications.map((c) => ({ ...c, quote: check(c.quote) })),
  };
}

/**
 * Inputs to the CV reading; the workflow assembles them from the system of record. `identity` is who the application is
 * from (the candidate's record), used only to hide those details from the reading (`scoringInput`). Earlier
 * applications to the company are never an input.
 */
export type AssessInput = {
  companyId: string;
  workflowRunId?: string | null;
  applicationId: string;
  /**
   * The job as the reading takes it: the must-haves and skills of the version it is read against, and `formQuestions` as
   * this candidate answered them (the version they applied to), which the form's answers are read with.
   */
  packet: RolePacket;
  /**
   * The CV's facts as `extractResume` read them. The reading is never given them: only the name they found, which is
   * hidden, and their job titles, employers and skills, which are never hidden as a name (`scoringInput`).
   */
  extraction: ResumeExtraction | null;
  /** The CV's own text. An application whose file has no readable text is never read. */
  resumeText: string;
  /** The application form's answers by question key (`formAnswersOf` in @ros/core): every one reaches the reading. */
  formAnswers: Record<string, unknown>;
  identity: ScoringIdentity;
};

/**
 * The words the job is judged on, never hidden as a single name (scoring-view.ts `ScoringIdentity.keep`): the job's
 * title, must-haves, competencies and places, and the résumé's own job titles, employers and skills. Every part is read
 * with care: an older or partial packet may leave one out.
 */
export function jobWords(packet: Partial<Pick<RolePacket, "identity" | "requirements" | "competencies">> | null | undefined, extraction?: Pick<ResumeExtraction, "positions" | "skills"> | null): string[] {
  const p = packet ?? {};
  const out: string[] = [];
  if (p.identity?.title) out.push(p.identity.title);
  for (const l of p.identity?.locations ?? []) out.push([l.city, l.region].filter(Boolean).join(" "));
  for (const m of p.requirements?.mustHaves ?? []) out.push(m.text);
  for (const c of p.competencies ?? []) out.push(c.name ?? "");
  for (const pos of extraction?.positions ?? []) out.push(pos.title ?? "", pos.employer ?? "");
  for (const s of extraction?.skills ?? []) out.push(s);
  return out.filter(Boolean);
}

/**
 * What the CV reading is given: the CV and the form's answers, the only texts it may quote, as the scoring view shows
 * them (name, email, phone, street address and links replaced by placeholders), with the scoring view itself, which maps
 * a quote back to the original words and counts what was hidden. The CV's facts as another model read them
 * (`input.extraction`) are not given to it: a quote taken from them is not the candidate's words, so it failed the quote
 * check and took the finding down with it. They only tell the view which name to hide and which words to keep. The
 * form's answers go to the model as plain sentences, the question and the candidate's answer (`formAnswerLines`), never
 * as the form's field names. The sentences are the candidate's own words for the evidence rules (`assessmentSources`).
 */
export function scoringInput(input: Pick<AssessInput, "packet" | "extraction" | "resumeText" | "formAnswers" | "identity">): { promptInput: TriageInput; view: ScoringView } {
  const view = scoringView({ ...input.identity, fullName: input.identity.fullName ?? input.extraction?.fullName ?? null, keep: [...(input.identity.keep ?? []), ...jobWords(input.packet, input.extraction)] });
  const promptInput: TriageInput = {
    packet: input.packet,
    resumeText: view.text(input.resumeText),
    // the questions are the company's words; the answers go through the scoring view
    answerSentences: formAnswerLines(input.packet, view.deep(input.formAnswers)),
  };
  return { promptInput, view };
}

/**
 * The candidate's answers on the application form as the CV reading reads them, one line each: every answered question
 * as a sentence ("Do you hold an active CA RDH license? Yes.", `formAnswerSentences` in @ros/core, the same wording the
 * AI interview is given, so a quote of one is always found again). Never a field name.
 */
export function formAnswerLines(packet: Pick<RolePacket, "formQuestions"> | null | undefined, answers: Readonly<Record<string, unknown>> | null | undefined): string[] {
  return formAnswerSentences(packet?.formQuestions ?? [], answers).map((s) => s.sentence);
}

/** How many times an application is read: the middle answer of three readings holds still where one reading moves (`combineReadings`). */
export const TRIAGE_READINGS = 3;

/**
 * The texts a CV reading may quote, by source, for the quote check. The application side is the candidate's own answers
 * as the sentences the reading was given (`formAnswerLines`), one per line, so a quote of one ("Do you hold an active CA
 * RDH license? Yes.") is the candidate's own words, and a field name is never found.
 */
export function assessmentSources(input: Pick<AssessInput, "resumeText" | "formAnswers" | "packet">): Partial<Record<EvidenceSource, string>> {
  return { resume: input.resumeText, application: formAnswerLines(input.packet, input.formAnswers).join("\n") };
}

/**
 * The CV reading. The model reads the application `TRIAGE_READINGS` times; code verifies every quote against the source
 * text and discards any claim whose quote cannot be found, so nothing invented reaches the team, then keeps the middle
 * answer of the readings for each finding. The readings ask the AI credit together (`runPromptsDetached`): with no room
 * for all of them none is made, and the caller waits for credit, rather than leaving this applicant with fewer readings
 * than the next.
 */
export async function assessApplication(db: Db, ai: AiRuntime, input: AssessInput): Promise<RunOutcome<EvidenceAssessment>> {
  const { promptInput, view } = scoringInput(input);
  // The record says which view the reading used and how many details it hid: counts only, never the values.
  const inputRef = { applicationId: input.applicationId, resumeChars: input.resumeText.length, scoringView: SCORING_VIEW_VERSION, hidden: view.counts() };
  const meta = (reading: number): RunMeta => ({ companyId: input.companyId, workflowRunId: input.workflowRunId ?? null, inputRef: { ...inputRef, reading } });
  const runs = await runPromptsDetached(db, ai, triageAssessPrompt, promptInput, Array.from({ length: TRIAGE_READINGS }, (_, i) => meta(i + 1)));
  // A reading lost to an outage is asked once more; one still lost fails the step, which the engine retries, rather than
  // leaving this applicant with fewer readings than the next.
  const settled = await Promise.all(runs.map((r, i) => (!r.ok && r.reason === "error" ? runPromptDetached(db, ai, triageAssessPrompt, promptInput, meta(i + 1)) : r)));
  const noCredit = settled.find(outOfCredit);
  if (noCredit) return noCredit;
  const outage = settled.find((r) => !r.ok && r.reason === "error");
  if (outage) return outage;
  const out = readingsOutcome(settled, view, input);
  await linkReadingRuns(db, input.companyId, out, settled);
  return out;
}

/**
 * The readings as the team sees them, combined into the middle answer of each finding, with the skill floor
 * (`skillFloor`). Quotes are checked against the ORIGINAL words and shown as the candidate wrote them: one the model
 * wrote around a placeholder is mapped back first (`restoreReadingQuotes`); one that cannot be fails the check. The
 * model's own words (summary, claims, unknowns) keep no placeholder either: "[name]" reads "the candidate". Shared with
 * the fairness evals (packages/evals), so they check exactly what the app does after the model has answered.
 */
export function readingsOutcome(readings: ReadonlyArray<RunOutcome<Reading>>, view: Pick<ScoringView, "restore">, input: Pick<AssessInput, "resumeText" | "formAnswers" | "packet">): RunOutcome<Reading> {
  const sources = assessmentSources(input);
  const liftable = liftableQuote(sources);
  const checked = readings.map((r) => (r.ok ? { ...r, output: withoutPlaceholders(restoreReadingQuotes(r.output, view, sources)) } : r));
  return combineOutcomes(checked, sources, credentialMustHaves(input.packet), findingSubjects(input.packet), { skills: (settled, all) => skillFloor(settled, all, liftable) });
}

/** How a combined reading is settled after the middle answers are taken (`combineReadings`). */
export type ReadingSettlement<R extends Combinable> = {
  /** The skill findings once the middle answers are taken, settled further from the readings themselves (`skillFloor`). */
  skills?: (settled: Combinable["competencyFindings"], readings: readonly R[]) => Combinable["competencyFindings"];
};

/** Whether evidence carries a checked quote, as the CV score reads it: something quoted, and not marked "no quote". */
const checkedQuote = (e: Evidence | undefined): e is Evidence => !!e?.quote?.trim() && !e.unquoted;

/**
 * The skill floor of the CV reading: a competency whose middle
 * answer is "not evidenced", but which one of the readings showed (partly or fully) on a checked quote that may lift it
 * (`liftable`, `liftableQuote`: never a dated job line or a yes/no answer on the form), settles at "partially evidenced"
 * with that quote. Never higher than partly shown, never when any reading said "contradicted" on a checked quote, and
 * never for a must-have (only competency findings are read). It only ever moves a finding toward the candidate, so the
 * score stays monotonic, and the quote it keeps is chosen by the readings' content (partly before fully shown, then by
 * the quote), never by the order the readings came back in. Pure; exported for the tests.
 */
export function skillFloor(settled: Combinable["competencyFindings"], readings: readonly Pick<Combinable, "competencyFindings">[], liftable: (e: Evidence) => boolean): Combinable["competencyFindings"] {
  const rank = (f: CompetencyFinding) => (f.finding === "partially_evidenced" ? 0 : 1);
  return settled.map((f): CompetencyFinding => {
    if (f.finding !== "not_evidenced") return f;
    const said = readings.flatMap((r) => {
      const first = r.competencyFindings.find((x) => x.competencyKey === f.competencyKey);
      return first ? [first] : [];
    });
    if (said.some((x) => x.finding === "contradicted" && checkedQuote(x.evidence))) return f;
    const shown = said
      .filter((x) => (x.finding === "partially_evidenced" || x.finding === "evidenced") && checkedQuote(x.evidence) && liftable(x.evidence))
      .sort((a, b) => rank(a) - rank(b) || (a.evidence?.quote ?? "").localeCompare(b.evidence?.quote ?? "") || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const lift = shown[0];
    if (!lift?.evidence) return f;
    return { competencyKey: f.competencyKey, finding: "partially_evidenced", evidence: lift.evidence, ...(lift.finding === "partially_evidenced" && lift.note ? { note: lift.note } : {}) };
  });
}

/**
 * A line with a span of years on it ("2016 - 2021", "2019 – Present", "2014 to 2019"): a job's title, employer and
 * dates, which on its own is no evidence of a competency (the prompt's own rule), so it never lifts one (`liftableQuote`).
 */
export const DATED_JOB_LINE = /\b(?:19|20)\d{2}\s*(?:-|–|—|to|until)\s*(?:(?:19|20)\d{2}|present|current|now|today)\b/i;

/** Whether a quote sits in an answer on the form that is a yes or a no to its question, whichever question it is (`yesOrNo`). */
function yesNoFormAnswer(quote: string, application: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const q = norm(quote);
  if (!q) return false;
  for (const raw of application.split(/\r?\n/)) {
    const line = raw.trim();
    if (!norm(line).includes(q)) continue;
    const asked = line.match(/^(.+\?)\s+(\S.*)$/);
    if (asked && yesOrNo(asked[2] ?? "")) return true;
  }
  return false;
}

/**
 * Which checked quotes may lift a skill under the skill floor (`skillFloor`), read from the candidate's texts by source
 * (`assessmentSources`): never a yes or no answer on the form ("Do you hold an active CA RDH license? Yes."), and never
 * a line with a span of years on it (`DATED_JOB_LINE`: a job title, an employer and dates), read as the whole line
 * around the quote (`sentenceAround`), or the quote itself when the line is not found. A title, an employer, years in a
 * job or a yes/no answer is not on its own evidence of a competency (the prompt's own rule). Anything else may.
 */
export function liftableQuote(sources: Partial<Record<EvidenceSource, string>>): (e: Evidence) => boolean {
  return (e) => {
    const quote = e.quote ?? "";
    if (e.source === "application" && yesNoFormAnswer(quote, sources.application ?? "")) return false;
    const line = sentenceAround(quote, sources[e.source] ?? "") ?? quote;
    return !DATED_JOB_LINE.test(line);
  };
}

/**
 * Every model run behind one stored reading, linked to the run the reading keeps as its own (`assessments.ai_run_id`):
 * each run's `final_outcome` says `readingOf` that run and lists all of them, so the audit trail from the reading the team
 * saw reaches all three runs. Bookkeeping only: a failure here is logged and never loses the reading.
 */
export async function linkReadingRuns(db: Db, companyId: string, kept: RunOutcome<unknown>, runs: ReadonlyArray<RunOutcome<unknown>>): Promise<void> {
  if (!kept.ok) return;
  const ids = [...new Set(runs.map((r) => r.runId).filter((id): id is string => !!id))];
  if (ids.length < 2) return;
  try {
    await withTenant(db, companyId, (q) => q.update(aiRuns).set({ finalOutcome: { readingOf: kept.runId, readings: ids } }).where(inArray(aiRuns.id, ids)));
  } catch (err) {
    console.warn(`[triage] could not link the readings' runs: ${errorForLog(err)}`);
  }
}

/**
 * A reading's quotes as the candidate wrote them: each quote with a placeholder mapped back to the original text of the
 * source it cites, else of any source. Exported for the tests.
 */
export function restoreReadingQuotes<T>(reading: T, view: Pick<ScoringView, "restore">, sources: Partial<Record<EvidenceSource, string>>): T {
  const all = Object.values(sources).filter((s): s is string => !!s);
  return restoreQuotes(reading, view, (source) => {
    const own = source ? sources[source as EvidenceSource] : undefined;
    return own ? [own, ...all.filter((s) => s !== own)] : all;
  });
}

/**
 * Whether a must-have's words name a licence, certificate, permit or registration. The one test for it: the licence rule
 * may settle only these (`credentialFinding`, in the CV reading and in the AI interview's scorecard), and the AI
 * interview asks about one of these once, as yes or no, and takes the answer (`gapQuestion` and `ladderApplies` in
 * screening.ts).
 */
export function namesCredential(text: string): boolean {
  return /licen[cs]|certif|permit|registration|registered|credential/i.test(text);
}

/** The must-haves the licence rule holds to (`namesCredential`), by key. */
export function credentialMustHaves(packet: Pick<RolePacket, "requirements">): ReadonlySet<string> {
  return new Set(packet.requirements.mustHaves.filter((m) => namesCredential(m.text)).map((m) => m.key));
}

/** What each finding is about, by key: a must-have's words, or a skill's name (`applyEvidenceRules` `subjects`). */
export function findingSubjects(packet: Partial<Pick<RolePacket, "requirements" | "competencies">> | null | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const m of packet?.requirements?.mustHaves ?? []) out.set(m.key, m.text);
  for (const c of packet?.competencies ?? []) if (!out.has(c.key)) out.set(c.key, c.name);
  return out;
}

/**
 * The line or sentence of `source` that holds `quote` (whitespace and case aside): the candidate's words around a
 * quote, so the licence rule reads "RDH license CA expired in 2021" whole when a reading quoted only "RDH license CA".
 * A quote over several lines gives all of them (at most six); one not found, null.
 */
export function sentenceAround(quote: string, source: string): string | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const q = norm(quote);
  if (!q) return null;
  const parts = source
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const normed = parts.map(norm);
  for (let len = 1; len <= Math.min(6, normed.length); len++) {
    for (let i = 0; i + len <= normed.length; i++) if (normed.slice(i, i + len).join(" ").includes(q)) return parts.slice(i, i + len).join(" ");
  }
  return null;
}

type Reading = EvidenceAssessment;
/** What `combineReadings` needs of a reading: its findings. */
type Combinable = Pick<EvidenceAssessment, "requirementFindings" | "competencyFindings">;

/**
 * The readings that came back, each through the evidence rules, combined into one (`combineReadings`). With fewer than
 * three (a reading refused or unusable) the first is used. With none, the failure: an outage when any reading had one,
 * so the step is retried.
 */
export function combineOutcomes(runs: ReadonlyArray<RunOutcome<Reading>>, sources: Partial<Record<EvidenceSource, string>>, credentials?: ReadonlySet<string>, subjects?: ReadonlyMap<string, string>, settle?: ReadingSettlement<Reading>): RunOutcome<Reading> {
  return combineRunOutcomes(runs, (r) => verifyAssessmentQuotes(r, sources, credentials, subjects), TRIAGE_READINGS, settle);
}

/**
 * `combineOutcomes` with the evidence rules given: `check` puts each reading through them first. The run kept is the
 * first usable one; `linkReadingRuns` ties the others to it. The skill floor (`settle.skills`) applies only when all the
 * readings came back, as the first is used otherwise.
 */
export function combineRunOutcomes<R extends Combinable>(runs: ReadonlyArray<RunOutcome<R>>, check: (r: R) => R, count = TRIAGE_READINGS, settle?: ReadingSettlement<R>): RunOutcome<R> {
  const ok = runs.filter((r): r is Extract<RunOutcome<R>, { ok: true }> => r.ok);
  if (!ok.length) return runs.find((r): r is Extract<RunOutcome<R>, { ok: false }> => !r.ok && r.reason === "error") ?? runs[0]!;
  const readings = ok.map((r) => check(r.output));
  return { ...ok[0]!, output: readings.length >= count ? combineReadings(readings, settle) : readings[0]! };
}

const MET_ORDER = ["no", "unknown", "partially", "yes"] as const;
const FINDING_ORDER = ["contradicted", "not_evidenced", "partially_evidenced", "evidenced"] as const;

/**
 * The middle value on the finding's own order. For an even number the upper middle: a tie never resolves against the
 * candidate. Every reading gives exactly one value per key, so with three readings it is the true middle.
 */
export function middle<T extends string>(values: readonly T[], order: readonly T[]): T {
  const sorted = [...values].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * One reading from several of the same application (three, after the evidence rules), the same whatever order they
 * came back in:
 * - each reading gives exactly one answer per must-have and per skill (its first; a reading that left one out counts as
 *   "unknown" or "not evidenced"), and the result is the middle answer (must-haves ordered no, unknown, partially, yes;
 *   skills contradicted, not evidenced, partially, evidenced), with the evidence of a reading that gave it;
 * - with `skills` (`skillFloor`) the skill findings are settled further from the readings: a skill one reading of three
 *   showed on a checked quote of the candidate's own work is partly shown, never more; never over a verified
 *   "contradicted"; never from a dated job line or a yes/no answer; never for a must-have;
 * - the words (summary, strengths, concerns, questions) all come from one reading, the one that agrees with the most
 *   middle answers, so they never contradict each other.
 */
export function combineReadings<R extends Combinable>(readings: readonly R[], opts: ReadingSettlement<R> = {}): R {
  const reqKeys = [...new Set(readings.flatMap((r) => r.requirementFindings.map((f) => f.requirementKey)))].sort();
  const compKeys = [...new Set(readings.flatMap((r) => r.competencyFindings.map((f) => f.competencyKey)))].sort();
  const reqOf = (r: R, k: string) => r.requirementFindings.find((f) => f.requirementKey === k);
  const compOf = (r: R, k: string) => r.competencyFindings.find((f) => f.competencyKey === k);
  const met = new Map(reqKeys.map((k) => [k, middle(readings.map((r) => reqOf(r, k)?.met ?? "unknown"), MET_ORDER)]));
  const found = new Map(compKeys.map((k) => [k, middle(readings.map((r) => compOf(r, k)?.finding ?? "not_evidenced"), FINDING_ORDER)]));
  // the closest reading: the most findings in common with the middle answers; a tie is settled by the reading's own
  // content, never by the order the readings came back in
  const agreement = (r: R) => reqKeys.filter((k) => reqOf(r, k)?.met === met.get(k)).length * 10 + compKeys.filter((k) => compOf(r, k)?.finding === found.get(k)).length;
  const ranked = [...readings].sort((a, b) => agreement(b) - agreement(a) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const requirementFindings = reqKeys.map((k) => ranked.map((r) => reqOf(r, k)).find((f) => f?.met === met.get(k)) ?? { requirementKey: k, met: met.get(k)! });
  const middleSkills = compKeys.map((k) => ranked.map((r) => compOf(r, k)).find((f) => f?.finding === found.get(k)) ?? { competencyKey: k, finding: found.get(k)! });
  const competencyFindings = opts.skills ? opts.skills(middleSkills, readings) : middleSkills;
  return { ...ranked[0]!, requirementFindings, competencyFindings };
}

/**
 * Checks every quote in a CV reading against the text it cites (through `applyEvidenceRules`). A
 * résumé reading is given only the candidate's own texts, so nothing else can be quoted in it: a quote citing any
 * other source (the AI interview, the owner's words, "verified") must
 * still be found in the candidate's texts, or it fails the check like an invented one. A claim citing such
 * a source with nothing quoted is no evidence of anything either, so it never scores in full (`cvScoreOf`).
 */
export function verifyAssessmentQuotes(a: EvidenceAssessment, sources: Partial<Record<EvidenceSource, string>>, credentials?: ReadonlySet<string>, subjects?: ReadonlyMap<string, string>): EvidenceAssessment {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const normalized = new Map<string, string>();
  for (const [k, v] of Object.entries(sources)) normalized.set(k, norm(v ?? ""));
  // the line a checked quote sits on, in the source it names (or the first source holding it); an answer on the form
  // ("Do you hold an active CA RDH license? No.") is read as the statement it makes ("I do not hold ...")
  const lineOf = (e: Evidence): string | null => {
    const quote = e.quote ?? "";
    const answer = e.source === "application" ? formAnswerAround(quote, sources.application ?? "") : null;
    if (answer) return answer;
    const own = sources[e.source];
    const texts = own !== undefined ? [own] : Object.values(sources).filter((s): s is string => !!s);
    for (const t of texts) {
      const line = sentenceAround(quote, t);
      if (line) return line;
    }
    return null;
  };
  return applyEvidenceRules(
    a,
    (e) => {
      const quote = norm(e.quote ?? "");
      const src = normalized.get(e.source);
      if (src !== undefined) return src.includes(quote);
      return [...normalized.values()].some((s) => !!s && s.includes(quote));
    },
    { credentials, lineOf, ...(subjects ? { subjects } : {}) },
  );
}

/**
 * The answer on the form a quote sits in (`formAnswerLines`: one line each, the question then the answer), read as the
 * statement it makes, with the question (`answerInContext`): "Do you hold an active CA RDH license? No." reads "I do not
 * hold an active CA RDH license", so the licence rule reads it as plainly as the same words in a résumé. Null when the
 * quote is not in a line of that shape.
 */
export function formAnswerAround(quote: string, application: string): string | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const q = norm(quote);
  if (!q) return null;
  for (const raw of application.split(/\r?\n/)) {
    const line = raw.trim();
    if (!norm(line).includes(q)) continue;
    const asked = line.match(/^(.+\?)\s+(\S.*)$/);
    if (asked) return answerInContext(asked[1] ?? "", asked[2] ?? "") ?? line;
  }
  return null;
}

/**
 * Whether an answer on the form (one line, the question then the answer: "Do you hold a current CPR certificate? No.")
 * says, read with its question, that they do not hold a licence, certificate, permit or registration: a "no" to "Do you
 * hold …?", "Do you have …?" or "Are you licensed …?" (`closedAnswer`), where what they do not hold is the credential
 * itself and never something about one (`saysNotHeld`, the licence rule's own test): "Do you have any restrictions on
 * your license? No." and "Do you have experience with CPR? No." say nothing of the kind. Nor does any other question
 * ("Has your licence ever been suspended? No.") or any other answer. The AI interview goes by it (`answeredNoOnTheForm`
 * in screening.ts). Pure.
 */
export function formAnswerSaysNotHeld(line: string): boolean {
  const asked = line.trim().match(/^(.+\?)\s+(\S.*)$/);
  const said = asked ? closedAnswer(asked[1] ?? "", asked[2] ?? "") : null;
  return !!said && !said.held && saysNotHeld(said.statement);
}

/** The candidate's own record or words: a claim citing one of these must quote it, and the quote is checked. */
const CANDIDATE_EVIDENCE_SOURCES: ReadonlySet<EvidenceSource> = new Set<EvidenceSource>(["resume", "application", "candidate_statement", "screen"]);

/**
 * The fewest words a quote needs to count as evidence, not counting yes, no and the small words around them: "Yes",
 * "I do" or "Dentrix" alone show nothing a person could check.
 */
const MIN_QUOTE_WORDS = 2;
const FILLER_WORDS = new Set(["yes", "yeah", "yep", "no", "nope", "ok", "okay", "sure", "true", "false", "none", "maybe", "na", "n", "a", "i", "an", "the", "do", "did", "does", "am", "is", "it", "have", "has", "of", "and", "or", "to", "in", "on", "my"]);

/** Whether a quote says enough to be evidence: at least `MIN_QUOTE_WORDS` words besides yes, no and the like. */
export function meaningfulQuote(quote: string | null | undefined): boolean {
  const words = (quote ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter((w) => w.length > 1 && !FILLER_WORDS.has(w)).length >= MIN_QUOTE_WORDS;
}

/**
 * Words that say a licence, certificate, permit or registration is not in force today: lapsed, expired, revoked and the
 * like, or still to come (pending, applied for, in training, enrolled, not yet). Under the licence rule
 * (`credentialFinding`) every one of these reads "unknown", for a person or the AI interview to ask about.
 */
const NOT_HELD = /\b(expired|lapsed|inactive|revoked|suspended|not renewed|renewal not started|pending|applied for|applying for|awaiting|in progress|enrolled|enrolling|studying|in training|trainee|graduating|not yet|yet to|expected)\b/gi;
const STILL_HELD = /\b(active|current|valid|reinstated|reactivated|good standing)\b|\bcurrently (licensed|certified|registered|active|valid|hold|holding)\b|(?<!\bnot )\brenewed\b/i;
/** A status word just after a negation ("never lapsed", "not expired", "hasn't been suspended", "non-expired") says the opposite. */
const NEGATED = /(\b(never|not|no|nor|without)\b[^.;,]{0,20}|n['’]t\s+(been\s+)?|\bnon-?\s*)$/i;
/**
 * Words that say a person does not have or hold what follows them: "do not hold …", "never had …", "no longer have …",
 * "have no …", "No …" at the start, "without a …", and "not", "no longer" or "never been" before "licensed", "certified"
 * or "registered". Whether what follows is the credential is for `isTheCredential` to say.
 */
const NOT_HAVING = new RegExp(
  [
    String.raw`\b(?:do|does|did)\s+not\s+(?:currently\s+)?(?:have|hold)\b`,
    String.raw`\b(?:do|does|did)n['’]t\s+(?:currently\s+)?(?:have|hold)\b`,
    String.raw`\bnever\s+(?:had|held)\b`,
    String.raw`\bno\s+longer\s+(?:have|hold)\b`,
    String.raw`\b(?:never\s+been|no\s+longer|not(?:\s+currently)?)(?=\s+(?:licensed|certified|registered)\b)`,
    String.raw`\b(?:have|hold)\s+no\b`,
    String.raw`^\s*no\b`,
    String.raw`\bwithout\s+(?:a|an|any)\b`,
  ].join("|"),
  "gi",
);
/** The same said in one word, with nothing to follow. */
const UNLICENSED = /\b(?:unlicensed|uncertified|unregistered)\b/i;
/** "Never", "not" or "can't" a little before "without a license" turns it round: "never practised without a license". */
const NOT_WITHOUT = /(?:\b(?:never|not|cannot)\b|n['’]t\b)[^.;,]{0,20}$/i;
/**
 * Where the first thing a person says they do not have ends: at a comma (unless it sits inside "a current, valid …"), a
 * bracket, a dash or the end of the sentence, and at "and" or "but", which start a second thing or a second sentence.
 */
const AFTER_THE_FIRST_THING = /(?:[.;:!?()\n]|(?<!\b(?:current|valid|active)),|\s[-–—]\s|\s+(?:and|but)\s)[\s\S]*$/i;
/** From the first word that says what a thing is about or belongs to, or when: "restrictions | on your licence", "experience | with CPR", "my licence | yet". */
const WHAT_IT_IS_ABOUT = /\s+(?:on|with|of|in|for|from|to|about|regarding|against|under|at|yet|currently|now|anymore|today)(?=\s|$)[\s\S]*$/i;
/** Another one than the job asks for: "any other license", "a license in another state". */
const ANOTHER_ONE = /\b(?:other|another|additional|different)\b/i;
/** Words that stand for the credential in a reply about it: "I don't have it", "I do not have one". */
const STANDS_FOR_IT = new Set(["it", "one", "that", "this", "any", "them", "those", "these"]);
/** Still to come, or not settled: a "do not hold" with any of these is pending, so "unknown". */
const NOT_SETTLED = /\b(yet|pending|applied|applying|awaiting|waiting|in progress|enrolled|studying|training|graduat\w*|expected|exam|soon|will)\b/i;

/** A word naming a credential or the way to one: a part of a line with none of these is about something else. */
const CREDENTIAL_WORD = /\b(licen[cs]\w*|certif\w*|registration|registered|permit|programs?|programmes?|credentials?|board|exam|rdh)\b/i;
/** Words of a must-have that say nothing about which credential it is. */
const GENERIC_SUBJECT_WORDS = new Set(["active", "current", "valid", "state", "must", "with", "and", "for", "hold", "holds", "have", "license", "licence", "licensed", "licenced", "licensure", "certificate", "certification", "certified", "registration", "registered", "permit", "credential", "credentials"]);
/** A renewal's own state ("renewal expected 2026", "renewal in progress") is not the credential's. */
const RENEWAL_BEFORE = /\brenewal\s+(?:is\s+|was\s+)?$/i;
const RENEWAL_STATE = /^(expected|in progress|pending|applied for|applying for|awaiting)$/i;

const wordsIn = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** The words of a must-have that say which credential it is: "ca" and "rdh" of "Active CA RDH license". */
const ownWordsOf = (subject?: string | null): string[] => wordsIn(subject ?? "").filter((w) => w.length > 1 && !FILLER_WORDS.has(w) && !GENERIC_SUBJECT_WORDS.has(w));

/**
 * The parts of a quote (or of the line around it) about the credential itself, split at semicolons, line breaks and
 * sentence ends. When some part names a credential, a part that names none ("renewal expected 2026") is left out; with
 * the must-have's own words (`subject`, e.g. "Active CA RDH license"), when some part names them, a part about another
 * qualification ("studying for local anesthesia permit") is left out too. With nothing named anywhere, the whole quote.
 */
function aboutTheCredential(quote: string, subject?: string | null): string[] {
  const clauses = quote
    .split(/;|\r?\n|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const own = ownWordsOf(subject);
  const hasOwn = (c: string) => {
    const w = wordsIn(c);
    return own.some((o) => w.includes(o));
  };
  const named = (c: string) => CREDENTIAL_WORD.test(c) || hasOwn(c);
  const anyNamed = clauses.some(named);
  const ownSomewhere = own.length > 0 && clauses.some(hasOwn);
  return clauses.filter((c) => (!anyNamed || named(c)) && (!ownSomewhere || hasOwn(c)));
}

/**
 * Whether a quote says a licence or certificate is not in force today: an expired-, pending- or in-training-like word
 * that is not negated, and nothing in the quote saying it is held (active, current, valid, renewed, reinstated, in good
 * standing). Only the parts about the credential count (`aboutTheCredential`): "RDH license CA #12345, renewal expected
 * 2026" is held, and "RDH license CA; studying for local anesthesia permit" is not about the RDH licence's state.
 */
export function shownNotHeld(quote: string, subject?: string | null): boolean {
  const parts = aboutTheCredential(quote, subject);
  if (parts.some((c) => STILL_HELD.test(c))) return false;
  for (const c of parts) {
    for (const m of c.matchAll(NOT_HELD)) {
      const at = m.index ?? 0;
      const before = c.slice(Math.max(0, at - 30), at);
      if (NEGATED.test(before)) continue;
      if (RENEWAL_BEFORE.test(before) && RENEWAL_STATE.test(m[0])) continue;
      return true;
    }
  }
  return false;
}

/**
 * Whether the first thing a person says they do not have or hold (`first`: the words after "do not hold", "have no",
 * "without a" …, as far as `AFTER_THE_FIRST_THING`) is the credential itself, and not something about one, another one, or
 * something else. It is read up to what it is about or belongs to (`WHAT_IT_IS_ABOUT`), and things joined by "or" are each
 * read ("a CPR or BLS certificate"). It is the credential when it ends in a word for one (`namesCredential`: "a California
 * RDH license", "licensed"), or in the must-have's own name for it (`own`: "CPR", "my RDH"), or stands for it in a reply
 * ("it", "a current one"). "Any restrictions on my license", "experience with CPR", "any license restrictions" and "a
 * license in any other state" are not.
 */
function isTheCredential(first: string, own: readonly string[]): boolean {
  if (ANOTHER_ONE.test(first)) return false;
  return first
    .replace(WHAT_IT_IS_ABOUT, "")
    .split(/\s+(?:or|nor)\s+/i)
    .some((named) => {
      const words = wordsIn(named);
      const last = words.at(-1);
      if (!last) return false;
      const standsForIt = words.some((w) => STANDS_FOR_IT.has(w)) && ownWordsOf(named).every((w) => STANDS_FOR_IT.has(w));
      return namesCredential(last) || own.includes(last) || standsForIt;
    });
}

/**
 * What a quote says apart from denying the credential, or null when it does not deny it. It denies it where, in a part
 * about the credential (`aboutTheCredential`), words of not having (`NOT_HAVING`) come before the credential itself
 * (`isTheCredential`), or it says "unlicensed", "uncertified" or "unregistered"; "never … without a license" says the
 * opposite (`NOT_WITHOUT`). The one reader of such words: a resume line, a reply in the AI interview and an answer on the
 * form all go through it (`plainlyNotHeld`, `credentialFinding`, `formAnswerSaysNotHeld`), so "I do not have any
 * restrictions on my license" is nowhere read as not holding one.
 */
function apartFromTheDenial(quote: string, subject?: string | null): string | null {
  const about = aboutTheCredential(quote, subject).join("; ");
  const own = ownWordsOf(subject);
  let denied = UNLICENSED.test(about);
  let rest = "";
  let from = 0;
  for (const m of about.matchAll(NOT_HAVING)) {
    const at = m.index ?? 0;
    if (at < from) continue;
    if (/^without/i.test(m[0]) && NOT_WITHOUT.test(about.slice(0, at))) continue;
    const first = about.slice(at + m[0].length).replace(AFTER_THE_FIRST_THING, "");
    if (!isTheCredential(first, own)) continue;
    denied = true;
    rest += about.slice(from, at);
    from = at + m[0].length + first.length;
  }
  return denied ? rest + about.slice(from) : null;
}

/** Whether a quote says the candidate does not have or hold the credential (`apartFromTheDenial`). */
const saysNotHeld = (quote: string, subject?: string | null): boolean => apartFromTheDenial(quote, subject) !== null;

/**
 * Whether a quote says plainly that the candidate does not hold the credential, with nothing pending, lapsed or held
 * about it. What they say they do not have must be the credential itself, in a part about it (`saysNotHeld`); anything
 * pending or held anywhere in the quote keeps it from being plain.
 */
export function plainlyNotHeld(quote: string, subject?: string | null): boolean {
  return saysNotHeld(quote, subject) && !NOT_SETTLED.test(quote) && !STILL_HELD.test(quote) && !shownNotHeld(quote, subject);
}

type Met = EvidenceAssessment["requirementFindings"][number]["met"];

/**
 * The licence rule for a credential must-have with a checked quote, read from the candidate's words (`text`: the line
 * the quote sits on, or the form's question a short answer replies to, so the finding never rests on which part of a
 * line the model chose to quote): "no" when the words say plainly the candidate does not hold it,
 * whatever the model answered; a lapsed, expired, pending or unclear credential is "unknown", never "no", "yes" or
 * "partially"; a "no" the words do not say plainly is "unknown". Words that say they do not hold it are never a "yes" or
 * a "partially" either: "I do not hold a current CPR certificate" is "unknown" (a lapsed one is not current either),
 * because the word that says a credential is in force sits inside what they say they do not hold. Only where the line
 * says one is in force apart from that ("my RN license is active, I do not hold a compact license") does the reading
 * stand, as anything else does. `subject`: the must-have's own words, so a part of the line about another qualification
 * is not read as this one.
 */
export function credentialFinding(met: Met, text: string, subject?: string | null): Met {
  if (plainlyNotHeld(text, subject)) return "no";
  if (met === "no" || shownNotHeld(text, subject)) return "unknown";
  const rest = apartFromTheDenial(text, subject);
  return rest !== null && !STILL_HELD.test(rest) ? "unknown" : met;
}

/** The parts of a CV reading the evidence rules touch. */
type Readable = Pick<EvidenceAssessment, "strengths" | "concerns" | "competencyFindings" | "requirementFindings">;
type Claim = EvidenceAssessment["strengths"][number];
type CompetencyFinding = EvidenceAssessment["competencyFindings"][number];
type RequirementFinding = EvidenceAssessment["requirementFindings"][number];

/**
 * What `applyEvidenceRules` may know beyond the quote itself:
 * - `credentials`: the must-haves the licence rule holds to (`credentialMustHaves`);
 * - `subjects`: what each finding is about, by key (`findingSubjects`);
 * - `lineOf(e)`: the candidate's line or sentence around a checked quote, for the licence rule (`sentenceAround`; an
 *   answer on the form read as the statement it makes, `formAnswerAround`).
 */
export type EvidenceRuleOptions = {
  credentials?: ReadonlySet<string>;
  subjects?: ReadonlyMap<string, string>;
  lineOf?: (e: Evidence) => string | null | undefined;
};

const YES_ANSWER = /^(?:yes|yeah|yep|yup|sure|correct|i do|i have|i am|i hold)\b/;
const NO_ANSWER = /^(?:no|nope|not really|i do not|i don['’]t|i have not|i haven['’]t|i am not|i['’]m not)\b/;
/** Whether an answer is a plain yes or a plain no ("Yes", "No, I don't"), whatever it answers. */
function yesOrNo(answer: string): boolean {
  const a = answer.replace(/\s+/g, " ").trim().toLowerCase();
  return YES_ANSWER.test(a) || NO_ANSWER.test(a);
}
// Each reads the last question from its start, after a leading "And" or "So" ("So do you hold …?"): "Which
// certifications do you hold …?" has "do you hold" in it and is no closed question.
const HOLD_QUESTION = /^(?:(?:and|so)\b,?\s+)?(?:do|did|does)\s+you\s+(?:currently\s+|still\s+)?(have|hold)\b\s*(.*)$/i;
const ARE_YOU_QUESTION = /^(?:(?:and|so)\b,?\s+)?are\s+you\s+(?:currently\s+|still\s+)?((?:licensed|certified|registered)\b.*)$/i;
/** A question that asks them to name something: which, what, how, when, where, who or whose. */
const OPEN_QUESTION = /^(?:(?:and|so)\b,?\s+)?(?:which|what|how|when|where|who|whose)\b/i;

/** The last question in an assistant's message ("Thanks, that helps. Next: Do you hold ...?"), or the whole message. */
const lastQuestionOf = (question: string): string => {
  const q = question.replace(/\s+/g, " ").trim();
  return q.split(/(?<=[.!?:])\s+/).filter((s) => s.endsWith("?")).at(-1) ?? q;
};

/** Whether the last question in an assistant's message asks them to name something ("Which certifications do you hold?"): a bare yes or no answers none of it. */
const asksOpenly = (question: string): boolean => OPEN_QUESTION.test(lastQuestionOf(question));

/**
 * A yes or no to a closed question about holding something ("Do you hold ...?", "Do you have ...?", "Are you licensed
 * ...?"), as the statement it makes and whether it says held: a bare "No" to "Do you hold a California RDH license?" is
 * { held: false, statement: "I do not hold a California RDH license" }. Null for any other question, for one that asks
 * them to name something (`asksOpenly`: a "yes" to "Which certifications do you hold …?" names none), and for anything but
 * a yes or a no. Pure.
 */
export function closedAnswer(question: string, answer: string): { held: boolean; statement: string } | null {
  const a = answer.replace(/\s+/g, " ").trim().toLowerCase();
  const no = NO_ANSWER.test(a);
  const yes = YES_ANSWER.test(a) && !no;
  if (!yes && !no) return null;
  const asked = lastQuestionOf(question);
  if (OPEN_QUESTION.test(asked)) return null;
  const hold = asked.match(HOLD_QUESTION);
  const are = asked.match(ARE_YOU_QUESTION);
  const rest = (s: string) => s.replace(/[?.!\s]+$/, "");
  if (hold) return { held: yes, statement: `${no ? `I do not ${hold[1]!.toLowerCase()}` : `I ${hold[1]!.toLowerCase()}`} ${rest(hold[2] ?? "")}`.trim() };
  if (are) return { held: yes, statement: `${no ? "I am not" : "I am"} ${rest(are[1] ?? "")}`.trim() };
  return null;
}

/**
 * A short answer read with the question it replies to, as one statement the evidence rules can read: a bare "No" to "Do
 * you hold a California RDH license?" reads "I do not hold a California RDH license", a bare "Yes" reads "I hold a
 * California RDH license" (`closedAnswer`). A yes or no to any other closed question reads as the question followed by
 * the answer. A yes or no to a question that asks them to name something (`asksOpenly`: "Which certifications do you
 * hold …?") says nothing, and anything else ("Maybe", "Dentrix") is not a plain answer to a closed question: null. Pure.
 */
export function answerInContext(question: string, answer: string): string | null {
  if (asksOpenly(question)) return null;
  const closed = closedAnswer(question, answer);
  if (closed) return closed.statement;
  return yesOrNo(answer) ? `${lastQuestionOf(question)} ${answer.trim()}` : null;
}

type QuoteCheck = "verified" | "failed" | "thin" | "none";

/** The evidence as shown: the model's own `unquoted` flag removed, and set when a claim about the candidate has nothing quoted. */
function marked(e: Evidence): Evidence {
  const { unquoted: _unquoted, ...rest } = e;
  return !rest.quote?.trim() && CANDIDATE_EVIDENCE_SOURCES.has(rest.source) ? { ...rest, quote: undefined, unquoted: true } : rest;
}

/** The evidence as kept after its check: a failed or too-short quote taken off (the source stays), anything else as marked. */
function keptEvidence(e: Evidence, c: QuoteCheck): Evidence {
  return c === "failed" || c === "thin" ? marked({ source: e.source }) : marked(e);
}

/**
 * The claims of a reading (strengths, concerns) after the quote check: one whose quote is not in the source is dropped;
 * one quoting too little to show anything (`meaningfulQuote`), or nothing, is kept and marked "no quote". The CV reading
 * and the AI interview's scorecard both pass theirs through it.
 */
export function checkedClaims(claims: readonly Claim[], inSource: (e: Evidence) => boolean): Claim[] {
  return claims.flatMap((f) => {
    if (!f.evidence.quote?.trim()) return [{ ...f, evidence: marked(f.evidence) }];
    if (!meaningfulQuote(f.evidence.quote)) return [{ ...f, evidence: keptEvidence(f.evidence, "thin") }];
    return inSource(f.evidence) ? [{ ...f, evidence: marked(f.evidence) }] : [];
  });
}

/**
 * The evidence rules a CV reading passes before anyone sees it. `inSource(e)` says whether a non-empty quote is in the
 * candidate's own text.
 * - A strength or concern whose quote is not in the source is dropped (`checkedClaims`).
 * - A skill or must-have finding whose quote is not in the source keeps its place without the quote: "evidenced" becomes
 *   "partially evidenced", a must-have "yes" becomes "partially".
 * - A must-have "no" stands only on a verified quote from the candidate; otherwise it becomes "unknown": a gap is a
 *   question to ask, never a conclusion.
 * - A quote too short to show anything (`meaningfulQuote`: a lone "yes", "I do", one word) is no evidence: it is taken
 *   off and the claim is marked "no quote", as if nothing were quoted (so a "yes" on it never scores in full).
 * - The licence rule (`credentialFinding`), for a credential must-have (`credentials`: one that names a licence,
 *   certificate, permit or registration) with a checked quote, read from the candidate's words around the quote
 *   (`lineOf`), never only the part the model chose: "no" when they say plainly they do not hold it, whatever the model
 *   answered; lapsed, expired, pending or unclear is "unknown".
 * - A claim about the candidate with nothing quoted is kept and marked `unquoted`, so the page says "no quote".
 * The model's own `unquoted` marks are never trusted: the flag is recomputed here.
 */
export function applyEvidenceRules<T extends Readable>(a: T, inSource: (e: Evidence) => boolean, opts: EvidenceRuleOptions = {}): T {
  const check = (e: Evidence | undefined): QuoteCheck => {
    if (!e?.quote?.trim()) return "none";
    if (!meaningfulQuote(e.quote)) return "thin";
    return inSource(e) ? "verified" : "failed";
  };
  const competencyFindings = a.competencyFindings.map((f): CompetencyFinding => {
    const c = check(f.evidence);
    if (c !== "failed") return { ...f, evidence: f.evidence ? keptEvidence(f.evidence, c) : undefined };
    return { ...f, evidence: keptEvidence(f.evidence!, c), finding: f.finding === "evidenced" ? "partially_evidenced" : f.finding, note: [f.note, "quote could not be verified against the source"].filter(Boolean).join("; ") };
  });
  const requirementFindings = a.requirementFindings.map((f): RequirementFinding => {
    const c = check(f.evidence);
    const evidence = !f.evidence ? undefined : keptEvidence(f.evidence, c);
    if (f.met === "no" && c !== "verified") return { ...f, evidence, met: "unknown" };
    const met = c === "failed" && f.met === "yes" ? "partially" : f.met;
    // The licence rule, on a quote that stands, read from the candidate's line around it.
    if (opts.credentials?.has(f.requirementKey) && c === "verified" && f.evidence?.quote) return { ...f, evidence, met: credentialFinding(met, opts.lineOf?.(f.evidence) ?? f.evidence.quote, opts.subjects?.get(f.requirementKey) ?? null) };
    return { ...f, evidence, met };
  });
  return { ...a, strengths: checkedClaims(a.strengths, inSource), concerns: checkedClaims(a.concerns, inSource), competencyFindings, requirementFindings };
}
