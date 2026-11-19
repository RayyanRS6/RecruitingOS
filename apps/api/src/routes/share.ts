import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { EditPost, PostChannel, SHARE_LINE, type ShareView } from "@ros/contracts";
import { assertCan } from "@ros/core";
import { roles, withTenant, type Tx } from "@ros/db";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import { requireTenant, type Vars } from "../middleware/session";
import { requestRewrite, savePost, shareView } from "../services/share";
import { jobId } from "./roles";

/**
 * A job's Share tab (services/share.ts): the Apply link and the LinkedIn and Indeed posts. Anyone on the team reads it;
 * whoever may edit the job may put their own words in a post or ask for it to be written again.
 */
export const shareRoutes = new Hono<Vars>();

const NOT_FOUND = () => new HttpError(404, "not_found", "Job not found.");

function channelOf(value: string | undefined): PostChannel {
  const channel = PostChannel.safeParse(value);
  if (!channel.success) throw new HttpError(404, "not_found", "There is no such post.");
  return channel.data;
}

async function viewOf(tx: Tx, container: Container, roleId: string): Promise<ShareView> {
  const view = await shareView(tx, container.env, roleId);
  if (!view) throw NOT_FOUND();
  return view;
}

/** The job whose post is changed, its row locked. A job that is not public has nothing to share: 409 with the tab's own line. */
async function publicJob(tx: Tx, roleId: string) {
  const [role] = await tx.select({ id: roles.id, companyId: roles.companyId, status: roles.status, posts: roles.posts }).from(roles).where(eq(roles.id, roleId)).limit(1).for("update");
  if (!role) throw NOT_FOUND();
  if (role.status === "closed") throw new HttpError(409, "role_closed", SHARE_LINE.closed);
  if (role.status !== "open" && role.status !== "paused") throw new HttpError(409, "not_published", SHARE_LINE.draft);
  return role;
}

shareRoutes.get("/:id/share", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const id = jobId(c.req.param("id"));
  const container = c.get("container");
  return c.json(await withTenant(container.db, t.companyId, (tx) => viewOf(tx, container, id)));
});

/** A person's own words for one post. They stay until that post's own "Write again". */
shareRoutes.put("/:id/share/:channel", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "packet.edit");
  const id = jobId(c.req.param("id"));
  const channel = channelOf(c.req.param("channel"));
  const body = EditPost.parse(await c.req.json());
  const container = c.get("container");
  const view = await withTenant(container.db, t.companyId, async (tx) => {
    await savePost(tx, { role: await publicJob(tx, id), channel, text: body.text, now: container.engine.clock() });
    return viewOf(tx, container, id);
  });
  return c.json(view);
});

/**
 * "Write again" on one post: the writing is queued and the answer says so at once (202, `state: "writing"`), or says
 * the plan's AI help is used up (`no_ai`). It replaces that post, a person's own words included.
 */
shareRoutes.post("/:id/share/:channel/rewrite", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "packet.edit");
  const id = jobId(c.req.param("id"));
  const channel = channelOf(c.req.param("channel"));
  const container = c.get("container");
  const view = await withTenant(container.db, t.companyId, async (tx) => {
    await requestRewrite(tx, container.engine, { role: await publicJob(tx, id), channel, now: container.engine.clock() });
    return viewOf(tx, container, id);
  });
  await container.kick();
  return c.json(view, 202);
});
