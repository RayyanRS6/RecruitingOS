import { describe, expect, it } from "vitest";
import { AI_INTERVIEW_STATUS_LABEL, ApplicationStage, CANDIDATE_STEP_LABEL, CANDIDATE_TAB_LABEL, CandidateStep, CandidateTab, IN_PROCESS_STAGES, ROLE_STATUS_LABEL, RoleStatus, STAGE_LABEL, STAGE_TAB, TERMINAL_STAGES, ToldState, inProcess, stageAfterUndo, stageLabel, tabOf } from "./stages";

describe("the stages of an application", () => {
  it("are exactly nine, and nothing of the removed steps is one", () => {
    expect(ApplicationStage.options).toEqual(["applied", "received", "triaged", "screen_invited", "screening", "screen_complete", "hired", "rejected", "withdrawn"]);
    for (const gone of ["ineligible", "eligible", "interview_recommended", "interview_scheduled", "finalist", "offer_sent", "declined", "talent_pool", "onboarding"]) expect(ApplicationStage.safeParse(gone).success, gone).toBe(false);
  });

  it("splits into still in the process and out of it, with nobody in both", () => {
    expect(IN_PROCESS_STAGES).toEqual(["applied", "received", "triaged", "screen_invited", "screening", "screen_complete"]);
    expect([...TERMINAL_STAGES].sort()).toEqual(["hired", "rejected", "withdrawn"]);
    for (const stage of ApplicationStage.options) expect(inProcess(stage), stage).toBe(IN_PROCESS_STAGES.includes(stage));
  });

  it("puts an undone decision back in the process: Interviewed for someone who had sent their answers, New for anyone else", () => {
    expect(stageAfterUndo("screen_complete")).toBe("screen_complete");
    for (const before of ["applied", "received", "triaged", "screen_invited", "screening", null, undefined] as const) expect(stageAfterUndo(before), String(before)).toBe("triaged");
    for (const stage of ApplicationStage.options) expect(inProcess(stageAfterUndo(stage)), stage).toBe(true);
  });
});

describe("the tab a person is listed under", () => {
  it("has five tabs, in the order they are shown, each with its word", () => {
    expect(CandidateTab.options).toEqual(["new", "shortlisted", "interviewed", "hired", "not_selected"]);
    expect(CandidateTab.options.map((t) => CANDIDATE_TAB_LABEL[t])).toEqual(["New", "Shortlisted", "Interviewed", "Hired", "Not selected"]);
  });

  it("comes from the stage alone: New, Shortlisted, Interviewed, Hired, Not selected", () => {
    expect(ApplicationStage.options.map((s) => [s, tabOf(s)])).toEqual([
      ["applied", "new"],
      ["received", "new"],
      ["triaged", "new"],
      ["screen_invited", "shortlisted"],
      ["screening", "shortlisted"],
      ["screen_complete", "interviewed"],
      ["hired", "hired"],
      ["rejected", "not_selected"],
      ["withdrawn", "not_selected"],
    ]);
    expect(Object.keys(STAGE_TAB).sort()).toEqual([...ApplicationStage.options].sort());
  });

  it("lists someone who withdrew under Not selected, labelled as their own choice", () => {
    expect(tabOf("withdrawn")).toBe("not_selected");
    expect(stageLabel("withdrawn")).toBe("Withdrew");
    expect(stageLabel("rejected")).toBe("Not selected");
  });
});

describe("the words for where a person is", () => {
  it("has one label for every stage", () => {
    expect(STAGE_LABEL).toEqual({ applied: "New", received: "New", triaged: "New", screen_invited: "AI interview sent", screening: "AI interview started", screen_complete: "Interviewed", hired: "Hired", rejected: "Not selected", withdrawn: "Withdrew" });
    for (const stage of ApplicationStage.options) expect(stageLabel(stage), stage).toBe(STAGE_LABEL[stage]);
  });

  it("says where the AI interview stands for someone shortlisted, and only for them", () => {
    expect(stageLabel("screen_invited", "sent")).toBe("AI interview sent");
    expect(stageLabel("screening", "started")).toBe("AI interview started");
    expect(stageLabel("screen_invited", "link_closed")).toBe("AI interview link closed");
    expect(stageLabel("screening", "link_closed")).toBe("AI interview link closed");
    expect(stageLabel("screen_invited", "opted_out")).toBe("Chose not to do the AI interview");
    // out of Shortlisted the stage speaks for itself
    expect(stageLabel("screen_complete", "done")).toBe("Interviewed");
    expect(stageLabel("triaged", "link_closed")).toBe("New");
    expect(stageLabel("hired", "done")).toBe("Hired");
    expect(Object.keys(AI_INTERVIEW_STATUS_LABEL)).toEqual(["sent", "started", "link_closed", "opted_out", "done"]);
  });
});

describe("the other small lists", () => {
  it("a decision is not told, on its way, or sent", () => {
    expect(ToldState.options).toEqual(["not_told", "queued", "sent"]);
    for (const gone of ["told_in_person", "before_tracking"]) expect(ToldState.safeParse(gone).success, gone).toBe(false);
  });

  it("a candidate sees four steps, the third named for the AI interview", () => {
    expect(CandidateStep.options.map((s) => CANDIDATE_STEP_LABEL[s])).toEqual(["Received", "Under review", "AI interview", "Decision"]);
  });

  it("a job is a draft, open, paused or closed", () => {
    expect(RoleStatus.options.map((s) => ROLE_STATUS_LABEL[s])).toEqual(["Draft", "Open", "Paused", "Closed"]);
    for (const gone of ["pending_approval", "filled"]) expect(RoleStatus.safeParse(gone).success, gone).toBe(false);
  });
});
