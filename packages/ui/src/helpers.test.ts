import { describe, expect, it } from "vitest";
import { GLYPHS, ICON_ALIASES, ICON_NAMES, resolveIcon } from "./glyphs";
import { cx, domId, holdPageScroll, initials, nextIndex, normalizeToast, OWNER_STAGES, SCORE_BANDS, scoreBand, scoreLabel, stageMenuItems, tabIds, toastDuration, toastPayload, typeaheadIndex } from "./helpers";

describe("avatar initials", () => {
  it("takes the first letters of the first and last names", () => {
    expect(initials("Priya Raman")).toBe("PR");
    expect(initials("  maria   del  carmen reyes ")).toBe("MR");
    expect(initials("Mary-Jane Watson")).toBe("MW");
  });
  it("uses one letter for one word, or when asked (a company chip)", () => {
    expect(initials("Cher")).toBe("C");
    expect(initials("Bright Dental", 1)).toBe("B");
  });
  it("reads the name part of an email address and leaves out bracketed asides", () => {
    expect(initials("ana.holt@example.com")).toBe("AH");
    expect(initials("Sam Doyle (they/them)")).toBe("SD");
  });
  it("keeps accented letters and skips punctuation at the start of a word", () => {
    expect(initials("ádám 'kovács'")).toBe("ÁK");
  });
  it("shows a question mark when there is no name", () => {
    expect(initials("")).toBe("?");
    expect(initials(null)).toBe("?");
    expect(initials(" - ")).toBe("?");
  });
});

describe("match score badge", () => {
  it("uses the founder-approved cut-offs: 85+, 70+, 55+ and below", () => {
    expect(scoreBand(100)?.band).toBe("very_high");
    expect(scoreBand(85)?.band).toBe("very_high");
    expect(scoreBand(84)?.band).toBe("high");
    expect(scoreBand(70)?.band).toBe("high");
    expect(scoreBand(69)?.band).toBe("medium");
    expect(scoreBand(55)?.band).toBe("medium");
    expect(scoreBand(54)?.band).toBe("low");
    expect(scoreBand(0)?.band).toBe("low");
    expect(SCORE_BANDS.map((b) => b.label)).toEqual(["Very high", "High", "Medium", "Low"]);
  });
  it("never borrows the AI reading's words, so the score worked out by code cannot be mistaken for the reading", () => {
    // the reading's labels in apps/web/src/pages/People.tsx and docs/07
    const reading = ["Strong match", "Potential match", "Weak match", "Insufficient evidence"];
    for (const b of SCORE_BANDS) {
      expect(b.label).not.toMatch(/match|evidence|fit/i);
      for (const word of reading) expect(word.toLowerCase()).not.toContain(b.label.toLowerCase());
    }
  });
  it("is green from 70, amber from 55 and grey below; never red, which belongs to a missing must-have", () => {
    expect(scoreBand(91)?.tone).toBe("good");
    expect(scoreBand(70)?.tone).toBe("good");
    expect(scoreBand(69)?.tone).toBe("caution");
    expect(scoreBand(58)?.tone).toBe("caution");
    expect(scoreBand(44)?.tone).toBe("neutral");
    expect(SCORE_BANDS.map((b) => b.tone)).not.toContain("critical");
  });
  it("rounds and keeps the number inside 0-100", () => {
    expect(scoreBand(69.6)).toMatchObject({ score: 70, tone: "good" });
    expect(scoreBand(130)?.score).toBe(100);
    expect(scoreBand(-4)?.score).toBe(0);
  });
  it("has no band without a score", () => {
    expect(scoreBand(null)).toBeNull();
    expect(scoreBand(undefined)).toBeNull();
    expect(scoreBand(Number.NaN)).toBeNull();
  });
  it("tells a screen reader the score in words", () => {
    expect(scoreLabel(91)).toBe("Match score 91 out of 100");
    expect(scoreLabel(null)).toBe("No match score yet");
  });
});

