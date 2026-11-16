import { desc, eq } from "drizzle-orm";
import { quoteWithSource, type EvidenceAssessment, type MembershipRole, type RolePacket, type ScreenAssessment } from "@ros/contracts";
import { can, countedFinding, screenAnswersSent, shownSkillFinding, teamScreenView, unsentScreenReadings } from "@ros/core";
import { assessments, screens, type Queryable } from "@ros/db";
import { scoringView } from "./scoring-view";
import { answersOf, isFocusKey } from "./screen-focus";
import { withoutResumeShownConcerns } from "./screening";

/**
 * The interviewer's brief (docs/spec/21 F7 and F8). Everything a person needs to walk into the room: what this round
 * is for, the competencies it covers with their definitions, the questions the plan suggests, the must-haves with what
 * the evidence says about each and where its quote is from, the strengths and concerns found so far with their quotes,
 * and the screen's answers. It carries no score, no internal rationale, pay only when the reader's role may see it, and
 * the candidate's contact details only when it may open their application (`briefForReader`); the decision after the
 * interview stays the hiring team's. The same brief rides in the confirmation email and on the interview page.
 */
export type MustHaveFinding = "yes" | "partially" | "no" | "unknown";
export type CompetencyFinding = "evidenced" | "partially_evidenced" | "not_evidenced" | "contradicted";

/**
 * `aboutPay` marks what speaks to the candidate's pay, which a reader whose role may not see pay never receives
 * (`redactBriefPay`; docs/spec/02: interviewers never see pay): an AI interview answer to a question about pay or one
 * that names pay (`composeInterviewerBrief`), and a finding whose claim talks about pay or whose claim or quote repeats
 * what they said about pay. A finding whose quote alone names pay (`namesPay`) keeps its claim for that reader, without
 * the quote: a practice's own "$90k" of collections is not their pay.
 */
export type BriefFinding = { claim: string; quote: string | null; source: string | null; aboutPay: boolean };
export type BriefScreenAnswer = { question: string; answer: string; aboutPay: boolean };
/**
 * A must-have and what the evidence says about it. `source` is where its quote is from: "resume", "application",
 * "screen" (the AI interview) or "recruiter_note", which the sheet and the email say after the quote (`quoteWithSource`).
 * `aboutPay`: its words or its quote speak to pay (a quote naming any amount of money counts, `namesMoney`), so a reader
 * who may not see pay gets it without the quote, `met` kept.
 */
export type BriefMustHave = { key: string; text: string; met: MustHaveFinding; quote: string | null; source: string | null; aboutPay: boolean };

export type InterviewerBrief = {
  candidateFirstName: string;
  round: { key: string; title: string; purpose: string; durationMinutes: number; format: string };
  /**
   * `evaluatedIn` is the skill's own (null for a round key the role has no skill for): one checked only in the team's own
   * interviews ("interview") is read by no AI review, so with nothing found it reads "for this interview", never "not
   * assessed yet" (the live test, 12 November 2026).
   */
  competencies: Array<{ key: string; name: string; definition: string; indicators: string[]; finding: CompetencyFinding | null; note: string | null; evaluatedIn: RolePacket["competencies"][number]["evaluatedIn"] | null }>;
  /** The questions the interview plan suggests for this round, if the packet has any. */
  questions: string[];
  mustHaves: BriefMustHave[];
  strengths: BriefFinding[];
  concerns: BriefFinding[];
  screen: { completedAt: string | null; answers: BriefScreenAnswer[] } | null;
  /** Present only when the reader may see pay; otherwise null, never zeroed. */
  pay: { expectation: string | null; withinRange: string } | null;
  includesPay: boolean;
};

type AssessmentRow = typeof assessments.$inferSelect;
type Finding = { claim: string; evidence: { source: string; quote?: string } };

