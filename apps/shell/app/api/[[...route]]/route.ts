import { honoHandler } from "../../../lib/hono";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Seconds a request may run on Vercel. The team is on the Pro plan, which accepts up to 300: a model call in the intake
 * chat or a screening turn can take most of a minute, and writing a whole draft (up to 32,000 tokens) several.
 */
export const maxDuration = 300;

export const GET = honoHandler;
export const POST = honoHandler;
export const PUT = honoHandler;
export const PATCH = honoHandler;
export const DELETE = honoHandler;
export const OPTIONS = honoHandler;
export const HEAD = honoHandler;