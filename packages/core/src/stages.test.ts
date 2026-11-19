import { describe, expect, it } from "vitest";
import { ApplicationStage, CANDIDATE_STEP_LABEL, IN_PROCESS_STAGES, stageAfterUndo } from "@ros/contracts";
import { canTransition, candidateStep, decisionTold, mayWithdraw, type Mover } from "./stages";

const STAGES = ApplicationStage.options;
const MOVERS: Mover[] = ["system", "team", "candidate"];

describe("the move table", () => {
  it("lets the system read the CV and follow the AI interview, and nothing else", () => {
    const system = STAGES.flatMap((from) => STAGES.filter((to) => from !== to && canTransition(from, to, "system")).map((to) => `${from}>${to}`));
    expect(system.sort()).toEqual([
      "applied>received", "applied>triaged", "received>triaged",
      "screen_invited>screening", "screen_invited>screen_complete", "screening>screen_complete",
      // only when their deletion request is fulfilled
      ...IN_PROCESS_STAGES.map((s) => `${s}>withdrawn`),
    ].sort());
  });

  it("never lets the system hire or decline anyone", () => {
    for (const from of STAGES) {
      expect(canTransition(from, "hired", "system"), from).toBe(false);
      expect(canTransition(from, "rejected", "system"), from).toBe(false);
      expect(canTransition(from, "hired", "candidate"), from).toBe(false);
      expect(canTransition(from, "rejected", "candidate"), from).toBe(false);
    }
  });

  it("lets a person shortlist from New once the CV is read, and cancel the AI interview back to New", () => {
    expect(canTransition("triaged", "screen_invited", "team")).toBe(true);
    for (const from of ["applied", "received", "screen_complete", "hired", "rejected", "withdrawn"] as const) expect(canTransition(from, "screen_invited", "team"), from).toBe(false);
    expect(canTransition("triaged", "screen_invited", "system")).toBe(false);
    expect(canTransition("screen_invited", "triaged", "team")).toBe(true);
    expect(canTransition("screening", "triaged", "team")).toBe(true);
    expect(canTransition("screen_complete", "triaged", "team")).toBe(false);
    expect(canTransition("screening", "triaged", "system")).toBe(false);
  });

  it("lets a person hire or mark Not selected from every stage still in the process, and from no other", () => {
    for (const from of STAGES) {
      const inProcess = IN_PROCESS_STAGES.includes(from);
      expect(canTransition(from, "hired", "team"), `${from} hired`).toBe(inProcess);
      expect(canTransition(from, "rejected", "team"), `${from} rejected`).toBe(inProcess);
    }
  });

  it("lets the candidate withdraw while in the process, and from Not selected until they were told", () => {
    for (const from of IN_PROCESS_STAGES) expect(canTransition(from, "withdrawn", "candidate"), from).toBe(true);
    expect(canTransition("hired", "withdrawn", "candidate")).toBe(false);
    expect(canTransition("rejected", "withdrawn", "candidate", { toldState: "not_told" })).toBe(true);
    expect(canTransition("rejected", "withdrawn", "candidate", { toldState: "queued" })).toBe(true);
    expect(canTransition("rejected", "withdrawn", "candidate", { toldState: "sent" })).toBe(false);
    expect(canTransition("rejected", "withdrawn", "system", { toldState: "not_told" })).toBe(false);
    expect(canTransition("rejected", "withdrawn", "team", { toldState: "not_told" })).toBe(false);
    expect(canTransition("triaged", "withdrawn", "team")).toBe(false);
    expect(mayWithdraw("screening", null)).toBe(true);
    expect(mayWithdraw("rejected", "not_told")).toBe(true);
    expect(mayWithdraw("rejected", "queued")).toBe(true);
    expect(mayWithdraw("rejected", "sent")).toBe(false);
    expect(mayWithdraw("hired", null)).toBe(false);
    expect(mayWithdraw("withdrawn", null)).toBe(false);
  });

  it("has no move out of a decision except the undo, and none at all for someone who withdrew", () => {
    for (const by of MOVERS) {
      for (const to of STAGES) {
        expect(canTransition("withdrawn", to, by), `withdrawn>${to} ${by}`).toBe(false);
        if (to !== "withdrawn") expect(canTransition("rejected", to, by, { toldState: "not_told" }), `rejected>${to} ${by}`).toBe(false);
        expect(canTransition("hired", to, by), `hired>${to} ${by}`).toBe(false);
      }
    }
  });
});

describe("undo", () => {
  it("takes back Hired, and Not selected only while nothing was sent and nothing waits to be sent", () => {
    expect(canTransition("hired", "triaged", "team", { undo: true })).toBe(true);
    expect(canTransition("hired", "screen_complete", "team", { undo: true })).toBe(true);
    expect(canTransition("rejected", "triaged", "team", { undo: true, toldState: "not_told" })).toBe(true);
    expect(canTransition("rejected", "triaged", "team", { undo: true, toldState: "queued" })).toBe(false);
    expect(canTransition("rejected", "triaged", "team", { undo: true, toldState: "sent" })).toBe(false);
  });

  it("is a person's only, goes only where stageAfterUndo can put someone, and undoes nothing but a decision", () => {
    expect(canTransition("hired", "triaged", "system", { undo: true })).toBe(false);
    expect(canTransition("hired", "triaged", "candidate", { undo: true })).toBe(false);
    for (const to of STAGES) expect(canTransition("hired", to, "team", { undo: true }), to).toBe(to === "triaged" || to === "screen_complete");
    for (const from of [...IN_PROCESS_STAGES, "withdrawn"] as const) expect(canTransition(from, "triaged", "team", { undo: true }), from).toBe(false);
    // where the contracts put them: Interviewed if they had sent their answers, otherwise New
    for (const before of STAGES) expect(canTransition("hired", stageAfterUndo(before), "team", { undo: true }), before).toBe(true);
  });
});

describe("the candidate's steps", () => {
  it("reads the stage as one of four steps", () => {
    expect(candidateStep("applied", null)).toBe("received");
    expect(candidateStep("received", null)).toBe("received");
    expect(candidateStep("triaged", null)).toBe("under_review");
    for (const s of ["screen_invited", "screening", "screen_complete"] as const) expect(candidateStep(s, null), s).toBe("interview");
    expect(candidateStep("hired", null)).toBe("decision");
    expect(candidateStep("withdrawn", null)).toBe("decision");
    expect(CANDIDATE_STEP_LABEL.interview).toBe("AI interview");
  });

  it("shows Not selected only once the candidate was told, and the step before it until then", () => {
    expect(candidateStep("rejected", "not_told")).toBe("under_review");
    expect(candidateStep("rejected", "not_told", "applied")).toBe("received");
    expect(candidateStep("rejected", "queued", "screen_complete")).toBe("interview");
    expect(candidateStep("rejected", "sent", "screen_complete")).toBe("decision");
    expect(decisionTold("queued")).toBe(false);
    expect(decisionTold("sent")).toBe(true);
    expect(decisionTold(null)).toBe(false);
  });
});
