import type { DraftRolePacket } from "@ros/contracts";

/**
 * The small line under each screening question on the application form, in plain words. The job's own line is shown when
 * it reads well to an applicant ("Required by law to practice dental hygiene."). "The owner" reads as "the employer". A
 * line written in the team's words shows nothing. The stored job keeps its words; only what the form shows changes.
 */

/** What the line says when the job's own reason was written for the team. */
export const ASKED_OF_EVERYONE = "Asked of everyone applying for this job.";

/** Words that only make sense inside the team's app: a line using them is not shown to applicants. */
const TEAM_WORDS = /\b(?:packets?|playbooks?|intake|knock-?outs?|triage)\b/i;

/** Stock reasons that read as the team's shorthand, said the way an applicant would read them. */
const PLAIN: Readonly<Record<string, string>> = {
  "Coverage is the reason for the hire.": "The job needs someone for this schedule.",
};

/** A reason as an applicant reads it; one in the team's words, or none, says only that everyone is asked. */
export function questionHelp(rationale: string | null | undefined): string {
  const text = (rationale ?? "").trim();
  if (!text || TEAM_WORDS.test(text)) return ASKED_OF_EVERYONE;
  return PLAIN[text] ?? text.replace(/\b([Tt])he owner\b/g, (_m, t: string) => `${t}he employer`);
}

/** The line under a screening question: shown as written, "the owner" read as "the employer"; a line in the team's words, or none, shows nothing. */
export function quickQuestionHelp(help: string | null | undefined): string | null {
  const text = (help ?? "").trim();
  if (!text || TEAM_WORDS.test(text)) return null;
  return PLAIN[text] ?? text.replace(/\b([Tt])he owner\b/g, (_m, t: string) => `${t}he employer`);
}

/** A copy of the job whose screening questions carry the line the form shows; nothing else changes. */
export function withPlainQuestionHelp<P extends Pick<DraftRolePacket, "formQuestions">>(packet: P): P {
  return { ...packet, formQuestions: packet.formQuestions.map((q) => ({ ...q, help: quickQuestionHelp(q.help) ?? undefined })) };
}
