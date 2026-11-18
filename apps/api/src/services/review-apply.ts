import { and, eq } from "drizzle-orm";
import { BATCH_ACTION_LABEL, BatchAction, DECLINE_REASON_LABEL, MARK_LABEL, TRIAL_ENDED_LINE, type Actor, type ApplicationAction, type BatchPreview, type BatchPreviewItem, type BatchResult, type BatchResultItem, type MarkKind, type RejectReason, type RoleBatchItem, type RoleBatchRequest } from "@ros/contracts";
import { PermissionError, assertCan, emit, entitlements, markBlockedReason, randomToken } from "@ros/core";
import { applications, roles, withTenant, type Tx } from "@ros/db";
import { HttpError, PERMISSION_MESSAGE } from "../middleware/errors";
import { reportError } from "../observability";
import type { Container } from "../container";
import type { Tenant } from "../middleware/session";
import { applicationActionState, applicationFacts, performApplicationAction, type ApplicationCapability } from "./application-actions";
import { columnWords, isUuid, loadPool, type PoolRow } from "./pool";
import { companyTrialStanding } from "./trial";

/**
 * Review and apply (plan F8; plan-adjustments section 3; founder decision B4): the pool board's suggestions applied by a
 * person, for up to 50 people at once. Shortlist, Longlist and On hold set private marks; Not moving forward files a
 * private decline with a reason from the fixed list, pre-filled from the person's own evidence; nobody is emailed about
 * any of them, and the told state stays "not told" until someone sends the decision message (B6). Inviting to the
 * screening conversation is offered too.
 *
 * Each person is applied in a transaction of their own, through the same `performApplicationAction` as a click on their
 * page, so the gates, the approvals, the marks' rules and the outbox's idempotency all hold, and one refusal never
 * blocks the rest. The preview (`dryRun`) changes nothing: per person, what will happen, whether it may and why not.
 */
const PRIVACY = "Private: nobody is told about a shortlist, longlist, hold or not-moving-forward decision. Send decision messages later, from the Talent page, when you are ready.";
const MARK_OF: Partial<Record<BatchAction, MarkKind>> = { shortlist: "shortlist", longlist: "longlist", on_hold: "on_hold" };
const CAPABILITY_OF: Record<BatchAction, ApplicationCapability> = { shortlist: "set_mark", longlist: "set_mark", on_hold: "set_mark", not_moving_forward: "reject", invite_screen: "invite_screen" };

/**
 * Why someone the board keeps apart (R20-7, R20-9) is never applied from it, by where their AI interview stands: being
 * scored, waiting to be scored for want of AI help, its scorecard could not be written, still to come, or closed (a link that lapsed or was stopped, one left
 * part-way, or one that never came for want of allowance, Q17), which they cannot finish without a new link. Neutral, like
 * the lane: never how far they got.
 */
const APART_REFUSAL = {
  being_scored: "Their AI interview is being scored; they join the board when it is. Decide from their own page if you need to.",
  not_scored: "Their AI interview is in, but your plan's AI help is used up, so it was not scored. Read their answers and decide from their own page.",
  scoring_failed: "Their AI interview is in, but its AI review could not be written, so it was not scored. Read their answers and decide from their own page.",
  not_done_yet: "They have no AI interview yet; they join the board when they finish it. Decide from their own page if you need to.",
  not_done: "They have no AI interview and none is open, so the board leaves them out. Decide from their own page, or send them a new AI interview link.",
} as const;

/** The batch-only reasons a person cannot be included, before the usual rules of their page. */
function batchRefusal(row: PoolRow | undefined, item: RoleBatchItem): string | null {
  if (!row) return "Not a candidate of this role.";
  // Never suggested or applied from the board before their AI interview is in their score (R20-7, R20-9): decide from
  // their own page if needed.
  if (row.noAiInterview) return row.interview === "being_scored" ? APART_REFUSAL.being_scored : row.interview === "not_scored" ? APART_REFUSAL.not_scored : row.interview === "scoring_failed" ? APART_REFUSAL.scoring_failed : row.interview === "not_done" ? APART_REFUSAL.not_done : APART_REFUSAL.not_done_yet;
  if (item.action === "not_moving_forward" && row.activeInterview) return "They have an interview in motion. Decide from their page, so the interview is called off properly.";
  return null;
}

/** What the page's rules say about this action for this person (the same rules as their own page), or null when it may go ahead. */
async function pageRefusal(tx: Tx, row: PoolRow, item: RoleBatchItem, tenant: Tenant): Promise<string | null> {
  const facts = await applicationFacts(tx, row.app, tenant.role);
  const { allowed, blockedReasons } = applicationActionState(facts);
  const cap = CAPABILITY_OF[item.action];
  if (!allowed.includes(cap)) return blockedReasons[cap] ?? "Not available at this step.";
  const mark = MARK_OF[item.action];
  return mark ? markBlockedReason(row.app.stage, mark) : null;
}