/*
 * What speaks to pay, only ever used to hide things from a reader who may not see pay (the second review of the
 * live-test fixes, #5, and the second look at its fix). The more that reader would lose, the narrower the test: a
 * strength or concern whose claim says pay, and an AI interview answer about their work, go whole, so there only pay in
 * words (in an answer, an hourly amount too) counts; a must-have's quote goes alone, so there any amount of money does.
 */
/** The word itself; a patient's "co-pay" is not the candidate's. */
const PAY_WORD = /\b(?<!\bco[- ])pay\b/i;
/**
 * The words a pay deal is written in, which never describe the work itself. The dental playbook's Associate Dentist is
 * paid "a daily guarantee against a percentage of production".
 */
const PAY_TERMS = /\b(?:salary|salaries|wages?|compensation|pay rate|hourly rate|guarantee[ds]?|commissions?|earnings|day rate|daily rate)\b/i;
/** "$" and an amount, or a range of them ("$28", "$1,500.50", "$25-30", "$25 to $30"). */
const DOLLARS = String.raw`\$\s?\d[\d,]*(?:\.\d+)?(?:\s*(?:-|–|to)\s*\$?\d[\d,]*(?:\.\d+)?)?`;
/** An amount without "$": two digits at least, so "8 an hour" of patients is not pay. */
const BARE = String.raw`(?<![\w$.,])\d{2}[\d,]*(?:\.\d+)?`;
const PER = String.raw`(?:\/\s*|per\s+|an?\s+)`;
/** An amount by the hour, with or without "$" ("$26/hr", "26 an hour", "$28 hourly"): pay, whatever it answers. */
const HOURLY = new RegExp(String.raw`(?:${DOLLARS}|${BARE})\s*(?:dollars?\s+)?(?:${PER}(?:hours?|hrs?|h)\b|hourly\b)`, "i");
/**
 * An amount written as pay is: with "$", by the hour, week, month or year or in thousands ("$28/hour", "$25-30/hr", "$60k",
 * "$60,000 a year"); without it, by the hour or the year ("28/hr", "80k a year") or as a base ("80k base").
 */
const MONEY = new RegExp(
  [
    String.raw`${DOLLARS}\s*(?:k\b|${PER}(?:hours?|hrs?|h|years?|yrs?|annum|weeks?|wks?|months?|mos?)\b|(?:hourly|annually|yearly|weekly|monthly)\b)`,
    HOURLY.source,
    String.raw`${BARE}\s?k?\s*${PER}(?:years?|yrs?|annum)\b`,
    String.raw`\b\d[\d,]*(?:\.\d+)?\s?k\s+base\b`,
  ].join("|"),
  "i",
);
/** Any amount of money ("$900", "50 dollars"), or one by the day or the shift without "$" ("900/day", "300 a shift"). */
const ANY_MONEY = new RegExp(String.raw`\$\s?\d|\b\d[\d,]*(?:\.\d+)?\s*(?:dollars|bucks)\b|${BARE}\s?k?\s*${PER}(?:days?|shifts?)\b`, "i");

/** Speaks to pay in words: the word itself or a pay deal's. A claim that does is about pay. */
const saysPay = (s: string) => PAY_WORD.test(s) || PAY_TERMS.test(s);
/** Names pay, in words or as an amount written as pay is: a strength's or concern's quote that does goes, its claim stays. */
const namesPay = (s: string | null | undefined) => !!s && (saysPay(s) || MONEY.test(s));
/**
 * Names pay or any amount of money: where only a quote goes and the finding stays (a must-have's: the Associate Dentist's
 * "$900/day guarantee" on a résumé line), and in an AI interview answer that is not about their work.
 */
const namesMoney = (s: string | null | undefined) => !!s && (namesPay(s) || ANY_MONEY.test(s));

/**
 * Where a must-have's quote is from: the words its reading checked it against (the evidence rules). A scorecard's quote is
 * the candidate's words in the AI interview, or a recruiter's call notes; a résumé reading's is the résumé, or the
 * application's answers. A reading may name another source, but its quote was checked against those words all the same,
 * so it reads as that reading's own: a résumé line never says "in the AI interview".
 */
