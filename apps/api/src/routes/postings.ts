import { Hono, type Context } from "hono";
import { and, eq, gte } from "drizzle-orm";
import { CreateApplicationLink, PostingReason, RecordPostingUrl, SetAcceptingApplications, VerifyPosting } from "@ros/contracts";
import { BOARD_UP_STATES, CHANNEL_NAME, POSTING_CHANNELS, POSTING_STATE_LABEL, POSTING_VERIFY_JOB_KIND, POSTING_VERIFY_MAX_ATTEMPTS, PostingNotFoundError, PostingTransitionError, SOURCES, SOURCE_LABEL, assertCan, audit, createApplicationLink, disableApplicationLink, emit, isBoardChannel, isPostingState, isSource, listApplicationLinks, notify, postingPackage, transitionPosting, type ApplicationLinkRow, type PostingChannel, type PostingPatch, type PostingRow, type PostingState } from "@ros/core";
import { applicationLinks, applications, companies, postings, rolePackets, roles, withTenant, type Tx } from "@ros/db";
import { intakeAddress } from "@ros/integrations";
import { DEFAULT_VOLUME_ALERT_PER_DAY, localDays } from "@ros/workflows";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import { actorOf, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { jobUrls, trackedLinkUrl } from "../services/job-urls";
import { replayHeldEmails } from "../webhooks/postmark";

/**
 * The owner's posting routes (docs/spec/20 section 2, items 9 to 17). Mounted under /api/v1/roles after the role
 * routes. Reading needs `role.read`; every change needs `role.manage`, is audited, and moves the posting through the
 * state table in packages/core/src/postings.ts (a refused move answers 409 and names both states). Nothing here posts
 * to a board or touches a candidate: a person posts by hand, records the public address, and the worker checks it.
 */
export const postingRoutes = new Hono<Vars>();
postingRoutes.use("/:id/*", roleScopeGuard);

/** The "Applications by source" report covers today and the thirteen days before it, in the company's time zone. */
const VOLUME_WINDOW_DAYS = 14;

type RoleRow = typeof roles.$inferSelect;
type Actor = ReturnType<typeof actorOf>;

export type LinkView = { id: string; url: string; source: string; sourceLabel: string; sourceDetail: string | null; label: string; postingId: string | null; visits: number; lastVisitedAt: string | null; createdAt: string; disabledAt: string | null };
export type PostingView = PostingRow & { name: string; stateLabel: string; isBoard: boolean; link: LinkView | null; package: { text: string; fields: Record<string, string> } | null; stillUp: boolean };

function postingHttpError(e: unknown): never {
  if (e instanceof PostingTransitionError) throw new HttpError(409, e.code, e.message, { from: e.from, to: e.to });
  if (e instanceof PostingNotFoundError) throw new HttpError(404, "not_found", e.message);
  throw e;
}

/** `transitionPosting` with the state table's refusal turned into a 409 the page can show as it is. */
async function move(tx: Tx, input: Parameters<typeof transitionPosting>[1]): Promise<Awaited<ReturnType<typeof transitionPosting>>> {
  try {
    return await transitionPosting(tx, input);
  } catch (e) {
    postingHttpError(e);
  }
}

function channelParam(c: Context<Vars>): PostingChannel {
  const channel = c.req.param("channel") ?? "";
  if (!(POSTING_CHANNELS as readonly string[]).includes(channel)) throw new HttpError(404, "not_found", "There is no such channel.");
  return channel as PostingChannel;
}

async function loadRole(tx: Tx, roleId: string): Promise<RoleRow> {
  const [role] = await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role) throw new HttpError(404, "not_found", "Role not found.");
  return role;
}

async function loadPosting(tx: Tx, roleId: string, channel: PostingChannel): Promise<PostingRow> {
  const [p] = await tx.select().from(postings).where(and(eq(postings.roleId, roleId), eq(postings.channel, channel))).limit(1);
  if (!p) throw new HttpError(404, "not_found", `${CHANNEL_NAME[channel]} is not prepared for this role yet. It is prepared when the role is approved and open.`);
  return p;
}

function stateLabel(status: string): string {
  return isPostingState(status) ? POSTING_STATE_LABEL[status] : status;
}

