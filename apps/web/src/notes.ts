import { NOTE_BODY_MAX, NOTE_STARTER, type NoteStarter } from "@ros/contracts";
import type { NoteView, NotesView } from "./api/client";

/**
 * Private team notes on a candidate (founder decision Q24; plan H3), the pure parts the Notes tab, the "How did the
 * interview go?" card, Compare and the interview sheet share, kept free of React so they can be tested
 * (tests/web/notes.test.ts): the starters, autosave, earlier versions, and the reminder to stick to job-related facts.
 * Notes are never shown to the candidate and never given to the AI assistant.
 */

export { NOTE_BODY_MAX };

/** Said beside every note box (counsel register item 25: notes can be asked for in a data request). */
export const NOTES_REMINDER = "Stick to job-related facts: what they said and did, and how it bears on the work. Leave out anything about age, family, health, religion, background or other personal characteristics, and anything you would not want them to read.";

/** Autosave waits this long after the last change before it saves. */
export const NOTE_AUTOSAVE_MS = 1200;

/** One earlier version of a note, on the reader's own note (the words a later sitting replaced). */
export type NoteVersion = { body: string; starter: NoteStarter | null; at: string };
/** A note as the page reads it: the API's view, and its earlier versions when the API sends them. */
export type NoteWithVersions = NoteView & { previousVersions?: NoteVersion[] };

/** The starters as buttons: "Before the interview", "After the interview", "For and against". */
export function starterChoices(view: Pick<NotesView, "starters"> | null | undefined): Array<{ id: NoteStarter; label: string; prompt: string }> {
  if (view?.starters?.length) return view.starters;
  return (Object.keys(NOTE_STARTER) as NoteStarter[]).map((id) => ({ id, ...NOTE_STARTER[id] }));
}

/** The words a starter puts in the note: its heading and its question, ready to answer underneath. */
export function starterText(starter: NoteStarter): string {
  const s = NOTE_STARTER[starter];
  return `${s.label}: ${s.prompt}\n`;
}

/** Choosing a starter: an empty note starts with it; a note with words keeps them and adds the starter underneath. */
export function applyStarter(body: string, starter: NoteStarter): string {
  const kept = body.trimEnd();
  return kept ? `${kept}\n\n${starterText(starter)}` : starterText(starter);
}

/** Whether the words are only a starter's heading and question, with nothing written yet (not worth saving). */
export function onlyStarters(body: string): boolean {
  const left = (Object.keys(NOTE_STARTER) as NoteStarter[]).reduce((t, s) => t.split(starterText(s).trim()).join(""), body);
  return !left.trim();
}

export type NoteSaveState = "saved" | "unsaved" | "saving" | "error" | "empty" | "too_long";

/** Where the person's own note stands: saved, waiting to save, saving, refused, or not worth saving yet. */
export function noteSaveState(input: { text: string; saved: string; saving: boolean; error: string | null }): NoteSaveState {
  if (input.saving) return "saving";
  if (input.text.trim().length > NOTE_BODY_MAX) return "too_long";
  if (input.text.trim() === input.saved.trim()) return "saved";
  if (!input.text.trim() || onlyStarters(input.text)) return "empty";
  return input.error ? "error" : "unsaved";
}

/** Whether autosave should save now: there are new words worth keeping, within the limit, and nothing is saving. */
export function shouldAutosave(input: { text: string; saved: string; saving: boolean }): boolean {
  const t = input.text.trim();
  return !input.saving && !!t && t.length <= NOTE_BODY_MAX && t !== input.saved.trim() && !onlyStarters(t);
}

/** The status line under the note box. */
export function saveStatusWords(state: NoteSaveState, input: { savedAt?: string | null; error?: string | null } = {}): string {
  switch (state) {
    case "saving":
      return "Saving…";
    case "saved":
      return input.savedAt ? `Saved ${timeWords(input.savedAt)}.` : "Nothing written yet.";
    case "unsaved":
      return "Saving when you stop typing…";
    case "too_long":
      return `Too long to save: ${NOTE_BODY_MAX.toLocaleString("en-US")} characters at most.`;
    case "empty":
      return "Write something under the heading to save it.";
    case "error":
      return `Not saved: ${input.error ?? "try again in a moment"}`;
  }
}

/** "at 3:04 PM" today, "on Oct 8" before. */
export function timeWords(at: string, now: Date = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? `at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : `on ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

/** Everyone else's notes the reader may see, the most recently changed first. */
export function othersNotes(view: Pick<NotesView, "notes"> | null | undefined): NoteWithVersions[] {
  return [...(view?.notes ?? [])].filter((n) => !n.mine).sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt));
}

/** "Dana Whitfield · After the interview · changed Oct 9": who wrote it, from which starter, and when. */
export function noteMeta(n: Pick<NoteView, "author" | "mine" | "starterLabel" | "updatedAt" | "createdAt" | "edited">): string {
  const who = n.mine ? "You" : n.author.name;
  const when = n.edited ? `changed ${timeWords(n.updatedAt)}` : `written ${timeWords(n.createdAt)}`;
  return [who, n.starterLabel, when].filter(Boolean).join(" · ");
}

/** The note's earlier versions, newest first, when the API sent them. */
export function earlierVersions(n: NoteWithVersions | null | undefined): NoteVersion[] {
  return [...(n?.previousVersions ?? [])].sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
}

/** A short excerpt for Compare and the "How did the interview go?" card: the first words, on one line. */
export function noteExcerpt(body: string, max = 160): string {
  const one = body.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** Who may read whose notes, in one line under the list. */
export function whoReadsLine(canRead: NotesView["canRead"]): string {
  return canRead === "own" ? "You see your own note only. The hiring team reads every note; nobody else's note is shown to you." : "Owners, admins, hiring managers, HR and an ITS recruiter with access read every note. An interviewer sees only their own.";
}
