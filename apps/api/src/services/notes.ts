import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { NOTES_PRIVACY_LINE, NOTE_STARTER, NOTE_VERSIONS_KEPT, NOTE_VERSION_SITTING_MINUTES, NoteStarter, type Actor, type NoteView, type NotesView, type WriteNote } from "@ros/contracts";
import { can, emit } from "@ros/core";
import { applicationNotes, users, type Tx } from "@ros/db";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";
import { interviewerNoteAccess } from "./interviewer-view";

/**
 * Private team notes on a candidate (founder decision Q24; plan H3). Owners, admins, hiring managers, HR and an ITS
 * recruiter while a grant gives them access read every note and write their own (note.read, note.write); an
 * interviewer writes their own note on a candidate they interviewed and reads only that one. One note per person per
 * candidate, changed only by the person who wrote it, with the words it replaced kept. The facts (`note.added`,
 * `note.updated`) never carry the words. Notes never reach the candidate's pages or any AI prompt: nothing in
 * packages/ai or packages/agents reads this table (hire-and-notes.test.ts checks it), and the privacy export leaves
 * them out until counsel answers (register item 25).
 */
type NoteRow = typeof applicationNotes.$inferSelect;

/** What this person may do with the notes on one candidate. `read`: everyone's, only their own, or none. */
export type NoteAccess = { read: "all" | "own" | "none"; write: boolean; writeBlockedReason: string | null };

const NO_NOTES = "Your role can't read or write notes on candidates.";

export async function noteAccessFor(tx: Tx, input: { tenant: Tenant; applicationId: string; now: Date }): Promise<NoteAccess> {
  const { tenant } = input;
  if (can(tenant.role, "note.read")) return { read: "all", write: can(tenant.role, "note.write"), writeBlockedReason: can(tenant.role, "note.write") ? null : NO_NOTES };
  if (tenant.role === "interviewer") {
    const own = await interviewerNoteAccess(tx, { applicationId: input.applicationId, userId: tenant.userId, now: input.now });
    return { read: own.participant ? "own" : "none", write: own.mayWrite, writeBlockedReason: own.reason };
  }
  return { read: "none", write: false, writeBlockedReason: NO_NOTES };
}

const iso = (value: string) => new Date(value).toISOString();

/**
 * Who wrote it, as the team reads it. The company's transactions see only its own members' accounts, so an author they
 * cannot see is the ITS recruiter who wrote it under a grant (`member` false).
 */
function authorName(author: { name: string | null; member: boolean }): string {
  if (!author.member) return "ITS recruiter";
  return author.name?.trim() || "A team member";
}

/** A note as the reader sees it; its earlier versions only on the reader's own note. */
function toView(row: NoteRow, author: { name: string | null; member: boolean }, viewerId: string): NoteView {
  const mine = row.authorUserId === viewerId;
  return {
    id: row.id, applicationId: row.applicationId, author: { userId: row.authorUserId, name: authorName(author) }, mine,
    starter: row.starter, starterLabel: row.starter ? NOTE_STARTER[row.starter].label : null, body: row.body,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), edited: row.previousVersions.length > 0,
    ...(mine ? { previousVersions: row.previousVersions.map((v) => ({ body: v.body, starter: v.starter, at: iso(v.at) })) } : {}),
  };
}

/** The live notes of these applications, oldest first, with their authors. */
async function liveNotes(tx: Tx, applicationIds: string[]): Promise<Array<{ row: NoteRow; author: { name: string | null; member: boolean } }>> {
  if (!applicationIds.length) return [];
  const rows = await tx.select({ row: applicationNotes, name: users.name, userId: users.id }).from(applicationNotes).leftJoin(users, eq(users.id, applicationNotes.authorUserId)).where(and(inArray(applicationNotes.applicationId, applicationIds), isNull(applicationNotes.deletedAt))).orderBy(asc(applicationNotes.createdAt));
  return rows.map((r) => ({ row: r.row, author: { name: r.name, member: !!r.userId } }));
}

/** The writer of a note, as `toView` names them. */
async function authorOf(tx: Tx, userId: string): Promise<{ name: string | null; member: boolean }> {
  const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return { name: u?.name ?? null, member: !!u };
}

/** GET /applications/:id/notes: what this person may read, their own note, and whether they may write. 403 for anyone who may do neither. */
export async function notesView(tx: Tx, input: { applicationId: string; tenant: Tenant; now: Date }): Promise<NotesView> {
  const access = await noteAccessFor(tx, input);
  if (access.read === "none") throw new HttpError(403, "forbidden", input.tenant.role === "interviewer" ? "You can open notes only on candidates you are interviewing." : NO_NOTES);
  const rows = (await liveNotes(tx, [input.applicationId])).filter((n) => access.read === "all" || n.row.authorUserId === input.tenant.userId);
  const notes = rows.map((n) => toView(n.row, n.author, input.tenant.userId));
  return {
    notes, mine: notes.find((n) => n.mine) ?? null, canRead: access.read, canWrite: access.write, writeBlockedReason: access.writeBlockedReason,
    starters: NoteStarter.options.map((id) => ({ id, ...NOTE_STARTER[id] })), privacy: NOTES_PRIVACY_LINE,
  };
}

