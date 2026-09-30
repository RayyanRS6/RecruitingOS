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
