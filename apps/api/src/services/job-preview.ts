import { EMPLOYMENT_TYPE_LABEL, REMOTE_POLICY_LABEL, type DraftRolePacket } from "@ros/contracts";
import { afterApplyingSteps } from "@ros/agents";
import { ON_FILE_LAST_STEP, isCompanyLive, jobNoticesFor, payShown } from "@ros/core";
import type { companies } from "@ros/db";

/**
 * What the job page and the apply form say about applying, shared by the public pages and the team's preview of them
 * (pages/preview.tsx), and the note the preview carries: whether the page is public yet and what it still lacks.
 */

/** How the public pages name the work arrangement and the kind of job. */
export const WORK_MODEL_LABEL: Readonly<Record<string, string>> = REMOTE_POLICY_LABEL;
export const EMPLOYMENT_LABEL: Readonly<Record<string, string>> = EMPLOYMENT_TYPE_LABEL;

/** The application form, in minutes. */
export const FORM_MINUTES = 3;

/** How long applying takes, on the job page's apply card. */
export const APPLY_TIME_LINE = `A short form, about ${FORM_MINUTES} minutes.`;

/**
 * "What to expect" on the job page and its preview: applying is a short form, and what follows it is what the receipt
 * and the email say (`afterApplyingSteps`). An AI interview is never part of applying. `onFile`: the job is past its
 * plan's candidates per job, so the page promises no review: its last step is DRAFT WORDING PENDING COUNSEL
 * (packages/core/src/candidate-lock.ts), and it never says why.
 */
export function applySteps(input: { companyName: string; onFile: boolean }): string[] {
  const form = `Send a short form, about ${FORM_MINUTES} minutes. We confirm by email.`;
  return input.onFile ? [form, ON_FILE_LAST_STEP] : [form, ...afterApplyingSteps(input.companyName)];
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
