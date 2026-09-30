/**
 * Who may decide an approval request, by role. A request names its approver roles from the policy in force. A policy
 * switched to "approval" in Setup keeps the action's own list, which is empty for actions that were never meant to
 * wait (the decline message, for instance), and a request with an empty list could then be decided by nobody: it would
 * sit on the brief and the role report for ever while the candidate hears nothing. Owners and admins decide those.
 * The decide route and the brief read the same list, so a card is offered exactly to the people the route accepts.
 */
export const DEFAULT_APPROVER_ROLES: readonly string[] = ["owner", "admin"];

export function approverRolesOf(requiredRoles: readonly string[]): readonly string[] {
  return requiredRoles.length ? requiredRoles : DEFAULT_APPROVER_ROLES;
}

export function mayDecideByRole(requiredRoles: readonly string[], role: string): boolean {
  return approverRolesOf(requiredRoles).includes(role);
}
