import type { Confidence, EligibilityResult, Evidence, EvidenceAssessment, EvidenceSource, ResumeExtraction, RolePacket } from "@ros/contracts";
import { resumeExtractPrompt, runPromptDetached, triageAssessPrompt, type AiRuntime, type RunOutcome, type TriageInput } from "@ros/ai";
import type { Db } from "@ros/db";
import { SCORING_VIEW_VERSION, restoreQuotes, scoringView, withoutPlaceholders, type ScoringIdentity, type ScoringView } from "./scoring-view";

export { PLACEHOLDER as SCORING_PLACEHOLDER, SCORING_VIEW_VERSION, hasPlaceholder, restoreQuotes, scoringView, withoutPlaceholders, type HiddenKind, type ScoringIdentity, type ScoringView } from "./scoring-view";

/**
 * Resume extraction (Triage agent, Slice 1). Quotes are verified against the source text in code:
 * any quote that is not a substring of the resume is dropped and the entry is marked as unquoted, so
 * nothing the model invented can be presented as evidence. The model is called with no transaction open;
 * the run is recorded in its own short one.
 */
export async function extractResume(db: Db, ai: AiRuntime, input: { companyId: string; workflowRunId?: string | null; text: string; filename?: string; documentId: string }): Promise<RunOutcome<ResumeExtraction>> {
  const out = await runPromptDetached(db, ai, resumeExtractPrompt, { text: input.text, filename: input.filename }, { companyId: input.companyId, workflowRunId: input.workflowRunId ?? null, inputRef: { documentId: input.documentId, chars: input.text.length } });
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
    education: ex.education.map((e) => ({ ...e, quote: check(e.quote) })),
    licenses: ex.licenses.map((l) => ({ ...l, quote: check(l.quote) })),
    certifications: ex.certifications.map((c) => ({ ...c, quote: check(c.quote) })),
  };
}

/**
 * Inputs to the evidence-based assessment; the workflow assembles them from the system of record. `identity` is who the
 * application is from (the candidate's record), used only to hide those details from the reading (`scoringInput`).
 * Earlier applications to the company are not an input (founder decision D-04 = C): the team sees them on the
 * candidate's page; the reading never does.
 */
