import { describe, expect, it } from "vitest";
import { APPLY_MODE_HELP, APPLY_MODE_LABEL, APPLY_MODE_NOTE, applyModeToast, companyFlowToast, isItsStaff, reasonReady, roleApplyModeBody, roleApplyModeLine, roleChoiceOf, roleChoices } from "../../apps/web/src/apply-flow";

/**
 * How applicants meet the screening conversation (plan E1; founder decision B1): the ITS-only control's words, who sees
 * it, and what it sends. New roles apply and talk in one visit; ITS can switch a role or a company back.
 */
const me = (platformRole: string) => ({ user: { id: "u1", email: "x@example.com", name: "X", platformRole } });

describe("who sees the control", () => {
  it("is ITS staff only: a platform administrator or an ITS recruiter, never a customer", () => {
    expect(isItsStaff(me("platform_admin"))).toBe(true);
    expect(isItsStaff(me("its_recruiter"))).toBe(true);
    expect(isItsStaff(me("none"))).toBe(false);
    expect(isItsStaff(null)).toBe(false);
  });
});

describe("the words", () => {
  it("names the two ways in plain words, with what each means for the applicant", () => {
    expect(APPLY_MODE_LABEL).toEqual({ one_visit: "Apply and talk in one visit", form_then_screen: "Form now, conversation later" });
    expect(APPLY_MODE_HELP.one_visit).toMatch(/start it, do it later, or ask for a person/);
    expect(APPLY_MODE_NOTE).toMatch(/"Ask me first" or "Only a person" always uses the later path/);
    expect(APPLY_MODE_NOTE).toMatch(/nobody who already applied is moved/);
  });

  it("says where the role's flow comes from", () => {
    expect(roleApplyModeLine({ roleId: "r1", applyMode: null, companyDefault: "one_visit", effective: "one_visit" })).toBe("Apply and talk in one visit, the company's default");
    expect(roleApplyModeLine({ roleId: "r1", applyMode: "form_then_screen", companyDefault: "one_visit", effective: "form_then_screen" })).toBe("Form now, conversation later, set for this role");
  });

  it("offers the company's default first, naming it", () => {
    expect(roleChoices("form_then_screen").map((c) => c.label)).toEqual(["The company's default (form now, conversation later)", "Apply and talk in one visit", "Form now, conversation later"]);
    expect(roleChoiceOf({ applyMode: null })).toBe("default");
    expect(roleChoiceOf({ applyMode: "one_visit" })).toBe("one_visit");
  });
});

describe("what a change sends", () => {
  const view = { applyMode: null } as const;

  it("needs a reason of five characters or more", () => {
    expect(reasonReady("why")).toBe(false);
    expect(reasonReady("  Owner asked  ")).toBe(true);
    expect(roleApplyModeBody(view, "form_then_screen", "no")).toBeNull();
  });

  it("sends the role's own setting, or null to follow the company again; nothing when nothing would change", () => {
    expect(roleApplyModeBody(view, "form_then_screen", " Owner wants to review first ")).toEqual({ applyMode: "form_then_screen", reason: "Owner wants to review first" });
    expect(roleApplyModeBody({ applyMode: "form_then_screen" }, "default", "Pilot back on")).toEqual({ applyMode: null, reason: "Pilot back on" });
    expect(roleApplyModeBody(view, "default", "Nothing to change")).toBeNull();
  });

  it("says what the change did, and that nobody who applied is moved", () => {
    const t = applyModeToast({ roleId: "r1", applyMode: "form_then_screen", companyDefault: "one_visit", effective: "form_then_screen" }, "Dental Hygienist");
    expect(t.title).toBe("Saved: form now, conversation later for Dental Hygienist.");
    expect(t.detail).toMatch(/nobody who already applied is moved/);
    expect(companyFlowToast("Bright Dental", "one_visit", false).detail).toBe("Nothing changed.");
    expect(companyFlowToast("Bright Dental", "form_then_screen", true).title).toBe("Bright Dental: form now, conversation later by default.");
  });
});
