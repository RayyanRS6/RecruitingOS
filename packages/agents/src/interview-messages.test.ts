import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { applications, candidates, communications, companies, createDb, interviews, migrate, roles, withTenant, type DbHandle } from "@ros/db";
import { createIntegrations } from "@ros/integrations";
import { samplePacket } from "./fixtures/sample-packet";
import { interviewCancelledMessage, sendSlotsOffered, slotsOfferedMessage, type InterviewMessageInput } from "./interview-messages";
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
    for (const variant of ["first", "new_times_asked", "new_times_team"] as const) {
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
