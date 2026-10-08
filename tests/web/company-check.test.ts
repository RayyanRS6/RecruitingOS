import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APPROVE_WAITS_FOR_CHECK, CAREERS_PAGE_WAITS, POSTING_WAITS_FOR_CHECK, ROLE_WAITS_FOR_CHECK, approvedToast, companyCheckOf, decisionOnItsWayText, messageOnItsWayChip } from "../../apps/web/src/company-check";
import { HELD_FOR_CHECK, bulkSendToast, noticeText, sendDecisionToast } from "../../apps/web/src/talent-actions";

/**
 * The one-time ITS check (founder decision B7) on the team's pages: until ITS confirms the company, nothing promises
 * "posting now" or "on its way". The role page, its Posting tab, Setup's careers-page link, the Talent list and the
 * candidate panel say what waits, and the toasts after approving a role or sending a message say it too.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("whether ITS has confirmed the company", () => {
  it("reads the company's settings, and says nothing until they have loaded", () => {
    expect(companyCheckOf({ settings: { verifiedAt: "2026-10-08T09:00:00.000Z" } })).toBe("confirmed");
    expect(companyCheckOf({ settings: {} })).toBe("waiting");
    expect(companyCheckOf(undefined)).toBe("unknown");
  });
});

describe("approving a role while the company waits", () => {
  it("says it goes public once ITS confirms, not that it is posting now", () => {
    expect(approvedToast({ editWhileOpen: false, check: "waiting" })).toBe("Approved. It goes public as soon as ITS confirms your company.");
    // nothing is promised as posted before it is checked (plan D2): the screen after approval says where it is going
    expect(approvedToast({ editWhileOpen: false, check: "confirmed" })).toBe("Approved. Getting it ready on its channels.");
    expect(approvedToast({ editWhileOpen: false, check: "confirmed" })).not.toMatch(/Posting now/);
    expect(approvedToast({ editWhileOpen: true, check: "waiting" })).toBe("Approved. The role now runs on the new version.");
    expect(APPROVE_WAITS_FOR_CHECK).toMatch(/goes public on its own as soon as ITS confirms/);
  });

  it("the role page, the Posting tab and Setup say why nothing is public", () => {
    expect(ROLE_WAITS_FOR_CHECK).toMatch(/^Not public yet: ITS is confirming your company\./);
    expect(POSTING_WAITS_FOR_CHECK).toMatch(/^Nothing of this role is public until ITS confirms your company/);
    expect(POSTING_WAITS_FOR_CHECK).toContain("\"not found\"");
    expect(CAREERS_PAGE_WAITS).toBe("Offline until ITS confirms your company.");
    expect(read("../../apps/web/src/pages/RolePlan.tsx")).toContain("approvedToast({ editWhileOpen: !!pending?.editWhileOpen, check })");
    expect(read("../../apps/web/src/pages/RolePosting.tsx")).toContain("{check === \"waiting\" && roleStatus !== \"closed\" ? <Alert tone=\"caution\">{POSTING_WAITS_FOR_CHECK}</Alert> : null}");
    expect(read("../../apps/web/src/pages/RoleDetail.tsx")).toContain("{ROLE_WAITS_FOR_CHECK}");
    expect(read("../../apps/web/src/pages/Setup.tsx")).toContain("{CAREERS_PAGE_WAITS}");
  });
});

describe("messages held for the check", () => {
  it("are saved, never 'on its way'", () => {
    expect(noticeText("held")).toBe(HELD_FOR_CHECK);
    expect(sendDecisionToast("held")).toEqual({ title: "Saved.", detail: HELD_FOR_CHECK });
    expect(HELD_FOR_CHECK).not.toMatch(/on its way/);
    expect(messageOnItsWayChip("waiting")).toBe("Message waits for the ITS check");
    expect(messageOnItsWayChip("confirmed")).toBe("Message on its way");
    expect(decisionOnItsWayText("Maria", "waiting")).toMatch(/^The decision message waits for the ITS check of your company; it goes to Maria/);
    expect(decisionOnItsWayText("Maria", "confirmed")).toBe("The decision message is on its way to Maria.");
  });

  it("the bulk Send counts them apart from the ones on their way", () => {
    expect(bulkSendToast({ queued: 0, held: 2, waitingApproval: 0, notSent: 0 })).toEqual({ title: "2 decision messages saved.", detail: "saved messages go out as soon as ITS confirms your company." });
    expect(bulkSendToast({ queued: 1, held: 0, waitingApproval: 0, notSent: 0 })).toEqual({ title: "1 decision message on its way." });
  });

  it("the candidate panel's message toast says it waits", () => {
    expect(read("../../apps/web/src/pages/candidate-panel/sections.tsx")).toContain("else if (r.status === \"held\") toast(\"Saved.\", \"It goes out as soon as ITS confirms your company.\");");
  });
});
