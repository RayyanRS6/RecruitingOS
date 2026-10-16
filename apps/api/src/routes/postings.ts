import { Hono, type Context } from "hono";
import { and, eq, gte } from "drizzle-orm";
import { ConfirmBoardUpdated, CreateApplicationLink, CreateShareLink, PostingReason, RecordPostingUrl, SetAcceptingApplications, SetPublishChannels, VerifyPosting, companyOnboarding, type PostingTaskKind, type PostingTaskView } from "@ros/contracts";
import { BOARD_CHANNELS, BOARD_UP_STATES, CHANNEL_NAME, CLOSING_DATE_REASON, POSTING_CHANNELS, POSTING_STATE_LABEL, POSTING_VERIFY_JOB_KIND, POSTING_VERIFY_MAX_ATTEMPTS, PostingNotFoundError, PostingTransitionError, SHARE_PLACES, SOURCES, SOURCE_LABEL, assertCan, audit, boardPostingOf, can, chosenBoards, closingMoment, confirmBoardRemoved, confirmBoardUpdated, createApplicationLink, disableApplicationLink, emit, isBoardChannel, isPostingState, isSource, listApplicationLinks, notify, openPostingTask, postingPackage, postingTaskLabel, postingTaskNeeded, postingTasksForRole, showsOldVersion, transitionPosting, zipRecruiterOffered, type ApplicationLinkRow, type BoardChannel, type PostingChannel, type PostingPatch, type PostingRow, type PostingState } from "@ros/core";
import { applicationLinks, applications, companies, postings, rolePackets, roles, withTenant, type Tx } from "@ros/db";
import { intakeAddress } from "@ros/integrations";
import { DEFAULT_VOLUME_ALERT_PER_DAY, localDays } from "@ros/workflows";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import { actorOf, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { jobUrls, shareTargets, trackedLinkUrl } from "../services/job-urls";
import { currentVersionOf } from "../services/packet-versions";
import { boardChoices, closingDateFor, postingTaskViews, publishingState, sharePlaceLink, shareText, shareView } from "../services/publishing";
import { tellItsQueueAboutTasks } from "../services/publishing-backfill";
import { assertNoNewWork } from "../services/trial";
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

export type LinkView = { id: string; url: string; source: string; sourceLabel: string; sourceDetail: string | null; label: string; postingId: string | null; visits: number; lastVisitedAt: string | null; createdAt: string; disabledAt: string | null; landing: string };
/**
 * One channel as the Posting tab and the after-approval screen show it (plan D2). For a board: `chosen` (still ticked
 * for the role), `postedBy` ("its" when an ITS recruiter posts it from the company's own account, "you" otherwise),
 * the latest ITS posting `task` with its state, and `showsOldVersion` once an approved edit left it behind.
 */
export type PostingView = PostingRow & { name: string; stateLabel: string; isBoard: boolean; link: LinkView | null; package: { text: string; fields: Record<string, string> } | null; stillUp: boolean; chosen: boolean; postedBy: "its" | "you" | null; task: PostingTaskView | null; showsOldVersion: boolean };

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
  return { id: l.id, url: trackedLinkUrl(container.env, l.token), source: l.source, sourceLabel: isSource(l.source) ? SOURCE_LABEL[l.source] : l.source, sourceDetail: l.sourceDetail, label: l.label, postingId: l.postingId, visits: l.visits, lastVisitedAt: l.lastVisitedAt, createdAt: l.createdAt, disabledAt: l.disabledAt, landing: l.landing };
}

