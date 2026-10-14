import { and, eq } from "drizzle-orm";
import { BATCH_ACTION_LABEL, BatchAction, DECLINE_REASON_LABEL, MARK_LABEL, type Actor, type ApplicationAction, type BatchPreview, type BatchPreviewItem, type BatchResult, type BatchResultItem, type MarkKind, type RejectReason, type RoleBatchItem, type RoleBatchRequest } from "@ros/contracts";
import { ESCALATION_ACCESS_DAYS, PermissionError, assertCan, can, createEscalation, emit, entitlements, markBlockedReason, randomToken } from "@ros/core";
import { applications, companies, roles, withPlatform, withTenant, type Tx } from "@ros/db";
import { HttpError, PERMISSION_MESSAGE } from "../middleware/errors";
import { reportError } from "../observability";
import type { Container } from "../container";
import type { Tenant } from "../middleware/session";
import { applicationActionState, applicationFacts, performApplicationAction, type ApplicationCapability } from "./application-actions";
import { columnWords, isUuid, loadPool, type PoolRow } from "./pool";
import { staffMayAsk, staffScopeOf } from "./staff-scope";
import { attachBoardSnapshot, emailItsQueue, queueNoticeOf, type QueueNotice } from "./escalation-queue";

/**
 * Review and apply (plan F8; plan-adjustments section 3; founder decision B4): the pool board's suggestions applied by a
 * person, for up to 50 people at once. Shortlist, Longlist and On hold set private marks; Not moving forward files a
 * private decline with a reason from the fixed list, pre-filled from the person's own evidence; nobody is emailed about
 * any of them, and the told state stays "not told" until someone sends the decision message (B6). Inviting to the
 * screening conversation and asking a recruiter are offered too.
 *
 * Each person is applied in a transaction of their own, through the same `performApplicationAction` as a click on their
 * page, so the gates, the approvals, the marks' rules and the outbox's idempotency all hold, and one refusal never
 * blocks the rest. The preview (`dryRun`) changes nothing: per person, what will happen, whether it may and why not.
 */
const PRIVACY = "Private: nobody is told about a shortlist, longlist, hold or not-moving-forward decision. Send decision messages later, from the Talent page, when you are ready.";
const MARK_OF: Partial<Record<BatchAction, MarkKind>> = { shortlist: "shortlist", longlist: "longlist", on_hold: "on_hold" };
const CAPABILITY_OF: Record<Exclude<BatchAction, "escalate">, ApplicationCapability> = { shortlist: "set_mark", longlist: "set_mark", on_hold: "set_mark", not_moving_forward: "reject", invite_screen: "invite_screen" };

/** The batch-only reasons a person cannot be included, before the usual rules of their page. */
function batchRefusal(row: PoolRow | undefined, item: RoleBatchItem, tenant: Tenant): string | null {
  if (!row) return "Not a candidate of this role.";
  if (row.stillApplying) return "They are still applying; they join the board when they finish the conversation.";
  if (item.action === "not_moving_forward" && row.activeInterview) return "They have an interview in motion. Decide from their page, so the interview is called off properly.";
  if (item.action === "escalate") {
    if (tenant.staff) return "You are the recruiter on this; add a note to the request instead.";
    if (!can(tenant.role, "escalation.create")) return "Your role can't ask a recruiter; ask an owner or admin.";
    if (!staffMayAsk(staffScopeOf(tenant), { roleId: row.app.roleId, applicationId: row.app.id })) return "Your access does not cover asking about this person.";
  }
  return null;
}

