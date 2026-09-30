/**
 * Who is ticked when "Approve an interview" opens on a candidate. The round itself comes from the packet version the
 * application runs on (the API checks the round against it), but the people come from the role's current interview plan
 * when that round is still in it, so interviewers assigned on the Interview plan tab reach candidates who applied
 * before the assignment. Only active team members are ever ticked: a removed member's id would be invisible on the
 * page, impossible to untick, and refused by the API on every attempt (interviewer_unknown).
 */
export type PlanRound = { key: string; interviewerUserIds: string[] };

export function defaultInterviewers(input: {
  roundKey: string | undefined;
  /** The rounds of the packet version the application runs on. */
  applicationPlan: PlanRound[];
  /** The rounds of the role's current packet (GET /roles/:id/interview-plan), when loaded. */
  currentPlan?: PlanRound[] | null;
  /** The people the person ticked by hand, when they changed the defaults. */
  picked?: string[] | null;
  /** Active members of the team; null while the list is loading, which ticks nobody yet. */
  activeMemberIds: ReadonlySet<string> | null;
}): string[] {
  if (!input.activeMemberIds) return [];
  const active = input.activeMemberIds;
  const fromCurrent = input.currentPlan?.find((r) => r.key === input.roundKey)?.interviewerUserIds;
  const fromApplication = input.applicationPlan.find((r) => r.key === input.roundKey)?.interviewerUserIds;
  const ids = input.picked ?? fromCurrent ?? fromApplication ?? [];
  return [...new Set(ids)].filter((id) => active.has(id));
}
