import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { NOTE_VERSION_SITTING_MINUTES, type HireFollowUp, type InterviewDraft, type NoteView, type NotesView, type OfferMadeResult } from "@ros/contracts";
import { addCalendarDays, anonymizeCandidate, buildEscalationContext, companyToday, entitlements, exportCandidateData } from "@ros/core";
import { composeInterviewerBrief, loadApplicationBundle, prepareScreenOpening } from "@ros/agents";
import type { FakeProvider, StructuredRequest } from "@ros/ai";
import { applicationNotes, applications, approvalRequests, auditRecords, candidates, documents, events, hiringOutcomes, interviewParticipants, interviews, offers, randomToken, rolePackets, users, withTenant } from "@ros/db";
import type { FakeEmailAdapter, MemoryStorageAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { composeBrief } from "./services/brief";
import { backupsWarmCards, hireFollowUp } from "./services/hire-sheet";
import { signInAs, signInStaff } from "./test-helpers";

const DAY = 86_400_000;

/**
 * Interviews to hire (plan Wave H): the record-only "Offer made" and its answer (H2, founder decision Q29), the hire
 * sheet with the backups to keep warm and closing the role (H1), the private team notes (H3, Q24) and who may read and
 * write them, their absence from the candidate's pages, the privacy export and every AI prompt, the interview approval
 * card filled in from a suggestion (H4), and the résumé shown inside the panel (H5).
 */
describe("interviews to hire: offer made, hire sheet, team notes, one-step interview, résumé in the panel", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerId = "";
  let hm = "";
  let hr = "";
  let ivA = "";
  let ivAId = "";
  let ivB = "";
  let ownerB = "";
  let companyId = "";
  let companyB = "";
  let roleId = "";
  let roleTitle = "";
  let plan: Array<{ key: string; title: string; format: string; durationMinutes: number }> = [];
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    return (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
  };
  const userId = async (email: string) => (await container.db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0].id;
  const seed = (first: string, stage: (typeof applications.$inferInsert)["stage"]) =>
    withTenant(container.db, companyId, async (tx) => {
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: first, lastName: "Example", email: `${first.toLowerCase()}@hire.example`, firstSource: "direct" }).returning();
      const [a] = await tx.insert(applications).values({ companyId, roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage, statusToken: randomToken(16) }).returning();
      return a;
    });
  const interviewFor = (applicationId: string, userIds: string[], input: { status: string; startsAt: string; round?: number; decisionNote?: string }) =>
    withTenant(container.db, companyId, async (tx) => {
      const round = plan[input.round ?? 0];
      const [iv] = await tx.insert(interviews).values({ companyId, applicationId, roundKey: round.key, title: round.title, format: round.format, durationMinutes: round.durationMinutes, status: input.status, startsAt: input.startsAt, endsAt: new Date(Date.parse(input.startsAt) + round.durationMinutes * 60_000).toISOString(), timezone: "America/Los_Angeles", decisionNote: input.decisionNote ?? null }).returning();
      for (const u of userIds) await tx.insert(interviewParticipants).values({ companyId, interviewId: iv.id, userId: u });
      return iv.id;
    });
  const stageOf = async (id: string) => (await container.db.select({ stage: applications.stage }).from(applications).where(eq(applications.id, id)))[0].stage;
  const today = () => companyToday(new Date(), "America/Los_Angeles");
  const outbox = () => (container.integrations.email as FakeEmailAdapter).sent;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    owner = await signIn("owner@hire.test");
    ownerId = await userId("owner@hire.test");
    await container.db.update(users).set({ name: "Olivia Owner" }).where(eq(users.id, ownerId));
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Harbor Dental", vertical: "dental", sizeBand: "20-49", timezone: "America/Los_Angeles", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    companyId = co.id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, 1)));
    plan = pv.packet.interviews.plan.map((r) => ({ key: r.key, title: r.title, format: r.format, durationMinutes: r.durationMinutes }));
    roleTitle = pv.packet.identity.title;
    expect(plan.length, "the next-round draft needs a plan with two rounds").toBeGreaterThanOrEqual(2);
    hm = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hm@hire.test", name: "Hana Manager" });
    hr = await signInAs(container, app, { companyId, role: "hr", email: "hr@hire.test", name: "Hugo People" });
    ivA = await signInAs(container, app, { companyId, role: "interviewer", email: "iva@hire.test", name: "Ida Interviewer" });
    ivAId = await userId("iva@hire.test");
    ivB = await signInAs(container, app, { companyId, role: "interviewer", email: "ivb@hire.test", name: "Ivo Interviewer" });
    ownerB = await signIn("owner@other-hire.test");
    companyB = ((await (await json(ownerB, "POST", "/api/v1/companies", { name: "Other Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Tustin", region: "CA", country: "US" }] })).json()) as { id: string }).id;
  });
  afterAll(async () => {
    await container.close();
  });

  describe("Offer made (plan H2, founder decision Q29)", () => {
    it("records an offer made outside the app for a finalist, privately, and then waits on the candidate", async () => {
      const ana = await seed("Ana", "finalist");
      const early = await seed("Bea", "triaged");
      const sentBefore = outbox().filter((m) => m.to === "ana@hire.example").length;
      // only those who record outcomes, only with a confirmation, only from a finalist, never a date still to come
      expect((await json(ivA, "POST", `/api/v1/applications/${ana.id}/offer`, { confirm: true })).status).toBe(403);
      expect((await json(owner, "POST", `/api/v1/applications/${ana.id}/offer`, {})).status).toBe(400);
      expect((await json(owner, "POST", `/api/v1/applications/${ana.id}/offer`, { confirm: true, terms: { salary: 1 } })).status).toBe(400);
      const tooEarly = await json(owner, "POST", `/api/v1/applications/${early.id}/offer`, { confirm: true });
      expect(tooEarly.status).toBe(409);
      expect(((await tooEarly.json()) as { error: { message: string } }).error.message).toMatch(/once they are a finalist/);
      expect((await json(owner, "POST", `/api/v1/applications/${ana.id}/offer`, { confirm: true, madeOn: addCalendarDays(today(), 3) })).status).toBe(400);
      const madeOn = addCalendarDays(today(), -1);
      const r = await json(hm, "POST", `/api/v1/applications/${ana.id}/offer`, { confirm: true, madeOn, note: "Offered on the phone." });
      expect(r.status).toBe(201);
      const made = (await r.json()) as OfferMadeResult;
      expect(made).toMatchObject({ ok: true, stage: "offer_sent", madeOn, candidateNotice: "not_told" });
      expect(made.statement).toMatch(/did not write, approve or send it/);
      expect(await stageOf(ana.id)).toBe("offer_sent");
      const detail = (await (await json(owner, "GET", `/api/v1/applications/${ana.id}`)).json()) as { group: string; ownerStage: string };
      expect(detail).toMatchObject({ group: "waiting_on_candidate", ownerStage: "offer" });
      // the offers row holds who and when, never a term
      const [row] = await container.db.select().from(offers).where(eq(offers.applicationId, ana.id));
      expect(row).toMatchObject({ id: made.offerId, status: "made", madeOutside: true, madeOn, terms: {} });
      expect(row.sentAt).toBeNull();
      const created = await container.db.select().from(events).where(and(eq(events.subjectId, ana.id), eq(events.type, "offer.created")));
      expect(created[0].payload).toMatchObject({ madeOutside: true, recordedOutsidePlatform: true, madeOn });
      const audits = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "outcome.recorded")));
      expect(audits.some((a) => a.reason === "offer made outside the app" && (a.target as { id: string }).id === ana.id)).toBe(true);
      // nothing was sent to the candidate
      expect(outbox().filter((m) => m.to === "ana@hire.example").length).toBe(sentBefore);
      // the list narrows to who waits on the candidate; a second offer is refused with what to do instead
      const list = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/applications?group=waiting_on_candidate`)).json()) as Array<{ id: string; group: string }>;
      expect(list.map((a) => a.id)).toEqual([ana.id]);
      const again = await json(owner, "POST", `/api/v1/applications/${ana.id}/offer`, { confirm: true });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: { message: string } }).error.message).toMatch(/accepted or declined/);
    });

    it("Declined records the candidate turning the offer down, and the offer says so", async () => {
      const [ana] = await container.db.select().from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(eq(candidates.firstName, "Ana"));
      const r = await json(hr, "POST", `/api/v1/applications/${ana.applications.id}/outcome`, { outcome: "offer_declined_externally", confirm: true, note: "Took another job." });
      expect(r.status).toBe(201);
      expect(((await r.json()) as { stage: string; offer: string }).offer).toBe("declined");
      expect(await stageOf(ana.applications.id)).toBe("declined");
      const [row] = await container.db.select().from(offers).where(eq(offers.applicationId, ana.applications.id));
      expect(row.status).toBe("declined");
      expect(row.respondedAt).toBeTruthy();
      expect((await container.db.select().from(events).where(and(eq(events.subjectId, ana.applications.id), eq(events.type, "offer.declined")))).length).toBe(1);
    });
  });

  describe("the hire sheet (plan H1)", () => {
    let cara = "";
    let startDate = "";
    it("Accepted records the hire with its start date, the backups to keep warm, and closing the role in the same sheet", async () => {
      cara = (await seed("Cara", "finalist")).id;
      expect((await json(owner, "POST", `/api/v1/applications/${cara}/offer`, { confirm: true })).status).toBe(201);
      await seed("Dev", "finalist");
      await seed("Eli", "interview_scheduled");
      const fay = await seed("Fay", "triaged");
      expect((await json(owner, "POST", `/api/v1/applications/${fay.id}/actions`, { action: "set_mark", mark: "shortlist" })).status).toBe(200);
      await seed("Gus", "triaged");
      startDate = addCalendarDays(today(), 14);
      const r = await json(owner, "POST", `/api/v1/applications/${cara}/outcome`, { outcome: "hired_externally", confirm: true, hireDate: startDate, offerAcceptedAt: today() });
      expect(r.status).toBe(201);
      const body = (await r.json()) as { stage: string; offer: string; hire: HireFollowUp; roleStillOpen: boolean };
      expect(body).toMatchObject({ stage: "hired", offer: "accepted", roleStillOpen: true });
      expect(body.hire.startDate).toBe(startDate);
      const names = body.hire.backups.people.map((p) => p.name);
      expect(names).toEqual(expect.arrayContaining(["Dev Example", "Eli Example", "Fay Example"]));
      expect(names).not.toContain("Gus Example");
      expect(names).not.toContain("Cara Example");
      expect(body.hire.backups.people.find((p) => p.name === "Fay Example")?.stageLabel).toBe("Shortlist");
      const active = (await container.db.select({ id: applications.id, stage: applications.stage }).from(applications).where(eq(applications.roleId, roleId))).filter((a) => !["hired", "declined", "rejected", "withdrawn", "talent_pool"].includes(a.stage));
      expect(body.hire.closeRole).toMatchObject({ path: `/api/v1/roles/${roleId}/outcome`, outcome: "filled", stillInProcess: active.length });
      expect(body.hire.closeRole!.words).toMatch(/privately: nobody is told/);
      const [offer] = await container.db.select().from(offers).where(eq(offers.applicationId, cara));
      expect(offer.status).toBe("accepted");
    });

    it("Today keeps a 'keep your backups warm' card until the start date, for those who read applications", async () => {
      const cards = await withTenant(container.db, companyId, (tx) => backupsWarmCards(tx, { companyId, viewer: { role: "owner" }, now: new Date() }));
      const card = cards.find((c) => c.applicationId === cara)!;
      expect(card).toMatchObject({ kind: "hire", roleId, actions: [{ label: "See them", method: "GET", path: `/roles/${roleId}/talent` }] });
      expect(card.title).toBe(`Keep your backups warm until Cara Example starts (${roleTitle})`);
      expect(card.body).toMatch(/Dev Example \(Finalist\)/);
      expect(card.body).toMatch(/hold off telling them a decision/);
      // Today carries it, as the hire sheet promised
      const brief = await withTenant(container.db, companyId, (tx) => composeBrief(tx, companyId, { userId: ownerId, role: "owner" }));
      expect(brief.cards.find((c) => c.kind === "hire" && c.applicationId === cara)?.title).toBe(card.title);
      // keyed on the start date: still there on the day, gone the day after; never for an interviewer
      const onTheDay = new Date(Date.parse(`${startDate}T20:00:00Z`));
      expect((await withTenant(container.db, companyId, (tx) => backupsWarmCards(tx, { companyId, viewer: { role: "owner" }, now: onTheDay }))).find((c) => c.applicationId === cara)?.body).toMatch(/starts today/);
      const after = new Date(Date.parse(`${startDate}T20:00:00Z`) + DAY);
      expect((await withTenant(container.db, companyId, (tx) => backupsWarmCards(tx, { companyId, viewer: { role: "owner" }, now: after }))).find((c) => c.applicationId === cara)).toBeUndefined();
      expect(await withTenant(container.db, companyId, (tx) => backupsWarmCards(tx, { companyId, viewer: { role: "interviewer" }, now: new Date() }))).toEqual([]);
    });

    it("the decision after an interview can be 'hired': the same outcome with its start date, for those who record outcomes", async () => {
      const hal = await seed("Hal", "interview_complete");
      const ivId = await interviewFor(hal.id, [ownerId], { status: "completed", startsAt: new Date(Date.now() - 2 * DAY).toISOString() });
      const noDate = await json(owner, "POST", `/api/v1/applications/${hal.id}/decision`, { decision: "hired" });
      expect(noDate.status).toBe(400);
      expect(((await noDate.json()) as { error: { code: string } }).error.code).toBe("hire_date_required");
      expect((await json(ivA, "POST", `/api/v1/applications/${hal.id}/decision`, { decision: "hired", hireDate: addCalendarDays(today(), 7) })).status).toBe(403);
      const hireDate = addCalendarDays(today(), 7);
      const r = await json(hm, "POST", `/api/v1/applications/${hal.id}/decision`, { decision: "hired", hireDate, note: "Great with patients." });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { stage: string; outcomeId: string; hire: HireFollowUp; statement: string };
      expect(body.stage).toBe("hired");
      expect(body.hire.startDate).toBe(hireDate);
      expect(body.statement).toMatch(/outside Recruiting OS/);
      expect(await stageOf(hal.id)).toBe("hired");
      const [iv] = await container.db.select().from(interviews).where(eq(interviews.id, ivId));
      expect(iv.decision).toBe("hired");
      const [outcome] = await container.db.select().from(hiringOutcomes).where(eq(hiringOutcomes.id, body.outcomeId));
      expect(outcome).toMatchObject({ outcome: "hired_externally", hireDate, applicationId: hal.id });
    });
  });

  describe("private team notes (plan H3, founder decision Q24)", () => {
    let nia = { id: "", candidateId: "", statusToken: "" };
    const notesOf = async (cookie: string, id = nia.id) => {
      const r = await json(cookie, "GET", `/api/v1/applications/${id}/notes`);
      return { status: r.status, body: (r.status === 200 ? await r.json() : null) as NotesView | null };
    };
    const write = (cookie: string, body: Record<string, unknown>, id = nia.id) => json(cookie, "PUT", `/api/v1/applications/${id}/notes/mine`, body);

    it("the hiring team writes and reads private notes: one each, changed only by its author, the old words kept, the facts without the words", async () => {
      nia = await seed("Nia", "finalist");
      const first = await write(owner, { starter: "for_and_against", body: "MARKER-owner: steady hands, unsure about weekends" });
      expect(first.status).toBe(201);
      expect(((await first.json()) as { note: NoteView }).note).toMatchObject({ mine: true, starter: "for_and_against", starterLabel: "For and against", edited: false, author: { userId: ownerId, name: "Olivia Owner" } });
      // the same words again change nothing
      const same = await write(owner, { starter: "for_and_against", body: "MARKER-owner: steady hands, unsure about weekends" });
      expect(same.status).toBe(200);
      expect(((await same.json()) as { changed: boolean }).changed).toBe(false);
      // autosave saves as typing pauses: changes in one sitting make one version, with no earlier version and no new fact
      for (const body of ["MARKER-owner: steady hands, unsure", "MARKER-owner: steady hands, unsure about weekends."]) {
        const typing = await write(owner, { starter: "for_and_against", body });
        expect(((await typing.json()) as { note: NoteView; changed: boolean })).toMatchObject({ changed: true, note: { edited: false, previousVersions: [] } });
      }
      // after a pause, new words change the note and keep the ones they replaced
      const mine = and(eq(applicationNotes.applicationId, nia.id), eq(applicationNotes.authorUserId, ownerId));
      await container.db.update(applicationNotes).set({ updatedAt: new Date(Date.now() - (NOTE_VERSION_SITTING_MINUTES + 1) * 60_000).toISOString() }).where(mine);
      const edited = await write(owner, { starter: "for_and_against", body: "MARKER-owner: steady hands; weekends are fine" });
      expect(((await edited.json()) as { note: NoteView; changed: boolean })).toMatchObject({ changed: true, note: { edited: true, previousVersions: [{ body: "MARKER-owner: steady hands, unsure about weekends.", starter: "for_and_against" }] } });
      const [row] = await container.db.select().from(applicationNotes).where(mine);
      expect(row.previousVersions.map((v) => v.body)).toEqual(["MARKER-owner: steady hands, unsure about weekends."]);
      expect((await write(owner, { body: "" })).status).toBe(400);
      expect((await write(owner, { body: "x", starter: "secret" })).status).toBe(400);
      // the hiring manager and HR read every note and write their own; nobody can change someone else's
      const seenByHm = await notesOf(hm);
      expect(seenByHm.body).toMatchObject({ canRead: "all", canWrite: true, mine: null, privacy: expect.stringMatching(/never sees notes/) });
      expect(seenByHm.body!.notes.map((n) => n.body)).toEqual(["MARKER-owner: steady hands; weekends are fine"]);
      // earlier versions go only to the note's author
      expect(seenByHm.body!.notes[0].previousVersions).toBeUndefined();
      expect(seenByHm.body!.starters.map((s) => s.id)).toEqual(["before_interview", "after_interview", "for_and_against"]);
      expect((await write(hm, { starter: "before_interview", body: "MARKER-hm: ask about the Saturday shift" })).status).toBe(201);
      expect((await write(hr, { body: "MARKER-hr: references to call" })).status).toBe(201);
      const seenByOwner = (await notesOf(owner)).body!;
      expect(seenByOwner.notes.map((n) => [n.author.name, n.mine])).toEqual([["Olivia Owner", true], ["Hana Manager", false], ["Hugo People", false]]);
      expect(seenByOwner.mine?.body).toBe("MARKER-owner: steady hands; weekends are fine");
      expect((await container.db.select().from(applicationNotes).where(eq(applicationNotes.applicationId, nia.id))).length).toBe(3);
      // the facts say who wrote or changed a note, never what it says
      const facts = await container.db.select().from(events).where(and(eq(events.subjectId, nia.id), inArray(events.type, ["note.added", "note.updated"])));
      expect(facts.map((e) => e.type).sort()).toEqual(["note.added", "note.added", "note.added", "note.updated"]);
      expect(JSON.stringify(facts)).not.toContain("MARKER");
      expect(facts.find((e) => e.type === "note.updated")!.payload).toMatchObject({ noteId: row.id, version: 2 });
    });

    it("an interviewer writes only their own note on someone they interviewed, once the interview started, and reads nobody else's", async () => {
      // not on any interview: nothing at all
      expect((await notesOf(ivA)).status).toBe(403);
      expect((await write(ivA, { body: "MARKER-iv: early" })).status).toBe(403);
      // on an interview still to come: their own (none yet), and not yet a note
      const ivId = await interviewFor(nia.id, [ivAId], { status: "scheduled", startsAt: new Date(Date.now() + 2 * DAY).toISOString() });
      const before = (await notesOf(ivA)).body!;
      expect(before).toMatchObject({ canRead: "own", notes: [], mine: null, canWrite: false });
      expect(before.writeBlockedReason).toMatch(/once the interview has started/);
      expect((await write(ivA, { body: "MARKER-iv: early" })).status).toBe(403);
      // once it took place they write their own after-interview note, and still read only that one
      await container.db.update(interviews).set({ status: "completed", startsAt: new Date(Date.now() - DAY).toISOString() }).where(eq(interviews.id, ivId));
      expect((await write(ivA, { starter: "after_interview", body: "MARKER-iv: calm and thorough" })).status).toBe(201);
      const own = (await notesOf(ivA)).body!;
      expect(own.notes.map((n) => n.body)).toEqual(["MARKER-iv: calm and thorough"]);
      expect(JSON.stringify(own)).not.toMatch(/MARKER-(owner|hm|hr)/);
      // their view of the candidate carries their own note and nothing else of the team's
      const view = await (await json(ivA, "GET", `/api/v1/applications/${nia.id}`)).text();
      expect(JSON.parse(view)).toMatchObject({ viewer: "interviewer", myNote: { body: "MARKER-iv: calm and thorough", starter: "after_interview" }, mayWriteNote: true });
      expect(view).not.toMatch(/MARKER-(owner|hm|hr)/);
      // another interviewer who was not on it reads and writes nothing; the team sees the interviewer's note
      expect((await notesOf(ivB)).status).toBe(403);
      expect((await write(ivB, { body: "MARKER-ivb" })).status).toBe(403);
      expect((await notesOf(owner)).body!.notes.map((n) => n.body)).toContain("MARKER-iv: calm and thorough");
    });

    it("notes stay inside the company: another company's owner reaches none, and row-level security keeps them out of its transactions", async () => {
      expect((await json(ownerB, "GET", `/api/v1/applications/${nia.id}/notes`)).status).toBe(404);
      expect((await json(ownerB, "PUT", `/api/v1/applications/${nia.id}/notes/mine`, { body: "MARKER-b" })).status).toBe(404);
      expect(await withTenant(container.db, companyB, (tx) => tx.select().from(applicationNotes))).toEqual([]);
      expect((await withTenant(container.db, companyId, (tx) => tx.select().from(applicationNotes).where(eq(applicationNotes.applicationId, nia.id)))).length).toBe(4);
    });

    it("Compare shows the team's notes on each person to those who read notes", async () => {
      const ola = await seed("Ola", "finalist");
      const r = await json(hr, "GET", `/api/v1/roles/${roleId}/compare?ids=${nia.id},${ola.id}`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { candidates: Array<{ applicationId: string; notes: NoteView[] }> };
      expect(body.candidates.map((c) => c.notes.length)).toEqual([4, 0]);
      expect(body.candidates[0].notes.find((n) => n.author.name === "Ida Interviewer")?.starterLabel).toBe("After the interview");
    });

    it("removing a note keeps the record, and its author can write a new one", async () => {
      const r = await json(hm, "DELETE", `/api/v1/applications/${nia.id}/notes/mine`);
      expect(r.status).toBe(200);
      expect((await notesOf(owner)).body!.notes.map((n) => n.author.name)).not.toContain("Hana Manager");
      expect((await json(hm, "DELETE", `/api/v1/applications/${nia.id}/notes/mine`)).status).toBe(404);
      const removed = await container.db.select().from(events).where(and(eq(events.subjectId, nia.id), eq(events.type, "note.updated")));
      expect(removed.some((e) => (e.payload as { removed?: boolean }).removed === true)).toBe(true);
      expect((await write(hm, { body: "MARKER-hm: second thoughts" })).status).toBe(201);
      expect((await container.db.select().from(applicationNotes).where(eq(applicationNotes.applicationId, nia.id))).length).toBe(5);
    });

    it("notes never reach an AI prompt: no prompt builder reads them, and the context the assistant is given leaves them out", async () => {
      // nothing in the AI and agent packages reads the notes table, so no prompt can carry a note
      const root = fileURLToPath(new URL("../../../packages/", import.meta.url));
      const sources: string[] = [];
      const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f)) sources.push(p); } };
      walk(join(root, "ai", "src"));
      walk(join(root, "agents", "src"));
      expect(sources.length).toBeGreaterThan(10);
      for (const file of sources) expect(readFileSync(file, "utf8"), file).not.toMatch(/application_notes|applicationNotes/);
      // and the context the assistant is handed for this candidate, or the recruiter's copy, has none of the words
      const provider = container.ai.provider as FakeProvider;
      const original = provider.structured.bind(provider);
      const prompts: string[] = [];
      const recording = async (req: StructuredRequest<unknown>, model: string) => { prompts.push(JSON.stringify({ system: req.system, messages: req.messages, inputRef: req.inputRef })); return original(req, model); };
      provider.structured = recording as FakeProvider["structured"];
      try {
        await prepareScreenOpening(container.db, container.ai, { companyId, applicationId: nia.id, channel: "sms" });
        expect((await json(owner, "POST", `/api/v1/applications/${nia.id}/messages/suggest`, { purpose: "update" })).status).toBe(200);
      } finally {
        provider.structured = original;
      }
      expect(prompts.length).toBeGreaterThanOrEqual(2);
      for (const p of prompts) expect(p).not.toContain("MARKER");
      const context = await withTenant(container.db, companyId, async (tx) => ({
        bundle: await loadApplicationBundle(tx, nia.id),
        brief: await composeInterviewerBrief(tx, { applicationId: nia.id, candidateFirstName: "Nia", packet: (await tx.select().from(rolePackets).where(eq(rolePackets.roleId, roleId)))[0].packet, roundKey: plan[0].key }),
        recruiter: await buildEscalationContext(tx, companyId, roleId, nia.id),
      }));
      expect(context.bundle).toBeTruthy();
      expect(JSON.stringify(context)).not.toContain("MARKER");
    });

    it("an ITS recruiter reads and writes notes while a grant gives them the candidate, and on no other candidate", async () => {
      const uma = await seed("Uma", "finalist");
      expect((await write(owner, { body: "MARKER-owner: Uma has two offers elsewhere" }, uma.id)).status).toBe(201);
      const recruiter = await signInStaff(app, container, "rae@its.test", "its_recruiter", "Rae Recruiter");
      const esc = (await (await json(owner, "POST", "/api/v1/escalations", { kind: "review", applicationId: uma.id, question: "Could you look at this finalist?" })).json()) as { id: string };
      expect((await json(recruiter, "POST", `/api/v1/escalations/${esc.id}/claim`)).status).toBe(200);
      expect((await json(recruiter, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
      const seen = (await notesOf(recruiter, uma.id)).body!;
      expect(seen).toMatchObject({ canRead: "all", canWrite: true });
      expect(seen.notes.map((n) => n.body)).toEqual(["MARKER-owner: Uma has two offers elsewhere"]);
      expect((await write(recruiter, { body: "MARKER-its: references are strong" }, uma.id)).status).toBe(201);
      // the team sees it among its notes, said to be the ITS recruiter's
      expect((await notesOf(owner, uma.id)).body!.notes.map((n) => [n.author.name, n.body])).toEqual([["Olivia Owner", "MARKER-owner: Uma has two offers elsewhere"], ["ITS recruiter", "MARKER-its: references are strong"]]);
      const added = await container.db.select().from(events).where(and(eq(events.subjectId, uma.id), eq(events.type, "note.added")));
      expect(added.map((e) => e.actor.kind).sort()).toEqual(["recruiter", "user"]);
      // the grant names one candidate: every other candidate's notes stay out of reach
      expect((await notesOf(recruiter, nia.id)).status).toBe(403);
      expect((await write(recruiter, { body: "MARKER-its: elsewhere" }, nia.id)).status).toBe(403);
    });

    it("notes never reach the candidate: not on the status page, not in a privacy export; a deletion empties them", async () => {
      const page = await (await app.request(`/c/status/${nia.statusToken}`)).text();
      expect(page).toContain("Your application");
      expect(page).not.toContain("MARKER");
      expect(JSON.stringify(await exportCandidateData(container.db, companyId, nia.candidateId))).not.toContain("MARKER");
      await container.db.update(interviews).set({ decision: "finalist", decisionNote: "MARKER-decision: strongest so far" }).where(eq(interviews.applicationId, nia.id));
      await anonymizeCandidate(container.db, { companyId, candidateId: nia.candidateId, actor: { kind: "user", id: "admin" }, deleteFile: async () => {} });
      const rows = await container.db.select().from(applicationNotes).where(eq(applicationNotes.applicationId, nia.id));
      expect(rows.length).toBe(5);
      for (const n of rows) expect(n).toMatchObject({ body: "", previousVersions: [] });
      expect(rows.every((n) => !!n.deletedAt)).toBe(true);
      expect((await container.db.select({ note: interviews.decisionNote }).from(interviews).where(eq(interviews.applicationId, nia.id))).every((i) => i.note === null)).toBe(true);
    });
  });

  describe("one-step interview from a suggestion (plan H4)", () => {
    it("fills in the interview approval card: the next round of the plan, its interviewers who are still members, the scheduling window", async () => {
      const ivy = await seed("Ivy", "screen_complete");
      const r = await json(owner, "GET", `/api/v1/applications/${ivy.id}/interview-draft`);
      expect(r.status).toBe(200);
      const draft = (await r.json()) as InterviewDraft;
      expect(draft).toMatchObject({ applicationId: ivy.id, roleId, roundKey: plan[0].key, roundTitle: plan[0].title, linkSource: "calendar", requestPath: `/api/v1/applications/${ivy.id}/interviews`, nextRound: false });
      expect(draft.window.fromDate).toBeTruthy();
      const members = new Set((await container.db.select({ id: users.id }).from(users)).map((u) => u.id));
      expect(draft.interviewerUserIds.every((id) => members.has(id))).toBe(true);
      // after the first round, the next one
      await interviewFor(ivy.id, [ownerId], { status: "completed", startsAt: new Date(Date.now() - DAY).toISOString() });
      expect(((await (await json(owner, "GET", `/api/v1/applications/${ivy.id}/interview-draft`)).json()) as InterviewDraft)).toMatchObject({ roundKey: plan[1].key, nextRound: true });
      expect((await json(ivA, "GET", `/api/v1/applications/${ivy.id}/interview-draft`)).status).toBe(403);
    });

    it("'Yes, interview' approves the assistant's suggestion and answers the card filled in; posting it is the one approval", async () => {
      const jo = await seed("Jo", "screen_complete");
      const suggest = () => withTenant(container.db, companyId, async (tx) => (await tx.insert(approvalRequests).values({ companyId, roleId, applicationId: jo.id, actionType: "application.recommend_interview", subject: { type: "application", id: jo.id }, proposal: {}, requestedBy: { kind: "agent", id: "screening" }, requiredRoles: [] }).returning())[0].id);
      const notNow = await suggest();
      const declined = (await (await json(owner, "POST", `/api/v1/approvals/${notNow}/decide`, { decision: "reject", note: "Not now" })).json()) as Record<string, unknown>;
      expect(declined.interviewDraft).toBeUndefined();
      const yes = await suggest();
      const r = await json(owner, "POST", `/api/v1/approvals/${yes}/decide`, { decision: "approve" });
      expect(r.status).toBe(200);
      const { interviewDraft } = (await r.json()) as { interviewDraft: InterviewDraft };
      expect(interviewDraft).toMatchObject({ applicationId: jo.id, roundKey: plan[0].key, requestPath: `/api/v1/applications/${jo.id}/interviews` });
      expect(await stageOf(jo.id)).toBe("interview_recommended");
      const booked = await json(owner, "POST", interviewDraft.requestPath, { roundKey: interviewDraft.roundKey, interviewerUserIds: [ownerId], linkSource: interviewDraft.linkSource, window: interviewDraft.window });
      expect(booked.status).toBe(201);
      // with that interview being set up there is nothing more to fill in, and a decided candidate gets no card at all
      const open = await json(owner, "GET", `/api/v1/applications/${jo.id}/interview-draft`);
      expect(open.status).toBe(409);
      expect(((await open.json()) as { error: { code: string } }).error.code).toBe("interview_open");
      const gone = await seed("Kit", "rejected");
      expect((await json(owner, "GET", `/api/v1/applications/${gone.id}/interview-draft`)).status).toBe(409);
    });
  });

  describe("the résumé inside the panel (plan H5)", () => {
    const storage = () => container.integrations.storage as MemoryStorageAdapter;
    const addDocument = (applicationId: string, candidateId: string, input: { filename: string; mime: string; bytes: Uint8Array; text: string | null; status?: string }) =>
      withTenant(container.db, companyId, async (tx) => {
        const key = `${companyId}/${candidateId}/${applicationId}/${randomToken(8)}`;
        await storage().put(key, input.bytes, input.mime);
        const [d] = await tx.insert(documents).values({ companyId, candidateId, applicationId, kind: "resume", filename: input.filename, mime: input.mime, sizeBytes: input.bytes.byteLength, storageKey: key, sha256: "0".repeat(64), textExtracted: input.text, status: input.status ?? "clean" }).returning();
        return d.id;
      });
    const pdfBytes = new Uint8Array(readFileSync(new URL("../../../packages/agents/src/fixtures/resume.pdf", import.meta.url)));

    it("a PDF comes back as itself from this origin, inline, never cached, framed only by the app, and the read is audited", async () => {
      const pia = await seed("Pia", "triaged");
      const docId = await addDocument(pia.id, pia.candidateId, { filename: "Pia Résumé.pdf", mime: "application/pdf", bytes: pdfBytes, text: "Pia Example, Registered Dental Hygienist" });
      const r = await app.request(`/api/v1/applications/${pia.id}/documents/${docId}/inline`, { headers: { cookie: owner } });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("application/pdf");
      expect(r.headers.get("content-disposition")).toBe('inline; filename="Pia R_sum_.pdf"');
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      expect(r.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
      expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(pdfBytes);
      const reads = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "document.read")));
      expect(reads.some((a) => (a.target as { id: string }).id === docId && (a.details as { view?: string }).view === "inline")).toBe(true);
      // the text of the same file, for a reader that wants words
      const text = await app.request(`/api/v1/applications/${pia.id}/documents/${docId}/inline?as=text`, { headers: { cookie: owner } });
      expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(text.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'self'");
      expect(await text.text()).toBe("Pia Example, Registered Dental Hygienist");
      // nobody else: signed out, an interviewer, another company
      expect((await app.request(`/api/v1/applications/${pia.id}/documents/${docId}/inline`)).status).toBe(401);
      expect((await app.request(`/api/v1/applications/${pia.id}/documents/${docId}/inline`, { headers: { cookie: ivA } })).status).toBe(403);
      expect((await app.request(`/api/v1/applications/${pia.id}/documents/${docId}/inline`, { headers: { cookie: ownerB } })).status).toBe(404);
    });

    it("a Word file falls back to its extracted text; a file still being checked, or with no text, is refused with what to do", async () => {
      const quinn = await seed("Quinn", "triaged");
      const docx = await addDocument(quinn.id, quinn.candidateId, { filename: "quinn.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: new Uint8Array([0x50, 0x4b, 3, 4]), text: "Quinn Example\nHygienist, 4 years" });
      const r = await app.request(`/api/v1/applications/${quinn.id}/documents/${docx}/inline`, { headers: { cookie: owner } });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(r.headers.get("content-disposition")).toBe('inline; filename="quinn.txt"');
      expect(await r.text()).toBe("Quinn Example\nHygienist, 4 years");
      const unread = await addDocument(quinn.id, quinn.candidateId, { filename: "scan.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: new Uint8Array([0x50, 0x4b, 3, 4]), text: null });
      const none = await app.request(`/api/v1/applications/${quinn.id}/documents/${unread}/inline`, { headers: { cookie: owner } });
      expect(none.status).toBe(409);
      expect(((await none.json()) as { error: { message: string } }).error.message).toMatch(/Open it in a new tab/);
      const held = await addDocument(quinn.id, quinn.candidateId, { filename: "new.pdf", mime: "application/pdf", bytes: pdfBytes, text: null, status: "quarantined" });
      expect((await app.request(`/api/v1/applications/${quinn.id}/documents/${held}/inline`, { headers: { cookie: owner } })).status).toBe(409);
    });
  });

  describe("closing the role from the hire sheet (plan H1)", () => {
    it("closes the role as filled; the people still in process move to the talent pool privately, and the sheet no longer offers the close", async () => {
      const r = await json(owner, "POST", `/api/v1/roles/${roleId}/outcome`, { outcome: "filled", confirm: true });
      expect(r.status).toBe(200);
      const [cara] = await container.db.select({ id: applications.id }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(eq(candidates.firstName, "Cara"));
      const after = await withTenant(container.db, companyId, (tx) => hireFollowUp(tx, { roleId, hiredApplicationId: cara.id, startDate: null, role: "owner" }));
      expect(after.closeRole).toBeNull();
      expect(after.backups.count).toBe(0);
      expect((await withTenant(container.db, companyId, (tx) => backupsWarmCards(tx, { companyId, viewer: { role: "owner" }, now: new Date() }))).find((c) => c.applicationId === cara.id)).toBeUndefined();
    });
  });
});