describe("the stage button's choices", () => {
  it("lists the owner's eight stages in order, in plain words, and never in red", () => {
    expect(OWNER_STAGES.map((s) => s.label)).toEqual(["New", "Longlist", "Shortlist", "Interviewing", "On hold", "Offer", "Hired", "Not moving forward"]);
    expect(OWNER_STAGES.map((s) => s.tone)).not.toContain("critical");
    expect(OWNER_STAGES.find((s) => s.id === "on_hold")?.tone).toBe("caution");
  });
  it("marks where the candidate is now and keeps a move that is not allowed in the list, greyed, with its reason", () => {
    const items = stageMenuItems("shortlist", { offer: "Record an interview first.", shortlist: "ignored for the current stage" });
    expect(items).toHaveLength(OWNER_STAGES.length);
    expect(items.filter((i) => i.current).map((i) => i.id)).toEqual(["shortlist"]);
    expect(items.find((i) => i.id === "shortlist")).toMatchObject({ current: true });
    expect(items.find((i) => i.id === "shortlist")?.disabled).toBeUndefined();
    expect(items.find((i) => i.id === "offer")).toMatchObject({ disabled: true, reason: "Record an interview first.", current: false });
    expect(items.find((i) => i.id === "hired")).toEqual({ id: "hired", label: "Hired", tone: "good", current: false });
  });
  it("reads an unknown stage as New rather than showing a raw name", () => {
    expect(stageMenuItems("something_else").find((i) => i.current)?.id).toBe("new");
  });
});

describe("keyboard movement in tabs and menus", () => {
  const disabled = new Set([1, 3]);
  const skip = (i: number) => disabled.has(i);
  it("moves to the next and previous item, round the ends", () => {
    expect(nextIndex(4, 0, "next")).toBe(1);
    expect(nextIndex(4, 3, "next")).toBe(0);
    expect(nextIndex(4, 0, "prev")).toBe(3);
  });
  it("passes over items that cannot be chosen", () => {
    expect(nextIndex(5, 0, "next", skip)).toBe(2);
    expect(nextIndex(5, 2, "next", skip)).toBe(4);
    expect(nextIndex(5, 0, "prev", skip)).toBe(4);
    expect(nextIndex(5, 4, "first", skip)).toBe(0);
    expect(nextIndex(4, 0, "last", skip)).toBe(2);
  });
  it("starts from nothing chosen, and stays put when nothing else can be chosen", () => {
    expect(nextIndex(3, -1, "next")).toBe(0);
    expect(nextIndex(2, 0, "next", (i) => i === 1)).toBe(0);
    expect(nextIndex(0, 0, "next")).toBe(-1);
  });
  it("jumps to the next label starting with a typed letter", () => {
    const labels = ["New", "Longlist", "Shortlist", "Interviewing", "On hold", "Not moving forward"];
    expect(typeaheadIndex(labels, 0, "s")).toBe(2);
    expect(typeaheadIndex(labels, 0, "N")).toBe(5);
    expect(typeaheadIndex(labels, 5, "n")).toBe(0);
    expect(typeaheadIndex(labels, 1, "z")).toBe(1);
  });
  it("ties each tab to its panel with ids that are safe in the page", () => {
    expect(tabIds("cand", "overview")).toEqual({ tab: "cand-tab-overview", panel: "cand-panel-overview" });
    expect(tabIds("cand", "not moving/forward").panel).toBe("cand-panel-not_moving_forward");
    expect(domId("tabs", "«r1:a»")).toBe("tabsr1a");
  });
});

