import type { BoardColumn, BoardPlacement, MatchScore, MustHaveSummary, NextStep, PoolAnswer, PoolAnswerPerson, PoolMustHaveCount, PoolQuestion, PoolQuestionKind, PoolSummary, RolePacket } from "@ros/contracts";
import { OVERLOOKED_AFTER_DAYS, daysSince } from "./board";

/**
 * The pool summary above the board and the one-click questions (plan F7, F10). Built by fixed rules from the records,
 * like a report: every name and number comes from the rows given, nothing is invented, and no AI is asked. The same
 * rows always give the same words in the same order.
 */
export type PoolPerson = {
  applicationId: string;
  name: string;
  /** When they reached the step they are at: how long they have waited. */
  waitingSince: string;
  stillApplying: boolean;
  placement: BoardPlacement;
  match: MatchScore | null;
  mustHaves: MustHaveSummary | null;
};

/** At least this many people read before the "stricter than needed?" prompt, and at least this share not showing it. */
export const STRICTER_MIN_PEOPLE = 5;
export const STRICTER_SHARE = 0.6;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const byName = (a: { name: string; applicationId: string }, b: { name: string; applicationId: string }) => a.name.localeCompare(b.name) || a.applicationId.localeCompare(b.applicationId);

/**
 * Each must-have's status for one person, from their score's findings: shown, partly, not met, or not known; and
 * "not read" when the version of the role they were read against did not have that must-have (it was added since), so
 * they are left out of its count instead of counted as not showing it.
 */
function mustHaveStatus(p: PoolPerson, key: string): "yes" | "partly" | "no" | "unknown" | "not_read" {
  const c = p.match?.breakdown.find((x) => x.mustHave && x.key === key);
  if (!c) return p.match?.unknown.some((u) => u.mustHave && u.key === key) ? "unknown" : "not_read";
  return c.pctMet === 100 ? "yes" : c.pctMet === 50 ? "partly" : "no";
}

/** Where to change the must-haves: the role page's requirements, opened for a new version (the editor goes through the packet guard). */
export function mustHaveEditPath(roleId: string): string {
  return `/roles/${roleId}?tab=requirements&edit=must-haves`;
}

