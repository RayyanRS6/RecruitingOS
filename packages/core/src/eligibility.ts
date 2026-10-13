import type { EligibilityResult, EligibilityRule } from "@ros/contracts";
import { daysWithin } from "./intake-builder";

/**
 * Deterministic evaluation of owner-authored eligibility rules against the candidate's own answers.
 * No model is involved: the only automatic hold in the system is a rule the owner wrote, evaluated
 * against what the candidate said. Anything the candidate did not answer is "unverifiable", never a fail.
 *
 * The rules themselves are drafted by a model, and a rule's expectation can arrive in any JSON shape: on staging
 * (13 Oct 2026) days written as "Monday–Friday" instead of a list stopped the application workflow at this step. So every
 * field is read as whatever shape it came in, and a rule that still cannot be read is left for a person (unverifiable),
 * never a crash and never a fail.
 */
export function evaluateEligibility(rules: EligibilityRule[], answers: Record<string, unknown>, now = new Date()): EligibilityResult {
  const failed: EligibilityResult["failedRules"] = [];
  const unverifiable: EligibilityResult["unverifiable"] = [];

  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule?.knockout) continue;
    const answer = answers?.[rule.key];
    if (answer === undefined || answer === null || answer === "" || (Array.isArray(answer) && answer.length === 0)) {
      unverifiable.push({ key: rule.key, question: rule.question, reason: "not answered" });
      continue;
    }
    const verdict = readRule(rule, answer, now);
    if (verdict.ok === false) failed.push({ key: rule.key, question: rule.question, answer, reason: verdict.reason });
    if (verdict.ok === "unknown") unverifiable.push({ key: rule.key, question: rule.question, reason: verdict.reason });
  }
  return { evaluatedAt: now.toISOString(), passed: failed.length === 0, failedRules: failed, unverifiable };
}

type Verdict = { ok: true } | { ok: false; reason: string } | { ok: "unknown"; reason: string };

/** The last guard: whatever a rule holds, the workflow carries on and a person reads the answer. */
function readRule(rule: EligibilityRule, answer: unknown, now: Date): Verdict {
  try {
    return evaluateRule(rule, answer, now);
  } catch {
    return { ok: "unknown", reason: "the rule could not be read" };
  }
}

function truthy(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["yes", "y", "true", "1"].includes(s)) return true;
    if (["no", "n", "false", "0"].includes(s)) return false;
  }
  return null;
}

function evaluateRule(rule: EligibilityRule, answer: unknown, now: Date): Verdict {
  const raw: unknown = rule.expectation;
  const exp = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  switch (rule.type) {
    case "license":
    case "certification":
    case "work_authorization":
    case "physical_requirement_bona_fide":
    case "minimum_age_legal": {
      const t = truthy(answer);
      if (t === null) return { ok: "unknown", reason: "answer not yes/no" };
      return t ? { ok: true } : { ok: false, reason: `answered no to: ${rule.question}` };
    }
    case "schedule_availability": {
      // The job page asks yes or no unless the rule lists its days as a list, so a yes or no answers the question as asked.
      const t = truthy(answer);
      if (t !== null) return t ? { ok: true } : { ok: false, reason: "not available for the required schedule" };
      const given = daysOf(answer);
      if (!given) return { ok: "unknown", reason: "answer not yes/no or a list of days" };
      const required = daysOf(exp.days);
      if (!required?.length) return { ok: "unknown", reason: "the days the job needs could not be read" };
      const missing = required.filter((d) => !given.includes(d));
      return missing.length === 0 ? { ok: true } : { ok: false, reason: `not available: ${missing.join(", ")}` };
    }
    case "start_date": {
      const withinDays = lengthInDays(exp.withinDays);
      const t = truthy(answer);
      if (t !== null) {
        if (t) return { ok: true };
        return { ok: false, reason: withinDays === null ? `answered no to: ${rule.question}` : `cannot start within ${withinDays} days` };
      }
      if (withinDays === null) return { ok: "unknown", reason: "the start window could not be read" };
      // Only a written date with a year is read as one: Date.parse would take "1" or "May 3" as a day in 2001.
      const written = typeof answer === "string" && /\d{4}/.test(answer) ? answer : null;
      const d = written === null ? Number.NaN : Date.parse(written);
      if (Number.isNaN(d)) return { ok: "unknown", reason: "start date not parseable" };
      const limit = now.getTime() + withinDays * 86_400_000;
      return d <= limit ? { ok: true } : { ok: false, reason: `earliest start ${written} is after ${withinDays} days` };
    }
    case "location_radius": {
      // We never geocode candidates automatically; the candidate answers whether they can commute.
      const t = truthy(answer);
      if (t === null) return { ok: "unknown", reason: "answer not yes/no" };
      return t ? { ok: true } : { ok: false, reason: "cannot work at the required location" };
    }
    default:
      return { ok: "unknown", reason: "unsupported rule type" };
  }
}

/** A start window as a number of days: 30, "30", "30 days", "2–4 weeks" (the upper end); null when it is not one. */
function lengthInDays(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : daysWithin(v);
}

/* Days of the week, as the job page's boxes send them ("Mon" to "Sun"), from whatever words or shape they came in. */

const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
type Day = (typeof WEEK)[number];

