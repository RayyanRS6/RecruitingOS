import { z } from "zod";
import { Location } from "../domain/common";
import { MembershipRole, type SignupRequest } from "../domain/company";
import type { AiCreditView, PlanLimitKey } from "../domain/plans";
import type { TrialStanding } from "../domain/trial";

/**
 * Company details at sign-up, and Settings: one page with four sections, Company, Team, Plan and Email updates. The
 * email switch is in api/notifications.ts.
 */

/** A real IANA time zone name ("America/Chicago"): the company's days, its closing dates among them, are counted in it. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const TimeZone = z.string().min(1).max(64).refine(isTimeZone, { message: "Choose a time zone from the list." });
const SizeBand = z.enum(["1-19", "20-49", "50-99", "100-199", "200-499", "500+"]);
const WebsiteInput = z.string().trim().max(200).refine((v) => v === "" || /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(v), "Use a web address like acme.com");

/* ------------------------------------------------------------------------------------------------------------ */
/* Company details (the form after the first sign-in).                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

/** POST /api/v1/companies. `vertical` is the kind of business, a plain label. */
export const CreateCompany = z.object({
  name: z.string().min(2).max(120),
  vertical: z.string().min(2).max(60),
  sizeBand: SizeBand,
  /** The form sends the owner's own zone; the default stays only for callers that send none. */
  timezone: TimeZone.default("America/Los_Angeles"),
  locations: z.array(Location).min(1),
  ownerName: z.string().min(1).optional(),
  website: z.string().optional(),
  /**
   * The address candidates may write to: the job pages show it and their replies go to it (`hiringContact`). The form
   * asks for it; left out, the ITS inbox answers until the company sets its own in Settings.
   */
  contactEmail: z.email().max(254).optional(),
});
export type CreateCompany = z.infer<typeof CreateCompany>;

/**
 * What it answers. Under `approval` the company is a request until an administrator accepts it: `accessRequest` says
 * so, and the person reads "Your request has been sent". Under `open` it is live at once and `accessRequest` is null.
 */
export type CompanyCreated = { id: string; name: string; accessRequest: SignupRequest | null };

/* ------------------------------------------------------------------------------------------------------------ */
/* Settings, Company.                                                                                             */
/* ------------------------------------------------------------------------------------------------------------ */

/** One usage line of a plan: "1 of 1 jobs", "2 of 3 people", "AI help: 40% used". AI help is a percentage, never money. */
export type UsageLine = { key: PlanLimitKey; label: string; used: number; limit: number | null; unit: "count" | "percent"; /** When a monthly allowance starts again (ISO); null for one that does not. */ resetsAt: string | null; words: string };

/**
 * The company's plan as its own people read it. `usage`: one line for each limit the plan sets. `mayUpgrade`: an
 * Upgrade can be asked for (GET /api/v1/plans lists the plans, POST /api/v1/plans/request sends the request);
 * `upgradeRequestedAt`: when the open request was sent, null with none open.
 */
export type PlanView = { key: string; name: string; usage: UsageLine[]; aiCredit: AiCreditView | null; trial: TrialStanding | null; mayUpgrade: boolean; upgradeRequestedAt: string | null };

/**
 * GET /api/v1/companies/current, and the answer to every change of the company's details. Only an accepted company has
 * people who can read it, so its careers page (`careersUrl`) is public whenever this is answered. `contactShown`: the
 * address candidates see, the company's own (`hiringContact`) or ours when it set none. `about`: the text about the
 * company on its job pages, approved by a person; `aiAssisted` when the assistant drafted it. `aboutDraft`: a text the
 * assistant drafted that nobody has approved yet (never on a public page), with the wording check's finding when it
 * holds something a job page should not say. `viewer.mayEdit`: the person looking may change these details (an owner or
 * an admin).
 */
export type CompanyView = {
  id: string;
  name: string;
  slug: string;
  vertical: string;
  sizeBand: string;
  timezone: string;
  locations: Location[];
  website: string | null;
  logoUrl: string | null;
  about: { text: string; approvedAt: string; aiAssisted: boolean } | null;
  aboutDraft: { text: string; draftedAt: string; check: { rule: string; text: string; reason: string; alternative: string } | null } | null;
  benefitsSummary: string | null;
  hiringContact: { email: string; name: string | null } | null;
  contactShown: { email: string; name: string | null; kind: "company" | "its" };
  careersUrl: string;
  plan: PlanView;
  viewer: { mayEdit: boolean };
};

