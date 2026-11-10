import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { applications, candidates, communications, companies, createDb, interviews, migrate, roles, withTenant, type DbHandle } from "@ros/db";
import { createIntegrations } from "@ros/integrations";
import { samplePacket } from "./fixtures/sample-packet";
import { ACCOMMODATION_LINE, interviewCancelledMessage, interviewConfirmationMessage, interviewIcs, interviewMovedMessage, interviewPlaceLine, interviewReminderMessage, sendSlotsOffered, slotsOfferedMessage, type InterviewMessageInput } from "./interview-messages";
import { HELD_REASON } from "./outbox";

/**
 * The candidate's interview emails around the Cancelled column (founder decisions 2A and 4A): the times email's
 * new-times openings, and the one sentence the candidate's own cancellation adds about what comes next. Every variant
 * keeps the one template and key per interview and attempt, so the ITS check and the outbox's withdrawals still apply.
 */
const packet = samplePacket();
const slot = { id: "s1", startsAt: "2026-10-20T17:00:00.000Z", endsAt: "2026-10-20T17:30:00.000Z", interviewerUserIds: ["u-1"], source: "declared" as const };
const interview = { id: "iv-1", attempt: 3, title: "Conversation with the dentist", durationMinutes: 30, format: "video", offeredSlots: [slot], scheduleToken: "tok-1", startsAt: null };
const base = {
  application: { id: "a-1" },
  candidate: { id: "c-1", firstName: "Ana", lastName: "Lopez", email: "ana@example.com" },
  role: { id: "r-1" },
  company: { id: "co-1", name: "Harbor Dental" },
  packet,
  actor: { kind: "system", id: "workflow:schedule_interview" },
  appBaseUrl: "https://app.example",
  interview,
  interviewerFirstNames: ["Grace", "Ben"],
  candidateTimezone: "America/Los_Angeles",
  companyTimezone: "America/Los_Angeles",
} as unknown as InterviewMessageInput;
const footer = `${packet.communication.humanAlternativeText}\n\n${packet.communication.signature}\n\n${packet.communication.disclosureText}`;

