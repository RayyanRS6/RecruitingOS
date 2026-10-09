import { describe, expect, it } from "vitest";
import { STILL_REVIEWING_LABEL, STILL_REVIEWING_NOTE } from "../../apps/web/src/ai-rules";
import { essentialWords, readinessList } from "../../apps/web/src/pages/new-role/rules";
import { canReadNotes } from "../../apps/web/src/roles";

/**
 * The signed-in polish of Waves G and H: "What we know" in the job builder says a code in the team's words, Setup names
 * the "still reviewing" note and says what each choice does, and the note permissions mirror the matrix (Q24).
 */
describe("What we know, in the team's words", () => {
  it("shows the reason for hiring by its label, never its code", () => {
    expect(essentialWords("reason_for_hire", "new_position")).toBe("A new position");
    expect(essentialWords("reason_for_hire", "replacement")).toBe("Replacing someone who left");
    // anything typed in the person's own words stays as it is
    expect(essentialWords("reason_for_hire", "Opening a second office")).toBe("Opening a second office");
    expect(essentialWords("title", "new_position")).toBe("new_position");
    expect(essentialWords("reason_for_hire", null)).toBeNull();
    const list = readinessList({ payConfirmed: true, essentials: [{ key: "reason_for_hire", label: "Why you are hiring", done: true, value: "new_position", note: null }] } as never);
    expect(list.known[0].value).toBe("A new position");
  });
});

describe("the 'still reviewing' note in Setup (plan G10)", () => {
  it("names the rule and says what each choice does, in plain words", () => {
    expect(STILL_REVIEWING_LABEL).toMatch(/still reviewing/);
    expect(STILL_REVIEWING_LABEL).toMatch(/30 days after applying/);
    expect(STILL_REVIEWING_NOTE.auto).toMatch(/^One short, courteous email per applicant, once/);
    expect(STILL_REVIEWING_NOTE.auto).toMatch(/carries the same AI notice/);
    expect(STILL_REVIEWING_NOTE.auto_notify).toBe(STILL_REVIEWING_NOTE.auto);
    expect(STILL_REVIEWING_NOTE.approval).toMatch(/^No note goes by itself/);
    expect(STILL_REVIEWING_NOTE.human_only).toMatch(/^No note goes by itself/);
  });
});

describe("who reads the team's notes (Q24)", () => {
  it("is the hiring team and an ITS recruiter with access; never an interviewer", () => {
    for (const r of ["owner", "admin", "hiring_manager", "hr", "recruiter"]) expect(canReadNotes(r), r).toBe(true);
    expect(canReadNotes("interviewer")).toBe(false);
    expect(canReadNotes(null)).toBe(false);
  });
});
