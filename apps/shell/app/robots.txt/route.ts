import { honoHandler } from "../../lib/hono";

/** robots.txt, pointing crawlers at the sitemap (docs/spec/20 item 5), built by Hono (apps/api/src/pages/public-feeds.ts). */
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
