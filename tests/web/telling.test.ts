import { describe, expect, it } from "vitest";
import type { ApplicationDetail, DecisionMessageResult } from "../../apps/web/src/api/client";
import {
  PERSONAL_LINE_HINT, SAFETY_NET_WORKING_DAYS, THREAD_LONG, WORDING_HINT, bulkUndoMillis, bulkUndoneToast, closingResultToast, closingSendLabel, closingSheetLines, replyOwnWords, safetyNetActed, safetyNetDate,
  safetyNetLine, safetyNetPromise, safetyNetShort, sendButtonLabel, sendPolicyLine, sentWithUndoToast, suggestedLineNote, threadItems, undoFailedToast, undoMillisLeft, undoable, undoneToast, wordingChoices,
} from "../../apps/web/src/telling";

describe("the safety net said when a decision is filed (Q27)", () => {
  it("never says nothing goes by itself: under 'Do it' the message goes, otherwise a recruiter is brought in, and unknown says both", () => {
    expect(safetyNetPromise("sends", "the closing message")).toBe("If nobody tells them within 5 working days, the closing message goes to them by itself.");
    expect(safetyNetPromise("needs_approval")).toBe("Nothing is sent by itself: if nobody tells them within 5 working days, an ITS recruiter is brought in to make sure they are told.");
    expect(safetyNetPromise("not_sent")).toBe(safetyNetPromise("needs_approval"));
    expect(safetyNetPromise()).toBe("If nobody tells them within 5 working days, the standard message goes by itself (if your settings ask for approval or keep these messages with a person, an ITS recruiter is brought in instead and nothing is sent).");
  });

  it("says it in one short line, with the day when it is known (founder decision D-03 A)", () => {
    const on = new Date("2026-10-21T12:00:00");
    expect(safetyNetShort({ policy: "sends", hasEmail: true, on })).toBe("If nobody tells them first, the standard message goes by itself on Wednesday, October 21.");
    expect(safetyNetShort({ policy: "sends", hasEmail: true, on, who: "Maria", what: "the closing message" })).toBe("If nobody tells Maria first, the closing message goes by itself on Wednesday, October 21.");
    // settings that keep these messages with a person, or no address: a recruiter, and nothing goes by itself
    expect(safetyNetShort({ policy: "needs_approval", on })).toBe("If nobody tells them first, an ITS recruiter is brought in on Wednesday, October 21. Nothing is sent by itself.");
    expect(safetyNetShort({ policy: "sends", hasEmail: false, on })).toMatch(/an ITS recruiter is brought in/);
    // the setting not known: both ways; the day not known: after five working days
    expect(safetyNetShort({ on })).toBe("If nobody tells them first, the standard message goes by itself on Wednesday, October 21 (or an ITS recruiter is brought in, if your settings say so).");
    expect(safetyNetShort({ policy: "sends" })).toBe("If nobody tells them first, the standard message goes by itself after 5 working days.");
  });
});

describe("a line the assistant suggested and the person kept (Q28)", () => {
  it("says the assistant helped while the line is whole, and still says so once it was changed, with how to leave it out", () => {
    expect(suggestedLineNote(true, "footer")).toBe("You kept a line the AI assistant suggested, so the footer says the assistant helped write it.");
    expect(suggestedLineNote(true, "invitation")).toBe("You kept a line the AI assistant suggested, so the invitation says the assistant helped write it.");
    expect(suggestedLineNote(false, "footer")).toBe("You changed the line the AI assistant suggested; it is still mostly its words, so the footer says the assistant helped write it. To leave that out, empty the message and write your own.");
    expect(suggestedLineNote(false, "invitation")).toMatch(/empty the line and write your own\.$/);
  });
});

/**
 * Telling candidates (plan Wave G; founder decisions B6, Q27, Q28, Q30), the page's words: the approved wordings and
 * the personal line on the Send screen, the Undo window after Send, the safety net on the "not told yet" card, the one
 * closing message of a closed role, and the conversation thread on the Messages tab. Pure functions, tested here.
 */
type Comm = ApplicationDetail["communications"][number];
const comm = (over: Partial<Comm>): Comm => ({ id: "m1", direction: "outbound", channel: "email", subject: null, bodyText: "Hello", status: "sent", createdAt: "2026-10-01T10:00:00.000Z", templateKey: null, sentBy: { kind: "system", id: "s" }, ...over });

