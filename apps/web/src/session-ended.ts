"use client";

import { useEffect } from "react";
import { ApiError } from "./api/client";

/**
 * Whether the session ended under a tab left open (the review of 9 November 2026): a look answered 401. The session
 * slides only while the tab looks, so a hidden or sleeping tab outlives it; then every look fails and each source keeps
 * what it read before, so the page goes to sign in instead.
 */
export function sessionEnded(errors: readonly unknown[]): boolean {
  return errors.some((e) => e instanceof ApiError && e.status === 401);
}

/**
 * Sends the page to sign in once any of its own looks answered 401: the console's Overview, its Customers page and Home
 * (10 November 2026). Any other failure stays on the page, which says so where it happened.
 */
export function useSignInWhenSessionEnds(errors: readonly unknown[]): void {
  const ended = sessionEnded(errors);
  useEffect(() => {
    if (ended) window.location.assign("/login");
  }, [ended]);
}
