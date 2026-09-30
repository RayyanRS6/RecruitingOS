import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { createEscalation, emit, gate, notify, resolvePolicy } from "@ros/core";
import { applications, approvalRequests, interventions, memberships, roles, screens, users, type Queryable } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import { queueCommunication } from "./outbox";

/**
 * The stuck-role detector and its intervention ladder (docs/02 "Customer success", docs/06 `stuck_role_detector`).
 * Detectors are read-only and also feed the brief. The ladder records what was done in `interventions`, respects the
 * `intervention.nudge` cooldown policy, and ends in a recruiter escalation so no role rots quietly.
 */

export type Detection = {
  detector: "candidates_waiting" | "screens_unanswered" | "approval_pending" | "no_applicants";
  roleId: string;
  roleTitle: string;
  title: string;
  body: string;
  action: { label: string; href: string };
  days: number;
};

const DAYS = 86_400_000;

export async function detectStuckRoles(q: Queryable, companyId: string, now: Date): Promise<Detection[]> {
  const out: Detection[] = [];
  const open = await q.select().from(roles).where(and(eq(roles.companyId, companyId), eq(roles.status, "open")));
  for (const role of open) {
    const apps = await q.select().from(applications).where(eq(applications.roleId, role.id));
    // Decisions pending: ready for review, screened, recommended, or interviewed with nobody's decision recorded yet.
    const waiting = apps.filter((a) => ["triaged", "screen_complete", "interview_recommended", "interview_complete"].includes(a.stage));
    if (waiting.length) {
      const oldest = Math.min(...waiting.map((a) => Date.parse(a.stageChangedAt)));
      const days = Math.floor((now.getTime() - oldest) / DAYS);
      if (days >= 3) out.push({ detector: "candidates_waiting", roleId: role.id, roleTitle: role.title, days, title: `${waiting.length} ${waiting.length === 1 ? "candidate has" : "candidates have"} been waiting on you for ${days} days (${role.title})`, body: "They are ready for a decision: invite to a screen, interview, decide after an interview, or decline with a reason. Candidates who wait more than a week usually move on.", action: { label: "Review them", href: `/roles/${role.id}/talent` } });
    }
    const invites = await q.select().from(screens).where(and(eq(screens.companyId, companyId), inArray(screens.status, ["invited", "reminded"]), inArray(screens.applicationId, apps.map((a) => a.id).length ? apps.map((a) => a.id) : ["00000000-0000-0000-0000-000000000000"])));
    const stale = invites.filter((s) => s.invitedAt && now.getTime() - Date.parse(s.invitedAt) >= 3 * DAYS);
    if (stale.length) {
      const days = Math.floor((now.getTime() - Math.min(...stale.map((s) => Date.parse(s.invitedAt!)))) / DAYS);
      out.push({ detector: "screens_unanswered", roleId: role.id, roleTitle: role.title, days, title: `${stale.length} screening ${stale.length === 1 ? "invite has" : "invites have"} gone unanswered for ${days} days (${role.title})`, body: "A reminder went out automatically. A recruiter can call them, or you can move on to the next candidates.", action: { label: "See who", href: `/roles/${role.id}/talent?stage=screen_invited` } });
    }
    const pending = await q.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, role.id), eq(approvalRequests.status, "pending")));
    const oldPending = pending.filter((p) => p.actionType !== "role_packet.approve" && now.getTime() - Date.parse(p.createdAt) >= 2 * DAYS);
    if (oldPending.length) {
      const days = Math.floor((now.getTime() - Math.min(...oldPending.map((p) => Date.parse(p.createdAt)))) / DAYS);
      out.push({ detector: "approval_pending", roleId: role.id, roleTitle: role.title, days, title: `A decision has been waiting ${days} days (${role.title})`, body: oldPending.map((p) => p.rationale ?? p.actionType.replace(/[._]/g, " ")).join("; "), action: { label: "Decide", href: "/" } });
    }
    const daysOpen = role.openedAt ? Math.floor((now.getTime() - Date.parse(role.openedAt)) / DAYS) : 0;
    if (apps.length === 0 && daysOpen >= 14) {
      out.push({ detector: "no_applicants", roleId: role.id, roleTitle: role.title, days: daysOpen, title: `${role.title} has had no applicants in ${daysOpen} days`, body: "Posting on Indeed from your account, asking the team for referrals, or a recruiter search usually fixes this within a week.", action: { label: "See posting options", href: `/roles/${role.id}` } });
    }
  }
  return out;
}