/** Everything the package and the cards are built from: the company, the current packet, the public URLs, the intake address, the links, the ITS tasks. */
async function postingContext(tx: Tx, container: Container, role: RoleRow) {
  const [company] = await tx.select({ name: companies.name, slug: companies.slug, locations: companies.locations, settings: companies.settings, timezone: companies.timezone }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
  const [pv] = role.currentPacketVersion ? await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, role.currentPacketVersion))).limit(1) : [];
  const posts = (await tx.select().from(postings).where(eq(postings.roleId, role.id))).sort((a, b) => (POSTING_CHANNELS as readonly string[]).indexOf(a.channel) - (POSTING_CHANNELS as readonly string[]).indexOf(b.channel));
  const links = await listApplicationLinks(tx, role.id);
  const urls = jobUrls(container.env, { slug: company?.slug ?? "", roleId: role.id });
  const emailIn = posts.find((p) => p.channel === "email_in") ?? null;
  const emailInAddress = emailIn?.intakeToken ? intakeAddress(emailIn.intakeToken, container.integrations.env.intakeDomain) : null;
  const emailInConnected = emailIn?.status === "live_verified";
  const linkUrl = (l: ApplicationLinkRow) => trackedLinkUrl(container.env, l.token);
  const tasks = postingTaskViews(await postingTasksForRole(tx, role.id), (id) => posts.find((p) => p.id === id)?.channel ?? null);
  const boards: readonly string[] = pv ? chosenBoards(role, pv.packet, company?.settings) : (role.publishChannels ?? []);
  return { company, packet: pv?.packet ?? null, posts, links, urls, emailIn, emailInAddress, emailInConnected, linkUrl, tasks, boards, whoPosts: boardPostingOf(company?.settings), currentVersion: role.currentPacketVersion };
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
  return {
    ...p, name: channelName(p.channel), stateLabel: stateLabel(p.status), isBoard, link: active ? linkView(container, active) : null, package: isBoard ? packageFor(ctx, p) : null, stillUp: p.closureRequired && !p.closureConfirmedAt,
    chosen: !isBoard || ctx.boards.includes(p.channel), postedBy: isBoard ? (ctx.whoPosts === "its" ? "its" : "you") : null, task: ctx.tasks.get(p.id) ?? null, showsOldVersion: showsOldVersion(p, ctx.currentVersion),
  };
}

/**
 * The Posting tab and the screen right after approval (plan D2). Besides the channels, links and the email address:
 * `publishing` says where publishing stands and when to ask again (poll while `pollAfterSeconds` is a number),
 * `whoPosts` and `boards` are the board ticks (D3, D6), `closingDate` the role's date (D7), `share` the ready-made share
 * places (D8), and `interviewers` whether every interview step has someone on it. `emailIn.shown` is true only while
 * applications by email actually work, so the screen offers the address only then.
 */
async function describePostings(tx: Tx, container: Container, role: RoleRow) {
  const ctx = await postingContext(tx, container, role);
  const views = ctx.posts.map((p) => postingView(container, ctx, p));
  const now = container.engine.clock();
  const rounds = ctx.packet?.interviews.plan ?? [];
  return {
    role: { id: role.id, title: role.title, status: role.status, acceptingApplications: role.acceptingApplications, applicationsClosedAt: role.applicationsClosedAt, applicationsClosedReason: role.applicationsClosedReason, volumeAlertPerDay: role.volumeAlertPerDay ?? DEFAULT_VOLUME_ALERT_PER_DAY, applicationsCloseOn: role.applicationsCloseOn, openedAt: role.openedAt, currentPacketVersion: role.currentPacketVersion },
    urls: ctx.urls,
    emailIn: { address: ctx.emailInAddress, connected: ctx.emailInConnected, shown: ctx.emailInConnected, status: ctx.emailIn?.status ?? null, error: ctx.emailIn?.error ?? null },
    postings: views,
    links: ctx.links.map((l) => linkView(container, l)),
    boardsStillUp: views.filter((v) => v.stillUp).map((v) => v.channel),
    publishing: await publishingState(tx, { role, company: ctx.company ?? null, packet: ctx.packet, posts: ctx.posts }),
    whoPosts: ctx.whoPosts,
    boards: boardChoices(role, ctx.packet, ctx.company?.settings),
    closingDate: closingDateFor(role, ctx.company ?? null, ctx.packet, now),
    share: shareView({ packet: ctx.packet, companyName: ctx.company?.name ?? "", jobUrl: ctx.urls.job, links: ctx.links, linkUrl: ctx.linkUrl }),
    interviewers: { rounds: rounds.length, roundsWithoutInterviewers: rounds.filter((r) => !r.interviewerUserIds.length).length },
  };
}

/**
 * What an ITS recruiter sees of a posting task they accepted (plan D3): the job ad as the board will show it (the
 * posting package, with the board's own apply link), the numbered steps, where the posting stands and what to do.
 * Nothing about applicants, so no access grant is needed and none is given.
 */
