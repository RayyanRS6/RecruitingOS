import { honoHandler } from "../../../lib/hono";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = honoHandler;
export const POST = honoHandler;
export const PUT = honoHandler;
export const PATCH = honoHandler;
export const DELETE = honoHandler;
export const OPTIONS = honoHandler;
export const HEAD = honoHandler;
