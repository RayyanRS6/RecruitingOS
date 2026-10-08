import type { GettingStartedAction, GettingStartedStep } from "@ros/contracts";

/**
 * Today's pure pieces (plan B2 and B9), kept out of the page so they can be checked without a browser.
 *
 * Today keeps itself current: its cards and updates are asked for again when the window comes back into focus, and
 * every minute while the page is open and visible (never in a hidden tab). The app's default is neither
 * (apps/shell/components/Providers.tsx), so a half-filled form elsewhere is never reloaded under someone.
 */
export const TODAY_REFRESH = { refetchOnWindowFocus: true, refetchInterval: 60_000, refetchIntervalInBackground: false } as const;

/** The step whose first button is the primary one: the first that is not done yet. */
export function nextStep(steps: readonly GettingStartedStep[]): GettingStartedStep | undefined {
  return steps.find((s) => !s.done);
}

/** What a getting-started button says it did, in two short lines (a request to ITS is answered by the API's own words). */
export function setupActionToast(action: GettingStartedAction): { title: string; detail?: string } {
  if (action.path.includes("/escalations")) return { title: "Sent to ITS." };
  if (action.body?.action === "dismiss") return { title: "Steps hidden.", detail: "Only for you; the rest of your team still sees theirs." };
  if (action.body?.action === "policies_reviewed") return { title: "Marked as reviewed.", detail: "You can change the AI rules in Setup at any time." };
  return { title: "Done." };
}
