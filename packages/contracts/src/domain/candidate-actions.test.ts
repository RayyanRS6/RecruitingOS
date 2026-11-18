import { describe, expect, it } from "vitest";
import { ACTION_BLOCKED, BulkCandidateAction, CANDIDATE_ACTION_LABEL, CandidateAction, candidateActionState, candidateActions, type CandidateActionFacts } from "./candidate-actions";
import { ApplicationStage } from "./stages";

const facts = (over: Partial<CandidateActionFacts> = {}): CandidateActionFacts => ({ stage: "triaged", aiInterview: null, toldState: null, decisionEmailWaiting: false, reachable: true, remindedRecently: false, roleStatus: "open", planStop: null, ...over });
const names = (f: CandidateActionFacts) => candidateActions(f).map((a) => a.action);
const allowed = (f: CandidateActionFacts) => candidateActions(f).filter((a) => a.allowed).map((a) => a.action);

describe("what a team can do with a candidate", () => {
  it("is nine actions, each with its button's words, four of them for several people at once", () => {
    expect(CandidateAction.options).toEqual(["shortlist", "remind_screen", "send_new_link", "cancel_screen", "hire", "reject", "undo_decision", "send_decision", "unsend_decision"]);
    expect(CANDIDATE_ACTION_LABEL).toEqual({ shortlist: "Shortlist", remind_screen: "Send a reminder", send_new_link: "Send a new link", cancel_screen: "Cancel the AI interview", hire: "Hire", reject: "Not selected", undo_decision: "Undo", send_decision: "Email the decision", unsend_decision: "Don't send" });
    expect(BulkCandidateAction.options).toEqual(["shortlist", "reject", "send_decision", "unsend_decision"]);
  });

  it("offers Shortlist, Hire and Not selected to someone in New, and Shortlist only once their CV was read", () => {
    expect(candidateActions(facts())).toEqual([
      { action: "shortlist", label: "Shortlist", allowed: true, reason: null },
      { action: "hire", label: "Hire", allowed: true, reason: null },
      { action: "reject", label: "Not selected", allowed: true, reason: null },
    ]);
    for (const stage of ["applied", "received"] as const) {
      expect(names(facts({ stage }))).toEqual(["shortlist", "hire", "reject"]);
      expect(candidateActionState(facts({ stage }), "shortlist")).toMatchObject({ allowed: false, reason: ACTION_BLOCKED.beingRead });
      expect(allowed(facts({ stage }))).toEqual(["hire", "reject"]);
    }
  });

  it("refuses Shortlist with a plain reason: no working address, a closed job, or the plan", () => {
    expect(candidateActionState(facts({ reachable: false }), "shortlist")?.reason).toBe("There is no email address that works for them, so nothing can be sent.");
    expect(candidateActionState(facts({ roleStatus: "closed" }), "shortlist")?.reason).toBe("This job is closed.");
    expect(candidateActionState(facts({ planStop: "ai_interviews_used_up" }), "shortlist")?.reason).toBe("This month's AI interviews are used up.");
    expect(candidateActionState(facts({ planStop: "ai_used_up" }), "shortlist")?.reason).toBe("Your plan's AI help is used up.");
    expect(candidateActionState(facts({ planStop: "trial_ended" }), "shortlist")?.reason).toBe("Your trial has ended. New applications are paused until a plan is chosen. Contact ITS to choose a plan.");
    // a paused job still takes its people forward
    expect(candidateActionState(facts({ roleStatus: "paused" }), "shortlist")?.allowed).toBe(true);
    // the plan never stops a hire or a decision
    expect(allowed(facts({ planStop: "ai_used_up", reachable: false, roleStatus: "closed" }))).toEqual(["hire", "reject"]);
  });

  it("offers a reminder while the AI interview's link is open, at most once a day", () => {
    for (const [stage, aiInterview] of [["screen_invited", "sent"], ["screening", "started"]] as const) {
      expect(names(facts({ stage, aiInterview }))).toEqual(["remind_screen", "cancel_screen", "hire", "reject"]);
      expect(allowed(facts({ stage, aiInterview }))).toEqual(["remind_screen", "cancel_screen", "hire", "reject"]);
      expect(candidateActionState(facts({ stage, aiInterview, remindedRecently: true }), "remind_screen")?.reason).toBe(ACTION_BLOCKED.remindedRecently);
      expect(candidateActionState(facts({ stage, aiInterview, reachable: false }), "remind_screen")?.reason).toBe(ACTION_BLOCKED.noEmail);
      // a reminder is no new AI interview, so the plan does not stop it
      expect(candidateActionState(facts({ stage, aiInterview, planStop: "ai_interviews_used_up" }), "remind_screen")?.allowed).toBe(true);
    }
  });

  it("offers a new link once the first one closed, and neither a link nor a reminder to someone who chose not to do it", () => {
    expect(names(facts({ stage: "screen_invited", aiInterview: "link_closed" }))).toEqual(["send_new_link", "cancel_screen", "hire", "reject"]);
    expect(candidateActionState(facts({ stage: "screening", aiInterview: "link_closed", planStop: "ai_interviews_used_up" }), "send_new_link")?.reason).toBe(ACTION_BLOCKED.interviewsUsedUp);
    expect(names(facts({ stage: "screen_invited", aiInterview: "opted_out" }))).toEqual(["cancel_screen", "hire", "reject"]);
    expect(names(facts({ stage: "screening", aiInterview: "opted_out" }))).toEqual(["cancel_screen", "hire", "reject"]);
  });

  it("offers Hire and Not selected to someone who finished the AI interview, and nothing about the interview", () => {
    expect(candidateActions(facts({ stage: "screen_complete", aiInterview: "done" })).map((a) => [a.action, a.allowed])).toEqual([["hire", true], ["reject", true]]);
  });

  it("lets a hire be taken back", () => {
    expect(candidateActions(facts({ stage: "hired" }))).toEqual([{ action: "undo_decision", label: "Undo", allowed: true, reason: null }]);
  });

  it("keeps Not selected private until someone emails the decision, and lets it be undone only until then", () => {
    expect(candidateActions(facts({ stage: "rejected", toldState: "not_told" })).map((a) => [a.action, a.allowed])).toEqual([["send_decision", true], ["undo_decision", true]]);
    expect(candidateActionState(facts({ stage: "rejected", toldState: "not_told", reachable: false }), "send_decision")?.reason).toBe(ACTION_BLOCKED.noEmail);
    // on its way: it can be taken back, and until it is nothing else changes
    expect(candidateActions(facts({ stage: "rejected", toldState: "queued", decisionEmailWaiting: true })).map((a) => [a.action, a.allowed, a.reason])).toEqual([["unsend_decision", true, null], ["undo_decision", false, ACTION_BLOCKED.emailOnItsWay]]);
    expect(candidateActionState(facts({ stage: "rejected", toldState: "queued", decisionEmailWaiting: false }), "unsend_decision")?.reason).toBe("The email has already left.");
    // told: nothing is undone and nothing is sent twice
    expect(candidateActions(facts({ stage: "rejected", toldState: "sent" })).map((a) => [a.action, a.allowed, a.reason])).toEqual([["send_decision", false, ACTION_BLOCKED.toldAlready], ["undo_decision", false, ACTION_BLOCKED.toldAlready]]);
  });

  it("leaves nothing to do with someone who withdrew", () => {
    expect(candidateActions(facts({ stage: "withdrawn" }))).toEqual([]);
    expect(candidateActionState(facts({ stage: "withdrawn" }), "hire")).toBeNull();
  });

  it("never lets the plan, the job's status or a missing address stop a hire, a decision or an undo", () => {
    for (const stage of ApplicationStage.options) {
      const open = candidateActions(facts({ stage, toldState: stage === "rejected" ? "not_told" : null, aiInterview: stage === "screen_invited" ? "sent" : stage === "screening" ? "started" : null }));
      const stopped = candidateActions(facts({ stage, toldState: stage === "rejected" ? "not_told" : null, aiInterview: stage === "screen_invited" ? "sent" : stage === "screening" ? "started" : null, planStop: "trial_ended", roleStatus: "closed", reachable: false }));
      for (const action of ["hire", "reject", "undo_decision", "cancel_screen"] as const) {
        expect(stopped.find((a) => a.action === action)?.allowed, `${stage} ${action}`).toBe(open.find((a) => a.action === action)?.allowed);
      }
      // every reason is a sentence, and every allowed action has none
      for (const a of [...open, ...stopped]) expect(a.allowed ? a.reason === null : /^[A-Z].*\.$/.test(a.reason ?? ""), `${stage} ${a.action}: ${a.reason}`).toBe(true);
    }
  });
});
