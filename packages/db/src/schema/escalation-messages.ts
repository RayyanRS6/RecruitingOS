import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import type { Actor } from "@ros/contracts";
import { createdAt, id } from "./columns";
import { recruiterEscalations } from "./platform";
import { companies } from "./tenancy";

/** Who wrote a message on a recruiter request: someone at the company, or the ITS recruiter holding it. */
export type EscalationMessageSide = "customer" | "recruiter";
/** A note either way, the recruiter's answer when they resolved it, or the team's reason for reopening it. */
export type EscalationMessageKind = "reply" | "answer" | "reopen";

/**
 * The thread on a recruiter request (migration 0029; plan items B4 and B5). recruiter_escalations keeps the first
 * question and the latest answer; every note, every answer and every reopening is a row here. Never deleted; a privacy
 * deletion rewrites the words that name the candidate.
 */
export const escalationMessages = pgTable(
  "escalation_messages",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    escalationId: uuid("escalation_id").notNull().references(() => recruiterEscalations.id),
    side: text("side").$type<EscalationMessageSide>().notNull(),
    kind: text("kind").$type<EscalationMessageKind>().notNull().default("reply"),
    author: jsonb("author").$type<Actor>().notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("escalation_messages_escalation_idx").on(t.escalationId, t.createdAt), index("escalation_messages_company_idx").on(t.companyId, t.createdAt)],
);
