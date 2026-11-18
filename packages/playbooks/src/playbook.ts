/** A vertical playbook: one versioned document per vertical, authored by ITS. */

export type PlaybookRole = {
  key: string;
  title: string;
  aliases: string[];
  summary: string;
  typicalEmploymentTypes: string[];
  eligibility: Array<{ type: string; question: string; expectationByJurisdiction: Record<string, Record<string, unknown>>; rationale: string }>;
  commonQualifications: string[];
  competencies: Array<{ key: string; name: string; definition: string; weight: number; indicators: string[] }>;
  screeningQuestions: Array<{ key: string; question: string; kind: string; competencyKey?: string; modelAnswer?: string }>;
  interviewPlan: Array<{ key: string; title: string; purpose: string; durationMinutes: number; format: string; competencyKeys: string[]; suggestedQuestions: string[] }>;
  redFlags: string[];
  candidateObjections: Array<{ objection: string; response: string }>;
  compensation: Array<{ metro: string; basis: "hourly" | "salary"; p25: number; p50: number; p75: number; source: string; asOf: string }>;
  benchmarks: { applicantsPerHire?: number; screensPerHire?: number; interviewsPerHire?: number; medianDaysToFill?: number };
  channels: string[];
  /**
   * The government occupation (SOC code) market pay is read from for this role. "approximate" when the job has no
   * occupation of its own and the figures are for a broader group (a social media manager is read as a marketing
   * specialist). Without it, the occupation is found from the title.
   */
  occupation?: { soc: string; name: string; match: "close" | "approximate" };
};

export type Playbook = {
  vertical: string;
  version: number;
  name: string;
  summary: string;
  roles: PlaybookRole[];
  generalRedFlags: string[];
  communicationDefaults: { tone: "warm" | "direct" | "formal"; candidateMayBeTold: string[] };
  authoredBy: string;
  reviewedAt: string;
};

type Listed = "aliases" | "typicalEmploymentTypes" | "eligibility" | "commonQualifications" | "competencies" | "screeningQuestions" | "interviewPlan" | "redFlags" | "candidateObjections" | "compensation" | "benchmarks" | "channels";

/** A role as it is written in a playbook file: a list the role does not need may be left out. */
export type PlaybookRoleInput = Omit<PlaybookRole, Listed> &
  Partial<Omit<Pick<PlaybookRole, Listed>, "eligibility" | "interviewPlan">> & {
    eligibility?: Array<Omit<PlaybookRole["eligibility"][number], "expectationByJurisdiction"> & { expectationByJurisdiction?: Record<string, Record<string, unknown>> }>;
    interviewPlan?: Array<Omit<PlaybookRole["interviewPlan"][number], "suggestedQuestions"> & { suggestedQuestions?: string[] }>;
  };

/** A playbook as it is written in its file. */
export type PlaybookInput = Omit<Playbook, "roles" | "generalRedFlags" | "communicationDefaults"> & {
  roles: PlaybookRoleInput[];
  generalRedFlags?: string[];
  communicationDefaults?: { tone?: Playbook["communicationDefaults"]["tone"]; candidateMayBeTold?: string[] };
};

function roleOf(r: PlaybookRoleInput): PlaybookRole {
  return {
    ...r,
    aliases: r.aliases ?? [],
    typicalEmploymentTypes: r.typicalEmploymentTypes ?? ["full_time"],
    eligibility: (r.eligibility ?? []).map((e) => ({ ...e, expectationByJurisdiction: e.expectationByJurisdiction ?? {} })),
    commonQualifications: r.commonQualifications ?? [],
    competencies: r.competencies ?? [],
    screeningQuestions: r.screeningQuestions ?? [],
    interviewPlan: (r.interviewPlan ?? []).map((p) => ({ ...p, suggestedQuestions: p.suggestedQuestions ?? [] })),
    redFlags: r.redFlags ?? [],
    candidateObjections: r.candidateObjections ?? [],
    compensation: r.compensation ?? [],
    benchmarks: r.benchmarks ?? {},
    channels: r.channels ?? [],
  };
}

/** The playbook every reader gets: each list is there, empty when the file left it out. A playbook has at least one role. */
export function playbookOf(input: PlaybookInput): Playbook {
  if (!input.roles.length) throw new Error(`the ${input.vertical} playbook has no roles`);
  return {
    ...input,
    roles: input.roles.map(roleOf),
    generalRedFlags: input.generalRedFlags ?? [],
    communicationDefaults: { tone: input.communicationDefaults?.tone ?? "warm", candidateMayBeTold: input.communicationDefaults?.candidateMayBeTold ?? [] },
  };
}
