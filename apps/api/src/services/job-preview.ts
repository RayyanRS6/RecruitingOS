import { APPLY_FORM_MINUTES, formatPayRange, isCompanyVerified, oneVisitMinutes, type CompanyQuestions, type DraftRolePacket, type JobPreview, type JobPreviewFact } from "@ros/contracts";
import { benefitsDescriptionFor, candidateNotices, jobNoticesFor, oneVisitPolicyAllows, payShown, payTransparencyApplies, quickQuestionsOf, resolveApplyMode, resolvePolicy } from "@ros/core";
import type { Queryable, companies } from "@ros/db";
import { questionHelp } from "../pages/question-help";
import { approvedAbout, logoMemberPath, profileOf } from "./company-settings-profile";

/**
 * The candidate's view of a job before it is public (plan C9): what the job page and the apply form would show for a
 * draft or for a saved version, built from the same rules as the public pages (apps/api/src/pages/candidate.tsx: the
 * notices for the job's places, pay shown by `payShown`, the steps, the eligibility questions). Data only: the job
 * builder draws it beside the conversation, and Wave D's authenticated preview page (pages/preview.tsx) takes its banner
 * and its gaps, then draws the real job page. Like that page (plan D10) it carries the must-haves and nice-to-haves (their
 * words only), the benefits and the company's approved text, so the in-app preview and the page agree. Never served
 * under /careers and never indexed.
 */

/** How the public pages name the work model and the kind of job (job-facts.tsx reads these too). */
export const WORK_MODEL_LABEL: Readonly<Record<string, string>> = { onsite: "On site", hybrid: "Hybrid", remote: "Remote" };
export const EMPLOYMENT_LABEL: Readonly<Record<string, string>> = { full_time: "Full time", part_time: "Part time", contract: "Contract", temporary: "Temporary", per_diem: "Per diem", internship: "Internship" };

type Company = Pick<typeof companies.$inferSelect, "name" | "slug" | "locations" | "settings">;

/**
 * How a job's applicants meet the screening conversation, as its pages tell it (plan E8): "one_visit", straight after
 * the form in the same visit (founder decision B1), or "later", by email if the hiring team's rules invite them.
 */
export type ApplyFlowView = "one_visit" | "later";

/** The form alone, in minutes; applying in one visit, rounded up to five (shared with the owner's preview of an edit). */
export const FORM_MINUTES = APPLY_FORM_MINUTES;
export { oneVisitMinutes };

/** How long applying takes, in the words of the job page, its apply card and the form (plan E8). */
export function applyTimeLine(packet: { screening: Pick<DraftRolePacket["screening"], "maxMinutes"> }, input: { companyName: string; flow: ApplyFlowView }): string {
  return input.flow === "one_visit" ? `About ${oneVisitMinutes(packet)} minutes, including a short written conversation with ${input.companyName}'s AI assistant.` : `A short form, about ${FORM_MINUTES} minutes.`;
}

/**
 * The steps the candidate can expect, the same on every job page, its preview and the job builder's preview. The first
 * is applying and the second the conversation (the builder's live preview relies on that order).
 */
export function applySteps(packet: Pick<DraftRolePacket, "screening" | "interviews">, input: { companyName: string; smsEnabled: boolean; flow: ApplyFlowView }): string[] {
  const n = packet.screening.questions.length;
  const first = input.flow === "one_visit"
    ? [
        `Apply in about ${oneVisitMinutes(packet)} minutes, including a short written conversation with ${input.companyName}'s AI assistant. We confirm by email.`,
        `The conversation: ${n} questions, about ${packet.screening.maxMinutes} minutes. It is not a test. You can skip a question, stop and come back later, or ask for a person instead.`,
      ]
    : [
        `Send a short form, about ${FORM_MINUTES} minutes. We confirm by email.`,
        `Possibly a short written conversation with ${input.companyName}'s AI assistant (${input.smsEnabled ? "by text or online" : "online"}, about ${packet.screening.maxMinutes} minutes). If so, we email you the link.`,
      ];
  return [...first, ...packet.interviews.plan.map((r) => `${r.title} (${r.durationMinutes} minutes)`), "A decision, and a real answer either way."];
}

