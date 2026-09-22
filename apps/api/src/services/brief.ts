import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { STAGE_LABEL, ownerGroup } from "@ros/core";
import { detectStuckRoles } from "@ros/agents";
import { applications, approvalRequests, assessments, candidates, events, postings, recruiterEscalations, roles, screens, type Tx } from "@ros/db";

const CHANNEL_NAME: Record<string, string> = { careers_page: "your careers page", google_jobs: "Google for Jobs", email_in: "email-in capture", linkedin_basic: "LinkedIn", indeed: "Indeed", ziprecruiter: "ZipRecruiter" };

export type BriefCard = {
  kind: "new_applicants" | "needs_review" | "decision" | "posting_action" | "escalation" | "stuck" | "screening" | "empty";
  title: string;
  body: string;
  roleId?: string;
  applicationId?: string;
  approvalRequestId?: string;
  actions: Array<{ label: string; method: "GET" | "POST"; path: string; body?: Record<string, unknown> }>;
};

/**
 * The morning brief, Slice 1: deterministic, from the system of record. The orchestrator agent replaces the
 * prose in a later slice; the sections and actions stay the same.
 */
export async function composeBrief(tx: Tx, companyId: string): Promise<{ generatedAt: string; cards: BriefCard[]; summary: string }> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const cards: BriefCard[] = [];
  const openRoles = await tx.select().from(roles).where(and(eq(roles.companyId, companyId), inArray(roles.status, ["open", "paused", "pending_approval"])));

  const pending = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.status, "pending"))).orderBy(desc(approvalRequests.createdAt));
  for (const p of pending) {
    const role = openRoles.find((r) => r.id === p.roleId);
    if (p.actionType === "role_packet.approve") {
      cards.push({ kind: "decision", title: `Approve the role: ${role?.title ?? "new role"}`, body: p.rationale ?? "Review the role packet and approve it to start posting.", roleId: p.roleId ?? undefined, approvalRequestId: p.id, actions: [{ label: "Review and approve", method: "GET", path: `/roles/${p.roleId}` }] });
    } else if (p.actionType === "application.invite_screen" || p.actionType === "application.recommend_interview") {
      const verb = p.actionType === "application.invite_screen" ? "Invite to a screen" : "Interview";
      cards.push({ kind: "decision", title: `${verb}? ${role?.title ?? ""}`.trim(), body: p.rationale ?? "", roleId: p.roleId ?? undefined, applicationId: p.applicationId ?? undefined, approvalRequestId: p.id, actions: [{ label: `Yes, ${verb.toLowerCase()}`, method: "POST", path: `/api/v1/approvals/${p.id}/decide`, body: { decision: "approve" } }, { label: "Review first", method: "GET", path: `/roles/${p.roleId}/people` }] });
    } else {
      cards.push({ kind: "decision", title: `Decision needed: ${p.actionType.replace(/[._]/g, " ")}`, body: p.rationale ?? "", roleId: p.roleId ?? undefined, applicationId: p.applicationId ?? undefined, approvalRequestId: p.id, actions: [{ label: "Decide", method: "POST", path: `/api/v1/approvals/${p.id}/decide` }] });
    }
  }

  for (const role of openRoles.filter((r) => r.status === "open")) {
    const apps = await tx.select().from(applications).where(and(eq(applications.roleId, role.id)));
    const fresh = apps.filter((a) => a.createdAt >= since);
    const waiting = apps.filter((a) => ownerGroup(a.stage) === "waiting_on_you" || a.stage === "eligible");
    const ineligible = apps.filter((a) => a.stage === "ineligible");
    if (fresh.length) {
      cards.push({ kind: "new_applicants", title: `${fresh.length} ${fresh.length === 1 ? "person" : "people"} applied to ${role.title} since yesterday`, body: waiting.length ? `${waiting.length} ${waiting.length === 1 ? "is" : "are"} ready for your review.` : "They are being acknowledged and checked for eligibility.", roleId: role.id, actions: [{ label: "See applicants", method: "GET", path: `/roles/${role.id}/people` }] });
    }
    if (waiting.length) {
      const names = await tx.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(inArray(candidates.id, waiting.slice(0, 5).map((a) => a.candidateId)));
      const list = waiting.slice(0, 5).map((a) => { const n = names.find((x) => x.id === a.candidateId); return `${n?.firstName ?? ""} ${n?.lastName ?? ""}`.trim() + ` (${STAGE_LABEL[a.stage]})`; }).join(", ");
      cards.push({ kind: "needs_review", title: `${waiting.length} ${waiting.length === 1 ? "candidate needs" : "candidates need"} your review for ${role.title}`, body: list, roleId: role.id, actions: [{ label: "Review", method: "GET", path: `/roles/${role.id}/people` }, { label: "Bring in a recruiter", method: "POST", path: `/api/v1/escalations`, body: { kind: "review", roleId: role.id } }] });
    }
    if (ineligible.length) {
      cards.push({ kind: "needs_review", title: `${ineligible.length} ${ineligible.length === 1 ? "applicant" : "applicants"} for ${role.title} did not meet an eligibility rule`, body: "Held for your decision. Nothing is sent to them unless you decline; override if the answer was a mistake.", roleId: role.id, actions: [{ label: "Review", method: "GET", path: `/roles/${role.id}/people?stage=ineligible` }] });
    }
    const manualPostings = await tx.select().from(postings).where(and(eq(postings.roleId, role.id), eq(postings.status, "manual_action_required")));
    if (manualPostings.length) {
      cards.push({ kind: "posting_action", title: `${role.title}: post it on ${manualPostings.map((p) => CHANNEL_NAME[p.channel] ?? p.channel).join(", ")} from your own account`, body: "These boards are not connected to the product. The role page has the copy, the apply link, and the address to forward applications to.", roleId: role.id, actions: [{ label: "See instructions", method: "GET", path: `/roles/${role.id}` }] });
    }
    const scr = apps.length ? await tx.select().from(screens).where(and(eq(screens.companyId, companyId), inArray(screens.applicationId, apps.map((a) => a.id)))) : [];
    const invited = scr.filter((s) => s.status === "invited" || s.status === "reminded").length;
    const talking = scr.filter((s) => s.status === "in_progress").length;
    const doneToday = scr.filter((s) => s.status === "completed" && (s.completedAt ?? "") >= since).length;
    if (invited + talking + doneToday > 0) {
      const parts = [invited ? `${invited} invited` : "", talking ? `${talking} answering now` : "", doneToday ? `${doneToday} completed since yesterday` : ""].filter(Boolean);
      cards.push({ kind: "screening", title: `Screening for ${role.title}: ${parts.join(", ")}`, body: doneToday ? "Completed screens are in \"Waiting on you\" with the scorecard." : "Candidates answer in their own time; you will see the scorecard when they finish.", roleId: role.id, actions: [{ label: "See people", method: "GET", path: `/roles/${role.id}/people` }] });
    }
  }
  for (const d of await detectStuckRoles(tx, companyId, new Date())) {
    cards.push({ kind: "stuck", title: d.title, body: d.body, roleId: d.roleId, actions: [{ label: d.action.label, method: "GET", path: d.action.href }, { label: "Have a recruiter review", method: "POST", path: `/api/v1/escalations`, body: { kind: "review", roleId: d.roleId } }] });
  }

  const escalations = await tx.select().from(recruiterEscalations).where(and(eq(recruiterEscalations.companyId, companyId), inArray(recruiterEscalations.status, ["open", "claimed", "in_progress"])));
  for (const e of escalations) {
    cards.push({ kind: "escalation", title: e.status === "open" ? "A recruiter will pick this up" : "A recruiter is on it", body: e.question.slice(0, 200), roleId: e.roleId ?? undefined, applicationId: e.applicationId ?? undefined, actions: [] });
  }
  if (cards.length === 0) {
    cards.push({ kind: "empty", title: openRoles.length ? "Nothing needs you right now" : "Tell me who you need to hire", body: openRoles.length ? "Applicants are being acknowledged and screened. I will tell you when someone is worth your time." : "Describe the role in a sentence or two and I will ask what I need to know.", actions: [] });
  }
  // Today answers four questions (docs/FOUNDER-CONTEXT.md §08): what needs me, who is worth a look, what is at risk, what was done for me.
  const needsMe = cards.filter((c) => c.kind === "decision" || c.kind === "needs_review").length;
  const strongIds = new Set((await tx.select({ id: assessments.applicationId }).from(assessments).where(and(eq(assessments.companyId, companyId), eq(assessments.overall, "strong")))).map((r) => r.id));
  const strongWaiting = (await tx.select({ id: applications.id, stage: applications.stage }).from(applications).where(eq(applications.companyId, companyId))).filter((a) => strongIds.has(a.id) && ownerGroup(a.stage) === "waiting_on_you").length;
  const atRisk = cards.filter((c) => c.kind === "stuck").length + escalations.length;
  const AUTOMATED = new Set(["application.acknowledged", "resume.ingested", "eligibility.evaluated", "application.triaged", "screen.invited", "screen.assessed", "candidate.recommended", "posting.published", "message.sent", "intervention.sent"]);
  const recent = await tx.select({ type: events.type, actor: events.actor }).from(events).where(and(eq(events.companyId, companyId), gte(events.occurredAt, since)));
  const handled = recent.filter((e) => AUTOMATED.has(e.type) && (e.actor.kind === "system" || e.actor.kind === "agent")).length;
  const summary = `${needsMe} ${needsMe === 1 ? "thing needs" : "things need"} you · ${strongWaiting} strong ${strongWaiting === 1 ? "candidate" : "candidates"} ready · ${atRisk} at risk · ${handled} handled for you since yesterday.`;
  return { generatedAt: new Date().toISOString(), cards, summary };
}


