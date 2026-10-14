import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_CALENDAR, addBusinessHours, deadlineWords, escalationReplyBy, slaBusinessHours } from "./business-hours";
import { escalationThread, queueOrder } from "./escalations";

/**
 * The recruiter loop's pure parts (plan B4 to B6): the queue's order, the reply-by time and how it is said, and a
 * request's thread as the team reads it.
 */
describe("the ITS queue order (founder decision Q32, option A)", () => {
  const row = (id: string, urgency: string, slaDueAt: string | null, createdAt = "2026-10-05T16:00:00.000Z") => ({ id, urgency, slaDueAt, createdAt });

  it("puts urgent requests first, then the soonest reply-by time, then the oldest", () => {
    const rows = [
      row("normal-soon", "normal", "2026-10-06T17:00:00.000Z"),
      row("urgent-later", "high", "2026-10-08T17:00:00.000Z"),
      row("blocking", "critical", "2026-10-09T17:00:00.000Z"),
      row("low", "low", "2026-10-05T17:00:00.000Z"),
      row("urgent-sooner", "high", "2026-10-07T17:00:00.000Z"),
      row("normal-no-deadline", "normal", null),
      row("normal-same-older", "normal", "2026-10-06T17:00:00.000Z", "2026-10-04T16:00:00.000Z"),
    ];
    expect(queueOrder(rows).map((r) => r.id)).toEqual(["blocking", "urgent-sooner", "urgent-later", "normal-same-older", "normal-soon", "normal-no-deadline", "low"]);
    // the input is left as it was
    expect(rows[0].id).toBe("normal-soon");
  });

  it("an unknown urgency counts as normal", () => {
    expect(queueOrder([row("odd", "whenever", "2026-10-06T17:00:00.000Z"), row("n", "normal", "2026-10-07T17:00:00.000Z")]).map((r) => r.id)).toEqual(["odd", "n"]);
  });
});

describe("the reply-by time", () => {
  it("is the kind's business hours from the moment it is asked, whatever the urgency", () => {
    const monday = new Date("2026-10-05T16:00:00.000Z"); // 9:00 Pacific
    expect(escalationReplyBy("ask", monday).toISOString()).toBe(addBusinessHours(monday, 8).toISOString());
    expect(escalationReplyBy("candidate_issue", monday).toISOString()).toBe(addBusinessHours(monday, slaBusinessHours("candidate_issue")).toISOString());
    // a Friday afternoon request counts open hours only: one hour on Friday, none on the weekend or on Columbus Day
    // (Monday 12 October), seven on Tuesday
    const friday = new Date("2026-10-09T23:00:00.000Z"); // 16:00 Pacific
    expect(escalationReplyBy("ask", friday).toISOString()).toBe("2026-10-13T23:00:00.000Z");
  });

  it("is said in the calendar's own zone, by day and time", () => {
    const words = deadlineWords(new Date("2026-10-13T21:00:00.000Z"), DEFAULT_BUSINESS_CALENDAR);
    expect(words).toMatch(/^Tuesday, October 13/);
    expect(words).toMatch(/2:00\s?PM Pacific$/);
  });
});

