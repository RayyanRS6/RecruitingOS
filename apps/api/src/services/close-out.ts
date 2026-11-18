import { and, inArray, isNotNull } from "drizzle-orm";
import { sendCloseOutNotes } from "@ros/agents";
import { applications, withPlatform, withTenant, type Db } from "@ros/db";
import type { Integrations } from "@ros/integrations";

/** The daily check that writes the close-out note to everyone it is due to. */
export const CLOSE_OUT_JOB_KIND = "candidates.close_out_notes";

/**
 * The close-out notes that are due, company by company: `sendCloseOutNotes` decides who (someone still past their
 * plan's candidates per job on an open or paused job when the latest date they were promised comes) and writes each
 * note once. It keeps the promise the on-file wording makes: "we email you either way, at the latest 30 days after you
 * apply". Only companies with someone locked and unread are visited. A company that fails does not stop the others;
 * the first failure is thrown at the end, so the queue records it and runs the check again. Returns how many notes
 * were written.
 */
export async function sendDueCloseOutNotes(deps: { db: Db; integrations: Integrations; jobsBaseUrl: string }, now: Date): Promise<number> {
  const companies = await withPlatform(deps.db, (tx) => tx.selectDistinct({ id: applications.companyId }).from(applications).where(and(isNotNull(applications.lockedAt), inArray(applications.stage, ["applied", "received"]))));
  let written = 0;
  let firstError: unknown = null;
  for (const company of companies) {
    try {
      // The candidate's status link lives on the job-page host.
      const noted = await withTenant(deps.db, company.id, (tx) => sendCloseOutNotes(tx, { integrations: deps.integrations, statusBaseUrl: deps.jobsBaseUrl, now, actor: { kind: "system", id: "close_out" } }, company.id));
      written += noted.length;
    } catch (err) {
      firstError ??= err;
    }
  }
  if (firstError) throw firstError;
  return written;
}