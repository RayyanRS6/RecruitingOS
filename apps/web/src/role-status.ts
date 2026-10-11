import type { Tone } from "@ros/ui";

/**
 * A role's status as the owner reads it: a word and the colour of its dot (docs/07: the word carries the meaning, the
 * colour only helps a glance). Green is a role taking applicants or filled, amber one waiting on a person or held.
 */
export const ROLE_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  pending_approval: { label: "Waiting for approval", tone: "caution" },
  open: { label: "Open", tone: "good" },
  paused: { label: "Paused", tone: "caution" },
  filled: { label: "Filled", tone: "good" },
  closed: { label: "Closed", tone: "neutral" },
};

export function roleStatus(status: string): { label: string; tone: Tone } {
  return ROLE_STATUS[status] ?? { label: status.replace(/_/g, " "), tone: "neutral" };
}
