"use client";

/** A short confirmation at the bottom of the screen; the shell listens and announces it with role="status". */
export function toast(message: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("ros:toast", { detail: message }));
}