export function poolSummary(people: readonly PoolPerson[], packet: Pick<RolePacket, "requirements"> | null, ctx: { roleId: string; now: Date }): PoolSummary {
  const onBoard = people.filter((p) => !p.stillApplying && p.placement.column);
  const read = onBoard.filter((p) => !!p.match);
  // The counts are of the people still to sort, by the column the board suggests; anyone already sorted, decided or
  // past this step (interviewing, offer, hired) is counted once in `done`, never as "on the shortlist".
  const counts: Record<BoardColumn, number> = { shortlist: 0, longlist: 0, not_moving_forward: 0 };
  const toSortPeople = onBoard.filter((p) => p.placement.state === "suggested");
  for (const p of toSortPeople) counts[p.placement.column!] += 1;
  const done = onBoard.filter((p) => p.placement.state === "done").length;
  const beingRead = onBoard.filter((p) => p.placement.state === "waiting").length;
  const mustHaves: PoolMustHaveCount[] = (packet?.requirements.mustHaves ?? []).map((m) => {
    const row: PoolMustHaveCount = { key: m.key, label: m.text, shown: 0, partly: 0, notShown: 0, unknown: 0, total: 0 };
    for (const p of read) {
      const s = mustHaveStatus(p, m.key);
      if (s === "not_read") continue;
      row.total += 1;
      if (s === "yes") row.shown += 1;
      else if (s === "partly") row.partly += 1;
      else if (s === "no") row.notShown += 1;
      else row.unknown += 1;
    }
    return row;
  });
  const showEveryMustHave = read.filter((p) => p.mustHaves && p.mustHaves.total > 0 && p.mustHaves.shown === p.mustHaves.total).length;
  // The must-have shown least often: not met, or not shown either way. Ties go to the first in the role's own order.
  let mostMissing: PoolSummary["mostMissing"] = null;
  for (const m of mustHaves) {
    const notShowing = m.notShown + m.unknown;
    if (notShowing > 0 && (!mostMissing || notShowing > mostMissing.notShowing)) mostMissing = { key: m.key, label: m.label, notShowing, of: m.total };
  }
  // Who has waited longest among the people still to sort.
  const longest = [...toSortPeople].sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince) || byName(a, b))[0];
  const longestWaiting = longest ? { applicationId: longest.applicationId, name: longest.name, days: daysSince(longest.waitingSince, ctx.now) } : null;
  const nextSteps = pickNextSteps(toSortPeople);
  const share = (m: PoolMustHaveCount) => (m.total ? (m.notShown + m.unknown) / m.total : 0);
  const strict = mustHaves.filter((m) => m.total >= STRICTER_MIN_PEOPLE && share(m) >= STRICTER_SHARE).sort((a, b) => share(b) - share(a))[0];
  const stricter = strict ? { key: strict.key, label: strict.label, notShowing: strict.notShown + strict.unknown, of: strict.total, words: `"${strict.label}" is not shown by ${strict.notShown + strict.unknown} of ${strict.total} people. If it is stricter than the job needs, you could make it a nice-to-have in a new version of the role. Nobody is turned down because of this note.`, editPath: mustHaveEditPath(ctx.roleId) } : null;
  const stillApplying = people.filter((p) => p.stillApplying).length;
  const sentences: string[] = [];
  if (!onBoard.length) sentences.push(stillApplying ? `Nobody to sort yet; ${plural(stillApplying, "person is", "people are")} still applying.` : "Nobody to sort yet.");
  else {
    const sortWords = toSortPeople.length ? `To sort: ${counts.shortlist} for the shortlist, ${counts.longlist} for the longlist, ${counts.not_moving_forward} not moving forward.` : "Nobody is waiting to be sorted.";
    const doneWords = done ? ` ${done} already sorted, moving forward or decided.` : "";
    const readWords = beingRead ? ` ${beingRead} still being read.` : "";
    sentences.push(`${plural(onBoard.length, "person", "people")} on the board. ${sortWords}${doneWords}${readWords}${stillApplying ? ` ${plural(stillApplying, "more is", "more are")} still applying.` : ""}`);
    if (mustHaves.length && read.length) sentences.push(`${showEveryMustHave} of ${read.length} show every must-have.`);
    if (mostMissing) sentences.push(`The must-have shown least often is "${mostMissing.label}": ${mostMissing.notShowing} of ${mostMissing.of} don't show it.`);
    if (longestWaiting) sentences.push(`${longestWaiting.name} has waited longest: ${plural(longestWaiting.days, "day", "days")}.`);
    if (stricter) sentences.push(stricter.words);
  }
  return { total: onBoard.length, counts, toSort: toSortPeople.filter((p) => !!p.placement.suggestedAction).length, done, stillApplying, showEveryMustHave, mostMissing, longestWaiting, nextSteps, mustHaves, stricter, sentences };
}

/**
 * Up to three next steps naming people: the shortlist first (highest score, then longest waiting), then the people who
 * need a person's eye, then those to ask for more detail, each with the board's own reason.
 */
function pickNextSteps(toSort: readonly PoolPerson[]): PoolSummary["nextSteps"] {
  const wait = (a: PoolPerson, b: PoolPerson) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince) || byName(a, b);
  const shortlist = toSort.filter((p) => p.placement.column === "shortlist").sort((a, b) => (b.match?.score ?? -1) - (a.match?.score ?? -1) || wait(a, b));
  const eye = toSort.filter((p) => p.placement.column === "longlist" && p.placement.needsYourEye).sort(wait);
  const ask = toSort.filter((p) => p.placement.column === "longlist" && !p.placement.needsYourEye && p.placement.nextStep?.kind === "ask_more").sort(wait);
  return [...shortlist, ...eye, ...ask].filter((p) => p.placement.nextStep).slice(0, 3).map((p) => ({ applicationId: p.applicationId, name: p.name, ...(p.placement.nextStep as NextStep) }));
}

