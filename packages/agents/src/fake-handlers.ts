import type { EvidenceAssessment, ResumeExtraction, ScreenAssessment, ScreenProgress, ScreenTurn } from "@ros/contracts";
import type { FakeProvider, StructuredRequest } from "@ros/ai";
import { screenCriterion } from "@ros/core";
import { redactProtected } from "./screening";
import { fakeIntakeCompile, fakeIntakeExtract, fakeIntakeTurn } from "./fake-job";
import { fakeScreenWriteup } from "./fake-writeup";
import { FOCUS_INTRO, isFocusKey } from "./screen-focus";
import { plainlyNotHeld } from "./triage";

/**
 * Deterministic handlers for the fake AI provider. They exist so tests, evals, and local development run
 * without a model. They are heuristics, not intelligence, and the UI labels the provider as "fake".
 * Never used in production (the runtime refuses to boot with AI_PROVIDER=fake there).
 */
export function registerFakeHandlers(fake: FakeProvider): void {
  fake.register("intake.turn", fakeIntakeTurn);
  fake.register("intake.compile", fakeIntakeCompile);
  fake.register("intake.extract", fakeIntakeExtract);
  fake.register("resume.extract", (req) => fakeResumeExtract(req));
  fake.register("triage.assess", (req) => fakeTriageAssess(req));
  fake.register("screen.turn", (req) => fakeScreenTurn(req));
  fake.register("screen.assess", (req) => fakeScreenAssess(req));
  fake.register("screen.writeup", (req) => fakeScreenWriteup(req));
  fake.register("company.about", (req) => fakeCompanyAbout(req));
}

