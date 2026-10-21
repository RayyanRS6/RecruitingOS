import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor, EvidenceAssessment, MatchScore, NoteView, OwnerStage, ReadingVersion, ScreenAssessment } from "@ros/contracts";
import { STAGE_LABEL, activeFollowUpsFor, activeMarksFor, assertCan, audit, groupFor, interviewInScore, matchScore, ownerStage, ownerStageLabel, readingPair, readingVersion, unsentScreenReadings } from "@ros/core";
import { applications, assessments, candidates, rolePackets, roles, screens, withTenant, type Tx } from "@ros/db";
import { interviewsLapsedOnAllowance } from "@ros/workflows";
import { actorOf, requireTenant, roleScopeGuard, type Tenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { notesForApplications } from "../services/notes";
import { currentVersionOf } from "../services/packet-versions";

/**
 * The comparison view (docs/spec/21 F10): up to five candidates of one role side by side, each must-have and
 * competency as a row with the evidence's finding as a chip, and each person's match score (founder decision B2). The
 * columns come back in the order the person chose. Interviewers cannot open it (no application.read). A reading made
 * against an earlier version of the role is labelled (plan F4): its rows are matched by the current version's keys, so a
 * must-have that changed shows blank rather than borrowing an answer to a different question. The team's private notes
 * on each person come along for those who read notes (plan H3).
 */
export const COMPARE_MAX = 5;
/** Postgres refuses anything else for the id column; an id that is not one is left out, like an unknown id, rather than answered with a 500. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const compareRoutes = new Hono<Vars>();
compareRoutes.use("/:id/*", roleScopeGuard);

type AssessmentRow = typeof assessments.$inferSelect;

export type CompareCandidate = {
  applicationId: string;
  name: string;
  stage: string;
  stageLabel: string;
  group: string;
  /** Where they sit on the stage strip, private marks included (founder decision B3). */
  ownerStage: OwnerStage;
  ownerStageLabel: string;
  mustHaves: Record<string, { met: string; quote: string | null }>;
  competencies: Record<string, { finding: string; note: string | null }>;
  screen: { recommendation: string; summary: string } | null;
  resume: { overall: string; recommendation: string; summary: string } | null;
  /** Must-haves and competencies with no finding or an unknown one, plus the open questions the newest assessment left. */
  unknownCount: number;
  /** The match score worked out from their findings, against the version of the role they were read against; `basis` says whether the AI interview is in it (R20-9). */
  score: MatchScore | null;
  /** Set when the reading was made against an earlier version of the role than the one shown. */
  readingVersion: ReadingVersion | null;
  /** The team's private notes on them (plan H3), oldest first; empty for anyone who does not read notes. */
  notes: NoteView[];
  open: string;
};

export const COMPARE_REMINDER = "People decide. Each match score is worked out from checked evidence, with the breakdown on the person's page. A blank cell means the evidence has not spoken yet.";

/**
 * The comparison itself, for the route below and for the board's "Compare these" (plan F10). Every candidate shown is
 * audited as viewed. Null when the role is not visible.
 */