function quoteSource(reading: "resume" | "screen", named: string | undefined): "resume" | "application" | "screen" | "recruiter_note" {
  if (reading === "screen") return named === "recruiter_note" ? "recruiter_note" : "screen";
  return named === "application" || named === "candidate_statement" ? "application" : "resume";
}

function isScreenAssessment(row: AssessmentRow): row is AssessmentRow & { result: ScreenAssessment } {
  return row.kind === "screen";
}

function mergeFindings(first: Finding[], second: Finding[], cap: number, aboutPay: (f: Finding) => boolean): BriefFinding[] {
  const seen = new Set<string>();
  const out: BriefFinding[] = [];
  for (const f of [...first, ...second]) {
    const key = f.claim.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ claim: f.claim, quote: f.evidence?.quote ?? null, source: f.evidence?.source ?? null, aboutPay: aboutPay(f) });
    if (out.length >= cap) break;
  }
  return out;
}

/** A must-have's finding the match score counts (`countedFinding` in @ros/core), in a reading's own words. */
const MET_OF: Record<"yes" | "partly" | "no" | "unknown", MustHaveFinding> = { yes: "yes", partly: "partially", no: "no", unknown: "unknown" };

/**
 * Composes the brief for one round of an application from the packet and the newest resume and screen assessments.
 * Returns null when the round is not in the packet. Each must-have and skill shows the finding the match score counts
 * (`countedFinding`), with its quote and where that is from, so the brief never disagrees with the score's breakdown: the
 * AI interview's own "no" first, then the better checked finding of the two readings (the live test, 12 November 2026:
 * an AI interview that never asked about a must-have the résumé shows had hidden the résumé's "yes" behind "unknown so
 * far"). A skill nothing counts reads "not seen yet" when a reading wrote about it, never "contradicted"
 * (`shownSkillFinding`: a "goes against it" with nothing checked quoted is not known to the score). The scorecard's
 * concerns come without those that are only the AI interview's silence about what the résumé shows, read with what the
 * conversation it read asked (`withoutResumeShownConcerns`); the stored scorecard keeps them all. This is everything the
 * readings say; `briefForReader` takes out what a reader's role may not see.
 */