describe("the times email", () => {
  it("keeps one template and one key per interview and attempt in every variant", () => {
    for (const variant of ["first", "new_times_asked", "new_times_team", "rescheduled", "other_times", "missed_by_us"] as const) {
      const m = slotsOfferedMessage({ ...base, variant });
      expect(m.templateKey, variant).toBe("interview_slots");
      expect(m.idempotencyKey, variant).toBe("slots:iv-1:3");
      expect(m.text, variant).toContain("Choose here: https://app.example/c/schedule/tok-1");
      expect(m.text, variant).toContain("If none of these work, the same page lets you tell us what does.");
      expect(m.text.endsWith(footer), variant).toBe(true);
    }
    expect(slotsOfferedMessage(base)).toEqual(slotsOfferedMessage({ ...base, variant: "first" }));
  });

  it("opens the first offer with today's words", () => {
    const m = slotsOfferedMessage(base);
    expect(m.subject).toBe("Pick a time for your interview: Dental Assistant at Harbor Dental");
    expect(m.text).toContain("Good news: Harbor Dental would like to interview you for the Dental Assistant position. Conversation with the dentist with Grace and Ben, 30 minutes, video.");
  });

  it("opens the times a candidate asked for when they cancelled with what they asked for", () => {
    const m = slotsOfferedMessage({ ...base, variant: "new_times_asked" });
    expect(m.subject).toBe("New times for your interview: Dental Assistant at Harbor Dental");
    expect(m.text).toContain("As you asked when you cancelled, here are new times for your conversation with the dentist for the Dental Assistant position at Harbor Dental. 30 minutes, video with Grace and Ben.");
    expect(m.text).not.toContain("Good news");
  });

  it("opens the times the team sends without blaming anyone or hinting at a decision", () => {
    const m = slotsOfferedMessage({ ...base, variant: "new_times_team" });
    expect(m.subject).toBe("New interview times: Dental Assistant at Harbor Dental");
    expect(m.text).toContain("Harbor Dental would like to find a new time for your conversation with the dentist for the Dental Assistant position. 30 minutes, video with Grace and Ben.");
    expect(m.text).not.toMatch(/Good news|did not|missed|cancel|decid/i);
  });

  it("opens times worked out again with words that fit: after the team moved it, and after 'none of these work'", () => {
    const moved = slotsOfferedMessage({ ...base, variant: "rescheduled" });
    expect(moved.subject).toBe("New times for your interview: Dental Assistant at Harbor Dental");
    expect(moved.text).toContain("Harbor Dental has new times for your conversation with the dentist for the Dental Assistant position. 30 minutes, video with Grace and Ben.");
    expect(moved.text).not.toContain("Good news");
    const other = slotsOfferedMessage({ ...base, variant: "other_times" });
    expect(other.subject).toBe("Other times for your interview: Dental Assistant at Harbor Dental");
    expect(other.text).toContain("As you asked, here are other times for your conversation with the dentist for the Dental Assistant position at Harbor Dental.");
  });

  it("says sorry when the same round is offered again after our interviewer missed it (founder decision L-12)", () => {
    const m = slotsOfferedMessage({ ...base, variant: "missed_by_us" });
    expect(m).toMatchObject({ templateKey: "interview_slots", idempotencyKey: "slots:iv-1:3", subject: "New times for your interview: Dental Assistant at Harbor Dental" });
    expect(m.text).toContain("We are sorry: the interviewer from Harbor Dental could not join your last interview for the Dental Assistant position. Please pick a new time for your conversation with the dentist. 30 minutes, video with Grace and Ben.");
    expect(m.text).not.toContain("Good news");
  });

  it("tells the candidate a booked time the team moved is off, with a calendar file that removes it and the team's reason", () => {
    const booked = { ...base, interview: { ...interview, startsAt: "2026-10-20T17:00:00.000Z", endsAt: "2026-10-20T17:30:00.000Z", meetingUrl: null } } as unknown as InterviewMessageInput;
    const m = interviewMovedMessage({ ...booked, reason: "The dentist is away that day." });
    expect(m.subject).toBe("Your interview time has changed: Conversation with the dentist at Harbor Dental");
    expect(m.text).toContain("Harbor Dental needs to move your interview (Conversation with the dentist). The booked time on ");
    expect(m.text).toContain("is off, so there is no need to attend then. The attached calendar file removes it from your calendar. Harbor Dental said: \"The dentist is away that day.\"");
    expect(m.text).toContain("We will email you new times to pick from shortly.");
    expect(m.text.endsWith(footer)).toBe(true);
    expect(interviewMovedMessage(booked).text).not.toContain("said:");
    // the cancellation file outranks the booking it removes, and the next booking outranks the cancellation
    const ics = (attempt: number, method: "REQUEST" | "CANCEL") => interviewIcs({ interview: { ...(booked.interview as object), attempt } as never, company: base.company, packet, candidate: base.candidate, fromAddress: "x@example.com", method, appBaseUrl: "https://app.example" });
    const seq = (s: string) => Number(/SEQUENCE:(\d+)/.exec(s)![1]);
    expect(seq(ics(3, "CANCEL"))).toBeGreaterThan(seq(ics(3, "REQUEST")));
    expect(seq(ics(4, "REQUEST"))).toBeGreaterThan(seq(ics(3, "CANCEL")));
  });

  it("keeps a title that starts with an acronym as written, and the invitation note where the caller gives one", () => {
    const hr = { ...base, interview: { ...interview, title: "HR interview" } } as InterviewMessageInput;
    expect(slotsOfferedMessage({ ...hr, variant: "new_times_team" }).text).toContain("a new time for your HR interview for the");
    // a title in title case reads in lower case mid-sentence; a word in capitals, and a person's name, stay as written
    const final = { ...base, interview: { ...interview, title: "Final Interview with the CEO" } } as InterviewMessageInput;
    expect(slotsOfferedMessage({ ...final, variant: "new_times_asked" }).text).toContain("here are new times for your final interview with the CEO for the");
    const named = { ...base, interview: { ...interview, title: "Call with Paul" } } as InterviewMessageInput;
    expect(slotsOfferedMessage({ ...named, variant: "new_times_team" }).text).toContain("a new time for your call with Paul for the");
    expect(slotsOfferedMessage({ ...base, variant: "new_times_asked", note: { text: "Looking forward to it.", aiHelped: false, senderName: "Dana" } }).text).toContain("with Grace and Ben.\n\nA note from Dana: Looking forward to it.");
  });
});

