import { formatPayRange, isCompanyVerified, type DraftRolePacket, type JobPreview, type JobPreviewFact } from "@ros/contracts";
import { candidateNotices, jobNoticesFor, payShown, payTransparencyApplies } from "@ros/core";
import type { companies } from "@ros/db";

/**
 * The candidate's view of a job before it is public (plan C9): what the job page and the apply form would show for a
 * draft or for a saved version, built from the same rules as the public pages (apps/api/src/pages/candidate.tsx: the
 * notices for the job's places, pay shown by `payShown`, the steps, the eligibility questions). Exactly the sections the
 * job page renders, nothing more: it does not list the must-haves or the benefits, so neither does this. Data only: the
 * job builder draws it beside the conversation, and Wave D's authenticated preview page reads the same. Never served
 * under /careers and never indexed.
 */

/** How the public pages name the work model and the kind of job (job-facts.tsx reads these too). */
export const WORK_MODEL_LABEL: Readonly<Record<string, string>> = { onsite: "On site", hybrid: "Hybrid", remote: "Remote" };
export const EMPLOYMENT_LABEL: Readonly<Record<string, string>> = { full_time: "Full time", part_time: "Part time", contract: "Contract", temporary: "Temporary", per_diem: "Per diem", internship: "Internship" };

type Company = Pick<typeof companies.$inferSelect, "name" | "slug" | "locations" | "settings">;

export type PreviewSource = { kind: "draft"; sessionId: string } | { kind: "version"; roleId: string; version: number; status: string; current: boolean; roleStatus: string };

export function jobPreview(input: { packet: DraftRolePacket; company: Company; source: PreviewSource; smsEnabled: boolean }): JobPreview {
  const { packet, company, source } = input;
  const notices = jobNoticesFor({ jobLocations: packet.identity.locations, companyLocations: company.locations, overrides: company.settings.notices });
  const shown = candidateNotices(notices);
  const verified = isCompanyVerified(company.settings);
  const comp = packet.compensation;
  const payVisible = comp ? payShown(comp, notices) : false;
  const payText = comp && payVisible ? formatPayRange(comp) : "";
  const places = packet.identity.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).filter(Boolean);
  const facts: JobPreviewFact[] = [];
  if (places[0]) facts.push({ key: "location", label: "Location", text: places[0] });
  facts.push({ key: "workplace", label: "Workplace", text: WORK_MODEL_LABEL[packet.identity.remotePolicy] ?? packet.identity.remotePolicy });
  facts.push({ key: "job_type", label: "Job type", text: EMPLOYMENT_LABEL[packet.identity.employmentType] ?? packet.identity.employmentType.replace(/_/g, " ") });
  if (payText) facts.push({ key: "pay", label: "Pay", text: payText });
  if (packet.identity.schedule) facts.push({ key: "schedule", label: "Schedule", text: packet.identity.schedule });

  const live = source.kind === "version" && source.current && source.roleStatus === "open" && verified;
  const banner = live
    ? "This is the live version of the job page."
    : source.kind === "draft"
      ? "Preview of your draft: this is what candidates would see. Nothing is public until the role is approved."
      : source.status === "approved" && source.current
        ? `Preview of version ${source.version}: approved, not public right now.`
        : `Preview of version ${source.version}: not public.`;
  const gaps: string[] = [];
  if (!comp) gaps.push("Pay is not set yet, so the page shows no pay. Set or confirm it on the pay card.");
  else if (!payVisible) gaps.push("The pay range is hidden on this page.");
  if (!verified) gaps.push("Your company is waiting for its one-time check by ITS. Job pages go public after that.");
  if (!places.length) gaps.push("The job has no place yet.");

  return {
    source: source.kind === "draft" ? source : { kind: "version", roleId: source.roleId, version: source.version, status: source.status, current: source.current },
    notPublicYet: !live,
    banner,
    company: { name: company.name, slug: company.slug, website: company.settings.website ?? null, logoUrl: company.settings.logoUrl ?? null, verified },
    job: {
      title: packet.identity.title,
      facts,
      locations: places,
      description: packet.description.publicJobDescription,
      // The same steps the job page lists under "What to expect".
      steps: [
        "Apply in about three minutes. We confirm by email.",
        `A short screening conversation ${input.smsEnabled ? "by text or online" : "online"} (about ${packet.screening.maxMinutes} minutes) if your background looks like a fit.`,
        ...packet.interviews.plan.map((r) => `${r.title} (${r.durationMinutes} minutes)`),
        "A decision, and a real answer either way.",
      ],
      notices: shown.filter((n) => n.key === "ai_use" || n.key === "pay_transparency").map((n) => ({ key: n.key, text: n.text })),
    },
    pay: { shown: payVisible, text: payText, requiredByLaw: payTransparencyApplies(notices), note: comp ? null : "Pay is not set yet." },
    apply: {
      questions: packet.requirements.eligibility.map((rule) => {
        const days = (rule.expectation as { days?: unknown }).days;
        return { key: rule.key, question: rule.question, help: rule.rationale, answer: rule.type === "schedule_availability" && Array.isArray(days) && days.length > 0 ? ("days" as const) : ("yes_no" as const) };
      }),
      notices: shown.map((n) => ({ key: n.key, text: n.text })),
      disclosure: packet.communication.disclosureText,
      humanAlternative: packet.communication.humanAlternativeText,
    },
    gaps,
  };
}
