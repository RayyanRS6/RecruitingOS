import { eq } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { sendTalentPoolOptOutConfirmation } from "@ros/agents";
import { emit } from "@ros/core";
import { applications, candidates, companies, type CandidatePreferences, type Tx } from "@ros/db";
import type { Container } from "../container";

type Application = typeof applications.$inferSelect;

/**
 * The person asked not to be kept for future roles. Every way into the talent pool checks this first (the team's "move
 * to the talent pool" today, the pool board and any future-role outreach later): they may leave a role's active list,
 * but they are never marked as kept, and nobody contacts them about other openings.
 */
export function leftOutOfTalentPool(candidate: { preferences: CandidatePreferences }): boolean {
  return !!candidate.preferences.talentPoolOptOut;
}

/**
 * "Don't keep me for future roles" (Wave 0 item 0.11), from a "no thanks" reply or the button on the status page. The
 * person's record says so (`preferences.talentPoolOptOut`, `inTalentPool` false), the choice is recorded as a consent
 * withdrawal (`consent.revoked`, purpose `talent_pool`), and one confirmation goes to the address on file. An application in progress is not
 * touched. Saying it again changes and sends nothing (false). Runs inside the company's transaction.
 */
export async function optOutOfTalentPool(tx: Tx, container: Container, input: { application: Application; source: "email_reply" | "status_page" }): Promise<boolean> {
  const { application } = input;
  const [candidate] = await tx.select().from(candidates).where(eq(candidates.id, application.candidateId)).limit(1);
  if (!candidate || candidate.anonymizedAt) return false;
  if (candidate.preferences.talentPoolOptOut && !candidate.inTalentPool) return false;
  const actor: Actor = { kind: "candidate", id: candidate.id };
  const preferences = { ...candidate.preferences, talentPoolOptOut: true };
  await tx.update(candidates).set({ preferences, inTalentPool: false }).where(eq(candidates.id, candidate.id));
  await emit(tx, { type: "consent.revoked", companyId: candidate.companyId, actor, subject: { type: "candidate", id: candidate.id }, payload: { purpose: "talent_pool", source: input.source, applicationId: application.id } });
  const [company] = await tx.select().from(companies).where(eq(companies.id, candidate.companyId)).limit(1);
  if (company) await sendTalentPoolOptOutConfirmation(tx, container.integrations, { application, candidate: { ...candidate, preferences, inTalentPool: false }, company, appBaseUrl: container.env.JOBS_BASE_URL, actor });
  return true;
}

/**
 * "Keep me for future roles again" on the status page: the person takes their opt-out back. Recorded as consent given
 * again (`consent.granted`, purpose `talent_pool`). Being kept is still the team's decision, so `inTalentPool` is left
 * as it is. When nothing was withdrawn, nothing changes (false). Runs inside the company's transaction.
 */
export async function optBackIntoTalentPool(tx: Tx, input: { application: Application }): Promise<boolean> {
  const { application } = input;
  const [candidate] = await tx.select().from(candidates).where(eq(candidates.id, application.candidateId)).limit(1);
  if (!candidate || candidate.anonymizedAt || !leftOutOfTalentPool(candidate)) return false;
  await tx.update(candidates).set({ preferences: { ...candidate.preferences, talentPoolOptOut: false } }).where(eq(candidates.id, candidate.id));
  await emit(tx, { type: "consent.granted", companyId: candidate.companyId, actor: { kind: "candidate", id: candidate.id }, subject: { type: "candidate", id: candidate.id }, payload: { purpose: "talent_pool", source: "status_page", applicationId: application.id } });
  return true;
}