describe("the confirmation", () => {
  const start = "2026-11-10T22:00:00.000Z"; // Tuesday 2:00 PM in Los Angeles
  const person = { ...slot, id: "s2", startsAt: start, endsAt: "2026-11-10T22:30:00.000Z", source: "person" as const };
  const booked = (over: Record<string, unknown> = {}) => ({ ...base, roundPurpose: "Your experience with patients.", interview: { ...interview, startsAt: start, endsAt: "2026-11-10T22:30:00.000Z", meetingUrl: "https://meet.example/room", selectedSlot: person, status: "scheduled", ...over } }) as unknown as Parameters<typeof interviewConfirmationMessage>[0];
  const when = "Tuesday, November 10, 2026 at 2:00 PM PST";
  const page = "https://app.example/c/schedule/tok-1/confirmed";

  it("a person set it: says who would like to interview them, the date and time with its zone, where, and how to ask for a change; nothing says they confirmed", () => {
    const m = interviewConfirmationMessage({ ...booked(), setByPerson: true });
    expect(m.subject).toBe(`Your interview: Conversation with the dentist at Harbor Dental, ${when}`);
    expect(m.text).toBe(`Hi Ana,

Good news: Harbor Dental would like to interview you for the Dental Assistant position.

When: ${when}
How long: 30 minutes
Join: https://meet.example/room
Who: Grace, Ben

What to prepare: Your experience with patients.

A calendar invitation is attached. Need a different time? ${page}

${ACCOMMODATION_LINE}

${footer}`);
  });

  it("the accommodation line is on every variant, and the footer's disclosure and way to a person with it", () => {
    const variants = [
      interviewConfirmationMessage(booked()),
      interviewConfirmationMessage({ ...booked(), setByPerson: true }),
      interviewConfirmationMessage({ ...booked(), setByPerson: true, moved: { reason: "A clash." } }),
      interviewConfirmationMessage({ ...booked(), setByPerson: true, newTimeAfterCancel: true }),
      interviewConfirmationMessage({ ...booked(), setByPerson: true, missedByUs: true }),
    ];
    expect(ACCOMMODATION_LINE).toBe("Need an adjustment, such as captions or a phone call instead of video? Tell us on the same page, or reply to this email.");
    for (const m of variants) {
      expect(m.text).toContain(ACCOMMODATION_LINE);
      expect(m.text.endsWith(footer)).toBe(true);
    }
  });

  it("the candidate's own pick keeps its words", () => {
    const m = interviewConfirmationMessage(booked());
    expect(m.subject).toBe(`Confirmed: Conversation with the dentist at Harbor Dental, ${when}`);
    expect(m.text).toContain("You are confirmed: Conversation with the dentist for the Dental Assistant position at Harbor Dental.");
    expect(m.text).toContain(`A calendar invitation is attached. Need to change it? ${page} lets you reschedule or cancel.`);
  });

  it("moved: says so in one email, with the team's reason when they gave one", () => {
    const m = interviewConfirmationMessage({ ...booked(), setByPerson: true, moved: { reason: "  The dentist is away.  " } });
    expect(m.subject).toBe(`New time for your interview: Conversation with the dentist at Harbor Dental, ${when}`);
    expect(m.text).toContain('Harbor Dental has moved your conversation with the dentist. Harbor Dental said: "The dentist is away."\n\nWhen:');
    expect(m.text).not.toContain("Good news");
    expect(interviewConfirmationMessage({ ...booked(), setByPerson: true, moved: { reason: null } }).text).toContain("Harbor Dental has moved your conversation with the dentist.\n\nWhen:");
  });

  it("the same time with new details: says the details changed, never 'New time' or 'has moved' (the release review, 11 November 2026)", () => {
    const m = interviewConfirmationMessage({ ...booked(), setByPerson: true, changed: { reason: "  Here is the link.  " } });
    expect(m.subject).toBe(`Your interview has changed: Conversation with the dentist at Harbor Dental, ${when}`);
    expect(m.text).toContain('Harbor Dental has changed the details of your conversation with the dentist. Harbor Dental said: "Here is the link."\n\nWhen:');
    expect(m.text).not.toMatch(/New time|has moved|Good news/);
    expect(interviewConfirmationMessage({ ...booked(), setByPerson: true, changed: { reason: null } }).text).toContain("Harbor Dental has changed the details of your conversation with the dentist.\n\nWhen:");
    // the accommodation line is whole in it too
    expect(m.text).toContain(ACCOMMODATION_LINE);
  });

  it("after a cancel or a no-show: a new time was set, with no hint why; after our interviewer missed it: sorry; a move says only that it moved", () => {
    const again = interviewConfirmationMessage({ ...booked(), setByPerson: true, newTimeAfterCancel: true });
    expect(again.subject).toBe(`Your interview: Conversation with the dentist at Harbor Dental, ${when}`);
    expect(again.text).toContain("Harbor Dental has set a new time for your conversation with the dentist for the Dental Assistant position.\n\nWhen:");
    expect(again.text).not.toMatch(/Good news|did not|missed|cancel|decid/i);
    const sorry = interviewConfirmationMessage({ ...booked(), setByPerson: true, missedByUs: true });
    expect(sorry.text).toContain("We are sorry: the interviewer from Harbor Dental could not join your last interview for the Dental Assistant position. Here is a new time for your conversation with the dentist.\n\nWhen:");
    expect(interviewConfirmationMessage({ ...booked(), setByPerson: true, missedByUs: true, moved: { reason: null } }).text).not.toContain("sorry");
  });

  it("names both zones when the candidate saved another, and the personal line sits after what to prepare, saying so when the assistant helped", () => {
    const m = interviewConfirmationMessage({ ...booked(), candidateTimezone: "America/New_York", setByPerson: true, note: { text: "See you then.", aiHelped: true, senderName: "Dana" } });
    expect(m.text).toContain(`When: Tuesday, November 10, 2026 at 5:00 PM EST (${when} for the team)`);
    expect(m.subject).toContain("5:00 PM EST");
    expect(m.text).toContain("What to prepare: Your experience with patients.\n\nA note from Dana: See you then. (Dana wrote this note with help from an AI assistant.)\n\nA calendar invitation");
  });

  it("the place line: a link, an address, by phone with and without their number, and nothing more known", () => {
    const lineOf = (over: Record<string, unknown>, phone: string | null = null) => interviewPlaceLine({ ...base, candidate: { ...base.candidate, phone }, interview: { ...interview, meetingUrl: null, selectedSlot: person, format: "video", ...over } } as never);
    expect(lineOf({ meetingUrl: "https://meet.example/x" })).toBe("Join: https://meet.example/x");
    expect(lineOf({ format: "onsite", selectedSlot: { ...person, address: "12 Main St" } })).toBe("Where: 12 Main St");
    expect(lineOf({ format: "phone" }, "+17145550100")).toBe("By phone: Harbor Dental will call you at +17145550100");
    expect(lineOf({ format: "phone" })).toBe("By phone: Harbor Dental will call you. Reply with the best number to reach you.");
    // a video link left empty with no calendar to make one, and the candidate's own pick of a phone round: the Format line says what is known
    expect(lineOf({})).toBeNull();
    expect(lineOf({ format: "phone", selectedSlot: { ...person, source: "declared" } })).toBeNull();
    expect(interviewConfirmationMessage({ ...booked({ meetingUrl: null }), setByPerson: true }).text).toContain("Format: video; details from the team follow if anything else is needed.");
  });

  it("the calendar file: LOCATION is the address or by phone, and the same UID with a higher SEQUENCE replaces an entry in place", () => {
    const ics = (over: Record<string, unknown>) => interviewIcs({ interview: { ...interview, startsAt: start, endsAt: person.endsAt, meetingUrl: null, selectedSlot: person, ...over } as never, company: base.company, packet, candidate: base.candidate, fromAddress: "x@example.com", method: "REQUEST", appBaseUrl: "https://app.example" }).replace(/\r\n /g, "");
    expect(ics({ format: "onsite", selectedSlot: { ...person, address: "12 Main St, Tustin" } })).toContain("LOCATION:12 Main St\\, Tustin");
    expect(ics({ format: "phone" })).toContain("LOCATION:By phone");
    expect(ics({ format: "video" })).not.toContain("LOCATION:");
    const first = ics({ attempt: 1, format: "video" });
    const moved = ics({ attempt: 2, format: "video" });
    const uid = (s: string) => /UID:(.+)/.exec(s)![1];
    const seq = (s: string) => Number(/SEQUENCE:(\d+)/.exec(s)![1]);
    expect(uid(moved)).toBe(uid(first));
    expect(seq(moved)).toBeGreaterThan(seq(first));
    expect(moved).toContain("METHOD:REQUEST");
  });

  it("a reminder carries the same place line, and nothing when nothing more is known", () => {
    const visit = interviewReminderMessage({ ...booked({ meetingUrl: null, format: "onsite", selectedSlot: { ...person, address: "12 Main St" } }), which: "before24h" });
    expect(visit.subject).toBe("Tomorrow: Conversation with the dentist at Harbor Dental");
    expect(visit.text).toContain(`Your interview is tomorrow. Conversation with the dentist at Harbor Dental: ${when}.\nWhere: 12 Main St\n`);
    expect(visit.text).toContain(`Need to change it? ${page}`);
    const call = interviewReminderMessage({ ...booked({ meetingUrl: null, format: "phone" }), which: "before2h" });
    expect(call.subject).toBe("Soon: Conversation with the dentist at Harbor Dental");
    expect(call.text).toContain("Your interview starts in about two hours.");
    expect(call.text).toContain("By phone: Harbor Dental will call you. Reply with the best number to reach you.");
    const video = interviewReminderMessage({ ...booked(), which: "before2h" });
    expect(video.text).toContain("Join: https://meet.example/room");
    expect(interviewReminderMessage({ ...booked({ meetingUrl: null }), which: "before2h" }).text).not.toMatch(/Join:|Where:|By phone:/);
  });
});