export async function composeInterviewerBrief(q: Queryable, input: { applicationId: string; candidateFirstName: string; packet: RolePacket; roundKey: string }): Promise<InterviewerBrief | null> {
  const round = input.packet.interviews.plan.find((r) => r.key === input.roundKey);
  if (!round) return null;
  // A screen may have opened with the assessment's open questions; their answers sit beside them in `progress`, so the brief reads both places.
  const screenRows = await q.select({ status: screens.status, answers: screens.answers, progress: screens.progress, completedAt: screens.completedAt, assessmentId: screens.assessmentId, transcript: screens.transcript }).from(screens).where(eq(screens.applicationId, input.applicationId)).orderBy(desc(screens.createdAt));
  // Only what the candidate sent (founder decision of 9 October 2026): a conversation they did not send, and any reading of it, stay out of the brief.
  const all = await q.select().from(assessments).where(eq(assessments.applicationId, input.applicationId)).orderBy(desc(assessments.createdAt));
  const hidden = unsentScreenReadings(screenRows, all);
  const rows = all.filter((r) => !hidden.has(r.id));
  const screenAsmt = rows.find(isScreenAssessment) ?? null;
  const resumeAsmt = (rows.find((r) => r.kind !== "screen") as (AssessmentRow & { result: EvidenceAssessment }) | undefined) ?? null;
  const answered = screenRows.filter(screenAnswersSent).map((s) => ({ ...s, all: answersOf(s) })).find((s) => Object.keys(s.all).length > 0) ?? null;
  // A chat that asked the company's written questions (Wave S7 in the visit; S8 by text or from an emailed link) keeps
  // their answers under the written questions' keys: the brief names them in the company's words, never by key.
  const questionText = (key: string) => answered?.progress.focusQuestions?.find((f) => f.key === key)?.question ?? input.packet.screening.questions.find((x) => x.key === key)?.question ?? input.packet.companyQuestions?.written?.find((w) => w.key === key)?.question ?? key.replace(/_/g, " ");

  const pair = { resume: resumeAsmt, screen: screenAsmt };
  const readingOf = (source: "resume" | "screen") => (source === "screen" ? screenAsmt : resumeAsmt);
  const requirementOf = (r: AssessmentRow | null, key: string) => r?.result.requirementFindings?.find((f) => f.requirementKey === key) ?? null;
  const mustHaveFinding = (key: string): Pick<BriefMustHave, "met" | "quote" | "source"> => {
    const counted = countedFinding(pair, { key, mustHave: true });
    if (counted.status === "unknown") return { met: MET_OF.unknown, quote: null, source: null };
    return { met: MET_OF[counted.status], quote: counted.quote, source: quoteSource(counted.source, requirementOf(readingOf(counted.source), key)?.evidence?.source) };
  };
  const competencyFinding = (key: string): { finding: CompetencyFinding | null; note: string | null } => {
    const shown = shownSkillFinding(pair, key);
    return { finding: shown?.finding ?? null, note: shown?.note ?? null };
  };
  // The newest scorecard with the newest résumé reading, and the conversation it read (as the team may see it): a concern
  // that is only the AI interview's silence about what the résumé shows is left out here, never in the stored scorecard.
  const scoredScreen = screenAsmt ? screenRows.find((s) => s.assessmentId === screenAsmt.id) : undefined;
  const screenConcerns = screenAsmt ? withoutResumeShownConcerns(screenAsmt.result, resumeAsmt?.result, input.packet, scoredScreen ? teamScreenView(scoredScreen).transcript : []).concerns : [];

  // What the candidate said about pay: their answer to each question about pay (the job's compensation question, or a
  // company's written question that asks about pay: a chat with written questions asks only those), and the expectation
  // the scorecard recorded.
  const written = input.packet.companyQuestions?.written ?? [];
  const payKeys = new Set([...input.packet.screening.questions.filter((x) => x.kind === "compensation").map((x) => x.key), ...written.filter((w) => saysPay(w.question) || /\bhourly\b/i.test(w.question)).map((w) => w.key)]);
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const paySaid = [...[...payKeys].map((k) => answered?.all[k]), screenAsmt?.result.compensationExpectation?.stated].filter((s): s is string => !!s?.trim()).map(norm);
  // a number they gave on its own ("25") is that number, never a piece of "2025" or "$250k"
  const sayings = paySaid.map((p) => (/^\$?\d[\d,.]*$/.test(p) ? new RegExp(String.raw`(?<![\d.,])${p.replace(/[$.]/g, "\\$&")}(?!\d|[.,]\d)`) : p));
  const repeatsPay = (text: string | null | undefined) => !!text && sayings.some((p) => (typeof p === "string" ? norm(text).includes(p) : p.test(norm(text))));
  // A strength or concern goes whole only on this strong signal; one whose quote alone names pay keeps its claim (`redactBriefPay`).
  const findingAboutPay = (f: Finding) => saysPay(f.claim) || repeatsPay(f.claim) || repeatsPay(f.evidence?.quote);
  // An answer goes whole. One about their work (to a skill or behavioural question, an open question from the résumé
  // reading, a company's written question) may hold the practice's own figures, the skill being judged ("about $5k a day
  // in production", "collections at $150k a month"), and a patient's pay ("what she would pay herself"): there only a pay
  // deal's words or an hourly amount speak to pay. Any other answer speaks to pay with the word or any amount of money.
  const workKeys = new Set([...input.packet.screening.questions.filter((x) => x.kind === "skills" || x.kind === "behavioral").map((x) => x.key), ...written.map((w) => w.key)]);
  const answerAboutPay = (key: string, answer: string) => payKeys.has(key) || repeatsPay(answer) || PAY_TERMS.test(answer) || HOURLY.test(answer) || (!isFocusKey(key) && !workKeys.has(key) && namesMoney(answer));

  return {
    candidateFirstName: input.candidateFirstName,
    round: { key: round.key, title: round.title, purpose: round.purpose, durationMinutes: round.durationMinutes, format: round.format },
    competencies: round.competencyKeys.map((key) => {
      const c = input.packet.competencies.find((x) => x.key === key);
      return { key, name: c?.name ?? key.replace(/_/g, " "), definition: c?.definition ?? "", indicators: c?.indicators ?? [], ...competencyFinding(key), evaluatedIn: c?.evaluatedIn ?? null };
    }),
    questions: round.suggestedQuestions ?? [],
    // only the quote goes, so any amount of money in it counts (the second review of the live-test fixes, #5, and the second look at its fix)
    mustHaves: input.packet.requirements.mustHaves.map((m) => {
      const found = mustHaveFinding(m.key);
      return { key: m.key, text: m.text, ...found, aboutPay: saysPay(m.text) || repeatsPay(m.text) || namesMoney(found.quote) || repeatsPay(found.quote) };
    }),
    strengths: mergeFindings(screenAsmt?.result.strengths ?? [], resumeAsmt?.result.strengths ?? [], 6, findingAboutPay),
    concerns: mergeFindings(screenConcerns, resumeAsmt?.result.concerns ?? [], 6, findingAboutPay),
    screen: answered ? { completedAt: answered.completedAt, answers: Object.entries(answered.all).map(([key, answer]) => ({ question: questionText(key), answer: String(answer), aboutPay: answerAboutPay(key, String(answer)) })) } : null,
    pay: screenAsmt ? { expectation: screenAsmt.result.compensationExpectation?.stated ?? null, withinRange: screenAsmt.result.compensationExpectation?.withinRange ?? "unknown" } : null,
    includesPay: true,
  };
}

