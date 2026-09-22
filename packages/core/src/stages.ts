import { eq } from "drizzle-orm";
import type { ActorKind, ApplicationStage, Actor, OwnerGroup } from "@ros/contracts";
import { applications, type Queryable } from "@ros/db";
import { emit } from "./events";

/**
 * The application state machine (docs/06). Each transition names who may perform it.
 * "system" means a workflow step; humans are tenant roles; "candidate" is the candidate.
 */
type Mover = ActorKind | "owner" | "admin" | "hiring_manager" | "hr" | "recruiter" | "interviewer";

const T: Array<{ from: ApplicationStage[]; to: ApplicationStage; by: Mover[] }> = [
  { from: ["applied"], to: "received", by: ["system"] },
  { from: ["received"], to: "eligible", by: ["system"] },
  { from: ["received"], to: "ineligible", by: ["system"] },
  { from: ["ineligible"], to: "rejected", by: ["owner", "admin", "hiring_manager", "recruiter"] }, // never the system (founder decision, correction 6)
  { from: ["ineligible"], to: "eligible", by: ["owner", "admin", "hiring_manager", "recruiter"] },
  { from: ["rejected"], to: "eligible", by: ["owner", "admin", "hiring_manager", "recruiter"] }, // "review anyway" after an eligibility-rule disposition; the route restricts it to that reason
  { from: ["eligible"], to: "triaged", by: ["system"] },
  { from: ["received"], to: "triaged", by: ["system"] }, // extraction failed; manual review path still triages
  { from: ["triaged", "eligible", "received"], to: "screen_invited", by: ["system", "owner", "admin", "hiring_manager", "recruiter"] },
  { from: ["screening"], to: "screen_invited", by: ["system", "owner", "admin", "hiring_manager", "recruiter"] }, // re-invite after a hand-off to a person
  { from: ["screen_invited"], to: "screening", by: ["system"] },
  { from: ["screening", "screen_invited"], to: "screen_complete", by: ["system"] },
  // a person may decide to interview before or during a screen; the screen stays open and is simply superseded
  { from: ["screen_complete", "triaged", "eligible", "screen_invited", "screening"], to: "interview_recommended", by: ["system", "owner", "admin", "hiring_manager", "recruiter"] },
  { from: ["triaged", "screen_complete", "interview_recommended", "screen_invited", "eligible"], to: "interview_scheduled", by: ["system", "owner", "admin", "hiring_manager", "recruiter"] },
  { from: ["interview_scheduled"], to: "interview_complete", by: ["system", "owner", "admin", "hiring_manager", "recruiter", "interviewer"] },
  // a cancelled or expired interview returns the candidate to "recommended" so the team can re-offer or decide
  { from: ["interview_scheduled"], to: "interview_recommended", by: ["system", "owner", "admin", "hiring_manager", "recruiter"] },
  { from: ["interview_complete"], to: "interview_scheduled", by: ["system", "owner", "admin", "hiring_manager", "recruiter"] },
  { from: ["interview_complete"], to: "debrief", by: ["system", "owner", "admin", "hiring_manager", "recruiter"] },
  { from: ["debrief", "interview_complete"], to: "finalist", by: ["owner", "admin", "hiring_manager"] },
  { from: ["finalist"], to: "reference_check", by: ["owner", "admin", "hr", "recruiter"] },
  { from: ["finalist", "reference_check"], to: "offer_draft", by: ["system", "owner", "admin", "hr", "recruiter"] },
  { from: ["offer_draft"], to: "offer_approval", by: ["system"] },
  { from: ["offer_approval"], to: "offer_sent", by: ["system"] },
  { from: ["offer_sent"], to: "negotiation", by: ["system"] },
  { from: ["negotiation"], to: "offer_sent", by: ["system"] },
  { from: ["offer_sent", "negotiation"], to: "accepted", by: ["candidate", "system", "owner", "admin", "recruiter"] },
  { from: ["offer_sent", "negotiation"], to: "declined", by: ["candidate", "system", "owner", "admin", "recruiter"] },
  { from: ["accepted"], to: "onboarding", by: ["system"] },
  { from: ["onboarding"], to: "hired", by: ["system", "owner", "admin", "hiring_manager", "hr"] },
];

const ACTIVE: ApplicationStage[] = [
  "applied", "received", "ineligible", "eligible", "triaged", "screen_invited", "screening", "screen_complete",
  "interview_recommended", "interview_scheduled", "interview_complete", "debrief", "finalist", "reference_check",
  "offer_draft", "offer_approval", "offer_sent", "negotiation", "accepted", "onboarding",
];

