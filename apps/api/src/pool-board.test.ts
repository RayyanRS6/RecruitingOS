import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { matchWeightOf, previewMatch, type BatchPreview, type BatchResult, type BoardView, type EvidenceAssessment, type MatchScore, type PoolAnswer, type RolePacket } from "@ros/contracts";
import { anonymizeCandidate, entitlements, matchScore, readingPair } from "@ros/core";
import { FAKE_SAMPLE_RESUMES } from "@ros/agents";
import { applicationMarks, applications, assessments, candidates, communications, escalationMessages, events, randomToken, recruiterEscalations, screens, withPlatform, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAs, signInStaff, useLaterApplyFlow } from "./test-helpers";

/**
 * Wave F: the match score on every applicant (founder decision B2), the pool board and its summary (plan F6, F7),
 * Review and apply (F8; founder decision B4: private, each with their own reason, nobody emailed), the one-click
 * questions (F10), a recruiter's check of the board (F9), "Something wrong?" reaching ITS (F11), Today's pool card and
 * latest-reading counts (F5, F7), importance on the packet (F3) and the version label (F4).
 */
describe("the match score, the pool board, Review and apply and the one-click questions", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  let packet: RolePacket;
  let elig: Array<{ key: string }> = [];
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const get = async <T>(path: string, cookie = owner) => (await (await json(cookie, "GET", path)).json()) as T;
  const sent = () => (container.integrations.email as FakeEmailAdapter).sent;

  type Req = EvidenceAssessment["requirementFindings"][number];
  const resultOf = (requirementFindings: Req[], over: Partial<EvidenceAssessment> = {}): EvidenceAssessment => ({
    overall: "potential", confidence: "medium", confidenceReasons: [], summary: "Hygiene work.", strengths: [{ claim: "Works as a hygienist", evidence: { source: "resume", quote: "Hygienist at Harbor Dental" } }], concerns: [], unknowns: [],
    competencyFindings: packet.competencies.map((c) => ({ competencyKey: c.key, finding: "evidenced", evidence: { source: "resume", quote: `${c.name} shown` } })),
    requirementFindings, anomalies: [], recommendation: "screen", rationale: "seeded", ...over,
  });
  /** A candidate with an application waiting on the team and, unless `result` is null, a résumé reading of it. */
  const seed = (first: string, result: EvidenceAssessment | null, over: { stageChangedAt?: string; packetVersion?: number } = {}) =>
    withTenant(container.db, companyId, async (tx) => {
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: first, lastName: "Pool", email: `${first.toLowerCase()}@pool.test`, firstSource: "direct" }).returning();
      const [a] = await tx.insert(applications).values({ companyId, roleId, candidateId: cand.id, packetVersion: over.packetVersion ?? 1, source: "direct", stage: "triaged", statusToken: randomToken(16), ...(over.stageChangedAt ? { stageChangedAt: over.stageChangedAt } : {}) }).returning();
      if (result) {
        const [asmt] = await tx.insert(assessments).values({ companyId, applicationId: a.id, kind: "triage", packetVersion: over.packetVersion ?? 1, result, overall: result.overall, confidence: result.confidence }).returning();
        await tx.update(applications).set({ latestAssessmentId: asmt.id }).where(eq(applications.id, a.id));
      }
      return a.id;
    });
  const must = (i: number) => packet.requirements.mustHaves[i];
  const yes = (i: number, quote: string): Req => ({ requirementKey: must(i).key, met: "yes", evidence: { source: "resume", quote } });

  const ids: Record<string, string> = {};

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@pool.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Pool Dental", vertical: "dental", sizeBand: "20-49", ownerName: "Dana Pool", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    slug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
    await useLaterApplyFlow(container, companyId);
    // The must-haves come last, on their own line: the fake intake reads a must-haves line to its end.
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Just draft it.\nMust-haves: active CA RDH license, periodontal charting" })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    const role = await get<{ status: string; currentPacket: { packet: RolePacket } }>(`/api/v1/roles/${roleId}`);
    expect(role.status).toBe("open");
    packet = role.currentPacket.packet;
    elig = packet.requirements.eligibility;
    expect(packet.requirements.mustHaves.map((m) => m.text)).toEqual(["active CA RDH license", "periodontal charting"]);
    // Ada shows everything; Ben shows the licence and only part of the perio work, with no skills on record; Cy's own words show the licence lapsed; Dee has no reading at all.
    ids.ada = await seed("Ada", resultOf([yes(0, "RDH license CA active"), yes(1, "Periodontal charting daily")], { overall: "strong" }), { stageChangedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    ids.ben = await seed("Ben", resultOf([yes(0, "RDH license CA active"), { requirementKey: must(1).key, met: "partially", evidence: { source: "resume", quote: "some charting" } }], { competencyFindings: packet.competencies.map((c, i) => ({ competencyKey: c.key, finding: i === 0 ? "contradicted" : "not_evidenced", ...(i === 0 ? { evidence: { source: "resume", quote: "I prefer not to do this" } } : {}) })) }), { stageChangedAt: new Date(Date.now() - 9 * 86_400_000).toISOString() });
    ids.cy = await seed("Cy", resultOf([{ requirementKey: must(0).key, met: "no", evidence: { source: "resume", quote: "RDH license CA expired in 2021" } }, yes(1, "Periodontal charting")], { overall: "weak", recommendation: "hold" }));
    ids.dee = await seed("Dee", null);
  });
  afterAll(async () => {
    await container.close();
  });

  type Row = { id: string; score: number | null; band: string | null; bandLabel: string | null; coverage: { known: number; total: number; words: string } | null; missingMustHave: Array<{ key: string; label: string; quote: string }>; mustHaves: { words: string } | null; placement: { column: string | null; confident: boolean; needsYourEye: string | null; suggestedAction: string | null }; nextStep: { kind: string; label: string } | null };

  describe("the match score on the list and the candidate's page (B2, F1, F3)", () => {
    it("carries the score worked out from the stored findings, its band, coverage, the missing must-have, the placement and next step", async () => {
      const rows = await get<Row[]>(`/api/v1/roles/${roleId}/applications`);
      const row = (id: string) => rows.find((r) => r.id === id)!;
      // the list says exactly what the pure function says over the same rows
      for (const id of [ids.ada, ids.ben, ids.cy]) {
        const own = await container.db.select().from(assessments).where(eq(assessments.applicationId, id));
        expect(row(id).score, id).toBe(matchScore(readingPair(own), packet)!.score);
      }
      expect(row(ids.ada)).toMatchObject({ score: 100, band: "very_high", bandLabel: "Very high", missingMustHave: [], placement: { column: "shortlist", confident: true }, mustHaves: { words: "Must-haves: 2 of 2 shown" } });
      expect(row(ids.ada).coverage).toMatchObject({ known: 2 + packet.competencies.length, total: 2 + packet.competencies.length });
      expect(row(ids.ben).band).toBe("medium");
      expect(row(ids.ben).placement).toMatchObject({ column: "longlist", confident: true });
      expect(row(ids.ben).coverage!.words).toBe(`Based on 3 of ${2 + packet.competencies.length} requirements`);
      expect(row(ids.cy)).toMatchObject({ band: "low", missingMustHave: [{ key: must(0).key, label: "active CA RDH license", quote: "RDH license CA expired in 2021" }], placement: { column: "not_moving_forward", suggestedAction: "not_moving_forward" }, nextStep: { kind: "not_moving_forward", label: "Not moving forward" } });
      expect(row(ids.cy).score).toBeLessThanOrEqual(54);
      expect(row(ids.dee)).toMatchObject({ score: null, band: null, coverage: null, placement: { column: "longlist", confident: false } });
    });

    it("sorts by score, highest first, with no score last (order=score or sort=score)", async () => {
      for (const q of ["order=score", "sort=score"]) {
        const rows = await get<Row[]>(`/api/v1/roles/${roleId}/applications?${q}`);
        expect(rows.map((r) => r.id), q).toEqual([ids.ada, ids.ben, ids.cy, ids.dee]);
      }
    });

    it("gives the candidate's page the full breakdown, costliest first, and the importance of each skill", async () => {
      const d = await get<{ matchScore: MatchScore; mustHaves: { total: number }; placement: { column: string }; packetLabels: { competencies: Array<{ key: string; importance: string }> } }>(`/api/v1/applications/${ids.ben}`);
      expect(d.matchScore.breakdown[0].pointsLost).toBeGreaterThan(0);
      expect(d.matchScore.breakdown.map((c) => c.pointsLost)).toEqual([...d.matchScore.breakdown.map((c) => c.pointsLost)].sort((a, b) => b - a));
      expect(d.matchScore.breakdown.find((c) => c.key === packet.competencies[0].key)).toMatchObject({ finding: "Goes against it", quote: "I prefer not to do this" });
      expect(d.packetLabels.competencies.map((c) => c.importance)).toEqual(packet.competencies.map((c) => (c.weight >= 5 ? "essential" : c.weight >= 3 ? "important" : "helpful")));
    });
  });

  describe("the pool board and its summary (F6, F7)", () => {
    it("puts each person in a column with the reason and the next step, and builds the summary from the rows", async () => {
      const b = await get<BoardView>(`/api/v1/roles/${roleId}/board`);
      expect(b.columns.shortlist.map((c) => c.name)).toEqual(["Ada Pool"]);
      expect(b.columns.longlist.map((c) => c.name)).toEqual(["Ben Pool", "Dee Pool"]);
      expect(b.columns.not_moving_forward.map((c) => c.name)).toEqual(["Cy Pool"]);
      const cy = b.columns.not_moving_forward[0];
      expect(cy.placement.reason).toBe("Missing must-have: active CA RDH license.");
      expect(cy.placement.declineReason).toEqual({ reason: "not_a_match_skills", note: 'Missing must-have: active CA RDH license. Their own words: "RDH license CA expired in 2021"' });
      expect(cy.gap).toMatchObject({ claim: "active CA RDH license: not met", quote: "RDH license CA expired in 2021" });
      expect(b.columns.longlist[1].placement.needsYourEye).toMatch(/could not assess this application automatically/);
      expect(b.summary).toMatchObject({ total: 4, counts: { shortlist: 1, longlist: 2, not_moving_forward: 1 }, toSort: 4, longestWaiting: { name: "Ben Pool", days: 9 } });
      expect(b.summary.sentences[0]).toBe("4 people on the board. To sort: 1 for the shortlist, 2 for the longlist, 1 not moving forward.");
      // the card carries what the page shows under the reason: the must-have line, what the score rests on, what happened
      // (seeded with no AI interview, as before 20 October 2026: "none", so the board places them on their résumé; R20-9)
      expect(b.columns.shortlist[0]).toMatchObject({ mustHaves: { words: "Must-haves: 2 of 2 shown" }, score: { basedOn: "resume", interview: "none", basis: "Résumé only: no AI interview" }, facts: { openScreen: false, suggestionWaiting: false } });
      expect(b.summary.nextSteps[0]).toMatchObject({ name: "Ada Pool" });
      // "Try different weights" (L-07 A) works each score out again in the browser from this answer's breakdown: with
      // the job's own weights it gives every real score back
      const scored = [...b.columns.shortlist, ...b.columns.longlist, ...b.columns.not_moving_forward, ...b.noAiInterview].filter((c) => c.score);
      expect(scored.length).toBe(3);
      for (const c of scored) {
        expect(previewMatch(c.score!, matchWeightOf).score, c.name).toBe(c.score!.score);
        expect(previewMatch(c.score!, matchWeightOf).capped, c.name).toBe(c.score!.capped);
      }
    });

    it("is open to those who read applications only, and to an interviewer not at all", async () => {
      const interviewer = await signInAs(container, app, { companyId, role: "interviewer" });
      // not one of their roles: it answers as a role that does not exist (on one of theirs, application.read refuses it)
      expect((await json(interviewer, "GET", `/api/v1/roles/${roleId}/board`)).status).toBe(404);
      expect((await json(owner, "GET", "/api/v1/roles/not-a-role/board")).status).toBe(404);
    });

    it("puts the pool on Today as one card per role, and counts strong candidates by their latest reading only (F5)", async () => {
      const brief = await get<{ summary: string; cards: Array<{ kind: string; roleId?: string; title: string; body: string; actions: Array<{ path: string }> }> }>("/api/v1/brief");
      const card = brief.cards.find((c) => c.kind === "pool_ready" && c.roleId === roleId)!;
      const { title } = await get<{ title: string }>(`/api/v1/roles/${roleId}`);
      expect(card.title).toBe(`4 people to sort for ${title}`);
      expect(card.body).toContain("4 people on the board");
      expect(card.actions.map((a) => a.path)).toEqual([`/roles/${roleId}/talent?view=board`, `/roles/${roleId}/talent?view=board&review=1`]);
      // Ada's Strong reading counts; once a later, Potential scorecard replaces it, it no longer does
      expect(brief.summary).toMatch(/· 1 strong candidate ready ·/);
      await withTenant(container.db, companyId, async (tx) => {
        const [card2] = await tx.insert(assessments).values({ companyId, applicationId: ids.ada, kind: "screen", packetVersion: 1, result: { ...resultOf([]), recommendation: "interview", questionFindings: [], compensationExpectation: { withinRange: "unknown" }, availability: { matchesSchedule: "unknown" }, eligibilityConfirmations: [] } as unknown as EvidenceAssessment, overall: "potential", confidence: "medium" }).returning();
        await tx.update(applications).set({ latestAssessmentId: card2.id }).where(eq(applications.id, ids.ada));
      });
      expect((await get<{ summary: string }>("/api/v1/brief")).summary).toMatch(/· 0 strong candidates ready ·/);
      // the scorecard said nothing about the must-haves, so the résumé's findings still count for her score
      expect((await get<Row[]>(`/api/v1/roles/${roleId}/applications`)).find((r) => r.id === ids.ada)!.score).toBe(100);
    });

    it("adds how the pool meets each must-have to the role report, counts only", async () => {
      const r = await get<{ mustHaves: { people: number; byMustHave: Array<{ key: string; shown: number; partly: number; notShown: number; unknown: number }> } }>(`/api/v1/roles/${roleId}/report`);
      expect(r.mustHaves.people).toBe(3);
      expect(r.mustHaves.byMustHave[0]).toMatchObject({ key: must(0).key, shown: 2, notShown: 1, unknown: 0 });
      expect(JSON.stringify(r.mustHaves)).not.toMatch(/Ada|Ben|Cy|Dee/);
    });
  });

  describe("one-click questions (F10)", () => {
    it("offers the questions, then answers each from the stored findings with the quotes and what it looked at", async () => {
      const qs = await get<{ questions: Array<{ id: string; label: string }> }>(`/api/v1/roles/${roleId}/questions`);
      expect(qs.questions.map((q) => q.label)).toEqual(["Who is missing a must-have, and why?", 'Strongest evidence for "active CA RDH license"', 'Strongest evidence for "periodontal charting"', "Who might I be overlooking?", "Compare these"]);
      const missing = await get<PoolAnswer>(`/api/v1/roles/${roleId}/questions/missing_must_have`);
      expect(missing.people.map((p) => [p.name, p.quotes[0]?.quote])).toEqual([["Cy Pool", "RDH license CA expired in 2021"]]);
      expect(missing.lookedAt.words).toContain("No AI was asked anything new");
      const strongest = await get<PoolAnswer>(`/api/v1/roles/${roleId}/questions/strongest_evidence?mustHave=${must(1).key}`);
      expect(strongest.people.map((p) => p.name)).toEqual(["Ada Pool", "Cy Pool", "Ben Pool"]);
      const overlooked = await get<PoolAnswer>(`/api/v1/roles/${roleId}/questions/overlooked`);
      expect(overlooked.people.map((p) => p.name)).toContain("Ben Pool");
      const compare = await get<PoolAnswer & { compare: { candidates: Array<{ name: string; score: MatchScore | null }> } }>(`/api/v1/roles/${roleId}/questions/compare?ids=${ids.cy},${ids.ada}`);
      expect(compare.compare.candidates.map((c) => [c.name, c.score?.score])).toEqual([["Cy Pool", expect.any(Number)], ["Ada Pool", 100]]);
      expect((await json(owner, "GET", `/api/v1/roles/${roleId}/questions/strongest_evidence?mustHave=nope`)).status).toBe(400);
      expect((await json(owner, "GET", `/api/v1/roles/${roleId}/questions/compare`)).status).toBe(400);
      expect((await json(owner, "GET", `/api/v1/roles/${roleId}/questions/compare?ids=${Array.from({ length: 6 }, (_, i) => `00000000-0000-7000-8000-00000000000${i}`).join(",")}`)).status).toBe(400);
      expect((await json(owner, "GET", `/api/v1/roles/${roleId}/questions/who_is_best`)).status).toBe(400);
    });
  });

  describe("Review and apply (F8; founder decision B4)", () => {
    it("previews without changing anything: who, the score, the board's suggestion, the pre-filled reason and the warnings", async () => {
      const p = (await (await json(owner, "POST", `/api/v1/roles/${roleId}/batch`, { dryRun: true, items: [{ applicationId: ids.ada, action: "shortlist" }, { applicationId: ids.ben, action: "longlist" }, { applicationId: ids.cy, action: "not_moving_forward" }, { applicationId: ids.dee, action: "not_moving_forward" }] })).json()) as BatchPreview;
      expect(p.items.map((i) => [i.name, i.allowed])).toEqual([["Ada Pool", true], ["Ben Pool", true], ["Cy Pool", true], ["Dee Pool", false]]);
      expect(p.items[2]).toMatchObject({ suggested: "not_moving_forward", reason: { reason: "not_a_match_skills", label: "Skills not a match", note: 'Missing must-have: active CA RDH license. Their own words: "RDH license CA expired in 2021"' } });
      // nobody to pre-fill a reason from: one has to be chosen
      expect(p.items[3].refusedReason).toBe("Choose a reason from the list.");
      expect(p).toMatchObject({ ready: 3, words: "3 decisions ready: 1 shortlist · 1 longlist · 1 not moving forward" });
      expect(p.privacy).toMatch(/nobody is told/);
      expect(await container.db.select().from(applicationMarks).where(inArray(applicationMarks.applicationId, Object.values(ids)))).toHaveLength(0);
    });

    it("applies each person privately in their own transaction, with their own reason; a refusal never blocks the rest; nobody is emailed", async () => {
      const before = sent().length;
      const hired = await seed("Hal", resultOf([yes(0, "RDH license CA active"), yes(1, "perio")]));
      await container.db.update(applications).set({ stage: "hired" }).where(eq(applications.id, hired));
      const r = (await (await json(owner, "POST", `/api/v1/roles/${roleId}/batch`, { items: [{ applicationId: ids.ada, action: "shortlist" }, { applicationId: hired, action: "longlist" }, { applicationId: ids.ben, action: "longlist", note: "Backup" }, { applicationId: ids.cy, action: "not_moving_forward" }] })).json()) as BatchResult;
      expect(r.results.map((x) => [x.name, x.ok, x.code])).toEqual([["Ada Pool", true, null], ["Hal Pool", false, "not_allowed"], ["Ben Pool", true, null], ["Cy Pool", true, null]]);
      expect(r).toMatchObject({ applied: 3, refused: 1, words: "Applied 3 decisions: 1 on the shortlist, 1 on the longlist, 1 not moving forward. 1 could not be applied; each says why." });
      expect(r.results.every((x) => !x.ok || x.candidateNotice === "not_told")).toBe(true);
      const marks = await container.db.select().from(applicationMarks).where(inArray(applicationMarks.applicationId, [ids.ada, ids.ben]));
      expect(marks.map((m) => [m.applicationId === ids.ada ? "ada" : "ben", m.mark, m.source]).sort()).toEqual([["ada", "shortlist", "board"], ["ben", "longlist", "board"]]);
      const [cy] = await container.db.select().from(applications).where(eq(applications.id, ids.cy));
      expect(cy).toMatchObject({ stage: "rejected", rejectReason: "not_a_match_skills", toldState: "not_told" });
      expect(cy.rejectNote).toContain("Missing must-have: active CA RDH license");
      // nothing reached any candidate
      expect(sent().slice(before).filter((m) => /pool\.test$/.test(m.to))).toHaveLength(0);
      expect(await container.db.select().from(communications).where(inArray(communications.applicationId, [ids.ada, ids.ben, ids.cy]))).toHaveLength(0);
      // suggested by the assistant, applied by the person: on each decision and once for the batch
      const [override] = await container.db.select().from(events).where(and(eq(events.type, "application.rejected"), eq(events.subjectId, ids.cy)));
      expect(override.payload).toMatchObject({ via: "review_and_apply", suggested: "not_moving_forward", suggestedBy: "assistant", appliedBy: "Dana Pool" });
      const [batch] = await container.db.select().from(events).where(and(eq(events.type, "pool.batch_applied"), eq(events.subjectId, roleId)));
      expect(batch.payload).toMatchObject({ batchId: r.batchId, applied: 3, refused: 1, followedSuggestion: 3 });
      expect((batch.payload as { items: Array<{ suggested: string | null; chosen: string }> }).items.map((i) => [i.suggested, i.chosen])).toEqual([["shortlist", "shortlist"], [null, "longlist"], ["longlist", "longlist"], ["not_moving_forward", "not_moving_forward"]]);
      // the board now shows them where they are, done
      const b = await get<BoardView>(`/api/v1/roles/${roleId}/board`);
      expect(b.columns.not_moving_forward.find((c) => c.applicationId === ids.cy)!.placement).toMatchObject({ state: "done", suggestedAction: null });
      expect(b.columns.shortlist.find((c) => c.applicationId === ids.ada)!.placement).toMatchObject({ state: "done", doneLabel: "Shortlist" });
    });

    it("refuses what a role may not do per person, caps the batch at 50 and refuses the same person twice", async () => {
      const hr = await signInAs(container, app, { companyId, role: "hr" });
      const extra = await seed("Ivy", resultOf([{ requirementKey: must(0).key, met: "no", evidence: { source: "resume", quote: "never held a license" } }]));
      const extra2 = await seed("Ned", resultOf([yes(0, "RDH license CA active")]));
      // HR sorts candidates but does not decline them: the decline is refused for that person, with who may
      const r = (await (await json(hr, "POST", `/api/v1/roles/${roleId}/batch`, { items: [{ applicationId: extra, action: "not_moving_forward" }, { applicationId: extra2, action: "longlist" }] })).json()) as BatchResult;
      expect(r.results.map((x) => [x.ok, x.code])).toEqual([[false, "not_allowed"], [true, null]]);
      expect(r.results[0].message).toMatch(/Your role can't decline candidates/);
      expect((await container.db.select().from(applications).where(eq(applications.id, extra)))[0].stage).toBe("triaged");
      const interviewer = await signInAs(container, app, { companyId, role: "interviewer" });
      expect((await json(interviewer, "POST", `/api/v1/roles/${roleId}/batch`, { items: [{ applicationId: extra, action: "longlist" }] })).status).toBe(403);
      expect((await json(owner, "POST", `/api/v1/roles/${roleId}/batch`, { items: Array.from({ length: 51 }, () => ({ applicationId: extra, action: "longlist" })) })).status).toBe(400);
      expect((await json(owner, "POST", `/api/v1/roles/${roleId}/batch`, { items: [{ applicationId: extra, action: "longlist" }, { applicationId: extra, action: "shortlist" }] })).status).toBe(400);
      expect((await json(owner, "POST", `/api/v1/roles/${roleId}/batch`, { items: [{ applicationId: extra, action: "promote" }] })).status).toBe(400);
    });

    it("asks a recruiter about several people in one request about the role, counted once (F9)", async () => {
      const a = await seed("Jo", resultOf([yes(0, "RDH license CA active")]));
      const b = await seed("Kai", resultOf([yes(0, "RDH license CA active")]));
      const items = [{ applicationId: a, action: "escalate" }, { applicationId: b, action: "escalate", note: "Two good backups?" }];
      // before anything is sent, the preview says the request covers the role, so the recruiter will see all of its candidates
      const preview = (await (await json(owner, "POST", `/api/v1/roles/${roleId}/batch`, { dryRun: true, items })).json()) as BatchPreview;
      expect(preview.items[0].warnings.join(" ")).toMatch(/One request covers all 2, so it is about the role: once a recruiter picks it up they see this role and all of its candidates, until a day after they answer or 14 days at most\./);
      const r = (await (await json(owner, "POST", `/api/v1/roles/${roleId}/batch`, { items })).json()) as BatchResult;
      expect(r.results.map((x) => x.ok)).toEqual([true, true]);
      expect(r.results[0].message).toContain("they see this role and all of its candidates");
      const reqs = await container.db.select().from(recruiterEscalations).where(and(eq(recruiterEscalations.roleId, roleId), eq(recruiterEscalations.kind, "review")));
      const mine = reqs.filter((e) => /Jo Pool, Kai Pool/.test(e.question));
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ applicationId: null });
      expect(mine[0].question).toContain("Two good backups?");
      // about the role, so the recruiter opens the board as it stood
      expect((mine[0].contextSnapshot as { board?: { people: Array<{ name: string }> } }).board?.people.map((p) => p.name)).toEqual(expect.arrayContaining(["Jo Pool", "Kai Pool"]));
      expect(sent().some((m) => m.subject.startsWith("[review]"))).toBe(true);
    });
  });

  describe("a recruiter's check and 'Something wrong?' (F9, F11)", () => {
    it("a review of the role carries the board as it stood when asked", async () => {
      const r = await json(owner, "POST", "/api/v1/escalations", { kind: "review", scope: "role", roleId, question: "Please check the board before I apply it." });
      expect(r.status).toBe(201);
      const { id } = (await r.json()) as { id: string };
      const [e] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, id));
      const board = (e.contextSnapshot as { board: { summary: { sentences: string[] }; people: Array<{ name: string; column: string | null; reason: string; score: number | null; interview?: string | null; basis?: string | null }> } }).board;
      expect(board.summary.sentences[0]).toMatch(/people on the board/);
      // Cy was filed as not moving forward in Review and apply: the board shows where she is now
      expect(board.people.find((p) => p.name === "Cy Pool")).toMatchObject({ column: "not_moving_forward", state: "done" });
      expect(board.people.find((p) => p.name === "Dee Pool")).toMatchObject({ column: "longlist", state: "suggested", needsYourEye: expect.stringMatching(/could not assess/) });
      // each score comes with whether the AI interview is in it, and its label, so the recruiter reads it as the team does (R20-9)
      const scored = board.people.filter((p) => p.score !== null);
      expect(scored.length).toBeGreaterThan(0);
      for (const p of scored) expect([p.interview, p.basis], p.name).toEqual([expect.any(String), expect.stringMatching(/^(From the|Résumé only)/)]);
    });

    it("a candidate's deletion reaches the board kept on a role review: their row, their next step and their name go", async () => {
      const rue = await seed("Rue", resultOf([yes(0, "RDH license CA active"), yes(1, "Periodontal charting daily")]), { stageChangedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
      const r = await json(owner, "POST", "/api/v1/escalations", { kind: "review", scope: "role", roleId, question: "Who should we call first?" });
      const { id } = (await r.json()) as { id: string };
      type Snapshot = { board: { people: Array<{ applicationId: string; name: string }>; summary: { longestWaiting: { applicationId: string; name: string } | null; nextSteps: Array<{ applicationId: string }>; sentences: string[] } } };
      const snapshot = async () => (await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, id)))[0].contextSnapshot as Snapshot;
      const before = await snapshot();
      expect(before.board.people.map((p) => p.name)).toContain("Rue Pool");
      expect(before.board.summary.longestWaiting).toMatchObject({ applicationId: rue, name: "Rue Pool" });
      expect(before.board.summary.sentences.join(" ")).toContain("Rue Pool has waited longest");
      const [app] = await container.db.select().from(applications).where(eq(applications.id, rue));
      await withPlatform(container.db, (tx) => anonymizeCandidate(tx, { companyId, candidateId: app.candidateId, actor: { kind: "user", id: "admin-test", name: "ITS admin" }, deleteFile: async () => {} }));
      const after = await snapshot();
      expect(JSON.stringify(after)).not.toContain("Rue");
      expect(after.board.people.some((p) => p.applicationId === rue)).toBe(false);
      expect(after.board.summary.longestWaiting).toBeNull();
      expect(after.board.summary.nextSteps.some((s) => s.applicationId === rue)).toBe(false);
      // everyone else is still there, and the request keeps its own words
      expect(after.board.people.map((p) => p.name)).toEqual(expect.arrayContaining(["Ada Pool", "Ben Pool"]));
      const [e] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, id));
      expect(e.question).toBe("Who should we call first?");
    });

    it("a flag reaches the ITS queue as a review of that candidate's reading; a second flag adds a note to it", async () => {
      const id = await seed("Lou", resultOf([yes(0, "RDH license CA active")]));
      const [asmt] = await container.db.select().from(assessments).where(eq(assessments.applicationId, id));
      const before = sent().filter((m) => m.subject.startsWith("[review]")).length;
      const first = (await (await json(owner, "POST", `/api/v1/applications/${id}/assessments/${asmt.id}/flag`, { kind: "false_negative", note: "She has years of perio work." })).json()) as { ok: boolean; review: { escalationId: string; created: boolean }; message: string };
      expect(first).toMatchObject({ ok: true, review: { created: true } });
      expect(first.message).toMatch(/ITS recruiter will check this AI review; follow it under Your recruiter requests on Home\./);
      const [e] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, first.review.escalationId));
      expect(e).toMatchObject({ kind: "review", applicationId: id, roleId });
      expect(e.question).toContain("it rates the candidate too low");
      expect(e.question).toContain("She has years of perio work.");
      expect(sent().filter((m) => m.subject.startsWith("[review]")).length).toBe(before + 1);
      // the queue email carries no customer words
      expect(sent().filter((m) => m.subject.startsWith("[review]")).at(-1)!.text).not.toContain("perio work");
      const second = (await (await json(owner, "POST", `/api/v1/applications/${id}/assessments/${asmt.id}/flag`, { kind: "wrong_evidence" })).json()) as { review: { escalationId: string; created: boolean } };
      expect(second.review).toEqual({ escalationId: first.review.escalationId, created: false });
      expect(await container.db.select().from(escalationMessages).where(eq(escalationMessages.escalationId, first.review.escalationId))).toHaveLength(1);
      const [after] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, first.review.escalationId));
      const flags = (after.contextSnapshot as { flags: Array<{ by: string; kind: string }> }).flags;
      expect(flags).toHaveLength(2);
      // the recruiter reads what was flagged, never who on the team flagged it
      expect(flags.map((f) => f.by)).toEqual(["user", "user"]);
      expect(JSON.stringify(flags)).not.toContain("Dana");
      // the first answer says what the recruiter will see once they pick it up, and for how long
      expect(first.message).toMatch(/they see this candidate and the role they applied for, until a day after they answer or 14 days at most/);
    });
  });

  describe("importance (F3) and the version label (F4)", () => {
    it("a person's importance is saved on a new version through the packet guard, with the weight kept in step, and changes the score", async () => {
      const role = await get<{ currentPacket: { version: number; packet: RolePacket } }>(`/api/v1/roles/${roleId}`);
      const next = structuredClone(role.currentPacket.packet);
      next.competencies[0].importance = "helpful";
      const r = await json(owner, "POST", `/api/v1/roles/${roleId}/packets`, { packet: next, changeSummary: "Clinical quality is helpful, not essential" });
      expect(r.status).toBe(201);
      const v = (await r.json()) as { version: number; packet: RolePacket; outcome: string };
      expect(v.version).toBe(role.currentPacket.version + 1);
      expect(v.packet.competencies[0]).toMatchObject({ importance: "helpful", weight: 1 });
      expect(v.outcome).toBe("approved_current");
      // a reading made against version 1 is labelled, everywhere it is shown
      const row = (await get<Array<Row & { readingVersion: { label: string } | null }>>(`/api/v1/roles/${roleId}/applications`)).find((x) => x.id === ids.ben)!;
      expect(row.readingVersion?.label).toBe(`Read against version 1 of the role; the role is now on version ${v.version}.`);
      const cmp = await get<{ candidates: Array<{ readingVersion: { readAgainst: number } | null }>; reminder: string }>(`/api/v1/roles/${roleId}/compare?ids=${ids.ben}`);
      expect(cmp.candidates[0].readingVersion).toMatchObject({ readAgainst: 1 });
      expect(cmp.reminder).toMatch(/^People decide\. Each match score is worked out from checked evidence/);
      // the weights preview (L-07 A) on Ben's card, read against version 1, with the first skill counted Helpful gives
      // what a reading against the new version gives; his real score stays the one of version 1
      const board = await get<BoardView>(`/api/v1/roles/${roleId}/board`);
      const ben = [...board.columns.shortlist, ...board.columns.longlist, ...board.columns.not_moving_forward].find((c) => c.applicationId === ids.ben)!;
      const benReadings = await container.db.select().from(assessments).where(eq(assessments.applicationId, ids.ben));
      expect(ben.readingVersion).toMatchObject({ readAgainst: 1 });
      expect(ben.score!.score).toBe(matchScore(readingPair(benReadings), packet)!.score);
      const helpful = previewMatch(ben.score!, (c) => (!c.mustHave && c.key === next.competencies[0].key ? 1 : matchWeightOf(c)));
      expect(helpful.score).toBe(matchScore(readingPair(benReadings), v.packet)!.score);
      expect(helpful.score).not.toBe(ben.score!.score);
      // a new reading against the new version uses its importance
      const fresh = await seed("Max", resultOf([yes(0, "RDH license CA active"), yes(1, "perio")], { competencyFindings: [{ competencyKey: next.competencies[0].key, finding: "contradicted", evidence: { source: "resume", quote: "I rush cleanings" } }] }), { packetVersion: v.version });
      const max = (await get<Row[]>(`/api/v1/roles/${roleId}/applications`)).find((x) => x.id === fresh)!;
      // must-haves 4 + 4 met, the Helpful skill (1) goes against it: 8 of 9
      expect(max.score).toBe(89);
    });
  });

  describe("the fake reads its sample résumés three ways, so the board has all three columns locally", () => {
    async function apply(first: string, resume: string) {
      const fd = new FormData();
      fd.set("firstName", first); fd.set("lastName", "Sample"); fd.set("email", `${first.toLowerCase()}@sample.test`);
      fd.set("resume", new File([resume], `${first.toLowerCase()}.txt`, { type: "text/plain" }));
      for (const r of elig) fd.set(`elig_${r.key}`, "yes");
      fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
      fd.set("acknowledged", "yes");
      const res = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
      expect(res.status).toBe(302);
      await container.drain();
      const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, `${first.toLowerCase()}@sample.test`));
      return (await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id))))[0].id;
    }

    it("strong on the Shortlist, possible on the Longlist, no licence (said plainly) under Not moving forward", async () => {
      const strong = await apply("Sol", FAKE_SAMPLE_RESUMES.strong);
      const possible = await apply("Pat", FAKE_SAMPLE_RESUMES.possible);
      const weak = await apply("Wes", FAKE_SAMPLE_RESUMES.weak);
      // every applicant is invited to the AI interview (R20-4) and waits in the read-only lane "No AI interview yet" until it
      // is done, never placed or suggested (R20-7), however their résumé reads
      const waiting = await get<BoardView>(`/api/v1/roles/${roleId}/board`);
      expect(waiting.noAiInterview.map((c) => c.applicationId)).toEqual(expect.arrayContaining([strong, possible, weak]));
      for (const c of waiting.noAiInterview.filter((x) => [strong, possible, weak].includes(x.applicationId))) expect(c.placement).toMatchObject({ column: null, state: "waiting", suggestedAction: null, doneLabel: "No AI interview yet" });
      // a lapsed link keeps them there
      await container.db.update(screens).set({ status: "expired" }).where(inArray(screens.applicationId, [strong, possible, weak]));
      const lapsed = await get<BoardView>(`/api/v1/roles/${roleId}/board`);
      expect(lapsed.noAiInterview.filter((c) => [strong, possible, weak].includes(c.applicationId)).map((c) => c.aiInterview?.state)).toEqual(["link_expired", "link_expired", "link_expired"]);
      // the team reviews them without it (as "Stop this AI interview invitation" does): in New, but their score is still the
      // résumé's alone, so the board keeps them apart from interviewed people, never suggested (R20-9)
      await container.db.update(applications).set({ stage: "triaged" }).where(inArray(applications.id, [strong, possible, weak]));
      const apart = await get<BoardView>(`/api/v1/roles/${roleId}/board`);
      const kept = apart.noAiInterview.filter((c) => [strong, possible, weak].includes(c.applicationId));
      expect(kept.map((c) => [c.placement.column, c.placement.state, c.placement.suggestedAction, c.placement.doneLabel, c.score?.basis])).toEqual([strong, possible, weak].map(() => [null, "waiting", null, "No AI interview", "Résumé only: no AI interview"]));
      // once each AI interview is sent and scored (here its scorecard says what the résumé said), the board places them
      for (const id of [strong, possible, weak]) {
        const [read] = await container.db.select().from(assessments).where(and(eq(assessments.applicationId, id), eq(assessments.kind, "triage")));
        const [scorecard] = await container.db.insert(assessments).values({ companyId, applicationId: id, kind: "screen", packetVersion: read.packetVersion, result: read.result, overall: read.overall, confidence: read.confidence }).returning();
        await container.db.update(screens).set({ status: "completed", completedAt: new Date().toISOString(), assessmentId: scorecard.id }).where(eq(screens.applicationId, id));
      }
      const b = await get<BoardView>(`/api/v1/roles/${roleId}/board`);
      const where = (id: string) => [...b.columns.shortlist, ...b.columns.longlist, ...b.columns.not_moving_forward].find((c) => c.applicationId === id)!;
      expect(where(strong).placement.column).toBe("shortlist");
      expect(where(strong).score?.band).toMatch(/high/);
      // "possible" shows a must-have only in part: since Wave S7 that costs the score nothing against its other evidence
      // (showing some never scores below showing none), so the board asks for more instead of the Shortlist
      expect(where(possible).placement).toMatchObject({ column: "longlist", confident: true, nextStep: { kind: "ask_more" } });
      expect(where(possible).placement.nextStep?.reason).toMatch(/^Their application only partly shows /);
      expect(where(possible).score?.breakdown.some((c) => c.mustHave && c.pctMet === 50 && c.countedPct !== undefined)).toBe(true);
      expect(where(weak).placement.column).toBe("not_moving_forward");
      expect(where(weak).score?.missingMustHave.map((m) => m.quote)).toEqual(["I do not hold a CA RDH license"]);
      expect(where(weak).reading).toBe("Weak match");
      for (const id of [strong, possible, weak]) expect(where(id).score).toMatchObject({ interview: "done", basis: "From the résumé and the AI interview" });
    });
  });

  describe("a reading made against a version of the role whose must-haves have changed since (F4, F6)", () => {
    it("is never a decline ticked in advance, and the board and Review and apply say why", async () => {
      const oz = await seed("Oz", resultOf([{ requirementKey: must(0).key, met: "no", evidence: { source: "resume", quote: "RDH license CA expired in 2021" } }, yes(1, "Periodontal charting daily")], { overall: "weak", recommendation: "hold" }));
      const row = async () => (await get<Array<Row & { readingVersion: { readAgainst: number; mustHavesChanged?: boolean; label: string } | null }>>(`/api/v1/roles/${roleId}/applications`)).find((r) => r.id === oz)!;
      // the role has moved on since version 1, but only the importance of a skill changed: the decline stands
      expect((await row()).placement).toMatchObject({ column: "not_moving_forward", confident: true });
      const role = await get<{ currentPacket: { version: number; packet: RolePacket } }>(`/api/v1/roles/${roleId}`);
      const next = structuredClone(role.currentPacket.packet);
      next.requirements.mustHaves = next.requirements.mustHaves.filter((m) => m.key !== must(0).key);
      const r = await json(owner, "POST", `/api/v1/roles/${roleId}/packets`, { packet: next, changeSummary: "The license is checked at hire instead" });
      expect(((await r.json()) as { outcome: string }).outcome).toBe("approved_current");
      const after = await row();
      expect(after.readingVersion).toMatchObject({ readAgainst: 1, mustHavesChanged: true });
      expect(after.readingVersion!.label).toContain("Its must-haves have changed since.");
      expect(after.placement).toMatchObject({ column: "longlist", confident: false, needsYourEye: "Read against version 1 of the role, and the must-haves have changed since. Check them against the role as it is now." });
      const p = (await (await json(owner, "POST", `/api/v1/roles/${roleId}/batch`, { dryRun: true, items: [{ applicationId: oz, action: "not_moving_forward" }] })).json()) as BatchPreview;
      expect(p.items[0].warnings).toEqual(expect.arrayContaining([expect.stringContaining("must-haves have changed since"), "The board suggested Longlist."]));
    });
  });

  describe("an ITS recruiter given one candidate sees that candidate only (staff scoping)", () => {
    it("on the board, the questions, Review and apply and Today, and is refused another role", async () => {
      const uma = await seed("Uma", resultOf([yes(0, "RDH license CA active"), yes(1, "Periodontal charting daily")]));
      const [asmt] = await container.db.select().from(assessments).where(eq(assessments.applicationId, uma));
      const flagged = (await (await json(owner, "POST", `/api/v1/applications/${uma}/assessments/${asmt.id}/flag`, { kind: "false_positive" })).json()) as { review: { escalationId: string } };
      const recruiter = await signInStaff(app, container, "ria@its.test", "its_recruiter", "Ria");
      expect((await json(recruiter, "POST", `/api/v1/escalations/${flagged.review.escalationId}/claim`)).status).toBe(200);
      expect((await json(recruiter, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
      const others = ["Ada Pool", "Ben Pool", "Cy Pool", "Dee Pool", "Oz Pool"];
      const leaks = (body: unknown) => others.filter((n) => JSON.stringify(body).includes(n));
      // the board: Uma alone, and a summary built from her alone
      const b = await get<BoardView>(`/api/v1/roles/${roleId}/board`, recruiter);
      expect([...b.columns.shortlist, ...b.columns.longlist, ...b.columns.not_moving_forward, ...b.noAiInterview].map((c) => c.applicationId)).toEqual([uma]);
      expect(b.summary.total).toBe(1);
      expect(leaks(b)).toEqual([]);
      // the questions answer over her alone, and Compare leaves out anyone else named
      const missing = await get<PoolAnswer>(`/api/v1/roles/${roleId}/questions/missing_must_have`, recruiter);
      expect(missing.lookedAt.people).toBe(1);
      expect(leaks(missing)).toEqual([]);
      const compare = await get<PoolAnswer & { compare: { candidates: Array<{ id?: string; name: string }> } }>(`/api/v1/roles/${roleId}/questions/compare?ids=${uma},${ids.ada}`, recruiter);
      expect(compare.compare.candidates.map((c) => c.name)).toEqual(["Uma Pool"]);
      expect(leaks(compare)).toEqual([]);
      // Review and apply's preview names nobody outside the grant
      const p = (await (await json(recruiter, "POST", `/api/v1/roles/${roleId}/batch`, { dryRun: true, items: [{ applicationId: uma, action: "longlist" }, { applicationId: ids.ada, action: "shortlist" }] })).json()) as BatchPreview;
      expect(p.items.map((i) => [i.name, i.allowed])).toEqual([["Uma Pool", true], ["Unknown", false]]);
      expect(p.items[1]).toMatchObject({ score: null, refusedReason: "Not a candidate of this role." });
      // Today names nobody else
      expect(leaks(await get<unknown>("/api/v1/brief", recruiter))).toEqual([]);
      // another role is outside the grant altogether
      const other = await json(recruiter, "GET", "/api/v1/roles/00000000-0000-7000-8000-000000000001/board");
      expect(other.status).toBe(403);
      expect(((await other.json()) as { error: { code: string } }).error.code).toBe("staff_scope");
      expect((await json(recruiter, "GET", "/api/v1/roles/00000000-0000-7000-8000-000000000001/questions/overlooked")).status).toBe(403);
    });

    it("a later flag on a request the recruiter holds tells them there is a note, never its words", async () => {
      const [held] = await container.db.select().from(recruiterEscalations).where(and(eq(recruiterEscalations.kind, "review"), eq(recruiterEscalations.status, "claimed")));
      const [asmt] = await container.db.select().from(assessments).where(eq(assessments.applicationId, held.applicationId!));
      const before = sent().length;
      const r = (await (await json(owner, "POST", `/api/v1/applications/${held.applicationId}/assessments/${asmt.id}/flag`, { kind: "missing_context", note: "She trained at the clinic down the road." })).json()) as { review: { created: boolean } };
      expect(r.review.created).toBe(false);
      const mail = sent().slice(before).filter((m) => m.to === "ria@its.test");
      expect(mail).toHaveLength(1);
      expect(mail[0].subject).toBe("[review] The customer added a note to a request you hold");
      expect(mail[0].text).not.toContain("clinic");
    });
  });

  describe("the score after both the résumé and the AI interview: honest labels, like with like (20 October 2026, R20-9)", () => {
    /** One screen of theirs and, with `scorecard`, its reading (kind "screen", as the AI interview's run writes it). */
    const screenOf = (applicationId: string, status: string, scorecard?: EvidenceAssessment) =>
      withTenant(container.db, companyId, async (tx) => {
        const assessmentId = scorecard ? (await tx.insert(assessments).values({ companyId, applicationId, kind: "screen", packetVersion: 1, result: scorecard, overall: scorecard.overall, confidence: scorecard.confidence }).returning())[0].id : null;
        await tx.insert(screens).values({ companyId, applicationId, channel: "web", status, token: `scr${randomToken(8)}`, invitedVia: "with_application", assessmentId, ...(status === "completed" ? { completedAt: new Date().toISOString() } : {}) });
      });
    type Scored = Row & { interview: string | null; basis: string | null };

    it("labels each score by where the AI interview stands, keeps résumé-only scores off the columns and out of Review and apply, and sorts the interviewed first", async () => {
      const both = [yes(0, "RDH license CA active"), yes(1, "Periodontal charting daily")];
      // Ivo: his AI interview is sent and scored; in it one skill goes against him, so his number is below Wyn's
      const against = resultOf(both, { competencyFindings: packet.competencies.map((c, i) => ({ competencyKey: c.key, finding: i === 0 ? "contradicted" : "evidenced", evidence: { source: "resume", quote: i === 0 ? "I prefer not to do this" : `${c.name} shown` } })) });
      const ivo = await seed("Ivo", resultOf(both));
      await screenOf(ivo, "completed", against);
      // Wyn: a résumé that shows everything; invited, not started
      const wyn = await seed("Wyn", resultOf(both, { overall: "strong" }));
      await screenOf(wyn, "invited");
      await container.db.update(applications).set({ stage: "screen_invited" }).where(eq(applications.id, wyn));
      // Rae: sent a moment ago, the scorecard not written yet
      const rae = await seed("Rae", resultOf(both, { overall: "strong" }));
      await screenOf(rae, "completed");
      await container.db.update(applications).set({ stage: "screen_complete" }).where(eq(applications.id, rae));
      // Kit: the team stopped the invitation before she started, and reviews her without it (New)
      const kit = await seed("Kit", resultOf(both, { overall: "strong" }));
      await screenOf(kit, "cancelled");
      // Ned: never offered one (as before 20 October 2026); Nil: nothing read at all
      const ned = await seed("Ned", resultOf(both, { overall: "strong" }));
      const nil = await seed("Nil", null);

      // the list: the label beside each score, and the number exactly as the pure function gives it without one
      const rows = await get<Scored[]>(`/api/v1/roles/${roleId}/applications`);
      const row = (id: string) => rows.find((r) => r.id === id)!;
      expect(row(ivo)).toMatchObject({ interview: "done", basis: "From the résumé and the AI interview" });
      expect(row(wyn)).toMatchObject({ interview: "not_done_yet", basis: "Résumé only: AI interview not done yet" });
      expect(row(rae)).toMatchObject({ interview: "being_scored", basis: "Résumé only for now: AI interview done, being scored" });
      expect(row(kit)).toMatchObject({ interview: "not_done", basis: "Résumé only: no AI interview" });
      expect(row(ned)).toMatchObject({ interview: "none", basis: "Résumé only: no AI interview" });
      expect(row(nil)).toMatchObject({ score: null, interview: null, basis: null });
      for (const id of [ivo, wyn, rae, kit]) {
        const own = await container.db.select().from(assessments).where(eq(assessments.applicationId, id));
        expect(row(id).score, id).toBe(matchScore(readingPair(own), packet)!.score);
      }
      expect(row(wyn).score).toBeGreaterThan(row(ivo).score!);

      // Sort: Score: the interviewed first, then the résumé-only scores, each highest first; no score last
      const mine = [ivo, wyn, rae, kit, ned, nil];
      for (const q of ["order=score", "sort=score"]) {
        const ordered = (await get<Scored[]>(`/api/v1/roles/${roleId}/applications?${q}`)).filter((r) => mine.includes(r.id)).map((r) => r.id);
        expect(ordered[0], q).toBe(ivo);
        expect(new Set(ordered.slice(1, 5)), q).toEqual(new Set([wyn, rae, kit, ned]));
        expect(ordered[5], q).toBe(nil);
      }

      // the candidate's page and Compare carry the same label
      expect((await get<{ matchScore: MatchScore }>(`/api/v1/applications/${wyn}`)).matchScore).toMatchObject({ interview: "not_done_yet", basis: "Résumé only: AI interview not done yet" });
      const compared = await get<{ candidates: Array<{ applicationId: string; score: MatchScore | null }> }>(`/api/v1/roles/${roleId}/compare?ids=${ivo},${kit}`);
      expect(compared.candidates.map((c) => c.score?.basis)).toEqual(["From the résumé and the AI interview", "Résumé only: no AI interview"]);

      // the board: Ivo on a column; the others in the lane with the board's own words, never placed or suggested
      const b = await get<BoardView>(`/api/v1/roles/${roleId}/board`);
      const onColumns = [...b.columns.shortlist, ...b.columns.longlist, ...b.columns.not_moving_forward];
      expect(onColumns.find((c) => c.applicationId === ivo)?.placement.state).toBe("suggested");
      for (const id of [wyn, rae, kit]) expect(onColumns.some((c) => c.applicationId === id), id).toBe(false);
      const lane = (id: string) => b.noAiInterview.find((c) => c.applicationId === id)!;
      expect(lane(wyn).placement).toMatchObject({ column: null, state: "waiting", suggestedAction: null, doneLabel: "No AI interview yet" });
      expect(lane(rae).placement).toMatchObject({ column: null, state: "waiting", suggestedAction: null, doneLabel: "AI interview being scored" });
      expect(lane(kit).placement).toMatchObject({ column: null, state: "waiting", suggestedAction: null, doneLabel: "No AI interview" });
      expect([lane(rae).facts.noAiInterview, lane(kit).facts.noAiInterview]).toEqual([true, true]);

      // Review and apply never reaches them, whatever is asked (B4 narrowed to match)
      const p = (await (await json(owner, "POST", `/api/v1/roles/${roleId}/batch`, { dryRun: true, items: [{ applicationId: ivo, action: "longlist" }, { applicationId: rae, action: "shortlist" }, { applicationId: kit, action: "not_moving_forward", reason: "not_a_match_skills" }] })).json()) as BatchPreview;
      expect(p.items.map((i) => i.allowed)).toEqual([true, false, false]);
      expect(p.items[1].refusedReason).toBe("Their AI interview is being scored; they join the board when it is. Decide from their own page if you need to.");
      // Kit's invitation was stopped: she cannot finish it, so the refusal never says she joins when she does
      expect(p.items[2].refusedReason).toBe("They have no AI interview and none is open, so the board leaves them out. Decide from their own page, or send them a new AI interview link.");
    });

    it("keeps apart someone whose AI interview never came because the month's interviews stayed used up (Q17), unlike one never offered it", async () => {
      // Lu: a low résumé score (her own words show the licence lapsed), and no screen: the screen run waited sixty days
      // for more AI interviews, then moved her to New (as `waitForAllowance` does). Ola: the same, from before 20 October.
      const low = resultOf([{ requirementKey: must(0).key, met: "no", evidence: { source: "resume", quote: "RDH license CA expired in 2021" } }, yes(1, "Periodontal charting")], { overall: "weak", recommendation: "hold" });
      const lu = await seed("Lu", low);
      const ola = await seed("Ola", low);
      await container.db.insert(events).values({ companyId, type: "screen.allowance_lapsed", actor: { kind: "system", id: "workflow" }, subjectType: "application", subjectId: lu, payload: { waitingSince: new Date().toISOString(), days: 60, promised: true } });

      const rows = await get<Scored[]>(`/api/v1/roles/${roleId}/applications`);
      expect(rows.find((r) => r.id === lu)).toMatchObject({ interview: "not_done", basis: "Résumé only: no AI interview" });
      expect(rows.find((r) => r.id === ola)).toMatchObject({ interview: "none", basis: "Résumé only: no AI interview" });
      expect((await get<{ matchScore: MatchScore; placement: { column: string | null } }>(`/api/v1/applications/${lu}`))).toMatchObject({ matchScore: { interview: "not_done" }, placement: { column: null } });
      const compared = await get<{ candidates: Array<{ score: MatchScore | null }> }>(`/api/v1/roles/${roleId}/compare?ids=${lu},${ola}`);
      expect(compared.candidates.map((c) => c.score?.interview)).toEqual(["not_done", "none"]);

      // the board: Lu in the lane, never suggested; Ola placed by today's rules, as before 20 October
      const b = await get<BoardView>(`/api/v1/roles/${roleId}/board`);
      const onColumns = [...b.columns.shortlist, ...b.columns.longlist, ...b.columns.not_moving_forward];
      expect(b.noAiInterview.find((c) => c.applicationId === lu)?.placement).toMatchObject({ column: null, state: "waiting", suggestedAction: null, doneLabel: "No AI interview" });
      expect(onColumns.some((c) => c.applicationId === lu)).toBe(false);
      expect(onColumns.find((c) => c.applicationId === ola)?.placement).toMatchObject({ state: "suggested", suggestedAction: expect.any(String) });

      // Review and apply refuses Lu, with words that never promise an interview she cannot do; Ola may be applied
      const p = (await (await json(owner, "POST", `/api/v1/roles/${roleId}/batch`, { dryRun: true, items: [{ applicationId: lu, action: "not_moving_forward", reason: "not_a_match_skills" }, { applicationId: ola, action: "not_moving_forward", reason: "not_a_match_skills" }] })).json()) as BatchPreview;
      expect(p.items.map((i) => [i.name, i.allowed])).toEqual([["Lu Pool", false], ["Ola Pool", true]]);
      expect(p.items[0].refusedReason).toBe("They have no AI interview and none is open, so the board leaves them out. Decide from their own page, or send them a new AI interview link.");
    });
  });
});