/**
 * The same brief for a reader whose role may not see pay: the pay line is removed, and so is every AI interview answer
 * that speaks to pay (the answer to the pay question first of all) and every strength or concern whose claim speaks to
 * pay or that repeats what they said about it. A must-have stays with what the evidence says about it, and a strength or
 * concern with its claim: only a quote of it that names pay goes. Nothing is zeroed.
 */
export function redactBriefPay(brief: InterviewerBrief): InterviewerBrief {
  const withoutPay = <T extends { aboutPay: boolean }>(items: T[]) => items.filter((x) => !x.aboutPay);
  const claimsKept = (items: BriefFinding[]) => withoutPay(items).map((x) => (namesPay(x.quote) ? { ...x, quote: null } : x));
  return {
    ...brief,
    mustHaves: brief.mustHaves.map((m) => (m.aboutPay ? { ...m, quote: null } : m)),
    strengths: claimsKept(brief.strengths),
    concerns: claimsKept(brief.concerns),
    screen: brief.screen ? { ...brief.screen, answers: withoutPay(brief.screen.answers) } : null,
    pay: null,
    includesPay: false,
  };
}

/**
 * The same brief for a reader who may not open the candidate's application, an interviewer, who never sees the
 * candidate's contact details (services/interviewer-view.ts): a quote holding an email address, a phone number, a street
 * address or zip code, or a web link (what the scoring view hides, `scoringView`) is left out, and what it backs stays,
 * the must-have's finding or the strength's or concern's claim; an AI interview answer holding one, all their own words,
 * is left out whole, as an answer about pay is. Names stay: an interviewer reads the candidate's name.
 */
