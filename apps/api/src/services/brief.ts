import { and, count, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { CLOSING_DATE_REASON, DECISION_STAGES, POSTING_CHANNELS, STAGE_LABEL, activeFollowUpsFor, activeMarksFor, addCalendarDays, boardPostingOf, can, closingDayWords, companyToday, followUpInMotion, groupFor, inCancelled, isBoardChannel, isPostingTask, mayDecideApproval, openFlagsMessage, ownerGroup, ownerStage, plainRequestText, postingTaskLabel, selfApprovalCheck, unfinishedPostingTasks, unresolvedFlags, withoutSentimentWords, type FollowUpView } from "@ros/core";
import { legalCheckFor, legalCheckMessage } from "./packet-approval";
import { HELD_STATUS, UNTOLD_SEND_WORKING_DAYS, decisionsWaitingApproval, detectStuckRoles, isClosingProposal, removedCandidates } from "@ros/agents";
import { CANCELLED_REASON_LABEL, DECISION_WORDING_LABEL, companyOnboarding, companyVerifiedAt, type AiInterviewGroup, type ApplicationStage, type CompanyOnboarding, type DecisionWording, type GettingStarted, type GettingStartedStep, type MembershipRole, type PoolSummary } from "@ros/contracts";
import { applications, approvalRequests, candidates, communications, companies, events, intakeSessions, integrations, interviewParticipants, interviewerAvailability, interviews, invitations, memberships, postings, recruiterEscalations, rolePackets, roles, screens, type Tx } from "@ros/db";
import type { Tenant } from "../middleware/session";
import { mayDecideByRole } from "./approvers";
import { APPROVAL_LABEL } from "./role-report";
import { escalationInScope, inStaffScope, staffMayAsk, staffScopeOf, type StaffScope } from "./staff-scope";
import { boardView, loadPool, shownLatestReadings } from "./pool";
import { aiInterviewsFor } from "./screens";
import { backupsWarmCards } from "./hire-sheet";

/**
 * What a decision card says for an approval that has no card of its own: a question in plain words (never an action
 * key), who and what it is about, and buttons named for what they do. Unknown action types still get a readable title.
 */
function approvalCardWords(actionType: string, ctx: { who: string; roleTitle: string | null; rationale: string | null; requestedBy: string | null; closing?: { count: number } | null; proposal?: Record<string, unknown> | null }): { title: string; body: string; approve: string; reject: string } {
  const about = ctx.roleTitle ? ` for ${ctx.roleTitle}` : "";
  if (actionType === "disposition.send" && ctx.closing) {
    // The one closing message of a closed role (Q30), approved once for everyone it names.
    const people = ctx.closing.count === 1 ? "1 person" : `${ctx.closing.count} people`;
    return { title: `Send the closing message to ${people}${ctx.roleTitle ? ` (${ctx.roleTitle})` : ""}?`, body: `${ctx.requestedBy ?? "Someone on your team"} wants to tell ${people} who were still in process when the role closed, with one courteous closing message. They stay in your talent pool unless they asked not to be kept. Nobody is told until someone approves it; "Do not send" leaves them not told.`, approve: "Yes, send it to everyone", reject: "Do not send" };
  }
  if (actionType === "disposition.send") {
    // A Send under "ask me first" (founder decision B6): the decision was private; this is the message telling them, in
    // the approved wording the person chose, with their personal line if they wrote one (Q28).
    const wording = typeof ctx.proposal?.wording === "string" && ctx.proposal.wording in DECISION_WORDING_LABEL ? DECISION_WORDING_LABEL[ctx.proposal.wording as DecisionWording] : null;
    const line = (ctx.proposal?.personalLine as { text?: string } | null | undefined)?.text;
    const which = wording ? `the approved "${wording}" message` : "the standard message";
    return { title: `Send the decision message to ${ctx.who}?`, body: ctx.rationale ?? `${ctx.requestedBy ?? "Someone on your team"} wants to tell ${ctx.who} that they are not moving forward${about}, with ${which}.${line ? ` They added a personal line: "${line}"` : ""} It goes only once someone approves it; until then they have not been told.`, approve: "Yes, send it", reject: "Do not send" };
  }
  const label = APPROVAL_LABEL[actionType] ?? "A decision is waiting for you";
  return { title: ctx.roleTitle ? `${label} (${ctx.roleTitle})` : label, body: ctx.rationale ?? "", approve: "Approve", reject: "Decline" };
}

const CHANNEL_NAME: Record<string, string> = { careers_page: "your careers page", google_jobs: "Google for Jobs", email_in: "email-in capture", linkedin_basic: "LinkedIn", indeed: "Indeed", ziprecruiter: "ZipRecruiter" };

/**
 * `closing_date`: a role's closing date stopped applications, or stops them tonight or tomorrow night (plan D7), with
 * "Extend by two weeks" (a POST), another date, or closing the role. `share`: the day a job opens, the moment to share it (D8).
 * `pool_ready`: a role's pool is sorted on the board and waiting for Review and apply (plan F7), with the summary.
 * `hire`: a recorded hire whose start date has not passed, with the people still in the running to keep warm (plan H1).
 */
export type BriefCard = {
  kind: "new_applicants" | "needs_review" | "decision" | "posting_action" | "escalation" | "stuck" | "screening" | "interviews" | "empty" | "getting_started" | "draft" | "closing_date" | "share" | "pool_ready" | "hire";
  title: string;
  body: string;
  roleId?: string;
  applicationId?: string;
  approvalRequestId?: string;
  actions: Array<{ label: string; method: "GET" | "POST"; path: string; body?: Record<string, unknown> }>;
  /** Only on the getting_started card: the ITS company check and the steps this viewer can do (plan B1, B2). */
  gettingStarted?: GettingStarted;
  /** Only on the pool_ready card: the board's summary, the same as above the board. */
  pool?: PoolSummary;
};

/** A pool is ready to review once at least this many people wait to be sorted on the board. */
export const POOL_READY_MIN = 2;

/**
 * The pool board's card on Today (plan F7): the role's pool, sorted by the board's rules and waiting for a person, with
 * the summary's sentences and next steps. It suggests; nothing is applied until someone uses Review and apply.
 */
async function poolReadyCard(tx: Tx, role: typeof roles.$inferSelect, scope: StaffScope | null): Promise<BriefCard | null> {
  const pool = await loadPool(tx, { roleId: role.id, scopeApplicationId: scope?.applicationId ?? null });
  const summary = boardView(pool, new Date()).summary;
  if (summary.toSort < POOL_READY_MIN) return null;
  const steps = summary.nextSteps.map((s) => `${s.label}: ${s.name}. ${s.reason}`);
  return {
    kind: "pool_ready",
    title: `${summary.toSort} ${summary.toSort === 1 ? "person" : "people"} to sort for ${role.title}`,
    body: [...summary.sentences, ...(steps.length ? ["Suggested next steps:", ...steps] : [])].join("\n"),
    roleId: role.id,
    actions: [{ label: "Open the board", method: "GET", path: `/roles/${role.id}/talent?view=board` }, { label: "Review and apply", method: "GET", path: `/roles/${role.id}/talent?view=board&review=1` }],
    pool: summary,
  };
}

export type Brief = { generatedAt: string; cards: BriefCard[]; summary: string };

/**
 * Who is reading the brief. An interviewer sees only their own interviews; an ITS recruiter under a grant for one role
 * or one candidate sees only that (`scope`); every other role sees the company's day.
 */
export type BriefViewer = { userId: string; role: MembershipRole; scope?: StaffScope | null };

export function briefViewerOf(t: Tenant): BriefViewer {
  return { userId: t.userId, role: t.role, scope: staffScopeOf(t) };
}

/** Where "Start a hire" goes (plan C4): the full-screen job builder. A draft is continued at `${START_HIRE_PATH}?session=<id>`. */
export const START_HIRE_PATH = "/roles/new";

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
  // Closing a role records its outcome (outcome.record): an owner, an admin, the hiring manager or HR. A recruiter, an
  // ITS recruiter under a grant among them, manages the closing date but is never offered "Close the role".
  const closesRoles = !viewer || can(viewer.role, "outcome.record");
  // "Bring in a recruiter" about a whole role is offered only to someone POST /escalations accepts it from: an ITS recruiter
  // given one candidate may not ask about the whole role (staff-scope.ts, staffMayAsk).
  const mayAskAboutRole = (roleId: string) => staffMayAsk(scope, { roleId, applicationId: null });
  const openRoles = (await tx.select().from(roles).where(and(eq(roles.companyId, companyId), inArray(roles.status, ["open", "paused", "pending_approval"])))).filter((r) => inStaffScope(scope, { roleId: r.id }));

  const now = new Date();
  // Only the requests the viewer may decide (`staffMayAsk`, the rule POST /approvals/:id/decide applies): an ITS recruiter
  // given one candidate gets no card for a request about the whole role, such as a closing message naming every applicant.
  const pending = (await tx.select().from(approvalRequests).where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.status, "pending"))).orderBy(desc(approvalRequests.createdAt))).filter((p) => staffMayAsk(scope, { roleId: p.roleId, applicationId: p.applicationId }));
  // The candidates the waiting requests are about, in one query, so a card can name the person instead of an action key.
  const pendingAppIds = [...new Set(pending.map((p) => p.applicationId).filter((x): x is string => !!x))];
  const pendingNames = pendingAppIds.length ? await tx.select({ id: applications.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(inArray(applications.id, pendingAppIds)) : [];
  for (const p of pending) {
    const role = openRoles.find((r) => r.id === p.roleId);
    if (p.actionType === "role_packet.approve") {
      // The card is offered only to someone the approve route would accept: the approver roles, the named decision maker
      // (or an owner), and not the person who started the role or wrote the version unless they are the sole owner.
      const may = viewer ? await mayApprovePacketFromBrief(tx, companyId, viewer, p) : { ok: true, openFlags: await openFlagsOf(tx, p) };
      if (!may.ok) continue;
      // A version proposed while the role runs is a different decision from opening a new role: the card says which.
      const proposal = p.proposal as { version?: number; editWhileOpen?: boolean };
      const editWhileOpen = !!proposal.editWhileOpen && role?.status !== "pending_approval";
      // What the law of the job's places asks of the ad comes next (plan D5): the approve route refuses while it is missing.
      const [pv] = !may.openFlags && p.roleId && Number.isFinite(Number(proposal.version)) ? await tx.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, p.roleId), eq(rolePackets.version, Number(proposal.version)))).limit(1) : [];
      const [legalRole] = pv && p.roleId ? await tx.select().from(roles).where(eq(roles.id, p.roleId)).limit(1) : [];
      const legal = pv && legalRole ? await legalCheckFor(tx, { role: legalRole, packet: pv.packet, now }) : null;
      // Open wording flags come first (the approve route refuses until each is changed or kept with a reason): the card says so instead of offering approval.
      const body = may.openFlags ? `${openFlagsMessage(may.openFlags)} It can be approved after that.` : legal?.missing.length ? `${legalCheckMessage(legal.missing)} It can be approved after that.` : p.rationale ?? (editWhileOpen ? "The job keeps running on its approved version until you decide." : "Review the job details and approve them to start posting.");
      const label = may.openFlags ? "Review the wording" : legal?.missing.length ? "See what is missing" : editWhileOpen ? "Review the change" : "Review and approve";
      cards.push({ kind: "decision", title: editWhileOpen ? `Approve version ${proposal.version ?? "?"} of ${role?.title ?? "the job"}` : `Approve the job: ${role?.title ?? "new job"}`, body, roleId: p.roleId ?? undefined, approvalRequestId: p.id, actions: [{ label, method: "GET", path: `/roles/${p.roleId}` }] });
    } else if (p.actionType === "application.invite_screen") {
      // No "Invite to a screening chat?" card (20 Oct 2026, R20-4): every applicant gets the AI interview by itself, and
      // an old suggestion still waiting lapses on its own within its week.
      continue;
    } else if (p.actionType === "application.recommend_interview") {
      // The card's "Yes" posts to the decide route, which refuses anyone outside the request's approver roles (during a recruiter takeover, everyone but the recruiter).
      if (viewer && !mayDecideByRole(p.requiredRoles, viewer.role)) continue;
      // "Not now" turns the suggestion down (plan A6); the candidate stays where they are and nothing is sent.
      const verb = "Interview";
      cards.push({ kind: "decision", title: `${verb}? ${role?.title ?? ""}`.trim(), body: p.rationale ?? "", roleId: p.roleId ?? undefined, applicationId: p.applicationId ?? undefined, approvalRequestId: p.id, actions: [{ label: `Yes, ${verb.toLowerCase()}`, method: "POST", path: `/api/v1/approvals/${p.id}/decide`, body: { decision: "approve" } }, { label: "Not now", method: "POST", path: `/api/v1/approvals/${p.id}/decide`, body: { decision: "reject", note: "Not now" } }, { label: "Review first", method: "GET", path: p.applicationId ? `/roles/${p.roleId}/talent?open=${p.applicationId}` : `/roles/${p.roleId}/talent` }] });
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
      // A closed role is not among the open ones: its closing message's card names it from the request.
      const closing = p.actionType === "disposition.send" && !p.applicationId && isClosingProposal(p.proposal) ? { count: p.proposal.applicationIds.length } : null;
      const [closedRole] = closing && !role && p.roleId ? await tx.select({ title: roles.title }).from(roles).where(eq(roles.id, p.roleId)).limit(1) : [];
      const words = approvalCardWords(p.actionType, { who: n ? `${n.firstName} ${n.lastName}`.trim() || "the candidate" : "the candidate", roleTitle: role?.title ?? closedRole?.title ?? null, rationale: closing ? null : p.rationale, requestedBy: p.requestedBy.kind === "user" || p.requestedBy.kind === "recruiter" ? p.requestedBy.name ?? null : null, closing, proposal: p.proposal as Record<string, unknown> });
      cards.push({ kind: "decision", title: words.title, body: words.body, roleId: p.roleId ?? undefined, applicationId: p.applicationId ?? undefined, approvalRequestId: p.id, actions: [{ label: words.approve, method: "POST", path: `/api/v1/approvals/${p.id}/decide`, body: { decision: "approve" } }, { label: words.reject, method: "POST", path: `/api/v1/approvals/${p.id}/decide`, body: { decision: "reject" } }, ...(where ? [{ label: "Review first", method: "GET" as const, path: where }] : [])] });
    }
  }

  // Telling candidates a private decision (founder decision B6) is offered to those who may decline.
  const tells = !viewer || can(viewer.role, "application.reject");
  // The pool board's card (plan F7) goes to those who can apply its suggestions (Review and apply needs application.act).
  const sortsPools = !viewer || can(viewer.role, "application.act");
  // Who posts on the boards (plan D3): when ITS does, the posting and taking-down work is ITS's, not a card for the team.
  const [company] = await tx.select({ settings: companies.settings, timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId)).limit(1);
  const teamPosts = boardPostingOf(company?.settings) === "self";
  // Sharing a job is open to those who manage postings and those who approve roles (routes/postings.ts, share-links).
  const shares = !viewer || can(viewer.role, "role.manage") || can(viewer.role, "role.approve");
  for (const card of closingDateCards(openRoles, company?.timezone ?? null, now, managesPostings, closesRoles)) cards.push(card);
  // Nothing is public before the ITS company check (founder decision B7), so a job goes public at the later of its opening and that check.
  const verifiedAt = companyVerifiedAt(company?.settings);
  for (const role of openRoles.filter((r) => r.status === "open")) {
    // The day the job goes public (plan D8): the moment to share it, before anyone has applied.
    const publicSince = verifiedAt && role.openedAt ? Math.max(Date.parse(role.openedAt), Date.parse(verifiedAt)) : null;
    if (shares && publicSince !== null && publicSince >= Date.parse(since)) {
      cards.push({ kind: "share", title: `${role.title} is live. Share it now`, body: "Send it to people you know, a school or a local group. Each place gets its own link, so you can see where applicants come from.", roleId: role.id, actions: [{ label: "Share the job", method: "GET", path: `/roles/${role.id}?tab=posting#share` }] });
    }
    // A recruiter given one candidate counts and names only that candidate, never the rest of the role's applicants.
    const apps = (await tx.select().from(applications).where(and(eq(applications.roleId, role.id)))).filter((a) => inStaffScope(scope, { roleId: role.id, applicationId: a.id }));
    const marks = await activeMarksFor(tx, apps.map((a) => a.id));
    const followUps = await activeFollowUpsFor(tx, apps.map((a) => a.id));
    // People under Cancelled (founder decisions 1A to 4A) have the role's one Cancelled card below, and only while nothing
    // is in motion for them; nobody gets two cards.
    const underCancelled = (a: { id: string; stage: ApplicationStage }) => inCancelled(a.stage, followUps.get(a.id));
    const fresh = apps.filter((a) => a.createdAt >= since);
    // Candidates whose interview is over, and those held on an eligibility answer, get cards of their own below, so they
    // are not counted here a second time; a running hold waits on nobody, and an ended one has its own card (stuck detector).
    const parked = (id: string) => { const m = marks.get(id); return m?.mark === "on_hold" || m?.mark === "not_a_fit_for_now"; };
    // Someone still being read is under "No AI interview yet" (R20-7) and waits on nobody: never "needs your review".
    const waiting = apps.filter((a) => !parked(a.id) && !underCancelled(a) && ownerGroup(a.stage) === "waiting_on_you" && a.stage !== "interview_complete" && a.stage !== "ineligible");
    const ineligible = apps.filter((a) => a.stage === "ineligible");
    const decidedNotTold = tells ? apps.filter((a) => DECISION_STAGES.includes(a.stage) && a.toldState === "not_told") : [];
    // someone whose details were deleted at their request is never written to, so nobody is asked to tell them
    const removed = await removedCandidates(tx, decidedNotTold.map((a) => a.candidateId));
    const untold = decidedNotTold.filter((a) => !removed.has(a.candidateId));
    // a decision message waiting for an approver is on the approver's card, not this one (the same rule as the
    // reminder, the safety net and the Talent page's "Review and send")
    const waitingApproval = await decisionsWaitingApproval(tx, untold.map((a) => a.id));
    const notTold = untold.filter((a) => !waitingApproval.has(a.id));
    for (const card of await afterInterviewCards(tx, role, apps.filter((a) => a.stage === "interview_complete" && !underCancelled(a)), afterInterview)) cards.push(card);
    const cancelledCard = afterInterview.decides || afterInterview.requests ? await cancelledColumnCard(tx, role, apps.flatMap((a) => { const f = followUps.get(a.id); return f && inCancelled(a.stage, f) ? [{ candidateId: a.candidateId, followUp: f }] : []; })) : null;
    if (cancelledCard) cards.push(cancelledCard);
    if (fresh.length) {
      cards.push({ kind: "new_applicants", title: `${fresh.length} ${fresh.length === 1 ? "person" : "people"} applied to ${role.title} since yesterday`, body: waiting.length ? `${waiting.length} ${waiting.length === 1 ? "is" : "are"} ready for your review.` : "Each gets the AI interview link by email once their résumé is read.", roleId: role.id, actions: [{ label: "See applicants", method: "GET", path: `/roles/${role.id}/talent` }] });
    }
    if (waiting.length) {
      const names = await tx.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(inArray(candidates.id, waiting.slice(0, 5).map((a) => a.candidateId)));
      const list = waiting.slice(0, 5).map((a) => { const n = names.find((x) => x.id === a.candidateId); return `${`${n?.firstName ?? ""} ${n?.lastName ?? ""}`.trim()} (${STAGE_LABEL[a.stage]})`; }).join(", ");
      cards.push({ kind: "needs_review", title: `${waiting.length} ${waiting.length === 1 ? "candidate needs" : "candidates need"} your review for ${role.title}`, body: list, roleId: role.id, actions: [{ label: "Review", method: "GET", path: `/roles/${role.id}/talent` }, ...(mayAskAboutRole(role.id) ? [{ label: "Bring in a recruiter", method: "POST" as const, path: `/api/v1/escalations`, body: { kind: "review", roleId: role.id } }] : [])] });
    }
    if (ineligible.length) {
      cards.push({ kind: "needs_review", title: `${ineligible.length} ${ineligible.length === 1 ? "applicant" : "applicants"} for ${role.title} did not meet an eligibility rule`, body: "Check eligibility: they are held for your decision. Keep them in if the answer was a mistake, or decline with a reason. Either way nothing is sent to them until someone sends the decision message.", roleId: role.id, actions: [{ label: "Review", method: "GET", path: `/roles/${role.id}/talent?stage=ineligible` }] });
    }
    const told = await notToldCard(tx, role, notTold);
    if (told) cards.push(told);
    // Boards waiting to be posted by hand (docs/spec/20): ready to post means the package and the tracked link exist and
    // nothing is on the board yet. Only for a company that posts itself; otherwise ITS has a task per board (plan D3).
    const manualPostings = managesPostings && teamPosts ? (await tx.select().from(postings).where(and(eq(postings.roleId, role.id), eq(postings.status, "ready_to_post")))).filter((p) => isBoardChannel(p.channel)) : [];
    if (manualPostings.length) {
      cards.push({ kind: "posting_action", title: `${role.title}: post it on ${manualPostings.map((p) => CHANNEL_NAME[p.channel] ?? p.channel).join(", ")} from your own account`, body: "These boards are not connected to the product. The job's Share tab has the posting package, each board's own apply link and the steps; record the public URL there once it is up.", roleId: role.id, actions: [{ label: "See instructions", method: "GET", path: `/roles/${role.id}?tab=posting` }] });
    }
    const pool = sortsPools && apps.length >= POOL_READY_MIN ? await poolReadyCard(tx, role, scope) : null;
    if (pool) cards.push(pool);
    // "No AI interview yet" (R20-7): one FYI line per job, never "needs you", in neutral words (never how far anyone got),
    // from the same column as the Talent page and the Jobs list; it replaces the per-person "didn't finish" alerts.
    const inColumn = apps.filter((a) => ownerStage(a, marks.get(a.id) ?? null, followUps.get(a.id)) === "no_ai_interview");
    const groups = [...(await aiInterviewsFor(tx, inColumn, now)).values()].map((v) => v.group);
    const tally = (g: AiInterviewGroup) => groups.filter((x) => x === g).length;
    const doneToday = apps.length ? (await tx.select({ id: screens.id }).from(screens).where(and(eq(screens.companyId, companyId), inArray(screens.applicationId, apps.map((a) => a.id)), eq(screens.status, "completed"), gte(screens.completedAt, since)))).length : 0;
    if (groups.length + doneToday > 0) {
      const closed = tally("closed");
      const parts = [tally("not_started") ? `${tally("not_started")} not started` : "", tally("started") ? `${tally("started")} started` : "", tally("asked_person") ? `${tally("asked_person")} asked for a person` : "", closed ? `${closed} link closed` : "", doneToday ? `${doneToday} done since yesterday` : ""].filter(Boolean);
      cards.push({ kind: "screening", title: `AI interviews for ${role.title}: ${parts.join(", ")}`, body: closed ? "Nothing here waits on you. From the column you can remind someone, send a new link or decline privately." : "Nothing here waits on you: people answer in their own time, and each moves to New with their scorecard once they send it.", roleId: role.id, actions: [{ label: "See people", method: "GET", path: `/roles/${role.id}/talent?ownerStage=no_ai_interview${closed ? "&aiInterview=closed" : ""}` }] });
    }
  }
  // Closing a role moves its people to the talent pool privately: a closed role keeps its card until they are told,
  // however long ago it closed, so nobody drops out of sight (the untold safety net). One query for every closed role.
  if (tells) {
    const closedRoles = (await tx.select({ id: roles.id, title: roles.title }).from(roles).where(and(eq(roles.companyId, companyId), eq(roles.status, "closed")))).filter((r) => inStaffScope(scope, { roleId: r.id }));
    const untoldClosed = closedRoles.length ? await tx.select({ id: applications.id, roleId: applications.roleId, candidateId: applications.candidateId }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(and(inArray(applications.roleId, closedRoles.map((r) => r.id)), inArray(applications.stage, [...DECISION_STAGES]), eq(applications.toldState, "not_told"), isNull(candidates.anonymizedAt))) : [];
    // whose message (their own, or the closing message's one request) waits for an approver: on the approver's card instead
    const waitingClosed = await decisionsWaitingApproval(tx, untoldClosed.map((a) => a.id));
    for (const role of closedRoles) {
      const card = await notToldCard(tx, role, untoldClosed.filter((a) => a.roleId === role.id && !waitingClosed.has(a.id) && inStaffScope(scope, { roleId: role.id, applicationId: a.id })), { closed: true });
      if (card) cards.push(card);
    }
  }
  // Boards still up after a posting closed (docs/spec/20 item 15): the checklist lives on the role's Posting tab. The
  // whole role may be closed, or a person closed one board's posting while the role stays open; the card says which.
  const channelOrder = (channel: string) => (POSTING_CHANNELS as readonly string[]).indexOf(channel);
  // When ITS posts for the company, taking a board down is ITS's task (plan D3), so the team gets no card for it.
  const stillUp: Array<{ roleId: string; channel: string }> = !managesPostings || !teamPosts ? [] : (await tx.select({ roleId: postings.roleId, channel: postings.channel }).from(postings).where(and(eq(postings.companyId, companyId), eq(postings.closureRequired, true), isNull(postings.closureConfirmedAt)))).filter((p) => isBoardChannel(p.channel) && inStaffScope(scope, { roleId: p.roleId })).sort((a, b) => channelOrder(a.channel) - channelOrder(b.channel));
  if (stillUp.length) {
    const affectedRoles = await tx.select({ id: roles.id, title: roles.title, status: roles.status }).from(roles).where(inArray(roles.id, [...new Set(stillUp.map((p) => p.roleId))]));
    for (const role of affectedRoles) {
      const boards = stillUp.filter((p) => p.roleId === role.id).map((p) => CHANNEL_NAME[p.channel] ?? p.channel);
      const one = boards.length === 1;
      const body = role.status === "closed"
        ? `${role.title} is closed, but ${one ? "this board still shows" : "these boards still show"} it. Take the posting down from your own account, then tick it off on the Share tab so nobody keeps applying to a closed job.`
        : `The ${role.title} posting on ${boards.join(", ")} was closed here, but ${one ? "the board still shows" : "the boards still show"} the job. Take it down from your own account, then tick it off on the Share tab.`;
      cards.push({ kind: "posting_action", title: `Still posted on ${boards.join(", ")}`, body, roleId: role.id, actions: [{ label: "Open the Share tab", method: "GET", path: `/roles/${role.id}?tab=posting` }] });
    }
  }
  // A board task ITS could not do (plan D3) comes back to the team, with the recruiter's words, until it is done or asked again.
  const unfinished = managesPostings && !teamPosts ? (await unfinishedPostingTasks(tx, { companyId })).filter((u) => inStaffScope(scope, { roleId: u.roleId })) : [];
  if (unfinished.length) {
    const titles = await tx.select({ id: roles.id, title: roles.title }).from(roles).where(inArray(roles.id, [...new Set(unfinished.map((u) => u.roleId))]));
    for (const u of unfinished) {
      const label = postingTaskLabel(u.kind, CHANNEL_NAME[u.channel] ?? u.channel);
      cards.push({ kind: "posting_action", title: `${titles.find((r) => r.id === u.roleId)?.title ?? "A role"}: ITS could not ${label.charAt(0).toLowerCase()}${label.slice(1)}`, body: `${u.note ? `ITS wrote: "${u.note}" ` : ""}Ask ITS again from the Share tab once that is sorted out, or do it from your company's own account and record it there.`, roleId: u.roleId, actions: [{ label: "Open the Share tab", method: "GET", path: `/roles/${u.roleId}?tab=posting` }] });
    }
  }
  for (const d of await detectStuckRoles(tx, companyId, now)) {
    if (!inStaffScope(scope, { roleId: d.roleId })) continue;
    // The untold reminder goes out as a notification; Today already lists those people on the role's "not told" card.
    if (d.detector === "decisions_untold") continue;
    // A hold that ended is the team's own reminder (plan A4), not a role at risk: a review card, no recruiter offer.
    if (d.detector === "hold_ended") {
      // A recruiter given one candidate hears about that candidate only, and the card names nobody else.
      const own = scope?.applicationId ? (d.applicationIds ?? []).filter((id) => id === scope.applicationId) : d.applicationIds ?? [];
      if (!own.length) continue;
      const narrowed = own.length !== (d.applicationIds ?? []).length;
      cards.push({ kind: "needs_review", title: narrowed ? `A hold has ended (${d.roleTitle})` : d.title, body: narrowed ? "You put them on hold until now; decide what comes next. Nothing has been sent to them." : d.body, roleId: d.roleId, ...(own.length === 1 ? { applicationId: own[0] } : {}), actions: [{ label: d.action.label, method: "GET", path: own.length === 1 ? `/roles/${d.roleId}/talent?open=${own[0]}` : d.action.href }] });
      continue;
    }
    // An offer made outside the app with no answer recorded (plan G10): the team's own follow-up, not a role at risk.
    if (d.detector === "offers_waiting") {
      const own = scope?.applicationId ? (d.applicationIds ?? []).filter((id) => id === scope.applicationId) : d.applicationIds ?? [];
      if (!own.length) continue;
      const narrowed = own.length !== (d.applicationIds ?? []).length;
      cards.push({ kind: "needs_review", title: narrowed ? `An offer has had no answer recorded (${d.roleTitle})` : d.title, body: narrowed ? "Check in with them, then record whether they accepted or declined. The app never sends or changes an offer." : d.body, roleId: d.roleId, ...(own.length === 1 ? { applicationId: own[0] } : {}), actions: [{ label: d.action.label, method: "GET", path: own.length === 1 ? `/roles/${d.roleId}/talent?open=${own[0]}` : d.action.href }] });
      continue;
    }
    // A long wait (plan G10): the person waiting longest, named, with the three ways forward on their page: decide, hold
    // with a date, or send them a note. A recruiter given one candidate hears about that candidate only.
    if (d.detector === "candidates_waiting" && d.applicationIds?.length) {
      const own = scope?.applicationId ? d.applicationIds.filter((id) => id === scope.applicationId) : d.applicationIds;
      if (!own.length) continue;
      const card = await longWaitCard(tx, d, own, scope?.applicationId ? null : mayAskAboutRole(d.roleId));
      if (card) cards.push(card);
      continue;
    }
    cards.push({ kind: "stuck", title: d.title, body: d.body, roleId: d.roleId, actions: [{ label: d.action.label, method: "GET", path: d.action.href }, ...(mayAskAboutRole(d.roleId) ? [{ label: "Have a recruiter review", method: "POST" as const, path: `/api/v1/escalations`, body: { kind: "review", roleId: d.roleId } }] : [])] });
  }

  // "Keep your backups warm" until a new hire starts (plan H1); the cards filter by application.read and the staff scope.
  for (const card of await backupsWarmCards(tx, { companyId, viewer: { role: viewer?.role ?? "owner", scope }, now })) cards.push(card);
  for (const card of await draftCards(tx, companyId, viewer)) cards.push(card);

  // ITS posting tasks are ITS's own work, shown with each board on the Posting tab, not as the team's requests (plan D3).
  const escalations = (await tx.select().from(recruiterEscalations).where(and(eq(recruiterEscalations.companyId, companyId), inArray(recruiterEscalations.status, ["open", "claimed", "in_progress"])))).filter((e) => escalationInScope(scope, e) && !isPostingTask(e.kind));
  // Each open request leads to itself in "Your recruiter requests" on Today, where its thread, notes and (once it comes)
  // the answer in full are; answered requests are shown there for two weeks, so the brief needs no card of its own.
  const readsRequests = !viewer || can(viewer.role, "escalation.create");
  for (const e of escalations) {
    // A hand-over reason from before 9 October 2026 in today's words: never how the candidate sounded. A stopped run's
    // request from before 13 October 2026 in plain words, never the technical error (before it is cut to length).
    cards.push({ kind: "escalation", title: e.status === "open" ? "A recruiter will pick this up" : "A recruiter is on it", body: withoutSentimentWords(plainRequestText(e.question, e.requestedBy.kind)).slice(0, 200), roleId: e.roleId ?? undefined, applicationId: e.applicationId ?? undefined, actions: readsRequests ? [{ label: "See the request", method: "GET", path: `/?request=${e.id}` }] : [] });
  }
  // Getting started leads Today until the company is set up; its steps step aside once real decisions are waiting. Its
  // "Start your first role" makes the empty card's "Start a hire" redundant, so that card is left out while it shows.
  const setup = await gettingStartedCard(tx, companyId, viewer, { decisionsWaiting: cards.some((c) => c.kind === "decision" || c.kind === "needs_review") });
  const offersFirstRole = !!setup?.gettingStarted?.steps.some((s) => s.key === "first_role" && !s.done);
  if (cards.length === 0 && !offersFirstRole) {
    // A brand-new company's first screen always offers the way forward; so does a quiet day.
    const startsHires = !viewer || (can(viewer.role, "role.create") && can(viewer.role, "compensation.read") && !scope);
    const actions: BriefCard["actions"] = openRoles.length ? [{ label: "See your jobs", method: "GET", path: "/roles" }] : startsHires ? [{ label: "Start a hire", method: "GET", path: START_HIRE_PATH }] : [];
    cards.push({ kind: "empty", title: openRoles.length ? "Nothing needs you right now" : startsHires ? "Tell me who you need to hire" : "No jobs are open yet", body: openRoles.length ? "Applicants are being acknowledged and reviewed. I will tell you when someone is worth your time." : startsHires ? "Describe the job in a sentence or two and I will ask what I need to know." : "When someone on your team opens a job, its applicants and decisions show up here.", actions });
  }
  // Today answers four questions (docs/FOUNDER-CONTEXT.md §08): what needs me, who is worth a look, what is at risk, what was done for me.
  const needsMe = cards.filter((c) => c.kind === "decision" || c.kind === "needs_review").length;
  // Strong by each person's latest reading only (plan F5): an earlier Strong résumé reading a scorecard has since replaced
  // does not count. A reading of a conversation the candidate never sent is never theirs to be counted by (9 October
  // 2026): they count by the newest reading left, their résumé's, as the Talent list and the board show them.
  const strongIds = new Set([...(await shownLatestReadings(tx, { companyId })).values()].filter((r) => r.overall === "strong").map((r) => r.applicationId));
  const companyApps = (await tx.select({ id: applications.id, roleId: applications.roleId, stage: applications.stage }).from(applications).where(eq(applications.companyId, companyId))).filter((a) => inStaffScope(scope, { roleId: a.roleId, applicationId: a.id }));
  const companyMarks = await activeMarksFor(tx, companyApps.filter((a) => strongIds.has(a.id)).map((a) => a.id));
  const companyFollowUps = await activeFollowUpsFor(tx, companyApps.filter((a) => strongIds.has(a.id)).map((a) => a.id));
  const strongWaiting = companyApps.filter((a) => strongIds.has(a.id) && groupFor(a, companyMarks.get(a.id), now, companyFollowUps.get(a.id)) === "waiting_on_you").length;
  const atRisk = cards.filter((c) => c.kind === "stuck").length + escalations.length;
  const AUTOMATED = new Set(["application.acknowledged", "resume.ingested", "eligibility.evaluated", "application.triaged", "screen.invited", "screen.assessed", "candidate.recommended", "posting.published", "message.sent", "intervention.sent"]);
  const recent = await tx.select({ type: events.type, actor: events.actor, subjectId: events.subjectId }).from(events).where(and(eq(events.companyId, companyId), gte(events.occurredAt, since)));
  // Under a scoped grant, only what was done about the role or the candidate in scope is counted.
  const inScopeSubjects = scope ? new Set<string>([...openRoles.map((r) => r.id), ...companyApps.map((a) => a.id)]) : null;
  const handled = recent.filter((e) => AUTOMATED.has(e.type) && (e.actor.kind === "system" || e.actor.kind === "agent") && (!inScopeSubjects || inScopeSubjects.has(e.subjectId))).length;
  const summary = `${needsMe} ${needsMe === 1 ? "thing needs" : "things need"} you · ${strongWaiting} strong ${strongWaiting === 1 ? "candidate" : "candidates"} ready · ${atRisk} at risk · ${handled} handled for you since yesterday.`;
  return { generatedAt: new Date().toISOString(), cards: setup ? [setup, ...cards] : cards, summary };
}

