import { describe, expect, it } from "vitest";
import { genericSummary, previewSummary, servedSummary } from "./escalation-preview";

/**
 * The queue's summary is template text chosen by category (founder decision I11). Since 15 October 2026 it also says who
 * raised the request: one Recruiting OS raised on its own (a stopped run, a held applicant's reminder, a stalled role)
 * says so instead of "The customer wants...". Rows stored before then read in today's words when served.
 */
describe("the summary of a request Recruiting OS raised on its own", () => {
  const system = (kind: string, opts: { hasRole?: boolean; hasApplication?: boolean } = {}) => genericSummary(kind, { ...opts, origin: "system" });

  it("says a review was raised automatically, about one candidate or about the candidates of the role", () => {
    expect(system("review", { hasRole: true, hasApplication: true })).toBe("Raised automatically by Recruiting OS: one candidate's application needs a recruiter to take over.");
    expect(system("review", { hasRole: false, hasApplication: true })).toBe("Raised automatically by Recruiting OS: one candidate's application needs a recruiter to take over.");
    expect(system("review", { hasRole: true })).toBe("Raised automatically by Recruiting OS: the candidates for this role need a recruiter's review.");
    expect(system("review")).toBe("Raised automatically by Recruiting OS: the candidates for their hiring need a recruiter's review.");
  });

  it("says so for a takeover, a stalled role and any other kind", () => {
    expect(system("takeover", { hasRole: true })).toBe("Raised automatically by Recruiting OS: this role needs ITS to take over.");
    expect(system("stuck_role", { hasRole: true })).toBe("Raised automatically by Recruiting OS: this role has stalled and needs a recruiter.");
    expect(system("negotiation", { hasRole: true })).toBe("Raised automatically by Recruiting OS: this needs a recruiter for this role.");
    expect(system("ask")).toBe("Raised automatically by Recruiting OS: this needs a recruiter for their hiring.");
    expect(system("something_new", { hasRole: true })).toBe("Raised automatically by Recruiting OS: this needs a recruiter for this role.");
  });

  it("keeps a candidate's issue and the posting tasks in their own words", () => {
    expect(system("candidate_issue", { hasRole: true })).toBe("The screening assistant could not continue with a candidate for this role; a person needs to follow up.");
    expect(genericSummary("candidate_issue", { hasRole: true, origin: "candidate" })).toBe("A candidate for this role asked for a person; the hiring team needs a recruiter to follow up.");
    expect(system("post_job", { hasRole: true })).toBe("Post this role on a job board from the customer's own account.");
    expect(system("update_job", { hasRole: true })).toBe("Bring this role's job board listing up to date with the approved version.");
    expect(system("take_down_job", { hasRole: true })).toBe("Take this role's listing down from a job board; the role or the listing was closed.");
  });

  it("leaves the customer's wording exactly as it was", () => {
    expect(genericSummary("review", { hasRole: true, hasApplication: true })).toBe("The customer wants a recruiter to review one candidate for this role.");
    expect(genericSummary("review", { hasRole: true, hasApplication: true, origin: "customer" })).toBe("The customer wants a recruiter to review one candidate for this role.");
    expect(genericSummary("review", { hasRole: true })).toBe("The customer wants a recruiter to review the candidates for this role.");
    expect(genericSummary("ask")).toBe("The customer wants a recruiter's advice for their hiring.");
    expect(genericSummary("takeover", { hasRole: true })).toBe("The customer wants ITS to run this role.");
    expect(genericSummary("stuck_role")).toBe("This role has stalled; the hiring team has not acted on reminders.");
    expect(genericSummary("something_new", { hasRole: true })).toBe("The customer needs a recruiter for this role.");
  });

  it("never carries a person's words or a name: every sentence is one of the templates", () => {
    for (const kind of ["ask", "review", "takeover", "negotiation", "search_support", "stuck_role", "data_request", "platform_blocking"]) {
      for (const hasRole of [true, false]) for (const hasApplication of [true, false]) {
        expect(system(kind, { hasRole, hasApplication })).toMatch(/^Raised automatically by Recruiting OS: [a-z][^:]*\.$/);
      }
    }
  });
});

describe("serving a stored summary (rows made before 15 October 2026)", () => {
  const oldReview = "The customer wants a recruiter to review one candidate for this role.";

  it("turns the old customer template on a request Recruiting OS raised into today's words", () => {
    expect(previewSummary({ kind: "review", storedSummary: oldReview, requestedByKind: "system", hasRole: true, hasApplication: true })).toBe("Raised automatically by Recruiting OS: one candidate's application needs a recruiter to take over.");
    expect(previewSummary({ kind: "stuck_role", storedSummary: "This role has stalled; the hiring team has not acted on reminders.", requestedByKind: "system", hasRole: true, hasApplication: false })).toBe("Raised automatically by Recruiting OS: this role has stalled and needs a recruiter.");
    expect(previewSummary({ kind: "review", storedSummary: "The customer wants a recruiter to review the candidates for this role.", requestedByKind: "system", hasRole: true, hasApplication: false })).toBe("Raised automatically by Recruiting OS: the candidates for this role need a recruiter's review.");
  });

  it("leaves a request the customer, a recruiter or a candidate raised as stored", () => {
    for (const kind of ["user", "recruiter", "candidate", "agent", undefined, null]) {
      expect(previewSummary({ kind: "review", storedSummary: oldReview, requestedByKind: kind, hasRole: true, hasApplication: true })).toBe(oldReview);
    }
  });

  it("leaves a summary that is not the old template as stored: posting tasks, new rows and a candidate's issue", () => {
    const posting = "Post this role on Indeed from the customer's own account.";
    expect(previewSummary({ kind: "post_job", storedSummary: posting, requestedByKind: "system", hasRole: true, hasApplication: false })).toBe(posting);
    expect(previewSummary({ kind: "post_job", storedSummary: genericSummary("post_job"), requestedByKind: "system", hasRole: true, hasApplication: false })).toBe(genericSummary("post_job"));
    const fresh = genericSummary("review", { hasRole: true, hasApplication: true, origin: "system" });
    expect(previewSummary({ kind: "review", storedSummary: fresh, requestedByKind: "system", hasRole: true, hasApplication: true })).toBe(fresh);
    // a candidate who replied HUMAN by email comes through a system actor; the sentence its caller chose stays
    const asked = genericSummary("candidate_issue", { hasRole: true, origin: "candidate" });
    expect(previewSummary({ kind: "candidate_issue", storedSummary: asked, requestedByKind: "system", hasRole: true, hasApplication: true })).toBe(asked);
    // the old template for a different shape (no candidate) is not this row's template
    expect(previewSummary({ kind: "review", storedSummary: oldReview, requestedByKind: "system", hasRole: true, hasApplication: false })).toBe(oldReview);
  });

  it("reads who raised it and what it names from the row", () => {
    expect(servedSummary({ kind: "review", summary: oldReview, requestedBy: { kind: "system" }, roleId: "r1", applicationId: "a1" })).toBe("Raised automatically by Recruiting OS: one candidate's application needs a recruiter to take over.");
    expect(servedSummary({ kind: "review", summary: oldReview, requestedBy: { kind: "user" }, roleId: "r1", applicationId: "a1" })).toBe(oldReview);
    expect(servedSummary({ kind: "review", summary: oldReview, requestedBy: null, roleId: "r1", applicationId: "a1" })).toBe(oldReview);
  });
});