describe("the Send screen (Q28)", () => {
  it("lists the approved wordings with the suggested one first and marked, each with a line in our own words", () => {
    const choices = wordingChoices([{ id: "v1", label: "Standard", suggested: false }, { id: "v2", label: "Warmer", suggested: false }, { id: "after_interview", label: "After an interview", suggested: true }]);
    expect(choices.map((c) => c.id)).toEqual(["after_interview", "v1", "v2"]);
    expect(choices[0].text).toBe("After an interview (suggested)");
    expect(choices[1].text).toBe("Standard");
    for (const c of choices) expect(c.hint).toBe(WORDING_HINT[c.id]);
    // every wording has a hint, and none of them copies another product's words
    for (const hint of Object.values(WORDING_HINT)) expect(hint.length).toBeGreaterThan(10);
  });

  it("says what the personal line may not carry, and what Send does under each setting", () => {
    expect(PERSONAL_LINE_HINT).toMatch(/no scores, no reasons for the decision, nothing about age, family, health, religion or background/);
    expect(sendButtonLabel("sends")).toBe("Send");
    expect(sendButtonLabel("needs_approval")).toBe("Send for approval");
    expect(sendPolicyLine({ to: "luis@example.com", policy: "sends", undoSeconds: 30 })).toBe("To luis@example.com. It goes when you press Send, after 30 seconds in which you can still undo it.");
    expect(sendPolicyLine({ to: "luis@example.com", policy: "sends", undoSeconds: 0 })).toBe("To luis@example.com. It goes as soon as you press Send.");
    expect(sendPolicyLine({ to: "luis@example.com", policy: "needs_approval", undoSeconds: 30 })).toMatch(/waits for approval/);
    expect(sendPolicyLine({ to: "luis@example.com", policy: "not_sent", undoSeconds: 30 })).toMatch(/no decision messages are sent/);
    expect(sendPolicyLine({ to: null, policy: "sends", undoSeconds: 30 })).toMatch(/^There is no email address on file/);
  });
});

describe("Undo after Send (plan G9)", () => {
  const now = new Date("2026-10-09T12:00:00.000Z");

  it("counts the time left in the window, and nothing once it has passed or when there is none", () => {
    expect(undoMillisLeft("2026-10-09T12:00:30.000Z", now)).toBe(30_000);
    expect(undoMillisLeft("2026-10-09T11:59:59.000Z", now)).toBe(0);
    expect(undoMillisLeft(null, now)).toBe(0);
    expect(undoMillisLeft("not a date", now)).toBe(0);
  });

  it("says the message waits and Undo takes it back; after Undo, that they were not told", () => {
    expect(sentWithUndoToast({ firstName: "Luis", seconds: 30, wording: "v2" })).toEqual({ title: "Decision message sent (Warmer).", detail: "It leaves in 30 seconds. Press Undo to take it back." });
    expect(sentWithUndoToast({ firstName: "Luis", seconds: 28, kind: "message" }).title).toBe("Message to Luis sent.");
    expect(undoneToast({ firstName: "Luis", kind: "decision", toldState: "not_told" })).toEqual({ title: "Taken back.", detail: "The decision message was not sent; Luis has not been told." });
    expect(undoneToast({ firstName: "Luis", kind: "message" }).detail).toBe("Your message to Luis was not sent.");
    expect(undoFailedToast("already_sent")).toEqual({ title: "Too late to undo.", detail: "The message has already gone." });
    expect(undoFailedToast("not_found", "That message was not found.").detail).toBe("That message was not found.");
  });

  it("offers Undo all for the messages of a bulk Send still waiting, until the first of them leaves", () => {
    const results: DecisionMessageResult[] = [
      { applicationId: "a1", ok: true, candidateNotice: "queued", communicationId: "c1", undoUntil: "2026-10-09T12:00:30.000Z" },
      { applicationId: "a2", ok: true, candidateNotice: "queued", communicationId: "c2", undoUntil: "2026-10-09T12:00:20.000Z" },
      { applicationId: "a3", ok: true, candidateNotice: "held", communicationId: "c3", undoUntil: null },
      { applicationId: "a4", ok: false, code: "already_told", message: "They were already told." },
    ];
    expect(undoable(results, now)).toEqual([{ applicationId: "a1", communicationId: "c1" }, { applicationId: "a2", communicationId: "c2" }]);
    expect(bulkUndoMillis(results, now)).toBe(20_000);
    expect(bulkUndoMillis([results[2], results[3]], now)).toBe(0);
    expect(bulkUndoneToast(2, 0)).toEqual({ title: "2 messages taken back.", detail: "Those people have not been told." });
    expect(bulkUndoneToast(1, 1)).toEqual({ title: "1 message taken back.", detail: "Those people have not been told. 1 message had already gone." });
    expect(bulkUndoneToast(0, 2).title).toBe("Nothing was taken back.");
  });
});