/**
 * The closing-date cards (founder decision Q12, plan D7), for those who manage postings: a role whose date stopped
 * applications (extend it, choose another date, or close the role, which stays a person's decision), and a role whose
 * date ends tonight or tomorrow night. "Extend by two weeks" posts the new date straight to the closing-date route.
 * "Close the role" goes only to those who may close one (`closes`: outcome.record); the others are told who can.
 */
function closingDateCards(list: ReadonlyArray<typeof roles.$inferSelect>, timeZone: string | null, now: Date, manages: boolean, closes: boolean): BriefCard[] {
  if (!manages) return [];
  const out: BriefCard[] = [];
  const today = companyToday(now, timeZone);
  for (const role of list) {
    if (role.status !== "open" && role.status !== "paused") continue;
    const closesOn = role.applicationsCloseOn ? role.applicationsCloseOn.slice(0, 10) : null;
    const pickDate = { label: "Choose another date", method: "GET" as const, path: `/roles/${role.id}?tab=posting#closing-date` };
    if (!role.acceptingApplications && role.applicationsClosedReason === CLOSING_DATE_REASON) {
      out.push({
        kind: "closing_date",
        title: `${role.title} stopped taking applications`,
        body: `Its closing date${closesOn ? `, ${closingDayWords(closesOn)},` : ""} has passed. Nobody was turned away: people who had started could finish, and everyone who applied is where they were. ${closes ? "Extend the date to take applications again, or close the role when you are ready." : "Extend the date to take applications again. Closing the role is up to the company's owner, an admin, the hiring manager or HR."}`,
        roleId: role.id,
        actions: [{ label: "Extend by two weeks", method: "POST", path: `/api/v1/roles/${role.id}/closing-date`, body: { closesOn: addCalendarDays(today, 14) } }, pickDate, ...(closes ? [{ label: "Close the role", method: "GET" as const, path: `/roles/${role.id}?close=1` }] : [])],
      });
    } else if (closesOn && role.acceptingApplications && closesOn >= today && closesOn <= addCalendarDays(today, 1)) {
      out.push({
        kind: "closing_date",
        title: `${role.title} stops taking applications ${closesOn === today ? "tonight" : "tomorrow night"}`,
        body: `Its closing date is ${closingDayWords(closesOn)}. New applications stop at the end of that day; anyone already applying can finish.`,
        roleId: role.id,
        actions: [{ label: "Extend by two weeks", method: "POST", path: `/api/v1/roles/${role.id}/closing-date`, body: { closesOn: addCalendarDays(closesOn, 14) } }, pickDate],
      });
    }
  }
  return out;
}