describe("the cancellation email", () => {
  const own = "As requested, your interview (Conversation with the dentist) at Harbor Dental is cancelled.";
  const write = (extra: Partial<Parameters<typeof interviewCancelledMessage>[0]>) => interviewCancelledMessage({ ...base, byCandidate: true, ...extra });

  it("without the candidate's choice is exactly today's email (the withdrawal and every other path)", () => {
    expect(write({}).text).toBe(`Hi Ana,\n\n${own}\n\n${footer}`);
    expect(write({}).subject).toBe("Cancelled: Conversation with the dentist at Harbor Dental");
  });

  it("adds the one sentence for what the candidate chose", () => {
    expect(write({ candidateChoice: { next: "new_times", newTimesOn: "Thursday, October 15" } }).text).toBe(`Hi Ana,\n\n${own} We will email you new times on Thursday, October 15, unless the team gets in touch first.\n\n${footer}`);
    expect(write({ candidateChoice: { next: "new_times", newTimesOn: null } }).text).toContain(`${own} You asked for new times, so someone from the team will be in touch about them.\n\n`);
    expect(write({ candidateChoice: { next: "not_interested", newTimesOn: null } }).text).toContain(`${own} We let the team know you are no longer interested. If you change your mind, reply to this email.\n\n`);
  });

  it("never promises a day when none is armed, and leaves the team's wordings alone", () => {
    expect(write({ candidateChoice: { next: "new_times", newTimesOn: null } }).text).not.toMatch(/on (Mon|Tues|Wednes|Thurs|Fri)day/);
    expect(write({ byCandidate: false, reason: "the dentist is ill." }).text).toContain("Harbor Dental had to cancel your interview (Conversation with the dentist): the dentist is ill. They will be in touch about next steps.");
  });
});

