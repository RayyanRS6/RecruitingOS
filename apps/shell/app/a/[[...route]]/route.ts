import { honoHandler } from "../../../lib/hono";

/**
 * Tracked application links (docs/spec/20 items 7, 8 and 19): `/a/<token>` counts the visit, seals the source into a
 * cookie and redirects to the apply page. Every board's posting package and every referral link points here, so the
 * shell must hand it to Hono like the other candidate surfaces.
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