export async function postingTaskDetail(tx: Tx, container: Container, task: { kind: string; postingId: string | null; roleId: string | null }) {
  if (!task.postingId || !task.roleId) throw new HttpError(404, "not_found", "This task names no posting.");
  const role = await loadRole(tx, task.roleId);
  const ctx = await postingContext(tx, container, role);
  const p = ctx.posts.find((x) => x.id === task.postingId);
  if (!p || !isBoardChannel(p.channel)) throw new HttpError(404, "not_found", "The posting this task is about no longer exists.");
  const view = postingView(container, ctx, p);
  const kind = task.kind as PostingTaskKind;
  const board = CHANNEL_NAME[p.channel];
  const company = ctx.company?.name ?? "the company";
  const boardAccessConfirmed = !!companyOnboarding(ctx.company?.settings).jobBoardsConfirmedAt;
  const whatToDo = kind === "post_job"
    ? `Sign in to ${board} with ${company}'s own account and post the job with the package below, using ${board}'s own apply link. Then record the public address here; the task closes once the address is checked.`
    : kind === "update_job"
      ? `Update the ${board} listing${p.externalUrl ? ` (${p.externalUrl})` : ""} from ${company}'s own account with the package below (version ${role.currentPacketVersion ?? "?"}), then confirm it here.`
      : `Take the ${board} listing${p.externalUrl ? ` (${p.externalUrl})` : ""} down from ${company}'s own account, then confirm it is gone here.`;
  return {
    kind,
    label: postingTaskLabel(kind, board),
    companyName: ctx.company?.name ?? "",
    role: { id: role.id, title: role.title, status: role.status, currentPacketVersion: role.currentPacketVersion },
    board: { channel: p.channel, name: board },
    posting: { id: p.id, status: p.status, stateLabel: view.stateLabel, externalUrl: p.externalUrl, verifiedAt: p.verifiedAt, verificationError: p.verificationError, error: p.error, closureRequired: p.closureRequired, closureConfirmedAt: p.closureConfirmedAt, boardVersion: p.boardVersion, showsOldVersion: view.showsOldVersion },
    package: kind === "take_down_job" ? null : view.package,
    steps: kind === "post_job" ? p.steps : [],
    applyUrl: view.link?.url ?? null,
    boardAccessConfirmed,
    whatToDo: boardAccessConfirmed ? whatToDo : `${whatToDo} ITS has not confirmed it can sign in to ${company}'s job-board accounts yet; sort that out with them first.`,
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
    const row = await recordBoardAddress(tx, container, { posting, url: body.url, actor });
    return describeOne(tx, container, role, row.id);
  });
  await container.kick();
  return c.json(result);
});

/**
 * Records a board listing's public address and queues its check (item 13). Shared by the Posting tab and the ITS
 * queue's posting task (plan D3); the caller has checked who may do it and kicks the worker after the commit.
 */
export async function recordBoardAddress(tx: Tx, container: Container, input: { posting: PostingRow; url: string; actor: Actor }): Promise<PostingRow> {
  const { posting, url, actor } = input;
  const now = container.engine.clock();
  const patch: PostingPatch = { ...UNVERIFIED, externalUrl: url, publicUrlRecordedAt: now.toISOString() };
  let row: PostingRow;
  if (posting.status === "posted_manually") {
    // a corrected address while the first check is still pending: the state stays, the checks start over
    [row] = await tx.update(postings).set(patch).where(eq(postings.id, posting.id)).returning();
    await emit(tx, { type: "posting.posted_manually", companyId: posting.companyId, actor, subject: { type: "posting", id: row.id }, payload: { channel: posting.channel, roleId: posting.roleId, from: "posted_manually", to: "posted_manually", url, corrected: true } });
  } else {
    row = (await move(tx, { postingId: posting.id, to: "posted_manually", actor, now, patch })).row;
  }
  await queueCheck(tx, container, row.id, posting.companyId);
  await auditPosting(tx, posting.companyId, actor, row, "public URL recorded", { url });
  return row;
}

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
    const posting = await loadPosting(tx, role.id, channel);
    const row = await confirmPostingByHand(tx, container, { posting, note: body.note, actor });
    return describeOne(tx, container, role, row.id);
  });
  return c.json(result);
});

