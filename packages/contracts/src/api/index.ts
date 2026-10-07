import { z } from "zod";
import { Location } from "../domain/common";
import { RolePacket } from "../domain/role-packet";
import { ApplicationStage, RejectReason } from "../domain/stages";
import { ActionType, PolicyLevel } from "../domain/policy";

/** Slice 1 API request and response schemas. docs/12 is the map. */

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

// Auth
export const MagicLinkRequest = z.object({ email: z.email() });
export const MagicLinkConsume = z.object({ token: z.string().min(10) });

export const MembershipRole = z.enum(["owner", "admin", "hiring_manager", "interviewer", "hr", "recruiter"]);
export type MembershipRole = z.infer<typeof MembershipRole>;

/** The signed-in person as GET /api/v1/auth/me answers it; the API builds this shape and the web client reads it, so neither can drift. */
export const MeResponse = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string().nullable(), platformRole: z.string() }),
  auth: z.object({ provider: z.string(), aal: z.enum(["aal1", "aal2"]), mfaVerifiedAt: z.string().nullable() }),
  memberships: z.array(z.object({ companyId: z.string(), companyName: z.string(), companySlug: z.string(), role: MembershipRole })),
  activeCompanyId: z.string().nullable(),
  /** Present when an ITS recruiter is inside a customer under a scoped, time-limited grant. */
  staffAccess: z.object({ grantId: z.string(), kind: z.string(), purpose: z.string(), expiresAt: z.string(), companyName: z.string().nullable(), scope: z.object({ escalationId: z.string().nullable(), roleId: z.string().nullable(), applicationId: z.string().nullable() }) }).nullable(),
  ai: z.object({ provider: z.string() }),
});
export type MeResponse = z.infer<typeof MeResponse>;

// Companies
/** A real IANA time zone name ("America/Chicago"): interview times and the hours texts may be sent are worked out in it. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
export const CreateCompany = z.object({
  name: z.string().min(2).max(120),
  vertical: z.string().min(2).max(60),
  sizeBand: z.enum(["1-19", "20-49", "50-99", "100-199", "200-499", "500+"]),
  /** The sign-up form sends the owner's own zone; the default stays only for callers that send none. */
  timezone: z.string().min(1).max(64).refine(isTimeZone, { message: "Choose a time zone from the list." }).default("America/Los_Angeles"),
  locations: z.array(Location).min(1),
  ownerName: z.string().min(1).optional(),
  website: z.string().optional(),
});
export type CreateCompany = z.infer<typeof CreateCompany>;

/** The candidate notices a company may reword (mirrors NoticeKey in packages/core/src/compliance.ts; the versions are stamped by the server). */
export const NoticeKey = z.enum(["ai_use", "sms_consent", "recording", "privacy", "pay_transparency", "adverse_decision_explanation"]);
export type NoticeKey = z.infer<typeof NoticeKey>;
const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:00");
/** When the company wants candidates contacted: days 0 (Sunday) to 6, local start and end. Narrows the quiet-hours rule for texts; never widens it. */
export const BusinessHoursInput = z.object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), start: LocalTime, end: LocalTime }).strict()
  .refine((h) => h.start < h.end, { message: "The end time must be after the start time.", path: ["end"] });
export type BusinessHoursInput = z.infer<typeof BusinessHoursInput>;
/** A reworded notice: the text only; the server stamps the version with the date of the change and keeps the jurisdictions. Null puts the standard text back. */
export const NoticeOverrideInput = z.object({ text: z.string().trim().min(20).max(4000) }).strict();
const WebsiteInput = z.string().trim().max(200).refine((v) => v === "" || /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(v), "Use a web address like acme.com");
const LogoUrlInput = z.string().trim().max(500).refine((v) => v === "" || /^https:\/\/\S+$/i.test(v), "Use a full https:// address for the logo");
/**
 * What owners and admins may change themselves (audit findings A8 and J16). Everything else on a company (the plan, the
 * pilot term, the allowances, the status) is set by Identified Talent Solutions and refused here.
 */
export const CompanySettingsInput = z.object({
  website: WebsiteInput.optional(),
  logoUrl: LogoUrlInput.optional(),
  benefitsSummary: z.string().trim().max(2000).optional(),
  careersPage: z.object({ intro: z.string().trim().max(1000).optional() }).strict().optional(),
  businessHours: BusinessHoursInput.nullable().optional(),
  notices: z.partialRecord(NoticeKey, NoticeOverrideInput.nullable()).optional(),
}).strict();
export type CompanySettingsInput = z.infer<typeof CompanySettingsInput>;
export const UpdateCompany = z.object({
  name: z.string().trim().min(2).max(120),
  website: WebsiteInput,
  timezone: z.string().min(1).max(64),
  sizeBand: CreateCompany.shape.sizeBand,
  locations: z.array(Location).min(1).max(20),
  settings: CompanySettingsInput,
}).partial().strict();
export type UpdateCompany = z.infer<typeof UpdateCompany>;

