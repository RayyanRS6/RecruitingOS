/**
 * What the signed-in person's tenant role may do around interviews, mirrored from the permission matrix in
 * packages/core/src/permissions.ts (the pages do not depend on @ros/core). The API is the authority: every route
 * checks the matrix itself, so these only decide what a page shows, never what is allowed.
 */
export type TenantRole = "owner" | "admin" | "hiring_manager" | "hr" | "interviewer";

/** interview.request, interview.manage and interview.decide: the same three roles hold all three. */
const INTERVIEW_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin", "hiring_manager"]);

/** Set up an interview round: set its date and time (the press is the approval), and pick the interviewers. */
export const canRequestInterviews = (role: string | null | undefined): boolean => !!role && INTERVIEW_ROLES.has(role);

/** Set or move a date and time, re-offer times, cancel, book on the candidate's behalf, record whether any interview took place. */
export const canManageInterviews = (role: string | null | undefined): boolean => !!role && INTERVIEW_ROLES.has(role);

/** Record the decision after an interview. */
export const canDecideInterviews = (role: string | null | undefined): boolean => !!role && INTERVIEW_ROLES.has(role);

/** application.read: every role but interviewer, who only ever sees the candidates they are interviewing. */
export const canSeeTalent = (role: string | null | undefined): boolean => !!role && role !== "interviewer";

/** role.create: who may start a hire (an intake session). HR and interviewers do not. */
const HIRE_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin", "hiring_manager"]);
export const canStartHire = (role: string | null | undefined): boolean => !!role && HIRE_ROLES.has(role);

/**
 * role.manage: pause and resume the role, every posting change (record a board's address, check, pause, resume, close,
 * tick a board off as taken down), tracked links and the accepting-applications switch. Hiring managers, HR and
 * interviewers do not hold it (docs/12-api-contracts.md), so the role page shows them postings read-only.
 */
const MANAGE_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin"]);
export const canManageRole = (role: string | null | undefined): boolean => !!role && MANAGE_ROLES.has(role);

/** packet.edit: edit the role packet, assign interviewers on the Interview plan tab, ask for approval again. */
const PACKET_EDIT_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin", "hiring_manager"]);
export const canEditPacket = (role: string | null | undefined): boolean => !!role && PACKET_EDIT_ROLES.has(role);

/**
 * "Try different weights" (founder decision L-07 A, preview only): whoever may edit the job (packet.edit) and read its
 * applicants (application.read), so never an interviewer and never HR. Nothing is sent or saved, so the page alone
 * decides.
 */
export const canTryWeights = (role: string | null | undefined): boolean => canEditPacket(role) && canSeeTalent(role);

/**
 * The packet editor's "Everything (advanced)": the whole packet as JSON (plan C11). Kept to admins; every other editor
 * uses the plain fields, which cover everything an owner or hiring manager changes.
 */
export const canEditPacketJson = (role: string | null | undefined): boolean => role === "admin";

/** role.approve: approve a role packet (owners, admins and hiring managers). */
const APPROVE_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin", "hiring_manager"]);
export const canApproveRole = (role: string | null | undefined): boolean => !!role && APPROVE_ROLES.has(role);

/** compensation.read: the pay, and so the job page preview that shows it (plan D1). Everyone but an interviewer. */
export const canSeePay = (role: string | null | undefined): boolean => !!role && role !== "interviewer";

/**
 * Sharing a job (plan D8): POST /roles/:id/share-links is open to those who manage postings and to those who approve
 * roles, so whoever approved the job can share it straight away.
 */
export const canShareJob = (role: string | null | undefined): boolean => canManageRole(role) || canApproveRole(role);

/** company.update: the company's own details in Setup, its "about" text and logo. Owners and admins. */
const COMPANY_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin"]);
export const canChangeCompany = (role: string | null | undefined): boolean => !!role && COMPANY_ROLES.has(role);

/** outcome.record: close a role with its outcome (the decision-makers and HR; not an interviewer). */
const OUTCOME_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin", "hiring_manager", "hr"]);
export const canRecordOutcome = (role: string | null | undefined): boolean => !!role && OUTCOME_ROLES.has(role);

/**
 * application.reject: move someone to Not moving forward, and tell candidates a decision (send the decision message, or
 * record telling them in person). HR and interviewers do not hold it.
 */
const DECLINE_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin", "hiring_manager"]);
export const canDecline = (role: string | null | undefined): boolean => !!role && DECLINE_ROLES.has(role);

/**
 * note.read and note.write: read every private team note on a candidate and write one's own (founder decision Q24).
 * Interviewers hold neither: they write and read only their own note, on people they interviewed.
 */
const NOTE_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin", "hiring_manager", "hr"]);
export const canReadNotes = (role: string | null | undefined): boolean => !!role && NOTE_ROLES.has(role);

/** events.read: the role's Activity tab. Everyone but an interviewer. */
export const canSeeActivity = (role: string | null | undefined): boolean => !!role && role !== "interviewer";

/** plan.request: ask ITS to change the company's plan. Everyone but an interviewer. */
export const canRequestPlan = (role: string | null | undefined): boolean => !!role && role !== "interviewer";