/** A person's "I checked it myself", shared by the Posting tab and the ITS queue's posting task. A board's ITS task settles with it. */
export async function confirmPostingByHand(tx: Tx, container: Container, input: { posting: PostingRow; note: string; actor: Actor }): Promise<PostingRow> {
  const { actor, note } = input;
  let posting = input.posting;
  const channel = posting.channel;
  if (isBoardChannel(channel) && !posting.externalUrl) throw new HttpError(409, "url_required", "Record the public address of the posting first, then confirm you checked it.");
  const now = container.engine.clock();
  if (posting.status === "failed") {
    // a failed automatic check does not stop a person: back to posted (or submitted) with the same address, then verified
    posting = (await move(tx, { postingId: posting.id, to: channel === "google_jobs" ? "submitted_integration" : "posted_manually", actor, now, patch: { error: null }, reason: "a person is confirming the posting" })).row;
  }
  const moved = await move(tx, { postingId: posting.id, to: "live_verified", actor, now, patch: { verificationNote: note, verificationError: null, verificationAttempts: 0, error: null }, payload: { check: "person" } });
  await auditPosting(tx, posting.companyId, actor, moved.row, "verified by a person", { note, from: moved.from });
  return moved.row;
}

/** Queues a fresh check of a posting's address (exported for the ITS queue's posting task). */
export async function queuePostingCheck(tx: Tx, container: Container, posting: PostingRow): Promise<void> {
  await queueCheck(tx, container, posting.id, posting.companyId, { requested: true });
}

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
    // The ITS take-down task, when there is one, settles with it (packages/core/src/postings.ts).
    const row = await confirmBoardRemoved(tx, { posting, actor, now: container.engine.clock() });
    await auditPosting(tx, t.companyId, actor, row, "removed from the board, confirmed by a person");
    return describeOne(tx, container, role, row.id);
  });
  return c.json(result);
});

/**
 * "The board shows the new version now" (plan D4): after an approved edit, a board posted by hand still showed the
 * earlier version; a person updated it and says so. The ITS update task settles, and the address is checked again,
 * since the title may have changed.
 */
postingRoutes.post("/:id/postings/:channel/updated", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const channel = channelParam(c);
  if (!isBoardChannel(channel)) throw new HttpError(409, "not_a_board", `${CHANNEL_NAME[channel]} shows the job page itself, so it is always up to date.`);
  const body = ConfirmBoardUpdated.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    const posting = await loadPosting(tx, role.id, channel);
    if (!showsOldVersion(posting, role.currentPacketVersion)) throw new HttpError(409, "up_to_date", `${CHANNEL_NAME[channel]} does not show an earlier version of the job, so there is nothing to update.`);
    const row = await confirmBoardUpdated(tx, { posting, version: role.currentPacketVersion!, actor, note: body.note ?? null, now: container.engine.clock() });
    if (row.externalUrl && ["posted_manually", "live_verified"].includes(row.status)) await queueCheck(tx, container, row.id, t.companyId, { requested: true });
    await auditPosting(tx, t.companyId, actor, row, "brought up to date with the approved version", { version: role.currentPacketVersion, note: body.note ?? null });
    return describeOne(tx, container, role, row.id);
  });
  await container.kick();
  return c.json(result);
});

/**
 * "Prepare this board" (plan D6): ticks a board for an open role and prepares it, with its package, its own tracked
 * link and, when ITS posts for the company, an ITS posting task. A board a person closed while the role stayed open
 * comes back only this way; one still waiting to be taken down from its earlier listing does not.
 */
