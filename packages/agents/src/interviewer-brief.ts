import { desc, eq } from "drizzle-orm";
import { quoteWithSource, type EvidenceAssessment, type MembershipRole, type RolePacket, type ScreenAssessment } from "@ros/contracts";
import { can, countedFinding, screenAnswersSent, shownSkillFinding, teamScreenView, unsentScreenReadings } from "@ros/core";
import { assessments, screens, type Queryable } from "@ros/db";
import { scoringView } from "./scoring-view";
import { answersOf } from "./screen-focus";
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
 * `aboutPay` marks what speaks to the candidate's pay: the answer to a compensation question, and any answer or finding
 * that repeats what they said about pay or talks about pay, in its claim or its quote. A reader whose role may not see pay
 * never receives these (`redactBriefPay`); docs/spec/02: interviewers never see pay.
 */
export type BriefFinding = { claim: string; quote: string | null; source: string | null; aboutPay: boolean };
export type BriefScreenAnswer = { question: string; answer: string; aboutPay: boolean };
/**
 * A must-have and what the evidence says about it. `source` is where its quote is from: "resume", "application",
 * "screen" (the AI interview) or "recruiter_note", which the sheet and the email say after the quote (`quoteWithSource`).
 * `aboutPay`: its words or its quote speak to pay, so a reader who may not see pay gets it without the quote, `met` kept.
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

/** A claim or a quote that talks about pay in so many words. Only used to hide things from readers who may not see pay. */
const PAY_WORDS = /\b(pay|salary|salaries|wage|wages|compensation|pay rate|hourly rate)\b/i;
/**
 * An amount of money with what it is paid by, as pay is written ("$28/hour", "$28 an hour", "$25-30/hr", "$60k",
 * "$60,000 a year"): a quote with one speaks to pay whatever its other words (the second review of the live-test fixes,
 * #5: "desired pay $28/hour" on a résumé line quoted for a must-have). Only used to hide things from readers who may not
 * see pay.
 */
const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s*(?:-|–|to)\s*\$?\d[\d,]*(?:\.\d+)?)?\s*(?:k\b|(?:\/\s*|per\s+|an?\s+)(?:hours?|hrs?|h|years?|yrs?|annum|weeks?|wks?|months?|mos?)\b|(?:hourly|annually|yearly|weekly|monthly)\b)/i;

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

  // What the candidate said about pay: their answer to each compensation question, and the expectation the scorecard recorded.
  const payKeys = new Set(input.packet.screening.questions.filter((x) => x.kind === "compensation").map((x) => x.key));
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const paySaid = [...[...payKeys].map((k) => answered?.all[k]), screenAsmt?.result.compensationExpectation?.stated].filter((s): s is string => !!s?.trim()).map(norm);
  const repeatsPay = (text: string | null | undefined) => !!text && paySaid.some((p) => norm(text).includes(p));
  // A quote speaks to pay with a pay word, an amount written as pay is (`MONEY`), or what they said about pay.
  const quoteAboutPay = (quote: string | null | undefined) => !!quote && (PAY_WORDS.test(quote) || MONEY.test(quote) || repeatsPay(quote));
  const findingAboutPay = (f: Finding) => PAY_WORDS.test(f.claim) || repeatsPay(f.claim) || quoteAboutPay(f.evidence?.quote);

  return {
    candidateFirstName: input.candidateFirstName,
    round: { key: round.key, title: round.title, purpose: round.purpose, durationMinutes: round.durationMinutes, format: round.format },
    competencies: round.competencyKeys.map((key) => {
      const c = input.packet.competencies.find((x) => x.key === key);
      return { key, name: c?.name ?? key.replace(/_/g, " "), definition: c?.definition ?? "", indicators: c?.indicators ?? [], ...competencyFinding(key), evaluatedIn: c?.evaluatedIn ?? null };
    }),
    questions: round.suggestedQuestions ?? [],
    // the same test as a finding's, with the must-have's words as the claim (the second review of the live-test fixes, #5)
    mustHaves: input.packet.requirements.mustHaves.map((m) => {
      const found = mustHaveFinding(m.key);
      return { key: m.key, text: m.text, ...found, aboutPay: PAY_WORDS.test(m.text) || repeatsPay(m.text) || quoteAboutPay(found.quote) };
    }),
    strengths: mergeFindings(screenAsmt?.result.strengths ?? [], resumeAsmt?.result.strengths ?? [], 6, findingAboutPay),
    concerns: mergeFindings(screenConcerns, resumeAsmt?.result.concerns ?? [], 6, findingAboutPay),
    screen: answered ? { completedAt: answered.completedAt, answers: Object.entries(answered.all).map(([key, answer]) => ({ question: questionText(key), answer: String(answer), aboutPay: payKeys.has(key) || repeatsPay(String(answer)) })) } : null,
    pay: screenAsmt ? { expectation: screenAsmt.result.compensationExpectation?.stated ?? null, withinRange: screenAsmt.result.compensationExpectation?.withinRange ?? "unknown" } : null,
    includesPay: true,
  };
}

/**
 * The same brief for a reader whose role may not see pay: the pay line is removed, and so is every screen answer and
 * finding that speaks to pay (the answer to the compensation question first of all). A must-have stays with what the
 * evidence says about it; only a quote of it that speaks to pay goes. Nothing is zeroed.
 */
export function redactBriefPay(brief: InterviewerBrief): InterviewerBrief {
  const withoutPay = <T extends { aboutPay: boolean }>(items: T[]) => items.filter((x) => !x.aboutPay);
  return {
    ...brief,
    mustHaves: brief.mustHaves.map((m) => (m.aboutPay ? { ...m, quote: null } : m)),
    strengths: withoutPay(brief.strengths),
    concerns: withoutPay(brief.concerns),
    screen: brief.screen ? { ...brief.screen, answers: withoutPay(brief.screen.answers) } : null,
    pay: null,
    includesPay: false,
  };
}

/**
 * The same brief for a reader who may not open the candidate's application, an interviewer, who never sees the
 * candidate's contact details (services/interviewer-view.ts): a quote holding an email address, a phone number, a street
 * address or zip code, or a web link (what the scoring view hides, `scoringView`) is left out, and what it backs stays,
 * the must-have's finding or the strength's or concern's claim. Names stay: an interviewer reads the candidate's name.
 */
export function redactBriefContact(brief: InterviewerBrief): InterviewerBrief {
  const view = scoringView({});
  const withoutContact = <T extends { quote: string | null }>(items: T[]) => items.map((x) => (x.quote && view.text(x.quote) !== x.quote ? { ...x, quote: null } : x));
  return { ...brief, mustHaves: withoutContact(brief.mustHaves), strengths: withoutContact(brief.strengths), concerns: withoutContact(brief.concerns) };
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