describe("toasts", () => {
  it("sends a plain string when there is only a title, so older listeners still understand it", () => {
    expect(toastPayload("Saved.")).toBe("Saved.");
    expect(toastPayload("Saved.", {})).toBe("Saved.");
    expect(toastPayload("Saved.", "")).toBe("Saved.");
  });
  it("sends a title with a second line, or a tone, as one message", () => {
    expect(toastPayload("Moved to Shortlist.", "Private: the candidate was not told.")).toEqual({ title: "Moved to Shortlist.", detail: "Private: the candidate was not told." });
    expect(toastPayload("Could not save.", { tone: "critical" })).toEqual({ title: "Could not save.", tone: "critical" });
  });
  it("reads both shapes and ignores anything else", () => {
    expect(normalizeToast("Done.")).toEqual({ title: "Done." });
    expect(normalizeToast({ title: "Applied 4 decisions.", detail: "Nobody was emailed.", tone: "good" })).toEqual({ title: "Applied 4 decisions.", detail: "Nobody was emailed.", tone: "good" });
    expect(normalizeToast({ title: "Done.", detail: "  ", tone: "loud" })).toEqual({ title: "Done." });
    expect(normalizeToast("   ")).toBeNull();
    expect(normalizeToast({ detail: "no title" })).toBeNull();
    expect(normalizeToast(42)).toBeNull();
    expect(normalizeToast(null)).toBeNull();
  });
  it("stays at least as long as before and longer for longer messages, within reason", () => {
    expect(toastDuration({ title: "Saved." })).toBe(2600);
    const long = toastDuration({ title: "Moved to Shortlist.", detail: "Private: the candidate was not told, and nothing was sent." });
    expect(long).toBeGreaterThan(2600);
    expect(toastDuration({ title: "word ".repeat(200) })).toBe(9000);
  });
});

describe("the page behind an open drawer", () => {
  it("stays still while any drawer is open and scrolls again once the last one closes, in whatever order they close", () => {
    const body = { style: { overflow: "auto" } };
    // a candidate drawer, then "Bring in a recruiter" opened from inside it
    const releaseDrawer = holdPageScroll(body);
    const releaseSheet = holdPageScroll(body);
    expect(body.style.overflow).toBe("hidden");
    // Back pressed: React unmounts the outer drawer first, then the sheet inside it
    releaseDrawer();
    expect(body.style.overflow).toBe("hidden");
    releaseSheet();
    expect(body.style.overflow).toBe("auto");
    // the next drawer saves the page's own setting again, not a stale "hidden"
    const again = holdPageScroll(body);
    expect(body.style.overflow).toBe("hidden");
    again();
    expect(body.style.overflow).toBe("auto");
  });
  it("closes in the usual order too, and a release counts once", () => {
    const body = { style: { overflow: "" } };
    const outer = holdPageScroll(body);
    const inner = holdPageScroll(body);
    inner();
    inner();
    expect(body.style.overflow).toBe("hidden");
    outer();
    expect(body.style.overflow).toBe("");
  });
});

describe("class names", () => {
  it("joins the parts that are set", () => {
    expect(cx("btn", false, "primary", undefined, null, "", "sm")).toBe("btn primary sm");
  });
});

describe("icon set", () => {
  it("has every icon the pages ask for", () => {
    const wanted = ["home", "today", "briefcase", "roles", "people", "talent", "calendar", "interviews", "settings", "plus", "search", "chevron-right", "chevron-down", "check", "x", "sparkle", "assistant", "mail", "send", "upload", "paperclip", "mic", "eye", "edit", "pencil", "clock", "alert", "lock", "link", "share", "filter", "sort", "more", "arrow-left", "arrow-right", "user", "building", "star", "flag", "refresh", "external"];
    for (const name of wanted) expect(ICON_NAMES).toContain(name);
  });
  it("draws every name, aliases included, with at least one path on the 24-pixel grid", () => {
    for (const name of ICON_NAMES) {
      const g = resolveIcon(name);
      const paths = [...g.stroke, ...(g.fill ?? [])];
      expect(paths.length, name).toBeGreaterThan(0);
      for (const d of paths) expect(d, name).toMatch(/^[Mm][\d.\s,LlHhVvCcSsQqTtAaZzMm-]+$/);
    }
    for (const [alias, target] of Object.entries(ICON_ALIASES)) expect(GLYPHS).toHaveProperty(target, resolveIcon(alias as keyof typeof ICON_ALIASES));
  });
});
