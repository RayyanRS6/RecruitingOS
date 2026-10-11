"use client";

import { TOAST_EVENT, type ToastAction, type ToastTone, toastPayload } from "@ros/ui";

/**
 * A short confirmation at the bottom of the screen; the shell's Toaster (packages/ui) announces it with role="status".
 * The optional second line says what did or did not follow: toast("Moved to Shortlist.", "Private: the candidate was not
 * told."). Pass { tone: "good" } or { tone: "critical" } for a tick or an alert mark beside the words, and { action,
 * durationMs } for an Undo that stays while it still works (plan G9). A plain toast never takes away an Undo still on
 * screen (it waits); { endsAction: true } marks the one that answers it (what became of the Undo), which replaces it.
 */
export function toast(title: string, more?: string | { detail?: string; tone?: ToastTone; action?: ToastAction; durationMs?: number; endsAction?: boolean }): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: toastPayload(title, more) }));
}
