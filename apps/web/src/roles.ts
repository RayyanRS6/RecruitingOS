/**
 * What the signed-in person's tenant role may do around interviews, mirrored from the permission matrix in
 * packages/core/src/permissions.ts (the pages do not depend on @ros/core). The API is the authority: every route
 * checks the matrix itself, so these only decide what a page shows, never what is allowed.
 */
export type TenantRole = "owner" | "admin" | "hiring_manager" | "hr" | "interviewer" | "recruiter";

/** interview.request, interview.manage and interview.decide: the same four roles hold all three. */
const INTERVIEW_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin", "hiring_manager", "recruiter"]);

/** Approve an interview round and pick the interviewers. */
export const canRequestInterviews = (role: string | null | undefined): boolean => !!role && INTERVIEW_ROLES.has(role);

/** Re-offer times, cancel, book on the candidate's behalf, record whether any interview took place. */
export const canManageInterviews = (role: string | null | undefined): boolean => !!role && INTERVIEW_ROLES.has(role);

/** Record the decision after an interview. */
export const canDecideInterviews = (role: string | null | undefined): boolean => !!role && INTERVIEW_ROLES.has(role);

/** application.read: every role but interviewer, who only ever sees the candidates they are interviewing. */
export const canSeeTalent = (role: string | null | undefined): boolean => !!role && role !== "interviewer";

/** role.create: who may start a hire (an intake session). HR and interviewers do not. */
const HIRE_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin", "hiring_manager", "recruiter"]);
export const canStartHire = (role: string | null | undefined): boolean => !!role && HIRE_ROLES.has(role);

/**
 * role.manage: pause and resume the role, every posting change (record a board's address, check, pause, resume, close,
 * tick a board off as taken down), tracked links and the accepting-applications switch. Hiring managers, HR and
 * interviewers do not hold it (docs/12-api-contracts.md), so the role page shows them postings read-only.
 */
const MANAGE_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin", "recruiter"]);
export const canManageRole = (role: string | null | undefined): boolean => !!role && MANAGE_ROLES.has(role);

/** packet.edit: edit the role packet, assign interviewers on the Interview plan tab, ask for approval again. */
const PACKET_EDIT_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin", "hiring_manager", "recruiter"]);
export const canEditPacket = (role: string | null | undefined): boolean => !!role && PACKET_EDIT_ROLES.has(role);

/**
 * The packet editor's "Everything (advanced)": the whole packet as JSON (plan C11). Kept to admins and recruiters; every
 * other editor uses the plain fields, which cover everything an owner or hiring manager changes.
 */
const PACKET_JSON_ROLES: ReadonlySet<string> = new Set<TenantRole>(["admin", "recruiter"]);
export const canEditPacketJson = (role: string | null | undefined): boolean => !!role && PACKET_JSON_ROLES.has(role);

/** outcome.record: close a role with its outcome (the decision-makers and HR; not a recruiter, not an interviewer). */
const OUTCOME_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin", "hiring_manager", "hr"]);
export const canRecordOutcome = (role: string | null | undefined): boolean => !!role && OUTCOME_ROLES.has(role);

/**
 * application.reject: move someone to Not moving forward, and tell candidates a decision (send the decision message, or
 * record telling them in person). HR and interviewers do not hold it.
 */
const DECLINE_ROLES: ReadonlySet<string> = new Set<TenantRole>(["owner", "admin", "hiring_manager", "recruiter"]);
export const canDecline = (role: string | null | undefined): boolean => !!role && DECLINE_ROLES.has(role);

/** events.read: the role's Activity tab. Everyone but an interviewer. */
export const canSeeActivity = (role: string | null | undefined): boolean => !!role && role !== "interviewer";

/**
 * escalation.create: bring in a recruiter, and read and answer the team's recruiter requests. Everyone but an
 * interviewer (an ITS recruiter inside a customer asks only within their grant; the API holds them to it).
 */
export const canAskRecruiter = (role: string | null | undefined): boolean => !!role && role !== "interviewer";
