import type { Me, RoleApplyModeView } from "./api/client";

/**
 * How applicants meet the screening conversation (plan E1; founder decision B1/Q15), in the words the ITS controls use,
 * kept free of React so they can be tested (tests/web/apply-flow.test.ts). Roles take "form now, conversation later"
 * until ITS, and only ITS, switches the one-visit flow on for a pilot role or a company's default (and back). The API is
 * the authority (PUT /roles/:id/apply-mode, POST /admin/customers/:id/apply-flow); these only decide what a page shows.
 */

export type ApplyMode = RoleApplyModeView["effective"];

export const APPLY_MODE_LABEL: Record<ApplyMode, string> = {
  one_visit: "Apply and talk in one visit",
  form_then_screen: "Form now, conversation later",
};

export const APPLY_MODE_HELP: Record<ApplyMode, string> = {
  one_visit: "Everyone who passes the yes/no questions is offered the screening chat straight after the form. They can start it, do it later, or ask for a person.",
  form_then_screen: "People send the form now. The screening chat reaches them by email later, under the company's rule for screening invitations.",
};

/** Always said beside the control: when the later path applies whatever is chosen, and that people already applying are untouched. */
export const APPLY_MODE_NOTE = "A role whose rule for screening invitations is \"Ask me first\" or \"Only a person\" always uses the later path. A change applies to new applicants only; nobody who already applied is moved.";

/** ITS staff (a platform administrator or an ITS recruiter): the only people who see these controls. */
export function isItsStaff(me: Pick<Me, "user"> | null | undefined): boolean {
  return !!me && ["platform_admin", "its_recruiter"].includes(me.user.platformRole);
}

/** The role's choice in the form: its own setting, or "default" to follow the company. */
export type RoleChoice = ApplyMode | "default";

export function roleChoiceOf(view: Pick<RoleApplyModeView, "applyMode">): RoleChoice {
  return view.applyMode ?? "default";
}

/** The options for a role, the company's default named in the first. */
export function roleChoices(companyDefault: ApplyMode): Array<{ value: RoleChoice; label: string }> {
  return [
    { value: "default", label: `The company's default (${APPLY_MODE_LABEL[companyDefault].toLowerCase()})` },
    { value: "one_visit", label: APPLY_MODE_LABEL.one_visit },
    { value: "form_then_screen", label: APPLY_MODE_LABEL.form_then_screen },
  ];
}

/** "Apply and talk in one visit, the company's default" or "..., set for this role". */
export function roleApplyModeLine(view: RoleApplyModeView): string {
  return `${APPLY_MODE_LABEL[view.effective]}, ${view.applyMode ? "set for this role" : "the company's default"}`;
}

/** A reason is required, five characters at least (the API's rule). */
export const REASON_MIN = 5;
export function reasonReady(reason: string): boolean {
  return reason.trim().length >= REASON_MIN;
}

/** What PUT /roles/:id/apply-mode takes; null until a reason is given or when nothing would change. */
export function roleApplyModeBody(view: Pick<RoleApplyModeView, "applyMode">, choice: RoleChoice, reason: string): { applyMode: ApplyMode | null; reason: string } | null {
  const applyMode = choice === "default" ? null : choice;
  if (applyMode === view.applyMode || !reasonReady(reason)) return null;
  return { applyMode, reason: reason.trim() };
}

/** What a saved change says, in two short lines. */
export function applyModeToast(view: RoleApplyModeView, roleTitle?: string | null): { title: string; detail: string } {
  return { title: `Saved: ${APPLY_MODE_LABEL[view.effective].toLowerCase()}${roleTitle ? ` for ${roleTitle}` : ""}.`, detail: "New applicants follow it from now on; nobody who already applied is moved. The change is recorded with your reason." };
}

/** The same for a company's default. */
export function companyFlowToast(companyName: string, flow: ApplyMode, changed: boolean): { title: string; detail: string } {
  if (!changed) return { title: `${companyName} already uses ${APPLY_MODE_LABEL[flow].toLowerCase()}.`, detail: "Nothing changed." };
  return { title: `${companyName}: ${APPLY_MODE_LABEL[flow].toLowerCase()} by default.`, detail: "Roles with their own setting keep it. New applicants follow it from now on; the change is recorded with your reason." };
}