const DAY_OF: Readonly<Record<string, Day>> = {
  monday: "Mon", mon: "Mon",
  tuesday: "Tue", tues: "Tue", tue: "Tue",
  wednesday: "Wed", weds: "Wed", wed: "Wed",
  thursday: "Thu", thurs: "Thu", thur: "Thu", thu: "Thu",
  friday: "Fri", fri: "Fri",
  saturday: "Sat", sat: "Sat",
  sunday: "Sun", sun: "Sun",
};
// Full names may be plural ("Saturdays"); short ones may not, so "thus" is never Thursday. Longest first within each.
const byLength = (names: string[]) => names.sort((a, b) => b.length - a.length).join("|");
const DAY_NAME = `(?:(?:${byLength(Object.keys(DAY_OF).filter((k) => k.endsWith("day")))})s?|${byLength(Object.keys(DAY_OF).filter((k) => !k.endsWith("day")))})`;
const ONE_DAY = new RegExp(`\\b${DAY_NAME}\\b`, "g");
const DAY_RANGE = new RegExp(`\\b(${DAY_NAME})\\s*(?:-|to|through|thru|until|till)\\s*(${DAY_NAME})\\b`, "g");

/**
 * Wording that leaves some of the named days out, offers a choice of them, or makes some only occasional: "no Sundays",
 * "Mon & Wed or Tue & Thu", "any 3 days", "some weekends", "between Monday and Saturday", "Saturdays as needed", "every
 * other Saturday", "one Sunday a month". Read as "every day named is required", it would hold a candidate the owner may
 * well take, so a person reads it instead.
 */
const SOME_DAYS_ONLY = new RegExp(
  `\\b(?:not|no|except|excluding|without|but|or|either|any|some|alternat\\w*|every (?:other|second)|rota\\w*|as needed|if needed|when needed|as required|on[- ]?call|occasional\\w*|sometimes|optional|flexible|preferred|may|might|monthly|(?:a|per|each|every) month|between ${DAY_NAME})\\b`,
);
/** "3 days a week", "four shifts per week": fewer days than the text names means some of them, not all of them. */
const DAYS_PER_WEEK = /\b(\d|one|two|three|four|five|six|seven)\s+(?:days?|shifts?)\s+(?:a|per|each|every)\s+week\b/;
const NUMBER_WORD: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };

const dayOf = (word: string): Day | undefined => DAY_OF[word] ?? DAY_OF[word.replace(/s$/, "")];

/** Every day from `from` to `to`, going round the week: "Fri" to "Mon" is Fri, Sat, Sun, Mon. */
function dayRange(from: Day, to: Day): Day[] {
  const start = WEEK.indexOf(from);
  const length = ((WEEK.indexOf(to) - start + 7) % 7) + 1;
  return Array.from({ length }, (_, i) => WEEK[(start + i) % 7]);
}

/**
 * The days a piece of text names, every one of them required: "Mon, Wed and Fri", "Monday–Friday", "Mon-Fri", "M-F",
 * "weekdays", "weekends", "every day". Null when it names none, or when only some of the days it names are needed
 * (`SOME_DAYS_ONLY`, `DAYS_PER_WEEK`): "no Sundays" read the other way round would even ask for the day the owner ruled
 * out. A rule that cannot be read is never a fail; a person reads the answer instead.
 */
function daysInText(text: string): Day[] | null {
  const t = text.toLowerCase().replace(/[–—]/g, "-");
  if (SOME_DAYS_ONLY.test(t)) return null;
  const found = new Set<Day>();
  const add = (days: readonly Day[]) => {
    for (const d of days) found.add(d);
  };
  if (/\bweek\s?days?\b/.test(t) || /\bm\s*-\s*f\b/.test(t)) add(dayRange("Mon", "Fri"));
  if (/\bweek\s?ends?\b/.test(t)) add(["Sat", "Sun"]);
  if (/\b(?:every\s?day|daily|all week|7 days|seven days)\b/.test(t)) add(WEEK);
  for (const m of t.matchAll(DAY_RANGE)) {
    const from = dayOf(m[1]);
    const to = dayOf(m[2]);
    if (from && to) add(dayRange(from, to));
  }
  for (const w of t.match(ONE_DAY) ?? []) {
    const d = dayOf(w);
    if (d) add([d]);
  }
  const perWeek = DAYS_PER_WEEK.exec(t)?.[1];
  if (perWeek && (NUMBER_WORD[perWeek] ?? Number(perWeek)) < found.size) return null;
  return found.size ? WEEK.filter((d) => found.has(d)) : null;
}

/**
 * Days from any shape: a list ["Mon", "Tue"] or ["Monday–Friday"], one string "Monday–Friday", or an object of days
 * {"Sat": true, "Sun": false} or {"from": "Mon", "to": "Fri"}. Nothing at all is no days ([]); a number, or anything that
 * names no day, is null (cannot be read).
 */
function daysOf(value: unknown): Day[] | null {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") return daysInText(value);
  if (Array.isArray(value)) {
    const found = new Set<Day>();
    for (const v of value) {
      const days = typeof v === "string" ? daysInText(v) : null;
      if (!days) return null;
      for (const d of days) found.add(d);
    }
    return WEEK.filter((d) => found.has(d));
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const from = o.from ?? o.start;
    const to = o.to ?? o.end;
    if (typeof from === "string" && typeof to === "string") return daysInText(`${from} to ${to}`);
    const keyed = Object.entries(o).flatMap(([k, v]) => {
      const d = dayOf(k.trim().toLowerCase());
      return d ? [{ d, wanted: v !== null && v !== 0 && truthy(v) !== false }] : [];
    });
    if (!keyed.length) return null;
    return WEEK.filter((d) => keyed.some((x) => x.d === d && x.wanted));
  }
  return null;
}
