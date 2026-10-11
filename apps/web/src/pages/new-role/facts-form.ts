import type { IntakeFacts, IntakeFactsPatch, IntakeListFact, IntakeTextFact } from "@ros/contracts";

/**
 * The draft panel's Edit mode (plan C7, C11 before the role exists): the answers as plain fields, and the one change
 * they make when saved (an IntakeFactsPatch: set a field, clear one, add or remove one list item). Pure, so
 * tests/web/job-builder.test.ts checks that an edit sends exactly what changed and nothing else.
 */

/** The single-line answers the panel edits, in the order it shows them. */
export const TEXT_FIELDS = ["title", "locationText", "employmentType", "remotePolicy", "schedule", "reason", "reasonDetail", "targetStartDate", "whatFailureLooksLike", "benefits"] as const satisfies readonly IntakeTextFact[];
export type TextField = (typeof TEXT_FIELDS)[number];

/** The lists the panel edits one item at a time. Interviewers are edited with the team chips instead. */
export const LIST_FIELDS = ["responsibilities", "mustHaves", "niceToHaves", "screeningQuestions", "dealBreakers"] as const satisfies readonly IntakeListFact[];
export type ListField = (typeof LIST_FIELDS)[number];

export type FactsForm = {
  text: Record<TextField, string>;
  lists: Record<ListField, string[]>;
  /** The decision maker as a team member, or a name for someone not on the team yet. */
  decisionMakerUserId: string;
  decisionMakerName: string;
  /** Interviewers on the team, and names of people who are not on it yet. */
  interviewerUserIds: string[];
  otherInterviewers: string[];
};

type Member = { userId: string; name: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The form as the facts stand now. Names of interviewers who are on the team are shown as their chips, not as text. */
export function factsFormFrom(f: IntakeFacts, team: readonly Member[]): FactsForm {
  const text = Object.fromEntries(TEXT_FIELDS.map((k) => [k, (f[k] ?? "").trim()])) as Record<TextField, string>;
  const lists = Object.fromEntries(LIST_FIELDS.map((k) => [k, [...(f[k] ?? [])]])) as Record<ListField, string[]>;
  const ids = f.interviewerUserIds ?? team.filter((m) => f.interviewers.some((n) => same(n, m.name))).map((m) => m.userId);
  const onTeam = (n: string) => team.some((m) => same(m.name, n) && ids.includes(m.userId));
  return {
    text,
    lists,
    decisionMakerUserId: f.decisionMakerUserId ?? "",
    decisionMakerName: f.decisionMakerUserId ? "" : (f.decisionMaker ?? "").trim(),
    interviewerUserIds: [...ids],
    otherInterviewers: f.interviewers.filter((n) => !onTeam(n)),
  };
}

/**
 * Only what changed between the form as it was opened and as it is now: a field emptied is cleared, a list item kept
 * is left alone. Null when nothing changed, so Save sends nothing and writes nothing into the conversation.
 */
export function factsPatch(before: FactsForm, after: FactsForm): IntakeFactsPatch | null {
  const set: NonNullable<IntakeFactsPatch["set"]> = {};
  const clear: IntakeTextFact[] = [];
  const add: Array<{ field: IntakeListFact; value: string }> = [];
  const remove: Array<{ field: IntakeListFact; value: string }> = [];
  for (const k of TEXT_FIELDS) {
    const was = before.text[k].trim();
    const now = after.text[k].trim();
    if (was === now) continue;
    if (now) set[k] = now.slice(0, 500);
    else clear.push(k);
  }
  const listDiff = (field: IntakeListFact, was: readonly string[], now: readonly string[]) => {
    const kept = now.map((x) => x.trim()).filter(Boolean);
    for (const x of was) if (!kept.some((y) => same(x, y))) remove.push({ field, value: x });
    for (const x of kept) if (!was.some((y) => same(x, y)) && !add.some((a) => a.field === field && same(a.value, x))) add.push({ field, value: x.slice(0, 500) });
  };
  for (const k of LIST_FIELDS) listDiff(k, before.lists[k], after.lists[k]);
  // The final say: a team member, or a name typed for someone not on the team yet, or nobody.
  if (after.decisionMakerUserId && after.decisionMakerUserId !== before.decisionMakerUserId) set.decisionMakerUserId = after.decisionMakerUserId;
  else if (!after.decisionMakerUserId) {
    const name = after.decisionMakerName.trim();
    if (name && (before.decisionMakerUserId || !same(name, before.decisionMakerName))) set.decisionMaker = name.slice(0, 500);
    else if (!name && (before.decisionMakerUserId || before.decisionMakerName)) clear.push("decisionMaker");
  }
  const idsChanged = before.interviewerUserIds.length !== after.interviewerUserIds.length || before.interviewerUserIds.some((id) => !after.interviewerUserIds.includes(id));
  if (idsChanged) set.interviewerUserIds = after.interviewerUserIds.slice(0, 10);
  listDiff("interviewers", before.otherInterviewers, after.otherInterviewers);
  const patch: IntakeFactsPatch = {
    ...(Object.keys(set).length ? { set } : {}),
    ...(add.length ? { add: add.slice(0, 20) } : {}),
    ...(remove.length ? { remove: remove.slice(0, 20) } : {}),
    ...(clear.length ? { clear } : {}),
  };
  return Object.keys(patch).length ? patch : null;
}
