import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { POSTING_CHANNELS, STAGE_LABEL, can, isBoardChannel, mayDecideApproval, ownerGroup, selfApprovalCheck } from "@ros/core";
import { detectStuckRoles } from "@ros/agents";
import type { MembershipRole } from "@ros/contracts";
import { applications, approvalRequests, assessments, candidates, companies, events, interviewParticipants, interviews, postings, recruiterEscalations, rolePackets, roles, screens, type Tx } from "@ros/db";
import type { Tenant } from "../middleware/session";
import { mayDecideByRole } from "./approvers";
import { APPROVAL_LABEL } from "./role-report";
import { escalationInScope, inStaffScope, staffMayAsk, staffScopeOf, type StaffScope } from "./staff-scope";

/**
 * What a decision card says for an approval that has no card of its own: a question in plain words (never an action
 * key), who and what it is about, and buttons named for what they do. Unknown action types still get a readable title.
 */
function approvalCardWords(actionType: string, ctx: { who: string; roleTitle: string | null; rationale: string | null }): { title: string; body: string; approve: string; reject: string } {
  const about = ctx.roleTitle ? ` for ${ctx.roleTitle}` : "";
  if (actionType === "disposition.send") {
    return { title: `Send the decline message to ${ctx.who}?`, body: ctx.rationale ?? `${ctx.who} was declined${about}. The respectful decline message goes to them only once someone approves it; until then they have heard nothing.`, approve: "Yes, send it", reject: "Do not send" };
  }
  const label = APPROVAL_LABEL[actionType] ?? "A decision is waiting for you";
  return { title: ctx.roleTitle ? `${label} (${ctx.roleTitle})` : label, body: ctx.rationale ?? "", approve: "Approve", reject: "Decline" };
}

const CHANNEL_NAME: Record<string, string> = { careers_page: "your careers page", google_jobs: "Google for Jobs", email_in: "email-in capture", linkedin_basic: "LinkedIn", indeed: "Indeed", ziprecruiter: "ZipRecruiter" };

export type BriefCard = {
  kind: "new_applicants" | "needs_review" | "decision" | "posting_action" | "escalation" | "stuck" | "screening" | "interviews" | "empty";
  title: string;
  body: string;
  roleId?: string;
  applicationId?: string;
  approvalRequestId?: string;
  actions: Array<{ label: string; method: "GET" | "POST"; path: string; body?: Record<string, unknown> }>;
};

export type Brief = { generatedAt: string; cards: BriefCard[]; summary: string };

/**
 * Who is reading the brief. An interviewer sees only their own interviews; an ITS recruiter under a grant for one role
 * or one candidate sees only that (`scope`); every other role sees the company's day.
 */
export type BriefViewer = { userId: string; role: MembershipRole; scope?: StaffScope | null };

export function briefViewerOf(t: Tenant): BriefViewer {
  return { userId: t.userId, role: t.role, scope: staffScopeOf(t) };
}

/** The empty card's way forward: the client opens the new-role conversation on "/?start=1" (until a page of its own exists). */
export const START_HIRE_PATH = "/?start=1";

/**
 * The morning brief, Slice 1: deterministic, from the system of record. The orchestrator agent replaces the
 * prose in a later slice; the sections and actions stay the same.
 */
