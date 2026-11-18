"use client";

import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api/client";

/**
 * Whether the session ended under a tab left open: a look answered 401. The session
 * slides only while the tab looks, so a hidden or sleeping tab outlives it; then every look fails and each source keeps
 * what it read before, so the page goes to sign in instead.
 */
export function sessionEnded(errors: readonly unknown[]): boolean {
  return errors.some((e) => e instanceof ApiError && e.status === 401);
}

/**
 * Sends the page to sign in once any of its own looks answered 401: the console's Overview, its Customers page, Home and
 * Settings. Any other failure stays on the page, which says so where it happened.
 */
export function useSignInWhenSessionEnds(errors: readonly unknown[]): void {
  const ended = sessionEnded(errors);
  useEffect(() => {
    if (ended) window.location.assign("/login");
  }, [ended]);
}

/**
 * The signed-in frame's watch: any page's own look that answers 401 sends it to sign
 * in, once. After Take away access, or an administrator's Sign out everywhere, a job page, Candidates or Settings
 * left open read "Could not load…" with a Try again that failed every time, and moving between pages did not run the
 * server's own redirect again. Any other failure stays on the page, which says so where it happened. Answers the unsubscribe.
 */
export function watchForEndedSession(qc: QueryClient, goToSignIn: () => void): () => void {
  let sent = false;
  return qc.getQueryCache().subscribe((event) => {
    if (sent || event.type !== "updated" || event.action.type !== "error") return;
    if (!sessionEnded([event.action.error])) return;
    sent = true;
    goToSignIn();
  });
}
