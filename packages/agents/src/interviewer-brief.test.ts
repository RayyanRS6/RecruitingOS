import { describe, expect, it } from "vitest";
import { renderInterviewerBriefText, type InterviewerBrief } from "./interviewer-brief";

/**
 * The interviewer's brief in the confirmation email (docs/spec/21 F7). The live test of 12 November 2026 read "Practice
 * software: not assessed yet" for a skill the owner had set to "Only in your own interviews", which no AI review reads: the
 * email says it is for this interview, so it never reads as something the AI missed.
 */
describe("the interviewer's brief in words", () => {
  const skill = (key: string, name: string, evaluatedIn: "screen" | "interview" | "both", finding: InterviewerBrief["competencies"][number]["finding"] = null) => ({ key, name, definition: `${name} defined.`, indicators: [], finding, note: null, evaluatedIn });
  const brief = (competencies: InterviewerBrief["competencies"]): InterviewerBrief => ({ candidateFirstName: "Maya", round: { key: "r1", title: "Working interview", purpose: "See the chairside work.", durationMinutes: 45, format: "onsite" }, competencies, questions: [], mustHaves: [], strengths: [], concerns: [], screen: null, pay: null, includesPay: false });

  it("says a skill checked only in the team's own interviews is for this interview, and the others what the readings found", () => {
    const text = renderInterviewerBriefText(brief([skill("software", "Practice software", "interview"), skill("chairside", "Chairside skill", "both"), skill("patients", "Patient care", "both", "evidenced"), { ...skill("old", "old round key", "both"), evaluatedIn: null }]));
    expect(text).toContain("- Practice software: Practice software defined. (for this interview)");
    expect(text).not.toContain("Practice software defined. (not assessed yet)");
    expect(text).toContain("- Chairside skill: Chairside skill defined. (not assessed yet)");
    expect(text).toContain("- Patient care: Patient care defined. (so far: seen in the evidence)");
    // a round key the role has no skill for says nothing about own interviews
    expect(text).toContain("- old round key: old round key defined. (not assessed yet)");
  });
});
