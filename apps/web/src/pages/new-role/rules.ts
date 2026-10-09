import {
  formatPayRange, INTAKE_FIRST_MESSAGE_MAX, INTAKE_MESSAGE_MAX, PACKET_VISIBILITY_LABEL, packetVisibility,
  type DraftRolePacket, type IntakeAnswer, type IntakeFacts, type IntakePayCard, type IntakeProgressStage, type IntakeQuestion, type IntakeQuestionField,
  type IntakeReadiness, type IntakeSessionView, type PacketVisibility,
} from "@ros/contracts";
import type { StepState } from "@ros/ui";
import { START_HIRE_HREF } from "../../start-hire";

/**
 * The job builder's rules that need no browser (plan Wave C: C5, C6, C7, C8, C15), kept out of the components so
 * tests/web/job-builder.test.ts can check them: the question cards' state and what they send, the one summary line the
 * picks are echoed as, the "what we know / still missing" list, the draft's sections and who sees each, the drafting
 * steps, and when Enter sends. The server decides everything that matters (readiness, pay, fairness); these only show it.
 */

/** A team card's "Someone not on the team yet" (SOMEONE_NEW in packages/core/src/intake-builder.ts): their name goes in `own`. */
export const SOMEONE_NEW = "__someone_new";

/** How the summary of tapped answers names each question (FIELD_LABEL in packages/core/src/intake-builder.ts). */
export const FIELD_LABEL: Readonly<Record<IntakeQuestionField, string>> = {
  title: "Job title",
  location: "Where",
  employment_type: "Full or part time",
  schedule: "Schedule",
  remote_policy: "Work model",
  reason_for_hire: "Why you are hiring",
  compensation_basis: "Paid",
  compensation: "Pay",
  responsibilities: "First thing they would own",
  must_haves: "Must-haves",
  nice_to_haves: "Nice to have",
  eligibility: "Eligibility",
  interviewers: "Who interviews",
  decision_maker: "Final decision",
  timeline: "Start",
  what_failure_looks_like: "What would not work out",
  deal_breakers: "Deal-breakers",
  screening_questions: "Screening questions",
  benefits: "Benefits",
};

/** Questions whose answer is a list (several picks become several lines of the draft). */
const LIST_FIELDS: ReadonlySet<IntakeQuestionField> = new Set<IntakeQuestionField>(["responsibilities", "must_haves", "nice_to_haves", "eligibility", "deal_breakers", "screening_questions"]);

const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/* ------------------------------------------------------------------------------------------------------------------ */
/* Question cards (C6, C15)                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What the pay card's boxes hold, as typed ("45", "$60,000", "60k"). */
export type PayForm = { basis: "hourly" | "salary" | ""; min: string; max: string; ceiling: string };
/** One card's answer so far: ticked values, words added as their own answers, the words still in the box, and the pay. */
export type CardAnswer = { selected: string[]; own: string[]; draft: string; pay: PayForm | null };
/** Which card is showing, and every card's answer. Cards are reset whenever the server sends new ones (`cardsKey`). */
export type CardState = { index: number; answers: Record<string, CardAnswer> };

const EMPTY_ANSWER: CardAnswer = { selected: [], own: [], draft: "", pay: null };

export function initialCards(): CardState {
  return { index: 0, answers: {} };
}

/** Changes when the server sends a different set of cards, so the page starts them afresh. */
export function cardsKey(questions: readonly Pick<IntakeQuestion, "id">[]): string {
  return questions.map((q) => q.id).join("|");
}

export function answerOf(state: CardState, q: Pick<IntakeQuestion, "id">): CardAnswer {
  return state.answers[q.id] ?? EMPTY_ANSWER;
}

function put(state: CardState, q: Pick<IntakeQuestion, "id">, a: CardAnswer): CardState {
  return { ...state, answers: { ...state.answers, [q.id]: a } };
}

/** One answer only: a single-choice card, and the team card for the final say. */
export function picksOne(q: Pick<IntakeQuestion, "mode" | "field">): boolean {
  return q.mode === "single" || (q.mode === "team" && q.field === "decision_maker");
}