function fakeResumeExtract(req: StructuredRequest<unknown>): ResumeExtraction {
  const text = ((req.messages[0]?.content ?? "") as string).replace(/^[\s\S]*?<resume[^>]*>\n?/, "").replace(/\n?<\/resume>[\s\S]*$/, "");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const phone = text.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0];
  const positions: ResumeExtraction["positions"] = [];
  for (const l of lines) {
    const m = l.match(/^(.{3,60}?)\s+(?:at|@|-|–|\|)\s+(.{2,60}?)\s*(?:\(|,|\s)?\s*((?:19|20)\d{2})\s*(?:-|–|to)\s*((?:19|20)\d{2}|present|current)/i);
    if (m) positions.push({ title: m[1].trim(), employer: m[2].trim(), startDate: m[3], endDate: /present|current/i.test(m[4]) ? undefined : m[4], current: /present|current/i.test(m[4]), quote: l });
  }
  const licenses: ResumeExtraction["licenses"] = [];
  for (const l of lines) {
    const m = l.match(/\b(RDH|RDA|DDS|DMD|RN|LVN|CNA|EPA 608|CDL)\b[^\n]*?(?:license|lic\.?|#|no\.?)?\s*([A-Z]{0,3}\d{3,8})?/i);
    if (m && /licen|RDH|RDA|DDS|DMD/i.test(l)) licenses.push({ name: m[1].toUpperCase(), jurisdiction: l.match(/\b(CA|AZ|NV|TX|NY|FL|WA|OR|CO)\b/)?.[1], number: m[2], quote: l });
  }
  const certifications: ResumeExtraction["certifications"] = [];
  for (const l of lines) if (/\b(BLS|CPR|ACLS|OSHA|HIPAA)\b/i.test(l) && !/licen/i.test(l)) certifications.push({ name: l.match(/\b(BLS|CPR|ACLS|OSHA|HIPAA)\b/i)![1].toUpperCase(), quote: l });
  const years = positions.reduce((n, p) => {
    const s = Number(p.startDate?.slice(0, 4));
    const e = p.endDate ? Number(p.endDate.slice(0, 4)) : new Date().getFullYear();
    return Number.isFinite(s) && Number.isFinite(e) ? n + Math.max(0, e - s) : n;
  }, 0);
  const skills = [...new Set((text.match(/\b(Dentrix|Eaglesoft|Open Dental|perio(?:dontal)?|radiograph|x-ray|scaling|root planing|scheduling|insurance|billing|Salesforce|Excel|HVAC|EPA 608|welding)\b/gi) ?? []).map((s) => s.toLowerCase()))];
  const anomalies: ResumeExtraction["anomalies"] = [];
  if (/lorem ipsum|results-driven professional with a proven track record/i.test(text)) anomalies.push({ kind: "possible_ai_generated", detail: "boilerplate phrasing" });
  return { fullName: lines[0]?.length < 60 ? lines[0] : undefined, email, phone, positions, education: [], licenses, certifications, skills, languages: [], yearsOfExperienceEstimate: years || undefined, anomalies, confidence: positions.length ? "medium" : "low" };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Slice 2: evidence-based assessment and screening (heuristic stand-ins; the real prompts are gated by the evals). */
/* ---------------------------------------------------------------------------------------------------------------- */

const STOP = new Set(["with", "that", "this", "from", "have", "your", "their", "will", "able", "must", "need", "work", "experience", "years", "year", "active", "current", "relevant", "setting", "posted", "schedule", "reliable", "availability", "the", "and", "for"]);
const tokens = (s: string) => [...new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3 && !STOP.has(t)))];

function parseBracketList(block: string | undefined): Array<{ key: string; text: string }> {
  if (!block) return [];
  return [...block.matchAll(/\[([a-z0-9_]+)\]\s*([^|]+?)(?=\s*\|\s*\[|$)/gi)].map((m) => ({ key: m[1], text: m[2].trim() }));
}

function fakeTriageAssess(req: StructuredRequest<unknown>): EvidenceAssessment {
  const sys = req.system.map((b) => b.text).join("\n");
  const user = req.messages[0]?.content ?? "";
  const resume = user.match(/<resume>\n?([\s\S]*?)\n?<\/resume>/)?.[1] ?? "";
  const noResume = !resume || /no resume text available/.test(resume);
  const about = user.match(/About their recent work \(in their words\): ([^\n]+)/)?.[1] ?? "";
  const source: "resume" | "application" = noResume ? "application" : "resume";
  const text = noResume ? about : resume;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const mustHaves = parseBracketList(sys.match(/Must-haves: ([^\n]+)/)?.[1]);
  const competencies = parseBracketList(sys.match(/Competencies: ([^\n]+)/)?.[1]);
  const lower = text.toLowerCase();
  const eligibilityFailed = /Eligibility result: failed/.test(user);
  const extractionJson = user.match(/<extraction>\n?([\s\S]*?)\n?<\/extraction>/)?.[1];
  let extraction: { anomalies?: Array<{ kind: string; detail: string }>; licenses?: Array<{ name: string }>; positions?: Array<{ title: string }> } = {};
  try { if (extractionJson) extraction = JSON.parse(extractionJson); } catch { /* ignore */ }

  const noText = !text.trim();
  const lineFor = (tks: string[]) => lines.find((l) => tks.some((t) => l.toLowerCase().includes(t)));
  const where = noResume ? "written summary" : "résumé";
  const strengths: EvidenceAssessment["strengths"] = [];
  const concerns: EvidenceAssessment["concerns"] = [];
  const unknowns: EvidenceAssessment["unknowns"] = [];
  const requirementFindings: EvidenceAssessment["requirementFindings"] = mustHaves.map((m) => {
    const what = m.text.replace(/\(.*\)$/, "").trim().replace(/[.!]+$/, "");
    const tks = tokens(what);
    const hits = tks.filter((t) => lower.includes(t));
    // The candidate's own line saying they do not meet it ("RDH license expired in 2021", "I do not have a forklift
    // certificate"): a "no" with that line quoted, which the quote check keeps. It gives local runs weak readings too.
    const miss = lines.find((l) => NOT_MET.test(l) && tks.some((t) => l.toLowerCase().includes(t)));
    // The licence rule (founder decision, 15 Oct 2026): a credential that is lapsed, expired or pending is "unknown", quoted
    // and asked about; only a plain "I do not hold it" is a "no".
    if (miss && CREDENTIAL.test(m.text) && !plainlyNotHeld(miss)) {
      unknowns.push({ question: `Is your ${plainPhrase(what)} current?`, whyItMatters: `It is a must-have for this role and the ${where} says it is lapsed or pending.` });
      return { requirementKey: m.key, met: "unknown" as const, evidence: { source, quote: miss } };
    }
    if (miss) {
      concerns.push({ claim: `Their own words show ${plainPhrase(what)} is not met`, evidence: { source, quote: miss } });
      return { requirementKey: m.key, met: "no" as const, evidence: { source, quote: miss } };
    }
    const license = /licen/i.test(m.text) && (extraction.licenses?.length || /\b(rdh|rda|license|licensed)\b/i.test(text));
    const met = hits.length >= 2 || license ? "yes" : hits.length === 1 ? "partially" : "unknown";
    const quote = lineFor(hits.length ? hits : tks);
    if (met === "yes" && quote) strengths.push({ claim: `Shows ${what}`, evidence: { source, quote } });
    if (met === "unknown" && !noText) {
      // A must-have the text says nothing about: a concern for the owner (no quote: there is nothing to quote) and a question for the screen.
      unknowns.push({ question: `Can you tell me about your ${plainPhrase(what)}?`, whyItMatters: `It is a must-have for this role and the ${where} does not show it.` });
      concerns.push({ claim: `No evidence of ${plainPhrase(what)} in the ${where}`, evidence: { source } });
    }
    return { requirementKey: m.key, met, evidence: quote && met !== "unknown" ? { source, quote } : undefined };
  });
  const competencyFindings: EvidenceAssessment["competencyFindings"] = competencies.map((c) => {
    const tks = tokens(c.text);
    const hits = tks.filter((t) => lower.includes(t));
    const quote = lineFor(hits);
    return { competencyKey: c.key, finding: hits.length >= 2 && quote ? "evidenced" : hits.length === 1 && quote ? "partially_evidenced" : "not_evidenced", evidence: quote && hits.length ? { source, quote } : undefined };
  });
  const anomalies = (extraction.anomalies ?? []).map((a) => ({ kind: a.kind, detail: a.detail }));
  const yes = requirementFindings.filter((r) => r.met === "yes").length;
  const partial = requirementFindings.filter((r) => r.met === "partially").length;
  const missing = requirementFindings.filter((r) => r.met === "unknown").length;
  const notMet = requirementFindings.filter((r) => r.met === "no").length;
  // "Thin but relevant" (the prompt's rule for "potential"): the text shows this kind of work even when no must-have is spelled out.
  const roleTitle = sys.match(/^Role: ([^(\n]+?) \(/m)?.[1] ?? "";
  const relevant = !noText && tokens(roleTitle).some((t) => lower.includes(t));
  // A must-have their own words show is not met makes the reading Weak (the prompt's rule), and nothing is suggested.
  const overall: EvidenceAssessment["overall"] = noText ? "unknown" : notMet ? "weak" : mustHaves.length && yes === mustHaves.length ? "strong" : yes + partial > 0 || relevant ? "potential" : "unknown";
  // The prompt's rule: "review_manually" when overall is unknown or the resume could not be read; the eligibility hold is reviewed by a person too.
  const recommendation: EvidenceAssessment["recommendation"] = overall === "unknown" ? "review_manually" : eligibilityFailed ? "review_manually" : overall === "weak" ? "hold" : "screen";
  const summary = noText
    ? "No resume text or description was available, so nothing can be said yet; a person should open the file or ask the candidate."
    : `${yes} of ${mustHaves.length} must-haves evidenced${partial ? `, ${partial} partially` : ""}; ${competencyFindings.filter((c) => c.finding === "evidenced").length} of ${competencies.length} competencies evidenced. ${extraction.positions?.length ? `Most recent work: ${extraction.positions[0].title}.` : ""}`.trim();
  // What drives the confidence, in an owner's words: what the fake could see and what it could not.
  const confidenceReasons: string[] = [];
  if (noText) confidenceReasons.push("no résumé text and no written summary to assess");
  else if (noResume) confidenceReasons.push("no résumé, only the written summary");
  if (notMet) confidenceReasons.push(`${notMet === 1 ? "one must-have is" : `${notMet} must-haves are`} shown not met in their own words`);
  if (missing) confidenceReasons.push(`${missing === 1 ? "one must-have has" : `${missing} must-haves have`} no evidence`);
  if (partial) confidenceReasons.push(`${partial === 1 ? "one must-have is" : `${partial} must-haves are`} only partly shown`);
  if (eligibilityFailed) confidenceReasons.push("an eligibility answer did not match");
  if (anomalies.length) confidenceReasons.push("the résumé has flags to check");
  return {
    overall,
    confidence: noText ? "low" : yes >= 1 ? "medium" : "low",
    confidenceReasons,
    summary,
    strengths,
    concerns,
    unknowns,
    competencyFindings,
    requirementFindings,
    anomalies,
    recommendation,
    rationale: recommendation === "screen" ? "Eligible, with relevant evidence for the must-haves; a screen will settle the unknowns." : noText ? "There is nothing to assess against; a human should look." : overall === "unknown" ? `The ${where} shows none of the must-haves and nothing about this kind of work; a person should look or ask.` : overall === "weak" ? "Their own words show a must-have is not met; a person decides what happens next." : "Eligibility was not met; the owner reviews before anything else happens.",
  };
}

/**
 * Three dental hygienist résumés that the fake reads three ways against the hygienist role it drafts when the owner's
 * must-haves are "active CA RDH license, periodontal charting": everything shown (a very high score, the Shortlist),
 * the license with the rest only partly shown (a middling score, the Longlist), and no license, said plainly in their own
 * words (a missing must-have, Not moving forward; a lapsed one would be "not known yet" under the founder's licence rule
 * of 15 Oct 2026). For local runs of the pool board and for tests.
 */
export const FAKE_SAMPLE_RESUMES = {
  strong: "Registered Dental Hygienist at Harbor Dental 2019 - present\nRDH license CA active\nPeriodontal charting, scaling and root planing, Dentrix\nThorough, gentle clinical care to high standards\nPatient communication: explains findings plainly and builds trust\nKeeps to time without cutting corners\nShows up consistently and communicates early",
  possible: "Dental Hygienist at Coastal Smiles 2022 - present\nRDH license CA active\nCharting in Dentrix, patient reminders",
  weak: "Dental Hygienist at Pacific Dental 2010 - 2020\nI do not hold a CA RDH license\nPeriodontal charting, Dentrix",
} as const;

/** A line where the candidate says, in their own words, that they do not have something: lapsed, expired, never, do not have. */
const NOT_MET = /\b(expired|lapsed|no longer (?:hold|have|active)|not (?:licensed|certified|currently licensed)|(?:do|does) not (?:have|hold)|don't (?:have|hold)|never (?:had|held|done|worked))\b/i;
/** A must-have that names a licence, certificate, permit or registration (as `credentialMustHaves` reads it). */
const CREDENTIAL = /licen[cs]|certif|permit|registration|registered|credential/i;

/** "Active CA RDH license" reads as "active CA RDH license" after "your"; an acronym at the start ("RDH license") is left alone. */
function plainPhrase(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

type ScreenQ = { key: string; kind: string; competencyKey?: string; question: string };

function parseScreenSystem(req: StructuredRequest<unknown>) {
  const sys = req.system.map((b) => b.text).join("\n");
  const qBlock = sys.match(/Screening questions in order \(about (\d+) minutes\): ([\s\S]*?)\nCompetencies:/);
  const questions: ScreenQ[] = qBlock ? [...qBlock[2].matchAll(/\d+\. \[([a-z0-9_]+)\] \(([a-z]+)(?:, competency ([a-z0-9_]+))?\) (.*?)(?= Model answer:| Follow up if:|\s+\d+\. \[|$)/g)].map((m) => ({ key: m[1], kind: m[2], competencyKey: m[3], question: m[4].trim() })) : [];
  const company = sys.match(/Company: ([^.]+)\. Role: ([^,]+),/);
  const pay = sys.match(/Posted pay: (hourly|salary) (\d+(?:\.\d+)?) to (\d+(?:\.\d+)?) ([A-Z]{3})/);
  const progressJson = sys.match(/Progress \(JSON\): (\{.*?\})\. Focus/)?.[1];
  let progress: ScreenProgress = { askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 };
  try { if (progressJson) progress = { ...progress, ...(JSON.parse(progressJson) as ScreenProgress) }; } catch { /* keep */ }
  const name = sys.match(/Candidate first name: ([^.]+)\./)?.[1] ?? "there";
  const channel = sys.match(/Channel: (web|sms)\./)?.[1] ?? "web";
  const minutes = qBlock?.[1] ?? "15";
  const competencies = parseBracketList(sys.match(/Competencies: ([^\n]+)/)?.[1]);
  const mustHaves = parseBracketList(sys.match(/Must-haves this screen should confirm \(evidencedBy includes screen\): ([^\n]+?)\.?$/m)?.[1]);
  return { questions, company: company?.[1]?.trim() ?? "the company", role: company?.[2]?.trim() ?? "the role", pay: pay ? { basis: pay[1], min: Number(pay[2]), max: Number(pay[3]) } : null, progress, name, channel, minutes, competencies, mustHaves };
}

/** The candidate's earlier message in the transcript the prompt renders (the latest one is already the last line). */
function earlierCandidateMessage(user: string): string | null {
  const said = [...user.matchAll(/^candidate: (.*)$/gm)].map((m) => m[1].trim());
  return said.length >= 2 ? said[said.length - 2] : null;
}

/** A few of the candidate's own words to build a follow-up on: the first clause, at most eight words. */
function theirWords(text: string): string {
  const clause = text.split(/[.!?;,]/)[0]?.trim() ?? text.trim();
  const words = clause.split(/\s+/).slice(0, 8).join(" ").replace(/^(i|i've|i have|i'm|i am)\s+/i, "").trim();
  return words ? `${words.charAt(0).toLowerCase()}${words.slice(1)}` : "that";
}

/** The candidate's own words, verbatim, to quote back: their first sentence, at most twelve words. */
function quoteOf(text: string): string {
  const sentence = (text.split(/[.!?;]/)[0] ?? text).trim();
  const words = sentence.split(/\s+/);
  return words.length > 12 ? `${words.slice(0, 12).join(" ")}…` : sentence;
}

/**
 * screen.turn v3 (plan Wave E): a move to the next question is a short acknowledgment only (the code adds the packet's
 * question word for word); a follow-up builds on the candidate's own words, at most two per question; after a follow-up
 * the whole answer (earlier words and new ones) is recorded verbatim; skipped questions are never asked again.
 */
function fakeScreenTurn(req: StructuredRequest<unknown>): ScreenTurn {
  const s = parseScreenSystem(req);
  const user = req.messages[0]?.content ?? "";
  const latestRaw = user.match(/Candidate's latest message: ([\s\S]*?)\n\nProduce the next turn\./)?.[1]?.trim() ?? "(none)";
  const latest = latestRaw === "(none)" ? null : latestRaw;
  const asked = new Set(s.progress.askedKeys);
  const declined = new Set(s.progress.declined ?? []);
  const current = s.progress.currentQuestionKey;
  const remaining = s.questions.filter((q) => !asked.has(q.key) && !declined.has(q.key));
  const base: ScreenTurn = { messageToCandidate: "", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };
  // A screen that starts with the assessment's open questions says so in the opening, after the disclosure.
  const disclosure = `Hi ${s.name}, this is the hiring team at ${s.company}, using an AI assistant for a short screening for the ${s.role} role (about ${s.minutes} minutes, one question at a time). Reply HUMAN at any time to reach a person.${s.questions.some((q) => isFocusKey(q.key)) ? ` ${FOCUS_INTRO}` : ""}`;
  if (latest === null) {
    const first = remaining[0];
    return { ...base, messageToCandidate: first ? `${disclosure}\n\nFirst question: ${first.question}` : `${disclosure}\n\nThere is nothing more to ask; the team will be in touch.`, questionKey: first?.key ?? null, done: !first };
  }
  if (/\b(human|person|someone real)\b/i.test(latest) && !/\bnot\b/i.test(latest)) {
    return { ...base, messageToCandidate: `Understood. A person from ${s.company} will follow up with you.`, humanRequested: true };
  }
  // A candidate who says they are struggling is handed to a person, never pressed with another question.
  if (/\bi('m| am) (so |really |very )?(stressed|overwhelmed|upset|anxious|frustrated|angry)\b|\bthis is (really |so )?(stressful|frustrating|ridiculous)\b|\bi can'?t do this\b/i.test(latest)) {
    return { ...base, messageToCandidate: `I'm sorry this is hard. A person from ${s.company} will follow up with you.`, humanRequested: true, sentiment: "distressed" };
  }
  const currentQ = s.questions.find((q) => q.key === current) ?? null;
  const asksAboutPay = /\?/.test(latest) && /\b(pay|salary|rate|per hour|an hour|hourly|wage|\$)\b/i.test(latest) && currentQ?.kind !== "compensation";
  if (asksAboutPay) {
    const answer = s.pay ? `The posted range is $${s.pay.min} to $${s.pay.max} ${s.pay.basis === "hourly" ? "an hour" : "a year"}, depending on experience.` : "A person can discuss pay with you; I can only share what is posted.";
    return { ...base, messageToCandidate: `${answer} ${currentQ ? `Back to my question: ${currentQ.question}` : ""}`.trim(), candidateAskedAbout: "pay", questionKey: null };
  }
  const confused = /\?{2,}|confus|what do you mean|huh\b|don't understand|dont understand/i.test(latest);
  // screen.turn v6 (Wave S7): a Kanvis-style chat, when the system gives its plan.
  const chat = chatPlanOf(req);
  if (chat && !confused) return fakeChatTurn(s, chat, latest, user);
  let answerRecorded: ScreenTurn["answerRecorded"] = null;
  let followUpReason: string | null = null;
  if (currentQ) {
    const trimmed = latest.trim();
    const complete = trimmed.length >= 8 || /^(yes|no)\b/i.test(trimmed);
    const followUpsSoFar = s.progress.followUps[currentQ.key] ?? 0;
    if (!complete && followUpsSoFar < 1 && !confused) {
      followUpReason = "answer too short to establish anything";
      return { ...base, messageToCandidate: "Could you say a bit more about that? A sentence or two is plenty.", followUpReason, answerRecorded: null, sentiment: "fine" };
    }
    // A short answer about their work with nothing concrete in it gets one follow-up that builds on their own words,
    // the way the model is asked to: an example, never anything personal.
    // Never on anything personal: an answer that touches a protected characteristic is recorded (without it), not probed.
    const thin = ["skills", "behavioral"].includes(currentQ.kind) && complete && trimmed.length < 40 && !/\d/.test(trimmed) && !/^(yes|no)\b/i.test(trimmed) && redactProtected(trimmed) === trimmed;
    if (thin && followUpsSoFar < 1 && !confused && !isFocusKey(currentQ.key)) {
      followUpReason = "answer has no example yet";
      return { ...base, messageToCandidate: `You mentioned ${theirWords(trimmed)}. Could you give one example of how that went?`, followUpReason, answerRecorded: null, sentiment: "fine" };
    }
    // A fuller answer that makes a claim about their work ("I ran the brand's Instagram and grew it a lot") with no
    // figure and no example yet gets one follow-up that quotes their own words, once in the whole conversation, so a
    // local run shows what the model does (polish list). Never on anything personal, never on the open questions, and
    // never for what the reply already says (screen.turn v8, the 22 Oct 2026 try-out): how they found it, or the fix.
    const noFollowUpYet = Object.values(s.progress.followUps).every((n) => !n);
    const saysHow = /\b(?:traced|found|tracked down|figured out|fixed|resolved|solved|because)\b/i.test(trimmed);
    const claim = ["skills", "behavioral"].includes(currentQ.kind) && complete && trimmed.length >= 40 && /^I\b/.test(trimmed) && !/\d/.test(trimmed) && !saysHow && !/\b(?:for example|for instance|e\.g\.|once|one time)\b/i.test(trimmed) && redactProtected(trimmed) === trimmed;
    if (claim && noFollowUpYet && !confused && !isFocusKey(currentQ.key)) {
      followUpReason = "a claim with no example yet";
      return { ...base, messageToCandidate: `You said "${quoteOf(trimmed)}". Could you give one example of what that looked like, and what came of it?`, followUpReason, answerRecorded: null, sentiment: "fine" };
    }
    // After a follow-up, the whole answer to the question: their earlier words and the new ones, verbatim and in order.
    const earlier = followUpsSoFar > 0 ? earlierCandidateMessage(user) : null;
    answerRecorded = { questionKey: currentQ.key, answer: redactProtected(earlier && !confused ? `${earlier} ${latest}` : latest), complete };
  }
  if (confused) {
    const msg = currentQ ? `No problem. In plain terms: ${currentQ.question} If you would rather talk to a person, reply HUMAN.` : "No problem. If you would rather talk to a person, reply HUMAN.";
    return { ...base, messageToCandidate: msg, sentiment: "confused", answerRecorded: null, questionKey: null, followUpReason: "candidate seemed confused" };
  }
  const next = remaining.find((q) => q.key !== current);
  if (!next) {
    return { ...base, answerRecorded, done: true, messageToCandidate: `Thanks ${s.name}, that is everything I needed. People on the hiring team at ${s.company} review your answers and make every decision; you will hear from them either way. Reply HUMAN at any time to reach a person.` };
  }
  // Only the acknowledgment: the code adds the next question in the packet's own words.
  return { ...base, answerRecorded, questionKey: next.key, messageToCandidate: "Thanks." };
}

type FakeChatItem = { key: string; kind: "gap" | "written"; step: "direct" | "analog" | "smaller"; pushes: number; ladder: boolean; question: string };

/** The Kanvis-style chat's plan, as the system block gives it (`Chat plan (JSON): {...}`), or null for any other conversation. */
function chatPlanOf(req: StructuredRequest<unknown>): { current: string | null; items: FakeChatItem[] } | null {
  const sys = req.system.map((b) => b.text).join("\n");
  const raw = sys.match(/^Chat plan \(JSON\): (.*)$/m)?.[1];
  if (!raw) return null;
  try {
    const plan = JSON.parse(raw) as { current?: string | null; items?: FakeChatItem[] };
    return { current: plan.current ?? null, items: plan.items ?? [] };
  } catch {
    return null;
  }
}

/**
 * screen.turn v6 (Wave S7): the chat the way the model is asked to run it, by plain rules, so tests and local runs show
 * it. One neutral restatement of the reply (the code adds the next question); a short reply with nothing specific in
 * it gets one push; "No" climbs the ladder on an open question (the analog, then for a gap the smaller version, then
 * the item is settled with the calm line); every reply is read (`reading`). The closing question's answer brings the
 * close, naming the longest thing the candidate said, in their own words.
 */
function fakeChatTurn(s: ReturnType<typeof parseScreenSystem>, plan: { current: string | null; items: FakeChatItem[] }, latest: string, user: string): ScreenTurn {
  const base: ScreenTurn = { messageToCandidate: "", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };
  const current = s.progress.currentQuestionKey;
  const asked = new Set(s.progress.askedKeys);
  const declined = new Set(s.progress.declined ?? []);
  const next = s.questions.find((q) => q.key !== current && !asked.has(q.key) && !declined.has(q.key)) ?? null;
  const said = latest.trim();
  if (current === "wrap_up") {
    const replies = [...user.matchAll(/^candidate: (.*)$/gm)].map((m) => m[1].trim()).filter((x) => x.length >= 25 && redactProtected(x) === x);
    const longest = replies.sort((a, b) => b.length - a.length)[0];
    return { ...base, done: true, answerRecorded: said ? { questionKey: "wrap_up", answer: redactProtected(said), complete: true } : null, messageToCandidate: longest ? `Thank you, ${s.name}. You told me "${quoteOf(longest)}".` : `Thank you, ${s.name}.` };
  }
  const item = plan.items.find((i) => i.key === current);
  if (!item) return { ...base, questionKey: next?.key ?? null, done: !next, messageToCandidate: "Noted." };
  const vague = said.length < 25 && !/\d/.test(said);
  // screen.turn v8 (22 Oct 2026 try-out): the sentence of theirs that already speaks to a must-have item (every word of
  // five letters or more in it, by its first four letters), or null; moving on to it asks one short check on what they
  // said, never the item's own question again (the code would add it word for word)
  const saidAlready = (key: string | undefined): string | null => {
    const text = plan.items.find((i) => i.key === key)?.kind === "gap" ? s.mustHaves.find((m) => m.key === key)?.text : undefined;
    const stems = (text?.toLowerCase().match(/[a-z]{5,}/g) ?? []).map((w) => w.slice(0, 4));
    if (!stems.length) return null;
    const theirs = [...user.matchAll(/^candidate: (.*)$/gm)].flatMap((m) => m[1].split(/(?<=[.!?])\s+/));
    return theirs.find((x) => {
      const own = new Set((x.toLowerCase().match(/[a-z]{4,}/g) ?? []).map((w) => w.slice(0, 4)));
      return stems.every((w) => own.has(w)) && redactProtected(x) === x;
    }) ?? null;
  };
  const moveOn = (reading: "concrete" | "vague" | "not_done"): ScreenTurn => {
    // Their words about this item since it was asked, verbatim and in order.
    const at = user.lastIndexOf(item.question);
    // a keyword command is not an answer
    const replies = [...(at >= 0 ? user.slice(at) : user).matchAll(/^candidate: (.*)$/gm)].map((m) => m[1].trim()).filter((x) => x && !/^(?:human|person|a person|a human|agent|representative|withdraw(?: my application)?|confirm)[.!]?$/i.test(x)).join(" ");
    const recorded = reading === "not_done" && item.kind === "gap" ? null : { questionKey: item.key, answer: redactProtected(replies || said), complete: reading === "concrete" };
    const already = reading === "concrete" ? saidAlready(next?.key) : null;
    const message = reading === "not_done" ? "Understood, thanks for saying so." : already ? `You also said "${quoteOf(already)}".\n\nIs there one thing you would add about that?` : `You said "${quoteOf(said)}".`;
    return { ...base, reading, questionKey: next?.key ?? null, done: !next, answerRecorded: recorded, messageToCandidate: message };
  };
  if (item.ladder && said.length < 60 && /^(no|nope|not really|never|i haven'?t|i have not)\b/i.test(said) && !/\bbut\b/i.test(said)) {
    if (item.step === "direct") return { ...base, reading: "not_done", followUpReason: "the analog", messageToCandidate: "Not done that exactly? Tell me about something similar from your own work." };
    if (item.step === "analog" && item.kind === "gap") return { ...base, reading: "not_done", followUpReason: "the smaller version", messageToCandidate: "Even a small moment counts: was there a time, even with just a few people, when you did something like it?" };
    return moveOn("not_done");
  }
  if (item.ladder && vague && item.pushes === 0) return { ...base, reading: "vague", followUpReason: "nothing specific yet", messageToCandidate: `You said "${quoteOf(said)}".\n\nCould you tell me about one specific time: what you did, and what came of it?` };
  return moveOn(item.ladder && vague ? "vague" : "concrete");
}

const trimDot = (t: string) => t.trim().replace(/[.!]+$/, "");

function fakeScreenAssess(req: StructuredRequest<unknown>): ScreenAssessment {
  const s = parseScreenSystem(req);
  const user = req.messages[0]?.content ?? "";
  let answers: Record<string, string> = {};
  try { answers = JSON.parse(user.match(/Recorded answers \(JSON\): (\{[\s\S]*?\})\nProgress/)?.[1] ?? "{}"); } catch { /* keep */ }
  // A recruiter's call notes (plan E3) are their own source, quoted as notes, never as the candidate's words.
  const notes = [...user.matchAll(/^recruiter note: (.*)$/gm)].map((m) => m[1].trim()).filter(Boolean);
  const questionFindings: ScreenAssessment["questionFindings"] = s.questions.map((q) => {
    const a = answers[q.key];
    if (!a && notes.length) return { questionKey: q.key, answered: true, finding: "Covered in a recruiter's call notes", evidence: { source: "recruiter_note", quote: notes[0] }, meetsModelAnswer: "unknown" };
    return { questionKey: q.key, answered: !!a, finding: a ? `Answered: "${a.slice(0, 160)}"` : "Not answered", evidence: a ? { source: "screen", quote: a } : undefined, meetsModelAnswer: a ? (a.length > 20 ? "partially" : "unknown") : "unknown" };
  });
  const payQ = s.questions.find((q) => q.kind === "compensation");
  const payAnswer = payQ ? answers[payQ.key] : undefined;
  const payNum = payAnswer?.match(/\$?\s?(\d{2,3}(?:,\d{3})?(?:\.\d+)?)/)?.[1];
  const expected = payNum ? Number(payNum.replace(/,/g, "")) : null;
  const withinRange: ScreenAssessment["compensationExpectation"]["withinRange"] = expected === null || !s.pay ? "unknown" : expected > s.pay.max ? "above" : expected < s.pay.min ? "below" : "yes";
  const availQ = s.questions.find((q) => q.kind === "availability");
  const availAnswer = availQ ? answers[availQ.key] : undefined;
  const eligQs = s.questions.filter((q) => q.kind === "eligibility");
  const eligibilityConfirmations: ScreenAssessment["eligibilityConfirmations"] = eligQs.map((q) => { const a = answers[q.key]; return { key: q.key, confirmed: !a ? "unknown" : /\b(yes|active|current|i do|i hold)\b/i.test(a) && !/\bnot\b|\bno\b/i.test(a) ? "yes" : /\bno\b|\bnot\b|expired|lapsed/i.test(a) ? "no" : "unknown", quote: a }; });
  const competencyFindings: ScreenAssessment["competencyFindings"] = s.competencies.map((c) => {
    const q = s.questions.find((x) => x.competencyKey === c.key);
    const a = q ? answers[q.key] : undefined;
    return { competencyKey: c.key, finding: a && a.length > 20 ? "evidenced" : a ? "partially_evidenced" : "not_evidenced", evidence: a ? { source: "screen", quote: a } : undefined };
  });
  const answered = questionFindings.filter((f) => f.answered && f.evidence?.source !== "recruiter_note").length;
  const strengths: ScreenAssessment["strengths"] = questionFindings.filter((f) => f.answered && f.evidence?.source === "screen" && (s.questions.find((q) => q.key === f.questionKey)?.kind === "skills" || s.questions.find((q) => q.key === f.questionKey)?.kind === "behavioral")).slice(0, 3).map((f) => { const q = s.questions.find((x) => x.key === f.questionKey); return { claim: `Gave a concrete answer ${q?.kind === "behavioral" ? "about a difficult moment" : "about recent work"}`, evidence: f.evidence! }; });
  const concerns: ScreenAssessment["concerns"] = [];
  if (withinRange === "above" && payAnswer) concerns.push({ claim: `Pay expectation (${payAnswer.slice(0, 40)}) is above the posted range`, evidence: { source: "screen", quote: payAnswer } });
  const noElig = eligibilityConfirmations.find((e) => e.confirmed === "no");
  if (noElig?.quote) concerns.push({ claim: "Did not confirm a required eligibility item", evidence: { source: "screen", quote: noElig.quote } });
  const unknowns = questionFindings.filter((f) => !f.answered).map((f) => ({ question: s.questions.find((q) => q.key === f.questionKey)?.question ?? f.questionKey, whyItMatters: "Not covered in the screen." }));
  const requirementFindings = fakeScreenMustHaves(req, user);
  // screen.assess v3: a conversation that was not finished is read for what it has, says so, and is never "strong interview".
  const unfinished = /This conversation was not finished/.test(user);
  const recommendation: ScreenAssessment["recommendation"] = noElig ? "decline_recommended" : withinRange === "above" ? "hold" : answered >= Math.max(1, s.questions.length - 1) ? (strengths.length >= 2 && !unfinished ? "strong_interview" : "interview") : answered > 0 ? "interview" : "hold";
  const overall: ScreenAssessment["overall"] = recommendation === "strong_interview" ? "strong" : recommendation === "interview" ? "potential" : recommendation === "hold" ? "unknown" : "weak";
  return {
    overall,
    confidence: answered >= s.questions.length - 1 ? "medium" : "low",
    summary: `${unfinished ? "Not finished: " : ""}${answered} of ${s.questions.length} questions answered.${payAnswer ? ` Pay expectation: ${trimDot(payAnswer.slice(0, 40))} (${withinRange === "yes" ? "within range" : withinRange}).` : ""}${availAnswer ? ` Availability: ${trimDot(availAnswer.slice(0, 60))}.` : ""}${notes.length ? " A recruiter's call notes cover the rest." : ""}`,
    strengths,
    concerns,
    unknowns,
    competencyFindings,
    requirementFindings,
    anomalies: [],
    questionFindings,
    compensationExpectation: { stated: payAnswer, withinRange },
    availability: { stated: availAnswer, matchesSchedule: availAnswer ? (/\b(yes|any|flexible|weekdays|full)\b/i.test(availAnswer) ? "yes" : "partially") : "unknown" },
    eligibilityConfirmations,
    recommendation,
    rationale: recommendation === "decline_recommended" ? "The candidate's own answer did not confirm a required eligibility item; a person decides." : recommendation === "hold" ? (withinRange === "above" ? "Pay expectations are above the posted range; worth a conversation before an interview." : "Too few answers to recommend an interview.") : `Answered the screen with ${strengths.length} concrete example${strengths.length === 1 ? "" : "s"}; logistics look workable.`,
  };
}

/**
 * The scorecard's must-have findings (screen.assess v8 to v10), the way the model is asked to write them: for each must-have the
 * chat was to confirm, the candidate's message about it quoted verbatim (a short "Yes" or "No" quoted as it is, when it
 * answers a question about it): "no" when they say plainly they do not meet it, "unknown" for a credential they say is
 * lapsed or pending, "yes" when they speak to it; nothing when the chat never touched it. The code's checks
 * (`verifyScreenQuotes`) then hold it to the licence and short-quote rules, as they hold the real model.
 */
function fakeScreenMustHaves(req: StructuredRequest<unknown>, user: string): ScreenAssessment["requirementFindings"] {
  const sys = req.system.map((b) => b.text).join("\n");
  const mustHaves = parseBracketList(sys.match(/Must-haves this screen should confirm \(evidencedBy includes screen\): ([^\n]+)/)?.[1]);
  if (!mustHaves.length) return [];
  const lines = (user.match(/<transcript>\n?([\s\S]*?)\n?<\/transcript>/)?.[1] ?? "").split("\n");
  // each candidate message with the assistant's question just before it
  const said: Array<{ text: string; asked: string }> = [];
  let asked = "";
  for (const l of lines) {
    if (l.startsWith("assistant: ")) asked = l.slice("assistant: ".length);
    else if (l.startsWith("candidate: ")) said.push({ text: l.slice("candidate: ".length).trim(), asked });
  }
  return mustHaves.flatMap((m) => {
    const what = m.text.replace(/\(.*\)$/, "").trim().replace(/[.!]+$/, "");
    const tks = tokens(what);
    const about = (s: string) => tks.some((t) => s.toLowerCase().includes(t));
    const own = said.find((s) => about(s.text));
    const short = said.find((s) => /^(yes|no)\b/i.test(s.text) && s.text.split(/\s+/).length <= 4 && about(s.asked));
    if (own) {
      const met = plainlyNotHeld(own.text) ? "no" : NOT_MET.test(own.text) ? (CREDENTIAL.test(m.text) ? "unknown" : "no") : "yes";
      return [{ requirementKey: m.key, met, evidence: { source: "screen" as const, quote: own.text } }];
    }
    if (short) return [{ requirementKey: m.key, met: /^no\b/i.test(short.text) ? ("no" as const) : ("yes" as const), evidence: { source: "screen" as const, quote: short.text } }];
    return [];
  });
}

/**
 * company.about v1 (D10): a few plain sentences built only from the facts in the request, the way the model is told to
 * write them. A sentence from the company's notes is kept when it reads as a fact about the company; one that stands in
 * for a protected trait ("young, energetic team") is left out, and so is one that tries to give instructions.
 */
function fakeCompanyAbout(req: StructuredRequest<unknown>): { text: string; basedOn: string[] } {
  const text = req.messages.map((m) => m.content).join("\n");
  const fact = (label: string) => text.match(new RegExp(`^${label}: (.+?)\\.?$`, "m"))?.[1]?.trim() ?? "";
  const name = fact("Company") || "The company";
  const kind = fact("Kind of business") || "local";
  const places = fact("Places").split("; ").filter(Boolean);
  const jobs = fact("Jobs they hire for").split("; ").filter(Boolean);
  const notes = (text.match(/<notes>\n([\s\S]*?)\n<\/notes>/)?.[1] ?? "").trim();
  const where = places.length ? ` in ${places.length > 2 ? `${places.slice(0, 2).join(", ")} and other places` : places.join(" and ")}` : "";
  const sentences = [`${name} is a ${kind} business${where}.`];
  if (jobs.length) sentences.push(`The team hires for roles such as ${jobs.slice(0, 2).join(" and ").toLowerCase()}.`);
  // A note's sentence is kept only as a plain fact: no proxy wording, no instruction, no figure, nothing about pay or software.
  const own = (notes.match(/[^.!?]+[.!?]?/g) ?? []).map((s) => s.trim()).filter((s) => s.length >= 12 && !screenCriterion(s) && !/\b(?:ignore|instructions?|rules?|system|prompt)\b/i.test(s) && !/\byoung\b|\bfamily\b|\benergetic\b|\bdigital natives?\b/i.test(s) && !/[$\d]|\b(?:pay|salary|wages?|AI|software)\b/i.test(s));
  for (const s of own.slice(0, 2)) sentences.push(/[.!?]$/.test(s) ? s : `${s}.`);
  const size = fact("Size");
  if (sentences.length < 2 && size) sentences.push(`It is a team of ${size}.`);
  if (sentences.length < 2) sentences.push("Its open jobs are listed on its careers page.");
  const basedOn = [`a ${kind} business${where}`, ...(jobs.length ? [`hires for ${jobs[0].toLowerCase()}`] : []), ...(own.length ? ["what you wrote in the notes"] : [])];
  return { text: sentences.join(" "), basedOn };
}
