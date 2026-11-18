import { z } from "zod";

export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

export const ActorKind = z.enum(["user", "agent", "system", "candidate"]);
export type ActorKind = z.infer<typeof ActorKind>;

/** Who did something. Every event, audit record, and packet version carries one. */
export const Actor = z.object({
  kind: ActorKind,
  id: z.string().min(1),
  name: z.string().optional(),
  /** For agents: the ai_runs row that produced the action. */
  runId: z.string().optional(),
});
export type Actor = z.infer<typeof Actor>;

export const SubjectType = z.enum([
  "company",
  "user",
  "role",
  "role_packet",
  "intake_session",
  "candidate",
  "application",
  "screen",
  "communication",
  "workflow_run",
  "ai_run",
  "document",
  "invitation",
]);
export type SubjectType = z.infer<typeof SubjectType>;

export const Subject = z.object({ type: SubjectType, id: z.string().min(1) });
export type Subject = z.infer<typeof Subject>;

export const Location = z.object({
  label: z.string().optional(),
  address1: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(), // state or province code, e.g. CA
  postalCode: z.string().optional(),
  country: z.string().default("US"),
  timezone: z.string().optional(),
});
export type Location = z.infer<typeof Location>;

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

/**
 * Where a quote came from: the CV, the application form's answers, the AI interview, or something the candidate or the
 * owner stated.
 */
export const EvidenceSource = z.enum(["resume", "application", "screen", "candidate_statement", "verified", "owner_statement"]);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/** Where a quote is from, in the app's own words, for the sources a quote of the candidate's is checked against. */
const QUOTE_FROM: Partial<Record<EvidenceSource, string>> = {
  resume: "from the CV",
  application: "from the application",
  candidate_statement: "from the application",
  screen: "in the AI interview",
};

/**
 * A quote with where it is from after it, `"…", from the CV`, so a CV line never reads as the candidate's words in the AI
 * interview. Just the quote for a source with no such words.
 */
export function quoteWithSource(quote: string, source: string | null | undefined): string {
  const from = source ? QUOTE_FROM[source as EvidenceSource] : undefined;
  return from ? `"${quote}", ${from}` : `"${quote}"`;
}

/**
 * A claim must point at where it came from. Quotes are verified against the source text in code.
 * `context` (date, role, employer) lets the reader judge the evidence, not just find it.
 */
export const Evidence = z.object({
  source: EvidenceSource,
  quote: z.string().optional(),
  ref: z.string().optional(),
  confidence: Confidence.optional(),
  context: z.string().optional(),
  /** Set in code, never trusted from the model: a claim about the candidate with nothing verified quoted from them. */
  unquoted: z.boolean().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/** Whether a piece of evidence carries a quote the code checked against the candidate's own words. */
export function hasCheckedQuote(evidence: { quote?: string | null; unquoted?: boolean | null } | null | undefined): boolean {
  return !!evidence?.quote?.trim() && !evidence.unquoted;
}

export const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

/** A calendar date (YYYY-MM-DD) that exists: 2026-02-30 is refused here, before anything reads it as March 2. */
export const CalendarDate = ISODate.refine((d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}, "That date does not exist.");
