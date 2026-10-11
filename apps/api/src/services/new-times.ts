import { and, eq, inArray } from "drizzle-orm";
import type { Actor, CancelledView, MembershipRole, SendNewTimesBatch, SendNewTimesBatchResult, SendNewTimesResult } from "@ros/contracts";
import { CANCEL_STAGES, PermissionError, activeFollowUpsFor, assertCan, cancelledView, emit, followUpParked, openFollowUpOf, setAutoState, type FollowUpRow } from "@ros/core";
import { companyConfirmed } from "@ros/agents";
import { applications, candidates, companies, interviews, roles, withTenant, type Tx } from "@ros/db";
import { activeInterviewersOf, cancelNewTimesRuns, reopenForNewTimes } from "@ros/workflows";
import type { Container } from "../container";
import { HttpError, PERMISSION_MESSAGE } from "../middleware/errors";
import { reportError } from "../observability";
import type { Tenant } from "../middleware/session";
import { createApprovedInterview } from "./interview-create";

/**
 * The team's new times for someone under Cancelled (founder decision 2A: "the team can send new times to one person or
 * the whole column"). A person's click reopens the interview a person already approved, with a fresh window from the same
 * interviewers' calendars; someone who did not come gets a new interview for the same round instead, which needs the
 * approval permission and is approved by that click (AC10.1). Times count as sent only once their email is on its way
 * (`newTimesOffered`, packages/core). Sending moves nobody out of the column: they leave when they book.
 */

const NOT_IN_CANCELLED = "They are not under Cancelled any more.";
const TIMES_OUT = "New times are already being prepared or are out to them.";
const NO_EMAIL = "We have no email address for them. Call them, then book a time from the interview page.";
const COMPANY_NOT_CHECKED = "New times can go out once ITS confirms your company. Until then, emails to candidates wait.";
const NO_INTERVIEWERS = "Nobody who ran that interview is still on your team. Approve a new interview from their page and choose the interviewers.";
const CHANGED = "Something changed a moment ago. Refresh to see where they are now.";
const NOTHING_DUE = "Nothing is due to go to them automatically.";
const STAFF_SCOPE = "Your access covers one candidate, so you can send new times to them only.";

type SendInput = { companyId: string; applicationId: string; actor: Actor; role: MembershipRole; approvedBy: string; via: "person" | "batch"; now: Date; /** the batch's role: an application of another role is refused */ roleId?: string };

const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** The application, locked, then its open follow-up, locked: the order the automatic set and an approval take them too. */
async function lockedFollowUp(tx: Tx, input: { companyId: string; applicationId: string; roleId?: string }): Promise<{ app: typeof applications.$inferSelect; followUp: FollowUpRow }> {
  const [app] = isUuid(input.applicationId) ? await tx.select().from(applications).where(and(eq(applications.id, input.applicationId), eq(applications.companyId, input.companyId))).limit(1).for("update") : [];
  if (!app) throw new HttpError(404, "not_found", "Application not found.");
  const followUp = await openFollowUpOf(tx, app.id, { lock: true });
  if (!followUp || !CANCEL_STAGES.includes(app.stage) || (input.roleId && app.roleId !== input.roleId)) throw new HttpError(409, "not_in_cancelled", NOT_IN_CANCELLED);
  return { app, followUp };
}

/** What the team sees of them now, in the company's days. */
async function viewNow(tx: Tx, companyId: string, applicationId: string): Promise<CancelledView> {
  const [co] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId)).limit(1);
  const view = (await activeFollowUpsFor(tx, [applicationId])).get(applicationId);
  if (!view) throw new HttpError(409, "not_in_cancelled", NOT_IN_CANCELLED);
  return cancelledView(view, { timeZone: co?.timezone ?? "America/Los_Angeles" });
}