/* ------------------------------------------------------------------------------------------------------------ */
/* One-click questions (plan F10): filters over the stored findings, no new AI.                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/** The questions the board offers: one "strongest evidence" per must-have. "Compare these" needs people chosen first. */
export function poolQuestions(packet: Pick<RolePacket, "requirements"> | null): PoolQuestion[] {
  return [
    { id: "missing_must_have", kind: "missing_must_have", label: "Who is missing a must-have, and why?", mustHaveKey: null },
    ...(packet?.requirements.mustHaves ?? []).map((m) => ({ id: `strongest_evidence:${m.key}`, kind: "strongest_evidence" as const, label: `Strongest evidence for "${m.text}"`, mustHaveKey: m.key })),
    { id: "overlooked", kind: "overlooked", label: "Who might I be overlooking?", mustHaveKey: null },
    { id: "compare", kind: "compare", label: "Compare these", mustHaveKey: null },
  ];
}

export class PoolQuestionError extends Error {
  constructor(public readonly code: "unknown_must_have" | "not_here", message: string) {
    super(message);
  }
}

const personOf = (p: PoolPerson, why: string, quotes: PoolAnswerPerson["quotes"], open: (id: string) => string): PoolAnswerPerson => ({ applicationId: p.applicationId, name: p.name, score: p.match?.score ?? null, band: p.match?.band ?? null, placement: p.placement.column, why, quotes, open: open(p.applicationId) });

/**
 * The answer to one question over the people on the board (still applying left out): who, why, the quotes it rests
 * on, and what it looked at. `compare` is answered by the comparison view instead.
 */