/** The roles a team member can hold. `recruiter` is ITS staff under a scoped grant, never invited or assigned. */
export const TeamRole = z.enum(["owner", "admin", "hiring_manager", "interviewer", "hr"]);
export type TeamRole = z.infer<typeof TeamRole>;

export const InviteMember = z.object({ email: z.email(), role: TeamRole, name: z.string().trim().min(1).max(120).optional() });
export type InviteMember = z.infer<typeof InviteMember>;

/** PATCH /companies/current/members/:userId: a new role, or removal. The route adds the last-owner and owner-only rules. */
export const UpdateMember = z.object({ role: TeamRole.optional(), status: z.enum(["active", "removed"]).optional() });
export type UpdateMember = z.infer<typeof UpdateMember>;

// Intake
export const StartIntake = z.object({ initialMessage: z.string().min(1).max(4000).optional() });
export const IntakeMessageRequest = z.object({ message: z.string().min(1).max(4000) });

// Roles
export const CreatePacketVersion = z.object({ packet: RolePacket, changeSummary: z.string().min(1).max(500) });
export const ApproveRole = z.object({ version: z.number().int().min(1), note: z.string().max(1000).optional() });
export const RoleStatusChange = z.object({ reason: z.string().max(500).optional() });
/** Interviewers per round, from the role page's Interview plan tab; every key must be a round of the current packet. */
export const UpdateInterviewPlan = z.object({ rounds: z.array(z.object({ key: z.string().min(1), interviewerUserIds: z.array(z.string().min(1)).max(10) })).min(1).max(5) });
export type UpdateInterviewPlan = z.infer<typeof UpdateInterviewPlan>;
/** "Request approval again" on a role that was sent back: the latest version unless one is named. */
export const RequestRoleApproval = z.object({ version: z.number().int().min(1).optional() });
export type RequestRoleApproval = z.infer<typeof RequestRoleApproval>;

// Applications
export const ApplicationAction = z.object({
  /** ask_in_screen: invite_screen with `focus: "unknowns"`, the one-click follow-up on an assessment that needs a closer look. */
  action: z.enum(["invite_screen", "ask_in_screen", "advance_to_interview", "reject", "hold", "move_to_talent_pool", "override_eligibility", "review_anyway"]),
  reason: RejectReason.optional(),
  note: z.string().max(2000).optional(),
  /** invite_screen: preferred channel; defaults to SMS with consent, else web chat by email. */
  channel: z.enum(["web", "sms"]).optional(),
  /** invite_screen: "unknowns" opens the screen with the résumé assessment's open questions before the packet's own. */
  focus: z.enum(["unknowns"]).optional(),
});

/** POST /applications/:id/messages: a message a person writes to a candidate (F11). The product adds the sending name and the footer; no disclosure line, since no AI wrote it. */
export const SendCandidateMessage = z.object({ subject: z.string().trim().max(200).optional(), text: z.string().trim().min(1, "Write the message first.").max(5000) });
export type SendCandidateMessage = z.infer<typeof SendCandidateMessage>;

/**
 * Human-recorded hiring outcomes (21 Sep, item 4). A person records what happened; the platform never generates,
 * approves or sends an offer. Deliberately no payroll, tax, identity, banking or onboarding field.
 */
export const ApplicationOutcome = z.enum(["hired_externally", "candidate_withdrew", "employer_declined", "offer_declined_externally", "no_hire"]);
const OutcomeDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-01").refine((d) => { const t = new Date(`${d}T00:00:00Z`); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d; }, "That date does not exist");
export const RecordApplicationOutcome = z.object({
  outcome: ApplicationOutcome,
  confirm: z.literal(true, { message: "Confirm the outcome." }),
  hireDate: OutcomeDate.optional(),
  offerAcceptedAt: OutcomeDate.optional(),
  reason: z.string().max(500).optional(),
  note: z.string().max(2000).optional(),
}).strict();
export const RoleOutcome = z.enum(["filled", "filled_outside_platform", "role_cancelled", "no_hire"]);
export const RecordRoleOutcome = z.object({ outcome: RoleOutcome, confirm: z.literal(true, { message: "Confirm the outcome." }), reason: z.string().max(500).optional() }).strict();
export const CorrectOutcome = z.object({ confirm: z.literal(true), reason: z.string().min(5).max(1000), outcome: z.enum([...ApplicationOutcome.options, ...RoleOutcome.options, "voided"]).optional(), hireDate: OutcomeDate.optional(), offerAcceptedAt: OutcomeDate.optional() }).strict()
  .refine((v) => v.outcome !== "hired_externally" || !!v.hireDate, { message: "A corrected hire needs the hire date.", path: ["hireDate"] });