/** The line under the question: what kind of answer it takes. */
export function pickHint(q: Pick<IntakeQuestion, "mode" | "field">): string {
  if (q.mode === "pay") return "Set the pay";
  if (q.mode === "free") return "Type your answer";
  return picksOne(q) ? "Pick one" : "Pick any that apply";
}

/**
 * Ticks or unticks an offered answer. On a pick-one card the new pick replaces the old one and any words typed as the
 * answer; "Someone not on the team yet" keeps the name typed for them.
 */
export function togglePick(state: CardState, q: Pick<IntakeQuestion, "id" | "mode" | "field">, value: string): CardState {
  const a = answerOf(state, q);
  const on = a.selected.includes(value);
  if (picksOne(q)) {
    const selected = on ? [] : [value];
    const keepName = value === SOMEONE_NEW && !on;
    return put(state, q, { ...a, selected, own: keepName ? a.own : [], draft: keepName ? a.draft : "" });
  }
  const selected = on ? a.selected.filter((v) => v !== value) : [...a.selected, value];
  // Unticking "Someone not on the team yet" drops the names typed for them.
  const dropNames = value === SOMEONE_NEW && on && q.mode === "team";
  return put(state, q, { ...a, selected, ...(dropNames ? { own: [], draft: "" } : {}) });
}

/** The words in the "Add your own…" box. On a pick-one card typing an answer clears the pick (a person, or a choice). */
export function setDraft(state: CardState, q: Pick<IntakeQuestion, "id" | "mode" | "field">, text: string): CardState {
  const a = answerOf(state, q);
  const clearPick = picksOne(q) && q.mode !== "team" && text.trim().length > 0;
  return put(state, q, { ...a, draft: text, selected: clearPick ? [] : a.selected });
}

/** Adds the typed words as one more answer on a pick-any card (Enter or the Add button); duplicates are ignored. */
export function addOwn(state: CardState, q: Pick<IntakeQuestion, "id">): CardState {
  const a = answerOf(state, q);
  const text = a.draft.trim();
  if (!text) return state;
  const own = a.own.some((x) => same(x, text)) ? a.own : [...a.own, text].slice(0, 6);
  return put(state, q, { ...a, own, draft: "" });
}

export function removeOwn(state: CardState, q: Pick<IntakeQuestion, "id">, text: string): CardState {
  const a = answerOf(state, q);
  return put(state, q, { ...a, own: a.own.filter((x) => x !== text) });
}

export function setPayForm(state: CardState, q: Pick<IntakeQuestion, "id">, pay: PayForm): CardState {
  return put(state, q, { ...answerOf(state, q), pay });
}

/** Moves to another card, staying inside the deck. */
export function goTo(state: CardState, index: number, total: number): CardState {
  return { ...state, index: Math.max(0, Math.min(index, Math.max(0, total - 1))) };
}

/** "Next" until the last card, where it sends every answer at once. */
export function nextLabel(index: number, total: number): "Next" | "Send" {
  return index >= total - 1 ? "Send" : "Next";
}

const skippedAnswer = (q: Pick<IntakeQuestion, "id">): IntakeAnswer => ({ questionId: q.id, selected: [], own: [], skipped: true });

/**
 * What one card sends (POST /intake/sessions/:id/answers). A card left alone is sent as skipped. Words still in the box
 * count as an answer. A team card's "Someone not on the team yet" sends only the name typed for them; a card that takes
 * no answers of the person's own sends none.
 */
export function answerPayload(q: IntakeQuestion, a: CardAnswer): IntakeAnswer {
  if (q.mode === "pay") {
    const pay = a.pay ? payPayload(a.pay) : null;
    return pay ? { questionId: q.id, selected: [], own: [], skipped: false, pay } : skippedAnswer(q);
  }
  const typed = a.draft.trim().slice(0, 500);
  let own = picksOne(q) && q.mode !== "team" ? (typed ? [typed] : []) : [...a.own, ...(typed && !a.own.some((x) => same(x, typed)) ? [typed] : [])];
  if (q.mode === "team" && !a.selected.includes(SOMEONE_NEW)) own = [];
  if (q.mode === "team" && picksOne(q)) own = own.slice(0, 1);
  if (!q.allowOwn && q.mode !== "team") own = [];
  const selected = a.selected.filter((v) => v !== SOMEONE_NEW).slice(0, 8);
  if (!selected.length && !own.length) return skippedAnswer(q);
  return { questionId: q.id, selected, own: own.slice(0, 6), skipped: false };
}