export type AssessInput = {
  companyId: string;
  workflowRunId?: string | null;
  applicationId: string;
  packet: RolePacket;
  extraction: ResumeExtraction | null;
  resumeText: string | null;
  applicationAnswers: { eligibility: Record<string, unknown>; noResumeSummary?: string };
  eligibility: EligibilityResult | null;
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
 * What the résumé reading is given (D-04 = C): the résumé, the written answer, the eligibility answers and the extraction
 * as the scoring view shows them (name, email, phone, street address and links replaced by placeholders), with the
 * scoring view itself, which maps a quote back to the original words and counts what was hidden.
 */
export function scoringInput(input: Pick<AssessInput, "packet" | "extraction" | "resumeText" | "applicationAnswers" | "eligibility" | "identity">): { promptInput: TriageInput; view: ScoringView } {
  const view = scoringView({ ...input.identity, fullName: input.identity.fullName ?? input.extraction?.fullName ?? null, keep: [...(input.identity.keep ?? []), ...jobWords(input.packet, input.extraction)] });
  const { noResumeSummary } = input.applicationAnswers;
  const promptInput: TriageInput = {
    packet: input.packet,
    extraction: input.extraction ? view.deep(input.extraction) : null,
    resumeText: input.resumeText === null ? null : view.text(input.resumeText),
    applicationAnswers: { eligibility: view.deep(input.applicationAnswers.eligibility), ...(noResumeSummary === undefined ? {} : { noResumeSummary: view.text(noResumeSummary) }) },
    eligibility: input.eligibility,
  };
  return { promptInput, view };
}

/**
 * How many times an application is read. The fairness run on Haiku 5.5 (14 Oct 2026) showed one reading of the same
 * résumé moving a competency between "evidenced" and "partially evidenced", and so the score by 5 to 11 points; the
 * middle answer of three readings (`combineReadings`) holds still. The three run side by side, about a cent in all.
 */
export const TRIAGE_READINGS = 3;

/** The texts a résumé reading may quote, by source, for the quote check. */
export function assessmentSources(input: Pick<AssessInput, "resumeText" | "applicationAnswers">): Partial<Record<EvidenceSource, string>> {
  return {
    resume: input.resumeText ?? "",
    application: `${input.applicationAnswers.noResumeSummary ?? ""}\n${JSON.stringify(input.applicationAnswers.eligibility)}`,
    candidate_statement: input.applicationAnswers.noResumeSummary ?? "",
  };
}

/**
 * Evidence-based assessment (Triage agent, Slice 2). The model reads the application `TRIAGE_READINGS` times; code
 * verifies every quote against the source text and discards any claim whose quote cannot be found, so nothing invented
 * reaches the owner, then keeps the middle answer of the readings for each finding.
 */
export async function assessApplication(db: Db, ai: AiRuntime, input: AssessInput): Promise<RunOutcome<EvidenceAssessment>> {
  const { promptInput, view } = scoringInput(input);
  // The record says which view the reading used and how many details it hid: counts only, never the values.
  const inputRef = { applicationId: input.applicationId, resumeChars: input.resumeText?.length ?? 0, hasExtraction: !!input.extraction, scoringView: SCORING_VIEW_VERSION, hidden: view.counts() };
  const read = (reading: number) => runPromptDetached(db, ai, triageAssessPrompt, promptInput, { companyId: input.companyId, workflowRunId: input.workflowRunId ?? null, inputRef: { ...inputRef, reading } });
  const runs = await Promise.all(Array.from({ length: TRIAGE_READINGS }, (_, i) => read(i + 1)));
  // A reading lost to an outage is asked once more; one still lost fails the step, which the engine retries, rather than
  // leaving this applicant with fewer readings than the next.
  const settled = await Promise.all(runs.map((r, i) => (!r.ok && r.reason === "error" ? read(i + 1) : r)));
  const outage = settled.find((r) => !r.ok && r.reason === "error");
  if (outage) return outage;
  return readingsOutcome(settled, view, input);
}

/**
 * The readings as the team sees them, combined into the middle answer. Quotes are checked against the ORIGINAL words,
 * and shown as the candidate wrote them: one the model wrote around a placeholder is mapped back first
 * (`restoreReadingQuotes`); one that cannot be fails the check. The model's own words (summary, claims, unknowns) keep no
 * placeholder either: "[name]" reads "the candidate". Shared with the fairness evals (packages/evals), so they check
 * exactly what the app does after the model has answered.
 */
export function readingsOutcome(readings: ReadonlyArray<RunOutcome<Reading>>, view: Pick<ScoringView, "restore">, input: Pick<AssessInput, "resumeText" | "applicationAnswers" | "packet">): RunOutcome<Reading> {
  const sources = assessmentSources(input);
  return combineOutcomes(readings.map((r) => (r.ok ? { ...r, output: withoutPlaceholders(restoreReadingQuotes(r.output, view, sources)) } : r)), sources, credentialMustHaves(input.packet));
}

/**
 * A reading's quotes as the candidate wrote them (D-04 = C): each quote with a placeholder mapped back to the original
 * text of the source it cites, else of any source. Exported for the tests.
 */
export function restoreReadingQuotes<T>(reading: T, view: Pick<ScoringView, "restore">, sources: Partial<Record<EvidenceSource, string>>): T {
  const all = Object.values(sources).filter((s): s is string => !!s);
  return restoreQuotes(reading, view, (source) => {
    const own = source ? sources[source as EvidenceSource] : undefined;
    return own ? [own, ...all.filter((s) => s !== own)] : all;
  });
}

/**
 * The must-haves that name a licence, certificate, permit or registration: the only ones the expired-credential rule
 * (`applyEvidenceRules`, `shownNotHeld`) may settle.
 */
export function credentialMustHaves(packet: Pick<RolePacket, "requirements">): ReadonlySet<string> {
  return new Set(packet.requirements.mustHaves.filter((m) => /licen[cs]|certif|permit|registration|registered|credential/i.test(m.text)).map((m) => m.key));
}

type Reading = EvidenceAssessment;
type Failure = Extract<RunOutcome<Reading>, { ok: false }>;

/**
 * The readings that came back, each through the evidence rules, combined into one (`combineReadings`). With fewer than
 * three (a reading refused or unusable) the first is used, and its confidence reasons say it was read fewer times. With
 * none, the failure: an outage when any reading had one, so the step is retried.
 */
export function combineOutcomes(runs: ReadonlyArray<RunOutcome<Reading>>, sources: Partial<Record<EvidenceSource, string>>, credentials?: ReadonlySet<string>): RunOutcome<Reading> {
  const ok = runs.filter((r): r is Extract<RunOutcome<Reading>, { ok: true }> => r.ok);
  if (!ok.length) return runs.find((r): r is Failure => !r.ok && r.reason === "error") ?? runs[0]!;
  const readings = ok.map((r) => verifyAssessmentQuotes(r.output, sources, credentials));
  if (readings.length >= TRIAGE_READINGS) return { ...ok[0]!, output: combineReadings(readings) };
  const one = readings[0]!;
  const reason = `the assistant could read this application ${readings.length === 1 ? "once" : `${readings.length} times`} instead of ${TRIAGE_READINGS}`;
  return { ...ok[0]!, output: { ...one, confidenceReasons: [...(one.confidenceReasons ?? []), reason].slice(-6) } };
}

const MET_ORDER = ["no", "unknown", "partially", "yes"] as const;
const FINDING_ORDER = ["contradicted", "not_evidenced", "partially_evidenced", "evidenced"] as const;
const OVERALL_ORDER = ["weak", "potential", "strong"] as const;
const CONFIDENCE_ORDER = ["low", "medium", "high"] as const;

/**
 * The middle value on the finding's own order. For an even number the upper middle: a tie never resolves against the
 * candidate. Every reading gives exactly one value per key (`combineReadings`), so with three readings it is the true middle.
 */
function middle<T extends string>(values: readonly T[], order: readonly T[]): T {
  const sorted = [...values].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The overall reading of several: "unknown" when most readings say so, otherwise the middle of the others. */
function middleOverall(values: readonly Reading["overall"][]): Reading["overall"] {
  const known = values.filter((v): v is (typeof OVERALL_ORDER)[number] => v !== "unknown");
  return known.length * 2 <= values.length && values.some((v) => v === "unknown") ? "unknown" : middle(known, OVERALL_ORDER);
}

/**
 * One reading from several of the same application (three, after the evidence rules), the same whatever order they
 * came back in:
 * - each reading gives exactly one answer per must-have and per competency (its first; a reading that left one out
 *   counts as "unknown" or "not evidenced"), and the result is the middle answer (must-haves ordered no, unknown,
 *   partially, yes; competencies contradicted, not evidenced, partially, evidenced), with the evidence of a reading that
 *   gave it;
 * - the overall reading and the confidence are the middle on their own order ("unknown" only when most readings say so);
 * - the recommendation, the confidence reasons and the words (summary, strengths, concerns, questions) all come from one
 *   reading, the closest to that result, so they never contradict each other.
 */
export function combineReadings(readings: readonly Reading[]): Reading {
  const reqKeys = [...new Set(readings.flatMap((r) => r.requirementFindings.map((f) => f.requirementKey)))].sort();
  const compKeys = [...new Set(readings.flatMap((r) => r.competencyFindings.map((f) => f.competencyKey)))].sort();
  const reqOf = (r: Reading, k: string) => r.requirementFindings.find((f) => f.requirementKey === k);
  const compOf = (r: Reading, k: string) => r.competencyFindings.find((f) => f.competencyKey === k);
  const met = new Map(reqKeys.map((k) => [k, middle(readings.map((r) => reqOf(r, k)?.met ?? "unknown"), MET_ORDER)]));
  const found = new Map(compKeys.map((k) => [k, middle(readings.map((r) => compOf(r, k)?.finding ?? "not_evidenced"), FINDING_ORDER)]));
  const overall = middleOverall(readings.map((r) => r.overall));
  const confidence = middle(readings.map((r) => r.confidence), CONFIDENCE_ORDER);
  // the closest reading: the same overall, then the same confidence, then the most findings; a tie is settled by the
  // reading's own content, never by the order the readings came back in
  const agreement = (r: Reading) => (r.overall === overall ? 1000 : 0) + (r.confidence === confidence ? 500 : 0) + reqKeys.filter((k) => reqOf(r, k)?.met === met.get(k)).length * 10 + compKeys.filter((k) => compOf(r, k)?.finding === found.get(k)).length;
  const ranked = [...readings].sort((a, b) => agreement(b) - agreement(a) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const closest = ranked[0]!;
  const requirementFindings = reqKeys.map((k) => ranked.map((r) => reqOf(r, k)).find((f) => f?.met === met.get(k)) ?? { requirementKey: k, met: met.get(k)! });
  const competencyFindings = compKeys.map((k) => ranked.map((r) => compOf(r, k)).find((f) => f?.finding === found.get(k)) ?? { competencyKey: k, finding: found.get(k)! });
  return { ...closest, overall, confidence, requirementFindings, competencyFindings };
}

/**
 * Checks every quote in a résumé assessment against the text it cites (plan 0.9, through `applyEvidenceRules`).
 * Sources not listed (playbook, benchmark, owner statements) are not candidate claims and pass through; a candidate
 * source with no text here (a screen or interview quoted in a résumé reading) cannot be checked, so it counts as unverified.
 */
export function verifyAssessmentQuotes(a: EvidenceAssessment, sources: Partial<Record<EvidenceSource, string>>, credentials?: ReadonlySet<string>): EvidenceAssessment {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const normalized = new Map<string, string>();
  for (const [k, v] of Object.entries(sources)) normalized.set(k, norm(v ?? ""));
  return applyEvidenceRules(a, (e) => {
    const src = normalized.get(e.source);
    if (src === undefined) return CANDIDATE_EVIDENCE_SOURCES.has(e.source) ? false : null;
    return src.includes(norm(e.quote ?? ""));
  }, { credentials });
}

/** The candidate's own record or words: a claim citing one of these must quote it, and the quote is checked. */
export const CANDIDATE_EVIDENCE_SOURCES: ReadonlySet<EvidenceSource> = new Set<EvidenceSource>(["resume", "application", "candidate_statement", "screen", "interview"]);

const NOT_HELD = /\b(expired|lapsed|inactive|revoked|suspended|not renewed|renewal not started)\b/gi;
const STILL_HELD = /\b(active|current|currently|valid|reinstated|reactivated|good standing)\b|(?<!\bnot )\brenewed\b/i;
/** A status word just after a negation ("never lapsed", "not expired", "hasn't been suspended", "non-expired") says the opposite. */
const NEGATED = /(\b(never|not|no|nor|without)\b[^.;,]{0,20}|n't\s+(been\s+)?|\bnon-?\s*)$/i;

/**
 * Whether a quote says a licence or certificate is not held today: an expired-and-the-like word that is not negated, and
 * nothing in the quote saying it is held again (active, current, valid, renewed, reinstated, in good standing).
 */
export function shownNotHeld(quote: string): boolean {
  if (STILL_HELD.test(quote)) return false;
  for (const m of quote.matchAll(NOT_HELD)) {
    const at = m.index ?? 0;
    if (!NEGATED.test(quote.slice(Math.max(0, at - 30), at))) return true;
  }
  return false;
}

/** One step down: what a reader can rely on once a claim lost its quote. */
export function stepDownConfidence(c: Confidence): Confidence {
  return c === "high" ? "medium" : "low";
}

/** The parts of a reading the evidence rules touch; a résumé assessment and a screen scorecard both have them. */
type Readable = Pick<EvidenceAssessment, "confidence" | "confidenceReasons" | "strengths" | "concerns" | "competencyFindings" | "requirementFindings" | "anomalies">;
type Claim = EvidenceAssessment["strengths"][number];
type CompetencyFinding = EvidenceAssessment["competencyFindings"][number];
type RequirementFinding = EvidenceAssessment["requirementFindings"][number];

/**
 * The evidence rules every reading passes before anyone sees it (plan 0.9). `inSource(e)` says whether a non-empty quote
 * is in the text it cites: true, false, or null for a source that is not the candidate's (it passes through).
 * - A strength or concern whose quote is not in the source is dropped.
 * - A competency or must-have finding whose quote is not in the source keeps its place without the quote: "evidenced"
 *   becomes "partially evidenced", a must-have "yes" becomes "partially".
 * - A must-have "no" stands only on a verified quote from the candidate; otherwise it becomes "unknown". A gap is a
 *   question for the screen, never a conclusion.
 * - A credential must-have (`credentials`: one that names a licence, certificate, permit or registration) that the
 *   reading left "unknown" although its verified quote from the candidate says the credential is expired, lapsed,
 *   inactive, revoked, suspended or not renewed (`shownNotHeld`: never negated, never held again) is "no". The fairness
 *   run on Haiku 5.5 (14 Oct 2026) quoted "RDH license CA expired in 2021; renewal not started" and still wrote "unknown"
 *   in two readings of three. The rule only settles an "unknown": it never overturns a "yes" or a "partially".
 * - A claim about the candidate with nothing quoted is kept and marked `unquoted`, so the page says "no quote".
 * - When any of that happened the confidence steps down one level, and the reasons say why.
 * The model's own `unquoted` marks are never trusted: the flag is recomputed here.
 */
export function applyEvidenceRules<T extends Readable>(a: T, inSource: (e: Evidence) => boolean | null, opts: { credentials?: ReadonlySet<string> } = {}): T {
  type Check = "verified" | "failed" | "external" | "none";
  const check = (e: Evidence | undefined): Check => {
    if (!e?.quote?.trim()) return "none";
    const r = inSource(e);
    return r === null ? "external" : r ? "verified" : "failed";
  };
  /** The evidence as shown: the model's flag removed, `unquoted` set when a candidate claim has no quote. */
  const marked = (e: Evidence): Evidence => {
    const { unquoted: _unquoted, ...rest } = e;
    return !rest.quote?.trim() && CANDIDATE_EVIDENCE_SOURCES.has(rest.source) ? { ...rest, quote: undefined, unquoted: true } : rest;
  };
  /** A quote that failed the check: the source stays, the quote goes. */
  const stripped = (e: Evidence): Evidence => marked({ source: e.source });
  let dropped = 0;
  let mustHaveNoWithoutQuote = 0;
  const keepClaim = (f: Claim): Claim | null => {
    if (check(f.evidence) === "failed") {
      dropped += 1;
      return null;
    }
    return { ...f, evidence: marked(f.evidence) };
  };
  const strengths = a.strengths.map(keepClaim).filter((f): f is Claim => f !== null);
  const concerns = a.concerns.map(keepClaim).filter((f): f is Claim => f !== null);
  const competencyFindings = a.competencyFindings.map((f): CompetencyFinding => {
    if (check(f.evidence) !== "failed") return { ...f, evidence: f.evidence ? marked(f.evidence) : undefined };
    dropped += 1;
    return { ...f, evidence: stripped(f.evidence!), finding: f.finding === "evidenced" ? "partially_evidenced" : f.finding, note: [f.note, "quote could not be verified against the source"].filter(Boolean).join("; ") };
  });
  const requirementFindings = a.requirementFindings.map((f): RequirementFinding => {
    const c = check(f.evidence);
    if (c === "failed") dropped += 1;
    const evidence = !f.evidence ? undefined : c === "failed" ? stripped(f.evidence) : marked(f.evidence);
    if (f.met === "no" && c !== "verified") {
      mustHaveNoWithoutQuote += 1;
      return { ...f, evidence, met: "unknown" };
    }
    // an "unknown" credential the candidate's own verified words show expired; a recruiter's call note never makes a "no"
    if (f.met === "unknown" && opts.credentials?.has(f.requirementKey) && c === "verified" && f.evidence && CANDIDATE_EVIDENCE_SOURCES.has(f.evidence.source) && shownNotHeld(f.evidence.quote ?? "")) return { ...f, evidence, met: "no" };
    return { ...f, evidence, met: c === "failed" && f.met === "yes" ? "partially" : f.met };
  });
  if (!dropped && !mustHaveNoWithoutQuote) return { ...a, strengths, concerns, competencyFindings, requirementFindings };
  const anomalies = dropped ? [...a.anomalies, { kind: "unverified_quote", detail: `${dropped} claim${dropped === 1 ? "" : "s"} cited text that is not in the source and ${dropped === 1 ? "was" : "were"} discarded` }] : a.anomalies;
  // Dropping a claim lowers what the owner can rely on; say so where the card explains the confidence.
  const reasons = [...(a.confidenceReasons ?? [])];
  if (dropped) reasons.push(`${dropped === 1 ? "one claim" : `${dropped} claims`} quoted text that is not in the source and ${dropped === 1 ? "was" : "were"} dropped`);
  if (mustHaveNoWithoutQuote) reasons.push(`${mustHaveNoWithoutQuote === 1 ? "one must-have was" : `${mustHaveNoWithoutQuote} must-haves were`} marked not met with nothing quoted to show it, so ${mustHaveNoWithoutQuote === 1 ? "it is" : "they are"} treated as unknown`);
  // The schema allows six reasons; the newest (why the confidence just dropped) are the ones to keep.
  return { ...a, strengths, concerns, competencyFindings, requirementFindings, anomalies, confidence: stepDownConfidence(a.confidence), confidenceReasons: reasons.slice(-6) };
}