/** What the page's rules say about this action for this person (the same rules as their own page), or null when it may go ahead. */
async function pageRefusal(tx: Tx, row: PoolRow, item: RoleBatchItem, tenant: Tenant): Promise<string | null> {
  if (item.action === "escalate") return null;
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

/**
 * What a recruiter request from Review and apply lets the recruiter see (Q31: say the real access): about one person,
 * that candidate and their role; about several, one request about the role, so every candidate of the role.
 */
function escalationAccessWords(people: number): string {
  const what = people > 1 ? `One request covers all ${people}, so it is about the role: once a recruiter picks it up they see this role and all of its candidates` : "Once a recruiter picks it up they see this candidate and the role they applied for";
  return `${what}, until a day after they answer or ${ESCALATION_ACCESS_DAYS} days at most. An owner or admin can end it sooner in Settings, and every page they open is recorded.`;
}

function warningsFor(row: PoolRow, item: RoleBatchItem, escalating: number): string[] {
  const out: string[] = [];
  const suggested = row.placement.suggestedAction;
  if (suggested && suggested !== item.action && (item.action === "shortlist" || item.action === "longlist" || item.action === "not_moving_forward")) out.push(`The board suggested ${BATCH_ACTION_LABEL[suggested]}.`);
  if (row.placement.needsYourEye) out.push(row.placement.needsYourEye);
  if (row.evidence.lowConfidence && !row.placement.needsYourEye?.includes("confident")) out.push("The assistant was not confident about this AI review.");
  if (row.match?.missingMustHave.length && item.action !== "not_moving_forward") out.push(`Missing must-have: ${row.match.missingMustHave.map((m) => m.label).join(", ")}.`);
  if (item.action === "not_moving_forward" && row.openScreen) out.push("Their open screening chat is closed; they are not told why.");
  if (item.action === "invite_screen") out.push("They get an email with a link to the screening chat.");
  if (item.action === "escalate") out.push(`An ITS recruiter is asked to look at them. ${escalationAccessWords(escalating)}`);
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
    const pool = await loadPool(tx, { roleId: input.roleId, tenant: t, onlyIds: body.items.map((i) => i.applicationId) });
    const items: BatchPreviewItem[] = [];
    const counts = emptyCounts();
    const escalating = body.items.filter((i) => i.action === "escalate").length;
    for (const item of body.items) {
      const row = pool.rows.find((r) => r.app.id === item.applicationId);
      let refusedReason = batchRefusal(row, item, t);
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
        warnings: row ? warningsFor(row, item, escalating) : [],
        reason: decline ? { reason: decline.reason, label: DECLINE_REASON_LABEL[decline.reason], note: decline.note } : null,
      });
    }
    const ready = items.filter((i) => i.allowed).length;
    // Screening conversations are counted when someone starts one, never refused once started (Q17): the preview says where the plan stands.
    const allowance = counts.invite_screen ? await entitlements.check(tx, t.companyId, entitlements.TEXT_SCREENS, counts.invite_screen) : null;
    const screenWords = allowance && allowance.limit !== null ? `Your plan includes ${allowance.limit} screening chats this month and ${allowance.used} ${allowance.used === 1 ? "has" : "have"} been used.${allowance.ok ? "" : " Inviting these may go past it; nobody who starts is cut off, and ITS will talk with you about the extra."}` : null;
    return { dryRun: true, items, counts, ready, words: readyWords(counts, ready), screenAllowance: { limit: allowance?.limit ?? null, used: allowance?.used ?? 0, inThisBatch: counts.invite_screen, words: screenWords }, privacy: PRIVACY };
  });
}

/**
 * Applies the batch, one person per transaction. Asking a recruiter about several people makes one request about the
 * role naming them (counted once), not one per person. Emits `pool.batch_applied` with what the board suggested and
 * what the person chose for each.
 */
