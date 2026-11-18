import { describe, expect, it } from "vitest";
import { SCREEN_REMIND_EVERY_HOURS, ScreenStatus } from "@ros/contracts";
import { aiInterviewLastEmailAt, aiInterviewViewOf, remindedRecently } from "./ai-interview";

describe("the team's view of an AI interview", () => {
  const now = new Date("2026-11-18T12:00:00.000Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const hoursOn = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();
  const screen = (status: string, over: Record<string, string | null> = {}) => ({ status, invitedAt: hoursAgo(30), expiresAt: hoursOn(90), remindedAt: null, startedAt: null, completedAt: null, createdAt: hoursAgo(30), ...over });

  it("names where each interview stands, and is nothing without one or for a cancelled one", () => {
    const cases: Array<[string, string, string]> = [
      ["invited", "sent", "AI interview sent"],
      ["reminded", "sent", "AI interview sent"],
      ["in_progress", "started", "AI interview started"],
      ["completed", "done", "AI interview done"],
      ["expired", "link_closed", "AI interview link closed"],
      ["declined_by_candidate", "opted_out", "Chose not to do the AI interview"],
    ];
    for (const [stored, status, label] of cases) expect(aiInterviewViewOf(screen(stored)), stored).toMatchObject({ status, label });
    expect(aiInterviewViewOf(screen("cancelled"))).toBeNull();
    expect(aiInterviewViewOf(null)).toBeNull();
    expect(aiInterviewViewOf(undefined)).toBeNull();
  });

  it("never carries a count, an answer or where they stopped: the same fields whatever they did", () => {
    for (const status of ScreenStatus.options.filter((s) => s !== "cancelled")) {
      const view = aiInterviewViewOf({ ...screen(status, { startedAt: hoursAgo(5), completedAt: hoursAgo(1) }), answers: { q1: "their words" }, transcript: [{ role: "candidate", content: "their words" }], progress: { askedKeys: ["q1"] } } as Parameters<typeof aiInterviewViewOf>[0]);
      expect(Object.keys(view!).sort(), status).toEqual(["completedAt", "label", "lastEmailAt", "linkOpenUntil", "sentAt", "startedAt", "status"]);
      expect(JSON.stringify(view), status).not.toContain("their words");
    }
  });

  it("says until when the link is open only while it is open, and when the answers were sent only once they were", () => {
    expect(aiInterviewViewOf(screen("invited"))).toMatchObject({ sentAt: hoursAgo(30), linkOpenUntil: hoursOn(90), startedAt: null, completedAt: null });
    expect(aiInterviewViewOf(screen("in_progress", { startedAt: hoursAgo(5) }))).toMatchObject({ linkOpenUntil: hoursOn(90), startedAt: hoursAgo(5), completedAt: null });
    expect(aiInterviewViewOf(screen("completed", { startedAt: hoursAgo(5), completedAt: hoursAgo(4) }))).toMatchObject({ linkOpenUntil: null, completedAt: hoursAgo(4) });
    // a closed link and an opt-out carry the time the row was closed nowhere: only that it is closed
    expect(aiInterviewViewOf(screen("expired", { expiresAt: hoursAgo(1), completedAt: hoursAgo(1) }))).toMatchObject({ linkOpenUntil: null, completedAt: null });
    expect(aiInterviewViewOf(screen("declined_by_candidate", { completedAt: hoursAgo(2) }))).toMatchObject({ linkOpenUntil: null, completedAt: null });
    // a row without its invitation time reads the time it was created
    expect(aiInterviewViewOf(screen("invited", { invitedAt: null }))).toMatchObject({ sentAt: hoursAgo(30) });
  });

  it("counts the latest email, the link or a reminder, and a reminder waits a day after either", () => {
    expect(SCREEN_REMIND_EVERY_HOURS).toBe(24);
    expect(aiInterviewLastEmailAt(screen("invited"))).toBe(hoursAgo(30));
    expect(aiInterviewLastEmailAt(screen("reminded", { remindedAt: hoursAgo(10) }))).toBe(hoursAgo(10));
    expect(aiInterviewLastEmailAt({ status: "invited" })).toBeNull();
    expect(aiInterviewViewOf(screen("reminded", { remindedAt: hoursAgo(10) }))).toMatchObject({ lastEmailAt: hoursAgo(10) });
    // the link went 30 hours ago: a reminder may go
    expect(remindedRecently(screen("invited"), now)).toBe(false);
    // the link went 3 hours ago: not yet
    expect(remindedRecently(screen("invited", { invitedAt: hoursAgo(3) }), now)).toBe(true);
    expect(remindedRecently(screen("reminded", { remindedAt: hoursAgo(10) }), now)).toBe(true);
    expect(remindedRecently(screen("in_progress", { remindedAt: hoursAgo(24) }), now)).toBe(false);
    expect(remindedRecently({ status: "invited" }, now)).toBe(false);
  });
});
