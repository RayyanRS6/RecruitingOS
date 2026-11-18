import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { closingDateRequired, closingDayWords, defaultClosingDate, emit, notify } from "@ros/core";
import { companies, rolePackets, roles, withPlatform, withTenant, type Queryable } from "@ros/db";
import { armClosingDate } from "@ros/workflows";
import type { Container } from "../container";

/**
 * Bringing roles that were already open up to the publishing rules (plan Wave D), once per deploy: every process boot
 * queues `PUBLISHING_BACKFILL_JOB_KIND`, and each run changes only what is still missing, so a second run does nothing.
 *
 * Closing dates (plan D5, founder decision Q12): a Colorado or remote role opened before closing dates existed gets the
 * default date and its timer, and the owners and admins are told how to change it.
 */
export const PUBLISHING_BACKFILL_JOB_KIND = "publishing.backfill";

const ACTOR: Actor = { kind: "system", id: "publishing_backfill" };

type Deps = Pick<Container, "db" | "engine">;

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
export async function backfillPublishing(deps: Deps): Promise<{ closingDates: number }> {
  const now = deps.engine.clock();
  const all = await withPlatform(deps.db, (tx) => tx.select({ id: companies.id }).from(companies));
  let closingDates = 0;
  for (const { id } of all) {
    await withTenant(deps.db, id, async (tx) => {
      closingDates += await backfillClosingDates(tx, deps, id, now);
    });
  }
  if (closingDates) console.log(`[publishing] backfill: closingDates=${closingDates}`);
  return { closingDates };
}