postingRoutes.post("/:id/postings/:channel/prepare", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const channel = channelParam(c);
  if (!isBoardChannel(channel)) throw new HttpError(409, "not_a_board", `${CHANNEL_NAME[channel]} is part of every open role; there is nothing to prepare.`);
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    if (role.status !== "open") throw new HttpError(409, "not_open", "Boards are prepared for an open role. Approve the role first; the ticked boards are prepared then.");
    const [company] = await tx.select({ settings: companies.settings }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
    if (channel === "ziprecruiter" && !zipRecruiterOffered(company?.settings)) throw new HttpError(409, "ziprecruiter_needs_plan", "ZipRecruiter needs your company's own paid ZipRecruiter plan. Say you have one in Settings first.");
    const [existing] = await tx.select().from(postings).where(and(eq(postings.roleId, role.id), eq(postings.channel, channel))).limit(1);
    if (existing && existing.status !== "closed") throw new HttpError(409, "already_prepared", `${CHANNEL_NAME[channel]} is already prepared for this role ("${stateLabel(existing.status)}").`);
    if (existing?.closureRequired && !existing.closureConfirmedAt) throw new HttpError(409, "still_up", `The earlier ${CHANNEL_NAME[channel]} listing still has to be taken down. Confirm it was removed, then prepare the board again.`);
    const [pv] = role.currentPacketVersion ? await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, role.currentPacketVersion))).limit(1) : [];
    const current = pv ? chosenBoards(role, pv.packet, company?.settings) : [];
    const ticked = [...new Set<string>([...current, channel])];
    await tx.update(roles).set({ publishChannels: BOARD_CHANNELS.filter((b) => ticked.includes(b)) }).where(eq(roles.id, role.id));
    await emit(tx, { type: "role.boards_chosen", companyId: t.companyId, actor, subject: { type: "role", id: role.id }, payload: { channels: ticked, before: current, prepared: channel } });
    await container.engine.start(tx, { workflowKey: "publish_role", companyId: t.companyId, subject: { type: "role", id: role.id }, state: { roleId: role.id, packetVersion: role.currentPacketVersion, prepare: [channel] }, actor });
    await audit(tx, { companyId: t.companyId, actor, action: "posting.changed", target: { type: "role", id: role.id }, reason: `prepare ${channel}`, details: { channel, roleId: role.id } });
    return { ok: true };
  });
  await container.kick();
  const out = await withTenant(container.db, t.companyId, async (tx) => describePostings(tx, container, await loadRole(tx, c.req.param("id"))));
  return c.json({ ...result, ...out });
});

/**
 * "Ask ITS again" (plan D3): a board whose ITS task was closed as not possible, or that has none, gets a fresh task of
 * the kind its posting needs now (post it, bring it up to date, take it down), and the ITS queue is told. Only while
 * ITS posts for the company; asking while a task is already waiting changes nothing (`created: false`).
 */
postingRoutes.post("/:id/postings/:channel/ask-its", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const channel = channelParam(c);
  if (!isBoardChannel(channel)) throw new HttpError(409, "not_a_board", `${CHANNEL_NAME[channel]} shows the job page itself, so there is nothing for ITS to post there.`);
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    const posting = await loadPosting(tx, role.id, channel);
    const [company] = await tx.select({ name: companies.name, vertical: companies.vertical, settings: companies.settings }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
    if (boardPostingOf(company?.settings) !== "its") throw new HttpError(409, "team_posts", "Your team posts on the job boards itself (Settings, Job boards), so there is no ITS task to ask for.");
    const kind = postingTaskNeeded(posting, role);
    if (!kind) throw new HttpError(409, "nothing_to_do", `${CHANNEL_NAME[channel]} needs nothing from ITS right now (it is "${stateLabel(posting.status)}").`);
    const now = container.engine.clock();
    const task = await openPostingTask(tx, { companyId: t.companyId, roleId: role.id, postingId: posting.id, channel, board: CHANNEL_NAME[channel], kind, roleTitle: role.title, companyName: company?.name ?? "", vertical: company?.vertical ?? null, actor, now });
    if (task.created) {
      await tellItsQueueAboutTasks(tx, container, { companyId: t.companyId, companyName: company?.name ?? "A customer", tasks: [{ roleTitle: role.title, board: CHANNEL_NAME[channel], kind }], key: `asked_again:${task.id}`, actor, now });
      await auditPosting(tx, t.companyId, actor, posting, "asked ITS again", { kind });
    }
    return { created: task.created, kind, posting: await describeOne(tx, container, role, posting.id) };
  });
  await container.kick();
  return c.json(result, result.created ? 201 : 200);
});

/**
 * The boards a role uses (founder decision Q11, plan D6): the ticks, before or after approval. The careers page,
 * Google and email are part of every role. On an open role a newly ticked board is prepared; an unticked board's
 * posting closes, and a listing that was up is named for taking down (by ITS, when ITS posts for the company).
 * ZipRecruiter only with the company's own plan (409 `ziprecruiter_needs_plan`).
 */
