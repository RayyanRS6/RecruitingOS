import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { PROVIDER_REFUSED_ALERT, detectStuckRoles, queueCommunication } from "@ros/agents";
import { addCalendarDays, companyToday, entitlements, findInvitationByToken } from "@ros/core";
import { adminAlerts, applications, candidates, communications, companies, hiringOutcomes as hiringOutcomesTable, interviews as interviewsTable, notifications, users, withPlatform, withTenant } from "@ros/db";
import type { FakeEmailAdapter, SendResult } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { APPLY_WAIT_JS, WAIT_GAVE_UP_LINE, WAIT_GAVE_UP_MORE } from "./pages/apply-form";
import { QUIET_DAY_LINE } from "./services/brief";
import { closeAfterHireCards } from "./services/hire-sheet";
import { signInAs } from "./test-helpers";

/**
 * The other dead ends of the owner's two flows (6 November 2026; the dead ends study, section 1). Each case is one thing a
 * first-time owner met with nothing to press, or words that were not true, and what they read now.
 */
describe("the dead ends a first-time owner met", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerId = "";
  let companyId = "";
  let companySlug = "";
  let roleId = "";
  let n = 0;
  const DAY = 86_400_000;
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const member = (role: "interviewer" | "hiring_manager" | "hr" | "admin", email: string) => signInAs(container, app, { companyId, role, email });
  const read = async <T>(r: Response) => (await r.json()) as T;
  type Card = { kind: string; title: string; body: string; actions: Array<{ label: string; path: string }>; unreached?: Array<{ applicationId: string; roleId: string; roleTitle: string; name: string; email: string | null; phone: string | null; emails: number }> };
  const brief = async (cookie = owner) => (await read<{ cards: Card[]; summary: string }>(await json(cookie, "GET", "/api/v1/brief")));
  const cardOf = async (kind: string, cookie = owner) => (await brief(cookie)).cards.find((c) => c.kind === kind);

  const apply = async (first: string, last: string, opts: { phone?: string; role?: string } = {}) => {
    n += 1;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}${n}@deadends.test`;
    const target = opts.role ?? roleId;
    const role = await read<{ currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } }>(await json(owner, "GET", `/api/v1/roles/${target}`));
    const fd = new FormData();
    fd.set("firstName", first);
    fd.set("lastName", last);
    fd.set("email", email);
    fd.set("locationText", "Tustin, CA");
    if (opts.phone) fd.set("phone", opts.phone);
    fd.set("resume", new File([`${first} ${last}, RDH\nRegistered Dental Hygienist at Coastal Family Dentistry 2019 - present`], "resume.txt", { type: "text/plain" }));
    for (const rule of role.currentPacket.packet.requirements.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    const r = await app.request(`/careers/${companySlug}/jobs/${target}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": `198.51.100.${n % 250}` } });
    expect(r.status).toBe(302);
    await container.drain();
    // Found by who applied, not by the newest time: the machine's clock can step back while a suite runs.
    const [{ a }] = await container.db.select({ a: applications }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(and(eq(applications.roleId, target), eq(candidates.email, email))).limit(1);
    return { id: a.id, email, name: `${first} ${last}`, candidateId: a.candidateId };
  };
  /** What the outbox would have written for an email that did not arrive. */
  const failEmailsOf = async (applicationId: string, status: "failed" | "bounced" = "failed", ago = 0) => {
    await container.db.update(communications).set({ status, error: status === "failed" ? "postmark 422: The 'From' address you supplied is not a Sender Signature." : "HardBounce: mailbox does not exist", ...(ago ? { createdAt: new Date(Date.now() - ago).toISOString() } : {}) }).where(and(eq(communications.applicationId, applicationId), eq(communications.channel, "email")));
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    owner = await signIn("owner@deadends.test");
    const [u] = await container.db.select({ id: users.id }).from(users).where(eq(users.email, "owner@deadends.test"));
    ownerId = u.id;
    expect(ownerId).toBeTruthy();
    const co = await read<{ id: string; slug: string }>(await json(owner, "POST", "/api/v1/companies", { name: "Harbor Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Tustin", region: "CA", country: "US" }] }));
    companyId = co.id;
    companySlug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const s = await read<{ session: { id: string } }>(await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." }));
    roleId = (await read<{ roleId: string }>(await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`))).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "Looks right." })).status).toBe(200);
    await container.drain();
  });
  afterAll(async () => {
    await container.close();
  });

  describe("rank 1: emails to candidates that did not arrive", () => {
    it("Home names each person whose email did not arrive, with their address and phone and the way to their page; Settings counts the same sends", async () => {
      const ana = await apply("Ana", "Reyes", { phone: "(714) 555-0101" });
      const ben = await apply("Ben", "Ortiz");
      const cleo = await apply("Cleo", "Locked");
      const fine = await apply("Dev", "Fine");
      // Before anything failed: no card, and Settings counts what left.
      expect(await cardOf("unreached")).toBeUndefined();
      const healthy = await read<{ candidateEmail: { left: number; failed: number; lastLeftAt: string | null } }>(await json(owner, "GET", "/api/v1/companies/current"));
      expect(healthy.candidateEmail.failed).toBe(0);
      expect(healthy.candidateEmail.left).toBeGreaterThanOrEqual(4);
      expect(healthy.candidateEmail.lastLeftAt).toBeTruthy();

      await failEmailsOf(ana.id, "failed");
      await failEmailsOf(ben.id, "bounced");
      // Someone past the plan's candidates per job is never named or counted (Rule 3), whatever happened to their email.
      await container.db.update(applications).set({ lockedAt: new Date().toISOString() }).where(eq(applications.id, cleo.id));
      await failEmailsOf(cleo.id, "failed");
      const card = (await cardOf("unreached"))!;
      const failedOfAnaAndBen = (await container.db.select({ id: communications.id, applicationId: communications.applicationId }).from(communications).where(and(eq(communications.companyId, companyId), eq(communications.channel, "email")))).filter((m) => m.applicationId === ana.id || m.applicationId === ben.id).length;
      expect(failedOfAnaAndBen).toBeGreaterThanOrEqual(2);
      expect(card.title).toBe(`${failedOfAnaAndBen} ${failedOfAnaAndBen === 1 ? "email" : "emails"} to candidates did not arrive`);
      expect(card.body.split("\n")[0]).toBe("Phone each of them, or write to them yourself.");
      expect(card.unreached!.map((p) => p.name).sort()).toEqual(["Ana Reyes", "Ben Ortiz"]);
      const anaRow = card.unreached!.find((p) => p.applicationId === ana.id)!;
      // the phone as it is kept (the form normalizes it)
      expect(anaRow).toMatchObject({ roleId, email: ana.email, phone: "+17145550101" });
      expect(anaRow.roleTitle).toBeTruthy();
      expect(card.body).toContain(ana.email);
      expect(card.body).toContain("+17145550101");
      for (const words of [JSON.stringify(card), JSON.stringify(await brief())]) {
        expect(words).not.toContain("Cleo");
        expect(words).not.toContain(cleo.email);
      }
      expect(card.unreached!.some((p) => p.applicationId === fine.id)).toBe(false);
      // It needs you, so it is counted as such.
      expect((await brief()).summary).toMatch(/^\d+ things? needs? you/);

      // Settings reads the same sends, and never the locked person's.
      const after = await read<{ candidateEmail: { left: number; failed: number; lastFailedAt: string | null; days: number } }>(await json(owner, "GET", "/api/v1/companies/current"));
      expect(after.candidateEmail.failed).toBe(failedOfAnaAndBen);
      expect(after.candidateEmail.days).toBe(7);
      expect(after.candidateEmail.lastFailedAt).toBeTruthy();

      // An email to Ana that left after the failure: she has a working address again, and leaves the card.
      await withPlatform(container.db, (tx) => tx.insert(communications).values({ companyId, candidateId: ana.candidateId, applicationId: ana.id, direction: "outbound", channel: "email", toAddress: ana.email, subject: "Reminder", bodyText: "t", templateKey: "screen_reminder", status: "sent", sentBy: { kind: "system", id: "test" }, idempotencyKey: `later:${ana.id}` }));
      expect((await cardOf("unreached"))!.unreached!.map((p) => p.name)).toEqual(["Ben Ortiz"]);
      expect((await cardOf("unreached"))!.title).toMatch(/^\d+ emails? to candidates did not arrive$/);
      // One person: their page is the card's button too.
      expect((await cardOf("unreached"))!.actions).toEqual([{ label: "Open Ben Ortiz", method: "GET", path: `/roles/${roleId}/talent?open=${ben.id}` }]);
    });

    it("a failure older than a week, and a decision message that did not arrive, are not on the card", async () => {
      const old = await apply("Old", "Failure");
      await failEmailsOf(old.id, "failed", 8 * DAY);
      const told = await apply("Told", "Already");
      await withPlatform(container.db, (tx) => tx.insert(communications).values({ companyId, candidateId: told.candidateId, applicationId: told.id, direction: "outbound", channel: "email", toAddress: told.email, subject: "Your application", bodyText: "t", templateKey: "disposition:standard", status: "failed", error: "x", sentBy: { kind: "system", id: "test" }, idempotencyKey: `decision:${told.id}` }));
      const names = (await cardOf("unreached"))?.unreached?.map((p) => p.name) ?? [];
      expect(names).not.toContain("Old Failure");
      expect(names).not.toContain("Told Already");
    });

    it("someone with no email address on file is named with that, and an interviewer's Home has no such card", async () => {
      const none = await apply("Nora", "Noaddress");
      await container.db.update(candidates).set({ email: null }).where(eq(candidates.id, none.candidateId));
      await failEmailsOf(none.id, "failed");
      const card = (await cardOf("unreached"))!;
      expect(card.unreached!.find((p) => p.applicationId === none.id)).toMatchObject({ email: null });
      expect(card.body).toContain("Nora Noaddress (");
      expect(card.body).toContain("no email address on file");
      // An interviewer reads only their own interviews; nobody's address reaches them. A hiring manager reads the card.
      expect(await cardOf("unreached", await member("interviewer", "ivy@deadends.test"))).toBeUndefined();
      expect((await cardOf("unreached", await member("hiring_manager", "hal@deadends.test")))?.unreached?.some((p) => p.applicationId === none.id)).toBe(true);
    });
  });

  describe("rank 9: an invitation whose email did not arrive", () => {
    type Pending = { id: string; email: string; emailState: string | null };
    const pending = async () => read<Pending[]>(await json(owner, "GET", "/api/v1/companies/current/invitations"));

    it("the one who invites gets the link to copy; the row says whether its email went, and Email failed when it did not", async () => {
      const sent = await read<{ link: string; invitation: { id: string } }>(await json(owner, "POST", "/api/v1/companies/current/invites", { email: "kim@deadends.test", role: "hiring_manager" }));
      expect(sent.link).toMatch(/\/api\/v1\/auth\/invite\?token=/);
      await container.drain();
      expect((await pending()).find((i) => i.id === sent.invitation.id)).toMatchObject({ email: "kim@deadends.test", emailState: "sent" });
      // its email failed for good
      await container.db.update(communications).set({ status: "failed", error: "postmark 422: refused" }).where(and(eq(communications.companyId, companyId), eq(communications.templateKey, "invite"), eq(communications.toAddress, "kim@deadends.test")));
      expect((await pending()).find((i) => i.id === sent.invitation.id)?.emailState).toBe("failed");
    });

    it("Copy invitation link makes a new link with no email; the old one stops working, and the row no longer claims an email", async () => {
      const sent = await read<{ link: string; invitation: { id: string } }>(await json(owner, "POST", "/api/v1/companies/current/invites", { email: "lee@deadends.test", role: "interviewer" }));
      await container.drain();
      const mails = async () => (await container.db.select().from(communications).where(and(eq(communications.companyId, companyId), eq(communications.templateKey, "invite"), eq(communications.toAddress, "lee@deadends.test")))).length;
      const before = await mails();
      const r = await json(owner, "POST", `/api/v1/companies/current/invitations/${sent.invitation.id}/resend`, { email: false });
      expect(r.status, await r.clone().text()).toBe(200);
      const copied = await read<{ link: string; emailed: boolean }>(r);
      expect(copied.emailed).toBe(false);
      expect(copied.link).toMatch(/\/api\/v1\/auth\/invite\?token=/);
      expect(copied.link).not.toBe(sent.link);
      await container.drain();
      expect(await mails()).toBe(before);
      // the old link no longer opens the invitation; the new one does
      const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;
      expect(await findInvitationByToken(container.db, tokenOf(sent.link))).toBeNull();
      expect((await findInvitationByToken(container.db, tokenOf(copied.link)))?.id).toBe(sent.invitation.id);
      expect((await pending()).find((i) => i.id === sent.invitation.id)?.emailState).toBeNull();
      // Send again still emails the fresh link, as before
      const again = await read<{ emailed: boolean; link: string }>(await json(owner, "POST", `/api/v1/companies/current/invitations/${sent.invitation.id}/resend`));
      expect(again.emailed).toBe(true);
      await container.drain();
      expect(await mails()).toBe(before + 1);
      expect((await pending()).find((i) => i.id === sent.invitation.id)?.emailState).toBe("sent");
    });
  });

  describe("rank 14: a hire ends that person's interviews still to come, and the job asks to be closed", () => {
    let jobB = "";
    let roundKey = "";
    // On the company's own day, as Home counts it (America/Los_Angeles, the company's zone): a UTC date is already tomorrow there
    // every US evening (00:00 to 08:00 UTC), when "yesterday" by UTC is the company's today (the release review, 11 November 2026).
    const TZ = "America/Los_Angeles";
    const dayFromNow = (days: number) => addCalendarDays(companyToday(new Date(), TZ), days);
    const book = async (applicationId: string, days: number) => {
      const r = await json(owner, "POST", `/api/v1/applications/${applicationId}/interviews`, { roundKey, interviewerUserIds: [ownerId], setTime: { date: dayFromNow(days), time: "10:00", durationMinutes: 45, place: { kind: "phone" } } });
      expect(r.status, await r.clone().text()).toBe(201);
      await container.drain();
      return read<{ id: string }>(r);
    };
    const hire = async (applicationId: string, hireDate: string) => {
      const r = await json(owner, "POST", `/api/v1/applications/${applicationId}/outcome`, { outcome: "hired_externally", confirm: true, hireDate });
      expect(r.status, await r.clone().text()).toBe(201);
      await container.drain();
      return read<{ stage: string; interviewsEnded?: number }>(r);
    };

    beforeAll(async () => {
      const s = await read<{ session: { id: string } }>(await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a front desk coordinator in Tustin, $22 to $26 an hour, full time. It's a new role. Ceiling $27. I decide. Must-haves: two years at a front desk. Just draft it." }));
      jobB = (await read<{ roleId: string }>(await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`))).roleId;
      expect((await json(owner, "POST", `/api/v1/roles/${jobB}/approve`, { version: 1, note: "ok" })).status).toBe(200);
      await container.drain();
      const role = await read<{ currentPacket: { packet: { interviews: { plan: Array<{ key: string }> } } } }>(await json(owner, "GET", `/api/v1/roles/${jobB}`));
      roundKey = role.currentPacket.packet.interviews.plan[0].key;
    });

    it("a hire calls off a booked interview quietly: nothing to the candidate, the interviewers told, nothing left under Coming up", async () => {
      const mo = await apply("Mo", "Hired", { role: jobB });
      const iv = await book(mo.id, 20);
      const before = (await container.db.select({ id: communications.id }).from(communications).where(eq(communications.applicationId, mo.id))).length;
      const done = await hire(mo.id, dayFromNow(30));
      expect(done).toMatchObject({ stage: "hired", interviewsEnded: 1 });
      const [row] = await container.db.select().from(interviewsTable).where(eq(interviewsTable.id, iv.id));
      expect(row.status).toBe("cancelled");
      // the candidate hears nothing about it
      const after = await container.db.select({ templateKey: communications.templateKey }).from(communications).where(eq(communications.applicationId, mo.id));
      expect(after.length).toBe(before);
      // the interviewer is told, in words that say why
      const [told] = await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.cancelled"), eq(notifications.userId, ownerId))).orderBy(desc(notifications.createdAt)).limit(1);
      expect(told.body).toBe("The candidate was hired, so this interview is off.");
      const coming = await read<Array<{ id: string; status: string }>>(await json(owner, "GET", "/api/v1/interviews"));
      expect(coming.find((i) => i.id === iv.id)?.status ?? "cancelled").toBe("cancelled");
    });

    it("once every hire on a job has started, Home asks \"Close this job?\" every day until it is closed; never before", async () => {
      const ned = await apply("Ned", "Starts", { role: jobB });
      const closeCard = async () => (await brief()).cards.find((c) => c.title.startsWith("Close this job?") && c.actions.some((a) => a.path === `/roles/${jobB}?close=1`));
      // Mo starts in 30 days: nothing asks to close yet
      expect(await closeCard()).toBeUndefined();
      // Ned was hired and started two days ago, but Mo has not started: still nothing
      await hire(ned.id, dayFromNow(-2));
      expect(await closeCard()).toBeUndefined();
      // once Mo's start has passed too (a correction of the date, here by hand), the job asks to be closed
      await container.db.update(hiringOutcomesTable).set({ hireDate: dayFromNow(-1) }).where(eq(hiringOutcomesTable.roleId, jobB));
      const card = (await closeCard())!;
      expect(card.kind).toBe("needs_review");
      expect(card.title).toMatch(/^Close this job\? /);
      expect(card.body).toMatch(/started on .+, and .+ is still live and taking applications\. Close it if the job is filled/);
      expect(card.actions).toEqual([{ label: "Close the job", method: "GET", path: `/roles/${jobB}?close=1` }]);
      // it asks again the next time Home is read: there is no way to wave it off but closing
      expect(await closeCard()).toBeTruthy();
      // the same question in a US evening, when the UTC date is already tomorrow: Home counts the company's own day, so the
      // card is there whatever hour CI runs at, and a start on the company's today has not passed yet (L5-1)
      const [company] = await container.db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId));
      expect(company.timezone).toBe(TZ);
      const today = dayFromNow(0);
      const evening = new Date(`${addCalendarDays(today, 1)}T03:30:00.000Z`);
      expect(companyToday(evening, TZ)).toBe(today);
      expect(evening.toISOString().slice(0, 10)).not.toBe(today);
      const askedAt = async (now: Date) => (await withTenant(container.db, companyId, (tx) => closeAfterHireCards(tx, { companyId, viewer: { role: "owner" }, now }))).some((c) => c.roleId === jobB);
      expect(await askedAt(evening)).toBe(true);
      await container.db.update(hiringOutcomesTable).set({ hireDate: today }).where(and(eq(hiringOutcomesTable.roleId, jobB), eq(hiringOutcomesTable.applicationId, ned.id)));
      expect(await askedAt(evening)).toBe(false);
      await container.db.update(hiringOutcomesTable).set({ hireDate: dayFromNow(-1) }).where(eq(hiringOutcomesTable.roleId, jobB));
      expect(await askedAt(evening)).toBe(true);
      // an interviewer, who cannot close a job, is never asked
      expect((await brief(await member("interviewer", "ivy2@deadends.test"))).cards.some((c) => c.title.startsWith("Close this job?"))).toBe(false);
      // closed as filled: the question goes
      expect((await json(owner, "POST", `/api/v1/roles/${jobB}/outcome`, { outcome: "filled", confirm: true })).status).toBe(200);
      expect(await closeCard()).toBeUndefined();
    });
  });

  describe("ranks 15, 17 and 18: a finalist, the candidate's tracker, and who withdrew", () => {
    type Row = { id: string; stage: string; ownerStage: string; ownerStageLabel: string; stageMoves: Array<{ to: string; allowed: boolean; blockedReason?: string }> };
    const rowOf = async (id: string) => (await read<Row[]>(await json(owner, "GET", `/api/v1/roles/${roleId}/applications`))).find((r) => r.id === id)!;

    it("someone who withdrew reads Withdrew on their row and stage button, never Not moving forward", async () => {
      const wes = await apply("Wes", "Withdrew");
      await withPlatform(container.db, (tx) => tx.update(applications).set({ stage: "withdrawn", withdrawnAt: new Date().toISOString() }).where(eq(applications.id, wes.id)));
      const row = await rowOf(wes.id);
      expect(row).toMatchObject({ ownerStage: "not_moving_forward", ownerStageLabel: "Withdrew" });
      const panel = await read<{ ownerStageLabel: string }>(await json(owner, "GET", `/api/v1/applications/${wes.id}`));
      expect(panel.ownerStageLabel).toBe("Withdrew");
    });

    it("a finalist's status page stays at the interview they had, in words that hint at nothing", async () => {
      const fay = await apply("Fay", "Finalist");
      const [applied] = await container.db.select().from(applications).where(eq(applications.id, fay.id));
      await withPlatform(container.db, (tx) => tx.update(applications).set({ stage: "finalist" }).where(eq(applications.id, fay.id)));
      const page = await (await app.request(`/c/status/${applied.statusToken}`)).text();
      expect(page).toMatch(/<span>Status<\/span><strong>Interview<\/strong>/);
      expect(page).toContain("Thanks for interviewing. The team is deciding, and you will hear from them either way.");
      expect(page).not.toMatch(/finalist/i);
      // and the stage menu says the way to an offer from where they are, in plain words
      const row = await rowOf(fay.id);
      expect(row.stageMoves.find((m) => m.to === "offer")).toMatchObject({ allowed: true });
    });
  });

  describe("rank 20: the word pass", () => {
    it("a quiet day promises nothing about emails and judges nobody; the long-wait nudge offers only what the team can choose", async () => {
      expect(QUIET_DAY_LINE).toBe("New applicants, and anything that waits on you, show up here.");
      // someone ready for the team's decision, waiting five days
      const tia = await apply("Tia", "Waiting");
      await container.db.update(applications).set({ stage: "triaged" }).where(eq(applications.id, tia.id));
      const detections = await withTenant(container.db, companyId, (tx) => detectStuckRoles(tx, companyId, new Date(Date.now() + 5 * DAY)));
      const waiting = detections.find((d) => d.detector === "candidates_waiting" && d.body.startsWith("They are ready for a decision"));
      expect(waiting?.body).toBe("They are ready for a decision: shortlist them, set a date and time for an interview, decide after an interview, or decline with a reason. Candidates who wait more than a week usually move on.");
      expect(JSON.stringify(detections)).not.toContain("invite to an AI interview");
    });
  });

  describe("rank 10: the waiting room's ending", () => {
    it("gives up saying it is taking longer than it should, and never that the link is already in their email", () => {
      expect(WAIT_GAVE_UP_LINE).toBe("This is taking longer than it should.");
      expect(WAIT_GAVE_UP_MORE).toBe("Press Start my interview again in a few minutes. The link we email you opens it too.");
      expect(APPLY_WAIT_JS).toContain(JSON.stringify(WAIT_GAVE_UP_LINE));
      expect(APPLY_WAIT_JS).toContain("line.textContent=WAIT_GAVE_UP_LINE;");
      expect(APPLY_WAIT_JS).not.toContain("is in your email");
      // still one script that a browser can read
      expect(() => new Function(APPLY_WAIT_JS)).not.toThrow();
    });
  });

  describe("rank 16: the failure notice, and ITS when the provider refuses", () => {
    const fake = () => container.integrations.email as FakeEmailAdapter;
    /** Queues one email to this applicant through the outbox, with the provider answering `answer`, and runs the worker. */
    const sendRefused = async (cand: { id: string; candidateId: string; email: string }, key: string, answer: SendResult) => {
      const adapter = fake();
      adapter.send = async () => answer;
      try {
        await withTenant(container.db, companyId, (tx) => queueCommunication(tx, container.integrations, { channel: "email", companyId, candidateId: cand.candidateId, applicationId: cand.id, to: cand.email, from: "Harbor Dental <updates@test.localhost>", subject: "Your next step: a short AI interview", text: "Hello", templateKey: "screen_invite", idempotencyKey: key, actor: { kind: "system", id: "dead_ends_test" } }));
        await container.drain();
      } finally {
        Reflect.deleteProperty(adapter, "send");
      }
      return (await container.db.select().from(communications).where(eq(communications.idempotencyKey, key)))[0];
    };
    const refusals = () => container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, PROVIDER_REFUSED_ALERT));

    it("the team's notice names the person in plain words, never the provider's error, and opens that candidate", async () => {
      const gil = await apply("Gil", "Notice");
      const row = await sendRefused(gil, `refused:${gil.id}`, { status: "failed", error: "postmark 422: The 'From' address you supplied (x) is not a Sender Signature on your account.", retryable: false });
      expect(row.status).toBe("failed");
      const [note] = await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "candidate.unreachable"), eq(notifications.title, "An email to Gil Notice did not arrive"))).orderBy(desc(notifications.createdAt)).limit(1);
      expect(note.body).toBe('"Your next step: a short AI interview" could not be delivered. Phone them, or write to them another way.');
      expect(note.body).not.toMatch(/postmark|422|Sender Signature/);
      expect(note.action).toEqual({ label: "Open Gil Notice", href: `/roles/${roleId}/talent?open=${gil.id}` });
    });

    it("a refusal that is not about one address alerts ITS once while it lasts; one about the address alerts nobody", async () => {
      await container.db.delete(adminAlerts).where(eq(adminAlerts.kind, PROVIDER_REFUSED_ALERT));
      const hal = await apply("Hal", "Refused");
      const ida = await apply("Ida", "Refused");
      await sendRefused(hal, `refused:${hal.id}`, { status: "failed", error: "postmark 412: Your account is pending approval.", retryable: false });
      const [alert] = await refusals();
      expect(alert).toMatchObject({ severity: "high", companyId, title: "The email provider is refusing emails", target: { type: "integration" } });
      expect(alert.body).toContain("postmark 412: Your account is pending approval.");
      // the next refused email in the hour adds nothing to the console
      await sendRefused(ida, `refused:${ida.id}`, { status: "failed", error: "postmark 412: Your account is pending approval.", retryable: false });
      expect(await refusals()).toHaveLength(1);
      // a refusal about one address: that person's problem, not the provider's, and no alert
      await container.db.delete(adminAlerts).where(eq(adminAlerts.kind, PROVIDER_REFUSED_ALERT));
      const jo = await apply("Jo", "Inactive");
      const row = await sendRefused(jo, `refused:${jo.id}`, { status: "failed", error: "postmark 406: You tried to send to recipient(s) that have been marked as inactive.", retryable: false, aboutAddress: true });
      expect(row.status).toBe("failed");
      expect(await refusals()).toEqual([]);
      expect(await container.db.select().from(adminAlerts).where(and(eq(adminAlerts.kind, "message.delivery_failed"), eq(adminAlerts.companyId, companyId)))).toEqual([]);
    });
  });
});
