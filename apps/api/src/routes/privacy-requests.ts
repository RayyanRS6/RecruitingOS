import { Hono, type Context } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { AdminCreateDataRequest, DataRequestAssign, DataRequestCounsel, DataRequestDecline, DataRequestFulfil, DataRequestNote, DataRequestVerify } from "@ros/contracts";
import { CounselDecisionRequired, addDataRequestNote, assignDataRequest, checkPrivacyRequestDeadlines, createDataRequest, declineDataRequest, escalateDataRequestToCounsel, exportCandidateData, fulfilAccessRequest, fulfilCorrectionRequest, fulfilDeletionRequest, fulfilSmsOptOut, publicDataRequest, raiseAlert, recordCounselDecision, verifyDataRequest, type DataRequestRow } from "@ros/core";
import { sendDeletionConfirmation, sendPrivacyAcknowledgment, sendPrivacyCompletion } from "@ros/agents";
import { applications, candidates, companies, dataRequests, withPlatform } from "@ros/db";
import { requirePlatformAdmin, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import type { Container } from "../container";

/**
 * Administrator side of privacy requests (docs/runbooks/privacy-requests.md). Platform administrators only; every read is
 * audited by the admin middleware with a reason. Customers never reach these routes and never see request content.
 */
export const privacyRequestRoutes = new Hono<Vars>();
privacyRequestRoutes.use("*", requirePlatformAdmin);

const actorOfAdmin = (c: Context<Vars>) => { const s = c.get("session")!; return { kind: "user" as const, id: s.user.id, name: s.user.name ?? s.user.email }; };

async function load(c: Context<Vars>) {
  const [row] = await c.get("container").db.select().from(dataRequests).where(eq(dataRequests.id, c.req.param("id") ?? "")).limit(1);
  if (!row) throw new HttpError(404, "not_found", "Privacy request not found.");
  return row;
}
async function companyName(c: Context<Vars>, companyId: string): Promise<string> {
  const [co] = await c.get("container").db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
  return co?.name ?? "the hiring team";
}

privacyRequestRoutes.get("/", async (c) => {
  const db = c.get("container").db;
  const status = c.req.query("status");
  const rows = await db.select().from(dataRequests).where(status ? eq(dataRequests.status, status) : inArray(dataRequests.status, ["received", "in_progress", "awaiting_counsel", "fulfilled", "declined"])).orderBy(desc(dataRequests.createdAt)).limit(300);
  const out = [];
  for (const r of rows) out.push({ ...publicDataRequest(r), companyName: await companyName(c, r.companyId) });
  return c.json(out);
});

/** A request that arrived by email to privacy@ is recorded here; verification stays pending until an administrator confirms it. */
privacyRequestRoutes.post("/", async (c) => {
  const body = AdminCreateDataRequest.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOfAdmin(c);
  const name = await companyName(c, body.companyId);
  const row = await withPlatform(container.db, async (tx) => {
    let candidateId = body.candidateId ?? null;
    if (candidateId) {
      const [own] = await tx.select({ id: candidates.id }).from(candidates).where(and(eq(candidates.id, candidateId), eq(candidates.companyId, body.companyId))).limit(1);
      if (!own) throw new HttpError(400, "mismatched_ids", "That candidate does not belong to that company.");
    }
    if (body.applicationId) {
      const [own] = await tx.select({ id: applications.id, candidateId: applications.candidateId }).from(applications).where(and(eq(applications.id, body.applicationId), eq(applications.companyId, body.companyId))).limit(1);
      if (!own || (candidateId && own.candidateId !== candidateId)) throw new HttpError(400, "mismatched_ids", "That application does not belong to that company and candidate.");
    }
    if (!candidateId) {
      const [cand] = await tx.select({ id: candidates.id }).from(candidates).where(and(eq(candidates.companyId, body.companyId), eq(candidates.email, body.requesterEmail.toLowerCase()))).limit(1);
      candidateId = cand?.id ?? null;
    }
    const r = await createDataRequest(tx, { companyId: body.companyId, kind: body.kind, requesterEmail: body.requesterEmail, details: body.details, candidateId, applicationId: body.applicationId ?? null, channel: "email", verified: false, actor });
    await sendPrivacyAcknowledgment(tx, container.integrations, { row: r, companyName: name, privacyEmail: container.env.PRIVACY_EMAIL, actor });
    return r;
  });
  await container.kick();
  return c.json(publicDataRequest(row), 201);
});

/** The daily deadline check on demand (the worker runs it every day). A POST: it raises alerts and records them, so a link from another site cannot set it off (middleware/same-site.ts). */
privacyRequestRoutes.post("/deadlines/check", async (c) => c.json(await checkPrivacyRequestDeadlines(c.get("container").db, c.get("container").engine.clock())));

privacyRequestRoutes.get("/:id", async (c) => {
  const row = await load(c);
  return c.json({ ...publicDataRequest(row), companyName: await companyName(c, row.companyId) });
});

privacyRequestRoutes.post("/:id/assign", async (c) => {
  const body = DataRequestAssign.parse(await c.req.json());
  const row = await load(c);
  const userId = body.userId === "me" ? c.get("session")!.user.id : body.userId;
  return c.json(publicDataRequest(await assignDataRequest(c.get("container").db, row, userId, actorOfAdmin(c))));
});

privacyRequestRoutes.post("/:id/notes", async (c) => {
  const body = DataRequestNote.parse(await c.req.json());
  const row = await load(c);
  return c.json(publicDataRequest(await addDataRequestNote(c.get("container").db, row, body.text, actorOfAdmin(c))));
});

privacyRequestRoutes.post("/:id/verify", async (c) => {
  const body = DataRequestVerify.parse(await c.req.json());
  const row = await load(c);
  return c.json(publicDataRequest(await verifyDataRequest(c.get("container").db, row, { method: body.method, outcome: body.outcome, actor: actorOfAdmin(c) })));
});

privacyRequestRoutes.post("/:id/escalate", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { note?: string };
  const row = await load(c);
  return c.json(publicDataRequest(await escalateDataRequestToCounsel(c.get("container").db, row, body.note, actorOfAdmin(c))));
});