/** The reason a not-moving-forward is filed with: the person's choice, or the one pre-filled from their own evidence. */
function declineFor(row: PoolRow, item: RoleBatchItem): { reason: RejectReason; note: string } | null {
  const pre = row.placement.declineReason;
  const reason = item.reason ?? pre?.reason ?? null;
  if (!reason) return null;
  return { reason, note: item.note?.trim() || pre?.note || "" };
}

function warningsFor(row: PoolRow, item: RoleBatchItem): string[] {
  const out: string[] = [];
  const suggested = row.placement.suggestedAction;
  if (suggested && suggested !== item.action && (item.action === "shortlist" || item.action === "longlist" || item.action === "not_moving_forward")) out.push(`The board suggested ${BATCH_ACTION_LABEL[suggested]}.`);
  if (row.placement.needsYourEye) out.push(row.placement.needsYourEye);
  if (row.evidence.lowConfidence && !row.placement.needsYourEye?.includes("confident")) out.push("The assistant was not confident about this AI review.");
  if (row.match?.missingMustHave.length && item.action !== "not_moving_forward") out.push(`Missing must-have: ${row.match.missingMustHave.map((m) => m.label).join(", ")}.`);
  if (item.action === "not_moving_forward" && row.openScreen) out.push("Their open AI interview is closed; they are not told why.");
  if (item.action === "invite_screen") out.push("They get an email with a link to the AI interview.");
  return out;
}

/** "5 decisions ready: 2 shortlist · 1 longlist · 2 not moving forward". */
function readyWords(counts: Record<BatchAction, number>, ready: number): string {
  const parts = BatchAction.options.filter((a) => counts[a]).map((a) => `${counts[a]} ${BATCH_ACTION_LABEL[a].toLowerCase()}`);
  return `${ready} ${ready === 1 ? "decision" : "decisions"} ready${parts.length ? `: ${parts.join(" · ")}` : ""}`;
}

const emptyCounts = () => Object.fromEntries(BatchAction.options.map((a) => [a, 0])) as Record<BatchAction, number>;

/** The preview: nothing changes. One read-only transaction over the people named. */
export async function previewBatch(container: Container, input: { roleId: string; tenant: Tenant; body: RoleBatchRequest }): Promise<BatchPreview> {
  const { tenant: t, body } = input;
  assertCan(t.role, "application.read");
  return withTenant(container.db, t.companyId, async (tx) => {
    const pool = await loadPool(tx, { roleId: input.roleId, onlyIds: body.items.map((i) => i.applicationId) });
    const items: BatchPreviewItem[] = [];
    const counts = emptyCounts();
    // A new screening chat waits for a plan once a trial has ended (founder decision L-02 B): the preview says so up front,
    // as the run refuses it (402 trial_ended per person).
    const paused = body.items.some((i) => i.action === "invite_screen") && (await companyTrialStanding(tx, t.companyId, container.engine.clock()))?.ended === true;
    for (const item of body.items) {
      const row = pool.rows.find((r) => r.app.id === item.applicationId);
      let refusedReason = batchRefusal(row, item);
      if (!refusedReason && row && paused && item.action === "invite_screen") refusedReason = TRIAL_ENDED_LINE;
      if (!refusedReason && row) refusedReason = await pageRefusal(tx, row, item, t);
      const decline = row && item.action === "not_moving_forward" ? declineFor(row, item) : null;
      if (!refusedReason && item.action === "not_moving_forward" && !decline) refusedReason = "Choose a reason from the list.";
      const allowed = !refusedReason;
      if (allowed) counts[item.action] += 1;
      items.push({
        applicationId: item.applicationId,
        name: row?.name ?? "Unknown",
        score: row?.match?.score ?? null,
        band: row?.match?.band ?? null,
        placement: row?.placement.column ?? null,
        suggested: row?.placement.suggestedAction ?? null,
        action: item.action,
        allowed,
        refusedReason,
        warnings: row ? warningsFor(row, item) : [],
        reason: decline ? { reason: decline.reason, label: DECLINE_REASON_LABEL[decline.reason], note: decline.note } : null,
      });
    }
    const ready = items.filter((i) => i.allowed).length;
    // Screening conversations are counted when someone starts one, never refused once started (Q17): the preview says where the plan stands.
    const allowance = counts.invite_screen ? await entitlements.check(tx, t.companyId, entitlements.TEXT_SCREENS, counts.invite_screen) : null;
    const screenWords = allowance && allowance.limit !== null ? `Your plan includes ${allowance.limit} AI interviews this month and ${allowance.used} ${allowance.used === 1 ? "has" : "have"} been used.${allowance.ok ? "" : " Inviting these may go past it; nobody who starts is cut off, and ITS will talk with you about the extra."}` : null;
    return { dryRun: true, items, counts, ready, words: readyWords(counts, ready), screenAllowance: { limit: allowance?.limit ?? null, used: allowance?.used ?? 0, inThisBatch: counts.invite_screen, words: screenWords }, privacy: PRIVACY };
  });
}

/**
 * Applies the batch, one person per transaction. Emits `pool.batch_applied` with what the board suggested and what the
 * person chose for each.
 */
