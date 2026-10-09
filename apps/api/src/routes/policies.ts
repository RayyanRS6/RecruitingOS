import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { ActionType, UpsertPolicy } from "@ros/contracts";
import { DEFAULT_POLICIES, HARD_HUMAN_ONLY, MAX_LEVELS, MIN_LEVELS, assertCan, audit, clampLevel, emit, levelAtLeast, resolvePolicy } from "@ros/core";
import { policies, withTenant } from "@ros/db";
import { actorOf, requireTenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { assertRecentAuth } from "../middleware/reauth";

/** "What may the AI do on its own?" Company defaults and per-role overrides, resolved for display. */
export const policyRoutes = new Hono<Vars>();

/** The levels as Setup names them, for refusals a person reads. */
const LEVEL_WORDS: Record<string, string> = { auto: "Do it", auto_notify: "Do it and tell me", approval: "Ask me first", human_only: "Only a person" };

// "Post an approved role" is not listed: publishing always follows approval and no rule ever changed it.
const GROUPS: Record<string, string[]> = {
  "Roles and posting": ["role_packet.approve", "posting.sponsor_spend"],
  "Applicants": ["application.triage", "application.hold_ineligible", "application.reject_ineligible", "application.reject_on_assessment", "application.invite_screen", "screen.conduct", "application.recommend_interview"],
  "Messages": ["message.send_templated", "message.send_freeform", "disposition.send", "message.still_reviewing"],
  "Interviews": ["interview.request", "interview.schedule", "interview.reschedule", "interview.record", "scorecard.draft", "debrief.recommend", "candidate.hire_decision"],
  "Offers": ["offer.draft", "offer.send", "offer.negotiate", "offer.revise"],
  "After the offer": ["reference.request", "background_check.order", "background_check.adverse_action", "employee.create_in_hris", "welcome.send", "checkin.request"],
  "Nudges and sourcing": ["intervention.nudge", "intervention.offer_recruiter", "sourcing.search_internal", "sourcing.enrich_external", "outreach.send"],
  "Rules and data": ["policy.change", "knockout_rule.change", "notice_text.change", "data.delete", "data.export"],
};

/**
 * The rules a setting really changes (plan B7, step 13): a workflow's gate or a route's policy read reads each of them
 * today, so choosing a level changes what happens. Setup offers choices for these only. When a feature starts reading
 * another rule, add it here; a test checks that every rule here has a reader in the code.
 */
export const SETTABLE: ReadonlySet<string> = new Set([
  "role_packet.approve", "application.hold_ineligible", "application.invite_screen", "application.recommend_interview",
  "message.send_freeform", "disposition.send", "message.still_reviewing", "intervention.nudge", "intervention.offer_recruiter",
]);

/**
 * Work the product does today that no setting changes, with what happens, in plain words. Setup shows these read-only,
 * so nobody picks a level that changes nothing, and nothing the product does is listed as "coming later".
 */
export const FIXED: Readonly<Record<string, string>> = {
  "application.triage": "The assistant reads every applicant and writes an assessment for you to review. It never decides anything with it.",
  "screen.conduct": "Once someone is invited to a screen, the screening conversation runs with them in their own time; they can ask for a person at any point. Whether people are invited is the rule above.",
  "message.send_templated": "Confirmations and reminders (that an application arrived, a screening reminder, an interview time) go out by themselves in the approved wording.",
  "interview.request": "An interview always waits for a person on your team to approve it on the candidate's page before any times go to the candidate.",
  "interview.schedule": "Once an interview is approved, times are offered from your team's calendars or declared hours, and the booking goes on the calendars by itself.",
  "interview.reschedule": "When someone on your team moves or cancels an interview, the candidate is offered new times or told, and the calendars follow by themselves.",
};

/** The product does it today: a setting to choose, or work it does the same way for everyone. The rest are planned. */
const inProduct = (actionType: string) => SETTABLE.has(actionType) || actionType in FIXED;

policyRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  const roleId = c.req.query("roleId") ?? null;
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const out = [];
    for (const [group, actions] of Object.entries(GROUPS)) {
      for (const a of actions) {
        const actionType = ActionType.parse(a);
        const d = await resolvePolicy(tx, t.companyId, roleId, actionType);
        // minLevel and maxLevel tell Setup which choices to offer, so it never shows one the PUT below refuses. `settable`:
        // a level here changes what happens; `does`: what the product does where nothing is to choose.
        out.push({ group, actionType, level: d.level, approverRoles: d.approverRoles, source: d.source, locked: HARD_HUMAN_ONLY.has(actionType), available: inProduct(actionType), settable: SETTABLE.has(actionType), does: FIXED[actionType] ?? null, defaultLevel: DEFAULT_POLICIES[actionType].level, minLevel: MIN_LEVELS[actionType] ?? null, maxLevel: MAX_LEVELS[actionType] ?? null });
      }
    }
    return out;
  });
  return c.json(rows);
});

policyRoutes.put("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "policy.manage");
  // A rule change needs a fresh sign-in or a confirmation with the provider (audit finding A12).
  assertRecentAuth(c);
  const body = UpsertPolicy.parse(await c.req.json());
  if (HARD_HUMAN_ONLY.has(body.actionType) && body.level !== "human_only") throw new HttpError(400, "locked", "That decision always stays with a person.");
  const allowed = clampLevel(body.actionType, body.level);
  if (allowed !== body.level) {
    if (levelAtLeast(allowed, body.level)) throw new HttpError(400, "minimum_level", `A person approves this before anything happens, so it cannot be set below "${LEVEL_WORDS[allowed]}".`);
    throw new HttpError(400, "maximum_level", `This stays at "${LEVEL_WORDS[allowed]}": a person approves it from the card on Today. "${LEVEL_WORDS[body.level]}" would leave it waiting with nobody asked to decide.`);
  }
  // A level nothing reads would be saved, audited and shown as chosen while changing nothing: refused in plain words.
  if (!SETTABLE.has(body.actionType) && !HARD_HUMAN_ONLY.has(body.actionType)) {
    throw new HttpError(400, "no_setting", body.actionType in FIXED ? `There is nothing to choose here: ${FIXED[body.actionType]}` : "This is not in the product yet, so there is nothing to choose.");
  }
  const container = c.get("container");
  const row = await withTenant(container.db, t.companyId, async (tx) => {
    const where = body.roleId ? and(eq(policies.companyId, t.companyId), eq(policies.roleId, body.roleId), eq(policies.actionType, body.actionType)) : and(eq(policies.companyId, t.companyId), isNull(policies.roleId), eq(policies.actionType, body.actionType));
    const [existing] = await tx.select().from(policies).where(where).limit(1);
    let saved: typeof policies.$inferSelect;
    if (existing) [saved] = await tx.update(policies).set({ level: body.level, approverRoles: body.approverRoles }).where(eq(policies.id, existing.id)).returning();
    else [saved] = await tx.insert(policies).values({ companyId: t.companyId, roleId: body.roleId ?? null, actionType: body.actionType, level: body.level, approverRoles: body.approverRoles, createdBy: actorOf(c) }).returning();
    await emit(tx, { type: "policy.changed", companyId: t.companyId, actor: actorOf(c), subject: { type: "policy", id: saved.id }, payload: { actionType: body.actionType, level: body.level, roleId: body.roleId ?? null, previous: existing?.level ?? null } });
    await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "policy.changed", target: { type: "policy", id: saved.id }, reason: `${body.actionType} → ${body.level}${body.roleId ? ` (role ${body.roleId})` : ""}` });
    return saved;
  });
  return c.json(row);
});
