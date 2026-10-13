import { describe, expect, it } from "vitest";
import { intakeCompilePrompt, type IntakeContext } from "./intake";

const ctx: IntakeContext = {
  company: { name: "Harbor Dental", vertical: "dental", sizeBand: "10-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] },
  playbook: null,
  playbookRole: null,
  benchmark: null,
  facts: { title: "Dental Assistant", mustHaves: [], niceToHaves: [], eligibilityNotes: [], interviewers: [], dealBreakers: [], declinedCriteria: [] },
  messages: [{ role: "owner", content: "A dental assistant in Irvine", at: "2026-10-13T09:00:00.000Z" }],
};
const compile = () => intakeCompilePrompt.system(ctx).map((b) => b.text).join("\n");

describe("intake.compile v5: what staging showed the owner and candidates (13 Oct 2026)", () => {
  it("asks for a few plain assumptions, never field names or stored values", () => {
    expect(intakeCompilePrompt.version).toBe(5);
    expect(compile()).toContain("at most about six, the ones that matter most, each a short plain sentence");
    expect(compile()).toContain('not "facts.dealBreakers is empty"');
    expect(compile()).toContain('not "remotePolicy set to onsite"');
  });

  it("asks one yes/no question per eligibility rule, with its why written to the candidate", () => {
    expect(compile()).toContain('Each question is ONE yes/no question with nothing after it: no second question, no "if yes"');
    expect(compile()).toContain('The rationale is shown to candidates under the question: write it to them, plainly, and never mention "the owner"');
  });

  it("asks for dates as YYYY-MM-DD and lists as arrays, and keeps the length of the screening", () => {
    expect(compile()).toContain("are written YYYY-MM-DD, or left out when there is no date");
    expect(compile()).toContain('{"days": ["Mon","Tue","Wed","Thu","Fri"]}, never "Monday–Friday"');
    expect(compile()).toContain('{"withinDays": 30}');
    expect(compile()).toContain("aim for five or six questions and screening.maxMinutes 10");
  });
});