export async function composeBrief(tx: Tx, companyId: string, viewer?: BriefViewer): Promise<Brief> {
  if (viewer?.role === "interviewer") return interviewerBrief(tx, companyId, viewer);
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const cards: BriefCard[] = [];
  const scope = viewer?.scope ?? null;
  // The after-interview cards ask for a decision or an approval, so they go only to the roles that can give one (HR cannot). An unknown viewer is treated as the owner.
  const afterInterview = { decides: !viewer || can(viewer.role, "interview.decide"), requests: !viewer || can(viewer.role, "interview.request") };
  // Posting work (post on a board and record its address, tick a board off once taken down) needs role.manage; every
  // posting route refuses anyone else, so a hiring manager or HR never gets a card they cannot act on.
  const managesPostings = !viewer || can(viewer.role, "role.manage");
  // "Bring in a recruiter" about a whole role is offered only to someone POST /escalations accepts it from: an ITS recruiter
  // given one candidate may not ask about the whole role (staff-scope.ts, staffMayAsk).
  const mayAskAboutRole = (roleId: string) => staffMayAsk(scope, { roleId, applicationId: null });
  const openRoles = (await tx.select().from(roles).where(and(eq(roles.companyId, companyId), inArray(roles.status, ["open", "paused", "pending_approval"])))).filter((r) => inStaffScope(scope, { roleId: r.id }));

  const pending = (await tx.select().from(approvalRequests).where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.status, "pending"))).orderBy(desc(approvalRequests.createdAt))).filter((p) => inStaffScope(scope, { roleId: p.roleId, applicationId: p.applicationId }));
  // The candidates the waiting requests are about, in one query, so a card can name the person instead of an action key.
  const pendingAppIds = [...new Set(pending.map((p) => p.applicationId).filter((x): x is string => !!x))];
  const pendingNames = pendingAppIds.length ? await tx.select({ id: applications.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(inArray(applications.id, pendingAppIds)) : [];
  for (const p of pending) {
    const role = openRoles.find((r) => r.id === p.roleId);
    if (p.actionType === "role_packet.approve") {
      // The card is offered only to someone the approve route would accept: the approver roles, the named decision maker
      // (or an owner), and not the person who started the role or wrote the version unless they are the sole owner.
      if (viewer && !(await mayApprovePacketFromBrief(tx, companyId, viewer, p))) continue;
      // A version proposed while the role runs is a different decision from opening a new role: the card says which.
      const proposal = p.proposal as { version?: number; editWhileOpen?: boolean };
      const editWhileOpen = !!proposal.editWhileOpen && role?.status !== "pending_approval";
      cards.push({ kind: "decision", title: editWhileOpen ? `Approve packet v${proposal.version ?? "?"} of ${role?.title ?? "the role"}` : `Approve the role: ${role?.title ?? "new role"}`, body: p.rationale ?? (editWhileOpen ? "The role keeps running on its approved version until you decide." : "Review the role packet and approve it to start posting."), roleId: p.roleId ?? undefined, approvalRequestId: p.id, actions: [{ label: editWhileOpen ? "Review the change" : "Review and approve", method: "GET", path: `/roles/${p.roleId}` }] });
    } else if (p.actionType === "application.invite_screen" || p.actionType === "application.recommend_interview") {
      // The card's "Yes" posts to the decide route, which refuses anyone outside the request's approver roles (during a recruiter takeover, everyone but the recruiter).
      if (viewer && !mayDecideByRole(p.requiredRoles, viewer.role)) continue;
      const verb = p.actionType === "application.invite_screen" ? "Invite to a screen" : "Interview";
      cards.push({ kind: "decision", title: `${verb}? ${role?.title ?? ""}`.trim(), body: p.rationale ?? "", roleId: p.roleId ?? undefined, applicationId: p.applicationId ?? undefined, approvalRequestId: p.id, actions: [{ label: `Yes, ${verb.toLowerCase()}`, method: "POST", path: `/api/v1/approvals/${p.id}/decide`, body: { decision: "approve" } }, { label: "Review first", method: "GET", path: p.applicationId ? `/roles/${p.roleId}/talent?open=${p.applicationId}` : `/roles/${p.roleId}/talent` }] });
    } else if (p.actionType === "message.send_freeform") {
      // A message a team member wrote to a candidate, waiting for an approver (F11): the text is on the card, so the decision can be made from here.
      // Only those who may decide it get the card; the writer, and anyone else the decide route would refuse, are told on the candidate's page instead.
      if (viewer && !mayDecideByRole(p.requiredRoles, viewer.role)) continue;
      const m = p.proposal as { subject?: string | null; text?: string; senderName?: string; candidateName?: string };
      const who = m.candidateName ?? "the candidate";
      const open = p.applicationId ? `/roles/${p.roleId}/talent?open=${p.applicationId}` : `/roles/${p.roleId}/talent`;
      cards.push({ kind: "decision", title: `Send this message to ${who}?`, body: `${m.senderName ?? "A team member"} wrote to ${who}${role ? ` about ${role.title}` : ""}${m.subject ? ` ("${m.subject}")` : ""}:\n\n${m.text ?? ""}`, roleId: p.roleId ?? undefined, applicationId: p.applicationId ?? undefined, approvalRequestId: p.id, actions: [{ label: "Yes, send it", method: "POST", path: `/api/v1/approvals/${p.id}/decide`, body: { decision: "approve" } }, { label: "Do not send", method: "POST", path: `/api/v1/approvals/${p.id}/decide`, body: { decision: "reject" } }, { label: "Open the candidate", method: "GET", path: open }] });
    } else {
      // Any other approval: the decide route needs a decision in the body, so the card posts one, and links to the page the
      // request is about. Only those the route accepts get it, and it says what is being decided in plain words.
      if (viewer && !mayDecideByRole(p.requiredRoles, viewer.role)) continue;
      const where = p.applicationId ? `/roles/${p.roleId}/talent?open=${p.applicationId}` : p.roleId ? `/roles/${p.roleId}` : null;
      const n = p.applicationId ? pendingNames.find((x) => x.id === p.applicationId) : undefined;
      const words = approvalCardWords(p.actionType, { who: n ? `${n.firstName} ${n.lastName}`.trim() || "the candidate" : "the candidate", roleTitle: role?.title ?? null, rationale: p.rationale });
      cards.push({ kind: "decision", title: words.title, body: words.body, roleId: p.roleId ?? undefined, applicationId: p.applicationId ?? undefined, approvalRequestId: p.id, actions: [{ label: words.approve, method: "POST", path: `/api/v1/approvals/${p.id}/decide`, body: { decision: "approve" } }, { label: words.reject, method: "POST", path: `/api/v1/approvals/${p.id}/decide`, body: { decision: "reject" } }, ...(where ? [{ label: "Review first", method: "GET" as const, path: where }] : [])] });
    }
  }

  for (const role of openRoles.filter((r) => r.status === "open")) {
    // A recruiter given one candidate counts and names only that candidate, never the rest of the role's applicants.
    const apps = (await tx.select().from(applications).where(and(eq(applications.roleId, role.id)))).filter((a) => inStaffScope(scope, { roleId: role.id, applicationId: a.id }));
    const fresh = apps.filter((a) => a.createdAt >= since);
    // Candidates whose interview is over get a card of their own below, so they are not counted here a second time.
    const waiting = apps.filter((a) => (ownerGroup(a.stage) === "waiting_on_you" && a.stage !== "interview_complete") || a.stage === "eligible");
    const ineligible = apps.filter((a) => a.stage === "ineligible");
    for (const card of await afterInterviewCards(tx, role, apps.filter((a) => a.stage === "interview_complete"), afterInterview)) cards.push(card);
    if (fresh.length) {
      cards.push({ kind: "new_applicants", title: `${fresh.length} ${fresh.length === 1 ? "person" : "people"} applied to ${role.title} since yesterday`, body: waiting.length ? `${waiting.length} ${waiting.length === 1 ? "is" : "are"} ready for your review.` : "They are being acknowledged and checked for eligibility.", roleId: role.id, actions: [{ label: "See applicants", method: "GET", path: `/roles/${role.id}/talent` }] });
    }
    if (waiting.length) {
      const names = await tx.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(inArray(candidates.id, waiting.slice(0, 5).map((a) => a.candidateId)));
      const list = waiting.slice(0, 5).map((a) => { const n = names.find((x) => x.id === a.candidateId); return `${`${n?.firstName ?? ""} ${n?.lastName ?? ""}`.trim()} (${STAGE_LABEL[a.stage]})`; }).join(", ");
      cards.push({ kind: "needs_review", title: `${waiting.length} ${waiting.length === 1 ? "candidate needs" : "candidates need"} your review for ${role.title}`, body: list, roleId: role.id, actions: [{ label: "Review", method: "GET", path: `/roles/${role.id}/talent` }, ...(mayAskAboutRole(role.id) ? [{ label: "Bring in a recruiter", method: "POST" as const, path: `/api/v1/escalations`, body: { kind: "review", roleId: role.id } }] : [])] });
    }
    if (ineligible.length) {
      cards.push({ kind: "needs_review", title: `${ineligible.length} ${ineligible.length === 1 ? "applicant" : "applicants"} for ${role.title} did not meet an eligibility rule`, body: "Held for your decision. Nothing is sent to them unless you decline; override if the answer was a mistake.", roleId: role.id, actions: [{ label: "Review", method: "GET", path: `/roles/${role.id}/talent?stage=ineligible` }] });
    }
    // Boards waiting to be posted by hand (docs/spec/20): ready to post means the package and the tracked link exist and nothing is on the board yet.
    const manualPostings = managesPostings ? (await tx.select().from(postings).where(and(eq(postings.roleId, role.id), eq(postings.status, "ready_to_post")))).filter((p) => isBoardChannel(p.channel)) : [];
    if (manualPostings.length) {
      cards.push({ kind: "posting_action", title: `${role.title}: post it on ${manualPostings.map((p) => CHANNEL_NAME[p.channel] ?? p.channel).join(", ")} from your own account`, body: "These boards are not connected to the product. The role's Posting tab has the posting package, each board's own apply link and the steps; record the public URL there once it is up.", roleId: role.id, actions: [{ label: "See instructions", method: "GET", path: `/roles/${role.id}?tab=posting` }] });
    }
    const scr = apps.length ? await tx.select().from(screens).where(and(eq(screens.companyId, companyId), inArray(screens.applicationId, apps.map((a) => a.id)))) : [];
    const invited = scr.filter((s) => s.status === "invited" || s.status === "reminded").length;
    const talking = scr.filter((s) => s.status === "in_progress").length;
    const doneToday = scr.filter((s) => s.status === "completed" && (s.completedAt ?? "") >= since).length;
    if (invited + talking + doneToday > 0) {
      const parts = [invited ? `${invited} invited` : "", talking ? `${talking} answering now` : "", doneToday ? `${doneToday} completed since yesterday` : ""].filter(Boolean);
      cards.push({ kind: "screening", title: `Screening for ${role.title}: ${parts.join(", ")}`, body: doneToday ? "Completed screens are in \"Waiting on you\" with the scorecard." : "Candidates answer in their own time; you will see the scorecard when they finish.", roleId: role.id, actions: [{ label: "See people", method: "GET", path: `/roles/${role.id}/talent` }] });
    }
  }
  // Boards still up after a posting closed (docs/spec/20 item 15): the checklist lives on the role's Posting tab. The
  // whole role may be closed, or a person closed one board's posting while the role stays open; the card says which.
  const channelOrder = (channel: string) => (POSTING_CHANNELS as readonly string[]).indexOf(channel);
  const stillUp: Array<{ roleId: string; channel: string }> = !managesPostings ? [] : (await tx.select({ roleId: postings.roleId, channel: postings.channel }).from(postings).where(and(eq(postings.companyId, companyId), eq(postings.closureRequired, true), isNull(postings.closureConfirmedAt)))).filter((p) => isBoardChannel(p.channel) && inStaffScope(scope, { roleId: p.roleId })).sort((a, b) => channelOrder(a.channel) - channelOrder(b.channel));
  if (stillUp.length) {
    const affectedRoles = await tx.select({ id: roles.id, title: roles.title, status: roles.status }).from(roles).where(inArray(roles.id, [...new Set(stillUp.map((p) => p.roleId))]));
    for (const role of affectedRoles) {
      const boards = stillUp.filter((p) => p.roleId === role.id).map((p) => CHANNEL_NAME[p.channel] ?? p.channel);
      const one = boards.length === 1;
      const body = role.status === "closed"
        ? `${role.title} is closed, but ${one ? "this board still shows" : "these boards still show"} it. Take the posting down from your own account, then tick it off on the Posting tab so nobody keeps applying to a closed role.`
        : `The ${role.title} posting on ${boards.join(", ")} was closed here, but ${one ? "the board still shows" : "the boards still show"} the job. Take it down from your own account, then tick it off on the Posting tab.`;
      cards.push({ kind: "posting_action", title: `Still posted on ${boards.join(", ")}`, body, roleId: role.id, actions: [{ label: "Open the Posting tab", method: "GET", path: `/roles/${role.id}?tab=posting` }] });
    }
  }
  for (const d of await detectStuckRoles(tx, companyId, new Date())) {
    if (!inStaffScope(scope, { roleId: d.roleId })) continue;
    cards.push({ kind: "stuck", title: d.title, body: d.body, roleId: d.roleId, actions: [{ label: d.action.label, method: "GET", path: d.action.href }, ...(mayAskAboutRole(d.roleId) ? [{ label: "Have a recruiter review", method: "POST" as const, path: `/api/v1/escalations`, body: { kind: "review", roleId: d.roleId } }] : [])] });
  }

  const escalations = (await tx.select().from(recruiterEscalations).where(and(eq(recruiterEscalations.companyId, companyId), inArray(recruiterEscalations.status, ["open", "claimed", "in_progress"])))).filter((e) => escalationInScope(scope, e));
  for (const e of escalations) {
    cards.push({ kind: "escalation", title: e.status === "open" ? "A recruiter will pick this up" : "A recruiter is on it", body: e.question.slice(0, 200), roleId: e.roleId ?? undefined, applicationId: e.applicationId ?? undefined, actions: [] });
  }
  if (cards.length === 0) {
    // A brand-new company's first screen always offers the way forward; so does a quiet day.
    const startsHires = !viewer || (can(viewer.role, "role.create") && can(viewer.role, "compensation.read") && !scope);
    const actions: BriefCard["actions"] = openRoles.length ? [{ label: "See your roles", method: "GET", path: "/roles" }] : startsHires ? [{ label: "Start a hire", method: "GET", path: START_HIRE_PATH }] : [];
    cards.push({ kind: "empty", title: openRoles.length ? "Nothing needs you right now" : startsHires ? "Tell me who you need to hire" : "No roles are open yet", body: openRoles.length ? "Applicants are being acknowledged and screened. I will tell you when someone is worth your time." : startsHires ? "Describe the role in a sentence or two and I will ask what I need to know." : "When someone on your team opens a role, its applicants and decisions show up here.", actions });
  }
  // Today answers four questions (docs/FOUNDER-CONTEXT.md §08): what needs me, who is worth a look, what is at risk, what was done for me.
  const needsMe = cards.filter((c) => c.kind === "decision" || c.kind === "needs_review").length;
  const strongIds = new Set((await tx.select({ id: assessments.applicationId }).from(assessments).where(and(eq(assessments.companyId, companyId), eq(assessments.overall, "strong")))).map((r) => r.id));
  const companyApps = (await tx.select({ id: applications.id, roleId: applications.roleId, stage: applications.stage }).from(applications).where(eq(applications.companyId, companyId))).filter((a) => inStaffScope(scope, { roleId: a.roleId, applicationId: a.id }));
  const strongWaiting = companyApps.filter((a) => strongIds.has(a.id) && ownerGroup(a.stage) === "waiting_on_you").length;
  const atRisk = cards.filter((c) => c.kind === "stuck").length + escalations.length;
  const AUTOMATED = new Set(["application.acknowledged", "resume.ingested", "eligibility.evaluated", "application.triaged", "screen.invited", "screen.assessed", "candidate.recommended", "posting.published", "message.sent", "intervention.sent"]);
  const recent = await tx.select({ type: events.type, actor: events.actor, subjectId: events.subjectId }).from(events).where(and(eq(events.companyId, companyId), gte(events.occurredAt, since)));
  // Under a scoped grant, only what was done about the role or the candidate in scope is counted.
  const inScopeSubjects = scope ? new Set<string>([...openRoles.map((r) => r.id), ...companyApps.map((a) => a.id)]) : null;
  const handled = recent.filter((e) => AUTOMATED.has(e.type) && (e.actor.kind === "system" || e.actor.kind === "agent") && (!inScopeSubjects || inScopeSubjects.has(e.subjectId))).length;
  const summary = `${needsMe} ${needsMe === 1 ? "thing needs" : "things need"} you · ${strongWaiting} strong ${strongWaiting === 1 ? "candidate" : "candidates"} ready · ${atRisk} at risk · ${handled} handled for you since yesterday.`;
  return { generatedAt: new Date().toISOString(), cards, summary };
}

/**
 * The same three checks as packet-approval.ts `assertMayApprovePacket`, applied before the card is built: role.approve,
 * the request's approver roles or named decision maker, and the self-approval rule (sole owners excepted).
 */
async function mayApprovePacketFromBrief(tx: Tx, companyId: string, viewer: BriefViewer, req: typeof approvalRequests.$inferSelect): Promise<boolean> {
  if (!can(viewer.role, "role.approve")) return false;
  if (!mayDecideApproval(req, { userId: viewer.userId, role: viewer.role }).ok) return false;
  const [role] = req.roleId ? await tx.select({ id: roles.id, createdBy: roles.createdBy }).from(roles).where(eq(roles.id, req.roleId)).limit(1) : [];
  if (!role) return false;
  const version = Number((req.proposal as { version?: number }).version);
  const [pv] = Number.isFinite(version) ? await tx.select({ createdBy: rolePackets.createdBy }).from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, version))).limit(1) : [];
  return (await selfApprovalCheck(tx, { companyId, userId: viewer.userId, roleCreatedBy: role.createdBy, versionCreatedBy: pv?.createdBy ?? role.createdBy })).ok;
}