/**
 * "Draft in progress" (plan C18): the roles this person started and has not finished, three at most, each with Continue
 * and Discard. Drafts are private to whoever started them (founder decision Q6), so nobody else's ever shows here, and
 * none for an ITS recruiter under a grant narrower than the company.
 */
async function draftCards(tx: Tx, companyId: string, viewer: BriefViewer | undefined): Promise<BriefCard[]> {
  if (!viewer || viewer.scope || !can(viewer.role, "role.create") || !can(viewer.role, "compensation.read")) return [];
  const drafts = await tx
    .select({ id: intakeSessions.id, facts: intakeSessions.facts, messages: intakeSessions.messages, draftPacket: intakeSessions.draftPacket })
    .from(intakeSessions)
    .where(and(eq(intakeSessions.companyId, companyId), eq(intakeSessions.status, "active"), or(eq(intakeSessions.createdByUserId, viewer.userId), sql`${intakeSessions.createdBy}->>'id' = ${viewer.userId}`)))
    .orderBy(desc(intakeSessions.updatedAt))
    .limit(3);
  return drafts
    .filter((d) => d.messages.some((m) => m.role === "owner"))
    .map((d) => {
      const title = d.facts.title ?? d.draftPacket?.identity.title ?? null;
      return {
        kind: "draft" as const,
        title: title ? `Draft in progress: ${title}` : "A role you started is not finished",
        body: d.draftPacket ? "The draft is written. Check it, then ask for approval when you are happy with it." : "Pick up where you left off; nothing has been sent to anyone.",
        actions: [{ label: "Continue", method: "GET" as const, path: `${START_HIRE_PATH}?session=${d.id}` }, { label: "Discard", method: "POST" as const, path: `/api/v1/intake/sessions/${d.id}/abandon` }],
      };
    });
}

