import { desc, eq } from "drizzle-orm";
import type { EvidenceAssessment, RolePacket, ScreenAssessment } from "@ros/contracts";
import { screenAnswersSent, unsentScreenReadings } from "@ros/core";
import { assessments, screens, type Queryable } from "@ros/db";
import { answersOf } from "./screen-focus";

/**
 * The interviewer's brief (docs/spec/21 F7 and F8). Everything a person needs to walk into the room: what this round
 * is for, the competencies it covers with their definitions, the questions the plan suggests, the must-haves with what
 * the evidence says about each, the strengths and concerns found so far with their quotes, and the screen's answers.
 * It carries no score, no internal rationale, and pay only when the reader's role may see it; the decision after the
 * interview stays the hiring team's. The same brief rides in the confirmation email and on the interview page.
 */
export type MustHaveFinding = "yes" | "partially" | "no" | "unknown";
export type CompetencyFinding = "evidenced" | "partially_evidenced" | "not_evidenced" | "contradicted";

/**
 * `aboutPay` marks what speaks to the candidate's pay: the answer to a compensation question, and any answer or finding
 * that repeats what they said about pay or talks about pay. A reader whose role may not see pay never receives these
 * (`redactBriefPay`); docs/spec/02: interviewers never see pay.
 */
export type BriefFinding = { claim: string; quote: string | null; source: string | null; aboutPay: boolean };
export type BriefScreenAnswer = { question: string; answer: string; aboutPay: boolean };

export type InterviewerBrief = {
  candidateFirstName: string;
  round: { key: string; title: string; purpose: string; durationMinutes: number; format: string };
  competencies: Array<{ key: string; name: string; definition: string; indicators: string[]; finding: CompetencyFinding | null; note: string | null }>;
  /** The questions the interview plan suggests for this round, if the packet has any. */
  questions: string[];
  mustHaves: Array<{ key: string; text: string; met: MustHaveFinding; quote: string | null; source: string | null }>;
  strengths: BriefFinding[];
  concerns: BriefFinding[];
  screen: { completedAt: string | null; answers: BriefScreenAnswer[] } | null;
  /** Present only when the reader may see pay; otherwise null, never zeroed. */
  pay: { expectation: string | null; withinRange: string } | null;
  includesPay: boolean;
};

type AssessmentRow = typeof assessments.$inferSelect;
type Finding = { claim: string; evidence: { source: string; quote?: string } };

/** A finding's claim that talks about pay in so many words. Only used to hide things from readers who may not see pay. */
const PAY_WORDS = /\b(pay|salary|salaries|wage|wages|compensation|pay rate|hourly rate)\b/i;

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

/**
 * Composes the brief for one round of an application from the packet and the newest resume and screen assessments.
 * Returns null when the round is not in the packet. The screen's findings take precedence over the resume's for a
 * must-have or competency both looked at, because the candidate spoke to it directly.
 */
