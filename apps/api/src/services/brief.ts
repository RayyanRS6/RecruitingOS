import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { POSTING_CHANNELS, STAGE_LABEL, can, isBoardChannel, ownerGroup } from "@ros/core";
import { detectStuckRoles } from "@ros/agents";
import type { MembershipRole } from "@ros/contracts";
import { applications, approvalRequests, assessments, candidates, companies, events, interviewParticipants, interviews, postings, recruiterEscalations, roles, screens, type Tx } from "@ros/db";

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

/** Who is reading the brief. An interviewer sees only their own interviews; every other role sees the company's day. */
export type BriefViewer = { userId: string; role: MembershipRole };

/**
 * The morning brief, Slice 1: deterministic, from the system of record. The orchestrator agent replaces the
 * prose in a later slice; the sections and actions stay the same.
 */
export async function composeBrief(tx: Tx, companyId: string, viewer?: BriefViewer): Promise<Brief> {
  if (viewer?.role === "interviewer") return interviewerBrief(tx, companyId, viewer);
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const cards: BriefCard[] = [];
  // The after-interview cards ask for a decision or an approval, so they go only to the roles that can give one (HR cannot). An unknown viewer is treated as the owner.
  const afterInterview = { decides: !viewer || can(viewer.role, "interview.decide"), requests: !viewer || can(viewer.role, "interview.request") };
  const openRoles = await tx.select().from(roles).where(and(eq(roles.companyId, companyId), inArray(roles.status, ["open", "paused", "pending_approval"])));

  const pending = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.status, "pending"))).orderBy(desc(approvalRequests.createdAt));
  for (const p of pending) {
    const role = openRoles.find((r) => r.id === p.roleId);
    if (p.actionType === "role_packet.approve") {
      // A version proposed while the role runs is a different decision from opening a new role: the card says which.
      const proposal = p.proposal as { version?: number; editWhileOpen?: boolean };
      const editWhileOpen = !!proposal.editWhileOpen && role?.status !== "pending_approval";
      cards.push({ kind: "decision", title: editWhileOpen ? `Approve packet v${proposal.version ?? "?"} of ${role?.title ?? "the role"}` : `Approve the role: ${role?.title ?? "new role"}`, body: p.rationale ?? (editWhileOpen ? "The role keeps running on its approved version until you decide." : "Review the role packet and approve it to start posting."), roleId: p.roleId ?? undefined, approvalRequestId: p.id, actions: [{ label: editWhileOpen ? "Review the change" : "Review and approve", method: "GET", path: `/roles/${p.roleId}` }] });
    } else if (p.actionType === "application.invite_screen" || p.actionType === "application.recommend_interview") {
      const verb = p.actionType === "application.invite_screen" ? "Invite to a screen" : "Interview";
      cards.push({ kind: "decision", title: `${verb}? ${role?.title ?? ""}`.trim(), body: p.rationale ?? "", roleId: p.roleId ?? undefined, applicationId: p.applicationId ?? undefined, approvalRequestId: p.id, actions: [{ label: `Yes, ${verb.toLowerCase()}`, method: "POST", path: `/api/v1/approvals/${p.id}/decide`, body: { decision: "approve" } }, { label: "Review first", method: "GET", path: p.applicationId ? `/roles/${p.roleId}/talent?open=${p.applicationId}` : `/roles/${p.roleId}/talent` }] });
    } else {
      // Any other approval: the decide route needs a decision in the body, so the card posts one, and links to the page the request is about.
      const where = p.applicationId ? `/roles/${p.roleId}/talent?open=${p.applicationId}` : p.roleId ? `/roles/${p.roleId}` : null;
      cards.push({ kind: "decision", title: `Decision needed: ${p.actionType.replace(/[._]/g, " ")}`, body: p.rationale ?? "", roleId: p.roleId ?? undefined, applicationId: p.applicationId ?? undefined, approvalRequestId: p.id, actions: [{ label: "Approve", method: "POST", path: `/api/v1/approvals/${p.id}/decide`, body: { decision: "approve" } }, { label: "Decline", method: "POST", path: `/api/v1/approvals/${p.id}/decide`, body: { decision: "reject" } }, ...(where ? [{ label: "Review first", method: "GET" as const, path: where }] : [])] });
    }
  }

  for (const role of openRoles.filter((r) => r.status === "open")) {
    const apps = await tx.select().from(applications).where(and(eq(applications.roleId, role.id)));
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
      cards.push({ kind: "needs_review", title: `${waiting.length} ${waiting.length === 1 ? "candidate needs" : "candidates need"} your review for ${role.title}`, body: list, roleId: role.id, actions: [{ label: "Review", method: "GET", path: `/roles/${role.id}/talent` }, { label: "Bring in a recruiter", method: "POST", path: `/api/v1/escalations`, body: { kind: "review", roleId: role.id } }] });
    }
    if (ineligible.length) {
      cards.push({ kind: "needs_review", title: `${ineligible.length} ${ineligible.length === 1 ? "applicant" : "applicants"} for ${role.title} did not meet an eligibility rule`, body: "Held for your decision. Nothing is sent to them unless you decline; override if the answer was a mistake.", roleId: role.id, actions: [{ label: "Review", method: "GET", path: `/roles/${role.id}/talent?stage=ineligible` }] });
    }
    // Boards waiting to be posted by hand (docs/spec/20): ready to post means the package and the tracked link exist and nothing is on the board yet.
    const manualPostings = (await tx.select().from(postings).where(and(eq(postings.roleId, role.id), eq(postings.status, "ready_to_post")))).filter((p) => isBoardChannel(p.channel));
    if (manualPostings.length) {
      cards.push({ kind: "posting_action", title: `${role.title}: post it on ${manualPostings.map((p) => CHANNEL_NAME[p.channel] ?? p.channel).join(", ")} from your own account`, body: "These boards are not connected to the product. The role's Posting tab has the posting package, each board's own apply link and the steps; record the public URL there once it is up.", roleId: role.id, actions: [{ label: "See instructions", method: "GET", path: `/roles/${role.id}` }] });
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
  const stillUp = (await tx.select({ roleId: postings.roleId, channel: postings.channel }).from(postings).where(and(eq(postings.companyId, companyId), eq(postings.closureRequired, true), isNull(postings.closureConfirmedAt)))).filter((p) => isBoardChannel(p.channel)).sort((a, b) => channelOrder(a.channel) - channelOrder(b.channel));
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