/** Where the getting-started card is hidden for one person, and where "I've reviewed them" is recorded (routes/company-settings.ts). */
export const GETTING_STARTED_PATH = "/api/v1/companies/current/getting-started";

/** Who migration 0027 recorded as confirming the companies that existed when the ITS check began. */
const EXISTING_COMPANY_ACTOR_ID = "migration_0027";

/** What "Draft it with an ITS recruiter" asks; the request covers all of the company's hiring, as the form says before it is sent. */
export const FIRST_ROLE_QUESTION = "Please help us draft our first role. We would like an ITS recruiter to go through the job with us and draft it for us to approve.";

/**
 * Getting started (plan B1 and B2; docs/customer/04 steps 3 to 9). While ITS has not confirmed the company the card says
 * so, with what waits meanwhile (the public pages, and how many messages to candidates are held), whatever else Today
 * shows: nobody can hide that. Below it, the steps this viewer can do, each with one line on why it matters, ticked when
 * done (derived from the record, never asked). The steps are left out once real decisions are waiting or the viewer hid
 * them, and the card goes once the company is confirmed and every step of the viewer's is done. Never for ITS staff, and
 * no steps for a company that was already running when the check began (migration 0027): ITS set those up by hand.
 */
async function gettingStartedCard(tx: Tx, companyId: string, viewer: BriefViewer | undefined, opts: { decisionsWaiting: boolean }): Promise<BriefCard | null> {
  if (viewer?.scope || viewer?.role === "recruiter" || viewer?.role === "interviewer") return null;
  const [company] = await tx.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) return null;
  const verified = companyVerifiedAt(company.settings) !== null;
  const onboarding = companyOnboarding(company.settings);
  const setUpBefore = company.settings.verifiedBy?.id === EXISTING_COMPANY_ACTOR_ID;
  const hidden = opts.decisionsWaiting || setUpBefore || (!!viewer && !!onboarding.dismissedBy?.[viewer.userId]);
  const role = viewer?.role ?? "owner";
  const steps = hidden ? [] : await gettingStartedSteps(tx, companyId, role, company.settings, onboarding);
  if (verified && !steps.some((s) => !s.done)) return null;
  const [held] = verified ? [{ n: 0 }] : await tx.select({ n: count() }).from(communications).where(and(eq(communications.companyId, companyId), eq(communications.status, HELD_STATUS)));
  const heldMessages = Number(held?.n ?? 0);
  const waiting = heldMessages ? ` ${heldMessages} ${heldMessages === 1 ? "message" : "messages"} to candidates ${heldMessages === 1 ? "is" : "are"} waiting for it now.` : "";
  // A company whose confirmation ITS took back is checked again; the one-time check's words would not be true for it.
  const [taken] = verified ? [] : await tx.select({ id: events.id }).from(events).where(and(eq(events.companyId, companyId), eq(events.type, "company.unverified"))).limit(1);
  const lead = taken ? "ITS is checking your company again; your ITS contact will be in touch." : "ITS is confirming your company. This one-time check usually takes up to a business day.";
  // Only the people who may draft or approve a role are told they can; HR, say, cannot.
  const meanwhile = can(role, "role.create") ? (can(role, "role.approve") ? " You can draft and approve roles in the meantime." : " You can draft roles in the meantime.") : "";
  const body = verified
    ? `${steps.filter((s) => s.done).length} of ${steps.length} done. A few steps get your hiring ready; each says why it matters.`
    : `${lead} Until it is done, your careers page, job pages and Google listing stay offline, and emails to candidates wait; they go out on their own as soon as ITS confirms.${waiting}${meanwhile}`;
  const dismissible = steps.length > 0;
  return {
    kind: "getting_started",
    title: steps.length ? "Getting started" : taken ? "ITS is checking your company again" : "ITS is confirming your company",
    body,
    actions: dismissible ? [{ label: "Hide these steps", method: "POST", path: GETTING_STARTED_PATH, body: { action: "dismiss" } }] : [],
    gettingStarted: { verified, heldMessages, steps, dismissible },
  };
}

