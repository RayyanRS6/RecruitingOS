import { and, eq } from "drizzle-orm";
import { jobPostsPrompt, outOfCredit, runPromptDetached, type AiRuntime, type JobPostsInput } from "@ros/ai";
import { EMPLOYMENT_TYPE_LABEL, POST_CHANNEL_LABEL, POST_TEXT_MAX, PostChannel, REMOTE_POLICY_LABEL, RolePacket as RolePacketSchema, RolePosts, SHARE_LINE, applyLinkFor, formatPayRange, type JobPosts, type RolePacket, type ShareView } from "@ros/contracts";
import { aiCreditRoomSoon, aiCreditStanding, benefitsDescriptionFor, jobNoticesFor, payShown, wordingProblems } from "@ros/core";
import { companies, rolePackets, roles, withTenant, type Db, type Tx } from "@ros/db";
import type { WorkflowEngine } from "@ros/workflows";
import type { Env } from "../env";
import { jobUrls } from "./job-urls";

/**
 * A job's Share tab: the Apply link, and the LinkedIn post and the Indeed listing the AI stage `job.posts` writes from
 * the job's public facts. The company copies them and posts them itself; nothing here reaches LinkedIn or Indeed.
 *
 * The posts are written by a queued job, never inside a request: when the job is published, when a saved edit changes
 * what the job page says, and when a person presses "Write again" on one post. A post a person edited is theirs: only
 * that post's own "Write again" replaces it. What the model wrote is finished by rule before it is stored: a line the
 * fairness guard would flag in a job description is taken out, and each post carries the pay the job page shows and its
 * own Apply link (`finishPost`).
 */

export const POSTS_JOB_KIND = "job.write_posts";
/** A writing that fails is tried again 2, 4 and 8 seconds later; then the Share tab says it could not be written. */
const POSTS_TRIES = 4;

type RoleRow = typeof roles.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;
type JobFacts = Omit<JobPostsInput, "applyLinks">;

/** The posts as stored on the job; null on a job never published, or when what is stored cannot be read. */
function storedPosts(role: Pick<RoleRow, "posts">): RolePosts | null {
  const posts = RolePosts.safeParse(role.posts);
  return posts.success ? posts.data : null;
}

/** GET /roles/:id/share. Null when the job is not this company's. */
export async function shareView(tx: Tx, env: Pick<Env, "JOBS_BASE_URL">, roleId: string): Promise<ShareView | null> {
  const [role] = await tx.select({ id: roles.id, companyId: roles.companyId, status: roles.status, posts: roles.posts }).from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role) return null;
  const [company] = await tx.select({ slug: companies.slug }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
  const jobUrl = jobUrls(env, { slug: company?.slug ?? "", roleId: role.id }).job;
  const isPublic = role.status === "open" || role.status === "paused";
  const posts = storedPosts(role);
  const state = posts?.state ?? null;
  return {
    roleId: role.id,
    jobUrl,
    public: isPublic,
    notPublicLine: isPublic ? null : role.status === "closed" ? SHARE_LINE.closed : SHARE_LINE.draft,
    state,
    stateLine: state === "no_ai" ? SHARE_LINE.noAi : state === "failed" ? SHARE_LINE.failed : null,
    posts: PostChannel.options.map((channel) => ({
      channel,
      label: POST_CHANNEL_LABEL[channel],
      text: posts?.[channel]?.text ?? null,
      edited: posts?.[channel]?.edited ?? false,
      writtenAt: posts?.[channel]?.writtenAt ?? null,
      applyUrl: applyLinkFor(jobUrl, channel),
    })),
  };
}

/**
 * Marks the posts as being written and queues the writing, inside the caller's transaction: it starts once that commits,
 * so the request that asked never waits for the model and never fails with it. `only`: one post's own "Write again".
 */
export async function queuePosts(tx: Tx, engine: WorkflowEngine, role: Pick<RoleRow, "id" | "companyId" | "posts">, only?: PostChannel): Promise<void> {
  const posts = storedPosts(role);
  await tx.update(roles).set({ posts: { linkedin: posts?.linkedin ?? null, indeed: posts?.indeed ?? null, version: posts?.version ?? null, state: "writing" } }).where(eq(roles.id, role.id));
  await engine.enqueue(tx, { kind: POSTS_JOB_KIND, payload: { companyId: role.companyId, roleId: role.id, ...(only ? { only } : {}) }, maxAttempts: POSTS_TRIES });
}

/** The parts of a job its job page shows, which the posts are written from. */
function publicParts(packet: RolePacket) {
  const { identity, compensation, description, requirements } = packet;
  return {
    title: identity.title,
    locations: identity.locations,
    remotePolicy: identity.remotePolicy,
    employmentType: identity.employmentType,
    schedule: identity.schedule?.trim() || null,
    pay: { basis: compensation.basis, min: compensation.min, max: compensation.max, shown: compensation.discloseRange },
    benefits: compensation.benefitsSummary?.trim() || null,
    description: description.publicJobDescription,
    mustHaves: requirements.mustHaves.map((m) => m.text),
  };
}