export async function applyBatch(container: Container, input: { roleId: string; tenant: Tenant; actor: Actor; body: RoleBatchRequest }): Promise<BatchResult> {
  const { tenant: t, actor, body } = input;
  assertCan(t.role, "application.act");
  const [known] = isUuid(input.roleId) ? await withTenant(container.db, t.companyId, (tx) => tx.select({ id: roles.id }).from(roles).where(eq(roles.id, input.roleId)).limit(1)) : [];
  if (!known) throw new HttpError(404, "not_found", "Role not found.");
  const batchId = randomToken(12);
  const results: BatchResultItem[] = [];
  const toEscalate: Array<{ item: RoleBatchItem; name: string; suggested: BatchAction | null }> = [];
  for (const item of body.items) {
    const out: BatchResultItem = { applicationId: item.applicationId, name: "Unknown", action: item.action, suggested: null, ok: false, code: null, message: "", ownerStage: null, candidateNotice: null };
    try {
      await withTenant(container.db, t.companyId, async (tx) => {
        // The row is locked, as on the person's own page: two people sorting the same candidate take turns.
        const [locked] = isUuid(item.applicationId) ? await tx.select({ id: applications.id }).from(applications).where(and(eq(applications.id, item.applicationId), eq(applications.roleId, input.roleId))).limit(1).for("update") : [];
        const pool = locked ? await loadPool(tx, { roleId: input.roleId, tenant: t, onlyIds: [item.applicationId] }) : null;
        const row = pool?.rows[0];
        out.name = row?.name ?? out.name;
        out.suggested = row?.placement.suggestedAction ?? null;
        const refused = batchRefusal(row, item, t) ?? (row ? await pageRefusal(tx, row, item, t) : null);
        if (refused) throw new HttpError(409, "not_allowed", refused);
        if (item.action === "escalate") {
          toEscalate.push({ item, name: out.name, suggested: out.suggested });
          return;
        }
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
        out.message = item.action === "invite_screen" ? "Invitation to the screening chat on its way." : item.action === "not_moving_forward" ? "Filed as not moving forward, privately. They were not told." : `${MARK_LABEL[MARK_OF[item.action]!]}, privately. They were not told.`;
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
    if (item.action !== "escalate" || out.code) results.push(out);
  }
  // One recruiter request for everyone in the batch who should get a recruiter's look.
  if (toEscalate.length) {
    let notice: QueueNotice | null = null;
    try {
      const made = await withTenant(container.db, t.companyId, async (tx) => {
        const one = toEscalate.length === 1 ? toEscalate[0].item.applicationId : null;
        const note = toEscalate.find((x) => x.item.note?.trim())?.item.note?.trim();
        const question = `Please look at ${toEscalate.length === 1 ? "this candidate" : `these ${toEscalate.length} candidates`} from the pool board: ${toEscalate.map((x) => x.name).join(", ")}.${note ? ` ${note}` : ""}`;
        const created = await createEscalation(tx, { companyId: t.companyId, roleId: input.roleId, applicationId: one, kind: "review", question, requestedBy: actor });
        // About several people the request covers the role, so the recruiter opens the board as it stood too.
        if (!one) await attachBoardSnapshot(tx, { escalationId: created.id, roleId: input.roleId, tenant: t, now: container.engine.clock() });
        // Counted once against the plan's recruiter requests, however many people it names; going over never refuses it (Q33).
        const allowance = actor.kind === "user" ? await entitlements.recordRecruiterAsk(tx, t.companyId, { escalationId: created.id }) : null;
        const [co] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, t.companyId)).limit(1);
        return { notice: await queueNoticeOf(tx, created.id), allowance, escalationId: created.id, companyName: co?.name ?? "A customer" };
      });
      notice = made.notice;
      if (made.allowance?.over) await withPlatform(container.db, (tx) => entitlements.flagRecruiterAsksOver(tx, { companyId: t.companyId, companyName: made.companyName, standing: made.allowance!, escalationId: made.escalationId }));
      for (const x of toEscalate) results.push({ applicationId: x.item.applicationId, name: x.name, action: "escalate", suggested: x.suggested, ok: true, code: null, message: `An ITS recruiter was asked to look at them. ${escalationAccessWords(toEscalate.length)}`, ownerStage: null, candidateNotice: "not_told" });
    } catch (e) {
      if (!(e instanceof HttpError)) reportError(e, { process: "api", method: "POST", path: "/api/v1/roles/:id/batch" });
      for (const x of toEscalate) results.push({ applicationId: x.item.applicationId, name: x.name, action: "escalate", suggested: x.suggested, ok: false, code: e instanceof HttpError ? e.code : "error", message: e instanceof HttpError ? e.message : "The recruiter request could not be made; nothing changed for them.", ownerStage: null, candidateNotice: null });
    }
    if (notice) await emailItsQueue(container, notice);
  }
  // Keep the order the person gave.
  results.sort((a, b) => body.items.findIndex((i) => i.applicationId === a.applicationId) - body.items.findIndex((i) => i.applicationId === b.applicationId));
  const applied = results.filter((r) => r.ok);
  await withTenant(container.db, t.companyId, (tx) => emit(tx, { type: "pool.batch_applied", companyId: t.companyId, actor, subject: { type: "role", id: input.roleId }, payload: { batchId, suggestedBy: "assistant", appliedBy: actor.name ?? actor.id, items: results.map((r) => ({ applicationId: r.applicationId, suggested: r.suggested, chosen: r.action, ok: r.ok, code: r.code })), applied: applied.length, refused: results.length - applied.length, followedSuggestion: applied.filter((r) => r.suggested === r.action).length } }));
  await container.kick();
  const counts = emptyCounts();
  for (const r of applied) counts[r.action] += 1;
  const sorted = columnWords({ shortlist: counts.shortlist, longlist: counts.longlist, not_moving_forward: counts.not_moving_forward });
  const extra = [counts.on_hold ? `${counts.on_hold} on hold` : "", counts.invite_screen ? `${counts.invite_screen} invited to the screening chat` : "", counts.escalate ? `${counts.escalate} sent to a recruiter` : ""].filter(Boolean);
  const words = applied.length
    ? `Applied ${applied.length} ${applied.length === 1 ? "decision" : "decisions"}${sorted || extra.length ? `: ${[sorted, ...extra].filter(Boolean).join(", ")}` : ""}.${results.length > applied.length ? ` ${results.length - applied.length} could not be applied; each says why.` : ""}`
    : "Nothing was applied; each person says why.";
  return { dryRun: false, batchId, results, applied: applied.length, refused: results.length - applied.length, words, privacy: PRIVACY };
}