export function answerPoolQuestion(kind: Exclude<PoolQuestionKind, "compare">, people: readonly PoolPerson[], packet: Pick<RolePacket, "requirements"> | null, opts: { mustHaveKey?: string | null; now: Date; open: (applicationId: string) => string }): PoolAnswer {
  const onBoard = people.filter((p) => !p.stillApplying && p.placement.column);
  const read = onBoard.filter((p) => !!p.match);
  const must = packet?.requirements.mustHaves ?? [];
  const lookedAt = (requirements: string[]) => ({
    people: read.length,
    resumeReadings: read.filter((p) => p.match!.basedOn !== "screen").length,
    screenReadings: read.filter((p) => p.match!.basedOn !== "resume").length,
    requirements,
    words: `Looked at the latest findings for ${plural(read.length, "person", "people")}${requirements.length ? ` against ${requirements.length === 1 ? `"${requirements[0]}"` : `${requirements.length} must-haves`}` : ""}. No AI was asked anything new; these are the checked findings already on file.`,
  });
  if (kind === "missing_must_have") {
    const hits = read.filter((p) => p.match!.missingMustHave.length).sort(byName);
    const silent = read.filter((p) => !p.match!.missingMustHave.length && p.match!.unknown.some((u) => u.mustHave)).length;
    const list = hits.map((p) => personOf(p, `Missing must-have: ${p.match!.missingMustHave.map((m) => m.label).join(", ")}.`, p.match!.missingMustHave.filter((m) => m.quote).map((m) => ({ criterion: m.label, quote: m.quote, source: p.match!.breakdown.find((c) => c.key === m.key)?.source ?? "resume" })), opts.open));
    const answer = hits.length
      ? `${plural(hits.length, "person shows", "people show")}, in their own words, that they do not meet a must-have.${silent ? ` ${plural(silent, "more does", "more do")} not say either way; they are not counted as missing.` : ""}`
      : `Nobody's own words show a missing must-have.${silent ? ` ${plural(silent, "person does", "people do")} not say either way about one.` : ""}`;
    return { kind, question: "Who is missing a must-have, and why?", answer, people: list, applicationIds: list.map((p) => p.applicationId), lookedAt: lookedAt(must.map((m) => m.text)) };
  }
  if (kind === "strongest_evidence") {
    const m = must.find((x) => x.key === opts.mustHaveKey);
    if (!m) throw new PoolQuestionError("unknown_must_have", "Choose one of this role's must-haves.");
    const scored = read.map((p) => ({ p, c: p.match!.breakdown.find((x) => x.mustHave && x.key === m.key) ?? null })).filter((x) => x.c && x.c.pctMet > 0);
    // Shown before partly shown, a quote before none, then the higher score, then by name.
    scored.sort((a, b) => b.c!.pctMet - a.c!.pctMet || Number(!!b.c!.quote) - Number(!!a.c!.quote) || (b.p.match!.score ?? -1) - (a.p.match!.score ?? -1) || byName(a.p, b.p));
    const top = scored.slice(0, 10);
    const list = top.map(({ p, c }) => personOf(p, `${c!.finding} ${c!.source === "screen" ? "in the screening chat" : "in the résumé or application"}.`, c!.quote ? [{ criterion: m.text, quote: c!.quote, source: c!.source }] : [], opts.open));
    const shown = scored.filter((x) => x.c!.pctMet === 100).length;
    const answer = scored.length ? `${plural(shown, "person shows", "people show")} "${m.text}"${scored.length > shown ? ` and ${plural(scored.length - shown, "more shows", "more show")} it in part` : ""}.${scored.length > top.length ? ` The first ${top.length} are listed.` : ""}` : `Nobody's evidence shows "${m.text}" yet.`;
    return { kind, question: `Strongest evidence for "${m.text}"`, answer, people: list, applicationIds: list.map((p) => p.applicationId), lookedAt: lookedAt([m.text]) };
  }
  // overlooked: good evidence but not on the shortlist, or waiting a long time with nothing decided.
  const rows = onBoard.filter((p) => p.placement.state === "suggested").map((p) => {
    const days = daysSince(p.waitingSince, opts.now);
    const good = !!p.match && (p.match.band === "very_high" || p.match.band === "high" || (!!p.mustHaves && p.mustHaves.total > 0 && p.mustHaves.shown === p.mustHaves.total));
    const reasons: string[] = [];
    if (good && p.placement.column !== "shortlist") reasons.push(`Good evidence, but on the ${p.placement.column === "longlist" ? "Longlist" : "Not moving forward list"}${p.placement.needsYourEye ? `: ${p.placement.needsYourEye}` : "."}`);
    if (days >= OVERLOOKED_AFTER_DAYS) reasons.push(`Waiting ${plural(days, "day", "days")} with nothing decided.`);
    return { p, days, reasons };
  }).filter((x) => x.reasons.length);
  rows.sort((a, b) => b.days - a.days || (b.p.match?.score ?? -1) - (a.p.match?.score ?? -1) || byName(a.p, b.p));
  const top = rows.slice(0, 10);
  const list = top.map(({ p, reasons }) => personOf(p, reasons.join(" "), (p.match?.breakdown ?? []).filter((c) => c.pctMet === 100 && c.quote).slice(0, 2).map((c) => ({ criterion: c.label, quote: c.quote!, source: c.source })), opts.open));
  const answer = rows.length ? `${plural(rows.length, "person", "people")} may deserve a second look.${rows.length > top.length ? ` The first ${top.length} are listed.` : ""}` : "Nobody stands out as overlooked: everyone with good evidence is on the shortlist, and nobody has waited a week or more.";
  return { kind, question: "Who might I be overlooking?", answer, people: list, applicationIds: list.map((p) => p.applicationId), lookedAt: lookedAt(must.map((m) => m.text)) };
}
