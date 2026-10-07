"use client";

import { TOAST_EVENT, type ToastTone, toastPayload } from "@ros/ui";

/**
 * A short confirmation at the bottom of the screen; the shell's Toaster (packages/ui) announces it with role="status".
 * The optional second line says what did or did not follow: toast("Moved to Shortlist.", "Private: the candidate was not
 * told."). Pass { tone: "good" } or { tone: "critical" } for a tick or an alert mark beside the words.
 */
export function toast(title: string, more?: string | { detail?: string; tone?: ToastTone }): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: toastPayload(title, more) }));
}
