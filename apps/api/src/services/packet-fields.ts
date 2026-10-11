import { SCREENING_QUESTIONS_MAX, SCREENING_QUESTIONS_MIN, type Actor, type EligibilityRule, type PacketFieldEdit, type RolePacket, type ScreeningQuestion } from "@ros/contracts";
import { DECIDER_ROLES, normalizeCriterion, type TeamMember } from "@ros/core";
import { HttpError } from "../middleware/errors";

/**
 * The plain-field editor (plan C11): the fields an owner changes without opening the whole packet. Each edit starts from
 * the newest version and changes only what was sent; the result goes through `createPacketVersion` like every other
 * edit (the packet guard, the approval rules). Anything that would break the packet's own limits is refused here with
 * plain words, before anything is saved.
 */

const dollars = (n: number) => `$${n.toLocaleString("en-US")}`;

function keyFrom(prefix: string, words: string, taken: Set<string>): string {
  const stem = `${prefix}_${normalizeCriterion(words).replace(/ /g, "_").slice(0, 30) || "item"}`;
  let key = stem;
  for (let n = 2; taken.has(key); n += 1) key = `${stem}_${n}`;
  taken.add(key);
  return key;
}

function screeningQuestions(base: ScreeningQuestion[], sent: NonNullable<PacketFieldEdit["screeningQuestions"]>): ScreeningQuestion[] {
  if (sent.length < SCREENING_QUESTIONS_MIN || sent.length > SCREENING_QUESTIONS_MAX) throw new HttpError(400, "screening_questions_count", `Keep between ${SCREENING_QUESTIONS_MIN} and ${SCREENING_QUESTIONS_MAX} screening questions. This list has ${sent.length}.`);
  const taken = new Set(base.map((q) => q.key));
  const seen = new Set<string>();
  return sent.map((q) => {
    if (q.key) {
      const before = base.find((b) => b.key === q.key);
      if (!before) throw new HttpError(409, "unknown_question", "One of these questions is no longer on this role. Reload the page and try again.");
      if (seen.has(q.key)) throw new HttpError(400, "duplicate_question", "The same question is in the list twice.");
      seen.add(q.key);
      // A reworded question no longer has the model answer or the follow-up written for the old wording.
      if (before.question !== q.question) return { key: before.key, question: q.question, kind: q.kind ?? before.kind, ...(before.competencyKey ? { competencyKey: before.competencyKey } : {}) };
      return { ...before, kind: q.kind ?? before.kind };
    }
    return { key: keyFrom("q", q.question, taken), question: q.question, kind: q.kind ?? "skills" };
  });
}

function eligibilityRules(base: EligibilityRule[], sent: NonNullable<PacketFieldEdit["eligibility"]>): EligibilityRule[] {
  const taken = new Set(base.map((e) => e.key));
  const seen = new Set<string>();
  return sent.map((e) => {
    if (e.key) {
      const before = base.find((b) => b.key === e.key);
      if (!before) throw new HttpError(409, "unknown_question", "One of these questions is no longer on this role. Reload the page and try again.");
      if (seen.has(e.key)) throw new HttpError(400, "duplicate_question", "The same question is in the list twice.");
      seen.add(e.key);
      return { key: before.key, type: e.type, question: e.question, rationale: e.rationale, knockout: e.knockout ?? before.knockout, expectation: e.expectation ?? (e.type === before.type ? before.expectation : {}) };
    }
    return { key: keyFrom(e.type, e.question, taken), type: e.type, question: e.question, rationale: e.rationale, knockout: e.knockout ?? true, expectation: e.expectation ?? {} };
  });
}

const FIELD_LABEL: Record<string, string> = {
  title: "job title",
  locations: "place",
  employmentType: "job type",
  schedule: "schedule",
  remotePolicy: "work model",
  compensation: "pay",
  screeningQuestions: "screening questions",
  eligibility: "eligibility questions",
  dealBreakers: "deal-breakers",
  decisionMakerUserId: "decision maker",
  tone: "message tone",
};

