import { EMPLOYMENT_TYPE_LABEL, REMOTE_POLICY_LABEL, type DraftRolePacket } from "@ros/contracts";
import { ON_FILE_LAST_STEP, isCompanyLive, jobNoticesFor, payShown } from "@ros/core";
import type { companies } from "@ros/db";

/**
 * What the job page and the apply form say about applying, shared by the public pages and the team's preview of them
 * (pages/preview.tsx), and the note the preview carries: whether the page is public yet and what it still lacks.
 */

/** How the public pages name the work arrangement and the kind of job. */
export const WORK_MODEL_LABEL: Readonly<Record<string, string>> = REMOTE_POLICY_LABEL;
export const EMPLOYMENT_LABEL: Readonly<Record<string, string>> = EMPLOYMENT_TYPE_LABEL;

/**
 * How a job's applicants meet the AI interview, as its pages tell it. "one_visit": a short form, then the AI interview.
 * "later": by email only. "on_file": the job is past its plan's candidates per job, so a new applicant meets no AI
 * interview and nothing reads their resume: the pages say a short form, promise neither, and never say why.
 */
export type ApplyFlowView = "one_visit" | "later" | "on_file";
export const APPLY_FLOW: ApplyFlowView = "one_visit";

/** The form alone, in minutes. */
export const FORM_MINUTES = 3;

/** Applying in one visit, the form and the AI interview, rounded up to five minutes. */
export function oneVisitMinutes(packet: { screening: { maxMinutes: number } }): number {
  return Math.ceil((FORM_MINUTES + packet.screening.maxMinutes) / 5) * 5;
}

/** How long applying takes, in the words of the job page, its apply card and the form. */
export function applyTimeLine(packet: { screening: Pick<DraftRolePacket["screening"], "maxMinutes"> }, input: { companyName: string; flow: ApplyFlowView }): string {
  return input.flow === "one_visit" ? `About ${oneVisitMinutes(packet)} minutes, including a short AI interview with ${input.companyName}'s AI assistant.` : `A short form, about ${FORM_MINUTES} minutes.`;
}

/**
 * The steps the candidate can expect, the same on every job page and its preview. It gives the job's own length, never
 * a number of questions. On a job past its limit (`on_file`) there is no AI interview to name, and the last step is the
 * promise that holds for someone nobody may read: a real answer by a date. That step is DRAFT WORDING PENDING COUNSEL
 * (packages/core/src/candidate-lock.ts).
 */
export function applySteps(packet: Pick<DraftRolePacket, "screening">, input: { companyName: string; flow: ApplyFlowView }): string[] {
  if (input.flow === "on_file") return [`Send a short form, about ${FORM_MINUTES} minutes. We confirm by email.`, ON_FILE_LAST_STEP];
  const first = input.flow === "one_visit"
    ? [
        `Send a short form, about ${FORM_MINUTES} minutes. We confirm by email.`,
        `A short AI interview with ${input.companyName}'s AI assistant, about ${packet.screening.maxMinutes} minutes. It opens right after the form, usually within a minute, and its link comes by email too, so you can do it later. It is not a test: you can skip a question, stop and come back later, or ask for a person instead.`,
      ]
    : [
        `Send a short form, about ${FORM_MINUTES} minutes. We confirm by email.`,
        `Possibly a short written conversation with ${input.companyName}'s AI assistant (online, about ${packet.screening.maxMinutes} minutes). If so, we email you the link.`,
      ];
  return [...first, "A decision, and a real answer either way."];
}

type Company = Pick<typeof companies.$inferSelect, "locations" | "settings">;

/** What is previewed: a draft in the job builder, or a job with the version shown and whether that version is the one its page runs on. */
export type PreviewSource = { kind: "draft" } | { kind: "job"; status: string; current: boolean };

/**
 * The note on a preview: whether candidates see this page now, the banner that says so, and what the page still lacks.
 * A job's page is public while the job is open or paused, for a company an administrator accepted.
 */
export function previewNote(input: { packet: DraftRolePacket; company: Company; source: PreviewSource }): { notPublicYet: boolean; banner: string; gaps: string[] } {
  const { packet, company, source } = input;
  const live = source.kind === "job" && source.current && (source.status === "open" || source.status === "paused") && isCompanyLive(company.settings);
  const banner = live
    ? "This is the job page as candidates see it now."
    : source.kind === "draft"
      ? "Preview of your draft: this is what candidates will see. Nothing is public until you publish the job."
      : source.status === "closed"
        ? "Preview: this job is closed, so its page is no longer public."
        : source.current ? "Preview: this job is not published yet." : "Preview of an earlier version: candidates do not see this one.";
  const gaps: string[] = [];
  const notices = jobNoticesFor({ jobLocations: packet.identity.locations, companyLocations: company.locations, overrides: company.settings.notices });
  if (!packet.compensation) gaps.push("Pay is not set yet, so the page shows no pay. Set or confirm it on the pay card.");
  else if (!payShown(packet.compensation, notices)) gaps.push("The pay range is hidden on this page.");
  if (!packet.identity.locations.some((l) => l.city || l.region)) gaps.push("The job has no place yet.");
  return { notPublicYet: !live, banner, gaps };
}
