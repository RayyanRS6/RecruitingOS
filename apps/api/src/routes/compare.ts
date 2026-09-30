import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { EvidenceAssessment, ScreenAssessment } from "@ros/contracts";
import { STAGE_LABEL, assertCan, audit, ownerGroup } from "@ros/core";
import { applications, assessments, candidates, rolePackets, roles, withTenant } from "@ros/db";
import { actorOf, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { currentVersionOf } from "../services/packet-versions";

/**
 * The comparison view (docs/spec/21 F10): up to five candidates of one role side by side, each must-have and
 * competency as a row with the evidence's finding as a chip. Nothing is ranked or scored; the columns come back in
 * the order the person chose, and the page says so. Interviewers cannot open it (no application.read).
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
  mustHaves: Record<string, { met: string; quote: string | null }>;
  competencies: Record<string, { finding: string; note: string | null }>;
  screen: { recommendation: string; summary: string } | null;
  resume: { overall: string; recommendation: string; summary: string } | null;
  /** Must-haves and competencies with no finding or an unknown one, plus the open questions the newest assessment left. */
  unknownCount: number;
  open: string;
};

compareRoutes.get("/:id/compare", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const asked = [...new Set((c.req.query("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (!asked.length) throw new HttpError(400, "invalid_request", "Choose at least one candidate to compare.");
  if (asked.length > COMPARE_MAX) throw new HttpError(400, "too_many", `Compare up to ${COMPARE_MAX} candidates at a time.`);
  const ids = asked.filter((s) => UUID.test(s));
  if (!ids.length) throw new HttpError(400, "invalid_request", "None of those are candidates of this role.");
  const roleId = c.req.param("id");
  const out = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    if (!role) return null;
    const apps = (await tx.select().from(applications).where(and(eq(applications.roleId, role.id), inArray(applications.id, ids)))).filter((a) => !t.staff?.scope.applicationId || a.id === t.staff.scope.applicationId);
    const packets = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
    const packet = (currentVersionOf(role, packets) ?? packets[0])?.packet ?? null;
    const mustHaves = packet?.requirements.mustHaves.map((m) => ({ key: m.key, text: m.text })) ?? [];
    const competencies = packet?.competencies.map((x) => ({ key: x.key, name: x.name, definition: x.definition })) ?? [];
    const cands = apps.length ? await tx.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(inArray(candidates.id, apps.map((a) => a.candidateId))) : [];
    const asmts = apps.length ? await tx.select().from(assessments).where(inArray(assessments.applicationId, apps.map((a) => a.id))).orderBy(desc(assessments.createdAt)) : [];
    const rows: CompareCandidate[] = [];
    for (const id of ids) {
      const a = apps.find((x) => x.id === id);
      if (!a) continue;
      const cand = cands.find((x) => x.id === a.candidateId);
      const screen = (asmts.find((x) => x.applicationId === a.id && x.kind === "screen") as (AssessmentRow & { result: ScreenAssessment }) | undefined) ?? null;
      const resume = (asmts.find((x) => x.applicationId === a.id && x.kind !== "screen") as (AssessmentRow & { result: EvidenceAssessment }) | undefined) ?? null;
      const newest = asmts.find((x) => x.applicationId === a.id) ?? null;
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
      await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "candidate.viewed", target: { type: "application", id: a.id }, reason: "comparison view" });
      rows.push({
        applicationId: a.id,
        name: `${cand?.firstName ?? ""} ${cand?.lastName ?? ""}`.trim() || "Unknown",
        stage: a.stage,
        stageLabel: STAGE_LABEL[a.stage],
        group: ownerGroup(a.stage),
        mustHaves: mh,
        competencies: comp,
        screen: screen ? { recommendation: screen.result.recommendation, summary: screen.result.summary } : null,
        resume: resume ? { overall: resume.overall, recommendation: resume.result.recommendation, summary: resume.result.summary } : null,
        unknownCount,
        open: `/roles/${role.id}/talent?open=${a.id}`,
      });
    }
    return { role: { id: role.id, title: role.title }, mustHaves, competencies, candidates: rows, max: COMPARE_MAX, reminder: "People decide. Nothing here is ranked or scored; the columns are in the order you chose, and a blank cell means the evidence has not spoken yet." };
  });
  if (!out) throw new HttpError(404, "not_found", "Role not found.");
  return c.json(out);
});
