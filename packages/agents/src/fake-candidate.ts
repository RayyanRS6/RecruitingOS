import type { EvidenceAssessment, ResumeExtraction, ScreenAssessment, ScreenProgress, ScreenTurn } from "@ros/contracts";
import type { StructuredRequest } from "@ros/ai";
import { redactProtected } from "./screening";
import { namesCredential, plainlyNotHeld } from "./triage";

/**
 * The stand-in AI for a candidate's path: the CV's facts, the CV reading, a turn of the AI interview and its scorecard.
 * Plain rules that read the prompts as the real model is given them, so tests, evals and local development run without a
 * model. They are heuristics, not intelligence, and are never used in production.
 */

export function fakeResumeExtract(req: StructuredRequest<unknown>): ResumeExtraction {
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

const STOP = new Set(["with", "that", "this", "from", "have", "your", "their", "will", "able", "must", "need", "work", "experience", "years", "year", "active", "current", "relevant", "setting", "posted", "schedule", "reliable", "availability", "the", "and", "for"]);
const tokens = (s: string) => [...new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3 && !STOP.has(t)))];

function parseBracketList(block: string | undefined): Array<{ key: string; text: string }> {
  if (!block) return [];
  return [...block.matchAll(/\[([a-z0-9_]+)\]\s*([^|]+?)(?=\s*\|\s*\[|$)/gi)].map((m) => ({ key: m[1], text: m[2].trim() }));
}

/** A line where the candidate says, in their own words, that they do not have something: lapsed, expired, never, do not have. */
const NOT_MET = /\b(expired|lapsed|no longer (?:hold|have|active)|not (?:licensed|certified|currently licensed)|(?:do|does) not (?:have|hold)|don't (?:have|hold)|never (?:had|held|done|worked))\b/i;

/** "Active CA RDH license" reads as "active CA RDH license" after "your"; an acronym at the start ("RDH license") is left alone. */
function plainPhrase(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * The CV reading, the way the model is asked to write it: for each must-have and skill, the CV line that shows it,
 * quoted. A line where the candidate says they do not have something is a "no" with that line quoted (for a licence
 * said to be lapsed or pending, "unknown"). A must-have the CV says nothing about is read from the form: a "Yes" or "No"
 * to a question about it, quoted as the whole line. No verdict and no number.
 */
export function fakeTriageAssess(req: StructuredRequest<unknown>): EvidenceAssessment {
  const sys = req.system.map((b) => b.text).join("\n");
  const user = req.messages[0]?.content ?? "";
  const text = user.match(/<resume>\n?([\s\S]*?)\n?<\/resume>/)?.[1] ?? "";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const formLines = (user.match(/one per line\):\n([\s\S]*?)\n<\/application>/)?.[1] ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const mustHaves = parseBracketList(sys.match(/Must-haves: ([^\n]+)/)?.[1]);
  const competencies = parseBracketList(sys.match(/Competencies: ([^\n]+)/)?.[1]);
  const lower = text.toLowerCase();
  const lineFor = (tks: string[]) => lines.find((l) => tks.some((t) => l.toLowerCase().includes(t)));
  const strengths: EvidenceAssessment["strengths"] = [];
  const concerns: EvidenceAssessment["concerns"] = [];
  const unknowns: EvidenceAssessment["unknowns"] = [];
  const requirementFindings: EvidenceAssessment["requirementFindings"] = mustHaves.map((m) => {
    const what = m.text.replace(/\(.*\)$/, "").trim().replace(/[.!]+$/, "");
    const tks = tokens(what);
    const hits = tks.filter((t) => lower.includes(t));
    const miss = lines.find((l) => NOT_MET.test(l) && tks.some((t) => l.toLowerCase().includes(t)));
    if (miss && namesCredential(m.text) && !plainlyNotHeld(miss)) {
      unknowns.push({ question: `Is your ${plainPhrase(what)} current?`, whyItMatters: "It is a must-have for this job and the resume says it is lapsed or pending." });
      return { requirementKey: m.key, met: "unknown" as const, evidence: { source: "resume" as const, quote: miss } };
    }
    if (miss) {
      concerns.push({ claim: `Their own words show ${plainPhrase(what)} is not met`, evidence: { source: "resume", quote: miss } });
      return { requirementKey: m.key, met: "no" as const, evidence: { source: "resume" as const, quote: miss } };
    }
    const license = /licen/i.test(m.text) && /\b(rdh|rda|license|licensed)\b/i.test(text);
    const met = hits.length >= 2 || license ? "yes" : hits.length === 1 ? "partially" : "unknown";
    const quote = lineFor(hits.length ? hits : tks);
    if (met !== "unknown") {
      if (met === "yes" && quote) strengths.push({ claim: `Shows ${what}`, evidence: { source: "resume", quote } });
      return { requirementKey: m.key, met, evidence: quote ? { source: "resume" as const, quote } : undefined };
    }
    // The CV says nothing about it: a yes or no on the form to a question about it is their own answer, quoted whole.
    const answered = formLines.find((l) => /\?\s+(yes|no)\.?$/i.test(l) && tks.filter((t) => l.toLowerCase().includes(t)).length >= Math.min(2, tks.length));
    if (answered) {
      const no = /\?\s+no\.?$/i.test(answered);
      if (no) concerns.push({ claim: `Answered no about ${plainPhrase(what)}`, evidence: { source: "application", quote: answered } });
      return { requirementKey: m.key, met: no ? ("no" as const) : ("yes" as const), evidence: { source: "application" as const, quote: answered } };
    }
    unknowns.push({ question: `Can you tell me about your ${plainPhrase(what)}?`, whyItMatters: "It is a must-have for this job and the resume does not show it." });
    concerns.push({ claim: `No evidence of ${plainPhrase(what)} in the resume`, evidence: { source: "resume" } });
    return { requirementKey: m.key, met: "unknown" as const };
  });
  const competencyFindings: EvidenceAssessment["competencyFindings"] = competencies.map((c) => {
    const hits = tokens(c.text).filter((t) => lower.includes(t));
    const quote = lineFor(hits);
    return { competencyKey: c.key, finding: hits.length >= 2 && quote ? "evidenced" : hits.length === 1 && quote ? "partially_evidenced" : "not_evidenced", evidence: quote && hits.length ? { source: "resume", quote } : undefined };
  });
  const yes = requirementFindings.filter((r) => r.met === "yes").length;
  const partial = requirementFindings.filter((r) => r.met === "partially").length;
  const summary = `${yes} of ${mustHaves.length} must-haves shown${partial ? `, ${partial} partly` : ""}; ${competencyFindings.filter((c) => c.finding === "evidenced").length} of ${competencies.length} skills shown.`;
  return { summary, strengths, concerns, unknowns, competencyFindings, requirementFindings };
}

/**
 * Three dental hygienist resumes the stand-in reads three ways against a job whose must-haves are "active CA RDH
 * license, periodontal charting": everything shown, the license with the rest only partly shown, and no license, said
 * plainly in their own words (a must-have not met). For local runs and for tests.
 */
export const FAKE_SAMPLE_RESUMES = {
  strong: "Registered Dental Hygienist at Harbor Dental 2019 - present\nRDH license CA active\nPeriodontal charting, scaling and root planing, Dentrix\nThorough, gentle clinical care to high standards\nPatient communication: explains findings plainly and builds trust\nKeeps to time without cutting corners\nShows up consistently and communicates early",
  possible: "Dental Hygienist at Coastal Smiles 2022 - present\nRDH license CA active\nCharting in Dentrix, patient reminders",
  weak: "Dental Hygienist at Pacific Dental 2010 - 2020\nI do not hold a CA RDH license\nPeriodontal charting, Dentrix",
} as const;

type FakeChatItem = { key: string; kind: "question" | "gap"; step: "direct" | "analog" | "smaller"; pushes: number; ladder: boolean; question: string };

/** What the turn's prompt says about where the chat stands: the plan, the progress, who is asked and what the job pays. */
function parseTurn(req: StructuredRequest<unknown>) {
  const sys = req.system.map((b) => b.text).join("\n");
  let plan: { items?: FakeChatItem[]; wrapUp?: { key: string; question: string } } = {};
  try { plan = JSON.parse(sys.match(/^Chat plan \(JSON\): (.*)$/m)?.[1] ?? "{}"); } catch { /* keep */ }
  let progress: ScreenProgress = { askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 };
  try { progress = { ...progress, ...(JSON.parse(sys.match(/Progress \(JSON\): (\{.*\})\.$/m)?.[1] ?? "{}") as ScreenProgress) }; } catch { /* keep */ }
  const pay = sys.match(/Posted pay: (hourly|salary) (\d+(?:\.\d+)?) to (\d+(?:\.\d+)?) ([A-Z]{3})/);
  const items = plan.items ?? [];
  const wrap = plan.wrapUp ?? { key: "wrap_up", question: "" };
  const mustHaves = [...(sys.match(/^Must-haves: (.*)$/m)?.[1] ?? "").matchAll(/\[([^\]]+)\] ([^|]+)/g)].map((m) => ({ key: m[1], text: m[2].trim() }));
  return { items, wrap, mustHaves, questions: [...items.map((i) => ({ key: i.key, question: i.question })), wrap], progress, name: sys.match(/Candidate first name: ([^.]+)\./)?.[1] ?? "there", pay: pay ? { basis: pay[1], min: Number(pay[2]), max: Number(pay[3]) } : null };
}

/** The candidate's own words, verbatim, to quote back: their first sentence, at most twelve words. */
function quoteOf(text: string): string {
  const sentence = (text.split(/[.!?;]/)[0] ?? text).trim();
  const words = sentence.split(/\s+/);
  return words.length > 12 ? `${words.slice(0, 12).join(" ")}…` : sentence;
}

/**
 * One turn of the AI interview, the way the model is asked to run it: one neutral restatement of the reply and the next
 * item (the code adds the question); a short reply with nothing specific in it gets one push; "No" climbs the ladder on
 * an open question (the analog, then for a must-have the smaller version, then the item is settled with the calm line);
 * every reply is read (`reading`). A question about pay is answered from the posted range; someone who asks for a
 * person, or says they are struggling, is flagged for one; a confused reply gets the question again. The closing
 * question's answer brings the close, naming the longest thing the candidate said, in their own words.
 */
export function fakeScreenTurn(req: StructuredRequest<unknown>): ScreenTurn {
  const s = parseTurn(req);
  const user = req.messages[0]?.content ?? "";
  const said = (user.match(/Candidate's latest message: ([\s\S]*?)\n\nProduce the next turn\./)?.[1] ?? "").trim();
  const base: ScreenTurn = { messageToCandidate: "", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };
  const current = s.progress.currentQuestionKey;
  const asked = new Set(s.progress.askedKeys);
  const declined = new Set(s.progress.declined ?? []);
  const currentQ = s.questions.find((q) => q.key === current) ?? null;
  if (/\b(?:want|need|prefer|rather)\b.*\b(?:human|person|someone real)\b/i.test(said)) return { ...base, messageToCandidate: "Understood.", humanRequested: true };
  if (/\bi('m| am) (so |really |very )?(stressed|overwhelmed|upset|anxious|frustrated|angry)\b|\bthis is (really |so )?(stressful|frustrating|ridiculous)\b|\bi can'?t do this\b/i.test(said)) return { ...base, messageToCandidate: "I'm sorry this is hard.", humanRequested: true, sentiment: "distressed" };
  if (/\?/.test(said) && /\b(pay|salary|rate|per hour|an hour|hourly|wage|\$)\b/i.test(said) && !/\b(pay|salary|range)\b/i.test(currentQ?.question ?? "")) {
    const answer = s.pay ? `The posted range is $${s.pay.min} to $${s.pay.max} ${s.pay.basis === "hourly" ? "an hour" : "a year"}.` : "The hiring team can discuss pay with you; I can only share what is posted.";
    return { ...base, messageToCandidate: `${answer}\n\n${currentQ?.question ?? ""}`.trim(), candidateAskedAbout: "pay" };
  }
  if (/\?{2,}|confus|what do you mean|huh\b|don't understand|dont understand/i.test(said)) return { ...base, messageToCandidate: currentQ ? `No problem. In plain terms: ${currentQ.question}` : "No problem.", sentiment: "confused", followUpReason: "candidate seemed confused" };

  const next = s.questions.find((q) => q.key !== current && !asked.has(q.key) && !declined.has(q.key)) ?? null;
  const theirs = [...user.matchAll(/^candidate: (.*)$/gm)].map((m) => m[1].trim());
  if (current === s.wrap.key) {
    const longest = theirs.filter((x) => x.length >= 25 && redactProtected(x) === x).sort((a, b) => b.length - a.length)[0];
    return { ...base, done: true, answerRecorded: said ? { questionKey: s.wrap.key, answer: redactProtected(said), complete: true } : null, messageToCandidate: longest ? `Thank you, ${s.name}. You told me "${quoteOf(longest)}".` : `Thank you, ${s.name}.` };
  }
  const item = s.items.find((i) => i.key === current);
  if (!item) return { ...base, questionKey: next?.key ?? null, done: !next, messageToCandidate: "Noted." };
  // The sentence of theirs that already speaks to a must-have the chat asks about next (every word of five letters or
  // more in it, by its first four letters), or null: moving on to it asks one short check on what they said, never the
  // item's own question again.
  const saidAlready = (key: string | undefined): string | null => {
    const text = s.items.find((i) => i.key === key)?.kind === "gap" ? s.mustHaves.find((m) => m.key === key)?.text : undefined;
    const stems = (text?.toLowerCase().match(/[a-z]{5,}/g) ?? []).map((w) => w.slice(0, 4));
    if (!stems.length) return null;
    return theirs.flatMap((x) => x.split(/(?<=[.!?])\s+/)).find((x) => {
      const own = new Set((x.toLowerCase().match(/[a-z]{4,}/g) ?? []).map((w) => w.slice(0, 4)));
      return stems.every((w) => own.has(w)) && redactProtected(x) === x;
    }) ?? null;
  };
  const moveOn = (reading: "concrete" | "vague" | "not_done"): ScreenTurn => {
    // Their words about this item since it was asked, verbatim and in order; a keyword command is not an answer.
    const at = user.lastIndexOf(item.question);
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
  const vague = said.length < 25 && !/\d/.test(said);
  if (item.ladder && vague && item.pushes === 0) return { ...base, reading: "vague", followUpReason: "nothing specific yet", messageToCandidate: `You said "${quoteOf(said)}".\n\nCould you tell me about one specific time: what you did, and what came of it?` };
  return moveOn(item.ladder && vague ? "vague" : "concrete");
}

/**
 * The scorecard of a sent AI interview, the way the model is asked to write it: one finding for each question asked,
 * quoting the answer the candidate sent. A full answer meets the job's standard, a short one partly, a plain "Yes" does,
 * and their own words saying they do not have or have not done it do not. A skipped or unanswered question is not known.
 */
export function fakeScreenAssess(req: StructuredRequest<unknown>): ScreenAssessment {
  const user = req.messages[0]?.content ?? "";
  let asked: Array<{ key: string; question: string; skipped?: boolean }> = [];
  let answers: Record<string, string> = {};
  try { asked = JSON.parse(user.match(/^Questions asked \(JSON\): (.*)$/m)?.[1] ?? "[]"); } catch { /* keep */ }
  try { answers = JSON.parse(user.match(/^Answers sent \(JSON\): (.*)$/m)?.[1] ?? "{}"); } catch { /* keep */ }
  const questionFindings: ScreenAssessment["questionFindings"] = asked.map((q) => {
    const a = q.skipped ? undefined : answers[q.key];
    if (!a) return { questionKey: q.key, answered: false, finding: q.skipped ? "Skipped by the candidate." : "Not answered.", meetsModelAnswer: "unknown" };
    const meets = NOT_MET.test(a) || /^no\b/i.test(a) ? "no" : /^yes\b/i.test(a) || a.length > 60 ? "yes" : a.length > 20 ? "partially" : "unknown";
    return { questionKey: q.key, answered: true, finding: `Answered: "${a.slice(0, 160)}"`, evidence: { source: "screen", quote: a }, meetsModelAnswer: meets };
  });
  const words = (key: string) => asked.find((q) => q.key === key)?.question ?? key;
  const strengths: ScreenAssessment["strengths"] = questionFindings.filter((f) => f.meetsModelAnswer === "yes" && f.evidence).slice(0, 3).map((f) => ({ claim: `Gave a specific answer to "${words(f.questionKey)}"`, evidence: f.evidence! }));
  const concerns: ScreenAssessment["concerns"] = questionFindings.filter((f) => f.meetsModelAnswer === "no" && f.evidence).map((f) => ({ claim: `Their answer does not meet what the job asks: "${words(f.questionKey)}"`, evidence: f.evidence! }));
  const unknowns = questionFindings.filter((f) => !f.answered).map((f) => ({ question: words(f.questionKey), whyItMatters: "Not answered in the AI interview." }));
  return { summary: `${questionFindings.filter((f) => f.answered).length} of ${asked.length} questions answered.`, strengths, concerns, unknowns, questionFindings };
}