export function redactBriefContact(brief: InterviewerBrief): InterviewerBrief {
  const view = scoringView({});
  const holdsContact = (s: string) => view.text(s) !== s;
  const withoutContact = <T extends { quote: string | null }>(items: T[]) => items.map((x) => (x.quote && holdsContact(x.quote) ? { ...x, quote: null } : x));
  return {
    ...brief,
    mustHaves: withoutContact(brief.mustHaves),
    strengths: withoutContact(brief.strengths),
    concerns: withoutContact(brief.concerns),
    screen: brief.screen ? { ...brief.screen, answers: brief.screen.answers.filter((a) => !holdsContact(a.answer)) } : null,
  };
}

/**
 * The brief as one reader may see it, on the interview page and in their confirmation email alike: pay only for a role
 * that may see pay (`redactBriefPay`), the candidate's contact details only for one that may open their application
 * (`redactBriefContact`). An interviewer gets neither (the second review of the live-test fixes, 12 November 2026).
 */
export function briefForReader(brief: InterviewerBrief, role: MembershipRole | null | undefined): InterviewerBrief {
  const paid = can(role, "compensation.read") ? brief : redactBriefPay(brief);
  return can(role, "application.read") ? paid : redactBriefContact(paid);
}

const MET_WORDS: Record<MustHaveFinding, string> = { yes: "met", partially: "partly met", no: "not met", unknown: "unknown so far" };
const FINDING_WORDS: Record<CompetencyFinding, string> = { evidenced: "seen in the evidence", partially_evidenced: "partly seen", not_evidenced: "not seen yet", contradicted: "contradicted by the evidence" };

/** The brief as plain text for the interviewer's confirmation email. Short lines, no jargon, no score. */
export function renderInterviewerBriefText(brief: InterviewerBrief): string {
  const lines: string[] = [];
  lines.push(`Your interview brief: ${brief.round.title} with ${brief.candidateFirstName}`);
  lines.push(`What this round is for: ${brief.round.purpose}`);
  lines.push("");
  lines.push("What to look for:");
  for (const c of brief.competencies) lines.push(`- ${c.name}: ${c.definition}${c.finding ? ` (so far: ${FINDING_WORDS[c.finding]}${c.note ? `; ${c.note}` : ""})` : c.evaluatedIn === "interview" ? " (for this interview)" : " (not assessed yet)"}`);
  if (brief.questions.length) {
    lines.push("");
    lines.push("Questions the plan suggests:");
    for (const qn of brief.questions) lines.push(`- ${qn}`);
  }
  lines.push("");
  lines.push("Must-haves and what we know:");
  // each quote says where it is from, so a résumé line never reads as their words in the AI interview
  for (const m of brief.mustHaves) lines.push(`- ${m.text}: ${MET_WORDS[m.met]}${m.quote ? ` (${quoteWithSource(m.quote, m.source)})` : ""}`);
  lines.push("");
  lines.push("Strengths so far:");
  if (brief.strengths.length) for (const s of brief.strengths) lines.push(`- ${s.claim}${s.quote ? ` ("${s.quote}")` : ""}`);
  else lines.push("- None recorded yet.");
  lines.push("");
  lines.push("Worth exploring:");
  if (brief.concerns.length) for (const s of brief.concerns) lines.push(`- ${s.claim}${s.quote ? ` ("${s.quote}")` : ""}`);
  else lines.push("- Nothing flagged yet.");
  if (brief.screen?.answers.length) {
    lines.push("");
    lines.push("What they said in the AI interview:");
    for (const a of brief.screen.answers) {
      lines.push(`- ${a.question}`);
      lines.push(`  ${a.answer}`);
    }
  }
  if (brief.includesPay && brief.pay?.expectation) {
    lines.push("");
    lines.push(`Pay expectation: ${brief.pay.expectation} (${brief.pay.withinRange === "yes" ? "within the range" : brief.pay.withinRange === "unknown" ? "not compared" : `${brief.pay.withinRange} the range`})`);
  }
  lines.push("");
  lines.push("The decision after the interview is the hiring team's, recorded with a reason. Nothing here is a score.");
  return lines.join("\n");
}