describe("the safety net on the 'not told yet' card (Q27)", () => {
  type A = Parameters<typeof safetyNetLine>[0]["a"];
  const base: A = { stage: "rejected", toldState: "not_told", stageChangedAt: "2026-10-05T15:00:00.000Z", rejectedAt: "2026-10-05T15:00:00.000Z", timeline: [], candidate: { firstName: "Luis", lastName: "Ortega", email: "luis@example.com", phone: null, locationText: null, consent: {} }, declineMessage: "sends" };

  it("acts five working days after the decision, skipping the weekend", () => {
    expect(SAFETY_NET_WORKING_DAYS).toBe(5);
    // decided on Monday, October 5: the fifth working day after is Monday, October 12
    const on = safetyNetDate("2026-10-05T15:00:00.000Z")!;
    expect(on.getDay()).toBe(1);
    expect(Math.round((on.getTime() - Date.parse("2026-10-05T15:00:00.000Z")) / 86_400_000)).toBe(7);
    // decided on a Friday: the next Friday
    const fri = safetyNetDate("2026-10-09T15:00:00.000Z")!;
    expect(Math.round((fri.getTime() - Date.parse("2026-10-09T15:00:00.000Z")) / 86_400_000)).toBe(7);
    expect(safetyNetDate("nonsense")).toBeNull();
  });

  it("says, in one short line, on which day the standard message goes by itself if nobody tells them first (D-03 A)", () => {
    const line = safetyNetLine({ a: base, waitingApproval: false, now: new Date("2026-10-06T12:00:00.000Z") })!;
    expect(line).toBe("If nobody tells Luis first, the standard message goes by itself on Monday, October 12.");
    expect(line.split(" ").length).toBeLessThanOrEqual(16);
  });

  it("brings in a recruiter instead, and sends nothing, when the settings ask for approval, keep it with a person, or there is no address", () => {
    for (const a of [{ ...base, declineMessage: "needs_approval" as const }, { ...base, declineMessage: "not_sent" as const }, { ...base, candidate: { ...base.candidate, email: null } }]) {
      expect(safetyNetLine({ a, waitingApproval: false, now: new Date("2026-10-06T12:00:00.000Z") })).toBe("If nobody tells Luis first, an ITS recruiter is brought in on Monday, October 12. Nothing is sent by itself.");
    }
  });

  it("says so once the day has passed, and once a recruiter was brought in; and says nothing when told, waiting for approval, or undecided", () => {
    expect(safetyNetLine({ a: base, waitingApproval: false, now: new Date("2026-10-13T12:00:00.000Z") })).toMatch(/with the next daily check/);
    const acted = { ...base, timeline: [{ type: "application.untold_fallback", occurredAt: "2026-10-12T14:00:00.000Z", actor: { kind: "system", id: "untold_safety_net" }, payload: { action: "recruiter" } }] };
    expect(safetyNetActed(acted.timeline)).toEqual({ action: "recruiter", at: "2026-10-12T14:00:00.000Z" });
    expect(safetyNetLine({ a: acted, waitingApproval: false })).toMatch(/^An ITS recruiter was brought in on Monday, October 12 to make sure Luis is told\./);
    expect(safetyNetLine({ a: { ...base, toldState: "sent" }, waitingApproval: false })).toBeNull();
    expect(safetyNetLine({ a: base, waitingApproval: true })).toBeNull();
    expect(safetyNetLine({ a: { ...base, stage: "triaged" }, waitingApproval: false })).toBeNull();
    // a day the API names wins over the page's own count
    expect(safetyNetLine({ a: { ...base, untoldFallbackOn: "2026-10-13" }, waitingApproval: false, now: new Date("2026-10-06T12:00:00.000Z") })).toMatch(/on Tuesday, October 13\.$/);
  });
});

