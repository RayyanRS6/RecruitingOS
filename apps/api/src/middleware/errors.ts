import type { Context } from "hono";
import { ZodError } from "zod";
import { INTAKE_MESSAGE_MAX } from "@ros/contracts";
import { AuthError, PermissionError, SecretLeakError, SignInRefused, StaffProviderRequired, TransitionError, maskTokenPath, redact, redactString } from "@ros/core";
import { reportError } from "../observability";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

/** What a person reads when their team role does not allow an action (a 403 from the permission matrix). */
export const PERMISSION_MESSAGE = "Your role on this team cannot do that. Ask an owner or an admin.";

/**
 * Words a person typed that are longer than a message may be (plan C5): said plainly, with the limit, instead of
 * "invalid". `afterFirst` adds the job builder's own rule (the first message may be a whole job ad, later ones are
 * shorter); no other form has a first message, so no other form says so.
 */
export function messageTooLong(max: number, opts: { afterFirst?: boolean } = {}): HttpError {
  return new HttpError(400, "message_too_long", `That is too long to send in one go: up to ${max.toLocaleString("en-US")} characters${opts.afterFirst ? " after the first message" : ""}. Shorten it, or send it in parts.`, { maxLength: max });
}

/** The message fields a person types; a Zod "too long" on one of them is answered with `messageTooLong`. */
const TYPED_MESSAGE_FIELDS = new Set(["message", "initialMessage", "note"]);

/** A later turn of the job builder's conversation (not its first message): only there does the limit differ from the first. */
const laterIntakeTurn = (path: string, field: string) => field !== "initialMessage" && /^\/api\/v1\/intake\/(?:sessions\/[^/]+\/(?:messages|answers)|conversation\/messages)$/.test(path);

function tooLongMessage(err: ZodError, path: string): HttpError | null {
  for (const issue of err.issues) {
    const i = issue as { code: string; origin?: string; maximum?: number | bigint; path: PropertyKey[] };
    const field = String(i.path[i.path.length - 1]);
    if (i.code === "too_big" && i.origin === "string" && TYPED_MESSAGE_FIELDS.has(field)) return messageTooLong(Number(i.maximum), { afterFirst: Number(i.maximum) === INTAKE_MESSAGE_MAX && laterIntakeTurn(path, field) });
  }
  return null;
}

export function errorHandler(err: unknown, c: Context) {
  if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
  if (err instanceof ZodError) {
    const tooLong = tooLongMessage(err, c.req.path);
    if (tooLong) return c.json({ error: { code: tooLong.code, message: tooLong.message, details: tooLong.details } }, 400);
    return c.json({ error: { code: "invalid_request", message: "Some fields are missing or invalid.", details: err.issues } }, 400);
  }
  if (err instanceof AuthError) return c.json({ error: { code: "unauthorized", message: err.message } }, 401);
  if (err instanceof SignInRefused) return c.json({ error: { code: err.code, message: err.message } }, 403);
  if (err instanceof StaffProviderRequired) return c.json({ error: { code: err.code, message: err.message } }, 403);
  // The message is read by people (pages show it as is), so it is plain words; the permission stays in `details` for support.
  if (err instanceof PermissionError) return c.json({ error: { code: "forbidden", message: PERMISSION_MESSAGE, details: { permission: err.permission } } }, 403);
  if (err instanceof TransitionError) return c.json({ error: { code: "invalid_transition", message: err.message } }, 409);
  // Correction 10: neither the response nor the log line may carry a credential.
  if (err instanceof SecretLeakError) {
    console.error("[api] refused to write a secret", err.where);
    return c.json({ error: { code: "internal", message: "Something went wrong. It has been logged." } }, 500);
  }
  const message = redactString(err instanceof Error ? err.message : String(err));
  console.error("[api] unhandled", redact(err));
  // Reported with the route only: no query string, no body, no headers (decision 3).
  reportError(err, { process: "api", method: c.req.method, path: maskTokenPath(c.req.path) });
  return c.json({ error: { code: "internal", message: process.env.NODE_ENV === "production" ? "Something went wrong. It has been logged." : message } }, 500);
}