const whenIn = (iso: string, timeZone: string) => new Date(iso).toLocaleString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * "Decide after the interview": one card per candidate whose interview is over and whose decision nobody has recorded
 * (the newest finished, undecided interview names the round and when it happened). A candidate already sent to the
 * next round, with no new interview in motion yet, is reminded to have that round approved instead. `who` says which of
 * the two the viewer may act on; a card the viewer could not act on is not shown to them.
 */
async function afterInterviewCards(tx: Tx, role: { id: string; title: string }, apps: Array<{ id: string; candidateId: string; companyId: string }>, who: { decides: boolean; requests: boolean }): Promise<BriefCard[]> {
  if (!apps.length || (!who.decides && !who.requests)) return [];
  const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, apps[0].companyId)).limit(1);
  const tz = company?.timezone ?? "UTC";
  const ivs = await tx.select({ id: interviews.id, applicationId: interviews.applicationId, title: interviews.title, status: interviews.status, outcome: interviews.outcome, decision: interviews.decision, startsAt: interviews.startsAt, createdAt: interviews.createdAt }).from(interviews).where(inArray(interviews.applicationId, apps.map((a) => a.id))).orderBy(desc(interviews.createdAt));
  const names = await tx.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(inArray(candidates.id, apps.map((a) => a.candidateId)));
  const out: BriefCard[] = [];
  for (const app of apps) {
    const n = names.find((x) => x.id === app.candidateId);
    const name = `${n?.firstName ?? ""} ${n?.lastName ?? ""}`.trim() || "A candidate";
    const mine = ivs.filter((i) => i.applicationId === app.id);
    if (mine.some((i) => ["proposed", "scheduling", "scheduled"].includes(i.status))) continue; // the next interview is already in motion
    const open = `/roles/${role.id}/talent?open=${app.id}`;
    const undecided = mine.find((i) => ["completed", "no_show"].includes(i.status) && !i.decision);
    if (undecided) {
      if (!who.decides) continue;
      const attendance = undecided.outcome === "no_show_candidate" ? " (the candidate did not attend)" : undecided.outcome === "no_show_interviewer" ? " (the interviewer did not attend)" : "";
      out.push({ kind: "decision", title: `Decide after the interview: ${name}`, body: `${undecided.title} for ${role.title}${undecided.startsAt ? `, ${whenIn(undecided.startsAt, tz)}` : ""}${attendance}. Next round, finalist, or not moving forward: your call, recorded with your reason.`, roleId: role.id, applicationId: app.id, actions: [{ label: "Decide", method: "GET", path: open }] });
      continue;
    }
    const latest = mine.find((i) => ["completed", "no_show"].includes(i.status));
    if (who.requests && latest?.decision === "next_round") out.push({ kind: "decision", title: `Set up the next round: ${name}`, body: `You chose the next round after ${latest.title}. Approve it from the candidate's page and times go out to them.`, roleId: role.id, applicationId: app.id, actions: [{ label: "Open the candidate", method: "GET", path: open }] });
  }
  return out;
}

