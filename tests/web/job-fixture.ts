import { ROLE_STATUS_LABEL, RolePacket, roleActions, type CandidateCounts, type RoleDetail, type RoleStatus, type RoleSummary } from "../../packages/contracts/src/index";

/**
 * A made-up job for the tests of the company's pages: a job record that parses as the contracts' own, and the shapes
 * the API answers for it. The actions are made with the contracts' own rule (`roleActions`), as the API makes them.
 */
export function jobPacket(over: Record<string, unknown> = {}): RolePacket {
  return RolePacket.parse({
    identity: { title: "Dental Assistant", department: "Clinical", locations: [{ city: "Irvine", region: "CA", country: "US", timezone: "America/Los_Angeles" }], employmentType: "full_time", schedule: "Weekdays, 8 to 5", remotePolicy: "onsite" },
    compensation: { basis: "hourly", min: 24, max: 28, discloseRange: true, benefitsSummary: "Health, dental and paid time off" },
    description: { publicJobDescription: "We are a family dental practice looking for a dental assistant who likes people and keeps a tidy operatory." },
    requirements: { mustHaves: [{ key: "m1", text: "Active RDA licence", rationale: "State law." }, { key: "m2", text: "Two years chairside" }], niceToHaves: [{ key: "n1", text: "Spanish" }] },
    competencies: [{ key: "s1", name: "Digital radiography", definition: "Takes and reads digital x-rays.", importance: "important", indicators: ["x-ray"] }],
    screening: { questions: [{ key: "q1", question: "Tell us about a busy day.", modelAnswer: "A concrete example." }, { key: "q2", question: "How do you sterilise instruments?" }, { key: "q3", question: "Why this practice?" }], maxMinutes: 10 },
    formQuestions: [
      { kind: "yes_no", key: "f1", question: "Can you work Saturdays?", required: true },
      { kind: "choice", key: "f2", question: "Which shift suits you?", required: false, options: ["Days", "Evenings"] },
      { kind: "number", key: "f3", question: "Years of chairside experience?", required: true, unit: "years", min: 0, max: 40 },
    ],
    communication: { companyBlurb: "A family dental practice.", signature: "The team", disclosureText: "An AI assistant helps with parts of this process.", humanAlternativeText: "You can ask for a person at any time." },
    compliance: { jurisdictions: ["US-CA"], notices: [] },
    provenance: {},
    ...over,
  });
}

export function jobCounts(byTab: Partial<CandidateCounts["byTab"]> = {}, locked = 0): CandidateCounts {
  const tabs = { new: 0, shortlisted: 0, interviewed: 0, hired: 0, not_selected: 0, ...byTab };
  return { total: Object.values(tabs).reduce((n, x) => n + x, 0) + locked, byTab: tabs, locked };
}

export function jobSummary(id: string, status: RoleStatus, over: Partial<RoleSummary> = {}): RoleSummary {
  const published = status === "draft" ? null : "2026-11-10T16:00:00.000Z";
  return {
    id, title: "Dental Assistant", status, statusLabel: ROLE_STATUS_LABEL[status], createdAt: "2026-11-08T16:00:00.000Z", openedAt: published, closedAt: status === "closed" ? "2026-11-17T16:00:00.000Z" : null,
    daysOpen: published ? 8 : null, lastActivityAt: "2026-11-17T16:00:00.000Z", closesOn: null, acceptingApplications: status === "open", counts: jobCounts(), ...over,
  };
}

export function jobDetail(id: string, status: RoleStatus, role: "owner" | "admin" | "hiring_manager" = "owner", over: Partial<RoleDetail> = {}): RoleDetail {
  return {
    ...jobSummary(id, status),
    version: status === "draft" ? null : 2,
    packet: jobPacket(),
    payShown: true,
    payRequiredByLaw: true,
    closingDate: { closesOn: null, closesAt: null, applyBy: null, timeZone: "America/Los_Angeles", requiredByLaw: false, defaultIfMissing: null, passed: false, applicationsClosedByDate: false },
    legalCheck: null,
    flags: [],
    urls: { careers: "https://jobs.test/careers/bright", job: `https://jobs.test/careers/bright/jobs/${id}`, apply: `https://jobs.test/careers/bright/jobs/${id}/apply` },
    public: status === "open" || status === "paused",
    publish: status === "draft" ? { allowed: true, blockers: [] } : null,
    actions: roleActions({ status, role, trialEnded: false }),
    ...over,
  };
}
