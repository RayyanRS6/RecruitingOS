import { and, eq, inArray, notInArray } from "drizzle-orm";
import { planChangedWords, type Actor } from "@ros/contracts";
import { notify, resolvePlanRequests, withdrawPostingTasks } from "@ros/core";
import { memberships, type Queryable } from "@ros/db";
import type { Container } from "../container";
import { openMissingTasksAndTell } from "./publishing-backfill";

type Deps = Pick<Container, "integrations" | "env" | "engine">;

/** The roles that hear about a change of plan as it happens: they are the ones who talk with ITS about it. */
const PLAN_READERS = ["owner", "admin"];

/**
 * What a change of plan does around the plan itself (the plans of 5 November 2026, Rules 5 and 6), inside Change plan's
 * transaction. Who posts on the boards follows the new plan: a move to a plan with ITS staff time gives ITS the boards already
 * waiting, and a move to one without takes ITS's waiting tasks back, which the team then sees on Home and the Share tab. The
 * open request about the plan is answered, and the owners and admins are told. Whoever asked and is neither gets the answer too.
 */
export async function afterPlanChange(q: Queryable, deps: Deps, input: { companyId: string; planName: string; opened: number; postedBy: "its" | "self"; postsNow: "its" | "self"; actor: Actor; now: Date }): Promise<void> {
  const { companyId, actor, now } = input;
  if (input.postedBy === "self" && input.postsNow === "its") await openMissingTasksAndTell(q, deps, { companyId, actor, now, key: `plan_changed:${companyId}:${now.getTime()}` });
  if (input.postedBy === "its" && input.postsNow === "self") await withdrawPostingTasks(q, { companyId, reason: "The company's plan has its own team post on the job boards.", actor, now });
  const words = planChangedWords(input.planName, input.opened);
  const answered = await resolvePlanRequests(q, { companyId, answer: words.answer, actor, now });
  for (const e of answered) await deps.engine.signal(q, { companyId, key: `escalation:${e.id}`, payload: { resolved: true } });
  await notify(q, { companyId, kind: "company.plan_changed", title: words.title, body: words.body, action: { label: "See plan", href: "/setup#setup-company" }, roles: PLAN_READERS });
  const askers = [...new Set(answered.flatMap((e) => (e.requestedBy.kind === "user" ? [e.requestedBy.id] : [])))];
  if (!askers.length) return;
  const others = await q.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, companyId), inArray(memberships.userId, askers), notInArray(memberships.role, PLAN_READERS), eq(memberships.status, "active")));
  if (others.length) await notify(q, { companyId, kind: "recruiter.resolved", title: words.title, body: words.answer, action: { label: "Read the answer", href: `/?request=${answered[0].id}` }, userIds: others.map((m) => m.userId) });
}
