import { describe, expect, it } from "vitest";
import { ApplicationStage as ApplicationStageEnum } from "@ros/contracts";
import { AI_INTERVIEW_REMIND_GAP_HOURS, aiInterviewCanRemind, aiInterviewLastEmailAt, aiInterviewOf, aiInterviewRemindBlocked, aiInterviewStateOf } from "./ai-interview";
import { isStillApplying } from "./apply-flow";
import { baseOwnerStage } from "./stages";

/**
 * "No AI interview yet" (20 October 2026, R20-7): where someone in the column stands with their AI interview, in neutral
 * words and never a count or a stopping point, from the stage and the latest screen alone.
 */
describe("aiInterviewOf", () => {
  const now = new Date("2026-10-21T12:00:00.000Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const hoursOn = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();
  const screen = (status: string, over: Record<string, string | null> = {}) => ({ status, invitedAt: hoursAgo(30), expiresAt: hoursOn(90), remindedAt: null, idleRemindedAt: null, startedAt: null, completedAt: null, humanRequestedAt: null, createdAt: hoursAgo(30), ...over });

  it("is null outside the column, and the column is exactly the stages that map to it", () => {
    for (const stage of ApplicationStageEnum.options) {
      const view = aiInterviewOf(stage, screen("invited"), now);
      expect(view !== null, stage).toBe(baseOwnerStage(stage) === "no_ai_interview");
    }
  });

  it("names each state in the founder's words", () => {
    const cases: Array<[string, ReturnType<typeof screen> | null, string, string]> = [
      ["eligible", null, "being_read", "Getting the AI interview ready"],
      ["received", screen("expired"), "being_read", "Getting the AI interview ready"], // an older screen does not count before the new one exists
      ["screen_invited", screen("invited"), "invited", "Invited (not started)"],
      ["screen_invited", screen("reminded"), "invited", "Invited (not started)"],
      ["screening", screen("in_progress", { startedAt: hoursAgo(5) }), "started", "Started (not finished)"],
      ["screening", screen("paused", { startedAt: hoursAgo(5) }), "started", "Started (not finished)"],
      ["screening", screen("human_requested", { humanRequestedAt: hoursAgo(2) }), "asked_person", "Asked for a person"],
      ["screen_invited", screen("expired", { expiresAt: hoursAgo(1) }), "link_expired", "Link expired"],
      ["screening", screen("unfinished", { completedAt: hoursAgo(3) }), "didnt_finish", "Didn't finish"],
      ["screening", screen("declined_by_candidate", { completedAt: hoursAgo(3) }), "didnt_finish", "Didn't finish"],
      ["screen_invited", null, "being_read", "Getting the AI interview ready"],
    ];
    for (const [stage, s, state, label] of cases) expect(aiInterviewOf(stage, s, now), `${stage} ${s?.status}`).toMatchObject({ state, label });
  });

  it("never carries a count, an answer or where they stopped: the same fields whatever they did", () => {
    const keys = Object.keys(aiInterviewOf("screening", screen("unfinished", { completedAt: hoursAgo(3) }), now)!).sort();
    expect(keys).toEqual(["canRemind", "canResend", "group", "label", "lastEmailAt", "linkOpenUntil", "remindBlocked", "since", "state", "waitingForMore"]);
  });

  it("says when the state began, until when an unstarted link is open, and the groups the column's chips count", () => {
    expect(aiInterviewOf("screen_invited", screen("invited"), now)).toMatchObject({ since: hoursAgo(30), linkOpenUntil: hoursOn(90), group: "not_started" });
    expect(aiInterviewOf("screening", screen("in_progress", { startedAt: hoursAgo(5) }), now)).toMatchObject({ since: hoursAgo(5), linkOpenUntil: null, group: "started" });
    expect(aiInterviewOf("screen_invited", screen("expired", { expiresAt: hoursAgo(1) }), now)).toMatchObject({ since: hoursAgo(1), group: "closed", canResend: true, canRemind: false });
    expect(aiInterviewOf("screening", screen("human_requested", { humanRequestedAt: hoursAgo(2) }), now)).toMatchObject({ group: "asked_person", canResend: false, canRemind: false });
    expect(aiInterviewOf("eligible", null, now)).toMatchObject({ group: "not_started", since: null, lastEmailAt: null, canRemind: false, canResend: false });
  });

  it("offers a reminder for an open link once a day after the link or the last reminder went", () => {
    expect(AI_INTERVIEW_REMIND_GAP_HOURS).toBe(24);
    // the link went 30 hours ago: a reminder may go
    expect(aiInterviewCanRemind(screen("invited"), now)).toBe(true);
    // the link went 3 hours ago: not yet
    expect(aiInterviewCanRemind(screen("invited", { invitedAt: hoursAgo(3) }), now)).toBe(false);
    // the latest email counts, whichever it was
    expect(aiInterviewLastEmailAt(screen("reminded", { remindedAt: hoursAgo(10) }))).toBe(hoursAgo(10));
    expect(aiInterviewCanRemind(screen("reminded", { remindedAt: hoursAgo(10) }), now)).toBe(false);
    expect(aiInterviewCanRemind(screen("reminded", { remindedAt: hoursAgo(24) }), now)).toBe(true);
    expect(aiInterviewCanRemind(screen("in_progress", { idleRemindedAt: hoursAgo(23) }), now)).toBe(false);
    // never a closed link, a paused chat or a request for a person
    for (const status of ["expired", "unfinished", "paused", "human_requested", "completed", "cancelled"]) expect(aiInterviewCanRemind(screen(status), now), status).toBe(false);
  });

  it("says why an open link cannot be reminded about: recently, its email not gone yet (B7), or paused; and a wait only for more interviews (Q17)", () => {
    const held = { ...screen("invited"), linkEmailHeld: true };
    expect(aiInterviewCanRemind(held, now)).toBe(false);
    expect(aiInterviewRemindBlocked(held, now)).toBe("email_held");
    expect(aiInterviewRemindBlocked(screen("invited", { invitedAt: hoursAgo(3) }), now)).toBe("recently");
    expect(aiInterviewRemindBlocked(screen("paused", { startedAt: hoursAgo(5) }), now)).toBe("paused");
    expect(aiInterviewRemindBlocked(screen("invited"), now)).toBeNull();
    // a link that is not open has nothing to say here: "Send a new link" says it
    for (const status of ["expired", "unfinished", "human_requested", "completed", "cancelled"]) expect(aiInterviewRemindBlocked(screen(status), now), status).toBeNull();
    expect(aiInterviewOf("screen_invited", held, now)).toMatchObject({ canRemind: false, remindBlocked: "email_held" });
    expect(aiInterviewOf("eligible", null, now, { waitingForMore: true })).toMatchObject({ state: "being_read", waitingForMore: true, remindBlocked: null });
    expect(aiInterviewOf("eligible", null, now)).toMatchObject({ waitingForMore: false });
    // once a screen exists the wait for more interviews is over
    expect(aiInterviewOf("screen_invited", screen("invited"), now, { waitingForMore: true })).toMatchObject({ waitingForMore: false });
  });

  it("reads 'still applying' (E6) as a part of it: the open states", () => {
    for (const status of ["invited", "reminded", "in_progress", "paused"]) {
      expect(isStillApplying({ status, invitedVia: "with_application" })).toBe(true);
      expect(["invited", "started"]).toContain(aiInterviewStateOf(status));
    }
  });
});
