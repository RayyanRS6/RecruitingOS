import type { Context } from "hono";
import { ZodError } from "zod";
import { AuthError, PermissionError, SecretLeakError, SignInRefused, StaffProviderRequired, TransitionError, maskTokenPath, redact, redactString } from "@ros/core";
import { reportError } from "../observability";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export function errorHandler(err: unknown, c: Context) {
  if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
  if (err instanceof ZodError) return c.json({ error: { code: "invalid_request", message: "Some fields are missing or invalid.", details: err.issues } }, 400);
  if (err instanceof AuthError) return c.json({ error: { code: "unauthorized", message: err.message } }, 401);
  if (err instanceof SignInRefused) return c.json({ error: { code: err.code, message: err.message } }, 403);
  if (err instanceof StaffProviderRequired) return c.json({ error: { code: err.code, message: err.message } }, 403);
  if (err instanceof PermissionError) return c.json({ error: { code: "forbidden", message: `Your role (${err.role}) cannot do this (${err.permission}).` } }, 403);
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