/** The next packet with the sent fields applied, and the plain summary of what was edited ("Edited: job title, pay"). */
export function applyFieldEdit(base: RolePacket, edit: PacketFieldEdit, ctx: { team: TeamMember[]; actor: Actor; now: string }): { packet: RolePacket; summary: string; fields: string[]; notes: string[] } {
  const p = structuredClone(base);
  const fields: string[] = [];
  const notes: string[] = [];
  if (edit.title !== undefined) p.identity.title = edit.title;
  if (edit.locations !== undefined) p.identity.locations = edit.locations;
  if (edit.employmentType !== undefined) p.identity.employmentType = edit.employmentType;
  if (edit.remotePolicy !== undefined) p.identity.remotePolicy = edit.remotePolicy;
  if (edit.schedule !== undefined) {
    if (edit.schedule) p.identity.schedule = edit.schedule;
    else delete p.identity.schedule;
  }
  if (edit.compensation) {
    const c = edit.compensation;
    const basis = c.basis ?? p.compensation.basis;
    if (basis !== p.compensation.basis && (c.min === undefined || c.max === undefined)) throw new HttpError(400, "pay_basis_needs_range", "When you switch between hourly and a yearly salary, enter the new range too.");
    const min = c.min ?? p.compensation.min;
    const max = c.max ?? p.compensation.max;
    if (min > max) throw new HttpError(400, "pay_range_reversed", "The lowest pay is above the highest. Check the two figures.");
    const ceiling = c.ceiling ?? Math.max(p.compensation.ceiling, max);
    if (ceiling < max) throw new HttpError(400, "ceiling_below_range", `The private ceiling cannot be below the top of the range (${dollars(max)}).`);
    if (c.ceiling === undefined && ceiling !== p.compensation.ceiling) notes.push(`The private ceiling was raised to the top of the new range (${dollars(ceiling)}).`);
    const changed = basis !== p.compensation.basis || min !== p.compensation.min || max !== p.compensation.max || ceiling !== p.compensation.ceiling;
    p.compensation = { ...p.compensation, basis, min, max, ceiling, ...(p.compensation.mid !== undefined ? { mid: Math.round((min + max) / 2) } : {}) };
    if (changed) {
      // Pay a person typed in the editor counts as set by them, like the pay card (C7).
      p.compensation.sources = p.compensation.sources.map((s) => (s.name === "owner-stated" ? { ...s, detail: `${min}–${max} ${basis}` } : s));
      p.provenance.payConfirmedBy = { by: ctx.actor, at: ctx.now, via: "edited" };
      p.provenance.payOrigin = "edited";
    }
  }
  if (edit.screeningQuestions !== undefined) p.screening.questions = screeningQuestions(base.screening.questions, edit.screeningQuestions);
  if (edit.eligibility !== undefined) p.requirements.eligibility = eligibilityRules(base.requirements.eligibility, edit.eligibility);
  if (edit.dealBreakers !== undefined) {
    const kept: string[] = [];
    for (const d of edit.dealBreakers) if (!kept.some((k) => normalizeCriterion(k) === normalizeCriterion(d))) kept.push(d);
    p.preferences.dealBreakersInTheirWords = kept;
  }
  if (edit.decisionMakerUserId !== undefined) {
    if (edit.decisionMakerUserId === null) {
      delete p.preferences.decisionMakerUserId;
      delete p.preferences.decisionMakerName;
    } else {
      const who = ctx.team.find((m) => m.userId === edit.decisionMakerUserId);
      if (!who || !DECIDER_ROLES.includes(who.role)) throw new HttpError(400, "not_a_decider", "Choose someone on your team who can approve roles: an owner, an admin or a hiring manager.");
      p.preferences.decisionMakerUserId = who.userId;
      p.preferences.decisionMakerName = who.name;
    }
  }
  if (edit.tone !== undefined) p.communication.tone = edit.tone;
  for (const key of Object.keys(FIELD_LABEL)) {
    if ((edit as Record<string, unknown>)[key] === undefined) continue;
    if (JSON.stringify(sectionOf(key, base)) !== JSON.stringify(sectionOf(key, p))) fields.push(key);
  }
  return { packet: p, fields, notes, summary: fields.length ? `Edited: ${fields.map((f) => FIELD_LABEL[f]).join(", ")}` : "" };
}

/** The part of the packet a field lives in, to tell whether an edit changed anything. */
function sectionOf(field: string, p: RolePacket): unknown {
  switch (field) {
    case "title": return p.identity.title;
    case "locations": return p.identity.locations;
    case "employmentType": return p.identity.employmentType;
    case "schedule": return p.identity.schedule ?? null;
    case "remotePolicy": return p.identity.remotePolicy;
    case "compensation": return [p.compensation.basis, p.compensation.min, p.compensation.max, p.compensation.ceiling];
    case "screeningQuestions": return p.screening.questions;
    case "eligibility": return p.requirements.eligibility;
    case "dealBreakers": return p.preferences.dealBreakersInTheirWords;
    case "decisionMakerUserId": return p.preferences.decisionMakerUserId ?? null;
    case "tone": return p.communication.tone;
    default: return null;
  }
}
