import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asksWhetherItTookPlace } from "../../apps/web/src/interview-defaults";
import { eligibilityAnswerWords, notReadYetWords } from "../../apps/web/src/pages/candidate-panel/helpers";
import { ACK_FOR_ANOTHER, ackIsForAnother, retryDeletionToast } from "../../apps/web/src/pages/Admin";
import { meetingLinkFor } from "../../apps/web/src/pages/candidate-panel/needs-you";
import { CATCH_UP_EVERY_MS, CATCH_UP_FOR_MS, catchUpInterval, waitingOnWorker } from "../../apps/web/src/pages/RolePlan";
import { CALENDAR_OFF_LINE, calendarConnectOffered } from "../../apps/web/src/pages/Setup";

/**
 * What live testing on staging found on the team's pages (13 Oct 2026), with the worker apart from the web server and
 * the development calendar stand-in switched on: the role page that never showed "Approve and publish" until a reload,
 * Setup's "Connect Google Calendar" that led to a page that was not found, the interview approval that recorded an empty
 * meeting link, and the admin console's buttons that failed without a word.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the role page while the worker catches up", () => {
  const role = (status: string, opts: { pending?: boolean; current?: number } = {}) => ({
    status,
    packetApproval: { pending: opts.pending ? ({ id: "ap1", version: 2 } as never) : null, latest: null },
    currentPacket: opts.current ? ({ version: opts.current } as never) : null,
  });

  it("waits just after 'Ask for approval', until the approval request exists", () => {
    expect(waitingOnWorker(role("pending_approval", { current: 1 }), null)).toBe(true);
    expect(waitingOnWorker(role("pending_approval", { pending: true, current: 1 }), null)).toBe(false);
    // nothing to wait for on a draft, an open role or a closed one
    for (const status of ["draft", "open", "paused", "closed"]) expect(waitingOnWorker(role(status, { current: 1 }), null), status).toBe(false);
  });

  it("waits just after approving, until the role is open on the approved version", () => {
    expect(waitingOnWorker(role("pending_approval", { current: 2 }), 2)).toBe(true);
    expect(waitingOnWorker(role("open", { current: 2 }), 2)).toBe(false);
    // a change approved on a live job: the status never changes, the version does
    expect(waitingOnWorker(role("open", { current: 1 }), 2)).toBe(true);
    expect(waitingOnWorker(role("paused", { current: 2 }), 2)).toBe(false);
  });

  it("reads the role again every 2 seconds while it waits, for two minutes at most, and not at all otherwise", () => {
    expect(CATCH_UP_EVERY_MS).toBe(2000);
    expect(catchUpInterval(true, 0, 1000)).toBe(2000);
    expect(catchUpInterval(true, 0, CATCH_UP_FOR_MS - 1)).toBe(2000);
    expect(catchUpInterval(true, 0, CATCH_UP_FOR_MS)).toBe(false);
    expect(catchUpInterval(false, 0, 1000)).toBe(false);
    expect(catchUpInterval(true, null, 1000)).toBe(false);
  });

  it("is wired into the role query, the approval card and the approve button", () => {
    const page = read("../../apps/web/src/pages/RoleDetail.tsx");
    expect(page).toContain("return catchUpInterval(true, waitingSince.current, Date.now());");
    expect(page).toContain("setApprovedVersion(r.packetApproval?.pending?.version ?? newestVersion);");
    // once caught up, the rail's dot and the Posting tab follow
    expect(page).toContain('qc.invalidateQueries({ queryKey: ["roles"] });');
    const plan = read("../../apps/web/src/pages/RolePlan.tsx");
    expect(plan).toContain('if (!pending && role.status === "pending_approval") return <CatchingUpCard latest={latest} sentBackHere={sentBackHere} />;');
    expect(plan).toContain("Getting the approval ready");
    // sent back from the card: "Sent back" until the worker has made the role a draft, not "Getting the approval ready"
    expect(plan).toContain("setSentBackHere(true);");
    expect(plan).toContain('if (role.status !== "pending_approval") setSentBackHere(false);');
  });
});

describe("Setup's calendar connection", () => {
  it("offers 'Connect Google Calendar' only when the real Google provider is set up", () => {
    expect(calendarConnectOffered([{ key: "google", status: "live" }])).toBe(true);
    // the development stand-in has no consent page in production; Google without its keys refuses
    expect(calendarConnectOffered([{ key: "google", status: "fake" }])).toBe(false);
    expect(calendarConnectOffered([{ key: "google", status: "not_connected" }])).toBe(false);
    expect(calendarConnectOffered([{ key: "outlook", status: "live" }])).toBe(false);
    expect(calendarConnectOffered(undefined)).toBe(false);
  });

  it("says in plain words that calendars are not switched on, and how interviews are scheduled meanwhile", () => {
    expect(CALENDAR_OFF_LINE).toBe("Calendar connection is not switched on for this workspace yet. Interviews are scheduled with the times you set below.");
    expect(CALENDAR_OFF_LINE).not.toMatch(/deployment|configured|_/);
    const setup = read("../../apps/web/src/pages/Setup.tsx");
    expect(setup).toContain("<p className=\"small muted\" style={{ margin: 0 }}>{CALENDAR_OFF_LINE}</p>");
    expect(setup).not.toContain('p.status !== "not_connected"');
  });
});

describe("the meeting link on the interview approval", () => {
  it("without a working calendar, offers no calendar link: a box for a link instead, which may stay empty", () => {
    const none = meetingLinkFor({ calendarLive: false, picked: null, url: "" });
    expect(none).toMatchObject({ offerCalendar: false, mode: "pasted", urlRequired: false, ready: true });
    // left empty, nothing pretends a link will be made: the invitation names the format
    expect(none.body).toEqual({ linkSource: "calendar" });
    expect(meetingLinkFor({ calendarLive: false, picked: null, url: "  https://meet.example.com/abc " }).body).toEqual({ linkSource: "pasted", meetingUrl: "https://meet.example.com/abc" });
    // a choice made while a calendar was there does not bring the calendar back
    expect(meetingLinkFor({ calendarLive: false, picked: "calendar", url: "" }).offerCalendar).toBe(false);
  });

  it("with an interviewer's working calendar, offers the calendar's link first, or a pasted one", () => {
    const cal = meetingLinkFor({ calendarLive: true, picked: null, url: "" });
    expect(cal).toMatchObject({ offerCalendar: true, mode: "calendar", ready: true, body: { linkSource: "calendar" } });
    // pasting needs the link before the approval can go
    expect(meetingLinkFor({ calendarLive: true, picked: "pasted", url: " " })).toMatchObject({ mode: "pasted", urlRequired: true, ready: false });
    expect(meetingLinkFor({ calendarLive: true, picked: "pasted", url: "https://zoom.example.com/j/1" })).toMatchObject({ ready: true, body: { linkSource: "pasted", meetingUrl: "https://zoom.example.com/j/1" } });
    // a link typed before the calendar was known counts as choosing to paste it
    expect(meetingLinkFor({ calendarLive: true, picked: null, url: "https://zoom.example.com/j/1" }).mode).toBe("pasted");
    expect(meetingLinkFor({ calendarLive: true, picked: "calendar", url: "https://zoom.example.com/j/1" }).body).toEqual({ linkSource: "calendar" });
  });

  it("reads the calendar from the team list the card already loads, and sends what the choice says", () => {
    const card = read("../../apps/web/src/pages/candidate-panel/needs-you.tsx");
    expect(card).toContain('m.calendar?.status === "live"');
    expect(card).toContain("...link.body,");
    expect(card).toContain("!link.ready}");
  });
});

describe("the admin console's alerts and retries", () => {
  const alert = (kind: string, actorId: string | null, targetId: string | null) => ({ kind, details: actorId ? { actorId } : {}, target: targetId ? { type: "user", id: targetId } : null });

  it("leaves acknowledging a platform-role alert about yourself to another administrator", () => {
    expect(ackIsForAnother(alert("platform_role.granted", "s1", "u9"), "s1")).toBe(true);
    expect(ackIsForAnother(alert("platform_role.bootstrapped", null, "s1"), "s1")).toBe(true);
    expect(ackIsForAnother(alert("platform_role.granted", "s2", "u9"), "s1")).toBe(false);
    // other alerts, and while it is not known who is signed in, keep the button (the server decides)
    expect(ackIsForAnother(alert("secret.delete_failed", "s1", "s1"), "s1")).toBe(false);
    expect(ackIsForAnother(alert("platform_role.granted", "s1", null), null)).toBe(false);
    expect(ACK_FOR_ANOTHER).toMatch(/^Another administrator acknowledges this one/);
  });

  it("says a retried deletion was queued when it was, and deleted only when it was", () => {
    expect(retryDeletionToast({ queued: true, deleted: false })).toEqual({ title: "Deletion queued.", detail: "It runs in the background in a moment. The alert closes once the credential is gone." });
    expect(retryDeletionToast({ queued: true, deleted: false }).title).not.toMatch(/deleted/i);
    expect(retryDeletionToast({ queued: false, deleted: true }).title).toBe("Credential deleted.");
  });

  it("tells the administrator when Acknowledge, Retry or Retry deletion did not work", () => {
    const admin = read("../../apps/web/src/pages/Admin.tsx");
    expect(admin).toContain('onError: (e) => toast(e instanceof ApiError ? e.message : "Could not acknowledge the alert. Try again in a moment.")');
    expect(admin).toContain('onError: (e) => toast(e instanceof ApiError ? e.message : "Could not retry the run. Try again in a moment.")');
    expect(admin).toContain('onError: (e) => toast(e instanceof ApiError ? e.message : "Could not retry the deletion. Try again in a moment.")');
    expect(admin).not.toContain('toast("Credential deleted.")');
    // the business calendar starts on today's date in the administrator's own calendar, never the UTC date
    expect(admin).toContain("const todayKey = () => dayKey(new Date());");
    expect(admin).not.toContain("toISOString().slice(0, 10)");
  });
});

describe("an interview booked for tomorrow", () => {
  const now = Date.parse("2026-10-13T22:40:00Z");
  it("asks whether it took place only once it has started", () => {
    expect(asksWhetherItTookPlace({ status: "scheduled", startsAt: "2026-10-14T16:00:00Z" }, now)).toBe(false);
    expect(asksWhetherItTookPlace({ status: "scheduled", startsAt: "2026-10-13T22:40:00Z" }, now)).toBe(true);
    expect(asksWhetherItTookPlace({ status: "scheduled", startsAt: null }, now)).toBe(false);
    // closed by the workflow's timer, still without an answer; never again once answered, or for one never booked
    expect(asksWhetherItTookPlace({ status: "completed", startsAt: "2026-10-12T16:00:00Z" }, now)).toBe(true);
    expect(asksWhetherItTookPlace({ status: "completed", outcome: "happened", startsAt: "2026-10-12T16:00:00Z" }, now)).toBe(false);
    expect(asksWhetherItTookPlace({ status: "scheduling", startsAt: null }, now)).toBe(false);
    expect(read("../../apps/web/src/pages/Interviews.tsx")).toContain("{asksWhetherItTookPlace(i) && (manage || participant) ? (");
  });
});

describe("someone held on an eligibility answer", () => {
  it("names the question once, with what they answered", () => {
    const question = "Do you hold a current California radiography (X-ray) certification?";
    expect(eligibilityAnswerWords({ question, reason: `answered no to: ${question}` })).toBe("answered no");
    expect(eligibilityAnswerWords({ question: "Can you start within 30 days?", reason: "cannot start within 30 days" })).toBe("cannot start within 30 days");
    expect(eligibilityAnswerWords({ question: "Can you work Saturdays?", reason: "not available: Sat" })).toBe("not available: Sat");
  });

  it("never promises a reading in a minute or two: it comes once someone keeps them in", () => {
    expect(notReadYetWords("ineligible")).toBe("The assistant reads this application once someone keeps them in.");
    expect(notReadYetWords("received")).toContain("a minute or two");
  });
});
