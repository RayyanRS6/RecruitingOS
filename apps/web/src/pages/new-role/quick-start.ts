import { formatPayRange, INTAKE_FIRST_MESSAGE_MAX, type IntakeAnswer, type IntakeFacts, type IntakeFactsPatch, type IntakeQuestion, type IntakeQuestionField } from "@ros/contracts";
import { closingDateProblem, closingDateRequiredFor } from "../../publishing";
import { GENERAL_QUESTIONS, guideRoleFor } from "./quick-starts";
import { aiSuggestFor, readAiSuggest, type AiSuggest } from "./quick-suggest";
import { dayWords, payPayload, payProblem, type PayForm } from "./rules";

/**
 * The quick start for a new job (Wave S2, K2): ten small steps, one question a screen, then "Write the job post", which
 * hands every answer to the existing job builder. Nothing here needs a browser, so tests/web/start-hire-quick.test.ts
 * checks it: the steps and what each one asks, when a step may move on, what the review shows, the first message the
 * draft starts with, the one edit that sets the answers on the draft (the server runs the fairness check on every word),
 * the job ad read to fill in the steps, and the copy kept in this browser so a reload loses nothing.
 */

export const QUICK_STEPS = ["title", "type", "where", "experience", "pay", "closing", "musts", "dealbreakers", "questions", "review"] as const;
export type QuickStepId = (typeof QUICK_STEPS)[number];

/** What each step is called on the review and in "Step 3 of 10 · Where". */
export const STEP_LABEL: Readonly<Record<QuickStepId, string>> = {
  title: "Job title",
  type: "Employment type",
  where: "Where",
  experience: "Minimum experience",
  pay: "Pay",
  closing: "Closing date",
  musts: "Must-have skills",
  dealbreakers: "Deal-breakers",
  questions: "Screening questions",
  review: "Review",
};

/** The one question each screen asks (its heading). */
export const STEP_QUESTION: Readonly<Record<QuickStepId, string>> = {
  title: "What is the job title?",
  type: "What kind of job is it?",
  where: "Where will they work?",
  experience: "How much experience do they need?",
  pay: "What does it pay?",
  closing: "When do applications close?",
  musts: "Which skills are a must?",
  dealbreakers: "What rules someone out?",
  questions: "What should every applicant answer?",
  review: "Check your answers",
};

/** One short line under each question. */
export const STEP_HINT: Readonly<Record<QuickStepId, string>> = {
  title: "Or paste a job ad you already have to fill in the steps.",
  type: "Pick one.",
  where: "Pick one, then say the place.",
  experience: "Pick the least you would accept.",
  pay: "Pay is always shown on your job ad.",
  closing: "You can change it later.",
  musts: "Every applicant is checked against these.",
  dealbreakers: "Each one passes a fairness check first.",
  questions: "Yes/no questions on the form. Ones you add are asked in the screening chat.",
  review: "The assistant writes the job post from these.",
};

export const EMPLOYMENT_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "full_time", label: "Full time" },
  { value: "part_time", label: "Part time" },
  { value: "contract", label: "Contract" },
  { value: "internship", label: "Internship" },
  { value: "temporary", label: "Temporary" },
];

export const WORK_MODEL_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "onsite", label: "On site" },
  { value: "hybrid", label: "Hybrid" },
  { value: "remote", label: "Remote" },
];

export const EXPERIENCE_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "none", label: "No minimum" },
  { value: "1", label: "1+ year" },
  { value: "2", label: "2+ years" },
  { value: "3", label: "3+ years" },
  { value: "5", label: "5+ years" },
  { value: "8", label: "8+ years" },
];

/** "Anyone with less?" once a minimum is set. */
export const BELOW_CHOICES: ReadonlyArray<{ value: "consider" | "must"; label: string }> = [
  { value: "consider", label: "Still consider them" },
  { value: "must", label: "Count it as a must-have" },
];

/** At most six must-haves (MAX_MUST_HAVES on the server); a few deal-breakers and questions, so one edit carries them all. */
export const MUST_HAVES_MAX = 6;
export const DEAL_BREAKERS_MAX = 5;
export const OWN_QUESTIONS_MAX = 5;
const ITEM_MAX = 300;

