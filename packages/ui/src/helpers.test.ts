import { describe, expect, it, vi } from "vitest";
import { GLYPHS, ICON_ALIASES, ICON_NAMES, resolveIcon } from "./glyphs";
import { compareValues, cx, domId, holdPageScroll, initials, nextIndex, nextSort, normalizeToast, numHead, OWNER_STAGES, SCORE_BANDS, scoreBand, scoreLabel, sortAnnouncement, sortRows, stageMenuItems, tabIds, toastDuration, toastPayload, typeaheadIndex } from "./helpers";

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
  it("lists the owner's ten stages in order, in plain words, and never in red", () => {
    // "No AI interview yet" first (20 Oct 2026, R20-7): everyone starts there, grey like New
    expect(OWNER_STAGES.map((s) => s.label)).toEqual(["No AI interview yet", "New", "Longlist", "Shortlist", "Interviewing", "Cancelled", "On hold", "Offer", "Hired", "Not moving forward"]);
    expect(OWNER_STAGES.map((s) => s.tone)).not.toContain("critical");
    expect(OWNER_STAGES.find((s) => s.id === "no_ai_interview")?.tone).toBe("neutral");
    expect(OWNER_STAGES.find((s) => s.id === "on_hold")?.tone).toBe("caution");
    // Cancelled sits right after Interviewing, amber like a hold, never red: a cancelled interview is not an error
    expect(OWNER_STAGES.find((s) => s.id === "cancelled")?.tone).toBe("caution");
    expect(stageMenuItems("cancelled")).toHaveLength(10);
    expect(stageMenuItems("cancelled").find((i) => i.current)?.label).toBe("Cancelled");
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
  it("carries an action (Undo) and stays as long as it can still be used, two minutes at most (plan G9)", () => {
    const onAction = () => undefined;
    const sent = toastPayload("Decision message sent.", { detail: "It leaves in 30 seconds.", action: { label: "Undo", onAction }, durationMs: 30_000 });
    expect(sent).toEqual({ title: "Decision message sent.", detail: "It leaves in 30 seconds.", action: { label: "Undo", onAction }, durationMs: 30_000 });
    // the action alone is enough to send the full message; a duration without an action means nothing
    expect(toastPayload("Sent.", { action: { label: "Undo", onAction } })).toEqual({ title: "Sent.", action: { label: "Undo", onAction } });
    expect(toastPayload("Sent.", { durationMs: 30_000 })).toBe("Sent.");
    const read = normalizeToast(sent)!;
    expect(read.action?.label).toBe("Undo");
    expect(toastDuration(read)).toBe(30_000);
    // never shorter than a second, never longer than two minutes; an action with no window stays long enough to reach
    expect(toastDuration(normalizeToast({ title: "Sent.", action: { label: "Undo", onAction }, durationMs: 50 })!)).toBe(1000);
    expect(toastDuration(normalizeToast({ title: "Sent.", action: { label: "Undo", onAction }, durationMs: 10 * 60_000 })!)).toBe(120_000);
    expect(toastDuration({ title: "Sent.", action: { label: "Undo", onAction } })).toBe(9000);
    // an action without words or without something to do is dropped, and so is its duration
    expect(normalizeToast({ title: "Sent.", action: { label: "", onAction }, durationMs: 30_000 })).toEqual({ title: "Sent." });
    expect(normalizeToast({ title: "Sent.", action: { label: "Undo", onAction: "nope" }, durationMs: 30_000 })).toEqual({ title: "Sent." });
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
    // the October 2026 redesign's shapes: the logo's bars, the rail's and the screens' new icons
    wanted.push("bars", "shield", "life-buoy", "activity", "user-plus", "sliders", "arrow-up-right", "message-circle", "file-text", "sparkles", "inbox", "chart");
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

describe("sorting a table", () => {
  it("orders words the way a person reads them, numbers by size, and puts empty values last either way", () => {
    const rows = [{ n: "Role 10", c: 3 }, { n: "role 2", c: null }, { n: "Bright Dental", c: 12 }, { n: "", c: 1 }];
    expect(sortRows(rows, (r) => r.n, "ascending").map((r) => r.n)).toEqual(["Bright Dental", "role 2", "Role 10", ""]);
    expect(sortRows(rows, (r) => r.n, "descending").map((r) => r.n)).toEqual(["Role 10", "role 2", "Bright Dental", ""]);
    expect(sortRows(rows, (r) => r.c, "descending").map((r) => r.c)).toEqual([12, 3, 1, null]);
    expect(sortRows(rows, (r) => r.c, "ascending").map((r) => r.c)).toEqual([1, 3, 12, null]);
    expect(compareValues(Number.NaN, 1, "descending")).toBe(1);
    expect(compareValues(undefined, null, "ascending")).toBe(0);
    expect(compareValues("Ádám", "adam", "ascending")).toBe(0);
  });

  it("keeps rows that tie in the order they came, and leaves the list it was given alone", () => {
    const rows = [{ id: "a", v: 1 }, { id: "b", v: 1 }, { id: "c", v: 0 }];
    expect(sortRows(rows, (r) => r.v, "descending").map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(sortRows(rows, (r) => r.v, "ascending").map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts dates by their timestamps, an unscheduled one last", () => {
    const at = ["2026-10-14T18:00:00.000Z", null, "2026-10-09T10:00:00.000Z"].map((s) => (s ? Date.parse(s) : null));
    expect(sortRows(at, (v) => v, "ascending")).toEqual([Date.parse("2026-10-09T10:00:00.000Z"), Date.parse("2026-10-14T18:00:00.000Z"), null]);
    expect(sortRows(at, (v) => v, "descending")).toEqual([Date.parse("2026-10-14T18:00:00.000Z"), Date.parse("2026-10-09T10:00:00.000Z"), null]);
  });

  it("starts a new column the useful way round and flips the same column, with no third press", () => {
    expect(nextSort(null, "company", "text")).toEqual({ key: "company", dir: "ascending" });
    expect(nextSort(null, "cost", "number")).toEqual({ key: "cost", dir: "descending" });
    expect(nextSort(null, "when", "date")).toEqual({ key: "when", dir: "descending" });
    expect(nextSort({ key: "cost", dir: "descending" }, "cost", "number")).toEqual({ key: "cost", dir: "ascending" });
    expect(nextSort({ key: "cost", dir: "ascending" }, "cost", "number")).toEqual({ key: "cost", dir: "descending" });
    expect(nextSort({ key: "cost", dir: "ascending" }, "when", "date")).toEqual({ key: "when", dir: "descending" });
  });

  it("lets a page start a column earliest first (a deadline, an interview to come), and still flips it", () => {
    expect(nextSort(null, "due", "date", "ascending")).toEqual({ key: "due", dir: "ascending" });
    expect(nextSort({ key: "candidate", dir: "ascending" }, "when", "date", "ascending")).toEqual({ key: "when", dir: "ascending" });
    expect(nextSort({ key: "when", dir: "ascending" }, "when", "date", "ascending")).toEqual({ key: "when", dir: "descending" });
    expect(sortAnnouncement("Due", "date", "ascending")).toBe("Sorted by Due, earliest first.");
  });

  it("says the new order once, in plain words", () => {
    expect(sortAnnouncement("Last activity", "date", "descending")).toBe("Sorted by Last activity, latest first.");
    expect(sortAnnouncement("Company", "text", "ascending")).toBe("Sorted by Company, A to Z.");
    expect(sortAnnouncement("Company", "text", "descending")).toBe("Sorted by Company, Z to A.");
    expect(sortAnnouncement("AI cost", "number", "descending")).toBe("Sorted by AI cost, highest first.");
    expect(sortAnnouncement("AI cost", "number", "ascending")).toBe("Sorted by AI cost, lowest first.");
    expect(numHead("Applicants")).toEqual({ label: "Applicants", num: true });
  });

  it("makes its word collator on the first comparison of words, not when a page loads the module", async () => {
    vi.resetModules();
    // counts each collator made, and still makes a real one
    const Real = Intl.Collator;
    let made = 0;
    const counting = new Proxy(Real, { construct: (target, args) => { made++; return Reflect.construct(target, args); } });
    Object.defineProperty(Intl, "Collator", { value: counting, configurable: true, writable: true });
    try {
      const fresh = await import("./helpers");
      expect(made).toBe(0);
      expect(fresh.compareValues(2, 10, "ascending")).toBeLessThan(0);
      expect(made).toBe(0);
      expect(fresh.compareValues("Role 2", "Role 10", "ascending")).toBeLessThan(0);
      expect(fresh.compareValues("Bright", "avon", "descending")).toBeLessThan(0);
      expect(made).toBe(1);
    } finally {
      Object.defineProperty(Intl, "Collator", { value: Real, configurable: true, writable: true });
    }
  });
});
