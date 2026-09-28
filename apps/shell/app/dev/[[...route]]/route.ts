import { honoHandler } from "../../../lib/hono";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Seconds a request may run on Vercel (a model call in the intake chat or a screening turn can take most of a minute). 60 is the highest value every Vercel plan accepts; raise it on a Pro plan if intake turns time out. */
export const maxDuration = 60;

export const GET = honoHandler;
export const POST = honoHandler;
export const PUT = honoHandler;
export const PATCH = honoHandler;
export const DELETE = honoHandler;
export const OPTIONS = honoHandler;
export const HEAD = honoHandler;