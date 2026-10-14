"use client";

import { useSyncExternalStore } from "react";

/** Nothing to listen to: the answer changes once, when the browser has taken the page over. */
const subscribe = () => () => {};

/**
 * Whether the page is the browser's own yet (Wave S2: one clean first draw). False while the server draws the page and
 * while the browser takes that drawing over (hydration), so both draw exactly the same; true from the very next draw,
 * and at once on a page opened from inside the app (no hydration there, so nothing waits).
 *
 * A page asks it before showing what the browser can know ahead of the server: the rail's jobs list, which the browser
 * may have read before it takes the page over (the server is only ever handed the session), and the reader's own clock.
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