const OUTCOME_RECORDERS: Mover[] = ["owner", "admin", "hiring_manager", "hr"];

export function canTransition(from: ApplicationStage, to: ApplicationStage, by: Mover): boolean {
  if (to === "withdrawn") return ACTIVE.includes(from) && (by === "candidate" || by === "system" || isHuman(by));
  if (to === "rejected") return ACTIVE.includes(from) && isHuman(by); // never the system, not on judgment and not on an eligibility answer
  if (to === "talent_pool") return ["rejected", "declined", "withdrawn", ...ACTIVE].includes(from) && (by === "system" || isHuman(by));
  // 21 Sep, item 4: a decision-maker records a hire or an offer declined outside the platform; never the system.
  if (to === "hired" && OUTCOME_RECORDERS.includes(by)) return ACTIVE.includes(from) || from === "talent_pool";
  if (to === "declined" && OUTCOME_RECORDERS.includes(by)) return ACTIVE.includes(from);
  return T.some((t) => t.from.includes(from) && t.to === to && t.by.includes(by));
}

function isHuman(by: Mover): boolean {
  return ["owner", "admin", "hiring_manager", "hr", "recruiter", "interviewer", "user"].includes(by);
}

export class TransitionError extends Error {
  constructor(public from: ApplicationStage, public to: ApplicationStage, public by: Mover) {
    super(`transition ${from} → ${to} not allowed for ${by}`);
  }
}

/** Moves an application and records the fact. The only way stage changes. */
export async function transition(
  q: Queryable,
  input: { applicationId: string; companyId: string; to: ApplicationStage; by: Mover; actor: Actor; reason?: string; payload?: Record<string, unknown>; correlationId?: string | null },
): Promise<{ from: ApplicationStage; to: ApplicationStage }> {
  const [app] = await q.select().from(applications).where(eq(applications.id, input.applicationId)).limit(1);
  if (!app) throw new Error(`application ${input.applicationId} not found`);
  const from = app.stage;
  if (from === input.to) return { from, to: input.to };
  if (!canTransition(from, input.to, input.by)) throw new TransitionError(from, input.to, input.by);
  const now = new Date().toISOString();
  const patch: Partial<typeof applications.$inferInsert> = { stage: input.to, stageChangedAt: now };
  if (input.to === "withdrawn") { patch.withdrawnAt = now; patch.withdrawReason = input.reason ?? null; }
  if (input.to === "rejected") { patch.rejectedAt = now; patch.rejectReason = input.reason ?? null; }
  await q.update(applications).set(patch).where(eq(applications.id, input.applicationId));
  await emit(q, {
    type: "application.stage_changed",
    companyId: input.companyId,
    actor: input.actor,
    subject: { type: "application", id: input.applicationId },
    payload: { from, to: input.to, reason: input.reason ?? null, ...(input.payload ?? {}) },
    correlationId: input.correlationId ?? null,
  });
  return { from, to: input.to };
}

/** Owner Mode groups stages into plain language. */
export function ownerGroup(stage: ApplicationStage): OwnerGroup {
  if (["hired"].includes(stage)) return "hired";
  if (["rejected", "withdrawn", "declined", "talent_pool", "ineligible"].includes(stage)) return "not_moving_forward";
  if (["triaged", "screen_complete", "interview_recommended", "debrief", "finalist", "offer_draft", "offer_approval", "negotiation"].includes(stage)) return "waiting_on_you";
  return "in_process";
}

export const STAGE_LABEL: Record<ApplicationStage, string> = {
  applied: "Just applied",
  received: "Received",
  ineligible: "Doesn't meet eligibility",
  eligible: "Eligible",
  triaged: "Ready for your review",
  screen_invited: "Invited to a screen",
  screening: "Being screened",
  screen_complete: "Screen complete",
  interview_recommended: "Recommended for interview",
  interview_scheduled: "Interviewing",
  interview_complete: "Interview done",
  debrief: "Deciding",
  finalist: "Finalist",
  reference_check: "Checking references",
  offer_draft: "Offer being prepared",
  offer_approval: "Offer needs your approval",
  offer_sent: "Offer out",
  negotiation: "Negotiating",
  accepted: "Accepted",
  declined: "Declined the offer",
  hired: "Hired",
  onboarding: "Starting soon",
  withdrawn: "Withdrew",
  rejected: "Not moving forward",
  talent_pool: "In your talent pool",
};