describe("a request's thread as the team reads it", () => {
  const request = { id: "e1", question: "Is Maria worth a working interview?", createdAt: "2026-10-05T16:00:00.000Z", requestedBy: { kind: "user" as const, id: "u1", name: "Dana Owner" }, resolution: null as string | null, resolvedAt: null as string | null };
  const msg = (id: string, side: "customer" | "recruiter", kind: "reply" | "answer" | "reopen", body: string, at: string, name: string) => ({ id, side, kind, body, createdAt: at, author: { kind: side === "customer" ? ("user" as const) : ("recruiter" as const), id: name, name } });

  it("starts with the question and keeps every note, answer and reopening in order", () => {
    const thread = escalationThread({ ...request, resolution: "Second answer.", resolvedAt: "2026-10-07T18:00:00.000Z" }, [
      msg("m3", "customer", "reopen", "That did not cover the evening shift.", "2026-10-06T18:00:00.000Z", "Dana Owner"),
      msg("m1", "recruiter", "reply", "Which shift is she for?", "2026-10-05T18:00:00.000Z", "Kai Recruiter"),
      msg("m2", "recruiter", "answer", "First answer.", "2026-10-05T20:00:00.000Z", "Kai Recruiter"),
      msg("m4", "recruiter", "answer", "Second answer.", "2026-10-07T18:00:00.000Z", "Kai Recruiter"),
    ], "Kai Recruiter");
    expect(thread.map((e) => [e.kind, e.side, e.by])).toEqual([
      ["question", "customer", "Dana Owner"],
      ["reply", "recruiter", "Kai Recruiter"],
      ["answer", "recruiter", "Kai Recruiter"],
      ["reopen", "customer", "Dana Owner"],
      ["answer", "recruiter", "Kai Recruiter"],
    ]);
    // the answer on the request is not repeated: it is on the thread already
    expect(thread.filter((e) => e.body === "Second answer.")).toHaveLength(1);
  });

  it("a request answered before the thread existed shows its one answer, by the recruiter who gave it", () => {
    const thread = escalationThread({ ...request, resolution: "Interview her.", resolvedAt: "2026-10-05T20:00:00.000Z" }, [], "Kai Recruiter");
    expect(thread.map((e) => e.kind)).toEqual(["question", "answer"]);
    expect(thread[1]).toMatchObject({ side: "recruiter", body: "Interview her.", by: "Kai Recruiter", at: "2026-10-05T20:00:00.000Z" });
  });

  it("names nobody for a request the system or a candidate raised", () => {
    expect(escalationThread({ ...request, requestedBy: { kind: "system", id: "workflow:x" } }, [], null)[0]).toMatchObject({ by: null, side: "customer" });
    expect(escalationThread({ ...request, requestedBy: { kind: "candidate", id: "a1" } }, [], null)[0].by).toBeNull();
    expect(escalationThread({ ...request, requestedBy: { kind: "recruiter", id: "r1", name: "Kai" } }, [], null)[0]).toMatchObject({ by: "Kai", side: "recruiter" });
  });

  // 15 October 2026: once accepted, a stopped run's request read "The customer asked" under "Raised automatically by
  // Recruiting OS". The question now says who raised it, never a name, for the recruiter and for the team alike.
  it("says on the question when Recruiting OS or a candidate raised it, and nothing for a person on either side", () => {
    const stopped = { ...request, kind: "review", summary: "The customer wants a recruiter to review one candidate for this role.", roleId: "r1", applicationId: "a1", requestedBy: { kind: "system" as const, id: "workflow:application_intake" } };
    for (const forRecruiter of [true, false]) {
      expect(escalationThread(stopped, [], null, { forRecruiter })[0]).toMatchObject({ kind: "question", side: "customer", by: null, raisedBy: "system" });
    }
    // a candidate's HUMAN reply by email comes through a system actor; its summary was chosen for the candidate
    const human = { ...stopped, kind: "candidate_issue", summary: "A candidate for this role asked for a person; the hiring team needs a recruiter to follow up.", requestedBy: { kind: "system" as const, id: "email_reply" } };
    expect(escalationThread(human, [], null, { forRecruiter: true })[0]).toMatchObject({ by: null, raisedBy: "candidate" });
    expect(escalationThread({ ...request, requestedBy: { kind: "candidate", id: "a1" } }, [], null)[0].raisedBy).toBe("candidate");
    // an interview Recruiting OS could not arrange is its own, not a candidate asking
    const noHours = { ...human, summary: "Raised automatically by Recruiting OS: a candidate for this role needs a person to follow up.", requestedBy: { kind: "system" as const, id: "workflow:schedule_interview" } };
    expect(escalationThread(noHours, [], null, { forRecruiter: true })[0].raisedBy).toBe("system");
    // a person on the team or at ITS: no raisedBy
    expect(escalationThread(request, [], null, { forRecruiter: true })[0]).not.toHaveProperty("raisedBy");
    expect(escalationThread({ ...request, requestedBy: { kind: "recruiter", id: "r1", name: "Kai" } }, [], null)[0]).not.toHaveProperty("raisedBy");
  });
});