function channelName(channel: string): string {
  return (POSTING_CHANNELS as readonly string[]).includes(channel) ? CHANNEL_NAME[channel as PostingChannel] : channel;
}

function linkView(container: Container, l: ApplicationLinkRow): LinkView {
  return { id: l.id, url: trackedLinkUrl(container.env, l.token), source: l.source, sourceLabel: isSource(l.source) ? SOURCE_LABEL[l.source] : l.source, sourceDetail: l.sourceDetail, label: l.label, postingId: l.postingId, visits: l.visits, lastVisitedAt: l.lastVisitedAt, createdAt: l.createdAt, disabledAt: l.disabledAt };
}

/** Everything the package and the cards are built from: the company, the current packet, the public URLs, the intake address, the links. */
async function postingContext(tx: Tx, container: Container, role: RoleRow) {
  const [company] = await tx.select({ name: companies.name, slug: companies.slug, locations: companies.locations, settings: companies.settings }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
  const [pv] = role.currentPacketVersion ? await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, role.currentPacketVersion))).limit(1) : [];
  const posts = (await tx.select().from(postings).where(eq(postings.roleId, role.id))).sort((a, b) => (POSTING_CHANNELS as readonly string[]).indexOf(a.channel) - (POSTING_CHANNELS as readonly string[]).indexOf(b.channel));
  const links = await listApplicationLinks(tx, role.id);
  const urls = jobUrls(container.env, { slug: company?.slug ?? "", roleId: role.id });
  const emailIn = posts.find((p) => p.channel === "email_in") ?? null;
  const emailInAddress = emailIn?.intakeToken ? intakeAddress(emailIn.intakeToken, container.integrations.env.intakeDomain) : null;
  const emailInConnected = emailIn?.status === "live_verified";
  const linkUrl = (l: ApplicationLinkRow) => trackedLinkUrl(container.env, l.token);
  return { company, packet: pv?.packet ?? null, posts, links, urls, emailIn, emailInAddress, emailInConnected, linkUrl };
}
type PostingContext = Awaited<ReturnType<typeof postingContext>>;

/** The package for one channel (item 9): a board gets its own tracked apply link; the intake address is offered only while email-in is connected. */
function packageFor(ctx: PostingContext, p: PostingRow): { text: string; fields: Record<string, string> } | null {
  if (!ctx.packet || p.channel === "email_in") return null;
  const active = ctx.links.find((l) => l.postingId === p.id && !l.disabledAt) ?? null;
  return postingPackage({ packet: ctx.packet, companyName: ctx.company?.name ?? "", jobUrl: ctx.urls.job, applyUrl: active ? ctx.linkUrl(active) : ctx.urls.apply, intakeAddress: ctx.emailInConnected ? ctx.emailInAddress : null, boardName: isBoardChannel(p.channel) ? CHANNEL_NAME[p.channel] : null, companyLocations: ctx.company?.locations ?? [], noticeOverrides: ctx.company?.settings.notices });
}

function postingView(container: Container, ctx: PostingContext, p: PostingRow): PostingView {
  const isBoard = isBoardChannel(p.channel);
  const active = ctx.links.find((l) => l.postingId === p.id && !l.disabledAt) ?? null;
  return { ...p, name: channelName(p.channel), stateLabel: stateLabel(p.status), isBoard, link: active ? linkView(container, active) : null, package: isBoard ? packageFor(ctx, p) : null, stillUp: p.closureRequired && !p.closureConfirmedAt };
}

async function describePostings(tx: Tx, container: Container, role: RoleRow) {
  const ctx = await postingContext(tx, container, role);
  const views = ctx.posts.map((p) => postingView(container, ctx, p));
  return {
    role: { id: role.id, title: role.title, status: role.status, acceptingApplications: role.acceptingApplications, applicationsClosedAt: role.applicationsClosedAt, applicationsClosedReason: role.applicationsClosedReason, volumeAlertPerDay: role.volumeAlertPerDay ?? DEFAULT_VOLUME_ALERT_PER_DAY },
    urls: ctx.urls,
    emailIn: { address: ctx.emailInAddress, connected: ctx.emailInConnected, status: ctx.emailIn?.status ?? null, error: ctx.emailIn?.error ?? null },
    postings: views,
    links: ctx.links.map((l) => linkView(container, l)),
    boardsStillUp: views.filter((v) => v.stillUp).map((v) => v.channel),
  };
}