export type QuickAnswers = {
  title: string;
  /** A job ad pasted on the first step: it fills in the steps and goes with the first message. */
  ad: string;
  employmentType: string;
  remotePolicy: string;
  place: string;
  experience: string;
  below: "" | "consider" | "must";
  pay: PayForm;
  closesOn: string;
  noClosingDate: boolean;
  /** Ticked suggestions and the person's own, in order. */
  mustHaves: string[];
  /** Must-haves read from a pasted job ad: offered on the must-haves step to tick, never used until ticked. */
  adMustHaves: string[];
  dealBreakers: string[];
  /**
   * Deal-breakers the person unticked from "Count it openly as a must-have" (founder decision Q19: a deal-breaker counts
   * openly as a must-have, after the fairness check, unless the person says not). An unticked one judges nobody.
   */
  dealBreakersPrivate: string[];
  noDealBreakers: boolean;
  /** Suggested questions the person unticked (suggestions start ticked). */
  questionsOff: string[];
  ownQuestions: string[];
  /**
   * The assistant's suggestions for a job no hiring guide knows (Wave S3, G3), with the answers they were made from
   * (quick-suggest.ts). Its must-haves are offered unticked; its questions are offered ticked, like the guide's.
   */
  aiSuggest: AiSuggest | null;
};

/**
 * Where the quick start stands: the screen, the answers, whether Next goes back to the review, and the draft once made.
 * `companyId` is the company the answers were given for: answers kept for another company are never shown.
 */
export type QuickState = { step: number; answers: QuickAnswers; fromReview: boolean; sessionId: string | null; companyId?: string | null };

export function emptyQuickAnswers(): QuickAnswers {
  return {
    title: "", ad: "", employmentType: "", remotePolicy: "", place: "", experience: "", below: "",
    pay: { basis: "", min: "", max: "", ceiling: "" }, closesOn: "", noClosingDate: false,
    mustHaves: [], adMustHaves: [], dealBreakers: [], dealBreakersPrivate: [], noDealBreakers: false, questionsOff: [], ownQuestions: [],
    aiSuggest: null,
  };
}

