import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import { LOCKED_WORD, MORE_CANDIDATES_LINE, MORE_CANDIDATES_UPGRADE_QUESTION } from "@ros/contracts";
import { applicationLocked, can } from "@ros/core";
import { applications, withTenant, type Tx } from "@ros/db";
import { HttpError } from "./errors";
import { isCanonicalId, type Tenant, type Vars } from "./session";

/**
 * The wall of the plans of 5 November 2026, Rule 3: nobody on the team opens someone past the plan's candidates per job, by
 * any id, from any old link. The ids are not secret (events, notices and audit rows all carry them), so
 * the rule never rests on hiding them. Mounted in app.ts at the prefix, not on each router, so a new router under these paths
 * cannot forget it, and it runs before every handler, so no signed link is minted and no `candidate.viewed` is written.
 */

/** What an Upgrade asks ITS, for the page to open its form with: the same shape as a job limit's refusal (routes/intake.ts). */
export const askToViewMore = { label: "Upgrade", method: "POST" as const, path: "/api/v1/plans/request", body: { reason: MORE_CANDIDATES_UPGRADE_QUESTION } };

/** The refusal: 402 `candidate_locked`, and the Upgrade for someone at the company who may ask for one. */
export function candidateLocked(t: Pick<Tenant, "role">): HttpError {
  const mayAsk = can(t.role, "plan.request");
  return new HttpError(402, "candidate_locked", `${LOCKED_WORD}. ${MORE_CANDIDATES_LINE}`, { upgrade: mayAsk, actions: mayAsk ? [askToViewMore] : [] });
}

/** For an id that arrives in a body or on a stored request, where no path guard sees it: the same refusal. */
export async function assertNotLocked(tx: Tx, t: Pick<Tenant, "role">, applicationId: string | null | undefined): Promise<void> {
  if (applicationId && (await applicationLocked(tx, applicationId))) throw candidateLocked(t);
}

/** "/x/*" also matches "/x", and each path is mounted both ways, so one request looks once. */
const looked = new WeakMap<Request, Promise<boolean>>();

function lockGuard(notFound: string, find: (tx: Tx, id: string, companyId: string) => Promise<string | null>): MiddlewareHandler<Vars> {
  return async (c, next) => {
    const t = c.get("tenant");
    const id = c.req.param("id");
    // Nobody signed in, or no company: `requireTenant` answers.
    if (t && id) {
      // An id not written the database's way names nobody, and is answered here. If it went on, the handler would find the person this guard did not look for.
      if (!isCanonicalId(id)) throw new HttpError(404, "not_found", notFound);
      let hidden = looked.get(c.req.raw);
      if (!hidden) {
        hidden = withTenant(c.get("container").db, t.companyId, async (tx) => {
          const applicationId = await find(tx, id, t.companyId);
          return !!applicationId && (await applicationLocked(tx, applicationId));
        });
        looked.set(c.req.raw, hidden);
      }
      if (await hidden) throw candidateLocked(t);
    }
    await next();
  };
}

/** Every route under /api/v1/applications/:id. */
export const applicationLockGuard = lockGuard("Application not found.", async (tx, id, companyId) => {
  const [row] = await tx.select({ id: applications.id }).from(applications).where(and(eq(applications.id, id), eq(applications.companyId, companyId))).limit(1);
  return row?.id ?? null;
});