/**
 * An interviewer's Today: their own interviews and nothing else, so no candidate they are not meeting is named. Booked
 * times first, then rounds still being scheduled, then any interview of theirs that ended without a record of whether it
 * took place.
 */
async function interviewerBrief(tx: Tx, companyId: string, viewer: BriefViewer): Promise<Brief> {
  const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId)).limit(1);
  const tz = company?.timezone ?? "UTC";
  const rows = await tx
    .select({ id: interviews.id, title: interviews.title, status: interviews.status, outcome: interviews.outcome, startsAt: interviews.startsAt, candidateId: applications.candidateId, roleId: applications.roleId })
    .from(interviews)
    .innerJoin(interviewParticipants, eq(interviewParticipants.interviewId, interviews.id))
    .innerJoin(applications, eq(applications.id, interviews.applicationId))
    .where(and(eq(interviews.companyId, companyId), eq(interviewParticipants.userId, viewer.userId), inArray(interviews.status, ["proposed", "scheduling", "scheduled", "completed"])));
  const names = rows.length ? await tx.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(inArray(candidates.id, [...new Set(rows.map((r) => r.candidateId))])) : [];
  const titles = rows.length ? await tx.select({ id: roles.id, title: roles.title }).from(roles).where(inArray(roles.id, [...new Set(rows.map((r) => r.roleId))])) : [];
  const nameOf = (candidateId: string) => { const n = names.find((x) => x.id === candidateId); return `${n?.firstName ?? ""} ${n?.lastName ?? ""}`.trim() || "A candidate"; };
  const roleOf = (roleId: string) => titles.find((r) => r.id === roleId)?.title ?? "a role";
  const upcoming = rows.filter((r) => r.status === "scheduled").sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? ""));
  const offering = rows.filter((r) => r.status === "proposed" || r.status === "scheduling");
  const toRecord = rows.filter((r) => r.status === "completed" && !r.outcome);
  const cards: BriefCard[] = [];
  if (upcoming.length || offering.length) {
    const lines = [
      ...upcoming.map((r) => `${nameOf(r.candidateId)}: ${r.title} for ${roleOf(r.roleId)}${r.startsAt ? `, ${whenIn(r.startsAt, tz)} (${tz})` : ""}`),
      ...offering.map((r) => `${nameOf(r.candidateId)}: ${r.title} for ${roleOf(r.roleId)}, times being offered to the candidate`),
    ];
    cards.push({ kind: "interviews", title: upcoming.length ? `${upcoming.length} ${upcoming.length === 1 ? "interview" : "interviews"} coming up` : `${offering.length} ${offering.length === 1 ? "interview" : "interviews"} being scheduled`, body: lines.join("\n"), actions: [{ label: "Open interviews", method: "GET", path: "/interviews" }] });
  }
  for (const r of toRecord) {
    cards.push({ kind: "interviews", title: `Did the interview with ${nameOf(r.candidateId)} take place?`, body: `${r.title} for ${roleOf(r.roleId)}${r.startsAt ? `, ${whenIn(r.startsAt, tz)}` : ""}. Tell us if it happened or someone did not show; it keeps the record straight.`, roleId: r.roleId, actions: [{ label: "Record what happened", method: "GET", path: `/interviews/${r.id}` }] });
  }
  if (!cards.length) cards.push({ kind: "empty", title: "Nothing needs you right now", body: "Your interviews appear here as soon as you are put on one. Keep your calendar or declared hours up to date in Setup so times can be offered.", actions: [{ label: "My availability", method: "GET", path: "/setup" }] });
  const summary = `${upcoming.length} ${upcoming.length === 1 ? "interview" : "interviews"} coming up · ${offering.length} being scheduled · ${toRecord.length} to record.`;
  return { generatedAt: new Date().toISOString(), cards, summary };
}