export async function composeInterviewerBrief(q: Queryable, input: { applicationId: string; candidateFirstName: string; packet: RolePacket; roundKey: string }): Promise<InterviewerBrief | null> {
  const round = input.packet.interviews.plan.find((r) => r.key === input.roundKey);
  if (!round) return null;
  // A screen may have opened with the assessment's open questions; their answers sit beside them in `progress`, so the brief reads both places.
  const screenRows = await q.select({ status: screens.status, answers: screens.answers, progress: screens.progress, completedAt: screens.completedAt, assessmentId: screens.assessmentId }).from(screens).where(eq(screens.applicationId, input.applicationId)).orderBy(desc(screens.createdAt));
  // Only what the candidate sent (founder decision of 9 October 2026): a conversation they did not send, and any reading of it, stay out of the brief.
  const all = await q.select().from(assessments).where(eq(assessments.applicationId, input.applicationId)).orderBy(desc(assessments.createdAt));
  const hidden = unsentScreenReadings(screenRows, all);
  const rows = all.filter((r) => !hidden.has(r.id));
  const screenAsmt = rows.find(isScreenAssessment) ?? null;
  const resumeAsmt = (rows.find((r) => r.kind !== "screen") as (AssessmentRow & { result: EvidenceAssessment }) | undefined) ?? null;
  const answered = screenRows.filter(screenAnswersSent).map((s) => ({ ...s, all: answersOf(s) })).find((s) => Object.keys(s.all).length > 0) ?? null;
  const questionText = (key: string) => answered?.progress.focusQuestions?.find((f) => f.key === key)?.question ?? input.packet.screening.questions.find((x) => x.key === key)?.question ?? key.replace(/_/g, " ");

  const requirementFinding = (key: string) => screenAsmt?.result.requirementFindings?.find((r) => r.requirementKey === key) ?? resumeAsmt?.result.requirementFindings?.find((r) => r.requirementKey === key) ?? null;
  const competencyFinding = (key: string) => screenAsmt?.result.competencyFindings?.find((c) => c.competencyKey === key) ?? resumeAsmt?.result.competencyFindings?.find((c) => c.competencyKey === key) ?? null;

  // What the candidate said about pay: their answer to each compensation question, and the expectation the scorecard recorded.
  const payKeys = new Set(input.packet.screening.questions.filter((x) => x.kind === "compensation").map((x) => x.key));
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const paySaid = [...[...payKeys].map((k) => answered?.all[k]), screenAsmt?.result.compensationExpectation?.stated].filter((s): s is string => !!s?.trim()).map(norm);
  const repeatsPay = (text: string | null | undefined) => !!text && paySaid.some((p) => norm(text).includes(p));
  const findingAboutPay = (f: Finding) => PAY_WORDS.test(f.claim) || repeatsPay(f.claim) || repeatsPay(f.evidence?.quote);

  return {
    candidateFirstName: input.candidateFirstName,
    round: { key: round.key, title: round.title, purpose: round.purpose, durationMinutes: round.durationMinutes, format: round.format },
    competencies: round.competencyKeys.map((key) => {
      const c = input.packet.competencies.find((x) => x.key === key);
      const f = competencyFinding(key);
      return { key, name: c?.name ?? key.replace(/_/g, " "), definition: c?.definition ?? "", indicators: c?.indicators ?? [], finding: f?.finding ?? null, note: f?.note ?? null };
    }),
    questions: round.suggestedQuestions ?? [],
    mustHaves: input.packet.requirements.mustHaves.map((m) => {
      const f = requirementFinding(m.key);
      return { key: m.key, text: m.text, met: f?.met ?? "unknown", quote: f?.evidence?.quote ?? null, source: f?.evidence?.source ?? null };
    }),
    strengths: mergeFindings(screenAsmt?.result.strengths ?? [], resumeAsmt?.result.strengths ?? [], 6, findingAboutPay),
    concerns: mergeFindings(screenAsmt?.result.concerns ?? [], resumeAsmt?.result.concerns ?? [], 6, findingAboutPay),
    screen: answered ? { completedAt: answered.completedAt, answers: Object.entries(answered.all).map(([key, answer]) => ({ question: questionText(key), answer: String(answer), aboutPay: payKeys.has(key) || repeatsPay(String(answer)) })) } : null,
    pay: screenAsmt ? { expectation: screenAsmt.result.compensationExpectation?.stated ?? null, withinRange: screenAsmt.result.compensationExpectation?.withinRange ?? "unknown" } : null,
    includesPay: true,
  };
}

/**
 * The same brief for a reader whose role may not see pay: the pay line is removed, and so is every screen answer and
 * finding that speaks to pay (the answer to the compensation question first of all). Nothing is zeroed.
 */
export function redactBriefPay(brief: InterviewerBrief): InterviewerBrief {
  const withoutPay = <T extends { aboutPay: boolean }>(items: T[]) => items.filter((x) => !x.aboutPay);
  return {
    ...brief,
    strengths: withoutPay(brief.strengths),
    concerns: withoutPay(brief.concerns),
    screen: brief.screen ? { ...brief.screen, answers: withoutPay(brief.screen.answers) } : null,
    pay: null,
    includesPay: false,
  };
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
  for (const c of brief.competencies) lines.push(`- ${c.name}: ${c.definition}${c.finding ? ` (so far: ${FINDING_WORDS[c.finding]}${c.note ? `; ${c.note}` : ""})` : " (not assessed yet)"}`);
  if (brief.questions.length) {
    lines.push("");
    lines.push("Questions the plan suggests:");
    for (const qn of brief.questions) lines.push(`- ${qn}`);
  }
  lines.push("");
  lines.push("Must-haves and what we know:");
  for (const m of brief.mustHaves) lines.push(`- ${m.text}: ${MET_WORDS[m.met]}${m.quote ? ` ("${m.quote}")` : ""}`);
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
    lines.push("What they said in the screening chat:");
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
