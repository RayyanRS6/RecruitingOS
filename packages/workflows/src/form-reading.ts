import { and, desc, eq, sql } from "drizzle-orm";
import { ResumeExtraction } from "@ros/contracts";
import { aiRuns, documents, type Queryable } from "@ros/db";
import type { Integrations } from "@ros/integrations";

/**
 * The apply form's own reading of a résumé (Wave S7, apps/api/src/services/apply-details.ts), shared with the intake
 * workflow so one upload is read by the model once (20 October 2026, R20-1): the reading job, the link at Send and the
 * intake's `extract` all find the reading by its upload, not by the note the form reads, so a note that could not be
 * written, a Send pressed before the reading finished, or a retry of the job never means a second model call.
 */

/** The event the reading job signals when it finishes, read or not; the intake waits on `formReadSignal(uploadId)`. */
export const FORM_READ_EVENT = "resume.form_read";
export const formReadSignal = (uploadId: string): string => `${uploadId}:${FORM_READ_EVENT}`;
/** How long a reading is reused (and kept before its words are scrubbed, when nobody sent it). */
export const FORM_READING_KEEP_MS = 24 * 3_600_000;
/** How long after the form asked for a reading the intake waits for it before reading the file itself. */
export const FORM_READ_WAIT_MS = 3 * 60_000;

type UploadRef = { companyId: string; roleId: string; uploadId: string };

/** Where the form's note about a reading lives: beside its quarantined file, under the company's own quarantine area. */
export function formReadingNoteKey(ref: UploadRef): string {
  return `quarantine/${ref.companyId}/${ref.roleId}/${ref.uploadId}.read.json`;
}

/** What the form's note says came of the reading ("read", "unreadable", "refused", "failed"); null while there is none. */
export async function formReadingOutcome(storage: Pick<Integrations["storage"], "get">, ref: UploadRef): Promise<string | null> {
  const bytes = await storage.get(formReadingNoteKey(ref));
  if (!bytes) return null;
  try {
    const note = JSON.parse(new TextDecoder().decode(bytes)) as { v?: unknown; uploadId?: unknown; outcome?: unknown } | null;
    return note && note.v === 1 && note.uploadId === ref.uploadId && typeof note.outcome === "string" ? note.outcome : null;
  } catch {
    return null;
  }
}

/**
 * A good form reading of one upload in the last day (`FORM_READING_KEEP_MS`), by the database's clock, the one that
 * stamped the run. Given an application, only one not tied to another application (two sent from one upload: the
 * second reads its own copy, never waits on or fails over the first's reading).
 */
const formRunsOf = (input: { companyId: string; uploadId: string; applicationId?: string }) =>
  and(
    eq(aiRuns.companyId, input.companyId),
    sql`${aiRuns.createdAt} >= now() - interval '24 hours'`,
    eq(aiRuns.task, "resume.extract"),
    eq(aiRuns.status, "ok"),
    sql`${aiRuns.inputRef}->>'uploadId' = ${input.uploadId}`,
    sql`${aiRuns.inputRef}->>'purpose' = 'apply_form'`,
    input.applicationId ? sql`(${aiRuns.inputRef}->>'applicationId' IS NULL OR ${aiRuns.inputRef}->>'applicationId' = ${input.applicationId})` : undefined,
  );

/**
 * The form's good reading of one upload in the last day, its output checked against the extraction schema; null when
 * there is none. With `applicationId`, one already tied to another application does not count.
 */
export async function formReadingRun(q: Queryable, input: { companyId: string; uploadId: string; applicationId?: string }): Promise<{ runId: string; model: string; output: ResumeExtraction } | null> {
  const [run] = await q.select({ id: aiRuns.id, model: aiRuns.model, structuredOutput: aiRuns.structuredOutput }).from(aiRuns).where(formRunsOf(input)).orderBy(desc(aiRuns.createdAt)).limit(1);
  if (!run) return null;
  const parsed = ResumeExtraction.safeParse(run.structuredOutput);
  return parsed.success ? { runId: run.id, model: run.model, output: parsed.data } : null;
}

/**
 * Ties the form's reading of an upload to the application and its résumé document: the run names both (a deletion
 * request scrubs it, the day-later clean-up leaves it alone) and the document points at the run (the intake reuses it).
 * Only a good `apply_form` reading of exactly this upload, not already tied to another application. Returns the run's id.
 */
export async function linkFormReading(q: Queryable, input: { companyId: string; uploadId: string; applicationId: string; documentId: string }): Promise<string | null> {
  const [run] = await q.select({ id: aiRuns.id, inputRef: aiRuns.inputRef }).from(aiRuns).where(formRunsOf(input)).orderBy(desc(aiRuns.createdAt)).limit(1);
  if (!run) return null;
  await q.update(aiRuns).set({ inputRef: { ...run.inputRef, applicationId: input.applicationId, documentId: input.documentId } }).where(eq(aiRuns.id, run.id));
  await q.update(documents).set({ extractedByAiRunId: run.id }).where(eq(documents.id, input.documentId));
  return run.id;
}
