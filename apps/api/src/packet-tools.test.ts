import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { packetFingerprint, storeDraftPacket } from "@ros/agents";
import { entitlements } from "@ros/core";
import type { DraftRolePacket, IntakeSessionView, JobPreview, PacketDiff, PacketRevisionProposal, RequirementsCheck, RolePacket } from "@ros/contracts";
import { aiRuns, companies, events, rolePackets } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { putOnInterview, signInAs, useLaterApplyFlow, useOneVisitApplyFlow } from "./test-helpers";

/**
 * The job builder's packet tools (plan Wave C): change by chat with a confirmation before anything is saved (C10), the
 * version diff, the requirements check with one-tap fixes (C16), the plain-field editor (C11) and the candidate-view
 * preview (C9), for a draft before the role exists and for a saved role.
 */
describe("packet tools: change by chat, diff, requirements check, plain fields, preview", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerId = "";
  let manager = "";
  let managerId = "";
  let interviewer = "";
  let interviewerId = "";
  let companyId = "";
  let draftId = "";
  let roleId = "";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const read = async <T>(r: Response): Promise<T> => (await r.json()) as T;
  const errorOf = async (r: Response) => (await read<{ error: { code: string; message: string } }>(r)).error;
  const session = async (id: string) => (await read<{ session: IntakeSessionView }>(await json(owner, "GET", `/api/v1/intake/sessions/${id}`))).session;
  const versions = async () => read<Array<{ version: number; status: string; source: string; changeSummary: string; createdBy: { id: string }; packet: RolePacket }>>(await json(owner, "GET", `/api/v1/roles/${roleId}/packets`));
  const newest = async () => (await versions())[0];
  const meId = async (cookie: string) => (await read<{ user: { id: string } }>(await json(cookie, "GET", "/api/v1/auth/me"))).user.id;
  const MESSAGE = "I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@tools.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    companyId = (await read<{ id: string }>(await json(owner, "POST", "/api/v1/companies", { name: "Harbor Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] }))).id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    ownerId = await meId(owner);
    manager = await signInAs(container, app, { companyId, role: "hiring_manager", name: "Hank Manager" });
    managerId = await meId(manager);
    interviewer = await signInAs(container, app, { companyId, role: "interviewer", name: "Ivy Interviewer" });
    interviewerId = await meId(interviewer);
  });
  afterAll(async () => {
    await container.close();
  });

  describe("on a draft, before the role exists", () => {
    it("a draft has nothing to preview, check or change until it is written; then the preview shows the candidate's view (C9)", async () => {
      draftId = (await read<{ session: IntakeSessionView }>(await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: MESSAGE }))).session.id;
      const early = await json(owner, "GET", `/api/v1/intake/sessions/${draftId}/preview`);
      expect(early.status).toBe(409);
      expect((await errorOf(early)).code).toBe("no_draft");
      expect((await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/draft`)).status).toBe(200);
      const preview = await read<JobPreview>(await json(owner, "GET", `/api/v1/intake/sessions/${draftId}/preview`));
      expect(preview.source).toEqual({ kind: "draft", sessionId: draftId });
      expect(preview).toMatchObject({ notPublicYet: true, company: { name: "Harbor Dental", verified: true }, pay: { shown: true, text: "$45–$55 an hour", requiredByLaw: true } });
      expect(preview.banner).toMatch(/Nothing is public until the role is approved/);
      expect(preview.job.facts.map((f) => f.key)).toEqual(["location", "workplace", "job_type", "pay"]);
      // a new role follows the company's flow: "form now, conversation later" until ITS switches the pilot on (plan E8, B1)
      expect(preview.job.steps[0]).toBe("Send a short form, about 3 minutes. We confirm by email.");
      expect(preview.job.steps[1]).toMatch(/^Possibly a short written conversation with Harbor Dental's AI assistant \((online|by text or online), about \d+ minutes\)\. If so, we email you the link\.$/);
      // a pilot company: the conversation in the same visit as the form, counted in the time
      await useOneVisitApplyFlow(container, companyId);
      const pilot = await read<JobPreview>(await json(owner, "GET", `/api/v1/intake/sessions/${draftId}/preview`));
      expect(pilot.job.steps[0]).toMatch(/^Apply in about \d+ minutes, including a short written conversation with Harbor Dental's AI assistant\. We confirm by email\.$/);
      expect(pilot.job.steps[1]).toMatch(/^The conversation: \d+ questions, about \d+ minutes\./);
      await useLaterApplyFlow(container, companyId);
      expect(preview.job.notices.map((n) => n.key)).toEqual(["ai_use", "pay_transparency"]);
      expect(preview.apply.questions.map((q) => q.key)).toEqual(expect.arrayContaining(["rdh_license", "schedule"]));
      // the same blocks as the job page (plan D10): the must-haves' words, never why each matters; no approved company text yet
      expect(preview.job.mustHaves.length).toBeGreaterThan(0);
      expect(preview.job.mustHaves.every((m) => typeof m === "string" && m.length > 0)).toBe(true);
      expect(Array.isArray(preview.job.niceToHaves)).toBe(true);
      expect(preview.company.about).toBeNull();
      expect(preview.gaps).toEqual([]);
      // the draft is the person's own: a hiring manager and an interviewer are refused
      expect((await json(manager, "GET", `/api/v1/intake/sessions/${draftId}/preview`)).status).toBe(403);
      expect((await json(interviewer, "POST", `/api/v1/intake/sessions/${draftId}/revisions`, { message: "Add a must-have: Dentrix experience" })).status).toBe(403);
    });

    it("a change by chat is shown first and saved only on confirmation, once (C10)", async () => {
      const before = (await session(draftId)).draft!;
      const r = await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions`, { message: "Add a must-have: Dentrix experience" });
      expect(r.status).toBe(200);
      const proposal = await read<PacketRevisionProposal>(r);
      expect(proposal).toMatchObject({ target: { kind: "draft", sessionId: draftId }, sections: ["requirements"], takesEffect: "draft", summary: "I added a must-have: Dentrix experience.", question: null, newFlags: [] });
      expect(proposal.diff.sections).toEqual([{ section: "requirements", label: "Must-haves and eligibility", changes: [expect.objectContaining({ label: "Must-have", kind: "added", before: null, after: "Dentrix experience", visibility: "public" })] }]);
      // nothing is saved yet
      expect((await session(draftId)).draft).toEqual(before);
      const [run] = await container.db.select().from(aiRuns).where(eq(aiRuns.id, proposal.revisionId));
      expect(run).toMatchObject({ task: "packet.revise", status: "ok", finalOutcome: null });
      expect(run.inputRef).toMatchObject({ target: "draft", sessionId: draftId, request: "Add a must-have: Dentrix experience", requestedBy: ownerId });
      const applied = await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions/${proposal.revisionId}/apply`);
      expect(applied.status).toBe(201);
      const body = await read<{ session: IntakeSessionView; draft: DraftRolePacket; diff: PacketDiff }>(applied);
      expect(body.draft.requirements.mustHaves.map((m) => m.text)).toContain("Dentrix experience");
      expect(body.session.draft?.requirements.mustHaves.map((m) => m.text)).toContain("Dentrix experience");
      expect(body.draft.provenance.aiRunIds).toContain(proposal.revisionId);
      // pay in a draft is still only what a person confirmed
      expect(body.draft.compensation).toMatchObject({ min: 45, max: 55 });
      const [after] = await container.db.select().from(aiRuns).where(eq(aiRuns.id, proposal.revisionId));
      expect(after.finalOutcome).toMatchObject({ decision: "applied", by: { id: ownerId } });
      expect((await container.db.select().from(events).where(and(eq(events.type, "packet.revision_applied"), eq(events.subjectId, draftId)))).length).toBe(1);
      expect((await container.db.select().from(events).where(and(eq(events.type, "packet.revision_proposed"), eq(events.subjectId, draftId)))).length).toBe(1);
      const twice = await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions/${proposal.revisionId}/apply`);
      expect(twice.status).toBe(409);
      expect((await errorOf(twice)).code).toBe("already_decided");
    });

    it("a change worked out on an older draft, a set-aside change, pay and a refused request are never saved", async () => {
      const first = await read<PacketRevisionProposal>(await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions`, { message: "Rename the job to Registered Dental Hygienist (RDH)" }));
      const second = await read<PacketRevisionProposal>(await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions`, { message: "Change the schedule to Tuesday to Saturday, 7 to 4" }));
      expect((await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions/${second.revisionId}/apply`)).status).toBe(201);
      const stale = await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions/${first.revisionId}/apply`);
      expect(stale.status).toBe(409);
      expect(await errorOf(stale)).toMatchObject({ code: "stale_revision", message: expect.stringMatching(/Ask again/) });
      const third = await read<PacketRevisionProposal>(await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions`, { message: "Make the messages more formal" }));
      expect((await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions/${third.revisionId}/discard`)).status).toBe(200);
      expect((await errorOf(await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions/${third.revisionId}/apply`))).code).toBe("already_decided");
      expect((await container.db.select().from(events).where(eq(events.type, "packet.revision_discarded"))).length).toBe(1);
      const pay = await read<PacketRevisionProposal>(await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions`, { message: "Change the pay to $50 to $60 an hour" }));
      expect(pay.sections).toEqual([]);
      expect(pay.notChanged).toEqual([expect.objectContaining({ reason: "Pay is set on the pay card." })]);
      expect((await errorOf(await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions/${pay.revisionId}/apply`))).code).toBe("nothing_to_apply");
      const proxy = await read<PacketRevisionProposal>(await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions`, { message: "Add a must-have: native English speaker" }));
      expect(proxy.sections).toEqual([]);
      expect(proxy.notChanged[0].reason).toMatch(/national origin/);
      // someone else's revision id, or a made-up one, is not found on this draft
      expect((await errorOf(await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions/not-a-run/apply`))).code).toBe("revision_not_found");
    });

    it("a draft write checks, on the locked row, that the draft is still the one the change was worked out on", async () => {
      const current = (await session(draftId)).draft!;
      const changed = structuredClone(current);
      changed.identity.title = "Something else";
      await expect(storeDraftPacket(container.db, { companyId, sessionId: draftId, actor: { kind: "user", id: ownerId }, draft: changed, expectedHash: "0000000000000000" })).rejects.toMatchObject({ code: "stale_draft" });
      expect((await session(draftId)).draft).toEqual(current);
      // the outcome recorded with the save fails with it: nothing is saved half way
      await expect(storeDraftPacket(container.db, { companyId, sessionId: draftId, actor: { kind: "user", id: ownerId }, draft: changed, expectedHash: packetFingerprint(current) }, { onSaved: async () => { throw new Error("recording failed"); } })).rejects.toThrow("recording failed");
      expect((await session(draftId)).draft).toEqual(current);
    });

    it("a failed model call changes nothing and says so plainly", async () => {
      container.fake!.failNext("packet.revise", "throw");
      const r = await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions`, { message: "Add a must-have: Eaglesoft experience" });
      expect(r.status).toBe(502);
      expect(await errorOf(r)).toMatchObject({ code: "ai_failed", message: expect.stringMatching(/Nothing was changed/) });
      container.fake!.clearScripts();
      const tooLong = await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions`, { message: "x".repeat(2_001) });
      expect(await errorOf(tooLong)).toMatchObject({ code: "message_too_long", message: expect.stringMatching(/2,000 characters/) });
    });

    it("the requirements check suggests, and only a tapped fix changes the draft (C16)", async () => {
      const trait = await read<PacketRevisionProposal>(await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions`, { message: "Add a must-have: Team player with a positive attitude" }));
      expect((await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/revisions/${trait.revisionId}/apply`)).status).toBe(201);
      const check = await read<RequirementsCheck>(await json(owner, "GET", `/api/v1/intake/sessions/${draftId}/requirements-check`));
      expect(check.base).toMatch(/^d[0-9a-f]{16}$/);
      const s = check.suggestions.find((x) => x.kind === "trait_as_skill")!;
      expect(s).toMatchObject({ text: "Team player with a positive attitude", title: "A personality trait, not a skill" });
      const move = s.fixes.find((f) => f.op === "to_interview")!;
      const stale = await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/requirements-check/apply`, { base: "d0000000000000000", fixIds: [move.id] });
      expect((await errorOf(stale)).code).toBe("stale_check");
      const r = await json(owner, "POST", `/api/v1/intake/sessions/${draftId}/requirements-check/apply`, { base: check.base, fixIds: [move.id] });
      expect(r.status).toBe(201);
      const out = await read<{ draft: DraftRolePacket; applied: string[]; check: RequirementsCheck }>(r);
      expect(out.applied).toEqual(['Moved "Team player with a positive attitude" to the interview.']);
      expect(out.draft.requirements.mustHaves.map((m) => m.text)).not.toContain("Team player with a positive attitude");
      expect(out.draft.competencies.some((c) => c.definition === "Team player with a positive attitude" && c.evaluatedIn === "interview")).toBe(true);
      expect(out.check.suggestions.some((x) => x.kind === "trait_as_skill")).toBe(false);
      expect((await container.db.select().from(events).where(and(eq(events.type, "packet.check_applied"), eq(events.subjectId, draftId)))).length).toBe(1);
    });
  });

  describe("on a saved role", () => {
    it("a confirmed change by chat becomes a new version under the person who confirmed it, source agent_revision (C10)", async () => {
      const started = await read<{ session: { id: string } }>(await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: MESSAGE }));
      const compiled = await json(owner, "POST", `/api/v1/intake/sessions/${started.session.id}/compile`);
      expect(compiled.status).toBe(201);
      roleId = (await read<{ roleId: string }>(compiled)).roleId;
      await container.drain();
      expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1 })).status).toBe(200);
      await container.drain();
      const r = await json(owner, "POST", `/api/v1/roles/${roleId}/revisions`, { message: "Add a must-have: Dentrix experience" });
      expect(r.status).toBe(200);
      const proposal = await read<PacketRevisionProposal>(r);
      expect(proposal).toMatchObject({ target: { kind: "role", roleId, baseVersion: 1 }, sections: ["requirements"], takesEffect: "now" });
      expect((await versions()).length).toBe(1);
      const applied = await json(owner, "POST", `/api/v1/roles/${roleId}/revisions/${proposal.revisionId}/apply`);
      expect(applied.status).toBe(201);
      const v2 = await read<{ version: number; outcome: string; source: string; changeSummary: string; createdBy: { id: string; kind: string }; packet: RolePacket; diff: PacketDiff }>(applied);
      expect(v2).toMatchObject({ version: 2, outcome: "approved_current", source: "agent_revision", changeSummary: "Changed by chat: I added a must-have: Dentrix experience.", createdBy: { kind: "user", id: ownerId } });
      expect(v2.packet.provenance.aiRunIds).toContain(proposal.revisionId);
      expect(v2.diff).toMatchObject({ from: 1, to: 2, total: 1 });
      const [ev] = await container.db.select().from(events).where(and(eq(events.type, "packet.revision_applied"), eq(events.subjectId, `${roleId}:2`)));
      expect(ev.payload).toMatchObject({ roleId, version: 2, baseVersion: 1, revisionId: proposal.revisionId, sections: ["requirements"] });
      // the role's activity lists the proposal and the confirmation
      const timeline = await read<Array<{ type: string }>>(await json(owner, "GET", `/api/v1/roles/${roleId}/timeline`));
      expect(timeline.map((e) => e.type)).toEqual(expect.arrayContaining(["packet.revision_proposed", "packet.revision_applied", "role_packet.edited"]));
    });

    it("the version diff names each change in plain words; pay is left out for people who may not see it", async () => {
      const diff = await read<PacketDiff>(await json(owner, "GET", `/api/v1/roles/${roleId}/packets/diff`));
      expect(diff).toMatchObject({ from: 1, to: 2, total: 1, sections: [{ section: "requirements", changes: [{ label: "Must-have", kind: "added", after: "Dentrix experience", visibility: "public" }] }] });
      const pay = await read<PacketRevisionProposal>(await json(owner, "POST", `/api/v1/roles/${roleId}/revisions`, { message: "Change the pay to $50 to $60 an hour" }));
      expect(pay.sections).toEqual(["compensation"]);
      expect(pay.diff.sections[0].changes).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Pay range", before: "$45–$55 an hour", after: "$50–$60 an hour", visibility: "public" }), expect.objectContaining({ label: "Private ceiling", before: expect.stringMatching(/^\$5\d$/), after: "$60", visibility: "internal" })]));
      const v3 = await read<{ version: number; packet: RolePacket }>(await json(owner, "POST", `/api/v1/roles/${roleId}/revisions/${pay.revisionId}/apply`));
      expect(v3.packet.provenance).toMatchObject({ payOrigin: "edited", payConfirmedBy: { via: "edited", by: { id: ownerId } } });
      const full = await read<PacketDiff>(await json(owner, "GET", `/api/v1/roles/${roleId}/packets/diff?from=1&to=3`));
      expect(full.sections.map((s) => s.section)).toEqual(["compensation", "requirements"]);
      // an interviewer reads the versions of a role they interview for, and no other's
      expect((await json(interviewer, "GET", `/api/v1/roles/${roleId}/packets/diff?from=2&to=3`)).status).toBe(404);
      const onIt = await putOnInterview(container, app, { cookie: interviewer, roleId });
      const forInterviewer = await json(interviewer, "GET", `/api/v1/roles/${roleId}/packets/diff?from=2&to=3`);
      expect(forInterviewer.status).toBe(200);
      expect(await read<PacketDiff>(forInterviewer)).toMatchObject({ sections: [], total: 0 });
      expect((await json(owner, "GET", `/api/v1/roles/${roleId}/packets/diff?to=99`)).status).toBe(404);
      // an interviewer cannot change the packet or see the candidate view with pay
      expect((await json(interviewer, "POST", `/api/v1/roles/${roleId}/revisions`, { message: "Add a must-have: Dentrix experience" })).status).toBe(403);
      expect((await json(interviewer, "GET", `/api/v1/roles/${roleId}/preview`)).status).toBe(403);
      await onIt.remove();
    });

    it("the plain-field editor changes only what was sent, within the packet's limits, from the newest version (C11)", async () => {
      const base = await newest();
      const stale = await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: base.version - 1, title: "Hygienist" });
      expect(stale.status).toBe(409);
      expect((await errorOf(stale)).code).toBe("stale_version");
      const two = base.packet.screening.questions.slice(0, 2).map((q) => ({ key: q.key, question: q.question }));
      const tooFew = await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: base.version, screeningQuestions: two });
      expect(await errorOf(tooFew)).toMatchObject({ code: "screening_questions_count", message: "Keep between 3 and 12 screening questions. This list has 2." });
      expect((await errorOf(await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: base.version, compensation: { ceiling: 40 } }))).code).toBe("ceiling_below_range");
      expect((await errorOf(await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: base.version, decisionMakerUserId: interviewerId }))).code).toBe("not_a_decider");
      expect((await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: base.version, eligibility: [{ type: "age_under_40", question: "How old are you?", rationale: "No" }] })).status).toBe(400);
      expect((await errorOf(await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: base.version, tone: base.packet.communication.tone }))).code).toBe("nothing_changed");
      const reordered = [...base.packet.screening.questions].reverse().map((q) => ({ key: q.key, question: q.question }));
      reordered[0] = { ...reordered[0], question: "What hourly range are you hoping for?" };
      const edit = {
        baseVersion: base.version,
        title: "Dental Hygienist (RDH)",
        schedule: "Tuesday to Saturday",
        tone: "direct",
        screeningQuestions: [...reordered, { question: "Which charting software have you used?" }],
        eligibility: [...base.packet.requirements.eligibility.map((e) => ({ key: e.key, type: e.type, question: e.question, rationale: e.rationale })), { type: "license", question: "Do you hold a California X-ray license?", rationale: "Needed to take x-rays here." }],
        dealBreakers: ["Cannot work Saturdays", "cannot work saturdays"],
        decisionMakerUserId: managerId,
      };
      const r = await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, edit);
      expect(r.status).toBe(200);
      const v = await read<{ version: number; outcome: string; fields: string[]; changeSummary: string; packet: RolePacket; diff: PacketDiff; needsApproval: unknown }>(r);
      // the title and the eligibility questions of a live job need the same approval as a new role (founder decision
      // Q10 = B); the company's only owner confirms their own change
      expect(v.outcome).toBe("proposed_pending_approval");
      // (the newest version, the base of this edit, also carries the pay change asked for by chat, still waiting)
      expect(v.needsApproval).toEqual({ changes: ["pay", "title", "eligibility"], words: "This changes the pay, the job title and the eligibility questions, so it needs the same approval as a new role before it goes live.", youMayConfirm: true });
      await container.drain();
      expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: v.version })).status).toBe(200);
      await container.drain();
      expect(v.fields).toEqual(["title", "schedule", "screeningQuestions", "eligibility", "dealBreakers", "decisionMakerUserId", "tone"]);
      expect(v.changeSummary).toBe("Edited: job title, schedule, screening questions, eligibility questions, deal-breakers, decision maker, message tone");
      expect(v.packet.identity).toMatchObject({ title: "Dental Hygienist (RDH)", schedule: "Tuesday to Saturday" });
      expect(v.packet.screening.questions.map((q) => q.key).slice(0, -1)).toEqual([...base.packet.screening.questions].reverse().map((q) => q.key));
      const reworded = v.packet.screening.questions[0];
      expect(reworded.question).toBe("What hourly range are you hoping for?");
      expect(reworded.modelAnswer).toBeUndefined();
      expect(v.packet.screening.questions.at(-1)).toMatchObject({ key: expect.stringMatching(/^q_which_charting_software/), question: "Which charting software have you used?", kind: "skills" });
      expect(v.packet.requirements.eligibility.at(-1)).toMatchObject({ type: "license", knockout: true, expectation: {} });
      expect(v.packet.preferences).toMatchObject({ decisionMakerUserId: managerId, decisionMakerName: "Hank Manager", dealBreakersInTheirWords: ["Cannot work Saturdays"] });
      expect(v.packet.communication.tone).toBe("direct");
      expect(v.diff.sections.map((s) => s.section)).toEqual(["identity", "requirements", "screening", "communication", "preferences"]);
      // a reworded question reads as one change, matched by its key; a new one as added
      expect(v.diff.sections.find((s) => s.section === "screening")!.changes).toEqual([
        expect.objectContaining({ label: "Screening question", kind: "changed", after: "What hourly range are you hoping for?", visibility: "asked" }),
        expect.objectContaining({ label: "Screening question", kind: "added", after: "Which charting software have you used?" }),
      ]);
      // the same questions in another order read as one change of order
      const turned = [...v.packet.screening.questions].reverse().map((q) => ({ key: q.key, question: q.question }));
      const order = await read<{ version: number; diff: PacketDiff }>(await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: v.version, screeningQuestions: turned }));
      expect(order.diff.sections).toEqual([{ section: "screening", label: "Screening questions", changes: [expect.objectContaining({ label: "Order of the screening questions", kind: "changed" })] }]);
      // pay typed in the editor counts as set by that person
      const pay = await read<{ version: number; packet: RolePacket; notes: string[] }>(await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: order.version, compensation: { min: 52, max: 64 } }));
      expect(pay.packet.compensation).toMatchObject({ min: 52, max: 64, ceiling: 64 });
      expect(pay.notes).toEqual(["The private ceiling was raised to the top of the new range ($64)."]);
      expect(pay.packet.provenance.payConfirmedBy).toMatchObject({ via: "edited", by: { id: ownerId } });
      // the pay of a live job changes only once approved (Q10); the only owner confirms it
      await container.drain();
      expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: pay.version })).status).toBe(200);
      await container.drain();
      expect((await errorOf(await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: pay.version, compensation: { basis: "salary" } }))).code).toBe("pay_basis_needs_range");
    });

    it("a change worked out on an older version is refused; a set-aside change can never be saved", async () => {
      const pending = await read<PacketRevisionProposal>(await json(owner, "POST", `/api/v1/roles/${roleId}/revisions`, { message: "Add a must-have: Eaglesoft experience" }));
      const base = await newest();
      expect((await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: base.version, tone: "warm" })).status).toBe(200);
      const stale = await json(owner, "POST", `/api/v1/roles/${roleId}/revisions/${pending.revisionId}/apply`);
      expect(stale.status).toBe(409);
      expect(await errorOf(stale)).toMatchObject({ code: "stale_revision", message: expect.stringMatching(/version \d+ now/) });
      const other = await read<PacketRevisionProposal>(await json(owner, "POST", `/api/v1/roles/${roleId}/revisions`, { message: "Add a must-have: Eaglesoft experience" }));
      expect((await json(owner, "POST", `/api/v1/roles/${roleId}/revisions/${other.revisionId}/discard`)).status).toBe(200);
      expect((await errorOf(await json(owner, "POST", `/api/v1/roles/${roleId}/revisions/${other.revisionId}/apply`))).code).toBe("already_decided");
      // a draft's proposal is not found on a role
      const runs = await container.db.select().from(aiRuns).where(and(eq(aiRuns.task, "packet.revise"), eq(aiRuns.status, "ok")));
      const fromDraft = runs.find((x) => (x.inputRef as { target?: string }).target === "draft" && !x.finalOutcome)!;
      expect((await errorOf(await json(owner, "POST", `/api/v1/roles/${roleId}/revisions/${fromDraft.id}/apply`))).code).toBe("revision_not_found");
    });

    it("the requirements check on the role: suggestions only, a tapped fix saves a new version", async () => {
      const add = await read<PacketRevisionProposal>(await json(owner, "POST", `/api/v1/roles/${roleId}/revisions`, { message: "Add a must-have: Will stay with us for at least 3 years" }));
      expect((await json(owner, "POST", `/api/v1/roles/${roleId}/revisions/${add.revisionId}/apply`)).status).toBe(201);
      const base = await newest();
      const check = await read<RequirementsCheck>(await json(owner, "GET", `/api/v1/roles/${roleId}/requirements-check`));
      expect(check).toMatchObject({ base: `v${base.version}`, version: base.version });
      const s = check.suggestions.find((x) => x.kind === "unprovable")!;
      expect(s.why).toMatch(/hunch/);
      // looking changes nothing
      expect((await newest()).version).toBe(base.version);
      const takeOut = s.fixes.find((f) => f.op === "remove")!;
      const r = await json(owner, "POST", `/api/v1/roles/${roleId}/requirements-check/apply`, { base: check.base, fixIds: [takeOut.id] });
      expect(r.status).toBe(201);
      const v = await read<{ version: number; source: string; changeSummary: string; packet: RolePacket; check: RequirementsCheck }>(r);
      expect(v).toMatchObject({ version: base.version + 1, source: "human_edit", changeSummary: 'Requirements check: Took out "Will stay with us for at least 3 years".' });
      expect(v.check.suggestions.some((x) => x.kind === "unprovable")).toBe(false);
      expect((await errorOf(await json(owner, "POST", `/api/v1/roles/${roleId}/requirements-check/apply`, { base: check.base, fixIds: [takeOut.id] }))).code).toBe("stale_check");
      const [ev] = await container.db.select().from(events).where(and(eq(events.type, "packet.check_applied"), eq(events.subjectId, `${roleId}:${v.version}`)));
      expect(ev.payload).toMatchObject({ roleId, applied: 1 });
    });

    it("the preview of a version shows the candidate's view and whether it is the live one (C9)", async () => {
      const current = await read<JobPreview>(await json(owner, "GET", `/api/v1/roles/${roleId}/preview`));
      expect(current.source).toMatchObject({ kind: "version", roleId, current: true });
      expect(current).toMatchObject({ notPublicYet: false, banner: "This is the live version of the job page.", gaps: [] });
      expect(current.job.title).toBe("Dental Hygienist (RDH)");
      expect(current.pay.text).toBe("$52–$64 an hour");
      const first = await read<JobPreview>(await json(owner, "GET", `/api/v1/roles/${roleId}/preview?version=1`));
      expect(first.source).toMatchObject({ version: 1, current: false });
      expect(first.banner).toBe("Preview of version 1: not public.");
      expect((await json(owner, "GET", `/api/v1/roles/${roleId}/preview?version=99`)).status).toBe(404);
      expect((await json(manager, "GET", `/api/v1/roles/${roleId}/preview`)).status).toBe(200);
      // until ITS has checked the company, even the live version is not public, and the preview says why
      const [co] = await container.db.select().from(companies).where(eq(companies.id, companyId));
      await container.db.update(companies).set({ settings: { ...co.settings, verifiedAt: undefined, verifiedBy: undefined } }).where(eq(companies.id, companyId));
      const unchecked = await read<JobPreview>(await json(owner, "GET", `/api/v1/roles/${roleId}/preview`));
      expect(unchecked).toMatchObject({ notPublicYet: true, company: { verified: false }, gaps: [expect.stringMatching(/one-time check by ITS/)] });
      await container.db.update(companies).set({ settings: co.settings }).where(eq(companies.id, companyId));
    });

    it("who set the pay is the server's record: a version saved from the client is stamped with whoever saved it, never what the client sent", async () => {
      const base = await newest();
      const forged = { by: { kind: "user" as const, id: managerId, name: "Hank Manager" }, at: "2020-01-01T00:00:00.000Z", via: "typed" as const };
      // pay changed in the full-packet editor: recorded as set by the owner, now; the made-up record is ignored
      const raised = structuredClone(base.packet);
      raised.compensation = { ...raised.compensation, min: 70, max: 80 };
      raised.provenance.payConfirmedBy = forged;
      raised.provenance.payOrigin = "typed";
      const r = await read<{ version: number; packet: RolePacket; guardChanges: string[] }>(await json(owner, "POST", `/api/v1/roles/${roleId}/packets`, { packet: raised, changeSummary: "New pay" }));
      expect(r.packet.provenance).toMatchObject({ payOrigin: "edited", payConfirmedBy: { via: "edited", by: { id: ownerId } } });
      expect(r.packet.provenance.payConfirmedBy?.at).not.toBe(forged.at);
      // what the guard changed on its own is said: the ceiling below the new range was raised
      expect(r.packet.compensation.ceiling).toBe(80);
      expect(r.guardChanges).toEqual(["The private ceiling was raised to the top of the range."]);
      // the same pay saved again keeps the earlier record, whatever the client says
      const again = structuredClone(r.packet);
      again.communication.tone = "warm";
      again.provenance.payConfirmedBy = forged;
      const kept = await read<{ version: number; outcome: string; packet: RolePacket }>(await json(owner, "POST", `/api/v1/roles/${roleId}/packets`, { packet: again, changeSummary: "Tone" }));
      expect(kept.packet.provenance.payConfirmedBy).toEqual(r.packet.provenance.payConfirmedBy);
      // the new pay of the live job waits for approval (Q10); the only owner confirms it
      expect(kept.outcome).toBe("proposed_pending_approval");
      await container.drain();
      expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: kept.version })).status).toBe(200);
      await container.drain();
    });

    it("the approval card lists the flagged wording; a person keeps it with a reason on the version waiting, and sending back is never blocked (C1)", async () => {
      type Pending = { version: number; flags: Array<{ id: string; text: string; kept?: { reason: string; by: { id: string } } }>; viewer: { mayDecide: boolean; maySendBack: boolean; reason: string | null } };
      const pendingOf = async (cookie: string) => (await read<{ packetApproval: { pending: Pending | null } }>(await json(cookie, "GET", `/api/v1/roles/${roleId}`))).packetApproval.pending;
      const base = await newest();
      const flagged = structuredClone(base.packet);
      flagged.requirements.niceToHaves.push({ key: "nh_young", text: "A young and energetic team player", rationale: "r", evidencedBy: ["resume"] });
      const v = await read<{ version: number; outcome: string }>(await json(owner, "POST", `/api/v1/roles/${roleId}/packets`, { packet: flagged, changeSummary: "Added a nice-to-have" }));
      expect(v.outcome).toBe("proposed_pending_approval");
      await container.drain();
      // the decision maker (the manager) sees the phrase, cannot approve yet, and can still send it back
      const forManager = await pendingOf(manager);
      expect(forManager).toMatchObject({ version: v.version, viewer: { mayDecide: false, maySendBack: true, reason: expect.stringMatching(/needs a decision first/) } });
      expect(forManager!.flags.map((f) => f.text)).toEqual(["young and energetic team"]);
      const flagId = forManager!.flags[0].id;
      // Today's card says the wording comes first, instead of offering an approval the route would refuse
      type Card = { kind: string; title: string; body: string; roleId?: string; actions: Array<{ label: string }> };
      const card = (await read<{ cards: Card[] }>(await json(manager, "GET", "/api/v1/brief"))).cards.find((c) => c.kind === "decision" && c.roleId === roleId)!;
      expect(card.body).toMatch(/needs a decision first/);
      expect(card.actions.map((a) => a.label)).toEqual(["Review the wording"]);
      // an interviewer may not keep it; an approved version has nothing to keep
      expect((await json(interviewer, "POST", `/api/v1/roles/${roleId}/packets/${v.version}/flags/keep`, { flagId, reason: "Because we say so" })).status).toBe(403);
      expect((await errorOf(await json(manager, "POST", `/api/v1/roles/${roleId}/packets/${base.version}/flags/keep`, { flagId, reason: "Because we say so" }))).code).toBe("not_waiting");
      const keep = await json(manager, "POST", `/api/v1/roles/${roleId}/packets/${v.version}/flags/keep`, { flagId, reason: "It is the name of our team's charity run; we will reword it next time." });
      expect(keep.status).toBe(200);
      expect(await read<{ openFlags: number }>(keep)).toMatchObject({ openFlags: 0 });
      expect((await errorOf(await json(manager, "POST", `/api/v1/roles/${roleId}/packets/${v.version}/flags/keep`, { flagId, reason: "Again, the same reason" }))).code).toBe("already_kept");
      const [ev] = await container.db.select().from(events).where(and(eq(events.type, "packet.flag_kept"), eq(events.subjectId, `${roleId}:${v.version}`)));
      expect(ev.payload).toMatchObject({ roleId, version: v.version, flagId });
      // the same version (no new one, so the approval asked for stands) now shows who kept it, and may be approved, by
      // someone else: on a live job the person who kept flagged wording does not approve it too (founder decision L-01)
      expect((await versions()).length).toBe(v.version);
      const after = await pendingOf(manager);
      expect(after).toMatchObject({ version: v.version, viewer: { mayDecide: false, maySendBack: true, reason: expect.stringMatching(/You kept wording the fairness check flagged/) } });
      expect(after!.flags[0].kept).toMatchObject({ by: { id: managerId }, reason: expect.stringMatching(/charity run/) });
      expect((await json(manager, "POST", `/api/v1/roles/${roleId}/approve`, { version: v.version })).status).toBe(409);
      // the company's only owner wrote the version and kept nothing: their yes is the second one
      expect((await pendingOf(owner))?.viewer).toMatchObject({ mayDecide: true });
      expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: v.version })).status).toBe(200);
      await container.drain();
    });

    it("a closed role is not changed any more", async () => {
      expect((await json(owner, "POST", `/api/v1/roles/${roleId}/outcome`, { outcome: "role_cancelled", confirm: true })).status).toBe(200);
      const r = await json(owner, "POST", `/api/v1/roles/${roleId}/revisions`, { message: "Add a must-have: Dentrix experience" });
      expect(r.status).toBe(409);
      expect((await errorOf(r)).code).toBe("role_closed");
      const base = await newest();
      expect((await errorOf(await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: base.version, title: "Hygienist" }))).code).toBe("role_closed");
      const rows = await container.db.select({ source: rolePackets.source }).from(rolePackets).where(eq(rolePackets.roleId, roleId));
      expect(rows.filter((x) => x.source === "agent_revision").length).toBe(3);
    });
  });
});
