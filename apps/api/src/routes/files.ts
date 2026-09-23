import { Hono } from "hono";
import { MAX_RESUME_BYTES } from "@ros/contracts";
import type { GrantSigner } from "@ros/integrations";
import type { Vars } from "../middleware/session";
import { safeFilename } from "../uploads";

/**
 * The stand-in for the object store when storage is local or in memory (development, tests, CI): the same browser
 * flow, the same single-object grants, served by the application itself. With the real store these routes answer 404
 * because no grant is ever issued for them. A grant names one key, one method, one content type and an expiry.
 */
export const fileRoutes = new Hono<Vars>();

function grantsOf(c: { get(k: "container"): { integrations: { storage: unknown } } }): GrantSigner | null {
  const storage = c.get("container").integrations.storage as { grants?: GrantSigner };
  return storage.grants ?? null;
}

fileRoutes.put("/put/:token", async (c) => {
  const grants = grantsOf(c);
  const grant = grants?.verify(c.req.param("token"));
  if (!grants || !grant || grant.m !== "PUT") return c.json({ error: { code: "forbidden", message: "This upload authorization is not valid or has expired." } }, 403);
  const contentType = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== grant.ct) return c.json({ error: { code: "unsupported_media_type", message: "The file type does not match the authorization." } }, 415);
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_RESUME_BYTES) return c.json({ error: { code: "too_large", message: "Resume files must be under 8 MB." } }, 413);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength === 0) return c.json({ error: { code: "empty", message: "The file is empty." } }, 400);
  if (bytes.byteLength > MAX_RESUME_BYTES) return c.json({ error: { code: "too_large", message: "Resume files must be under 8 MB." } }, 413);
  await c.get("container").integrations.storage.put(grant.k, bytes, grant.ct);
  return c.body(null, 200);
});

fileRoutes.get("/get/:token", async (c) => {
  const grants = grantsOf(c);
  const grant = grants?.verify(c.req.param("token"));
  if (!grants || !grant || grant.m !== "GET") return c.text("This download link is not valid or has expired.", 403);
  const bytes = await c.get("container").integrations.storage.get(grant.k);
  if (!bytes) return c.text("Not found.", 404);
  return new Response(bytes.slice().buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "content-type": grant.ct,
      "content-disposition": `attachment; filename="${safeFilename(grant.fn ?? "resume")}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