/**
 * PATCH /api/v1/companies/current: what an owner or an admin may change. Only the fields sent change. `benefitsSummary`
 * is the benefits line the legal check of a job reads when the job has none of its own. The plan, the limits and the
 * company's status are set by an administrator and refused here.
 */
export const UpdateCompany = z.object({
  name: z.string().trim().min(2).max(120),
  website: WebsiteInput,
  timezone: TimeZone,
  sizeBand: SizeBand,
  locations: z.array(Location).min(1).max(20),
  benefitsSummary: z.string().trim().max(2000),
}).partial().strict();
export type UpdateCompany = z.infer<typeof UpdateCompany>;

/** PUT /api/v1/companies/current/hiring-contact: the address candidates see, or null to show ours. */
export const HiringContactInput = z.object({ email: z.email().max(254).nullable(), name: z.string().trim().max(120).nullable().optional() }).strict();
export type HiringContactInput = z.infer<typeof HiringContactInput>;

/** POST /api/v1/companies/current/about/draft: the assistant drafts the text about the company from the person's notes. It is kept as `aboutDraft` until a person approves a text. */
export const AboutDraftRequest = z.object({ notes: z.string().trim().max(1000).optional() }).strict();
export type AboutDraftRequest = z.infer<typeof AboutDraftRequest>;

/** POST /api/v1/companies/current/about: the text a person approves for the job pages (their own, or the draft as they left it), or null to take the text off. */
export const AboutInput = z.object({ text: z.string().trim().min(40).max(1200).nullable() }).strict();
export type AboutInput = z.infer<typeof AboutInput>;

/* ------------------------------------------------------------------------------------------------------------ */
/* Settings, Team.                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** One person on the team. `mayChange`: the person looking may change this one's role or remove them, with the reason when not. */
export type TeamMember = { userId: string; name: string | null; email: string; role: MembershipRole; roleLabel: string; you: boolean; mayChange: boolean; changeBlockedReason: string | null };

/** One invitation not yet answered. `emailState`: what became of its email; null when nothing is known yet. */
export type TeamInvitation = { id: string; email: string; name: string | null; role: MembershipRole; roleLabel: string; invitedBy: string | null; createdAt: string; expiresAt: string; emailState: "on_its_way" | "sent" | "failed" | null };

/**
 * GET /api/v1/companies/current/members: the team, the invitations still open (only for someone who manages the team),
 * the plan's people, and what the person looking may do. `grantableRoles`: the roles they may invite someone as or
 * change someone to: an owner all three, an admin Admin and Member, a member none. Granting Owner or Admin asks for a
 * recent sign-in (403 `reauth_required`). `seats.line`: why nobody more can be invited when every place is in use.
 */
export type TeamView = {
  members: TeamMember[];
  invitations: TeamInvitation[];
  seats: { used: number; limit: number | null; full: boolean; line: string | null };
  viewer: { userId: string; role: MembershipRole; mayManage: boolean; grantableRoles: MembershipRole[]; mayLeave: boolean; leaveBlockedReason: string | null };
};

/** POST /api/v1/companies/current/members/invite. */
export const InviteMember = z.object({ email: z.email(), role: MembershipRole, name: z.string().trim().min(1).max(120).optional() });
export type InviteMember = z.infer<typeof InviteMember>;

/** What inviting and sending an invitation again answer. `emailed`: the email is on its way; `link` is the invitation's address, to copy when it is not. */
export type InviteAnswer = { ok: true; invitation: TeamInvitation; emailed: boolean; link: string };

/** PATCH /api/v1/companies/current/members/:userId: a new role, or removal. Nobody changes their own membership, and the last owner stays. */
export const UpdateMember = z.object({ role: MembershipRole.optional(), status: z.literal("removed").optional() }).refine((m) => m.role !== undefined || m.status !== undefined, { message: "Send a new role, or remove the person." });
export type UpdateMember = z.infer<typeof UpdateMember>;
export type MemberChanged = { ok: true; userId: string; role: MembershipRole; status: "active" | "removed" };

/** POST /api/v1/companies/current/leave: `{ confirm: true }`. `movedTo`: the other company this person now works in; `signedOut` when there is none. */
export const LeaveCompany = z.object({ confirm: z.literal(true, { message: "Confirm leaving the company." }) }).strict();
export type LeaveCompany = z.infer<typeof LeaveCompany>;
export type LeftCompany = { ok: true; left: string; movedTo: { companyId: string; companyName: string } | null; signedOut: boolean };