/** A Postgres unique violation (23505), as the driver or the query builder hands it back. */
function uniqueViolation(e: unknown): boolean {
  const code = (x: unknown) => (x && typeof x === "object" && "code" in x ? (x as { code?: unknown }).code : undefined);
  return code(e) === "23505" || code((e as { cause?: unknown } | null)?.cause) === "23505";
}

/**
 * Writes the person's own note on this candidate: the first one is added, a later one changes it. The Notes tab saves
 * whenever typing pauses, so changes within NOTE_VERSION_SITTING_MINUTES of the last save are one sitting: the note is
 * changed in place, with no earlier version and no new fact. A change after a longer pause keeps the words it replaced
 * (the latest NOTE_VERSIONS_KEPT of them) and is recorded as `note.updated`. Nothing changes (and nothing is recorded)
 * when the words and the starter are the same. `created` says which.
 */
export async function writeOwnNote(tx: Tx, input: { companyId: string; applicationId: string; tenant: Tenant; actor: Actor; note: WriteNote; now: Date }): Promise<{ note: NoteView; created: boolean; changed: boolean }> {
  const access = await noteAccessFor(tx, input);
  if (!access.write) throw new HttpError(403, "forbidden", access.writeBlockedReason ?? NO_NOTES);
  const starter = input.note.starter ?? null;
  const at = input.now.toISOString();
  const [existing] = await tx.select().from(applicationNotes).where(and(eq(applicationNotes.applicationId, input.applicationId), eq(applicationNotes.authorUserId, input.tenant.userId), isNull(applicationNotes.deletedAt))).limit(1).for("update");
  const author = await authorOf(tx, input.tenant.userId);
  if (existing) {
    if (existing.body === input.note.body && existing.starter === starter) return { note: toView(existing, author, input.tenant.userId), created: false, changed: false };
    if (input.now.getTime() - Date.parse(existing.updatedAt) < NOTE_VERSION_SITTING_MINUTES * 60_000) {
      const [row] = await tx.update(applicationNotes).set({ body: input.note.body, starter, updatedAt: at }).where(eq(applicationNotes.id, existing.id)).returning();
      return { note: toView(row, author, input.tenant.userId), created: false, changed: true };
    }
    const previousVersions = [...existing.previousVersions, { body: existing.body, starter: existing.starter, at: iso(existing.updatedAt) }].slice(-NOTE_VERSIONS_KEPT);
    const [row] = await tx.update(applicationNotes).set({ body: input.note.body, starter, previousVersions, updatedAt: at }).where(eq(applicationNotes.id, existing.id)).returning();
    await emit(tx, { type: "note.updated", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.applicationId }, payload: { noteId: row.id, starter, version: previousVersions.length + 1, authorRole: input.tenant.role } });
    return { note: toView(row, author, input.tenant.userId), created: false, changed: true };
  }
  // One live note per person per candidate (a unique index): the same note saved twice at once is a clear refusal, not a crash.
  const [row] = await tx.insert(applicationNotes).values({ companyId: input.companyId, applicationId: input.applicationId, authorUserId: input.tenant.userId, starter, body: input.note.body, createdAt: at, updatedAt: at }).returning().catch((e: unknown) => {
    if (uniqueViolation(e)) throw new HttpError(409, "note_exists", "Your note was saved a moment ago from somewhere else. Reload to see it, then change it.");
    throw e;
  });
  await emit(tx, { type: "note.added", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.applicationId }, payload: { noteId: row.id, starter, authorRole: input.tenant.role } });
  return { note: toView(row, author, input.tenant.userId), created: true, changed: true };
}

/** Removes the person's own note (kept as a removed row, words and all, until a privacy deletion empties it). 404 when they have none. */
export async function removeOwnNote(tx: Tx, input: { companyId: string; applicationId: string; tenant: Tenant; actor: Actor; now: Date }): Promise<{ noteId: string }> {
  const access = await noteAccessFor(tx, input);
  if (!access.write && access.read === "none") throw new HttpError(403, "forbidden", access.writeBlockedReason ?? NO_NOTES);
  const [row] = await tx.update(applicationNotes).set({ deletedAt: input.now.toISOString() }).where(and(eq(applicationNotes.applicationId, input.applicationId), eq(applicationNotes.authorUserId, input.tenant.userId), isNull(applicationNotes.deletedAt))).returning({ id: applicationNotes.id, starter: applicationNotes.starter });
  if (!row) throw new HttpError(404, "not_found", "You have no note on this candidate.");
  await emit(tx, { type: "note.updated", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.applicationId }, payload: { noteId: row.id, starter: row.starter, removed: true, authorRole: input.tenant.role } });
  return { noteId: row.id };
}

/** Every live note on these candidates, for those who read notes (Compare, plan H3); an empty map for anyone else. */
export async function notesForApplications(tx: Tx, input: { applicationIds: string[]; tenant: Tenant }): Promise<Map<string, NoteView[]>> {
  const out = new Map<string, NoteView[]>();
  if (!can(input.tenant.role, "note.read")) return out;
  for (const n of await liveNotes(tx, input.applicationIds)) {
    const list = out.get(n.row.applicationId) ?? [];
    list.push(toView(n.row, n.author, input.tenant.userId));
    out.set(n.row.applicationId, list);
  }
  return out;
}
