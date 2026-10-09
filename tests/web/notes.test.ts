import { describe, expect, it } from "vitest";
import type { NoteView } from "../../apps/web/src/api/client";
import {
  NOTES_REMINDER, NOTE_BODY_MAX, applyStarter, earlierVersions, noteExcerpt, noteMeta, noteSaveState, onlyStarters, othersNotes, saveStatusWords, shouldAutosave, starterChoices, starterText, whoReadsLine,
} from "../../apps/web/src/notes";
import { hasTeamNotes } from "../../apps/web/src/pages/compare/compare-view";

/**
 * Private team notes (founder decision Q24; plan H3), the page's rules: the starters, autosave, the earlier versions,
 * the reminder to stick to job-related facts, who reads whose, and notes in Compare. Pure functions, tested here.
 */
const note = (over: Partial<NoteView>): NoteView => ({ id: "n1", applicationId: "a1", author: { userId: "u2", name: "Sam Doyle" }, mine: false, starter: null, starterLabel: null, body: "Steady with patients.", createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z", edited: false, ...over });

describe("your own note", () => {
  it("offers the three starters, each putting its heading and question in the note", () => {
    expect(starterChoices(null).map((s) => s.label)).toEqual(["Before the interview", "After the interview", "For and against"]);
    expect(starterText("after_interview")).toBe("After the interview: How did it go? What did you see and hear?\n");
    expect(applyStarter("", "before_interview")).toBe("Before the interview: What do you want to find out?\n");
    // words already written stay, and the starter goes under them
    expect(applyStarter("Calm under pressure.  ", "for_and_against")).toBe("Calm under pressure.\n\nFor and against: What speaks for them, and what gives you pause?\n");
    expect(onlyStarters(applyStarter("", "after_interview"))).toBe(true);
    expect(onlyStarters(`${starterText("after_interview")}Asked good questions.`)).toBe(false);
  });

  it("saves new words once typing pauses, never a bare starter, an empty box or one over the limit", () => {
    expect(shouldAutosave({ text: "Asked good questions.", saved: "", saving: false })).toBe(true);
    expect(shouldAutosave({ text: "Asked good questions. ", saved: "Asked good questions.", saving: false })).toBe(false);
    expect(shouldAutosave({ text: "More words", saved: "", saving: true })).toBe(false);
    expect(shouldAutosave({ text: "   ", saved: "", saving: false })).toBe(false);
    expect(shouldAutosave({ text: starterText("after_interview"), saved: "", saving: false })).toBe(false);
    expect(shouldAutosave({ text: "x".repeat(NOTE_BODY_MAX + 1), saved: "", saving: false })).toBe(false);
  });

  it("says where the save stands, in a word or two", () => {
    expect(noteSaveState({ text: "a", saved: "a", saving: false, error: null })).toBe("saved");
    expect(noteSaveState({ text: "ab", saved: "a", saving: false, error: null })).toBe("unsaved");
    expect(noteSaveState({ text: "ab", saved: "a", saving: true, error: null })).toBe("saving");
    expect(noteSaveState({ text: "ab", saved: "a", saving: false, error: "Your role can't write notes." })).toBe("error");
    expect(noteSaveState({ text: starterText("for_and_against"), saved: "", saving: false, error: null })).toBe("empty");
    expect(noteSaveState({ text: "x".repeat(NOTE_BODY_MAX + 1), saved: "", saving: false, error: null })).toBe("too_long");
    expect(saveStatusWords("saving")).toBe("Saving…");
    expect(saveStatusWords("saved", { savedAt: null })).toBe("Nothing written yet.");
    expect(saveStatusWords("saved", { savedAt: new Date().toISOString() })).toMatch(/^Saved at /);
    expect(saveStatusWords("error", { error: "the connection dropped" })).toBe("Not saved: the connection dropped");
    expect(saveStatusWords("too_long")).toBe("Too long to save: 5,000 characters at most.");
  });

  it("lists the earlier versions, newest first, when the API sends them", () => {
    const mine = { ...note({ mine: true, edited: true }), previousVersions: [{ body: "First take", starter: null, at: "2026-10-05T10:00:00.000Z" }, { body: "Second take", starter: null, at: "2026-10-06T10:00:00.000Z" }] };
    expect(earlierVersions(mine).map((v) => v.body)).toEqual(["Second take", "First take"]);
    expect(earlierVersions(note({}))).toEqual([]);
    expect(earlierVersions(null)).toEqual([]);
  });
});

describe("the team's notes", () => {
  it("reminds everyone to stick to job-related facts, and says who reads whose", () => {
    expect(NOTES_REMINDER).toMatch(/^Stick to job-related facts/);
    expect(NOTES_REMINDER).toMatch(/age, family, health, religion, background/);
    expect(whoReadsLine("own")).toMatch(/^You see your own note only/);
    expect(whoReadsLine("all")).toMatch(/An interviewer sees only their own\.$/);
  });

  it("shows everyone else's, the most recently changed first, with who wrote it and when", () => {
    const view = { notes: [note({ id: "n1" }), note({ id: "n2", mine: true }), note({ id: "n3", author: { userId: "u3", name: "Pat Lee" }, updatedAt: "2026-10-07T10:00:00.000Z", edited: true, starter: "after_interview", starterLabel: "After the interview" })] };
    expect(othersNotes(view).map((n) => n.id)).toEqual(["n3", "n1"]);
    expect(noteMeta(view.notes[2])).toMatch(/^Pat Lee · After the interview · changed on Oct 7$/);
    expect(noteMeta(view.notes[1])).toMatch(/^You · written on Oct 5$/);
    expect(noteExcerpt("a  b\n\nc")).toBe("a b c");
    expect(noteExcerpt("x".repeat(200), 20)).toBe(`${"x".repeat(19)}…`);
  });

  it("shows notes in Compare only when someone compared has one (the API sends none to anyone who may not read them)", () => {
    expect(hasTeamNotes([{ notes: [] }, { notes: [note({})] }])).toBe(true);
    expect(hasTeamNotes([{ notes: [] }, {}])).toBe(false);
  });
});
