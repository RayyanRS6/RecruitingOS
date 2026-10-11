import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { Actor, AutoNewTimesReason, AutoNewTimesState, CancelNext, FollowUpKind, FollowUpResolution } from "@ros/contracts";
import { createdAt, id, ts, updatedAt } from "./columns";
import { applications, interviews } from "./hiring";
import { companies } from "./tenancy";

/**
 * The Cancelled column (migration 0035; founder decisions 1A to 4A). One row each time a candidate cancels a booked
 * interview from their schedule page, with their choice, or the team records that the candidate did not show. It carries
 * the one automatic set of new times and how it ended, and how the person left the column. Resolved, never deleted.
 * Only packages/core interview-followups.ts writes it.
 */
export const interviewFollowups = pgTable(
  "interview_followups",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    applicationId: uuid("application_id").notNull().references(() => applications.id),
    /** The interview they cancelled or missed, and its attempt after that (the entry). */
    interviewId: uuid("interview_id").notNull().references(() => interviews.id),
    interviewAttempt: integer("interview_attempt").notNull(),
    kind: text("kind").$type<FollowUpKind>().notNull(),
    /** The candidate's choice; null for a no-show. */
    choice: text("choice").$type<CancelNext | null>(),
    autoState: text("auto_state").$type<AutoNewTimesState>().notNull().default("none"),
    autoReason: text("auto_reason").$type<AutoNewTimesReason | null>(),
    autoWorkingDays: integer("auto_working_days"),
    autoDueAt: ts("auto_due_at"),
    autoRunId: uuid("auto_run_id"),
    autoSentAt: ts("auto_sent_at"),
    /** The interview that carries their new times, once someone or the automatic set reopened or created it. */
    currentInterviewId: uuid("current_interview_id").references(() => interviews.id),
    timesSentCount: integer("times_sent_count").notNull().default(0),
    lastSentAt: ts("last_sent_at"),
    lastSentVia: text("last_sent_via").$type<"auto" | "person" | "batch" | null>(),
    lastSentBy: jsonb("last_sent_by").$type<Actor | null>(),
    /** `slots:{interviewId}:{attempt}` of the last offer counted, so an offer step that runs twice counts once. */
    lastOfferKey: text("last_offer_key"),
    resolvedAt: ts("resolved_at"),
    resolvedHow: text("resolved_how").$type<FollowUpResolution | null>(),
    resolvedBy: jsonb("resolved_by").$type<Actor | null>(),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("interview_followups_entry_idx").on(t.companyId, t.interviewId, t.interviewAttempt),
    uniqueIndex("interview_followups_open_idx").on(t.companyId, t.applicationId).where(sql`${t.resolvedAt} is null`),
    uniqueIndex("interview_followups_one_auto_idx").on(t.companyId, t.applicationId).where(sql`${t.autoState} in ('preparing', 'sent')`),
    index("interview_followups_due_idx").on(t.companyId, t.autoDueAt).where(sql`${t.autoState} in ('waiting', 'waiting_check')`),
    index("interview_followups_application_idx").on(t.applicationId, t.createdAt),
  ],
);