/**
 * After a saved edit went live: when what the job page says changed, the posts nobody edited are written again. A job
 * whose two posts are both a person's own words has nothing to write.
 */
export async function rewritePostsAfterEdit(tx: Tx, engine: WorkflowEngine, input: { role: Pick<RoleRow, "id" | "companyId" | "posts">; before: unknown; after: RolePacket }): Promise<void> {
  const before = RolePacketSchema.safeParse(input.before);
  if (before.success && JSON.stringify(publicParts(before.data)) === JSON.stringify(publicParts(input.after))) return;
  const posts = storedPosts(input.role);
  if (posts && PostChannel.options.every((channel) => posts[channel]?.edited)) return;
  await queuePosts(tx, engine, input.role);
}

/** PUT /roles/:id/share/:channel: a person's own words for one post, kept from every automatic rewrite. */
export async function savePost(tx: Tx, input: { role: Pick<RoleRow, "id" | "posts">; channel: PostChannel; text: string; now: Date }): Promise<void> {
  const posts = storedPosts(input.role) ?? { linkedin: null, indeed: null, state: "ready" as const, version: null };
  await tx.update(roles).set({ posts: { ...posts, [input.channel]: { text: input.text, edited: true, writtenAt: input.now.toISOString() } } }).where(eq(roles.id, input.role.id));
}

/**
 * POST /roles/:id/share/:channel/rewrite, "Write again" on one post: queued, unless the plan's AI help is already used
 * up, which the Share tab then says at once.
 */
export async function requestRewrite(tx: Tx, engine: WorkflowEngine, input: { role: Pick<RoleRow, "id" | "companyId" | "posts">; channel: PostChannel; now: Date }): Promise<void> {
  if ((await aiCreditStanding(tx, input.role.companyId, { now: input.now, settled: true }))?.usedUp) {
    const posts = storedPosts(input.role) ?? { linkedin: null, indeed: null, version: null };
    await tx.update(roles).set({ posts: { ...posts, state: "no_ai" } }).where(eq(roles.id, input.role.id));
    return;
  }
  await queuePosts(tx, engine, input.role, input.channel);
}

/** A job's public facts in the job page's own words, as the model is given them. */
function jobFacts(packet: RolePacket, company: Pick<CompanyRow, "name" | "locations" | "settings">): JobFacts {
  const parts = publicParts(packet);
  const notices = jobNoticesFor({ jobLocations: parts.locations, companyLocations: company.locations, overrides: company.settings.notices });
  return {
    companyName: company.name,
    title: parts.title,
    places: [...new Set(parts.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).filter(Boolean))],
    workArrangement: REMOTE_POLICY_LABEL[parts.remotePolicy],
    employmentType: EMPLOYMENT_TYPE_LABEL[parts.employmentType],
    schedule: parts.schedule,
    pay: payShown(packet.compensation, notices) ? formatPayRange(packet.compensation) : null,
    benefits: benefitsDescriptionFor(packet.compensation, company.settings),
    description: parts.description,
    mustHaves: parts.mustHaves,
  };
}

/** The same figure however it is written: "$45", "$45.00", "$90,000" and "$90k" all count. */
const amountsIn = (text: string): number[] => [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi)].map((m) => Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1));

/**
 * One post as it is stored, whatever the model wrote: every address of the job page in it is this post's own Apply
 * link, no line is left that the fairness guard would flag in a job description, and the pay the job page shows and the
 * Apply link are added at the end when the text lacks them.
 */
export function finishPost(text: string, input: { packet: RolePacket; facts: Pick<JobFacts, "pay" | "benefits">; jobUrl: string; channel: PostChannel }): string {
  const { packet, facts, jobUrl } = input;
  const applyLink = applyLinkFor(jobUrl, input.channel);
  const linked = text.split(jobUrl).map((part, i) => (i === 0 ? part : part.replace(/^[?&]src=[A-Za-z0-9-]*/, ""))).join(applyLink);
  const guarded = { compensation: packet.compensation, benefits: facts.benefits, provenance: packet.provenance };
  const kept = linked.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => wordingProblems(line, guarded).length === 0).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const said = amountsIn(kept);
  const lacksPay = !!facts.pay && ![packet.compensation.min, packet.compensation.max].every((amount) => said.includes(amount));
  const added = [lacksPay ? `Pay: ${facts.pay}` : null, kept.includes(applyLink) ? null : `Apply: ${applyLink}`].filter((line): line is string => !!line).join("\n");
  if (!added) return kept;
  // What is added always fits: the model's words give way to it at the stored length.
  return `${kept.slice(0, POST_TEXT_MAX - added.length - 2).trimEnd()}\n\n${added}`;
}

