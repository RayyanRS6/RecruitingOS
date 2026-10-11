import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { NoteStarter } from "@ros/contracts";
import { createdAt, id, ts, updatedAt } from "./columns";
import { applications } from "./hiring";
import { companies, users } from "./tenancy";

/** A note's earlier words, kept when its author changes it. */
export type NoteVersion = { body: string; starter: NoteStarter | null; at: string };

/**
 * Private team notes on a candidate (migration 0034; founder decision Q24, plan H3). One live note per person per
 * application, changed only by its author. Never shown to the candidate, never given to an AI prompt. Removed notes
 * keep their row (`deletedAt`); a privacy deletion empties the words.
 */
export const applicationNotes = pgTable(
  "application_notes",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    applicationId: uuid("application_id").notNull().references(() => applications.id),
    authorUserId: uuid("author_user_id").notNull().references(() => users.id),
    starter: text("starter").$type<NoteStarter | null>(),
    body: text("body").notNull(),
    previousVersions: jsonb("previous_versions").$type<NoteVersion[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    uniqueIndex("application_notes_author_idx").on(t.companyId, t.applicationId, t.authorUserId).where(sql`${t.deletedAt} is null`),
    index("application_notes_application_idx").on(t.applicationId, t.createdAt),
  ],
);