async function describeOne(tx: Tx, container: Container, role: RoleRow, postingId: string): Promise<PostingView> {
  const ctx = await postingContext(tx, container, role);
  const p = ctx.posts.find((x) => x.id === postingId);
  if (!p) throw new HttpError(404, "not_found", "Posting not found.");
  return postingView(container, ctx, p);
}

/**
 * Queues a fetch of the posting's address. The tenant role may only insert jobs (migration 0013), so a check that is
 * already waiting in the queue is neither seen nor cancelled here: it keeps running, reads the row's current address
 * when its turn comes, and every fetch it makes is counted on the row like any other. Two checks in flight are
 * harmless: either one marks the posting live, and a posting is failed only after three real fetches missed.
 * A posting a person has confirmed by hand is left alone by any check still waiting; only a check a person asked
 * for ("Check again", `requested`) fetches a person-verified posting again.
 */
async function queueCheck(tx: Tx, container: Container, postingId: string, companyId: string, opts: { requested?: boolean } = {}): Promise<void> {
  await container.engine.enqueue(tx, { kind: POSTING_VERIFY_JOB_KIND, payload: { postingId, companyId, requested: opts.requested === true }, maxAttempts: POSTING_VERIFY_MAX_ATTEMPTS });
}

/** A fresh address starts from nothing: whatever was verified before was verified at a different address. */
const UNVERIFIED: PostingPatch = { verifiedAt: null, verifiedBy: null, verificationNote: null, verificationAttempts: 0, verificationError: null, error: null };

async function auditPosting(tx: Tx, companyId: string, actor: Actor, posting: PostingRow, reason: string, details: Record<string, unknown> = {}): Promise<void> {
  await audit(tx, { companyId, actor, action: "posting.changed", target: { type: "posting", id: posting.id }, reason, details: { channel: posting.channel, roleId: posting.roleId, ...details } });
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Reading                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

postingRoutes.get("/:id/postings", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => describePostings(tx, container, await loadRole(tx, c.req.param("id"))));
  return c.json(result);
});

postingRoutes.get("/:id/postings/:channel/package", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const channel = channelParam(c);
  if (channel === "email_in") throw new HttpError(409, "not_a_posting", "Applications by email has no posting package. Share the intake address instead.");
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    const posting = await loadPosting(tx, role.id, channel);
    const pkg = packageFor(await postingContext(tx, container, role), posting);
    if (!pkg) throw new HttpError(409, "no_packet", "The role has no approved packet yet, so there is nothing to post.");
    return pkg;
  });
  return c.json(result);
});

/* ------------------------------------------------------------------------------------------------------------ */
/* Moving a posting                                                                                               */
/* ------------------------------------------------------------------------------------------------------------ */

/** Item 13: a person posted by hand and records the board's public address; the worker then checks it (item 12). */
postingRoutes.post("/:id/postings/:channel/url", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const channel = channelParam(c);
  if (!isBoardChannel(channel)) throw new HttpError(409, "not_a_board", `${CHANNEL_NAME[channel]} has no address to record: the system knows where it lives.`);
  const body = RecordPostingUrl.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    const posting = await loadPosting(tx, role.id, channel);
    const now = container.engine.clock();
    const patch: PostingPatch = { ...UNVERIFIED, externalUrl: body.url, publicUrlRecordedAt: now.toISOString() };
    let row: PostingRow;
    if (posting.status === "posted_manually") {
      // a corrected address while the first check is still pending: the state stays, the checks start over
      [row] = await tx.update(postings).set(patch).where(eq(postings.id, posting.id)).returning();
      await emit(tx, { type: "posting.posted_manually", companyId: t.companyId, actor, subject: { type: "posting", id: row.id }, payload: { channel, roleId: role.id, from: "posted_manually", to: "posted_manually", url: body.url, corrected: true } });
    } else {
      row = (await move(tx, { postingId: posting.id, to: "posted_manually", actor, now, patch })).row;
    }
    await queueCheck(tx, container, row.id, t.companyId);
    await auditPosting(tx, t.companyId, actor, row, "public URL recorded", { url: body.url });
    return describeOne(tx, container, role, row.id);
  });
  await container.kick();
  return c.json(result);
});

