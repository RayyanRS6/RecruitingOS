import type { Tone } from "@ros/ui";

/**
 * Whether email to candidates is really arriving (6 November 2026, the dead ends' rank 1): GET /companies/current
 * `candidateEmail`, over the last `days` days, counts only. Settings said "Candidate email is sent from the dedicated ITS
 * domain." whenever a key existed, while every email failed; now it reads the sends.
 */
export type CandidateEmailHealth = { days: number; left: number; failed: number; lastLeftAt: string | null; lastFailedAt: string | null };

/** One person an email did not reach, as Home's card lists them (the brief's `unreached`). */
export type UnreachedPerson = { applicationId: string; roleId: string; roleTitle: string; name: string; email: string | null; phone: string | null; emails: number };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * The email row of Connected services when its provider is connected: its state, its tone and its line, from the sends.
 * None of the last ones arrived: "Not working". Some did not: "Some did not arrive". Some went and none failed: the usual
 * "Connected and working", with when the last one went. Nothing sent in the window: "Connected", since nothing proves
 * more. Never a claim about a domain: that a key exists says nothing about whether mail arrives.
 */
export function candidateEmailRow(h: CandidateEmailHealth | null | undefined): { state: string; tone: Tone; line: string } {
  const days = h?.days ?? 7;
  const failed = h?.failed ?? 0;
  const left = h?.left ?? 0;
  if (failed && !left) return { state: "Not working", tone: "critical", line: `None of the last ${plural(failed, "email", "emails")} to candidates arrived. Home lists who to phone.` };
  if (failed) return { state: "Some did not arrive", tone: "caution", line: `${failed} of the last ${failed + left} emails to candidates did not arrive. Home lists who to phone.` };
  if (left && h?.lastLeftAt) return { state: "Connected and working", tone: "good", line: `The last email to a candidate went out on ${day(h.lastLeftAt)}.` };
  return { state: "Connected", tone: "good", line: `No email to a candidate in the last ${days} days.` };
}

/** What stands in for the address of someone who gave none. */
export const NO_EMAIL_ON_FILE = "No email address on file";

/** A phone number as a link that dials it: only its digits and a leading plus. */
export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

/** Where a person on the card opens: their page, on their job's Candidates. */
export const openPersonPath = (p: Pick<UnreachedPerson, "roleId" | "applicationId">) => `/roles/${p.roleId}/talent?open=${p.applicationId}`;