/** The flow a company's new roles follow, when nothing more is known (a draft, or a caller without the role's own setting). */
export function companyApplyFlow(company: Pick<Company, "settings">): ApplyFlowView {
  return resolveApplyMode({ applyMode: null }, company.settings) === "one_visit" ? "one_visit" : "later";
}

/**
 * How a role's applicants meet the conversation, as its pages tell it: the same rule the apply page follows
 * (services/apply-conversation.ts): the role's or the company's flow, and the owner's rule for screen invitations ("Ask
 * me first" and "Only a person" keep the later path). Eligibility is per applicant, so it is not part of what the page says.
 */
export async function applyFlowOf(q: Queryable, company: { id: string; settings: Company["settings"] }, role: { id: string | null; applyMode?: string | null }): Promise<ApplyFlowView> {
  if (resolveApplyMode(role, company.settings) !== "one_visit") return "later";
  const policy = await resolvePolicy(q, company.id, role.id, "application.invite_screen");
  return oneVisitPolicyAllows(policy.level) ? "one_visit" : "later";
}

export type PreviewSource = { kind: "draft"; sessionId: string } | { kind: "version"; roleId: string; version: number; status: string; current: boolean; roleStatus: string };

/** `flow`: how applicants meet the conversation (pages/candidate.tsx `applyFlowOf`); the company's default when not given. */
export function jobPreview(input: { packet: DraftRolePacket; company: Company; source: PreviewSource; smsEnabled: boolean; flow?: ApplyFlowView }): JobPreview {
  const { packet, company, source } = input;
  // A saved version carries the company's own questions; a draft from the job builder may not yet.
  const withQuestions = packet as DraftRolePacket & { companyQuestions?: CompanyQuestions | null };
  const notices = jobNoticesFor({ jobLocations: packet.identity.locations, companyLocations: company.locations, overrides: company.settings.notices });
  const shown = candidateNotices(notices);
  const verified = isCompanyVerified(company.settings);
  const storedLogo = profileOf(company.settings).logo;
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
    // The stored logo from the team's own address (plan D10): its public address answers only once the company is public.
    company: { name: company.name, slug: company.slug, website: company.settings.website ?? null, logoUrl: storedLogo ? logoMemberPath(storedLogo) : company.settings.logoUrl ?? null, verified, about: approvedAbout(company.settings) },
    job: {
      title: packet.identity.title,
      facts,
      locations: places,
      description: packet.description.publicJobDescription,
      // The words only, as the job page lists them; why each matters stays with the team.
      mustHaves: packet.requirements.mustHaves.map((m) => m.text),
      niceToHaves: packet.requirements.niceToHaves.map((m) => m.text),
      benefits: benefitsDescriptionFor(packet.compensation, company.settings),
      // The same steps the job page lists under "What to expect".
      steps: applySteps(packet, { companyName: company.name, smsEnabled: input.smsEnabled, flow: input.flow ?? companyApplyFlow(company) }),
      notices: shown.filter((n) => n.key === "ai_use" || n.key === "pay_transparency").map((n) => ({ key: n.key, text: n.text })),
    },
    pay: { shown: payVisible, text: payText, requiredByLaw: payTransparencyApplies(notices), note: comp ? null : "Pay is not set yet." },
    apply: {
      questions: packet.requirements.eligibility.map((rule) => {
        const days = (rule.expectation as { days?: unknown }).days;
        // the same plain line the live form shows under the question (pages/question-help.ts), never the team's words
        return { key: rule.key, question: rule.question, help: questionHelp(rule.rationale), answer: rule.type === "schedule_availability" && Array.isArray(days) && days.length > 0 ? ("days" as const) : ("yes_no" as const) };
      }),
      // The company's own questions (Wave S7): the quick ones as the form shows them, the written ones counted.
      quickQuestions: quickQuestionsOf(withQuestions).filter((q) => q.source === "company").map((q) => ({ key: q.key, question: q.question, help: q.help, kind: q.kind === "number" ? "number" as const : q.kind === "yes_no" ? "yes_no" as const : "choice" as const, options: q.options, unit: q.unit, required: q.required })),
      writtenQuestions: withQuestions.companyQuestions?.written?.length ?? 0,
      notices: shown.map((n) => ({ key: n.key, text: n.text })),
      disclosure: packet.communication.disclosureText,
      humanAlternative: packet.communication.humanAlternativeText,
    },
    gaps,
  };
}