export function isAnswered(q: IntakeQuestion, a: CardAnswer): boolean {
  return !answerPayload(q, a).skipped;
}

/** Every card's answer, in the order the cards were asked. */
export function answersPayload(questions: readonly IntakeQuestion[], state: CardState): IntakeAnswer[] {
  return questions.map((q) => answerPayload(q, answerOf(state, q)));
}

/**
 * The picks as the one short message the conversation shows straight away (C15), line for line as the server writes it
 * (`applyAnswers` in packages/core/src/intake-builder.ts); the server's own copy replaces it when the answer comes back.
 */
export function echoText(questions: readonly IntakeQuestion[], state: CardState): string {
  const lines: string[] = [];
  for (const q of questions) {
    const a = answerPayload(q, answerOf(state, q));
    if (a.skipped) continue;
    if (a.pay) {
      lines.push(`Pay: ${formatPayRange(a.pay)}${a.pay.ceiling !== undefined ? `, at most ${money(a.pay.ceiling)}` : ""}`);
      continue;
    }
    const label = (v: string) => q.options.find((o) => o.value === v)?.label ?? v;
    if (q.mode === "team") {
      const names = [...a.selected.map(label), ...a.own];
      if (q.field === "decision_maker") lines.push(`${FIELD_LABEL.decision_maker}: ${names[0]}`);
      else lines.push(`${FIELD_LABEL.interviewers}: ${names.filter((n, i) => names.findIndex((m) => same(m, n)) === i).join(", ")}`);
      continue;
    }
    const values = [...a.selected, ...a.own];
    if (LIST_FIELDS.has(q.field)) lines.push(`${FIELD_LABEL[q.field]}: ${values.map(label).join("; ")}`);
    else lines.push(`${FIELD_LABEL[q.field]}: ${label(values[0])}`);
  }
  return lines.length ? lines.join("\n") : "Skipped those questions.";
}