export const OwnerGroupQuery = z.object({
  group: z.enum(["waiting_on_you", "in_process", "not_moving_forward", "hired"]).optional(),
  stage: ApplicationStage.optional(),
});

// Public apply (candidate)
export const ApplyRequest = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.email(),
  phone: z.string().min(7).max(30).optional(),
  locationText: z.string().max(120).optional(),
  smsConsent: z.boolean().default(false),
  answers: z.record(z.string(), z.unknown()).default({}),
  noResumeAnswers: z.record(z.string(), z.string()).optional(),
  /** Honeypot: must be empty. */
  website: z.string().max(0).optional(),
  noticeVersionsShown: z.array(z.string()).default([]),
  /** The affirmative acknowledgment (docs/readiness/20 section D item 10): an unchecked box the candidate must tick; never pre-checked, never optional. */
  acknowledged: z.literal(true, { message: "Please confirm you have read the notice." }),
});
export type ApplyRequest = z.infer<typeof ApplyRequest>;

// Policies
export const UpsertPolicy = z.object({
  roleId: z.string().nullable().optional(),
  actionType: ActionType,
  level: PolicyLevel,
  approverRoles: z.array(z.string()).default([]),
});

// Approvals
export const DecideApproval = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(2000).optional(),
  edits: z.record(z.string(), z.unknown()).optional(),
});

// Escalations
/**
 * What a recruiter brought in for a request may see: one candidate (and the role they applied for), one role and its
 * candidates, or all of the company's hiring. The ids carry it; "company" must be chosen out loud, never inferred from
 * missing ids, so a request with no role and no candidate is refused unless it says `scope: "company"`.
 */
export const EscalationScope = z.enum(["application", "role", "company"]);
export type EscalationScope = z.infer<typeof EscalationScope>;
export const CreateEscalation = z.object({
  kind: z.enum(["ask", "review", "takeover", "negotiation", "search_support", "candidate_issue"]),
  scope: EscalationScope.optional(),
  roleId: z.string().optional(),
  applicationId: z.string().optional(),
  question: z.string().min(1).max(4000),
  /** Optional; the category sets a default. Shown to recruiters before acceptance (correction 11). */
  urgency: z.enum(["low", "normal", "high", "critical"]).optional(),
});
export type CreateEscalation = z.infer<typeof CreateEscalation>;
export const ResolveEscalation = z.object({ resolution: z.string().min(1).max(4000), /** Recruiter effort, for capacity and pricing (founder decision F12). */ minutesSpent: z.number().int().min(0).max(1440).optional() });

// Emergency access for platform administrators (founder decision F10): MFA, a recorded reason, a short expiry.
export const PlanChange = z.object({ planKey: z.string().min(1), pilotDays: z.number().int().min(1).max(365).optional(), extendUntil: z.string().optional(), reason: z.string().max(500).optional() });

export const BreakGlass = z.object({ companyId: z.string().min(1), reason: z.string().min(10).max(1000), minutes: z.number().int().min(5).max(60).default(30) });

// Owner conversation
export const ConversationMessage = z.object({ message: z.string().min(1).max(4000) });

// Screening (Slice 2)
export const ScreenCandidateMessage = z.object({ message: z.string().min(1).max(2000) });
export const InviteScreenOptions = z.object({ channel: z.enum(["web", "sms"]).optional() });

// Notifications
export const MarkNotificationsRead = z.object({ ids: z.array(z.string()).min(1).max(200) });

// Learning loop: a one-click flag on an AI assessment with the founder context's taxonomy (§23).
export const AssessmentFlagKind = z.enum(["wrong_evidence", "hallucination", "policy_error", "bias_concern", "poor_communication", "wrong_workflow_action", "false_negative", "false_positive", "missing_context"]);
export type AssessmentFlagKind = z.infer<typeof AssessmentFlagKind>;
export const FlagAssessment = z.object({ kind: AssessmentFlagKind, note: z.string().max(2000).optional() });

// Candidate self-service on the status page
export const CandidateSmsPreference = z.object({ pref: z.enum(["on", "off"]) });