export type LadderLevel = "brief" | "message" | "offer_recruiter" | "escalation";
const LADDER: LadderLevel[] = ["brief", "message", "offer_recruiter", "escalation"];

export type LadderDeps = { integrations: Integrations; appBaseUrl: string; itsQueueEmail: string; now: Date; actor: Actor };

/**
 * Applies the ladder to today's detections and closes interventions whose condition has cleared.
 * Returns what was sent, for the workflow ledger and tests.
 */
export async function runInterventionLadder(q: Queryable, deps: LadderDeps, companyId: string, detections: Detection[]): Promise<Array<{ roleId: string; detector: string; level: LadderLevel | "skipped" | "resolved"; reason?: string }>> {
  const results: Array<{ roleId: string; detector: string; level: LadderLevel | "skipped" | "resolved"; reason?: string }> = [];
  const openInterventions = await q.select().from(interventions).where(and(eq(interventions.companyId, companyId), eq(interventions.status, "sent")));
  for (const iv of openInterventions) {
    const still = detections.some((d) => d.roleId === iv.roleId && d.detector === iv.detector);
    if (!still) {
      await q.update(interventions).set({ status: "resolved", respondedAt: deps.now.toISOString(), response: "condition cleared" }).where(eq(interventions.id, iv.id));
      await emit(q, { type: "intervention.responded", companyId, actor: deps.actor, subject: { type: "role", id: iv.roleId ?? "" }, payload: { detector: iv.detector, level: iv.ladderLevel, outcome: "resolved" } });
      results.push({ roleId: iv.roleId ?? "", detector: iv.detector, level: "resolved" });
    }
  }
  for (const d of detections) {
    const prior = await q.select().from(interventions).where(and(eq(interventions.companyId, companyId), eq(interventions.roleId, d.roleId), eq(interventions.detector, d.detector))).orderBy(desc(interventions.sentAt));
    const policy = await resolvePolicy(q, companyId, d.roleId, "intervention.nudge");
    if (policy.level === "human_only") { results.push({ roleId: d.roleId, detector: d.detector, level: "skipped", reason: "nudges disabled by policy" }); continue; }
    const cooldownHours = Number(policy.params.cooldownHours ?? 48);
    const last = prior[0];
    const sinceLast = last ? (deps.now.getTime() - Date.parse(last.sentAt)) / 3_600_000 : Infinity;
    // An intervention that was already resolved once and fires again starts the ladder over.
    const active = last && last.status === "sent" ? prior.filter((p) => p.status === "sent") : [];
    if (last && last.status === "sent" && sinceLast < cooldownHours) { results.push({ roleId: d.roleId, detector: d.detector, level: "skipped", reason: `cooldown (${Math.round(cooldownHours - sinceLast)}h left)` }); continue; }
    const level = LADDER[Math.min(active.length, LADDER.length - 1)];
    if (level === "escalation" && active.some((p) => p.ladderLevel === "escalation")) { results.push({ roleId: d.roleId, detector: d.detector, level: "skipped", reason: "already escalated" }); continue; }
    await sendIntervention(q, deps, companyId, d, level);
    const [row] = await q.insert(interventions).values({ companyId, roleId: d.roleId, detector: d.detector, ladderLevel: level, status: "sent", sentAt: deps.now.toISOString() }).returning({ id: interventions.id });
    await emit(q, { type: "intervention.sent", companyId, actor: deps.actor, subject: { type: "role", id: d.roleId }, payload: { detector: d.detector, level, interventionId: row.id, days: d.days } });
    results.push({ roleId: d.roleId, detector: d.detector, level });
  }
  return results;
}

