import type { Context } from "hono";
import { FRESH_SESSION_MS, REAUTH_WINDOW_MS, isRecentlyAuthenticated } from "@ros/core";
import { HttpError } from "./errors";
import type { Vars } from "./session";

/**
 * Re-authentication before a sensitive change (audit finding A12). A policy or notice change is accepted from a
 * session opened in the last thirty minutes, or from one whose holder confirmed with their sign-in provider again in
 * the last ten minutes (POST /api/v1/auth/reauth/start, then the provider, then the callback). Otherwise the answer is
 * 403 `reauth_required`, which the Setup page turns into "Confirm it's you".
 */
export function assertRecentAuth(c: Context<Vars>): void {
  const s = c.get("session");
  if (!s) throw new HttpError(401, "unauthorized", "Sign in to continue.");
  const now = c.get("container").engine.clock();
  if (isRecentlyAuthenticated(s, now)) return;
  throw new HttpError(403, "reauth_required", "To change this, confirm it's you first: sign in with your provider again, then try once more.", { freshSessionMinutes: FRESH_SESSION_MS / 60_000, reauthMinutes: REAUTH_WINDOW_MS / 60_000 });
}