privacyRequestRoutes.post("/:id/counsel", async (c) => {
  const body = DataRequestCounsel.parse(await c.req.json());
  const row = await load(c);
  return c.json(publicDataRequest(await recordCounselDecision(c.get("container").db, row, { decision: body.decision, note: body.note, actor: actorOfAdmin(c) })));
});

/** The candidate's own data as a file; audited as an export. */
privacyRequestRoutes.get("/:id/export", async (c) => {
  const row = await load(c);
  if (!row.candidateId) throw new HttpError(409, "no_candidate", "No candidate record is linked to this request.");
  const bundle = await exportCandidateData(c.get("container").db, row.companyId, row.candidateId);
  return c.body(JSON.stringify(bundle, null, 2), 200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="your-information-${row.id.slice(0, 8)}.json"`, "cache-control": "no-store" });
});

privacyRequestRoutes.post("/:id/fulfil", async (c) => {
  const body = DataRequestFulfil.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOfAdmin(c);
  const row = await load(c);
  if (["fulfilled", "declined"].includes(row.status)) throw new HttpError(409, "closed", `This request is already ${row.status}.`);
  if (!["verified_by_link", "verified_manual"].includes(row.verificationStatus)) throw new HttpError(409, "not_verified", "Verify the requester's identity before acting on the request.");
  const name = await companyName(c, row.companyId);
  // A deletion's stored files and its "your data was deleted" email wait for the commit: a deletion that rolls back
  // leaves the files where its records still point, and nobody is told something that did not happen.
  const filesToRemove: string[] = [];
  const deleted = row.kind === "delete";
  const result = await withPlatform(container.db, async (tx) => {
    try {
      if (row.kind === "access") {
        const { row: u, bundle } = await fulfilAccessRequest(tx, row, { resolution: body.resolution, actor, now: container.engine.clock() });
        await sendPrivacyCompletion(tx, container.integrations, { row: u, companyName: name, privacyEmail: container.env.PRIVACY_EMAIL, actor, attachment: { filename: `your-information-${row.id.slice(0, 8)}.json`, contentType: "application/json", contentBase64: Buffer.from(JSON.stringify(bundle, null, 2)).toString("base64") } });
        return u;
      }
      if (row.kind === "correct") {
        if (!body.correction) throw new HttpError(400, "correction_required", "State the field and the corrected value.");
        const u = await fulfilCorrectionRequest(tx, row, { field: body.correction.field, value: body.correction.value, resolution: body.resolution, actor, now: container.engine.clock() });
        await sendPrivacyCompletion(tx, container.integrations, { row: u, companyName: name, privacyEmail: container.env.PRIVACY_EMAIL, actor });
        return u;
      }
      if (row.kind === "delete") {
        const u = await fulfilDeletionRequest(tx, row, { resolution: body.resolution, confirm: !!body.confirmAnonymize, actor, deleteFile: async (key) => { filesToRemove.push(key); }, now: container.engine.clock(), cancelRun: (q, runId, reason) => container.engine.cancel(q, runId, actor, reason) });
        return u;
      }
      if (row.kind === "sms_opt_out") {
        const u = await fulfilSmsOptOut(tx, row, actor, container.engine.clock());
        await sendPrivacyCompletion(tx, container.integrations, { row: u, companyName: name, privacyEmail: container.env.PRIVACY_EMAIL, actor });
        return u;
      }
      // human_review and withdrawal close once the person confirms the outcome in the resolution text
      const [u] = await tx.update(dataRequests).set({ status: "fulfilled", resolution: body.resolution, resolvedAt: container.engine.clock().toISOString(), resolvedBy: actor.id }).where(eq(dataRequests.id, row.id)).returning();
      await sendPrivacyCompletion(tx, container.integrations, { row: u, companyName: name, privacyEmail: container.env.PRIVACY_EMAIL, actor });
      return u;
    } catch (err) {
      if (err instanceof CounselDecisionRequired) throw new HttpError(409, "counsel_decision_required", err.message);
      throw err;
    }
  });
  if (deleted) {
    await removeStoredFiles(container, result, filesToRemove);
    await confirmDeletionAfterCommit(container, { row: result, companyName: name, privacyEmail: container.env.PRIVACY_EMAIL, actor });
  }
  await container.kick();
  return c.json(publicDataRequest(deleted ? await reload(container, result) : result));
});

type ContainerOf = Container;

async function reload(container: ContainerOf, row: DataRequestRow): Promise<DataRequestRow> {
  // a platform table, read in a platform transaction like the writes above (tests/policy/raw-db-access.test.ts)
  const [fresh] = await withPlatform(container.db, (tx) => tx.select().from(dataRequests).where(eq(dataRequests.id, row.id)).limit(1));
  return fresh ?? row;
}

/** The anonymized candidate's stored files, removed once the anonymization committed; one that will not go raises an alert. */
async function removeStoredFiles(container: ContainerOf, row: DataRequestRow, keys: string[]): Promise<void> {
  let failed = 0;
  for (const key of keys) {
    try {
      await container.integrations.storage.delete(key);
    } catch (err) {
      failed++;
      console.warn(`[privacy] a stored file of a deleted candidate could not be removed (request ${row.id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed) await withPlatform(container.db, (tx) => raiseAlert(tx, { kind: "privacy_request.file_cleanup", severity: "high", title: "Files of a deleted candidate are still in storage", body: `${failed} of ${keys.length} stored file${keys.length === 1 ? "" : "s"} could not be removed after deletion request ${row.id.slice(0, 8)}. The records are anonymized; remove the files from storage by hand.`, companyId: row.companyId, target: { type: "candidate", id: row.candidateId ?? row.id }, details: { requestId: row.id, failed, files: keys.length } }));
}

/** "Your data was deleted" (or "we could not"), after the commit; a failure is logged and leaves the request unconfirmed for the administrator to see. */
async function confirmDeletionAfterCommit(container: ContainerOf, input: Parameters<typeof sendDeletionConfirmation>[2]): Promise<void> {
  try {
    const sent = await sendDeletionConfirmation(container.db, container.integrations, input);
    if (!sent) console.warn(`[privacy] the confirmation of deletion request ${input.row.id} was not sent; the request shows no confirmation`);
  } catch (err) {
    console.warn(`[privacy] the confirmation of deletion request ${input.row.id} could not be sent: ${err instanceof Error ? err.message : String(err)}`);
  }
}

privacyRequestRoutes.post("/:id/decline", async (c) => {
  const body = DataRequestDecline.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOfAdmin(c);
  const row = await load(c);
  const name = await companyName(c, row.companyId);
  const u = await withPlatform(container.db, async (tx) => {
    const d = await declineDataRequest(tx, row, body.resolution, actor, container.engine.clock());
    // A deletion request's answer is sent directly, never through the outbox, so it waits for the commit.
    if (row.kind !== "delete") await sendPrivacyCompletion(tx, container.integrations, { row: d, companyName: name, privacyEmail: container.env.PRIVACY_EMAIL, actor });
    return d;
  });
  if (row.kind === "delete") await confirmDeletionAfterCommit(container, { row: u, companyName: name, privacyEmail: container.env.PRIVACY_EMAIL, actor });
  await container.kick();
  return c.json(publicDataRequest(row.kind === "delete" ? await reload(container, u) : u));
});

/**
 * Sends the "your data was deleted" (or "we could not") email again, for a closed deletion request whose confirmation
 * never left (the send after the commit failed). The same idempotency key as the first try, so it goes once at most.
 */
privacyRequestRoutes.post("/:id/confirm-again", async (c) => {
  const container = c.get("container");
  const actor = actorOfAdmin(c);
  const row = await load(c);
  if (row.kind !== "delete") throw new HttpError(409, "not_a_deletion", "Only a deletion request's confirmation is sent this way.");
  if (!["fulfilled", "declined"].includes(row.status)) throw new HttpError(409, "still_open", "Fulfil or decline the request first; the confirmation goes then.");
  if (row.confirmationSentAt) throw new HttpError(409, "already_confirmed", "The requester was already told.");
  await confirmDeletionAfterCommit(container, { row, companyName: await companyName(c, row.companyId), privacyEmail: container.env.PRIVACY_EMAIL, actor });
  const fresh = await reload(container, row);
  if (!fresh.confirmationSentAt) throw new HttpError(502, "not_sent", "The confirmation could not be sent. Try again later.");
  return c.json(publicDataRequest(fresh));
});

/** For tests and operators: the candidate an email address maps to inside a company. */
privacyRequestRoutes.get("/lookup/candidate", async (c) => {
  const email = (c.req.query("email") ?? "").toLowerCase();
  const companyId = c.req.query("companyId") ?? "";
  const [cand] = await c.get("container").db.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(and(eq(candidates.companyId, companyId), eq(candidates.email, email))).limit(1);
  const apps = cand ? await c.get("container").db.select({ id: applications.id, roleId: applications.roleId, stage: applications.stage }).from(applications).where(eq(applications.candidateId, cand.id)) : [];
  return c.json({ candidate: cand ?? null, applications: apps });
});