/** "I checked it myself": a person confirms the posting is up, with a note; the record names them (item 12). */
postingRoutes.post("/:id/postings/:channel/verify", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const channel = channelParam(c);
  if (channel === "email_in") throw new HttpError(409, "not_a_posting", "Applications by email is connected by the system; there is nothing to verify by hand.");
  const body = VerifyPosting.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    let posting = await loadPosting(tx, role.id, channel);
    if (isBoardChannel(channel) && !posting.externalUrl) throw new HttpError(409, "url_required", "Record the public address of the posting first, then confirm you checked it.");
    const now = container.engine.clock();
    if (posting.status === "failed") {
      // a failed automatic check does not stop a person: back to posted (or submitted) with the same address, then verified
      posting = (await move(tx, { postingId: posting.id, to: channel === "google_jobs" ? "submitted_integration" : "posted_manually", actor, now, patch: { error: null }, reason: "a person is confirming the posting" })).row;
    }
    const moved = await move(tx, { postingId: posting.id, to: "live_verified", actor, now, patch: { verificationNote: body.note, verificationError: null, verificationAttempts: 0, error: null }, payload: { check: "person" } });
    await auditPosting(tx, t.companyId, actor, moved.row, "verified by a person", { note: body.note, from: moved.from });
    return describeOne(tx, container, role, moved.row.id);
  });
  return c.json(result);
});

/**
 * The careers page and the Google listing are the job page itself (Wave 0 item 0.8): pausing or closing them here would
 * change a label while the page stayed up and kept taking applications. They follow the role instead, so these moves
 * are refused with the way to do it. (Resuming one that an earlier version left paused stays possible.)
 */
function refuseNativeMove(channel: PostingChannel, action: "pause" | "close"): void {
  if (channel !== "careers_page" && channel !== "google_jobs") return;
  throw new HttpError(409, "follows_the_role", `${CHANNEL_NAME[channel]} shows the job page itself, so it cannot be ${action === "pause" ? "paused" : "closed"} on its own. To stop new applications, turn off "accepting applications" or pause the role; ${action === "pause" ? "the page then says so" : "closing the role closes it too"}.`);
}

postingRoutes.post("/:id/postings/:channel/pause", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const channel = channelParam(c);
  refuseNativeMove(channel, "pause");
  const body = PostingReason.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    const posting = await loadPosting(tx, role.id, channel);
    const moved = await move(tx, { postingId: posting.id, to: "paused", actor, now: container.engine.clock(), reason: body.reason ?? null });
    await auditPosting(tx, t.companyId, actor, moved.row, body.reason ?? "paused", { from: moved.from });
    return describeOne(tx, container, role, moved.row.id);
  });
  return c.json(result);
});

/** Resume goes back to where the posting was: verified stays verified, a recorded address is checked again, otherwise ready to post. */
postingRoutes.post("/:id/postings/:channel/resume", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const channel = channelParam(c);
  const body = PostingReason.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const actor = actorOf(c);
  let queued = false;
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    const posting = await loadPosting(tx, role.id, channel);
    if (posting.status !== "paused") throw new HttpError(409, "not_paused", `${CHANNEL_NAME[channel]} is not paused (it is "${stateLabel(posting.status)}").`);
    const now = container.engine.clock();
    let moved: Awaited<ReturnType<typeof move>>;
    if (posting.verifiedAt) {
      moved = await move(tx, { postingId: posting.id, to: "live_verified", actor, now, reason: body.reason ?? null, patch: { verifiedAt: posting.verifiedAt, verifiedBy: posting.verifiedBy, verificationNote: posting.verificationNote } });
    } else if (channel === "google_jobs") {
      await move(tx, { postingId: posting.id, to: "ready_to_post", actor, now, reason: body.reason ?? null });
      moved = await move(tx, { postingId: posting.id, to: "submitted_integration", actor, now, reason: body.reason ?? null });
    } else if (posting.externalUrl) {
      moved = await move(tx, { postingId: posting.id, to: "posted_manually", actor, now, reason: body.reason ?? null, patch: { verificationAttempts: 0, verificationError: null } });
      await queueCheck(tx, container, moved.row.id, t.companyId);
      queued = true;
    } else {
      moved = await move(tx, { postingId: posting.id, to: "ready_to_post", actor, now, reason: body.reason ?? null });
    }
    await auditPosting(tx, t.companyId, actor, moved.row, body.reason ?? "resumed", { to: moved.to });
    return describeOne(tx, container, role, moved.row.id);
  });
  if (queued) await container.kick();
  return c.json(result);
});