/** The steps a person in this role can do, in the order of the onboarding checklist. */
async function gettingStartedSteps(tx: Tx, companyId: string, role: MembershipRole, settings: typeof companies.$inferSelect.settings, onboarding: CompanyOnboarding): Promise<GettingStartedStep[]> {
  const steps: GettingStartedStep[] = [];
  if (can(role, "company.update")) {
    const missing = [settings.website ? null : "your website", settings.careersPage?.intro ? null : "a careers-page introduction", settings.benefitsSummary ? null : "a benefits summary"].filter((m): m is string => !!m);
    steps.push({
      key: "company_details",
      title: "Add your website, careers-page introduction and benefits",
      why: "Candidates read these on your careers page and job pages before they apply.",
      done: missing.length === 0,
      ...(missing.length ? { detail: `Still to add: ${missing.join(", ")}.${settings.logoUrl ? "" : " A logo is optional."}` } : {}),
      actions: [{ label: "Open company details", method: "GET", path: "/setup#setup-company" }],
    });
  }
  if (can(role, "members.manage")) {
    const [members] = await tx.select({ n: count() }).from(memberships).where(and(eq(memberships.companyId, companyId), eq(memberships.status, "active")));
    const [invited] = await tx.select({ n: count() }).from(invitations).where(and(eq(invitations.companyId, companyId), eq(invitations.status, "pending")));
    steps.push({
      key: "team",
      title: "Invite your team",
      why: "Everyone signs in with their own work account, so each decision is theirs and on the record.",
      done: Number(members?.n ?? 0) > 1 || Number(invited?.n ?? 0) > 0,
      actions: [{ label: "Invite people", method: "GET", path: "/setup#setup-team" }],
    });
  }
  if (can(role, "scorecard.write")) {
    const [hours] = await tx.select({ id: interviewerAvailability.id }).from(interviewerAvailability).where(and(eq(interviewerAvailability.companyId, companyId), sql`jsonb_array_length(${interviewerAvailability.windows}) > 0`)).limit(1);
    const [calendar] = hours ? [] : await tx.select({ id: integrations.id }).from(integrations).where(and(eq(integrations.companyId, companyId), eq(integrations.kind, "calendar"), eq(integrations.status, "live"))).limit(1);
    steps.push({
      key: "interview_hours",
      title: "Set when you can interview, or connect your calendar",
      why: "Candidates are offered interview times only from the hours or calendars your team has set.",
      done: !!hours || !!calendar,
      actions: [{ label: "Set my hours", method: "GET", path: "/setup#setup-availability" }],
    });
  }
  if (can(role, "role.create") && can(role, "compensation.read")) {
    const [anyRole] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.companyId, companyId)).limit(1);
    const [draft] = anyRole ? [] : await tx.select({ id: intakeSessions.id }).from(intakeSessions).where(and(eq(intakeSessions.companyId, companyId), ne(intakeSessions.status, "abandoned"))).limit(1);
    // a talk with ITS about the plan (more roles) is not a request to draft the first role
    const [asked] = await tx.select({ id: recruiterEscalations.id }).from(recruiterEscalations).where(and(eq(recruiterEscalations.companyId, companyId), eq(recruiterEscalations.kind, "ask"), isNull(recruiterEscalations.roleId), isNull(recruiterEscalations.applicationId), inArray(recruiterEscalations.status, ["open", "claimed", "in_progress"]), sql`coalesce(${recruiterEscalations.billing}->>'topic', '') <> 'plan'`)).limit(1);
    // The page opens this request in the request form, prefilled, so what the recruiter would see, the reply-by time and
    // the plan's recruiter requests are shown before anything is sent (Q31); nothing goes in one click.
    const askRecruiter = can(role, "escalation.create") && !asked ? [{ label: "Draft it with an ITS recruiter", method: "POST" as const, path: "/api/v1/escalations", body: { kind: "ask", scope: "company", question: FIRST_ROLE_QUESTION } }] : [];
    steps.push({
      key: "first_role",
      title: "Start your first role",
      why: "Describe the job in a sentence or two; the assistant asks for the rest and drafts it for you to approve. An ITS recruiter can draft it with you instead: you see what they would have access to before you send the request.",
      done: !!anyRole || !!draft,
      ...(asked ? { detail: "You asked an ITS recruiter to draft it with you; they will be in touch." } : {}),
      actions: [{ label: "Start a hire", method: "GET", path: START_HIRE_PATH }, ...askRecruiter],
    });
  }
  if (can(role, "integration.manage")) {
    steps.push({
      key: "job_boards",
      title: "Give ITS access to your job boards",
      why: "ITS posts your jobs on LinkedIn, Indeed and ZipRecruiter under your own employer accounts. Add the ITS recruiter your contact names as a user on each; never send a password by email.",
      done: !!onboarding.jobBoardsConfirmedAt,
      ...(onboarding.jobBoardsConfirmedAt ? {} : { detail: "This ticks once ITS confirms it can sign in to each one." }),
      actions: [],
    });
  }
  if (can(role, "policy.manage")) {
    steps.push({
      key: "ai_rules",
      title: "Review what the assistant may do on its own",
      why: "Everything starts at the recommended settings. You choose what waits for a person; the decisions that always need a person stay that way.",
      done: !!onboarding.policiesReviewedAt,
      actions: [{ label: "Open the AI rules", method: "GET", path: "/setup#setup-rules" }, { label: "I've reviewed them", method: "POST", path: GETTING_STARTED_PATH, body: { action: "policies_reviewed" } }],
    });
  }
  return steps;
}

