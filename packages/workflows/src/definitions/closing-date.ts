import { and, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { CLOSING_DATE_REASON, closingDayWords, closingMoment, emit, notify } from "@ros/core";
import { companies, roles, workflowRuns, type Queryable } from "@ros/db";
import type { WorkflowEngine } from "../engine";
import type { WorkflowDefinition } from "../types";

type State = { roleId: string; closesOn: string };

export const ROLE_CLOSING_DATE_KEY = "role_closing_date";

/**
 * A role's closing date (founder decision Q12, plan D7): a timer per role, due at the end of the closing day in the
 * company's own time zone, kept in the jobs table so it survives restarts. When it is due, new applications stop the
 * same way the accepting switch stops them (`role.applications_closed`, emails held, the job page saying so), with the
 * reason "closing date". Nobody already in the process is touched, people part-way through the form may still finish
 * (apps/api services/closing-date.ts), and closing the role stays a person's decision: the team is told, and Today
 * offers to extend the date or close the role.
 *
 * Every change of the date starts a fresh run (`armClosingDate`); a run whose date is no longer the role's ends
 * without doing anything, so an earlier timer never closes applications on a date that was changed.
 */
export const roleClosingDate: WorkflowDefinition<State> = {
  key: ROLE_CLOSING_DATE_KEY,
  version: 1,
  initialStep: "wait",
  maxAttempts: 5,
  escalationKind: "stuck_role",
  steps: {
    async wait(ctx) {
      const [role] = await ctx.q.select().from(roles).where(eq(roles.id, ctx.state.roleId)).limit(1);
      if (!role || role.status === "closed") return { kind: "complete" };
      if ((role.applicationsCloseOn ?? "").slice(0, 10) !== ctx.state.closesOn) return { kind: "complete" };
      const [company] = await ctx.q.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
      const due = closingMoment(ctx.state.closesOn, company?.timezone);
      if (ctx.now.getTime() < due.getTime()) {
        return { kind: "wait", wait: { kind: "timer", until: due.toISOString(), reason: `applications close at the end of ${ctx.state.closesOn}` }, resumeStep: "wait" };
      }
      if (!["open", "paused"].includes(role.status) || !role.acceptingApplications) return { kind: "complete" };
      // Checked again in the write itself, so a person switching applications off at the same moment is not overwritten.
      const [stopped] = await ctx.q.update(roles).set({ acceptingApplications: false, applicationsClosedAt: due.toISOString(), applicationsClosedReason: CLOSING_DATE_REASON }).where(and(eq(roles.id, role.id), eq(roles.acceptingApplications, true))).returning({ id: roles.id });
      if (!stopped) return { kind: "complete" };
      await emit(ctx.q, { type: "role.applications_closed", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "role", id: role.id }, payload: { reason: CLOSING_DATE_REASON, closesOn: ctx.state.closesOn, automatic: true }, correlationId: ctx.run.id });
      await notify(ctx.q, {
        companyId: ctx.companyId,
        kind: "applications.closed",
        title: `${role.title} stopped taking new applications`,
        body: `Its closing date, ${closingDayWords(ctx.state.closesOn)}, has passed. The job page stays up and says applications are closed. Anyone who had already started applying can still finish, and nobody was turned away. Extend the date to take applications again, or close the role when you are ready.`,
        action: { label: "Extend or close", href: `/roles/${role.id}?tab=posting` },
      });
      return { kind: "complete" };
    },
  },
};

/**
 * Sets the timer for a role's closing date, or takes it away (`closesOn` null): any timer already waiting for the role
 * is cancelled first. Call inside the caller's tenant transaction, after the date is written to the role.
 */
export async function armClosingDate(q: Queryable, engine: WorkflowEngine, input: { companyId: string; roleId: string; closesOn: string | null; actor: Actor }): Promise<string | null> {
  const waiting = await q
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.workflowKey, ROLE_CLOSING_DATE_KEY), inArray(workflowRuns.status, ["running", "waiting"]), sql`${workflowRuns.subject}->>'id' = ${input.roleId}`));
  for (const r of waiting) await engine.cancel(q, r.id, input.actor, "the closing date changed");
  if (!input.closesOn) return null;
  const { runId } = await engine.start(q, { workflowKey: ROLE_CLOSING_DATE_KEY, companyId: input.companyId, subject: { type: "role", id: input.roleId }, state: { roleId: input.roleId, closesOn: input.closesOn.slice(0, 10) }, actor: input.actor });
  return runId;
}