/** Item 14: closing a posting a person put on a board still needs the board taken down; the closure checkbox records that. */
postingRoutes.post("/:id/postings/:channel/close", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const channel = channelParam(c);
  refuseNativeMove(channel, "close");
  const body = PostingReason.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    const posting = await loadPosting(tx, role.id, channel);
    const stillUp = isBoardChannel(channel) && BOARD_UP_STATES.includes(posting.status as PostingState);
    const moved = await move(tx, { postingId: posting.id, to: "closed", actor, now: container.engine.clock(), reason: body.reason ?? null, patch: stillUp ? { closureRequired: true } : {} });
    if (stillUp) await emit(tx, { type: "posting.closure_required", companyId: t.companyId, actor, subject: { type: "posting", id: posting.id }, payload: { channel, roleId: role.id, url: posting.externalUrl } });
    await auditPosting(tx, t.companyId, actor, moved.row, body.reason ?? "closed", { from: moved.from, closureRequired: stillUp });
    return describeOne(tx, container, role, moved.row.id);
  });
  return c.json(result);
});

/** Item 15: the board was taken down by hand. Ticking it twice changes nothing. */
postingRoutes.post("/:id/postings/:channel/closure-confirm", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const channel = channelParam(c);
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    const posting = await loadPosting(tx, role.id, channel);
    if (!posting.closureRequired) throw new HttpError(409, "not_required", `${CHANNEL_NAME[channel]} was not up when it closed, so there is nothing to take down.`);
    if (posting.closureConfirmedAt) return describeOne(tx, container, role, posting.id);
    const now = container.engine.clock().toISOString();
    const [row] = await tx.update(postings).set({ closureConfirmedAt: now, closureConfirmedBy: actor }).where(eq(postings.id, posting.id)).returning();
    await emit(tx, { type: "posting.closure_confirmed", companyId: t.companyId, actor, subject: { type: "posting", id: row.id }, payload: { channel, roleId: role.id, url: row.externalUrl } });
    await auditPosting(tx, t.companyId, actor, row, "removed from the board, confirmed by a person");
    return describeOne(tx, container, role, row.id);
  });
  return c.json(result);
});

/**
 * Retry: a board (or the careers page) with a recorded address is checked again; a board that failed before any
 * address was recorded goes back to ready to post; a failed native channel is prepared again by the publish workflow.
 */
postingRoutes.post("/:id/postings/:channel/retry", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const channel = channelParam(c);
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    const posting = await loadPosting(tx, role.id, channel);
    const now = container.engine.clock();
    const checkable = isBoardChannel(channel) || channel === "careers_page";
    if (checkable && posting.externalUrl) {
      if (posting.status === "failed") {
        // the earlier verification did not survive the failed checks; the address is checked from nothing
        const moved = await move(tx, { postingId: posting.id, to: "posted_manually", actor, now, reason: "check again", patch: UNVERIFIED });
        await queueCheck(tx, container, moved.row.id, t.companyId, { requested: true });
      } else if (["posted_manually", "live_verified"].includes(posting.status)) {
        await tx.update(postings).set({ verificationAttempts: 0, verificationError: null }).where(eq(postings.id, posting.id));
        await queueCheck(tx, container, posting.id, t.companyId, { requested: true });
      } else {
        throw new HttpError(409, "nothing_to_retry", `${CHANNEL_NAME[channel]} is "${stateLabel(posting.status)}"; ${posting.status === "paused" ? "resume it first" : "there is nothing to check"}.`);
      }
      await auditPosting(tx, t.companyId, actor, posting, "check again");
      return { ok: true, action: "check_again" as const, posting: await describeOne(tx, container, role, posting.id) };
    }
    if (posting.status !== "failed") throw new HttpError(409, "nothing_to_retry", `${CHANNEL_NAME[channel]} is "${stateLabel(posting.status)}"; there is nothing to retry.`);
    if (isBoardChannel(channel)) {
      // nothing was recorded yet: back to the steps, for a person to post and record the address
      const moved = await move(tx, { postingId: posting.id, to: "ready_to_post", actor, now, reason: "retry", patch: { error: null } });
      await auditPosting(tx, t.companyId, actor, moved.row, "back to ready to post");
      return { ok: true, action: "ready_to_post" as const, posting: await describeOne(tx, container, role, moved.row.id) };
    }
    if (role.status !== "open") throw new HttpError(409, "not_open", "The role must be open to post.");
    await container.engine.start(tx, { workflowKey: "publish_role", companyId: t.companyId, subject: { type: "role", id: role.id }, state: { roleId: role.id, packetVersion: role.currentPacketVersion }, actor });
    await auditPosting(tx, t.companyId, actor, posting, "publish retried");
    return { ok: true, action: "republish" as const, posting: await describeOne(tx, container, role, posting.id) };
  });
  await container.kick();
  return c.json(result);
});