/** A person took it from here: an automatic set still waiting for its day (or for the ITS check) does not go. */
async function stopPendingSet(tx: Tx, container: Container, input: { companyId: string; applicationId: string; actor: Actor; now: Date; reason: "team_acted" | "stopped_by_team"; why: string }): Promise<boolean> {
  const row = await openFollowUpOf(tx, input.applicationId, { lock: true });
  if (!row || !followUpParked(row)) return false;
  await setAutoState(tx, { followUpId: row.id, to: "not_sent", reason: input.reason, actor: input.actor, now: input.now });
  await cancelNewTimesRuns(tx, container.engine, { companyId: input.companyId, applicationId: input.applicationId, actor: input.actor, reason: input.why });
  return true;
}

/**
 * "Send new times" for one person, inside the caller's tenant transaction. Refused, with a plain reason, for someone no
 * longer under Cancelled, someone whose new times are already being prepared or out, someone with no email address, and
 * before ITS has confirmed the company (every email to its candidates waits then, and the times would lapse unseen).
 */
export async function sendNewTimes(tx: Tx, container: Container, input: SendInput): Promise<SendNewTimesResult> {
  const { companyId, actor, now } = input;
  assertCan(input.role, "interview.manage");
  const { app, followUp } = await lockedFollowUp(tx, input);
  const view = (await activeFollowUpsFor(tx, [app.id])).get(app.id);
  if (!view || view.interviewOpen) throw new HttpError(409, "times_out", TIMES_OUT);
  const [cand] = await tx.select({ email: candidates.email, anonymizedAt: candidates.anonymizedAt }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  if (!cand?.email || cand.anonymizedAt) throw new HttpError(400, "no_email", NO_EMAIL);
  if (!(await companyConfirmed(tx, companyId))) throw new HttpError(409, "company_not_checked", COMPANY_NOT_CHECKED);

  let interviewId: string;
  let via: SendNewTimesResult["via"] = "reopened";
  const reopened = await reopenForNewTimes(tx, container.engine, { followUp, actor, via: input.via, offerKind: followUp.choice === "new_times" ? "new_times_asked" : "new_times_team", now });
  if (reopened.ok) interviewId = reopened.interviewId;
  else if (reopened.reason === "not_reopenable") {
    // Someone who did not come: a new interview for the same round, from the same interviewers still on the team. A new
    // interview is a person's approval (policy interview.request); this click is it.
    assertCan(input.role, "interview.request");
    const [missed] = await tx.select().from(interviews).where(eq(interviews.id, followUp.interviewId)).limit(1);
    const interviewers = missed ? await activeInterviewersOf(tx, companyId, missed.id) : [];
    if (!missed || !interviewers.length) throw new HttpError(409, "no_interviewers", NO_INTERVIEWERS);
    const pasted = missed.linkSource === "pasted";
    const made = await createApprovedInterview(tx, container, { companyId, applicationId: app.id, roundKey: missed.roundKey, interviewerUserIds: interviewers, linkSource: pasted ? "pasted" : "calendar", meetingUrl: pasted ? missed.meetingUrl : null, note: "New times after the candidate did not attend", actor, by: input.role, approvedBy: input.approvedBy, now, locked: true, via: input.via });
    interviewId = made.interviewId;
    via = "new_interview";
  } else if (reopened.reason === "no_interviewers") throw new HttpError(409, "no_interviewers", NO_INTERVIEWERS);
  else if (reopened.reason === "times_out") throw new HttpError(409, "times_out", TIMES_OUT);
  else throw new HttpError(409, reopened.reason, CHANGED);

  await stopPendingSet(tx, container, { companyId, applicationId: app.id, actor, now, reason: "team_acted", why: "a person sent new times" });
  // The person's act; the times count as sent (`interview.new_times_sent`) only once their email is queued.
  await emit(tx, { type: "human.override", companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "interview.new_times", followUpId: followUp.id, via: input.via } });
  return { ok: true, interviewId, via, cancelled: await viewNow(tx, companyId, app.id) };
}

