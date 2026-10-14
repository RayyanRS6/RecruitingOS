import { and, eq, inArray, isNull } from "drizzle-orm";
import { queueCommunication } from "@ros/agents";
import type { Actor, PostingTaskKind } from "@ros/contracts";
import { closingDateRequired, closingDayWords, defaultClosingDate, emit, notify, openMissingPostingTasks, postingTaskLabel } from "@ros/core";
import { companies, rolePackets, roles, withPlatform, withTenant, type Queryable } from "@ros/db";
import { armClosingDate } from "@ros/workflows";
import type { Container } from "../container";

/**
 * Bringing roles that were already open up to the publishing rules (plan Wave D), once per deploy: every process boot
 * queues `PUBLISHING_BACKFILL_JOB_KIND`, and each run changes only what is still missing, so a second run does nothing.
 *
 * - ITS posting tasks (plan D3). Boards prepared before ITS posted for every company had no task: one waiting to be
 *   posted, or still up after its role closed, would otherwise wait for nobody while the Posting tab says ITS has it.
 * - Closing dates (plan D5, founder decision Q12). A Colorado or remote role opened before closing dates existed gets the
 *   default date and its timer, and the owners and admins are told how to change it.
 */
export const PUBLISHING_BACKFILL_JOB_KIND = "publishing.backfill";

const ACTOR: Actor = { kind: "system", id: "publishing_backfill" };

type Deps = Pick<Container, "db" | "integrations" | "env" | "engine">;

/**
 * One email to the ITS queue for posting tasks opened outside a publish run (this backfill, a company handing its
 * boards to ITS, the team asking again): the company, the jobs and the boards, nothing more. Through the outbox, so it
 * leaves once, after the caller's transaction commits.
 */
export async function tellItsQueueAboutTasks(q: Queryable, deps: Pick<Deps, "integrations" | "env">, input: { companyId: string; companyName: string; tasks: Array<{ roleTitle: string; board: string; kind: PostingTaskKind }>; key: string; actor: Actor; now: Date }): Promise<void> {
  if (!input.tasks.length) return;
  const n = input.tasks.length;
  await queueCommunication(q, deps.integrations, {
    channel: "email",
    companyId: input.companyId,
    to: deps.env.ITS_QUEUE_EMAIL,
    from: `${deps.integrations.env.productName} <${deps.integrations.env.fromAddress}>`,
    subject: `[posting tasks] ${input.companyName}: ${n} job board ${n === 1 ? "task" : "tasks"}`,
    text: `${input.companyName} has job board work for ITS, from the company's own accounts:\n${input.tasks.map((t) => `- ${postingTaskLabel(t.kind, t.board)}: "${t.roleTitle}"`).join("\n")}\nEach one is its own task in the queue, with the posting package and the board's apply link: ${deps.env.APP_BASE_URL}/recruiter/queue`,
    templateKey: "its_posting_tasks",
    idempotencyKey: `its_posting_tasks:${input.key}`,
    tags: { template: "its_posting_tasks" },
    actor: input.actor,
  }, input.now);
}

/** Opens the company's missing posting tasks and tells the ITS queue once; inside the company's tenant transaction. */
export async function openMissingTasksAndTell(q: Queryable, deps: Pick<Deps, "integrations" | "env">, input: { companyId: string; actor: Actor; now: Date; key: string }): Promise<number> {
  const opened = await openMissingPostingTasks(q, { companyId: input.companyId, actor: input.actor, now: input.now });
  if (!opened.length) return 0;
  const [co] = await q.select({ name: companies.name }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  await tellItsQueueAboutTasks(q, deps, { companyId: input.companyId, companyName: co?.name ?? "A customer", tasks: opened, key: input.key, actor: input.actor, now: input.now });
  return opened.length;
}

/** The default closing date for the company's open Colorado or remote roles that have none; inside its tenant transaction. */
async function backfillClosingDates(q: Queryable, deps: Pick<Deps, "engine">, companyId: string, now: Date): Promise<number> {
  const [company] = await q.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId)).limit(1);
  const open = await q.select().from(roles).where(and(eq(roles.companyId, companyId), inArray(roles.status, ["open", "paused"]), isNull(roles.applicationsCloseOn)));
  let n = 0;
  for (const role of open) {
    if (!role.currentPacketVersion) continue;
    const [pv] = await q.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, role.currentPacketVersion))).limit(1);
    if (!pv || !closingDateRequired({ jobLocations: pv.packet.identity.locations, remotePolicy: pv.packet.identity.remotePolicy })) continue;
    const closesOn = defaultClosingDate(now, company?.timezone);
    await q.update(roles).set({ applicationsCloseOn: closesOn }).where(eq(roles.id, role.id));
    await emit(q, { type: "role.closing_date_set", companyId, actor: ACTOR, subject: { type: "role", id: role.id }, payload: { closesOn, previous: null, defaulted: true, reason: "Colorado expects the job ad to say when applications close." } });
    await armClosingDate(q, deps.engine, { companyId, roleId: role.id, closesOn, actor: ACTOR });
    await notify(q, {
      companyId,
      kind: "stuck.closing_date_added",
      title: `${role.title} now has a closing date`,
      body: `Colorado expects a job ad to say when applications close, so ${role.title} now shows "Apply by ${closingDayWords(closesOn)}". New applications stop at the end of that day; anyone part-way through can still finish. Choose another date on the Share tab at any time.`,
      action: { label: "Choose a closing date", href: `/roles/${role.id}?tab=posting#closing-date` },
      roles: ["owner", "admin"],
    });
    n += 1;
  }
  return n;
}

/** The whole pass, company by company, each in its own tenant transaction. */
export async function backfillPublishing(deps: Deps): Promise<{ postingTasks: number; closingDates: number }> {
  const now = deps.engine.clock();
  const all = await withPlatform(deps.db, (tx) => tx.select({ id: companies.id }).from(companies));
  let postingTasks = 0;
  let closingDates = 0;
  for (const { id } of all) {
    await withTenant(deps.db, id, async (tx) => {
      postingTasks += await openMissingTasksAndTell(tx, deps, { companyId: id, actor: ACTOR, now, key: `backfill:${id}:${now.getTime()}` });
      closingDates += await backfillClosingDates(tx, deps, id, now);
    });
  }
  if (postingTasks || closingDates) console.log(`[publishing] backfill: postingTasks=${postingTasks} closingDates=${closingDates}`);
  return { postingTasks, closingDates };
}