postingRoutes.post("/:id/channels", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const body = SetPublishChannels.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    if (role.status === "closed") throw new HttpError(409, "role_closed", "The role is closed; its boards no longer change.");
    const [company] = await tx.select({ settings: companies.settings }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
    const wanted = BOARD_CHANNELS.filter((b) => body.channels.includes(b));
    if (wanted.includes("ziprecruiter") && !zipRecruiterOffered(company?.settings)) throw new HttpError(409, "ziprecruiter_needs_plan", "ZipRecruiter needs your company's own paid ZipRecruiter plan. Say you have one in Settings first.");
    const packets = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id));
    const packet = currentVersionOf(role, packets)?.packet ?? null;
    const before: string[] = packet ? chosenBoards(role, packet, company?.settings) : (role.publishChannels ?? []);
    await tx.update(roles).set({ publishChannels: wanted }).where(eq(roles.id, role.id));
    await emit(tx, { type: "role.boards_chosen", companyId: t.companyId, actor, subject: { type: "role", id: role.id }, payload: { channels: wanted, before } });
    await audit(tx, { companyId: t.companyId, actor, action: "role.boards_chosen", target: { type: "role", id: role.id }, reason: wanted.length ? wanted.join(", ") : "no boards", details: { channels: wanted, before } });
    if (role.status !== "open" && role.status !== "paused") return;
    const now = container.engine.clock();
    for (const channel of before.filter((b) => !wanted.includes(b as BoardChannel))) {
      const [p] = await tx.select().from(postings).where(and(eq(postings.roleId, role.id), eq(postings.channel, channel))).limit(1);
      if (!p || p.status === "closed") continue;
      const stillUp = BOARD_UP_STATES.includes(p.status as PostingState);
      const moved = await move(tx, { postingId: p.id, to: "closed", actor, now, reason: "board unticked", patch: stillUp ? { closureRequired: true } : {} });
      if (stillUp) await emit(tx, { type: "posting.closure_required", companyId: t.companyId, actor, subject: { type: "posting", id: p.id }, payload: { channel, roleId: role.id, url: p.externalUrl } });
      await auditPosting(tx, t.companyId, actor, moved.row, "board unticked", { from: moved.from, closureRequired: stillUp });
    }
    const added = wanted.filter((b) => !before.includes(b));
    if (added.length && role.status === "open") await container.engine.start(tx, { workflowKey: "publish_role", companyId: t.companyId, subject: { type: "role", id: role.id }, state: { roleId: role.id, packetVersion: role.currentPacketVersion, prepare: added }, actor });
  });
  await container.kick();
  const out = await withTenant(container.db, t.companyId, async (tx) => describePostings(tx, container, await loadRole(tx, c.req.param("id"))));
  return c.json(out);
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

/**
 * One-tap sharing (plan D8): a ready-made place (a referral, a school, a community group, or a share button) gets its
 * own tracked link with no form, the same link on every tap, opening the job page first. Answers the link, the text
 * the share starts with, and the share buttons' addresses (no third-party script runs on our pages). Open to those who
 * manage postings and to those who approve roles, so whoever approved the job can share it straight away.
 */
postingRoutes.post("/:id/share-links", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  if (!can(t.role, "role.approve")) assertCan(t.role, "role.manage");
  const body = CreateShareLink.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const out = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    if (role.status === "closed") throw new HttpError(409, "role_closed", "The role is closed; a new link would lead nowhere.");
    const ctx = await postingContext(tx, container, role);
    let link = sharePlaceLink(ctx.links, body.place);
    let created = false;
    if (!link) {
      const place = SHARE_PLACES[body.place];
      link = await createApplicationLink(tx, { companyId: t.companyId, roleId: role.id, source: place.source, label: place.label, landing: "job", actor, now: container.engine.clock() });
      await audit(tx, { companyId: t.companyId, actor, action: "application_link.changed", target: { type: "application_link", id: link.id }, reason: "created for sharing", details: { roleId: role.id, source: link.source, label: link.label, place: body.place } });
      created = true;
    }
    const url = ctx.linkUrl(link);
    const text = ctx.packet ? shareText(ctx.packet, ctx.company?.name ?? "", url) : url;
    return { created, link: linkView(container, link), text, targets: shareTargets({ url, text, subject: `${ctx.company?.name ?? "We"} ${ctx.company?.name ? "is" : "are"} hiring: ${role.title}` }) };
  });
  return c.json(out, out.created ? 201 : 200);
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
 * the same way the daily volume alert cuts them. Counting only: nothing here touches an application. The counts follow
 * the role page's (GET /roles/:id): none for those who do not read applications (an interviewer), and a grant about one
 * candidate counts that candidate alone. The switch's state and the alert threshold are the role's own, for everyone.
 */
