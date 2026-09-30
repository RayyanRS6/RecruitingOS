import { honoHandler } from "../../../lib/hono";

/**
 * The stand-in for the object store when storage is local or in memory (development, previews, the browser journeys):
 * the apply form's direct upload goes to `/files/put/<grant>`. With the real store Hono answers 404 here, because no
 * grant is ever issued for these paths (apps/api/src/routes/files.ts).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Seconds a request may run on Vercel; kept in step with the other mounted routes. */
export const maxDuration = 60;

export const GET = honoHandler;
export const POST = honoHandler;
export const PUT = honoHandler;
export const PATCH = honoHandler;
export const DELETE = honoHandler;
export const OPTIONS = honoHandler;
export const HEAD = honoHandler;
