import type { DraftRolePacket } from "@ros/contracts";

/**
 * The small line under each eligibility question on the apply form, in plain words (Wave S2, slice K4). The job's own
 * reason is shown when it reads well to an applicant ("Required by law to practice dental hygiene."). A reason written in
 * the team's words ("The owner stated the work model in the packet.") says only what is true for the applicant: everyone
 * applying is asked. "The owner" reads as "the employer". The stored packet keeps its words; only what the form shows
 * changes. The owner's preview of the form should show the same (pages/preview.tsx, services/job-preview.ts).
 */

/** What the line says when the job's own reason was written for the team. */
export const ASKED_OF_EVERYONE = "Asked of everyone applying for this job.";

/** Words that only make sense inside the team's app (the S1 glossary): a reason using them is not shown to applicants. */
const TEAM_WORDS = /\b(?:packets?|playbooks?|intake|knock-?outs?|triage)\b/i;

/** Stock reasons from the playbooks that read as the team's shorthand, said the way an applicant would read them. */
const PLAIN: Readonly<Record<string, string>> = {
  "Coverage is the reason for the hire.": "The job needs someone for this schedule.",
};

/** The line shown under an eligibility question, from the job's own reason. */
export function questionHelp(rationale: string | null | undefined): string {
  const text = (rationale ?? "").trim();
  if (!text || TEAM_WORDS.test(text)) return ASKED_OF_EVERYONE;
  return PLAIN[text] ?? text.replace(/\b([Tt])he owner\b/g, (_m, t: string) => `${t}he employer`);
}

/**
 * The line under one of the company's own quick questions (Wave S7): the company wrote it for applicants, so it is shown
 * as written, "the owner" read as "the employer"; a line in the team's words, or none, shows nothing (a quick question
 * needs no reason to be asked).
 */
export function quickQuestionHelp(help: string | null | undefined): string | null {
  const text = (help ?? "").trim();
  if (!text || TEAM_WORDS.test(text)) return null;
  return PLAIN[text] ?? text.replace(/\b([Tt])he owner\b/g, (_m, t: string) => `${t}he employer`);
}

/** A copy of the packet whose eligibility questions carry the plain line (the form reads `rationale`); nothing else changes. */
export function withPlainQuestionHelp<P extends Pick<DraftRolePacket, "requirements">>(packet: P): P {
  return { ...packet, requirements: { ...packet.requirements, eligibility: packet.requirements.eligibility.map((rule) => ({ ...rule, rationale: questionHelp(rule.rationale) })) } };
}