postingRoutes.get("/:id/volume", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const container = c.get("container");
  const readsApplications = can(t.role, "application.read");
  const onlyApplicationId = t.staff?.scope.applicationId ?? null;
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
    const local = localDays(container.engine.clock(), company?.timezone);
    const windowStart = local.start(-(VOLUME_WINDOW_DAYS - 1));
    const inWindow = and(eq(applications.roleId, role.id), gte(applications.createdAt, windowStart.toISOString()));
    const rows = !readsApplications ? [] : await tx.select({ createdAt: applications.createdAt, source: applications.source }).from(applications).where(onlyApplicationId ? and(inWindow, eq(applications.id, onlyApplicationId)) : inWindow);
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
  // The reason "closing date" marks a stop the closing date made (plan D7): only that stop lets a form opened earlier
  // finish and is undone by a later date. A person's own stop never carries it, so it takes nothing new.
  if (!body.accepting && body.reason?.trim().toLowerCase() === CLOSING_DATE_REASON) throw new HttpError(400, "reserved_reason", "That reason is kept for stops made by the closing date. Say it another way, for example \"We have enough applicants\", or set a closing date on the Share tab instead.");
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const role = await loadRole(tx, c.req.param("id"));
    if (role.status === "closed") throw new HttpError(409, "role_closed", "The role is closed, so it is not taking applications.");
    const pick = (r: RoleRow) => ({ id: r.id, acceptingApplications: r.acceptingApplications, applicationsClosedAt: r.applicationsClosedAt, applicationsClosedReason: r.applicationsClosedReason });
    if (role.acceptingApplications === body.accepting) return { ok: true, changed: false, role: pick(role) };
    // Turning applications back on is new work once a trial has ended (founder decision L-02 B): it waits for a plan. Turning them off never does.
    if (body.accepting) await assertNoNewWork(tx, t.companyId, container.engine.clock());
    // A closing date that has passed would stop them again at once and tell candidates a date in the past (plan D7).
    if (body.accepting && role.applicationsCloseOn) {
      const [co] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
      if (closingMoment(role.applicationsCloseOn, co?.timezone).getTime() <= container.engine.clock().getTime()) throw new HttpError(409, "closing_date_passed", "The closing date has passed. Choose a later closing date to take applications again.");
    }
    const now = container.engine.clock().toISOString();
    const [updated] = await tx.update(roles).set({ acceptingApplications: body.accepting, applicationsClosedAt: body.accepting ? null : now, applicationsClosedReason: body.accepting ? null : body.reason ?? null }).where(eq(roles.id, role.id)).returning();
    await emit(tx, { type: body.accepting ? "role.applications_reopened" : "role.applications_closed", companyId: t.companyId, actor, subject: { type: "role", id: role.id }, payload: { reason: body.reason ?? null } });
    const who = actor.name ?? "A team member";
    await notify(tx, {
      companyId: t.companyId,
      kind: body.accepting ? "applications.reopened" : "applications.closed",
      title: body.accepting ? `${role.title} is taking applications again` : `${role.title} stopped taking new applications`,
      body: body.accepting ? `${who} reopened applications. The job page shows the apply button again.` : `${who} closed applications${body.reason ? ` (${body.reason})` : ""}. The job page stays up and says applications are closed. Everyone who already applied stays exactly where they are.`,
      action: { label: "Open the Share tab", href: `/roles/${role.id}?tab=posting` },
    });
    await audit(tx, { companyId: t.companyId, actor, action: "role.applications_toggled", target: { type: "role", id: role.id }, reason: body.reason ?? (body.accepting ? "reopened" : "closed"), details: { accepting: body.accepting } });
    return { ok: true, changed: true, role: pick(updated) };
  });
  // Applications that arrived by email while the switch was off were held (C19); reopening adds them to the role.
  if (result.changed && body.accepting) await replayHeldEmails(container, { companyId: t.companyId, roleId: result.role.id });
  return c.json(result);
});
