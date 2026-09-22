import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { ActionType, UpsertPolicy } from "@ros/contracts";
import { DEFAULT_POLICIES, HARD_HUMAN_ONLY, MIN_LEVELS, assertCan, audit, emit, levelAtLeast, resolvePolicy } from "@ros/core";
import { policies, withTenant } from "@ros/db";
import { actorOf, requireTenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";

/** "What may the AI do on its own?" Company defaults and per-role overrides, resolved for display. */
export const policyRoutes = new Hono<Vars>();

const GROUPS: Record<string, string[]> = {
  "Roles and posting": ["role_packet.approve", "role.publish", "posting.sponsor_spend"],
  "Applicants": ["application.triage", "application.hold_ineligible", "application.reject_ineligible", "application.reject_on_assessment", "application.invite_screen", "screen.conduct", "application.recommend_interview"],
  "Messages": ["message.send_templated", "message.send_freeform", "disposition.send"],
  "Interviews": ["interview.request", "interview.schedule", "interview.reschedule", "interview.record", "scorecard.draft", "debrief.recommend", "candidate.hire_decision"],
  "Offers": ["offer.draft", "offer.send", "offer.negotiate", "offer.revise"],
  "After the offer": ["reference.request", "background_check.order", "background_check.adverse_action", "employee.create_in_hris", "welcome.send", "checkin.request"],
  "Nudges and sourcing": ["intervention.nudge", "intervention.offer_recruiter", "sourcing.search_internal", "sourcing.enrich_external", "outreach.send"],
  "Rules and data": ["policy.change", "knockout_rule.change", "notice_text.change", "data.delete", "data.export"],
};

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
        out.push({ group, actionType, level: d.level, approverRoles: d.approverRoles, source: d.source, locked: HARD_HUMAN_ONLY.has(actionType), defaultLevel: DEFAULT_POLICIES[actionType].level });
      }
    }
    return out;
  });
  return c.json(rows);
});

policyRoutes.put("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "policy.manage");
  const body = UpsertPolicy.parse(await c.req.json());
  if (HARD_HUMAN_ONLY.has(body.actionType) && body.level !== "human_only") throw new HttpError(400, "locked", "That decision always stays with a person.");
  const min = MIN_LEVELS[body.actionType];
  if (min && !levelAtLeast(body.level, min)) throw new HttpError(400, "minimum_level", `That action needs at least "${min}": a person approves it before anything happens.`);
  const container = c.get("container");
  const row = await withTenant(container.db, t.companyId, async (tx) => {
    const where = body.roleId ? and(eq(policies.companyId, t.companyId), eq(policies.roleId, body.roleId), eq(policies.actionType, body.actionType)) : and(eq(policies.companyId, t.companyId), isNull(policies.roleId), eq(policies.actionType, body.actionType));
    const [existing] = await tx.select().from(policies).where(where).limit(1);
    let saved;
    if (existing) [saved] = await tx.update(policies).set({ level: body.level, approverRoles: body.approverRoles }).where(eq(policies.id, existing.id)).returning();
    else [saved] = await tx.insert(policies).values({ companyId: t.companyId, roleId: body.roleId ?? null, actionType: body.actionType, level: body.level, approverRoles: body.approverRoles, createdBy: actorOf(c) }).returning();
    await emit(tx, { type: "policy.changed", companyId: t.companyId, actor: actorOf(c), subject: { type: "policy", id: saved.id }, payload: { actionType: body.actionType, level: body.level, roleId: body.roleId ?? null, previous: existing?.level ?? null } });
    await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "policy.changed", target: { type: "policy", id: saved.id }, reason: `${body.actionType} → ${body.level}${body.roleId ? ` (role ${body.roleId})` : ""}` });
    return saved;
  });
  return c.json(row);
});