export async function compareCandidates(tx: Tx, input: { roleId: string; ids: string[]; tenant: Tenant; actor: Actor; now: Date }) {
  const { tenant: t } = input;
  const ids = input.ids.filter((s) => UUID.test(s));
  const [role] = await tx.select().from(roles).where(eq(roles.id, input.roleId)).limit(1);
  if (!role) return null;
  const apps = ids.length ? (await tx.select().from(applications).where(and(eq(applications.roleId, role.id), inArray(applications.id, ids)))).filter((a) => !t.staff?.scope.applicationId || a.id === t.staff.scope.applicationId) : [];
  const packets = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
  const currentRow = currentVersionOf(role, packets) ?? packets[0] ?? null;
  const packet = currentRow?.packet ?? null;
  const byVersion = new Map(packets.map((p) => [p.version, p.packet]));
  const mustHaves = packet?.requirements.mustHaves.map((m) => ({ key: m.key, text: m.text })) ?? [];
  const competencies = packet?.competencies.map((x) => ({ key: x.key, name: x.name, definition: x.definition })) ?? [];
  const cands = apps.length ? await tx.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(inArray(candidates.id, apps.map((a) => a.candidateId))) : [];
  // Never a reading of a conversation the candidate did not send (founder decision of 9 October 2026).
  const all = apps.length ? await tx.select().from(assessments).where(inArray(assessments.applicationId, apps.map((a) => a.id))).orderBy(desc(assessments.createdAt)) : [];
  // Their screens, in any order: also where each one's AI interview stands, for the score's label (R20-9).
  const scr = apps.length ? await tx.select({ applicationId: screens.applicationId, status: screens.status, assessmentId: screens.assessmentId }).from(screens).where(inArray(screens.applicationId, apps.map((a) => a.id))) : [];
  const hidden = unsentScreenReadings(scr, all);
  const asmts = all.filter((x) => !hidden.has(x.id));
  // An AI interview that never came for want of allowance (Q17) reads as not done, as on the list and the board.
  const lapsed = await interviewsLapsedOnAllowance(tx, apps.filter((a) => !scr.some((s) => s.applicationId === a.id)).map((a) => a.id));
  const marks = await activeMarksFor(tx, apps.map((a) => a.id));
  // Under Cancelled (founder decisions 1A to 4A), as on the Talent list.
  const followUps = await activeFollowUpsFor(tx, apps.map((a) => a.id));
  const notes = await notesForApplications(tx, { applicationIds: apps.map((a) => a.id), tenant: t });
  const rows: CompareCandidate[] = [];
  for (const id of ids) {
    const a = apps.find((x) => x.id === id);
    if (!a) continue;
    const cand = cands.find((x) => x.id === a.candidateId);
    const own = asmts.filter((x) => x.applicationId === a.id);
    const screen = (own.find((x) => x.kind === "screen") as (AssessmentRow & { result: ScreenAssessment }) | undefined) ?? null;
    const resume = (own.find((x) => x.kind !== "screen") as (AssessmentRow & { result: EvidenceAssessment }) | undefined) ?? null;
    const newest = own[0] ?? null;
    // The screen's finding wins where both looked at the same thing: the candidate spoke to it directly.
    const mh: CompareCandidate["mustHaves"] = {};
    for (const m of mustHaves) {
      const f = screen?.result.requirementFindings?.find((r) => r.requirementKey === m.key) ?? resume?.result.requirementFindings?.find((r) => r.requirementKey === m.key);
      if (f) mh[m.key] = { met: f.met, quote: f.evidence?.quote ?? null };
    }
    const comp: CompareCandidate["competencies"] = {};
    for (const x of competencies) {
      const f = screen?.result.competencyFindings?.find((r) => r.competencyKey === x.key) ?? resume?.result.competencyFindings?.find((r) => r.competencyKey === x.key);
      if (f) comp[x.key] = { finding: f.finding, note: f.note ?? null };
    }
    const unknownCount = mustHaves.filter((m) => !mh[m.key] || mh[m.key].met === "unknown").length + competencies.filter((x) => !comp[x.key]).length + (newest?.result.unknowns.length ?? 0);
    await audit(tx, { companyId: t.companyId, actor: input.actor, action: "candidate.viewed", target: { type: "application", id: a.id }, reason: "comparison view" });
    const mark = marks.get(a.id) ?? null;
    const followUp = followUps.get(a.id) ?? null;
    const strip = ownerStage(a, mark, followUp);
    const readAgainst = newest?.packetVersion ?? a.packetVersion;
    const scorePacket = byVersion.get(readAgainst) ?? packet;
    rows.push({
      applicationId: a.id,
      name: `${cand?.firstName ?? ""} ${cand?.lastName ?? ""}`.trim() || "Unknown",
      stage: a.stage,
      stageLabel: STAGE_LABEL[a.stage],
      group: groupFor(a, mark, input.now, followUp),
      ownerStage: strip,
      ownerStageLabel: ownerStageLabel(strip, mark, followUp),
      mustHaves: mh,
      competencies: comp,
      screen: screen ? { recommendation: screen.result.recommendation, summary: screen.result.summary } : null,
      resume: resume ? { overall: resume.overall, recommendation: resume.result.recommendation, summary: resume.result.summary } : null,
      unknownCount,
      score: scorePacket ? matchScore(readingPair(own), scorePacket, { packetVersion: readAgainst, interview: interviewInScore(scr.filter((s) => s.applicationId === a.id), a.stage, { allowanceLapsed: lapsed.has(a.id) }) }) : null,
      readingVersion: newest ? readingVersion(readAgainst, currentRow?.version ?? null, { was: byVersion.get(readAgainst), now: packet }) : null,
      notes: notes.get(a.id) ?? [],
      open: `/roles/${role.id}/talent?open=${a.id}`,
    });
  }
  return { role: { id: role.id, title: role.title }, version: currentRow?.version ?? null, mustHaves, competencies, candidates: rows, max: COMPARE_MAX, reminder: COMPARE_REMINDER };
}

compareRoutes.get("/:id/compare", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const asked = [...new Set((c.req.query("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (!asked.length) throw new HttpError(400, "invalid_request", "Choose at least one candidate to compare.");
  if (asked.length > COMPARE_MAX) throw new HttpError(400, "too_many", `Compare up to ${COMPARE_MAX} candidates at a time.`);
  if (!asked.some((s) => UUID.test(s))) throw new HttpError(400, "invalid_request", "None of those are candidates of this role.");
  const out = await withTenant(c.get("container").db, t.companyId, (tx) => compareCandidates(tx, { roleId: c.req.param("id") ?? "", ids: asked, tenant: t, actor: actorOf(c), now: c.get("container").engine.clock() }));
  if (!out) throw new HttpError(404, "not_found", "Role not found.");
  return c.json(out);
});