/**
 * The same three checks as packet-approval.ts `assertMayApprovePacket`, applied before the card is built: role.approve,
 * the request's approver roles or named decision maker, and the self-approval rule (sole owners excepted). The fourth,
 * open wording flags, does not hide the card (the approver is the one to settle them), so it is returned for the card
 * to say what comes first.
 */
async function mayApprovePacketFromBrief(tx: Tx, companyId: string, viewer: BriefViewer, req: typeof approvalRequests.$inferSelect): Promise<{ ok: boolean; openFlags: number }> {
  const no = { ok: false, openFlags: 0 };
  if (!can(viewer.role, "role.approve")) return no;
  if (!mayDecideApproval(req, { userId: viewer.userId, role: viewer.role }).ok) return no;
  const [role] = req.roleId ? await tx.select({ id: roles.id, createdBy: roles.createdBy }).from(roles).where(eq(roles.id, req.roleId)).limit(1) : [];
  if (!role) return no;
  const version = Number((req.proposal as { version?: number }).version);
  const [pv] = Number.isFinite(version) ? await tx.select({ createdBy: rolePackets.createdBy, packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, version))).limit(1) : [];
  const ok = (await selfApprovalCheck(tx, { companyId, userId: viewer.userId, roleCreatedBy: role.createdBy, versionCreatedBy: pv?.createdBy ?? role.createdBy })).ok;
  return { ok, openFlags: unresolvedFlags(pv?.packet).length };
}