/* ------------------------------------------------------------------------------------------------------------ */
/* Tracked links (items 7 and 19)                                                                                 */
/* ------------------------------------------------------------------------------------------------------------ */

postingRoutes.get("/:id/links", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const container = c.get("container");
  const rows = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    return (await listApplicationLinks(tx, role.id)).map((l) => linkView(container, l));
  });
  return c.json(rows);
});

postingRoutes.post("/:id/links", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const body = CreateApplicationLink.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const row = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    if (role.status === "closed") throw new HttpError(409, "role_closed", "The role is closed; a new link would lead nowhere.");
    const link = await createApplicationLink(tx, { companyId: t.companyId, roleId: role.id, source: body.source, sourceDetail: body.sourceDetail || null, label: body.label, actor, now: container.engine.clock() });
    await audit(tx, { companyId: t.companyId, actor, action: "application_link.changed", target: { type: "application_link", id: link.id }, reason: "created", details: { roleId: role.id, source: link.source, label: link.label } });
    return linkView(container, link);
  });
  return c.json(row, 201);
});

postingRoutes.post("/:id/links/:linkId/disable", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const container = c.get("container");
  const actor = actorOf(c);
  const row = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    const [link] = await tx.select().from(applicationLinks).where(and(eq(applicationLinks.id, c.req.param("linkId")), eq(applicationLinks.roleId, role.id))).limit(1);
    if (!link) throw new HttpError(404, "not_found", "Link not found.");
    if (link.disabledAt) throw new HttpError(409, "already_disabled", "This link is already disabled.");
    if (link.postingId) {
      const [p] = await tx.select({ status: postings.status, channel: postings.channel }).from(postings).where(eq(postings.id, link.postingId)).limit(1);
      if (p && BOARD_UP_STATES.includes(p.status as PostingState)) throw new HttpError(409, "link_in_use", `This is the apply link on ${channelName(p.channel)} and that posting is still up. Close or pause the posting first.`);
    }
    const disabled = await disableApplicationLink(tx, { linkId: link.id, companyId: t.companyId, actor, now: container.engine.clock() });
    if (!disabled) throw new HttpError(409, "already_disabled", "This link is already disabled.");
    await audit(tx, { companyId: t.companyId, actor, action: "application_link.changed", target: { type: "application_link", id: link.id }, reason: "disabled", details: { roleId: role.id, source: link.source, label: link.label } });
    return linkView(container, disabled);
  });
  return c.json(row);
});

/* ------------------------------------------------------------------------------------------------------------ */
/* Volume (item 16) and the accepting switch (items 16 and 17)                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

export type VolumeDay = { day: string; total: number; bySource: Record<string, number> };

/**
 * Applications per day for the last fourteen days, by source. Days are calendar days in the company's time zone, cut
 * the same way the daily volume alert cuts them. Counting only: nothing here touches an application.
 */
