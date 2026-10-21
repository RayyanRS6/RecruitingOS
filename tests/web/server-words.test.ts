import { describe, expect, it } from "vitest";
import { STAGE_LABEL as CORE_STAGE_LABEL } from "../../packages/core/src/stages";
import { LOW_CONFIDENCE_TEXT as CORE_LOW_CONFIDENCE, readingConsistency as coreConsistency } from "../../packages/core/src/evidence";
import { autoReasonText } from "../../packages/core/src/interview-followups";
import { alertHeadline } from "../../packages/core/src/notify-email";
import { NOTIFY_GROUP_INFO } from "../../packages/core/src/notify-groups";
import { STAGE_LABEL as WEB_STAGE_LABEL } from "../../apps/web/src/pages/candidate-panel/helpers";
import { LOW_CONFIDENCE_TEXT as WEB_LOW_CONFIDENCE, readingConsistency as webConsistency } from "../../apps/web/src/evidence";
import { notSentReasonText } from "../../apps/web/src/cancelled";

/**
 * The words the server makes and the copies the web keeps of them say the same thing, in the staff glossary of Wave S1
 * (Wave S2, slice K5): "screening chat" (never "a screen"), "AI review" (never "the reading"), Settings and Home.
 */
const INTERNAL = /\b(packet|Role Packet|intake conversation|screening conversation|Posting tab|Setup|Today)\b|\ba screen\b|\bthe reading\b/;

describe("server words and their web copies", () => {
  it("the stage labels are the same on both sides, in the glossary's words", () => {
    expect(WEB_STAGE_LABEL).toEqual({ ...CORE_STAGE_LABEL });
    expect(CORE_STAGE_LABEL.screen_invited).toBe("Invited to an AI interview");
    expect(CORE_STAGE_LABEL.screening).toBe("In the AI interview");
    expect(CORE_STAGE_LABEL.screen_complete).toBe("AI interview done");
    for (const label of Object.values(CORE_STAGE_LABEL)) expect(label).not.toMatch(INTERNAL);
  });

  it("the evidence check reads the same on the list and in the drawer", () => {
    expect(WEB_LOW_CONFIDENCE).toBe(CORE_LOW_CONFIDENCE);
    const reading = { kind: "triage", overall: "weak", result: { summary: "s", strengths: [], concerns: [], unknowns: [], rationale: "r", recommendation: "screen", requirementFindings: [], competencyFindings: [] } };
    const server = coreConsistency(reading as never).reason;
    expect(server).toBe("The assistant suggested an AI interview, but its AI review says Weak match. Read it yourself before anything else happens.");
    expect(webConsistency(reading as never).reason).toBe(server);
  });

  it("why no automatic new times went says Settings on both sides", () => {
    expect(notSentReasonText("switched_off")).toBe(autoReasonText("switched_off", { state: "not_sent" }));
    expect(autoReasonText("switched_off", { state: "none" })).toBe("Automatic new times are off in Settings.");
  });

  it("alert emails and the email groups never use the internal words", () => {
    for (const kind of ["application.ready", "screen.completed", "screen.expired", "screen.invited", "stuck.screens_unanswered", "stuck.conversations_stuck", "entitlement.text_screens"]) expect(alertHeadline(kind)).not.toMatch(INTERNAL);
    for (const g of Object.values(NOTIFY_GROUP_INFO)) expect(`${g.label} ${g.description}`).not.toMatch(INTERNAL);
  });
});