/** "Don't send automatically": the set waiting for its day does not go; they stay under Cancelled for the team. */
export async function stopNewTimes(tx: Tx, container: Container, input: { companyId: string; applicationId: string; actor: Actor; role: MembershipRole; now: Date }): Promise<{ ok: true; cancelled: CancelledView }> {
  assertCan(input.role, "interview.manage");
  const { app, followUp } = await lockedFollowUp(tx, input);
  const stopped = await stopPendingSet(tx, container, { companyId: input.companyId, applicationId: app.id, actor: input.actor, now: input.now, reason: "stopped_by_team", why: "stopped by the team" });
  if (!stopped) throw new HttpError(409, "nothing_due", NOTHING_DUE);
  await emit(tx, { type: "human.override", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: app.id }, payload: { action: "interview.new_times_stop", followUpId: followUp.id } });
  return { ok: true, cancelled: await viewNow(tx, input.companyId, app.id) };
}

/**
 * "Send new times" to several people under one role's Cancelled column, one transaction each: one refusal never stops
 * the rest, and each person's result says why in plain words. Recorded once on the role. An ITS recruiter whose access
 * covers one candidate reaches that candidate only (as with the decision messages): anyone else is refused, and their
 * name is never looked up.
 */
export async function sendNewTimesBatch(container: Container, input: { roleId: string; tenant: Tenant; actor: Actor; body: SendNewTimesBatch }): Promise<SendNewTimesBatchResult> {
  const { tenant: t, actor } = input;
  assertCan(t.role, "interview.manage");
  const ids = [...new Set(input.body.applicationIds)];
  const only = t.staff?.scope.applicationId ?? null;
  const inScope = (id: string) => !only || id === only;
  const names = await withTenant(container.db, t.companyId, async (tx) => {
    const [role] = isUuid(input.roleId) ? await tx.select({ id: roles.id }).from(roles).where(and(eq(roles.id, input.roleId), eq(roles.companyId, t.companyId))).limit(1) : [];
    if (!role) throw new HttpError(404, "not_found", "Role not found.");
    const visible = ids.filter(inScope);
    const rows = visible.length ? await tx.select({ id: applications.id, first: candidates.firstName, last: candidates.lastName }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(and(eq(applications.roleId, input.roleId), inArray(applications.id, visible))) : [];
    return new Map(rows.map((r) => [r.id, `${r.first} ${r.last}`.trim()]));
  });
  const results: SendNewTimesBatchResult["results"] = [];
  for (const applicationId of ids) {
    const out: SendNewTimesBatchResult["results"][number] = { applicationId, name: names.get(applicationId) || "This candidate", ok: false };
    if (!inScope(applicationId)) {
      out.code = "staff_scope";
      out.message = STAFF_SCOPE;
      results.push(out);
      continue;
    }
    try {
      const sent = await withTenant(container.db, t.companyId, (tx) => sendNewTimes(tx, container, { companyId: t.companyId, applicationId, actor, role: t.role, approvedBy: t.userId, via: "batch", now: container.engine.clock(), roleId: input.roleId }));
      out.ok = true;
      out.interviewId = sent.interviewId;
    } catch (e) {
      if (e instanceof HttpError) {
        out.code = e.code;
        out.message = e.message;
      } else if (e instanceof PermissionError) {
        out.code = "forbidden";
        out.message = PERMISSION_MESSAGE;
      } else {
        // One person's failure never stops the rest; it is reported like any unhandled error, with the route only.
        reportError(e, { process: "api", method: "POST", path: "/api/v1/roles/:id/new-times" });
        out.code = "error";
        out.message = "Something went wrong with this one; nothing changed for them.";
      }
    }
    results.push(out);
  }
  const sent = results.filter((r) => r.ok).length;
  await withTenant(container.db, t.companyId, (tx) => emit(tx, { type: "interview.new_times_batch", companyId: t.companyId, actor, subject: { type: "role", id: input.roleId }, payload: { roleId: input.roleId, requested: ids.length, sent, notSent: ids.length - sent } }));
  return { results, sent, notSent: ids.length - sent };
}
