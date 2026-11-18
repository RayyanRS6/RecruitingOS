/**
 * The addresses of the signed-in app that the server writes into an update's link, a team email or a redirect. The web
 * app serves every one of them; neither side spells an address of its own. The candidate's pages are not here: they are
 * the API's own and no screen of the app links to them, except a job's public addresses (`JobUrls`).
 */
export const appPaths = {
  home: "/",
  login: "/login",
  /** The company details form, and the "request sent" screen after it. */
  companyDetails: "/setup/company",
  jobs: "/roles",
  /** The job builder's start. */
  newJob: "/roles/new",
  /** A draft in the job builder. */
  draft: (sessionId: string): string => `/roles/new?session=${sessionId}`,
  /** A job's page, on its Job tab. */
  job: (roleId: string): string => `/roles/${roleId}`,
  /** A job's Share tab. */
  jobShare: (roleId: string): string => `/roles/${roleId}?tab=share`,
  /** A job's Candidates tab; `tab` opens it on one of its five tabs. */
  candidates: (roleId: string, tab?: string): string => `/roles/${roleId}/talent${tab ? `?tab=${tab}` : ""}`,
  /** One candidate's panel, open over their job's Candidates tab. */
  candidate: (roleId: string, applicationId: string): string => `/roles/${roleId}/talent?open=${applicationId}`,
  /** Candidates in the side rail: the same list, with a job picker. */
  allCandidates: "/talent",
  settings: "/setup",
  updates: "/updates",
  /** The admin dashboard: Companies, Privacy requests, System. */
  admin: "/admin",
  adminCompany: (companyId: string): string => `/admin?open=${companyId}`,
  adminPrivacy: "/admin/privacy",
  adminSystem: "/admin/system",
} as const;