/** The cards worth showing: a pay card is dropped once a person has set or confirmed the pay elsewhere (the draft's pay card). */
export function cardsToShow(view: Pick<IntakeSessionView, "questions" | "pay" | "status">): IntakeQuestion[] {
  if (view.status !== "active") return [];
  return view.questions.filter((q) => !(q.mode === "pay" && view.pay.confirmed));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Pay (C8)                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A figure as people type it: "$60,000", "60k", "45.50". NaN when there is none. */
export function parseAmount(text: string): number {
  const t = text.replace(/[$,\s]/g, "");
  if (!t) return Number.NaN;
  const k = /k$/i.test(t);
  const n = Number(k ? t.slice(0, -1) : t);
  return Number.isFinite(n) ? n * (k ? 1000 : 1) : Number.NaN;
}

const amountText = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

/** The pay card's boxes, filled from what the draft already says (a range read from an ad is shown, to be confirmed). */
export function payFormFrom(card: Pick<IntakePayCard, "basis" | "stated">): PayForm {
  return { basis: card.basis ?? "", min: amountText(card.stated.min), max: amountText(card.stated.max), ceiling: amountText(card.stated.ceiling) };
}

/** The first thing wrong with the pay as typed, in plain words, or null when it can be set. */
export function payProblem(f: PayForm): string | null {
  if (!f.basis) return "Choose by the hour or a yearly salary.";
  const min = parseAmount(f.min);
  const max = parseAmount(f.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) return "Enter the lowest and the highest pay you will advertise.";
  if (min > max) return "The lowest pay must not be above the highest.";
  if (f.basis === "hourly" && max >= 1000) return "That looks like a yearly figure. Choose a yearly salary, or enter an hourly rate.";
  if (f.basis === "salary" && max < 1000) return "That looks like an hourly rate. Choose by the hour, or enter a yearly figure.";
  if (f.ceiling.trim()) {
    const ceiling = parseAmount(f.ceiling);
    if (!Number.isFinite(ceiling) || ceiling < 0) return "The most you would pay must be a figure, or left empty.";
    if (ceiling < max) return "The most you would pay must not be below the top of the range.";
  }
  return null;
}

/** The pay as it is sent, or null while it cannot be (see `payProblem`). */
export function payPayload(f: PayForm): { basis: "hourly" | "salary"; min: number; max: number; ceiling?: number } | null {
  if (payProblem(f) || !f.basis) return null;
  const ceiling = f.ceiling.trim() ? parseAmount(f.ceiling) : undefined;
  return { basis: f.basis, min: parseAmount(f.min), max: parseAmount(f.max), ...(ceiling !== undefined ? { ceiling } : {}) };
}

const PER: Record<"hourly" | "salary", string> = { hourly: "an hour", salary: "a year" };

/** The market figure as one line ("$24–$31 an hour, middle $27"), or null when there is none. */
export function marketRange(card: Pick<IntakePayCard, "benchmark">): string | null {
  const b = card.benchmark;
  return b ? `${money(b.p25)}–${money(b.p75)} ${PER[b.basis]}, middle ${money(b.p50)}` : null;
}

/** Where the market figure comes from, with its year; ITS's own table is always called an estimate. */
export function marketSource(card: Pick<IntakePayCard, "benchmark">): string | null {
  const b = card.benchmark;
  if (!b) return null;
  if (b.origin === "its_estimate") return `ITS estimate for ${b.metro}${b.asOf ? `, ${b.asOf}` : ""}. ITS's own pay table, not government wage data.`;
  return `${b.source}, ${b.metro}${b.asOf ? `, ${b.asOf}` : ""}`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Readiness (C7, Q8)                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

export type ChecklistItem = { key: string; label: string; done: boolean; value: string | null; note: string | null };

/**
 * "What we know / still missing": the six essentials the server checks, in its words. Pay counts as known only once a
 * person has set or confirmed it; a range read from an ad or an earlier role is listed as missing until then.
 */
export function readinessList(r: Pick<IntakeReadiness, "essentials" | "payConfirmed">): { known: ChecklistItem[]; missing: ChecklistItem[]; complete: boolean } {
  const items: ChecklistItem[] = r.essentials.map((e) => {
    if (e.key === "compensation_range" && e.done && !r.payConfirmed) return { key: e.key, label: e.label, done: false, value: e.value, note: "Confirm it on the pay card." };
    return { key: e.key, label: e.label, done: e.done, value: essentialWords(e.key, e.value), note: e.note };
  });
  const missing = items.filter((i) => !i.done);
  return { known: items.filter((i) => i.done), missing, complete: missing.length === 0 };
}

/**
 * An essential's value in the team's words: the server keeps some as codes ("new_position"), which "What we know" shows
 * by their label ("A new position"). Anything the person typed in their own words stays as it is.
 */
export function essentialWords(key: string, value: string | null): string | null {
  if (!value) return value;
  if (key === "reason_for_hire") return REASON_WORD[value] ?? value;
  return value;
}

/** What the disabled "Ask for approval" says when pointed at or pressed: everything still in the way, from the server. */
export function approvalHelp(r: Pick<IntakeReadiness, "mayAskForApproval" | "approvalBlockers">): { ready: boolean; heading: string; lines: string[]; title: string } {
  if (r.mayAskForApproval) return { ready: true, heading: "Ready to ask for approval", lines: [], title: "Ask for approval: the role is created and goes to whoever approves it. Nothing is posted until they do." };
  const lines = r.approvalBlockers.length ? r.approvalBlockers : ["A few things are still missing."];
  return { ready: false, heading: "Before you can ask for approval:", lines, title: `Still needed: ${lines.join(" ")}` };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The draft beside the conversation (C7, C9, C15)                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

export type SectionId = "basics" | "about" | "must" | "nice" | "screening" | "eligibility" | "why" | "team" | "start" | "dealbreakers";

/**
 * One section of the draft panel. `path` is where it lives in the Role Packet; `seenBy` says plainly who sees it
 * ("Candidates see this", "Only your team sees this"), from the packet's visibility map in @ros/contracts.
 */
export type DraftSection = { id: SectionId; title: string; path: string; visibility: PacketVisibility; seenBy: string; text: string | null; items: string[]; empty: string };

export const WORK_MODEL_WORD: Readonly<Record<string, string>> = { onsite: "On site", hybrid: "Hybrid", remote: "Remote" };
export const EMPLOYMENT_WORD: Readonly<Record<string, string>> = { full_time: "Full time", part_time: "Part time", contract: "Contract", temporary: "Temporary", per_diem: "Per diem", internship: "Internship" };
export const REASON_WORD: Readonly<Record<string, string>> = { new_position: "A new position", replacement: "Replacing someone who left", growth: "The team is growing", seasonal: "Seasonal help", other: "Another reason" };

const placeOf = (loc: { city?: string; region?: string } | undefined) => (loc ? [loc.city, loc.region].filter(Boolean).join(", ") : "");

/** The title the draft has so far, or null ("Untitled role", in grey, until it is known). */
export function draftTitle(view: { facts: Pick<IntakeFacts, "title">; draft: Pick<DraftRolePacket, "identity"> | null }): string | null {
  return view.facts.title?.trim() || view.draft?.identity.title?.trim() || null;
}

/** A start date as people say it ("November 3, 2026"); the stored value is a plain day. */
export function dayWords(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** What the chips read from a written draft or a role's packet. */
export type ChipPacket = {
  identity: { locations: ReadonlyArray<{ city?: string; region?: string }>; remotePolicy: string; employmentType: string; schedule?: string };
  compensation?: { basis: string; min: number; max: number } | null;
};

/** The chips under the title: where, how, what kind of job, the pay and the schedule. Pay not set yet says so. */
export function basicsChips(view: { facts: IntakeFacts; draft: ChipPacket | null }): Array<{ icon: "location" | "building" | "briefcase" | "pay" | "clock"; name: string; text: string; missing?: boolean }> {
  const { facts: f, draft: d } = view;
  const out: ReturnType<typeof basicsChips> = [];
  const place = d ? placeOf(d.identity.locations[0]) : f.locationText?.trim() ?? "";
  if (place) out.push({ icon: "location", name: "Location", text: place });
  const model = d ? d.identity.remotePolicy : f.remotePolicy;
  if (model) out.push({ icon: "building", name: "Workplace", text: WORK_MODEL_WORD[model] ?? model });
  const type = d ? d.identity.employmentType : f.employmentType;
  if (type) out.push({ icon: "briefcase", name: "Job type", text: EMPLOYMENT_WORD[type] ?? type.replace(/_/g, " ") });
  const pay = d?.compensation ? formatPayRange(d.compensation) : f.compensationMin !== undefined && f.compensationMax !== undefined && (f.compensationBasis === "hourly" || f.compensationBasis === "salary") ? formatPayRange({ basis: f.compensationBasis, min: f.compensationMin, max: f.compensationMax }) : null;
  out.push(pay ? { icon: "pay", name: "Pay", text: pay } : { icon: "pay", name: "Pay", text: "Pay not set yet", missing: true });
  const schedule = d?.identity.schedule ?? f.schedule;
  if (schedule?.trim()) out.push({ icon: "clock", name: "Schedule", text: schedule.trim() });
  return out;
}

function section(id: SectionId, title: string, path: string, content: { text?: string | null; items?: string[] }, empty: string): DraftSection {
  const visibility = packetVisibility(path);
  return { id, title, path, visibility, seenBy: PACKET_VISIBILITY_LABEL[visibility], text: content.text?.trim() || null, items: (content.items ?? []).map((x) => x.trim()).filter(Boolean), empty };
}

/**
 * The draft panel's sections, in reading order: what candidates see first (from the written draft once there is one,
 * otherwise from the answers so far, so it fills in while the person talks), then what only the team sees, always from
 * the answers, which are the latest word on them.
 */
export function draftSections(view: { facts: IntakeFacts; draft: DraftRolePacket | null }): DraftSection[] {
  const { facts: f, draft: d } = view;
  const out: DraftSection[] = [
    section("basics", "The basics", "identity", { items: basicsChips(view).filter((c) => !c.missing).map((c) => c.text) }, "Where, how and what kind of job."),
    d
      ? section("about", "What you'll do", "description.publicJobDescription", { text: d.description.publicJobDescription }, "")
      : section("about", "What you'll do", "description.publicJobDescription", { items: f.responsibilities ?? [] }, "What they would own fills in here as you answer."),
    section("must", "What we're looking for", "requirements.mustHaves", { items: d ? d.requirements.mustHaves.map((m) => m.text) : f.mustHaves }, "The few things you would not hire without."),
    section("nice", "Nice to have", "requirements.niceToHaves", { items: d ? d.requirements.niceToHaves.map((m) => m.text) : f.niceToHaves }, "Helpful, never a reason to turn anyone away."),
    section("screening", "You'll be asked during the application", "screening.questions", { items: d ? d.screening.questions.map((q) => q.question) : f.screeningQuestions ?? [] }, d ? "" : "A few questions candidates answer in a short conversation, marked as AI, with a person available."),
  ];
  if (d) out.push(section("eligibility", "Quick questions on the application form", "requirements.eligibility", { items: d.requirements.eligibility.map((e) => e.question) }, "None."));
  const reason = f.reason ? `${REASON_WORD[f.reason] ?? f.reason}${f.reasonDetail ? `: ${f.reasonDetail}` : ""}` : null;
  out.push(section("why", "Why you're hiring", "business", { text: reason }, "Not said yet."));
  const team = [
    ...(f.interviewers.length ? [`Interviews: ${f.interviewers.join(", ")}`] : []),
    ...(f.decisionMaker ? [`Final decision: ${f.decisionMaker}`] : []),
  ];
  out.push(section("team", "Who interviews and decides", "interviews", { items: team }, "Not chosen yet."));
  const start = f.targetStartDate ? `Start by ${dayWords(f.targetStartDate)}${f.urgency === "high" ? ", as soon as possible" : ""}` : null;
  out.push(section("start", "When they start", "business.timeline", { text: start }, "Not said yet."));
  if (f.dealBreakers.length) out.push(section("dealbreakers", "Deal-breakers, in your words", "preferences.dealBreakersInTheirWords", { items: f.dealBreakers }, ""));
  return out;
}

export const isEmptySection = (s: Pick<DraftSection, "text" | "items">) => !s.text && s.items.length === 0;

const signature = (s: DraftSection) => JSON.stringify([s.text, s.items]);

/** The sections that changed between two looks at the draft, to highlight briefly. Nothing on the first look. */
export function changedSections(prev: readonly DraftSection[] | null, next: readonly DraftSection[]): SectionId[] {
  if (!prev) return [];
  return next.filter((s) => {
    const before = prev.find((p) => p.id === s.id);
    return !isEmptySection(s) && (!before || signature(before) !== signature(s));
  }).map((s) => s.id);
}

/** The panel section a packet path belongs to ("requirements.mustHaves[mh_2].text" is "What we're looking for"). */
export function sectionOfPath(path: string): SectionId | null {
  const p = path.replace(/\[[^\]]*\]/g, "");
  if (p.startsWith("identity") || p.startsWith("compensation")) return "basics";
  if (p.startsWith("description")) return "about";
  if (p.startsWith("requirements.mustHaves")) return "must";
  if (p.startsWith("requirements.niceToHaves")) return "nice";
  if (p.startsWith("requirements.eligibility")) return "eligibility";
  if (p.startsWith("screening")) return "screening";
  if (p.startsWith("business.timeline")) return "start";
  if (p.startsWith("business")) return "why";
  if (p.startsWith("interviews") || p.startsWith("preferences.decisionMaker")) return "team";
  if (p.startsWith("preferences.dealBreakers")) return "dealbreakers";
  return null;
}

/**
 * Whether the person changed answers after the draft was written in a way only writing it again carries into its
 * words. The server decides (`readiness.draftOutOfDate`, from a key of the answers the draft was written from); pay, the
 * team and the deal-breakers are brought up to date on their own and never make it out of date.
 */
export function draftOutOfDate(view: Pick<IntakeSessionView, "readiness">): boolean {
  return view.readiness.hasDraft && view.readiness.draftOutOfDate;
}

/**
 * What "Write it again" says before it replaces anything: the changes saved on the draft since it was written (by chat
 * or with a fix) are replaced by the new words, so the person is asked first. Null when there is nothing to lose.
 */
export function redraftWarning(r: Pick<IntakeReadiness, "draftEdits">): string | null {
  if (!r.draftEdits) return null;
  return `Writing it again replaces the ${r.draftEdits === 1 ? "change" : `${r.draftEdits} changes`} you saved on the draft since it was written (by asking, or with a suggested fix). Pay, who interviews and decides, and the deal-breakers carry over. Ask for ${r.draftEdits === 1 ? "that change" : "those changes"} again afterwards if you still want ${r.draftEdits === 1 ? "it" : "them"}.`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Drafting progress (C7: truthful stages from the server)                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/** One step per stage the server records, in order (IntakeProgressStage: benchmark, writing, checking; then done). */
export const DRAFT_STEP_LABELS = ["Checking market pay", "Writing the draft", "Checking the wording and saving"] as const;

const STAGE_STEP: Record<IntakeProgressStage, number> = { benchmark: 0, writing: 1, checking: 2, done: 3, failed: 1 };

/**
 * The drafting steps for the stage the server last recorded (`progress.stage` on the session): "starting" before the
 * first word from the server, when the first step (the market check, which the server starts at once) shows as under
 * way. A failed draft failed while it was being written, the one step that calls the model.
 */
export function draftSteps(stage: IntakeProgressStage | "starting" | null): Array<{ label: string; state: StepState }> {
  const at = stage === null || stage === "starting" ? 0 : STAGE_STEP[stage];
  return DRAFT_STEP_LABELS.map((label, i) => {
    if (stage === "failed") return { label, state: i < at ? "done" : i === at ? "failed" : "waiting" };
    if (stage === "done") return { label, state: "done" };
    return { label, state: i < at ? "done" : i === at ? "active" : "waiting" };
  });
}

const RUNNING: ReadonlySet<IntakeProgressStage> = new Set<IntakeProgressStage>(["benchmark", "writing", "checking"]);

/** Whether a draft is being written right now (say, someone reloaded the page mid-way): recent, and not done or failed. */
export function draftingNow(progress: IntakeSessionView["progress"], now = Date.now()): boolean {
  return !!progress && RUNNING.has(progress.stage) && now - Date.parse(progress.at) < 180_000;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The composer (C5)                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Whether a key press sends the message: Enter at a desk; Shift+Enter is a new line; on a touch screen Enter is always a
 * new line and the button sends; a key that finishes an accented letter or a word in an input method never sends.
 */
export function enterSends(e: { key: string; shiftKey: boolean; isComposing?: boolean }, touch: boolean): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && !touch;
}

/** What the box says before anything is typed. */
export function composerPlaceholder(state: { started: boolean; hasDraft: boolean }): string {
  if (!state.started) return "For example: a dental assistant for our Irvine office, full time, $24 to $28 an hour";
  if (state.hasDraft) return "Ask me to change anything: make it warmer, drop the weekend requirement…";
  return "Answer here. Say \"draft it\" when you're ready, then press Write the draft";
}

/** The first message may be a whole job ad (20,000 characters); every later one is a turn (4,000). */
export function messageLimit(first: boolean): number {
  return first ? INTAKE_FIRST_MESSAGE_MAX : INTAKE_MESSAGE_MAX;
}

/**
 * Said before sending, instead of a refusal after: too long for one message, with the limit. `changeMax` is the limit of
 * a request to change the written draft, which is a short instruction rather than a turn of conversation.
 */
export function messageProblem(text: string, first: boolean, changeMax?: number): string | null {
  const max = changeMax ?? messageLimit(first);
  if (text.trim().length <= max) return null;
  if (changeMax !== undefined) return `That is too long to ask in one go: up to ${max.toLocaleString("en-US")} characters. Say the change in a sentence or two.`;
  return `That is too long to send in one go: up to ${max.toLocaleString("en-US")} characters${first ? "" : " after the first message"}. Shorten it, or send it in parts.`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Turns that fail, and the hand-off (C4, C12)                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

export type RecruiterAction = { label: string; body: Record<string, unknown> };
type ActionLike = { kind?: string; label?: string; path?: string; body?: Record<string, unknown> };

const askOf = (actions: readonly ActionLike[] | undefined): RecruiterAction | null => {
  const a = actions?.find((x) => x.kind === "ask_recruiter" || x.path === "/api/v1/escalations");
  return a ? { label: a.label ?? "Bring in a recruiter", body: a.body ?? {} } : null;
};

/**
 * A turn the assistant could not take: what to say, and the "Bring in a recruiter" the server offers with the draft
 * attached. The model's own error text is never shown; it means nothing to the person.
 */
export function turnProblem(reply: { error?: string; recovery?: string; proposedActions?: readonly ActionLike[] } | null | undefined): { message: string; ask: RecruiterAction | null } | null {
  if (!reply?.error) return null;
  return { message: `The assistant could not reply just now. ${reply.recovery ?? "Try again."}`, ask: askOf(reply.proposedActions) };
}

/**
 * "Bring in a recruiter" for a draft (C12), the same request the server offers on a failed turn
 * (apps/api/src/routes/intake.ts): all of the hiring, with this draft and its conversation attached. Offered on every
 * failure in the job builder, also when the error itself carries no offer.
 */
export function draftRecruiterAsk(sessionId: string): RecruiterAction {
  return { label: "Bring in a recruiter", body: { kind: "ask", scope: "company", intakeSessionId: sessionId, question: "Please help me finish drafting this role. The assistant could not finish it with me." } };
}

/** What to say when a request fails: the API's own plain sentence, or a line about the connection when there is none. */
export function errorWords(err: unknown, fallback = "That did not go through. Check your connection and try again."): string {
  const e = err as { status?: unknown; message?: unknown } | null | undefined;
  return typeof e?.status === "number" && typeof e.message === "string" && e.message.trim() ? e.message : fallback;
}

/** The "Bring in a recruiter" an error from the API carries (a draft that could not be written, an approval that failed). */
export function askFromDetails(details: unknown): RecruiterAction | null {
  return askOf((details as { actions?: ActionLike[] } | null | undefined)?.actions);
}

/** Where a draft is worked on: the job builder, with the draft named in the address (never the person's words). */
export function startHireHref(sessionId?: string | null): string {
  return sessionId ? `${START_HIRE_HREF}?session=${encodeURIComponent(sessionId)}` : START_HIRE_HREF;
}

/** "Start a different role" from inside a draft: the builder's empty page, without resuming the draft in progress. */
export const NEW_ROLE_FRESH_HREF = `${START_HIRE_HREF}?new=1`;

/** Today's "Draft in progress" card's Discard (plan C18): asked about first, since a discarded draft cannot be continued. */
export function isDiscardDraft(action: { method: string; path: string }): boolean {
  return action.method === "POST" && /^\/api\/v1\/intake\/sessions\/[^/]+\/abandon$/.test(action.path);
}

/** Whether a role can be hired for again (plan C14): it ran its course, filled or closed. */
export function mayHireAgain(status: string): boolean {
  return status === "filled" || status === "closed";
}

/**
 * Who sees a draft (founder decision Q6, option A): the person who started it, and every owner and admin, who may also
 * take it over. Said on every draft in the lists, so nobody believes a draft is private when it is not.
 */
export const DRAFT_SEEN_BY = "you, owners and admins can see it";

/** Owners and admins see everyone's drafts and may take one over (POST /intake/sessions/:id/take-over). */
export function mayTakeOverDrafts(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** What "Take it over" says once done: true whatever the starter's role (an owner or admin starter can still open it). */
export const TAKEN_OVER_TOAST = { title: "The draft is yours now.", body: "The person who started it was told. Unless they are an owner or an admin, they can no longer work on it." } as const;