export async function applyBatch(container: Container, input: { roleId: string; tenant: Tenant; actor: Actor; body: RoleBatchRequest }): Promise<BatchResult> {
  const { tenant: t, actor, body } = input;
  assertCan(t.role, "application.act");
  const [known] = isUuid(input.roleId) ? await withTenant(container.db, t.companyId, (tx) => tx.select({ id: roles.id }).from(roles).where(eq(roles.id, input.roleId)).limit(1)) : [];
  if (!known) throw new HttpError(404, "not_found", "Role not found.");
  const batchId = randomToken(12);
  const results: BatchResultItem[] = [];
  for (const item of body.items) {
    const out: BatchResultItem = { applicationId: item.applicationId, name: "Unknown", action: item.action, suggested: null, ok: false, code: null, message: "", ownerStage: null, candidateNotice: null };
    try {
      await withTenant(container.db, t.companyId, async (tx) => {
        // The row is locked, as on the person's own page: two people sorting the same candidate take turns.
        const [locked] = isUuid(item.applicationId) ? await tx.select({ id: applications.id }).from(applications).where(and(eq(applications.id, item.applicationId), eq(applications.roleId, input.roleId))).limit(1).for("update") : [];
        const pool = locked ? await loadPool(tx, { roleId: input.roleId, onlyIds: [item.applicationId] }) : null;
        const row = pool?.rows[0];
        out.name = row?.name ?? out.name;
        out.suggested = row?.placement.suggestedAction ?? null;
        const refused = batchRefusal(row, item) ?? (row ? await pageRefusal(tx, row, item, t) : null);
        if (refused) throw new HttpError(409, "not_allowed", refused);
        const via = { via: "review_and_apply" as const, batchId, suggested: out.suggested };
        let action: ApplicationAction;
        if (item.action === "not_moving_forward") {
          const decline = declineFor(row!, item);
          if (!decline) throw new HttpError(400, "reason_required", "Choose a reason from the list.");
          action = { action: "reject", reason: decline.reason, note: decline.note || undefined };
        } else if (item.action === "invite_screen") action = { action: "invite_screen" };
        else action = { action: "set_mark", mark: MARK_OF[item.action], note: item.note };
        const r = await performApplicationAction(tx, container, { app: row!.app, body: action, tenant: t, actor, via });
        out.ok = true;
        out.ownerStage = r.ownerStage ?? null;
        out.candidateNotice = r.candidateNotice ?? null;
        out.message = item.action === "invite_screen" ? "Invitation to the AI interview on its way." : item.action === "not_moving_forward" ? "Filed as not moving forward, privately. They were not told." : `${MARK_LABEL[MARK_OF[item.action]!]}, privately. They were not told.`;
      });
    } catch (e) {
      if (e instanceof HttpError) {
        out.code = e.code;
        out.message = e.message;
      } else if (e instanceof PermissionError) {
        out.code = "forbidden";
        out.message = PERMISSION_MESSAGE;
      } else {
        // One person's failure never stops the rest; it is reported like any unhandled error, with the route only.
        reportError(e, { process: "api", method: "POST", path: "/api/v1/roles/:id/batch" });
        out.code = "error";
        out.message = "Something went wrong with this one; nothing changed for them.";
      }
    }
    results.push(out);
  }
  // Keep the order the person gave.
  results.sort((a, b) => body.items.findIndex((i) => i.applicationId === a.applicationId) - body.items.findIndex((i) => i.applicationId === b.applicationId));
  const applied = results.filter((r) => r.ok);
  await withTenant(container.db, t.companyId, (tx) => emit(tx, { type: "pool.batch_applied", companyId: t.companyId, actor, subject: { type: "role", id: input.roleId }, payload: { batchId, suggestedBy: "assistant", appliedBy: actor.name ?? actor.id, items: results.map((r) => ({ applicationId: r.applicationId, suggested: r.suggested, chosen: r.action, ok: r.ok, code: r.code })), applied: applied.length, refused: results.length - applied.length, followedSuggestion: applied.filter((r) => r.suggested === r.action).length } }));
  await container.kick();
  const counts = emptyCounts();
  for (const r of applied) counts[r.action] += 1;
  const sorted = columnWords({ shortlist: counts.shortlist, longlist: counts.longlist, not_moving_forward: counts.not_moving_forward });
  const extra = [counts.on_hold ? `${counts.on_hold} on hold` : "", counts.invite_screen ? `${counts.invite_screen} invited to the AI interview` : ""].filter(Boolean);
  const words = applied.length
    ? `Applied ${applied.length} ${applied.length === 1 ? "decision" : "decisions"}${sorted || extra.length ? `: ${[sorted, ...extra].filter(Boolean).join(", ")}` : ""}.${results.length > applied.length ? ` ${results.length - applied.length} could not be applied; each says why.` : ""}`
    : "Nothing was applied; each person says why.";
  return { dryRun: false, batchId, results, applied: applied.length, refused: results.length - applied.length, words, privacy: PRIVACY };
}