type PostsDeps = { db: Db; ai: AiRuntime; env: Pick<Env, "JOBS_BASE_URL"> };
type Asked = { companyId: string; roleId: string; only?: PostChannel };
type Written = { state: "no_ai" | "failed" } | { state: "ready"; posts: JobPosts; version: number; at: string };

/**
 * Stores how a writing ended, with the job's row locked. A person's own words stay: an automatic writing replaces only
 * the posts nobody edited; one post's "Write again" replaces that post, and the other only when it has no words yet.
 */
async function storeWritten(db: Db, asked: Asked, written: Written): Promise<void> {
  await withTenant(db, asked.companyId, async (tx) => {
    const [role] = await tx.select({ id: roles.id, posts: roles.posts }).from(roles).where(eq(roles.id, asked.roleId)).limit(1).for("update");
    if (!role) return;
    const had = storedPosts(role) ?? { linkedin: null, indeed: null, version: null };
    if (written.state !== "ready") {
      await tx.update(roles).set({ posts: { ...had, state: written.state } }).where(eq(roles.id, role.id));
      return;
    }
    const next: RolePosts = { ...had, state: "ready", version: written.version };
    for (const channel of PostChannel.options) {
      const mayWrite = asked.only ? channel === asked.only || !had[channel] : !had[channel]?.edited;
      if (mayWrite) next[channel] = { text: written.posts[channel], edited: false, writtenAt: written.at };
    }
    await tx.update(roles).set({ posts: next }).where(eq(roles.id, role.id));
  });
}

/**
 * The queued writing: reads the job as it stands now, asks the model once for both posts, finishes them by rule and
 * stores them. With no AI credit left the tab says so (`no_ai`), unless the credit is only held by calls still running,
 * which is tried again. A failure is tried again until `lastTry`, then stored as `failed`.
 */
async function writePosts(deps: PostsDeps, asked: Asked, ctx: { lastTry: boolean; now: Date }): Promise<void> {
  const job = await withTenant(deps.db, asked.companyId, async (tx) => {
    const [role] = await tx.select({ id: roles.id, version: roles.currentPacketVersion }).from(roles).where(eq(roles.id, asked.roleId)).limit(1);
    if (!role || role.version === null) return null;
    const [stored] = await tx.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, role.version))).limit(1);
    const [company] = await tx.select({ name: companies.name, slug: companies.slug, locations: companies.locations, settings: companies.settings }).from(companies).where(eq(companies.id, asked.companyId)).limit(1);
    const packet = RolePacketSchema.safeParse(stored?.packet);
    return packet.success && company ? { packet: packet.data, company, version: role.version } : null;
  });
  if (!job) return storeWritten(deps.db, asked, { state: "failed" });
  const jobUrl = jobUrls(deps.env, { slug: job.company.slug, roleId: asked.roleId }).job;
  const applyLinks = { linkedin: applyLinkFor(jobUrl, "linkedin"), indeed: applyLinkFor(jobUrl, "indeed") };
  const facts = jobFacts(job.packet, job.company);
  const out = await runPromptDetached(deps.db, deps.ai, jobPostsPrompt, { ...facts, applyLinks }, { companyId: asked.companyId, inputRef: { roleId: asked.roleId, version: job.version } });
  if (outOfCredit(out)) {
    const heldOnly = !ctx.lastTry && (await withTenant(deps.db, asked.companyId, (tx) => aiCreditRoomSoon(tx, { companyId: asked.companyId, holdUsd: out.refusedHoldUsd, now: ctx.now })));
    if (heldOnly) throw new Error("the AI credit is held by calls still running, so the posts are tried again");
    return storeWritten(deps.db, asked, { state: "no_ai" });
  }
  if (!out.ok) {
    if (!ctx.lastTry) throw new Error(`the posts were not written (${out.reason}): ${out.error}`);
    return storeWritten(deps.db, asked, { state: "failed" });
  }
  const finish = (channel: PostChannel) => finishPost(out.output[channel], { packet: job.packet, facts, jobUrl, channel });
  await storeWritten(deps.db, asked, { state: "ready", posts: { linkedin: finish("linkedin"), indeed: finish("indeed") }, version: job.version, at: ctx.now.toISOString() });
}

/** Registered in every process, so the web process can queue the writing and the worker runs it. */
export function registerPostsJob(engine: WorkflowEngine, deps: PostsDeps): void {
  engine.registerJob(POSTS_JOB_KIND, async (payload, ctx) => {
    const companyId = typeof payload.companyId === "string" ? payload.companyId : "";
    const roleId = typeof payload.roleId === "string" ? payload.roleId : "";
    const only = PostChannel.safeParse(payload.only);
    if (!companyId || !roleId) return;
    await writePosts(deps, { companyId, roleId, ...(only.success ? { only: only.data } : {}) }, { lastTry: ctx.attempt >= ctx.maxAttempts, now: ctx.now });
  });
}
