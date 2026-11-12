import { describe, expect, it } from "vitest";
// The real dental playbook, read by path: @ros/ai does not depend on @ros/playbooks.
import { dentalPlaybook } from "../../../playbooks/src/dental.v1";
import { OWNERS_CALL_MARK, PANEL_CHANGE_NOTE, intakeCompilePrompt, intakeTurnPrompt, type IntakeContext } from "./intake";

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
    expect(intakeCompilePrompt.version).toBe(6);
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

describe("intake.compile v6: what the live test showed (12 Nov 2026)", () => {
  it("writes a must-have worded as what rules someone out as the requirement, and never turns a deal-breaker into one by itself", () => {
    expect(intakeCompilePrompt.version).toBe(6);
    expect(compile()).toContain('One worded as what rules someone out is written as the requirement, never kept as written: "No active California RDA license" is "Active California RDA license".');
    // a deal-breaker becomes a requirement, or a question on the form, only once the owner counts it openly
    expect(compile()).toContain("never turn deal-breakers into requirements or questions on the form yourself: the owner counts a deal-breaker openly, and then its requirement is in facts.mustHaves");
  });

  it("puts exactly the owner's questions on the form only once the owner went through them, each holding a No for the owner's decision", () => {
    // the server's marker (the quick start's step 9), never a note on its own: a note the assistant read from a sentence
    // or an ad is not the owner going through the questions (review of the live-test fixes, 12 Nov 2026)
    const chose = (facts: Partial<IntakeContext["facts"]>) => intakeCompilePrompt.system({ ...ctx, facts: { ...ctx.facts, ...facts } }).map((b) => b.text).join("\n");
    const EXACTLY = "the form has exactly the owner's chosen questions";
    const notes = chose({ eligibilityNotes: ["Able to work Saturdays"] });
    expect(notes).not.toContain(EXACTLY);
    expect(notes).toContain("Questions on the form: the owner has not gone through them. Start from the playbook's typical eligibility");
    expect(notes).toContain("add one rule for each of the owner's notes (facts.eligibilityNotes) that no rule asks yet");
    expect(notes).toContain('never use one they left unticked (facts.suggestions with field "eligibility")');
    // an unticked question alone is no marker either: only the server sets it
    expect(chose({ suggestions: [{ field: "eligibility", text: "Do you hold current CPR/BLS certification?", origin: "playbook" }] })).not.toContain(EXACTLY);
    const marked = chose({ eligibilityNotes: ["Do you hold current CPR/BLS certification?"], formQuestionsChosen: true });
    expect(marked).toContain(`Questions on the form: the owner went through them, so ${EXACTLY} (facts.eligibilityNotes), and none of the ones they left unticked`);
    expect(marked).not.toContain("Start from the playbook's typical eligibility");
    // the line is its own block after the cached ones, so both kinds of draft keep the cache
    expect(intakeCompilePrompt.system({ ...ctx, facts: { ...ctx.facts, formQuestionsChosen: true } }).filter((b) => b.text.startsWith("Questions on the form:")).map((b) => b.cache)).toEqual([undefined]);
    // an owner's-call question goes on only when the owner asked for it, never because of a deal-breaker alone, which the
    // assistant never turns into a question on the form itself
    expect(compile()).toContain('a question marked "(ask only when the owner requires it)" goes on the form only when the owner named it among the must-haves or asked for it in their own words as a requirement, never a deal-breaker alone');
    expect(compile()).not.toMatch(/\bor said so\b/);
    // one rule per deal-breaker counted openly, never a question the owner left unticked
    expect(compile()).toContain("add one rule for each deal-breaker the owner counted openly (its requirement is in facts.mustHaves)");
    expect(compile()).toContain("unless a rule already asks it or the owner left a question asking it unticked");
    expect(compile()).toContain("Every rule holds the application for the owner's decision when the answer is No (knockout true); nobody is declined by it.");
  });

  it("keeps why the owner is hiring out of the public description, and never adds a skill that is a must-have under another name", () => {
    expect(compile()).toContain("The description is public: never write why the owner is hiring into it");
    expect(compile()).toContain("never add a skill that is the same as a must-have, under any name: the must-have already counts it");
    expect(compile()).not.toContain("never name one the same as a must-have");
  });

  it("marks the Dental Assistant's RDA question as the owner's call in the draft's prompt only, and no other question", () => {
    const role = (key: string) => dentalPlaybook.roles.find((r) => r.key === key)!;
    // the playbook's part of the system text (the second block of intake.compile)
    const playbookText = (key: string) => intakeCompilePrompt.system({ ...ctx, playbook: dentalPlaybook, playbookRole: role(key) })[1].text;
    const da = playbookText("da");
    expect(da).toContain(`license: Do you hold an active Registered Dental Assistant (RDA) license in the state where this office is located?${OWNERS_CALL_MARK} | certification:`);
    expect(da).not.toMatch(/Answer 'not required'|if the owner did not require it/);
    // the hygienist's licence is required by law, so it carries no mark, and no other role has one
    expect(playbookText("rdh")).toContain("license: Do you hold an active dental hygiene (RDH) license in the state where this office is located? | certification:");
    for (const r of dentalPlaybook.roles) expect(playbookText(r.key).split(OWNERS_CALL_MARK).length - 1, r.key).toBe(r.key === "da" ? 1 : 0);
  });

  it("never shows the mark to intake.turn, which writes the cards the owner reads (review of the live-test fixes, 12 Nov 2026)", () => {
    const da = dentalPlaybook.roles.find((r) => r.key === "da")!;
    const turn = intakeTurnPrompt.system({ ...ctx, playbook: dentalPlaybook, playbookRole: da });
    expect(turn.map((b) => b.text).join("\n")).not.toContain(OWNERS_CALL_MARK.trim());
    expect(turn.map((b) => b.text).join("\n")).not.toMatch(/ask only when/i);
    // the same playbook block as the draft's, the question written for candidates, without the mark
    expect(turn[1].text).toContain("license: Do you hold an active Registered Dental Assistant (RDA) license in the state where this office is located? | certification:");
    expect(turn[1].text).toBe(intakeCompilePrompt.system({ ...ctx, playbook: dentalPlaybook, playbookRole: da })[1].text.replace(OWNERS_CALL_MARK, ""));
    // its words changed from the released v5 (the reworded question), so it is a version of its own
    expect(intakeTurnPrompt.version).toBe(6);
  });
});

describe("intake.turn's conversation", () => {
  const assistant = { role: "assistant" as const, content: "Thanks. Two quick questions on the right.", at: "2026-10-13T09:00:05.000Z" };
  it("always ends with the owner's turn, which Haiku 5.5 and Sonnet 5.5 require", () => {
    // the owner changed an answer on the panel and wrote nothing, so the last stored line is the assistant's
    const turns = intakeTurnPrompt.messages({ ...ctx, messages: [...ctx.messages, assistant] });
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(turns.at(-1)!.content).toBe(PANEL_CHANGE_NOTE);
  });

  it("adds nothing when the owner spoke last, and the draft's transcript never carries the note", () => {
    expect(intakeTurnPrompt.messages(ctx)).toEqual([{ role: "user", content: "A dental assistant in Irvine" }]);
    const compileText = intakeCompilePrompt.messages({ ...ctx, messages: [...ctx.messages, assistant] }).map((m) => m.content).join("\n");
    expect(compileText).not.toContain(PANEL_CHANGE_NOTE);
  });
});