describe("the closing message of a closed role (Q30)", () => {
  const p = { count: 3, alreadyTold: 1, waitingApproval: 0, noEmail: 1, optedOut: 1, policy: "sends" as const, waitingApprovalId: null };

  it("says who gets it, who is left out and why, and what the one Send does", () => {
    const w = closingSheetLines(p);
    expect(w.lead).toMatch(/^3 people were still in process when the role closed\. One courteous message tells all of them/);
    expect(w.lead).toMatch(/stay in your talent pool unless they asked not to be kept/);
    expect(w.notes).toEqual([
      "1 person already told is left out.",
      "1 person has no email address on file, so tell them another way and record it on their page.",
      "1 person asked not to be kept for future roles; the message does not invite them back.",
    ]);
    expect(closingSendLabel(p)).toBe("Send to 3 people");
    expect(closingSendLabel({ count: 1, policy: "needs_approval" })).toBe("Send to 1 person for approval");
    expect(closingSheetLines({ ...p, policy: "needs_approval" }).notes).toContain("Under your settings it waits for one approval for everyone before it goes.");
    expect(closingSheetLines({ ...p, waitingApprovalId: "ar1" }).lead).toMatch(/waiting for approval/);
    expect(closingSheetLines({ ...p, count: 0 }).lead).toMatch(/told already/);
  });

  it("counts every outcome of the Send", () => {
    expect(closingResultToast({ status: "sent", queued: 3, held: 0, notSent: 0 })).toEqual({ title: "3 closing messages on their way." });
    expect(closingResultToast({ status: "sent", queued: 2, held: 1, notSent: 1 })).toEqual({ title: "2 closing messages on their way.", detail: "1 saved; saved messages go out as soon as ITS confirms your company; 1 not sent." });
    expect(closingResultToast({ status: "waiting_approval", queued: 0, held: 0, notSent: 0 }).detail).toMatch(/One approval covers everyone/);
    expect(closingResultToast({ status: "not_sent_settings", queued: 0, held: 0, notSent: 3 }).title).toBe("Not sent.");
    expect(closingResultToast({ status: "role_reopened", queued: 0, held: 0, notSent: 2 })).toEqual({ title: "Not sent.", detail: "The role was reopened, so the closing message was not sent. Nobody was told anything." });
    // the closing message's per-person results offer "Undo all" like a bulk Send (plan G9)
    const until = new Date(Date.now() + 20_000).toISOString();
    const closing = [{ applicationId: "a1", ok: true, candidateNotice: "queued" as const, communicationId: "c1", undoUntil: until }, { applicationId: "a2", ok: false, code: "already_told" }];
    expect(undoable(closing)).toEqual([{ applicationId: "a1", communicationId: "c1" }]);
    expect(bulkUndoMillis(closing)).toBeGreaterThan(0);
  });
});

describe("the conversation thread on the Messages tab (plan G7)", () => {
  it("puts every message in order, oldest first, saying who wrote it", () => {
    const items = threadItems([
      comm({ id: "m3", direction: "inbound", bodyText: "Thanks, that works.\n\nOn Tue, Oct 6, Bright Dental wrote:\n> Hi Luis", createdAt: "2026-10-06T10:00:00.000Z", sentBy: { kind: "candidate", id: "c" }, status: "received" }),
      comm({ id: "m1", subject: "We received your application", templateKey: "application_received", createdAt: "2026-10-01T10:00:00.000Z" }),
      comm({ id: "m2", subject: "A question", templateKey: "freeform", createdAt: "2026-10-05T10:00:00.000Z", sentBy: { kind: "user", id: "u1", name: "Dana Whitfield" } }),
      comm({ id: "m4", subject: null, templateKey: "freeform", createdAt: "2026-10-07T10:00:00.000Z", sentBy: { kind: "recruiter", id: "r1", name: "Pat Lee" } }),
      comm({ id: "m5", templateKey: "disposition:v1", createdAt: "2026-10-08T10:00:00.000Z", sentBy: { kind: "user", id: "u1", name: "Dana Whitfield" }, status: "cancelled" }),
      comm({ id: "m6", channel: "internal", createdAt: "2026-10-08T11:00:00.000Z" }),
    ], "Luis");
    expect(items.map((i) => i.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(items.map((i) => i.from)).toEqual(["system", "team", "candidate", "recruiter", "team"]);
    expect(items.map((i) => i.who)).toEqual(["Sent automatically", "Dana Whitfield", "Luis", "Pat Lee (ITS recruiter)", "Dana Whitfield"]);
    // the candidate's own words, without what their email program quoted under them
    expect(items[2].text).toBe("Thanks, that works.");
    expect(items[2].label).toBe("Reply");
    expect(items[3].label).toBe("A message from your team");
    expect(items[4].label).toBe("Decision message");
    expect(items[4].status).toBe("Taken back before it was sent");
  });

  it("says where a message stands when it has not simply been delivered, and folds long ones", () => {
    const [queued, held, failed] = threadItems([comm({ id: "a", status: "queued" }), comm({ id: "b", status: "held", createdAt: "2026-10-02T10:00:00.000Z" }), comm({ id: "c", status: "failed", createdAt: "2026-10-03T10:00:00.000Z" })], "Luis");
    expect(queued.status).toBe("Waiting to go out");
    expect(held).toMatchObject({ status: "Saved until ITS confirms your company", statusTone: "caution" });
    expect(failed).toMatchObject({ status: "Could not be delivered", statusTone: "critical" });
    expect(threadItems([comm({ bodyText: "x".repeat(THREAD_LONG + 1) })], "Luis")[0].long).toBe(true);
    expect(threadItems([comm({ bodyText: "short" })], "Luis")[0].long).toBe(false);
  });

  it("keeps a whole reply when nothing would be left of it, and cuts an Outlook block", () => {
    expect(replyOwnWords("> only quoted")).toBe("> only quoted");
    expect(replyOwnWords("Yes please.\nFrom: Bright Dental\nSent: Tuesday\nSubject: Hi")).toBe("Yes please.");
    expect(replyOwnWords("Sure\n-----Original Message-----\nold")).toBe("Sure");
  });
});