describe("the times email through the outbox", () => {
  let handle: DbHandle;
  const integrations = createIntegrations({ NODE_ENV: "test", COMP_BLS_ENABLED: "false", STORAGE_PROVIDER: "memory" }, { memoryStorage: true });

  /** A company (confirmed by ITS or not) with one candidate whose interview is being offered again (attempt 3). */
  async function offer(verified: boolean) {
    const companyId = randomUUID();
    const roleId = randomUUID();
    const candidateId = randomUUID();
    const applicationId = randomUUID();
    const interviewId = randomUUID();
    const settings = verified ? { verifiedAt: "2026-09-01T00:00:00.000Z" } : {};
    await handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band, timezone, settings) VALUES (${companyId}, 'Harbor Dental', ${`harbor-${companyId}`}, 'dental', '20-49', 'America/Los_Angeles', ${JSON.stringify(settings)}::jsonb)`);
    await handle.db.execute(sql`INSERT INTO roles (id, company_id, title, status, created_by) VALUES (${roleId}, ${companyId}, 'Dental Assistant', 'open', ${sql`'{"kind":"user","id":"u1"}'::jsonb`})`);
    await handle.db.execute(sql`INSERT INTO candidates (id, company_id, first_name, last_name, email, first_source) VALUES (${candidateId}, ${companyId}, 'Ana', 'Lopez', ${`ana-${candidateId}@example.com`}, 'direct')`);
    await handle.db.execute(sql`INSERT INTO applications (id, company_id, role_id, candidate_id, packet_version, source, status_token, stage) VALUES (${applicationId}, ${companyId}, ${roleId}, ${candidateId}, 1, 'direct', ${`tok-${applicationId}`}, 'interview_recommended')`);
    await handle.db.execute(sql`INSERT INTO interviews (id, company_id, application_id, round_key, title, format, duration_minutes, status, attempt, schedule_token, offered_slots) VALUES (${interviewId}, ${companyId}, ${applicationId}, 'owner', 'Conversation with the dentist', 'video', 30, 'scheduling', 3, ${`tok-${interviewId}`}, ${JSON.stringify([slot])}::jsonb)`);
    return withTenant(handle.db, companyId, async (tx) => {
      const [application] = await tx.select().from(applications).where(eq(applications.id, applicationId));
      const [candidate] = await tx.select().from(candidates).where(eq(candidates.id, candidateId));
      const [role] = await tx.select().from(roles).where(eq(roles.id, roleId));
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const [iv] = await tx.select().from(interviews).where(eq(interviews.id, interviewId));
      const sent = await sendSlotsOffered(tx, integrations, { application, candidate, role, company, packet, actor: { kind: "system", id: "workflow:schedule_interview" }, appBaseUrl: "https://app.example", interview: iv, interviewerFirstNames: ["Grace"], candidateTimezone: "America/Los_Angeles", companyTimezone: "America/Los_Angeles", variant: "new_times_asked" });
      const [row] = await tx.select().from(communications).where(eq(communications.idempotencyKey, `slots:${interviewId}:3`));
      return { sent, row };
    });
  }

  beforeAll(async () => {
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle);
  });
  afterAll(async () => {
    await handle.close();
  });

  it("queues the new-times email under the times key and template", async () => {
    const { sent, row } = await offer(true);
    expect(sent).toMatchObject({ status: "pending", reason: "queued for delivery" });
    expect(row).toMatchObject({ templateKey: "interview_slots", status: "queued", subject: "New times for your interview: Dental Assistant at Harbor Dental", disclosureIncluded: true });
    expect(row.bodyText).toContain("As you asked when you cancelled");
    expect(row.bodyText).toContain(packet.communication.disclosureText);
  });

  it("holds it for the ITS check, and says so to the caller", async () => {
    const { sent, row } = await offer(false);
    expect(sent).toMatchObject({ status: "pending", reason: HELD_REASON });
    expect(row.status).toBe("held");
  });
});
