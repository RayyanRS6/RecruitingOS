import { and, eq, inArray } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { emit } from "@ros/core";
import { approvalRequests, interviews, screens, type Tx } from "@ros/db";
import type { Container } from "../container";
import { cancelInterviewInTx, type CancelNotice } from "./interview-cancel";

/**
 * Leaving the process cleans up (plan A9): an application that is declined, moved to the talent pool, withdrawn or
 * closed with its role has its interviews still to come and its open screens cancelled, and the assistant's waiting
 * suggestions about it withdrawn, so no reminder, booking link or screening question reaches someone who is out.
 * `candidateEmail` says what the candidate hears about it:
 * - "send_cancellation": the candidate's own news (they withdrew, declined an offer). Every interview they knew about
 *   (a booked time, or times they were offered) is called off with a short note.
 * - "private_decision": the team's decision, which stays private until a person sends it (founder decision B6;
 *   plan-adjustments §4). Nothing is sent here: a booked time and offered times are withdrawn quietly (their link says
 *   so), and the decision message, when someone sends it, says the interview is off. One message, not two.
 * - "with_decision_message": nothing is sent here either, because the caller sends the decision message in this same
 *   transaction and that message names the cancelled interview.
 * A screen is closed without a note in every case (its link says the conversation is closed). A booked interview whose
 * time has already started is left to the scheduling run, which records that it ended without asking for a decision.
 */
export type ExitCandidateEmail = "send_cancellation" | "private_decision" | "with_decision_message";
export type ExitCleanupInput = { companyId: string; applicationId: string; reason: string; actor: Actor; candidateEmail: ExitCandidateEmail };
export type ExitCleanupResult = { interviewsCancelled: number; screensCancelled: number; suggestionsWithdrawn: number; candidateNotes: number };

const NOTICE: Record<ExitCandidateEmail, CancelNotice> = { send_cancellation: "known", private_decision: "none", with_decision_message: "none" };
const OPEN_INTERVIEWS = ["proposed", "scheduling", "scheduled"];
const OPEN_SCREENS = ["invited", "reminded", "in_progress"];
/** The assistant's suggestions and a decision message waiting for approval: nothing is left to do for someone who left. */
const WAITING_ON_A_PERSON = ["application.invite_screen", "application.recommend_interview", "disposition.send"];

export async function exitCleanup(tx: Tx, container: Container, input: ExitCleanupInput): Promise<ExitCleanupResult> {
  const now = container.engine.clock();
  const { companyId, applicationId, actor } = input;
  const result: ExitCleanupResult = { interviewsCancelled: 0, screensCancelled: 0, suggestionsWithdrawn: 0, candidateNotes: 0 };
  const open = await tx.select().from(interviews).where(and(eq(interviews.applicationId, applicationId), inArray(interviews.status, OPEN_INTERVIEWS)));
  const byCandidate = actor.kind === "candidate";
  // The interviewers get a sentence; the recorded reason (a code like "declined: position_filled") stays on the interview for the team's record.
  const interviewerNote = byCandidate ? "The candidate withdrew, so this interview is off." : "The candidate is no longer in the process, so this interview is off.";
  for (const iv of open) {
    if (iv.status === "scheduled" && iv.startsAt && Date.parse(iv.startsAt) <= now.getTime()) continue; // it took place, or is taking place
    const done = await cancelInterviewInTx(tx, container, { companyId, interview: iv, actor, by: "system", reason: input.reason, byCandidate, cause: "left_process", now, notice: NOTICE[input.candidateEmail], leftProcess: true, interviewerNote });
    result.interviewsCancelled += 1;
    if (done.candidateTold) result.candidateNotes += 1;
  }
  const scr = await tx.select().from(screens).where(and(eq(screens.applicationId, applicationId), inArray(screens.status, OPEN_SCREENS)));
  for (const s of scr) {
    await tx.update(screens).set({ status: "cancelled" }).where(eq(screens.id, s.id));
    await emit(tx, { type: "screen.cancelled", companyId, actor, subject: { type: "screen", id: s.id }, payload: { applicationId, reason: "left_process", started: s.status === "in_progress" } });
    if (s.workflowRunId) await container.engine.cancel(tx, s.workflowRunId, actor, `the application left the process (${input.reason})`);
    result.screensCancelled += 1;
  }
  const waiting = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.applicationId, applicationId), inArray(approvalRequests.actionType, WAITING_ON_A_PERSON), eq(approvalRequests.status, "pending")));
  for (const p of waiting) {
    await tx.update(approvalRequests).set({ status: "cancelled", decidedAt: now.toISOString(), decisionNote: `the application left the process (${input.reason})` }).where(eq(approvalRequests.id, p.id));
    await emit(tx, { type: "approval.cancelled", companyId, actor, subject: { type: "approval_request", id: p.id }, payload: { actionType: p.actionType, applicationId, by: "left_process" }, correlationId: p.workflowRunId });
    await container.engine.signal(tx, { companyId, key: `approval:${p.id}`, payload: { decision: "cancelled" } });
    result.suggestionsWithdrawn += 1;
  }
  return result;
}