/** How many wording flags are open on the version a packet approval is for (an unknown viewer's card says so too). */
async function openFlagsOf(tx: Tx, req: typeof approvalRequests.$inferSelect): Promise<number> {
  const version = Number((req.proposal as { version?: number }).version);
  if (!req.roleId || !Number.isFinite(version)) return 0;
  const [pv] = await tx.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, req.roleId), eq(rolePackets.version, version))).limit(1);
  return unresolvedFlags(pv?.packet).length;
}

/**
 * Decisions are private until a person tells the candidate (founder decision B6): the people of one role nobody has told
 * yet, named (five at most), with the way to check the message and send it, and what the safety net does if nobody
 * does (Q27). A closed role's card also leads to its one closing message (Q30). Null when there is nobody.
 */
async function notToldCard(tx: Tx, role: { id: string; title: string }, apps: Array<{ candidateId: string }>, opts: { closed?: boolean } = {}): Promise<BriefCard | null> {
  if (!apps.length) return null;
  const names = await tx.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(inArray(candidates.id, apps.slice(0, 5).map((a) => a.candidateId)));
  const list = apps.slice(0, 5).map((a) => { const n = names.find((x) => x.id === a.candidateId); return `${n?.firstName ?? ""} ${n?.lastName ?? ""}`.trim() || "A candidate"; }).join(", ");
  const how = opts.closed
    ? "The role is closed: one courteous closing message tells everyone it left in your talent pool, and you approve it once for all of them. Or send each person their own message, or record telling them in person."
    : "Check the message first; it goes to each of them separately. Or record telling them in person.";
  return { kind: "needs_review", title: `${apps.length} ${apps.length === 1 ? "person has" : "people have"} not been told your decision yet (${role.title})`, body: `${list}${apps.length > 5 ? ` and ${apps.length - 5} more` : ""}. Your decision is private until someone tells them. ${how} If nobody has after ${UNTOLD_SEND_WORKING_DAYS} working days, the standard message goes by itself and you are told (when your settings ask for approval or keep decision messages with a person, or a recruiter runs the role, a recruiter is brought in instead and nothing is sent).`, roleId: role.id, actions: [{ label: "Review and send", method: "GET", path: `/roles/${role.id}/talent?ownerStage=not_moving_forward&told=not_told` }, ...(opts.closed ? [{ label: "Send the closing message", method: "GET" as const, path: `/roles/${role.id}?closingMessage=1` }] : [])] };
}