export function emptyQuickState(companyId: string | null = null): QuickState {
  return { step: 0, answers: emptyQuickAnswers(), fromReview: false, sessionId: null, ...(companyId ? { companyId } : {}) };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const labelOf = (list: ReadonlyArray<{ value: string; label: string }>, value: string) => list.find((c) => c.value === value)?.label ?? value;

/** A day as the date box writes it, in this browser's own time. */
export function todayDay(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Lists                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Ticks or unticks one item. */
export function toggleItem(list: readonly string[], value: string): string[] {
  return list.some((x) => same(x, value)) ? list.filter((x) => !same(x, value)) : [...list, value];
}

/** Adds typed words as one more item, once, up to `max`; the list is unchanged when there is nothing to add or no room. */
export function addItem(list: readonly string[], text: string, max: number): string[] {
  const t = text.trim().replace(/\s+/g, " ").slice(0, ITEM_MAX);
  if (!t || list.some((x) => same(x, t)) || list.length >= max) return [...list];
  return [...list, t];
}

/** The experience line when it is a must-have ("At least 3 years of relevant experience"), else null. */
export function experienceMustHave(a: Pick<QuickAnswers, "experience" | "below">): string | null {
  const n = Number(a.experience);
  if (!Number.isFinite(n) || n <= 0 || a.below !== "must") return null;
  return `At least ${n} year${n === 1 ? "" : "s"} of relevant experience`;
}

/** The experience line when it is welcome but not required ("3+ years of relevant experience"), else null. */
export function experienceNiceToHave(a: Pick<QuickAnswers, "experience" | "below">): string | null {
  const n = Number(a.experience);
  if (!Number.isFinite(n) || n <= 0 || a.below !== "consider") return null;
  return `${n}+ year${n === 1 ? "" : "s"} of relevant experience`;
}

type DealBreakerAnswers = Partial<Pick<QuickAnswers, "dealBreakers" | "dealBreakersPrivate" | "noDealBreakers" | "mustHaves">>;

/**
 * The deal-breakers that count openly as must-haves (founder decision Q19): every one the person added and left ticked,
 * unless it is already one of their must-haves. Each still passes the server's fairness check.
 */
export function openDealBreakers(a: DealBreakerAnswers): string[] {
  if (a.noDealBreakers) return [];
  const priv = a.dealBreakersPrivate ?? [];
  const musts = a.mustHaves ?? [];
  return (a.dealBreakers ?? []).filter((d) => !priv.some((p) => same(p, d)) && !musts.some((m) => same(m, d)));
}

/** How many skills may still be ticked: six in all, one fewer when the experience is a must-have, and one fewer for each deal-breaker counted openly. */
export function mustHavesRoom(a: Pick<QuickAnswers, "experience" | "below"> & DealBreakerAnswers): number {
  return MUST_HAVES_MAX - (experienceMustHave(a) ? 1 : 0) - openDealBreakers(a).length;
}

/** Every must-have the draft will carry, in order: the skills, the experience when it counts, the deal-breakers counted openly. */
export function allMustHaves(a: Pick<QuickAnswers, "experience" | "below" | "mustHaves"> & DealBreakerAnswers): string[] {
  const exp = experienceMustHave(a);
  const out: string[] = [];
  for (const m of [...a.mustHaves, ...(exp ? [exp] : []), ...openDealBreakers(a)]) if (!out.some((x) => same(x, m))) out.push(m);
  return out;
}

/** The must-haves our hiring guide knows for this job (none when it does not know the job). */
export function suggestedMustHaves(vertical: string | null | undefined, title: string): readonly string[] {
  return guideRoleFor(vertical, title)?.mustHaves ?? [];
}

/** The yes/no questions offered: the guide's for this job, or the general ones. */
export function suggestedQuestions(vertical: string | null | undefined, title: string): readonly string[] {
  return guideRoleFor(vertical, title)?.questions ?? GENERAL_QUESTIONS;
}

type QuestionAnswers = Pick<QuickAnswers, "questionsOff" | "title"> & Partial<QuickAnswers>;

/**
 * Every yes/no question offered on the screening step, ticked unless the person unticked it: the guide's for a job it
 * knows; else the general ones, then the assistant's for these very answers (Wave S3, G3), each once.
 */
export function offeredQuestions(a: QuestionAnswers, vertical: string | null | undefined): readonly string[] {
  if (guideRoleFor(vertical, a.title)) return suggestedQuestions(vertical, a.title);
  const ai = aiSuggestFor(a)?.questions ?? [];
  return [...GENERAL_QUESTIONS, ...ai.filter((q) => !GENERAL_QUESTIONS.some((g) => same(g, q)))];
}

/** The one edit carries at most twenty list items (IntakeFactsPatch.add). */
const PATCH_ADD_MAX = 20;

/**
 * Room on the one edit for the questions on the form, after every other item it carries (must-haves, the experience as
 * a nice-to-have, deal-breakers, the person's own questions): an offered question is what gives way, never the person's own words.
 */
function formQuestionsRoom(a: QuestionAnswers): number {
  const exp = { experience: a.experience ?? "", below: a.below ?? "" } as const;
  const musts = allMustHaves({ ...exp, mustHaves: a.mustHaves ?? [], dealBreakers: a.dealBreakers, dealBreakersPrivate: a.dealBreakersPrivate, noDealBreakers: a.noDealBreakers }).slice(0, MUST_HAVES_MAX).length;
  const nice = experienceNiceToHave(exp) ? 1 : 0;
  const deals = a.noDealBreakers ? 0 : Math.min((a.dealBreakers ?? []).length, DEAL_BREAKERS_MAX);
  const own = Math.min((a.ownQuestions ?? []).length, OWN_QUESTIONS_MAX);
  return Math.max(0, PATCH_ADD_MAX - musts - nice - deals - own);
}

/** The offered questions still ticked, as many as the one edit has room for. */
export function chosenQuestions(a: QuestionAnswers, vertical: string | null | undefined): string[] {
  return offeredQuestions(a, vertical).filter((q) => !a.questionsOff.some((x) => same(x, q))).slice(0, formQuestionsRoom(a));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Moving on                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What stops a step from moving on, in plain words, or null when it may. */
export function stepProblem(step: QuickStepId, a: QuickAnswers, today: string): string | null {
  switch (step) {
    case "title":
      if (!a.title.trim()) return "Type the job title, or paste a job ad.";
      if (a.title.trim().length > 120) return "Keep the title under 120 characters.";
      return null;
    case "type":
      return a.employmentType ? null : "Pick the kind of job.";
    case "where":
      if (!a.remotePolicy) return "Pick on site, hybrid or remote.";
      return a.place.trim() ? null : a.remotePolicy === "remote" ? "Say where they can live, for example Anywhere in the US." : "Type the city or the address.";
    case "experience":
      if (!a.experience) return "Pick the least experience you would accept.";
      if (a.experience !== "none" && !a.below) return "Say whether you would still consider someone with less.";
      return null;
    case "pay":
      return payProblem(a.pay);
    case "closing":
      if (a.noClosingDate) return null;
      return a.closesOn ? closingDateProblem(a.closesOn, today) : "Pick a date, or choose No closing date.";
    case "musts": {
      if (!allMustHaves(a).length) return "Tick or add at least one must-have.";
      const room = Math.max(0, mustHavesRoom(a));
      if (a.mustHaves.length > room) return openDealBreakers(a).length ? `Keep it to ${room}, with your deal-breakers counted. Anything else can wait for the draft.` : `Keep it to ${room}. Anything else can wait for the draft.`;
      return null;
    }
    case "dealbreakers":
      if (!a.noDealBreakers && !a.dealBreakers.length) return "Add what rules someone out, or choose None.";
      if (allMustHaves(a).length > MUST_HAVES_MAX) return `Six must-haves at most, with your skills. Untick one here, or take a skill off.`;
      return null;
    case "questions":
    case "review":
      return null;
  }
}

/** The first step that is not finished, or null: the review checks them all before writing. */
export function firstUnfinished(a: QuickAnswers, today: string): number | null {
  const i = QUICK_STEPS.findIndex((s) => stepProblem(s, a, today) !== null);
  return i < 0 ? null : i;
}

/**
 * Whether a key press moves on: Enter on a field or a choice, never in a text box (a new line), never on a button (it
 * presses itself), never while an accented letter or a word is still being composed.
 */
export function enterMovesOn(e: { key: string; shiftKey?: boolean; isComposing?: boolean }, target: { tagName?: string; type?: string } | null): boolean {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return false;
  const tag = (target?.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "BUTTON" || tag === "A" || tag === "SUMMARY") return false;
  return !(tag === "INPUT" && ["button", "submit", "reset"].includes((target?.type ?? "").toLowerCase()));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The review                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

/** The pay as people read it ("$45–$55 an hour, at most $58"), or null while it is not set. */
export function payWords(form: PayForm): string | null {
  const p = payPayload(form);
  if (!p) return null;
  return `${formatPayRange(p)}${p.ceiling !== undefined ? `, at most ${money(p.ceiling)}` : ""}`;
}

export function experienceWords(a: Pick<QuickAnswers, "experience" | "below">): string {
  if (!a.experience) return "Not answered";
  if (a.experience === "none") return "No minimum";
  const years = labelOf(EXPERIENCE_CHOICES, a.experience);
  return a.below === "must" ? `${years} · counts as a must-have` : `${years} · anyone with less is still considered`;
}

/** One row a step on the review: what it is called, the answer, and the step its Edit opens. */
export function reviewRows(a: QuickAnswers, vertical: string | null | undefined): Array<{ step: number; label: string; value: string }> {
  const onForm = chosenQuestions(a, vertical).length;
  const inChat = a.ownQuestions.length;
  const questions = [...(onForm ? [`${onForm} on the form`] : []), ...(inChat ? [`${inChat} in the screening chat`] : [])].join(" · ");
  const open = openDealBreakers(a);
  const deal = a.dealBreakers.map((d) => (open.some((o) => same(o, d)) || a.mustHaves.some((m) => same(m, d)) ? `${d} (must-have)` : `${d} (not used to judge)`));
  const musts = allMustHaves(a);
  const where = a.remotePolicy ? `${labelOf(WORK_MODEL_CHOICES, a.remotePolicy)}${a.place.trim() ? ` · ${a.place.trim()}` : ""}` : "Not answered";
  const rows: Array<[QuickStepId, string]> = [
    ["title", a.title.trim() || "Not answered"],
    ["type", a.employmentType ? labelOf(EMPLOYMENT_CHOICES, a.employmentType) : "Not answered"],
    ["where", where],
    ["experience", experienceWords(a)],
    ["pay", payWords(a.pay) ?? "Not answered"],
    ["closing", a.noClosingDate ? "No closing date" : a.closesOn ? dayWords(a.closesOn) : "Not answered"],
    ["musts", a.mustHaves.length || open.length ? musts.join("; ") : experienceMustHave(a) ? "Only the experience" : "Not answered"],
    ["dealbreakers", a.noDealBreakers ? "None" : deal.length ? deal.join("; ") : "Not answered"],
    ["questions", questions || "None"],
  ];
  return rows.map(([id, value]) => ({ step: QUICK_STEPS.indexOf(id), label: STEP_LABEL[id], value }));
}

/** Whether the law asks this job's ad for a closing date (Colorado, or remote), the builder's own rule. */
export function closingDateAsked(a: Pick<QuickAnswers, "remotePolicy" | "place">): boolean {
  return closingDateRequiredFor({ remotePolicy: a.remotePolicy, locationText: a.place });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Handing over to the job builder                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The draft's first message: the plain facts, one a line, as the person's own words in the conversation, then any job ad
 * they pasted. Lists (must-haves, deal-breakers, questions) go in the edit that follows, item by item, so each one is
 * stored whole and passes the fairness check.
 */
export function firstMessage(a: QuickAnswers): string {
  const pay = payWords(a.pay);
  const lines = [
    "Quick start for a new job.",
    `Job title: ${a.title.trim()}`,
    `Employment type: ${labelOf(EMPLOYMENT_CHOICES, a.employmentType)}`,
    `Where: ${labelOf(WORK_MODEL_CHOICES, a.remotePolicy)}, ${a.place.trim()}`,
    `Minimum experience: ${a.experience === "none" || !a.experience ? "No minimum" : `${labelOf(EXPERIENCE_CHOICES, a.experience)}${a.below === "must" ? ", required" : ", preferred"}`}`,
    ...(pay ? [`Pay: ${pay}`] : []),
    `Closing date: ${a.noClosingDate || !a.closesOn ? "None" : dayWords(a.closesOn)}`,
  ];
  const head = lines.join("\n");
  const ad = a.ad.trim();
  if (!ad) return head;
  const intro = "\n\nThe job ad we already have:\n";
  return `${head}${intro}${ad}`.slice(0, INTAKE_FIRST_MESSAGE_MAX);
}

/** Set on a draft the quick start made (in the page's query cache, never the address), so the job builder writes the post as soon as it opens, once. */
export const quickStartDraftKey = (sessionId: string) => ["intake", "quick-start", sessionId] as const;

/** The card questions the quick start already answered: skipped, so they leave the conversation. The rest stay open. */
const COVERED: ReadonlySet<IntakeQuestionField> = new Set<IntakeQuestionField>(["title", "location", "employment_type", "remote_policy", "compensation_basis", "compensation", "must_haves", "nice_to_haves", "deal_breakers", "screening_questions", "eligibility"]);

/**
 * The server's card that offers deal-breakers back as must-haves (founder decision Q19): its id is renumbered with the
 * others, so it is known by its question. It is never skipped: deal-breakers read from a pasted ad are asked about there.
 */
export function isDealBreakerCard(q: Pick<IntakeQuestion, "id" | "field"> & { prompt?: string }): boolean {
  return q.id === "deal" || (q.field === "must_haves" && /deal[\s-]?breakers?/i.test(q.prompt ?? ""));
}

export function skippedAnswers(questions: readonly (Pick<IntakeQuestion, "id" | "field"> & { prompt?: string })[]): IntakeAnswer[] {
  return questions.filter((q) => COVERED.has(q.field) && !isDealBreakerCard(q)).slice(0, 3).map((q) => ({ questionId: q.id, selected: [], own: [], skipped: true }));
}

/** An experience line the assistant may have read from the first message ("3+ years of experience"). */
const EXPERIENCE_LINE = /\b\d{1,2}\s*\+?\s*(?:years?|yrs?)\b.*\bexperience\b|\bexperience\b.*\b\d{1,2}\s*\+?\s*(?:years?|yrs?)\b/i;

/**
 * The one edit (POST /intake/sessions/:id/answers, `patch`) that puts the answers on the draft: the plain facts set,
 * pay set by this person, and each list item added (the server's fairness check reads every one). The must-haves are the
 * person's choice, all of them: anything the assistant read as a must-have from the first message or a pasted ad that
 * the person did not tick is taken out (they were offered the ad's on the must-haves step), and so is an experience line
 * it read as a nice-to-have that differs from the person's answer. Deal-breakers left ticked count openly as must-haves
 * (Q19). Suggested yes/no questions go with the eligibility, questions typed by the person with the screening chat.
 */
export function quickStartPatch(a: QuickAnswers, vertical: string | null | undefined, existing: (Pick<IntakeFacts, "mustHaves"> & Partial<Pick<IntakeFacts, "niceToHaves">>) | null): IntakeFactsPatch {
  const pay = payPayload(a.pay);
  const musts = allMustHaves(a).slice(0, MUST_HAVES_MAX);
  const nice = experienceNiceToHave(a);
  const add: NonNullable<IntakeFactsPatch["add"]> = [
    ...musts.map((value) => ({ field: "mustHaves" as const, value })),
    ...(nice ? [{ field: "niceToHaves" as const, value: nice }] : []),
    ...(a.noDealBreakers ? [] : a.dealBreakers.slice(0, DEAL_BREAKERS_MAX).map((value) => ({ field: "dealBreakers" as const, value }))),
    ...chosenQuestions(a, vertical).map((value) => ({ field: "eligibilityNotes" as const, value })),
    ...a.ownQuestions.slice(0, OWN_QUESTIONS_MAX).map((value) => ({ field: "screeningQuestions" as const, value })),
  ].slice(0, 20);
  const extraMusts = (existing?.mustHaves ?? []).filter((x) => !musts.some((m) => same(m, x)));
  const extraNice = (existing?.niceToHaves ?? []).filter((x) => EXPERIENCE_LINE.test(x) && !(nice && same(nice, x)));
  const remove = [
    ...extraMusts.map((value) => ({ field: "mustHaves" as const, value: value.slice(0, 500) })),
    ...extraNice.map((value) => ({ field: "niceToHaves" as const, value: value.slice(0, 500) })),
  ].slice(0, 20);
  return {
    set: {
      title: a.title.trim(),
      employmentType: a.employmentType,
      remotePolicy: a.remotePolicy,
      locationText: a.place.trim(),
      ...(pay ? { pay } : {}),
    },
    ...(add.length ? { add } : {}),
    ...(remove.length ? { remove } : {}),
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* A pasted job ad fills in the steps                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

export type AdFacts = { title?: string; employmentType?: string; remotePolicy?: string; place?: string; pay?: PayForm; experience?: string; mustHaves?: string[] };

/** A heading over the ad's requirements ("Requirements", "Must have", "What you'll need"). */
const REQUIREMENTS_HEADING = /^(?:requirements|required|must[\s-]?haves?|qualifications|required qualifications|what you(?:'|’)ll need|what you need|what we(?:'|’)re looking for)\s*:?$/i;
const BULLET = /^(?:[-*•·]|\d{1,2}[.)])\s+(.+)$/;

/** The bullet points under the ad's requirements heading, at most six, as the person could tick them. */
function adRequirements(lines: readonly string[]): string[] {
  const out: string[] = [];
  let inside = false;
  let gap = 0;
  for (const l of lines) {
    if (REQUIREMENTS_HEADING.test(l)) { inside = true; gap = 0; continue; }
    if (!inside) continue;
    const item = l.match(BULLET)?.[1]?.trim();
    if (!item) {
      // the list ends at the first line that is not a bullet; one line of words may sit between the heading and the list
      if (out.length || ++gap > 1) inside = false;
      if (out.length) break;
      continue;
    }
    if (item.length <= 200 && !out.some((x) => same(x, item))) out.push(item);
    if (out.length >= MUST_HAVES_MAX) break;
  }
  return out;
}

const EXPERIENCE_STEPS = [8, 5, 3, 2, 1];

/**
 * What a pasted ad states plainly, read with simple rules (no AI): a labelled or first-line title, the kind of job, the
 * work model, the place, a pay range and the years of experience. Anything unclear is left for the person.
 */
export function readAd(text: string): AdFacts {
  const out: AdFacts = {};
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const labelled = (label: RegExp) => lines.map((l) => l.match(new RegExp(`^(?:${label.source})\\s*[:\\-–]\\s*(.+)$`, "i"))?.[1]?.trim()).find(Boolean);
  const first = lines[0] ?? "";
  const heading = first && first.length <= 80 && !/[.!?]$/.test(first) && !/^(?:about|we are|we're|join|our)\b/i.test(first) ? first.replace(/^(?:now hiring|we(?:'|’)re hiring|hiring)\s*[:\-–]?\s*/i, "") : undefined;
  const title = labelled(/job title|title|position|role/) ?? heading;
  if (title) out.title = title.slice(0, 120);
  if (/\bfull[\s-]?time\b/i.test(text)) out.employmentType = "full_time";
  else if (/\bpart[\s-]?time\b/i.test(text)) out.employmentType = "part_time";
  else if (/\binternship\b|\bintern\b/i.test(text)) out.employmentType = "internship";
  else if (/\bcontract(?:or)?\b/i.test(text)) out.employmentType = "contract";
  else if (/\btemporary\b|\btemp\b/i.test(text)) out.employmentType = "temporary";
  if (/\bhybrid\b/i.test(text)) out.remotePolicy = "hybrid";
  else if (/\b(?:fully\s+)?remote\b/i.test(text) && !/\b(?:no|not|never)\s+(?:fully\s+)?remote\b/i.test(text)) out.remotePolicy = "remote";
  else if (/\bon[\s-]?site\b|\bin[\s-]?office\b|\bin[\s-]?person\b/i.test(text)) out.remotePolicy = "onsite";
  const place = labelled(/location|where|based in/) ?? text.match(/\bin ([A-Z][a-z]+(?: [A-Z][a-z]+)?, [A-Z]{2})\b/)?.[1];
  if (place) out.place = place.slice(0, 200);
  const pay = text.replace(/(\d),(\d{3})/g, "$1$2").match(/\$\s?(\d+(?:\.\d+)?)\s*(k)?\s*(?:-|–|—|to)\s*\$?\s?(\d+(?:\.\d+)?)\s*(k)?\s*(per hour|an hour|\/\s?hr|\/\s?hour|hourly|per year|a year|\/\s?yr|\/\s?year|annually|salary)?/i);
  if (pay) {
    const min = Number(pay[1]) * (pay[2] || pay[4] ? 1000 : 1);
    const max = Number(pay[3]) * (pay[4] ? 1000 : 1);
    const basis: "hourly" | "salary" = pay[5] ? (/hour|hr/i.test(pay[5]) ? "hourly" : "salary") : max >= 1000 ? "salary" : "hourly";
    if (min > 0 && max >= min) out.pay = { basis, min: String(min), max: String(max), ceiling: "" };
  }
  const years = text.match(/\b(\d{1,2})\s*\+?\s*(?:years?|yrs?)(?:\s+of)?(?:\s+[\w-]+){0,3}?\s+experience\b/i);
  if (years) {
    const n = Number(years[1]);
    const step = EXPERIENCE_STEPS.find((s) => n >= s);
    if (step) out.experience = String(step);
  }
  const musts = adRequirements(lines);
  if (musts.length) out.mustHaves = musts;
  return out;
}

/** Fills the steps still empty from the ad's facts; says which were filled. Nothing the person already answered changes. */
export function fillFromAd(a: QuickAnswers, ad: string): { answers: QuickAnswers; filled: string[] } {
  const f = readAd(ad);
  const next: QuickAnswers = { ...a, ad: ad.slice(0, INTAKE_FIRST_MESSAGE_MAX) };
  const filled: string[] = [];
  if (f.title && !a.title.trim()) { next.title = f.title; filled.push(STEP_LABEL.title); }
  if (f.employmentType && !a.employmentType) { next.employmentType = f.employmentType; filled.push(STEP_LABEL.type); }
  if ((f.remotePolicy && !a.remotePolicy) || (f.place && !a.place.trim())) {
    if (f.remotePolicy && !a.remotePolicy) next.remotePolicy = f.remotePolicy;
    if (f.place && !a.place.trim()) next.place = f.place;
    filled.push(STEP_LABEL.where);
  }
  if (f.experience && !a.experience) { next.experience = f.experience; filled.push(STEP_LABEL.experience); }
  if (f.pay && !a.pay.basis && !a.pay.min && !a.pay.max) { next.pay = f.pay; filled.push(STEP_LABEL.pay); }
  // The ad's requirements are offered on the must-haves step, unticked: only what the person ticks screens anyone.
  const fresh = (f.mustHaves ?? []).filter((m) => !a.adMustHaves.some((x) => same(x, m)));
  if (fresh.length) { next.adMustHaves = [...a.adMustHaves, ...fresh].slice(0, 12); filled.push(`${STEP_LABEL.musts} (to tick)`); }
  return { answers: next, filled };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Kept in this browser                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The answers so far live in this browser only, so a reload loses nothing; "Start over" and "Write the job post" clear
 * them, and so does signing out. They are kept per company and per person (`quickStartStorageKey`), because one browser
 * may serve two companies or two people, and the answers hold the private most-you-would-pay and the deal-breakers.
 */
export const QUICK_START_STORAGE_KEY = "ros:quick-start:v1";

/** Whose answers these are: the company they were given for and the person giving them. */
export type QuickScope = { companyId: string; userId: string };

/** The storage key for one person in one company (the bare key only where no one is known, as in the tests). */
export function quickStartStorageKey(scope?: QuickScope | null): string {
  return scope ? `${QUICK_START_STORAGE_KEY}:${scope.companyId}:${scope.userId}` : QUICK_START_STORAGE_KEY;
}

const str = (v: unknown, max = 20_000) => (typeof v === "string" ? v.slice(0, max) : "");
const strs = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.slice(0, ITEM_MAX)).slice(0, max) : []);

/**
 * Reads what was kept, or null when there is nothing (or storage cannot be read, or holds something else, or was kept
 * for another company).
 */
export function readQuickStart(storage: Pick<Storage, "getItem"> | null | undefined, scope?: QuickScope | null): QuickState | null {
  try {
    const raw = storage?.getItem(quickStartStorageKey(scope));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<QuickState> & { answers?: Partial<QuickAnswers> & { pay?: Partial<PayForm> } };
    if (!v || typeof v !== "object" || !v.answers || typeof v.answers !== "object") return null;
    if (scope && v.companyId !== scope.companyId) return null;
    const a = v.answers;
    const basis = a.pay?.basis === "hourly" || a.pay?.basis === "salary" ? a.pay.basis : "";
    const answers: QuickAnswers = {
      title: str(a.title, 120),
      ad: str(a.ad, INTAKE_FIRST_MESSAGE_MAX),
      employmentType: EMPLOYMENT_CHOICES.some((c) => c.value === a.employmentType) ? str(a.employmentType) : "",
      remotePolicy: WORK_MODEL_CHOICES.some((c) => c.value === a.remotePolicy) ? str(a.remotePolicy) : "",
      place: str(a.place, 200),
      experience: EXPERIENCE_CHOICES.some((c) => c.value === a.experience) ? str(a.experience) : "",
      below: a.below === "consider" || a.below === "must" ? a.below : "",
      pay: { basis, min: str(a.pay?.min, 20), max: str(a.pay?.max, 20), ceiling: str(a.pay?.ceiling, 20) },
      closesOn: /^\d{4}-\d{2}-\d{2}$/.test(str(a.closesOn)) ? str(a.closesOn) : "",
      noClosingDate: a.noClosingDate === true,
      mustHaves: strs(a.mustHaves, 12),
      adMustHaves: strs(a.adMustHaves, 12),
      dealBreakers: strs(a.dealBreakers, DEAL_BREAKERS_MAX),
      dealBreakersPrivate: strs(a.dealBreakersPrivate, DEAL_BREAKERS_MAX),
      noDealBreakers: a.noDealBreakers === true,
      questionsOff: strs(a.questionsOff, 12),
      ownQuestions: strs(a.ownQuestions, OWN_QUESTIONS_MAX),
      aiSuggest: readAiSuggest(a.aiSuggest),
    };
    const step = typeof v.step === "number" && Number.isInteger(v.step) ? Math.max(0, Math.min(v.step, QUICK_STEPS.length - 1)) : 0;
    const sessionId = typeof v.sessionId === "string" && /^[\w-]{1,64}$/.test(v.sessionId) ? v.sessionId : null;
    const companyId = typeof v.companyId === "string" && v.companyId ? v.companyId : null;
    return { step, answers, fromReview: v.fromReview === true, sessionId, ...(companyId ? { companyId } : {}) };
  } catch {
    return null;
  }
}

export function writeQuickStart(storage: Pick<Storage, "setItem"> | null | undefined, state: QuickState, scope?: QuickScope | null): void {
  try {
    storage?.setItem(quickStartStorageKey(scope), JSON.stringify(scope ? { ...state, companyId: scope.companyId } : state));
  } catch {
    // a browser that keeps nothing (private windows, blocked storage): the answers last until the page is reloaded
  }
}

export function clearQuickStart(storage: Pick<Storage, "removeItem"> | null | undefined, scope?: QuickScope | null): void {
  try {
    storage?.removeItem(quickStartStorageKey(scope));
  } catch {
    // nothing kept, nothing to clear
  }
}

/** Signing out forgets every quick start kept in this browser, for every company and person. */
export function clearAllQuickStarts(storage: Pick<Storage, "removeItem" | "key" | "length"> | null | undefined): void {
  try {
    if (!storage) return;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && (k === QUICK_START_STORAGE_KEY || k.startsWith(`${QUICK_START_STORAGE_KEY}:`))) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
  } catch {
    // storage that cannot be read keeps nothing to clear
  }
}

/** Whether any answer was given, so a fresh page is not mistaken for work in progress. */
export function hasAnswers(a: QuickAnswers): boolean {
  const texts = [a.title, a.ad, a.employmentType, a.remotePolicy, a.place, a.experience, a.below, a.pay.basis, a.pay.min, a.pay.max, a.pay.ceiling, a.closesOn];
  const lists = [a.mustHaves, a.adMustHaves, a.dealBreakers, a.dealBreakersPrivate, a.questionsOff, a.ownQuestions];
  return texts.some((t) => t.trim().length > 0) || lists.some((l) => l.length > 0) || a.noClosingDate || a.noDealBreakers;
}