// The ITS business calendar (correction 12): every change is a new version with an effective date.
const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
export const HoursWindowInput = z.object({ start: ClockTime, end: ClockTime }).refine((w) => w.start < w.end, { message: "the window must end after it starts" });
const DayHours = z.array(HoursWindowInput).max(4);
export const BusinessCalendarInput = z.object({
  effectiveFrom: IsoDate,
  timeZone: z.string().min(1).refine((tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }, { message: "unknown time zone" }),
  hours: z.object({ sun: DayHours, mon: DayHours, tue: DayHours, wed: DayHours, thu: DayHours, fri: DayHours, sat: DayHours }),
  holidays: z.array(z.object({ date: IsoDate, name: z.string().min(1).max(120) })).max(400).default([]),
  closures: z.array(z.object({ from: IsoDate, to: IsoDate, name: z.string().min(1).max(120) }).refine((c) => c.from <= c.to, { message: "a closure must end on or after it starts" })).max(200).default([]),
  coverageChanges: z.array(z.object({ from: IsoDate, to: IsoDate, reason: z.string().min(1).max(200), hours: z.array(HoursWindowInput).max(4).nullable() }).refine((c) => c.from <= c.to, { message: "a coverage change must end on or after it starts" })).max(200).default([]),
  note: z.string().max(1000).optional(),
});
export type BusinessCalendarInputT = z.infer<typeof BusinessCalendarInput>;
export const RecalculateDeadlines = z.object({ escalationIds: z.array(z.string().min(1)).max(500).optional(), reason: z.string().min(5).max(500) });

// Candidate privacy requests (correction 7; docs/runbooks/privacy-requests.md)
export const DataRequestKind = z.enum(["access", "correct", "delete", "sms_opt_out", "human_review", "withdrawal"]);
export type DataRequestKind = z.infer<typeof DataRequestKind>;
/** The status-page form offers exactly these four; withdrawals and text-message choices have their own controls. */
export const CandidatePrivacyRequest = z.object({ kind: z.enum(["access", "correct", "delete", "human_review"]), details: z.string().max(2000).optional() });
/** The public privacy-request form (audit finding D13): who is asking, what for, in their words; confirmed by an emailed link before anyone acts. `website` is the honeypot. */
export const PrivacyRequestForm = z.object({ email: z.email(), kind: z.enum(["access", "correct", "delete"]), details: z.string().trim().max(2000).optional(), company: z.string().trim().max(80).optional(), website: z.string().max(0).optional() });
export type PrivacyRequestForm = z.infer<typeof PrivacyRequestForm>;
export const AdminCreateDataRequest = z.object({ companyId: z.string().min(1), requesterEmail: z.string().email(), kind: DataRequestKind, details: z.string().max(2000).optional(), candidateId: z.string().optional(), applicationId: z.string().optional() });
export const DataRequestNote = z.object({ text: z.string().min(1).max(2000) });
export const DataRequestAssign = z.object({ userId: z.string().min(1).nullable() });
export const DataRequestVerify = z.object({ method: z.string().min(3).max(300), outcome: z.enum(["verified", "failed"]) });
export const DataRequestCounsel = z.object({ decision: z.enum(["pending", "approved", "declined"]), note: z.string().max(2000).optional() });
export const DataRequestFulfil = z.object({
  resolution: z.string().min(1).max(4000),
  /** correct: the field and the new value; delete: confirmation that the counsel-approved anonymization may run. */
  correction: z.object({ field: z.enum(["firstName", "lastName", "email", "phone", "locationText"]), value: z.string().min(1).max(300) }).optional(),
  confirmAnonymize: z.boolean().optional(),
});
export const DataRequestDecline = z.object({ resolution: z.string().min(1).max(4000) });

// Postings (docs/spec/20 section 2, items 9 to 17): what a person may do to a posting, a tracked link and the accepting switch.
function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !!u.hostname;
  } catch {
    return false;
  }
}
/** The public address of a board posting. Only https; the worker fetches it to decide "live". */
export const RecordPostingUrl = z.object({ url: z.string().trim().max(2048).refine(isHttpsUrl, { message: "Enter the full address of the posting, starting with https://." }) });
/** "I checked it myself": the note says what was checked and when; it is recorded with the person's name. */
export const VerifyPosting = z.object({ note: z.string().trim().min(3, "Say what you checked, in a few words.").max(1000) });
export const PostingReason = z.object({ reason: z.string().trim().max(500).optional() });
/** A person's own tracked link; boards get theirs from the publish workflow. */
export const CreateApplicationLink = z.object({ source: z.enum(["referral", "direct", "other"]), label: z.string().trim().min(1, "Give the link a name.").max(80), sourceDetail: z.string().trim().max(200).optional() });
/** The accepting-applications switch (item 16): distinct from pausing; nobody is turned away. */
export const SetAcceptingApplications = z.object({ accepting: z.boolean(), reason: z.string().trim().max(500).optional() });