postingRoutes.get("/:id/volume", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
    const local = localDays(container.engine.clock(), company?.timezone);
    const windowStart = local.start(-(VOLUME_WINDOW_DAYS - 1));
    const rows = await tx.select({ createdAt: applications.createdAt, source: applications.source }).from(applications).where(and(eq(applications.roleId, role.id), gte(applications.createdAt, windowStart.toISOString())));
    const days: VolumeDay[] = Array.from({ length: VOLUME_WINDOW_DAYS }, (_, i) => ({ day: local.key(local.start(i - (VOLUME_WINDOW_DAYS - 1))), total: 0, bySource: {} }));
    const byDay = new Map(days.map((d) => [d.day, d]));
    const totals: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const d = byDay.get(local.key(new Date(r.createdAt)));
      if (!d) continue; // a row stamped after "now" on a moved clock, or before the window
      d.total += 1;
      d.bySource[r.source] = (d.bySource[r.source] ?? 0) + 1;
      totals[r.source] = (totals[r.source] ?? 0) + 1;
      total += 1;
    }
    const order = (s: string) => { const i = (SOURCES as readonly string[]).indexOf(s); return i === -1 ? SOURCES.length : i; };
    const sources = Object.keys(totals).sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map((source) => ({ source, label: isSource(source) ? SOURCE_LABEL[source] : source, total: totals[source] }));
    const yesterday = days[days.length - 2];
    const today = days[days.length - 1];
    return { from: days[0].day, to: today.day, timeZone: local.timeZone, days, totals: { total, bySource: totals }, sources, threshold: role.volumeAlertPerDay ?? DEFAULT_VOLUME_ALERT_PER_DAY, yesterday: { day: yesterday.day, total: yesterday.total }, today: { day: today.day, total: today.total }, acceptingApplications: role.acceptingApplications, applicationsClosedAt: role.applicationsClosedAt, applicationsClosedReason: role.applicationsClosedReason };
  });
  return c.json(result);
});

/**
 * The switch (item 16), distinct from pausing the role: the job page stays up and says applications are closed, the
 * apply routes refuse new submissions, and nobody who already applied is touched (item 17). The team is told.
 */
postingRoutes.post("/:id/applications/accepting", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const body = SetAcceptingApplications.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    if (role.status === "closed") throw new HttpError(409, "role_closed", "The role is closed, so it is not taking applications.");
    const pick = (r: RoleRow) => ({ id: r.id, acceptingApplications: r.acceptingApplications, applicationsClosedAt: r.applicationsClosedAt, applicationsClosedReason: r.applicationsClosedReason });
    if (role.acceptingApplications === body.accepting) return { ok: true, changed: false, role: pick(role) };
    const now = container.engine.clock().toISOString();
    const [updated] = await tx.update(roles).set({ acceptingApplications: body.accepting, applicationsClosedAt: body.accepting ? null : now, applicationsClosedReason: body.accepting ? null : body.reason ?? null }).where(eq(roles.id, role.id)).returning();
    await emit(tx, { type: body.accepting ? "role.applications_reopened" : "role.applications_closed", companyId: t.companyId, actor, subject: { type: "role", id: role.id }, payload: { reason: body.reason ?? null } });
    const who = actor.name ?? "A team member";
    await notify(tx, {
      companyId: t.companyId,
      kind: body.accepting ? "applications.reopened" : "applications.closed",
      title: body.accepting ? `${role.title} is taking applications again` : `${role.title} stopped taking new applications`,
      body: body.accepting ? `${who} reopened applications. The job page shows the apply button again.` : `${who} closed applications${body.reason ? ` (${body.reason})` : ""}. The job page stays up and says applications are closed. Everyone who already applied stays exactly where they are.`,
      action: { label: "Open the Posting tab", href: `/roles/${role.id}?tab=posting` },
    });
    await audit(tx, { companyId: t.companyId, actor, action: "role.applications_toggled", target: { type: "role", id: role.id }, reason: body.reason ?? (body.accepting ? "reopened" : "closed"), details: { accepting: body.accepting } });
    return { ok: true, changed: true, role: pick(updated) };
  });
  // Applications that arrived by email while the switch was off were held (C19); reopening adds them to the role.
  if (result.changed && body.accepting) await replayHeldEmails(container, { companyId: t.companyId, roleId: result.role.id });
  return c.json(result);
});