/**
 * The long-wait card (plan G10): people have waited on the team for days. It names the one waiting longest and opens
 * them on the three ways forward: decide, put them on hold until a date (they come back to Today then), or send them a
 * note in your own words. Nothing is sent from here. `askRecruiter`: whether to offer a recruiter's review of the role
 * (null for a recruiter given one candidate, whose card names nobody else).
 */
async function longWaitCard(tx: Tx, d: { roleId: string; roleTitle: string; title: string; body: string; days: number; action: { href: string } }, applicationIds: string[], askRecruiter: boolean | null): Promise<BriefCard | null> {
  const [first] = await tx.select({ id: applications.id, stageChangedAt: applications.stageChangedAt, firstName: candidates.firstName, lastName: candidates.lastName }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(eq(applications.id, applicationIds[0])).limit(1);
  if (!first) return null;
  const name = `${first.firstName} ${first.lastName}`.trim() || "A candidate";
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(first.stageChangedAt)) / 86_400_000));
  const others = applicationIds.length - 1;
  const open = `/roles/${d.roleId}/talent?open=${first.id}`;
  const narrowed = askRecruiter === null;
  return {
    kind: "stuck",
    title: narrowed ? `${name} has been waiting on you for ${days} days (${d.roleTitle})` : d.title,
    body: `${narrowed ? "" : `${d.body} `}${name} has waited longest, ${days} ${days === 1 ? "day" : "days"}${!narrowed && others ? `; ${others} more ${others === 1 ? "is" : "are"} waiting too` : ""}. Decide what comes next, put them on hold until a date (they come back to Home then), or send them a note in your own words. Nothing is sent until you do.`,
    roleId: d.roleId,
    applicationId: first.id,
    actions: [
      { label: "Decide", method: "GET", path: open },
      { label: "Hold until a date", method: "GET", path: `${open}&step=hold` },
      { label: "Send a note", method: "GET", path: `${open}&message=1` },
      ...(!narrowed && others ? [{ label: "See everyone waiting", method: "GET" as const, path: d.action.href }] : []),
      ...(askRecruiter ? [{ label: "Have a recruiter review", method: "POST" as const, path: `/api/v1/escalations`, body: { kind: "review", roleId: d.roleId } }] : []),
    ],
  };
}

/**
 * The Cancelled column on Today (founder decisions 1A to 4A): one card per role for the people under Cancelled with
 * nothing in motion for them (no automatic set promised, no new times being prepared or out), longest there first, five
 * named with why they are there. They are left out of "needs your review" and "Decide after the interview" (and the
 * stuck detector leaves them out of the long-wait card), so nobody gets two cards; someone whose new times are promised
 * or on their way waits on nobody and is on no card. Null when nobody waits.
 */
async function cancelledColumnCard(tx: Tx, role: { id: string; title: string }, people: Array<{ candidateId: string; followUp: FollowUpView }>): Promise<BriefCard | null> {
  const waiting = people.filter((p) => !followUpInMotion(p.followUp)).sort((x, y) => Date.parse(x.followUp.since) - Date.parse(y.followUp.since));
  if (!waiting.length) return null;
  const shown = waiting.slice(0, 5);
  const names = await tx.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(inArray(candidates.id, shown.map((p) => p.candidateId)));
  const list = shown.map((p) => { const n = names.find((x) => x.id === p.candidateId); return `${`${n?.firstName ?? ""} ${n?.lastName ?? ""}`.trim() || "A candidate"} (${CANCELLED_REASON_LABEL[p.followUp.reason].toLowerCase()})`; }).join(", ");
  const more = waiting.length > 5 ? ` and ${waiting.length - 5} more` : "";
  return {
    kind: "interviews",
    title: `${waiting.length} ${waiting.length === 1 ? "person" : "people"} under Cancelled for ${role.title}`,
    body: `${list}${more}. Send new times, or decide for each of them. Nothing is on its way to them now.`,
    roleId: role.id,
    actions: [{ label: "See them", method: "GET", path: `/roles/${role.id}/talent?ownerStage=cancelled` }],
  };
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
    if (who.requests && latest?.decision === "next_round") out.push({ kind: "decision", title: `Set up the next round: ${name}`, body: `You chose the next round after ${latest.title}. Approve it from the candidate's page and times go out to them.`, roleId: role.id, applicationId: app.id, actions: [{ label: "Approve the next round", method: "GET", path: `${open}&step=interview` }] });
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
  if (!cards.length) cards.push({ kind: "empty", title: "Nothing needs you right now", body: "Your interviews appear here as soon as you are put on one. Keep your calendar or declared hours up to date in Settings so times can be offered.", actions: [{ label: "My availability", method: "GET", path: "/setup" }] });
  const summary = `${upcoming.length} ${upcoming.length === 1 ? "interview" : "interviews"} coming up · ${offering.length} being scheduled · ${toRecord.length} to record.`;
  return { generatedAt: new Date().toISOString(), cards, summary };
}