/** Team-facing mail goes through the outbox like everything sent from inside a transaction. */
function teamMail(q: Queryable, deps: LadderDeps, companyId: string, input: { to: string; subject: string; text: string; idempotencyKey: string; templateKey: string; tags?: Record<string, string> }) {
  return queueCommunication(q, deps.integrations, { channel: "email", companyId, to: input.to, from: `${deps.integrations.env.productName} <${deps.integrations.env.fromAddress}>`, subject: input.subject, text: input.text, templateKey: input.templateKey, idempotencyKey: input.idempotencyKey, tags: { template: input.templateKey, ...(input.tags ?? {}) }, actor: deps.actor }, deps.now);
}

async function sendIntervention(q: Queryable, deps: LadderDeps, companyId: string, d: Detection, level: LadderLevel): Promise<void> {
  const href = `${deps.appBaseUrl}${d.action.href}`;
  if (level === "brief") {
    await notify(q, { companyId, kind: `stuck.${d.detector}`, title: d.title, body: d.body, action: d.action });
    return;
  }
  const owners = await q.select({ email: users.email, name: users.name, userId: users.id }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.companyId, companyId), inArray(memberships.role, ["owner", "admin", "hiring_manager"]), eq(memberships.status, "active")));
  const day = deps.now.toISOString().slice(0, 10);
  if (level === "message") {
    await notify(q, { companyId, kind: `stuck.${d.detector}`, title: d.title, body: d.body, action: d.action });
    for (const o of owners) {
      await teamMail(q, deps, companyId, { to: o.email, subject: d.title, text: `${o.name ? `Hi ${o.name.split(" ")[0]},` : "Hi,"}\n\n${d.body}\n\n${d.action.label}: ${href}\n\nIf you would rather a recruiter handled this, reply to this email or use "Ask a recruiter" in the app.`, idempotencyKey: `intervention:${companyId}:${d.roleId}:${d.detector}:message:${day}:${o.userId}`, templateKey: "intervention", tags: { detector: d.detector } });
    }
    return;
  }
  if (level === "offer_recruiter") {
    const g = await gate(q, { companyId, roleId: d.roleId, actionType: "intervention.offer_recruiter", subject: { type: "role", id: d.roleId }, proposal: { detector: d.detector }, rationale: d.title, requestedBy: deps.actor });
    if (g.outcome === "human_only") return;
    const body = `${d.body}\n\nAn ITS recruiter can review the shortlist, reach out to candidates, and get this moving. It is one click from the role page or the brief.`;
    await notify(q, { companyId, kind: "stuck.offer_recruiter", title: `Want a recruiter to take a look at ${d.roleTitle}?`, body, action: { label: "Ask a recruiter", href: d.action.href } });
    for (const o of owners) {
      await teamMail(q, deps, companyId, { to: o.email, subject: `Want a recruiter to look at ${d.roleTitle}?`, text: `${body}\n\nOpen: ${href}`, idempotencyKey: `intervention:${companyId}:${d.roleId}:${d.detector}:offer:${day}:${o.userId}`, templateKey: "intervention", tags: { detector: d.detector } });
    }
    return;
  }
  const esc = await createEscalation(q, { companyId, roleId: d.roleId, kind: "stuck_role", question: `${d.title}. ${d.body} The owner has not acted after a brief line, a message, and an offer of help. Please review the role and reach out.`, requestedBy: deps.actor });
  await notify(q, { companyId, kind: "stuck.escalated", title: `A recruiter is reviewing ${d.roleTitle}`, body: "It has been waiting a while, so an ITS recruiter is taking a look and will reach out.", action: { label: "See role", href: `/roles/${d.roleId}` } });
  await teamMail(q, deps, companyId, { to: deps.itsQueueEmail, subject: `[stuck_role] ${d.title}`, text: `${d.body}\n\nOpen the queue: ${deps.appBaseUrl}/recruiter/queue/${esc.id}`, idempotencyKey: `escalation:${esc.id}`, templateKey: "escalation" });
}
