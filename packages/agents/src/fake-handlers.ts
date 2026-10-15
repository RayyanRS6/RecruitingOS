import type { DraftRolePacket, EvidenceAssessment, IntakeExtraction, IntakeFacts, IntakeQuestion, IntakeTurn, PacketRevision, ResumeExtraction, ScreenAssessment, ScreenProgress, ScreenTurn } from "@ros/contracts";
import type { FakeProvider, IntakeContext, StructuredRequest } from "@ros/ai";
import { marketPlace, normalizeCriterion, screenCriterion } from "@ros/core";
import { redactProtected } from "./screening";
import { fakeScreenWriteup } from "./fake-writeup";
import { FOCUS_INTRO, isFocusKey } from "./screen-focus";
import { plainlyNotHeld } from "./triage";

/**
 * Deterministic handlers for the fake AI provider. They exist so tests, evals, and local development run
 * without a model. They are heuristics, not intelligence, and the UI labels the provider as "fake".
 * Never used in production (the runtime refuses to boot with AI_PROVIDER=fake there).
 */
export function registerFakeHandlers(fake: FakeProvider): void {
  fake.register("intake.turn", (req) => fakeIntakeTurn(contextFrom(req)));
  fake.register("intake.compile", (req) => fakeCompile(contextFrom(req)));
  fake.register("intake.extract", (req) => fakeExtract(req));
  fake.register("resume.extract", (req) => fakeResumeExtract(req));
  fake.register("triage.assess", (req) => fakeTriageAssess(req));
  fake.register("screen.turn", (req) => fakeScreenTurn(req));
  fake.register("screen.assess", (req) => fakeScreenAssess(req));
  fake.register("screen.writeup", (req) => fakeScreenWriteup(req));
  fake.register("packet.revise", (req) => fakeRevise(req));
  fake.register("company.about", (req) => fakeCompanyAbout(req));
  fake.register("message.freeform", (req) => fakeMessageLine(req));
  fake.register("intake.suggest", (req) => fakeSuggest(req));
}

/**
 * intake.suggest v1 (Wave S3, G3): must-haves and yes/no questions for the quick start, built only from the job facts in
 * the request, the same every time for the same facts. Nothing about candidates is ever in the request. A title that is
 * not a job (empty, or only instructions) gets nothing.
 */
function fakeSuggest(req: StructuredRequest<unknown>): { mustHaves: string[]; questions: string[] } {
  const text = req.messages.map((m) => m.content).join("\n");
  const job = text.match(/<job>\n([\s\S]*?)\n<\/job>/)?.[1] ?? "";
  const fact = (label: string) => job.match(new RegExp(`^${label}: (.*)$`, "m"))?.[1]?.trim() ?? "";
  const title = fact("Job title");
  if (!title || /\b(?:ignore|instructions?|system prompt)\b/i.test(title)) return { mustHaves: [], questions: [] };
  const lower = title.toLowerCase();
  const model = fact("Work model");
  const type = fact("Employment type");
  const mustHaves = [`Hands-on ${lower} work`, `The tools a ${lower} uses every day`];
  const questions = [`Have you worked as a ${lower} before?`];
  if (/\bdriver|delivery|courier|truck/i.test(title)) {
    mustHaves.push("Valid driver's licence and a clean driving record");
    questions.push("Do you hold a valid driver's licence?");
  }
  if (model === "Remote") {
    mustHaves.push("Working on your own, remotely");
    questions.push("Do you have a quiet place to work from home?");
  } else if (model === "On site" || model === "Hybrid") {
    questions.push("Can you get to the workplace on the days the job needs?");
  }
  if (type === "Part time" || type === "Temporary") mustHaves.push("Available for the posted hours");
  return { mustHaves: mustHaves.slice(0, 8), questions: questions.slice(0, 4) };
}

/**
 * message.suggest_line v1 (Q28): one warm line for an interview invitation or an update, the way the model is told to
 * write it: no promise, no judgment, nothing about the person. The interview's title is used when given.
 */
function fakeMessageLine(req: StructuredRequest<unknown>): { line: string } {
  const text = req.messages.map((m) => m.content).join("\n");
  const interview = text.match(/<interview>([^<]*)<\/interview>/)?.[1]?.trim();
  if (/Purpose: an interview invitation/.test(text)) return { line: interview ? `We are looking forward to meeting you for the ${interview.toLowerCase()} and hearing more about what you are looking for.` : "We are looking forward to meeting you and hearing more about what you are looking for." };
  return { line: "Thank you for your patience while the team works through the applications for this role." };
}

type FakeIntakeContext = {
  req: StructuredRequest<unknown>;
  facts: IntakeFacts;
  ownerMessages: string[];
  playbookRoleTitle: string | null;
  companyName: string;
  benchmark: IntakeContext["benchmark"];
  /** "basis_unknown" or "no_market_figure" when the prompt says there is no benchmark, and why. */
  benchmarkGap: "basis_unknown" | "no_market_figure" | null;
  locationsText: string;
  vertical: string;
  ad: string | null;
  confirmedPay: { basis: "hourly" | "salary"; min: number; max: number; ceiling?: number } | null;
  fromRole: string | null;
};

/** The prompt renders `Facts established so far (JSON): ...` and the transcript; recover them from the request. */
function contextFrom(req: StructuredRequest<unknown>): FakeIntakeContext {
  const sys = req.system.map((b) => b.text).join("\n");
  const factsMatch = sys.match(/Facts established so far \(JSON\): (\{[\s\S]*\})/);
  let facts: IntakeFacts = { mustHaves: [], niceToHaves: [], eligibilityNotes: [], interviewers: [], dealBreakers: [], declinedCriteria: [] };
  if (factsMatch) {
    try { facts = { ...facts, ...(JSON.parse(factsMatch[1]) as IntakeFacts) }; } catch { /* keep defaults */ }
  } else {
    const inMsg = req.messages.map((m) => m.content).join("\n").match(/Established facts \(JSON\): (\{[\s\S]*?\})\n\n/);
    if (inMsg) { try { facts = { ...facts, ...(JSON.parse(inMsg[1]) as IntakeFacts) }; } catch { /* keep */ } }
  }
  const roleMatch = sys.match(/Matched playbook role: ([^.]+)\./);
  const companyMatch = sys.match(/Company: ([^.]+)\./);
  const verticalMatch = sys.match(/Vertical: ([^.]+)\./);
  const locMatch = sys.match(/Locations: ([^.\n]+)\./);
  const benchMatch = sys.match(/Compensation benchmark for ([^(]+) \((hourly|salary)\): p25 ([\d.]+), p50 ([\d.]+), p75 ([\d.]+)\. Source: ([^\n]+)\./);
  const estimate = /This figure is ITS's own estimate/.test(sys);
  const roughMatch = sys.match(/This figure is an approximate match: it is for a broader group of jobs \(([^)]+)\)/);
  const payMatch = sys.match(/Confirmed pay \(set or confirmed by a person\): (hourly|salary) ([\d.]+) to ([\d.]+)(?:, ceiling ([\d.]+))?\./);
  const ownerMessages = req.messages.filter((m) => m.role === "user").map((m) => m.content);
  const transcript = req.messages.map((m) => m.content).join("\n");
  const fromTranscript = [...transcript.matchAll(/^owner: (.*)$/gm)].map((m) => m[1]);
  return {
    req,
    facts,
    ownerMessages: fromTranscript.length ? fromTranscript : ownerMessages,
    playbookRoleTitle: roleMatch?.[1]?.trim() ?? null,
    companyName: companyMatch?.[1]?.trim() ?? "the company",
    vertical: verticalMatch?.[1]?.trim() ?? "general",
    benchmark: benchMatch ? { metro: benchMatch[1].trim(), basis: benchMatch[2], p25: Number(benchMatch[3]), p50: Number(benchMatch[4]), p75: Number(benchMatch[5]), source: benchMatch[6].trim(), origin: estimate ? "its_estimate" : "market", ...(roughMatch ? { approximate: true, occupation: roughMatch[1] } : {}) } : null,
    benchmarkGap: /pay basis is not known/.test(sys) ? "basis_unknown" : /No compensation benchmark is available/.test(sys) ? "no_market_figure" : null,
    locationsText: locMatch?.[1]?.trim() ?? "",
    ad: sys.match(/<job_ad>\n([\s\S]*?)\n<\/job_ad>/)?.[1] ?? null,
    confirmedPay: payMatch ? { basis: payMatch[1] as "hourly" | "salary", min: Number(payMatch[2]), max: Number(payMatch[3]), ...(payMatch[4] ? { ceiling: Number(payMatch[4]) } : {}) } : null,
    fromRole: sys.match(/This draft starts from the role "([^"]+)"/)?.[1] ?? null,
  };
}

const ILLEGAL: Array<{ pattern: RegExp; reason: string; alternative: string }> = [
  { pattern: /\b(under|younger than|below)\s+\d{2}\b|\brecent grad(?:uate)?s?\b|\byoung\b|\bdigital native/i, reason: "Age and proxies for age cannot be hiring criteria.", alternative: "Describe the energy or skills you need (for example, comfort with new software) and we will screen for that." },
  { pattern: /\bno (employment )?gaps?\b/i, reason: "Employment gaps are not a lawful or useful criterion.", alternative: "We will look at demonstrated skills and recent relevant experience instead." },
  { pattern: /\bnative (english )?speaker/i, reason: "Native-speaker requirements can discriminate by national origin.", alternative: "We can require the level of English proficiency the job actually needs, such as clear patient communication." },
  { pattern: /\b(no|without) (kids|children|family)\b|\bsingle\b|\bmarried\b/i, reason: "Family status cannot be a criterion.", alternative: "If the real need is schedule availability, we will ask every candidate about availability." },
  { pattern: /\bzip( ?code)?\b.*\bonly\b|\bonly\b.*\bzip( ?code)?\b/i, reason: "Zip-code restrictions are a proxy for protected characteristics and are prohibited in Illinois.", alternative: "We will ask whether candidates can reliably work at the location." },
];

/** "Did we hire anyone?" or "what's on today?": a question about the day, not a role to open (founder decision Q5). */
function notARole(text: string, facts: IntakeFacts, playbookRoleTitle: string | null): boolean {
  if (facts.title) return false;
  const t = text.trim();
  const asksAboutTheDay = /^(?:did|how|what|what's|when|who|where|is|are|do|does|has|have|any|why)\b/i.test(t) && /\?\s*$/.test(t) && !/\b(?:hire|hiring|need|find|looking for)\s+(?:a|an|some|another|two|three)\b/i.test(t);
  if (asksAboutTheDay) return true;
  // "Front office coordinator in Tustin, $22 to $26 an hour. Just draft it." names a job without the word "hire".
  const aboutHiring = /\b(?:hire|hiring|need|want|looking for|recruit|position|role|job|opening|vacancy|replace|replacement|staff)\b/i.test(t) || !!playbookRoleTitle || /\$\s?\d|\bdraft it\b/i.test(t);
  return !aboutHiring;
}

/** The playbook block as the fake reads it: the role's qualifications, competencies, screening questions and interview plan. */
function playbookRoleFrom(req: StructuredRequest<unknown>): { competencies: Array<{ key: string; name: string; definition: string }>; eligibility: Array<{ type: string; question: string }>; qualifications: string[]; questions: string[]; interviews: Array<{ title: string; minutes: number; format: string }> } {
  const sys = req.system.map((b) => b.text).join("\n");
  const block = sys.match(/Matched playbook role: ([\s\S]*?)(?:\n|$)/)?.[1] ?? "";
  const seg = (start: string, end: string) => { const i = block.indexOf(start); if (i < 0) return ""; const rest = block.slice(i + start.length); const j = rest.indexOf(end); return (j < 0 ? rest : rest.slice(0, j)).trim(); };
  const competencies = seg("Competencies: ", ". Screening questions:").split("; ").map((c) => c.match(/^(.*?) \((.*)\)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => ({ key: slug(m[1]), name: m[1].trim(), definition: m[2].trim() }));
  const eligibility = seg("Typical eligibility: ", ". Common qualifications:").split(" | ").map((e) => e.match(/^([a-z_]+): (.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => ({ type: m[1], question: m[2].trim() }));
  const qualifications = seg("Common qualifications: ", ". Competencies:").split("; ").map((q) => q.trim()).filter(Boolean);
  const questions = seg("Screening questions: ", ". Interview plan:").split(" | ").map((q) => q.trim()).filter(Boolean);
  const interviews = seg("Interview plan: ", ". Red flags").split("; ").map((r) => r.match(/^(.*?) \((\d+) min, ([a-z_]+)\)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => ({ title: m[1].trim(), minutes: Number(m[2]), format: m[3] }));
  return { competencies, eligibility, qualifications, questions, interviews };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "item";
}

const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const per = (basis: string) => (basis === "hourly" ? "an hour" : "a year");

/**
 * The items of a list line ("Must-haves: ...") not already in the facts. The summary of tapped answers lists each ticked
 * answer whole, between semicolons, and the server has already put it in the facts: it stays whole, never split into
 * "Instagram", "TikTok", ... beside it (polish list). Words the owner typed are still read as a list (`split`).
 */
function newListItems(text: string, known: string[], split: RegExp): string[] {
  const has = (s: string, more: string[]) => [...known, ...more].some((m) => normalizeCriterion(m) === normalizeCriterion(s));
  const added: string[] = [];
  for (const part of text.split(";").map((s) => s.trim().replace(/\.$/, "")).filter(Boolean)) {
    if (has(part, added)) continue;
    for (const piece of part.split(split).map((s) => s.trim().replace(/\.$/, "")).filter(Boolean)) if (!has(piece, added)) added.push(piece);
  }
  return added;
}

/**
 * intake.turn v2: realistic question cards (up to three) the way the model is asked to write them, built from the
 * playbook and what is still missing. Pay comes first when nobody has stated it, then the reason for the hire, the
 * first thing the person would own, the true must-haves, screening questions, the team and the start date.
 */
function fakeIntakeTurn(c: FakeIntakeContext): IntakeTurn {
  const last = c.ownerMessages[c.ownerMessages.length - 1] ?? "";
  // The summary of tapped answers repeats what was refused ("Not used: ..."); that is not a new request.
  const said = (s: string) => s.split("\n").filter((l) => !/^Not used:/.test(l)).join("\n");
  const all = c.ownerMessages.map(said).join("\n");
  const facts: IntakeFacts = { ...c.facts };
  const firstTurn = c.ownerMessages.length === 1 && !c.fromRole;

  if (firstTurn && !c.ad && notARole(last, facts, c.playbookRoleTitle)) {
    return { assistantMessage: "That doesn't sound like a new role, so I haven't started a draft. When you're ready to hire, describe the job: the title, where it is, the pay and why you're hiring.", factsExtracted: facts, missingFacts: [], questions: [], readyToCompile: false, confidence: "low", notARole: true, takenFromAd: [] };
  }

  if (!facts.title) {
    const t = c.playbookRoleTitle ?? all.match(/(?:hire|need|want|looking for)\s+(?:an?|the)?\s*([A-Za-z][A-Za-z /-]{3,50}?)(?=\s+(?:in|for|at|who|with|that|\.|,|$))/i)?.[1]?.trim();
    if (t) facts.title = t;
  }
  if (!facts.locationText) {
    const l = all.match(/\bin\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?(?:,\s?[A-Z]{2})?)/)?.[1];
    if (l) facts.locationText = l;
    else if (c.locationsText) facts.locationText = c.locationsText.split(";")[0].trim();
  }
  if (!facts.employmentType) {
    if (/full[\s-]?time/i.test(all)) facts.employmentType = "full_time";
    else if (/part[\s-]?time/i.test(all)) facts.employmentType = "part_time";
    else if (/per diem|temp/i.test(all)) facts.employmentType = "per_diem";
  }
  // The work model, only when the owner states it ("hybrid, three days in the office", "fully remote", "on-site only"); on-site is the packet's default.
  if (!facts.remotePolicy) {
    if (/\bhybrid\b/i.test(all)) facts.remotePolicy = "hybrid";
    else if (/\bremote\b/i.test(all) && !/\b(no|not|never|isn't|is not)\s+(fully\s+)?remote\b/i.test(all)) facts.remotePolicy = "remote";
    else if (/\b(on[\s-]?site|in[\s-]?office|in[\s-]?person)\b/i.test(all)) facts.remotePolicy = "onsite";
  }
  const pay = all.match(/\$\s?(\d{2,3}(?:,\d{3})?(?:\.\d+)?)\s*(?:k)?\s*(?:to|-|–)\s*\$?\s?(\d{2,3}(?:,\d{3})?(?:\.\d+)?)\s*(k)?\s*(?:an hour|\/hr|per hour|hourly|a year|\/yr|per year|annually|k)?/i);
  if (pay && facts.compensationMin === undefined) {
    let min = Number(pay[1].replace(/,/g, ""));
    let max = Number(pay[2].replace(/,/g, ""));
    const isK = !!pay[3] || /\bk\b/i.test(pay[0]);
    if (isK) { min *= 1000; max *= 1000; }
    facts.compensationMin = min;
    facts.compensationMax = max;
    facts.compensationBasis = /hour|hr|hourly/i.test(pay[0]) || max < 500 ? "hourly" : "salary";
  }
  if (!facts.compensationBasis) {
    if (/\b(?:hourly|by the hour|an hour|per hour)\b/i.test(all)) facts.compensationBasis = "hourly";
    else if (/\b(?:salary|salaried|a year|per year|annual)\b/i.test(all)) facts.compensationBasis = "salary";
  }
  const ceiling = all.match(/(?:ceiling|max(?:imum)?|no more than|up to)\s*(?:of|is|at)?\s*\$?\s?(\d{2,3}(?:,\d{3})?)/i);
  if (ceiling && facts.compensationCeiling === undefined) facts.compensationCeiling = Number(ceiling[1].replace(/,/g, ""));
  const start = all.match(/start (?:within|in) (\d+) days/i);
  if (start && !facts.targetStartDate) {
    const d = new Date(); d.setDate(d.getDate() + Number(start[1]));
    facts.targetStartDate = d.toISOString().slice(0, 10);
  }
  if (!facts.reason) {
    if (/replac|left|quit|leaving|resign/i.test(all)) facts.reason = "replacement";
    else if (/new (position|role|location)|growing|growth|expand|second location|third location/i.test(all)) facts.reason = "growth";
  }
  const normalizedTitles = all.replace(/\b(Dr|Mr|Mrs|Ms)\./gi, "$1");
  if (!facts.decisionMaker) {
    if (/\b(i|me) (make|will make) the (final )?(call|decision)|i decide/i.test(all)) facts.decisionMaker = "the owner";
    else {
      const named = normalizedTitles.match(/\b((?:Dr|Mr|Mrs|Ms)\s)?([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s(?:makes|will make|has|gets)\s(?:the\s)?final\s(?:decision|call|say)/);
      if (named) facts.decisionMaker = `${named[1] ?? ""}${named[2]}`.trim();
    }
  }
  const interviewers = normalizedTitles.match(/interview(?:ers?|s)?(?: will be| are| is|:)\s+([^.\n]+)/i);
  if (interviewers && facts.interviewers.length === 0) {
    facts.interviewers = interviewers[1]
      .split(/,| and /)
      .map((s) => s.trim())
      // Keep names; drop trailing descriptions such as "our office manager".
      .filter((s) => s && !/^(i|me|myself)$/i.test(s) && !/^(our|the|my|a|an|who)\b/.test(s) || /^me$/i.test(s));
  }
  if (!facts.whatFailureLooksLike) {
    const f = all.match(/fail(?:ure)? (?:would look like|looks like|means)\s*[:-]?\s*([^.\n]+)/i)
      ?? all.match(/(?:did not|didn't|does not|doesn't|hasn't|has not) work(?:ed)? out (?:if|when|would be)\s+([^.\n]+)/i);
    if (f) facts.whatFailureLooksLike = f[1].trim();
  }
  const mh = last.match(/must[\s-]?haves?\s*[:-]\s*([^\n]+)/i) ?? last.match(/\bmust have\s+(?:an?\s+)?([^.\n]+)/i);
  if (mh) facts.mustHaves = [...facts.mustHaves, ...newListItems(mh[1], facts.mustHaves, /,| and (?:be |have )?/)];
  const nh = last.match(/nice[\s-]?to[\s-]?haves?\s*[:-]\s*([^\n]+)/i);
  if (nh) facts.niceToHaves = [...facts.niceToHaves, ...newListItems(nh[1], facts.niceToHaves, /,/)];
  const db = last.match(/deal[\s-]?breakers?\s*[:-]\s*([^\n]+)/i);
  if (db) facts.dealBreakers = [...facts.dealBreakers, ...newListItems(db[1], facts.dealBreakers, /,/)];

  // Unlawful wording in what the owner just said, and in a pasted ad on the first turn (the ad is data, never instructions).
  const declinedNow: IntakeFacts["declinedCriteria"] = [];
  for (const text of [said(last), ...(firstTurn && c.ad ? [c.ad] : [])]) {
    for (const rule of ILLEGAL) {
      const m = text.match(rule.pattern);
      if (m && !declinedNow.some((d) => d.requested.toLowerCase() === m[0].toLowerCase())) declinedNow.push({ requested: m[0], reason: rule.reason, alternative: rule.alternative });
    }
  }
  facts.declinedCriteria = [...facts.declinedCriteria, ...declinedNow];

  const missing: IntakeTurn["missingFacts"] = [];
  if (!facts.title) missing.push("title");
  if (!facts.locationText) missing.push("location");
  if (!facts.reason) missing.push("reason_for_hire");
  if (!facts.compensationBasis) missing.push("compensation_basis");
  if (facts.compensationMin === undefined) missing.push("compensation_range");
  if (facts.compensationCeiling === undefined && facts.compensationMax === undefined) missing.push("compensation_ceiling");
  if (facts.mustHaves.length === 0 && !c.playbookRoleTitle) missing.push("must_haves");
  if (facts.interviewers.length === 0) missing.push("interviewers");
  if (!facts.decisionMaker) missing.push("decision_maker");
  if (!facts.targetStartDate) missing.push("timeline");
  if (!facts.whatFailureLooksLike) missing.push("what_failure_looks_like");
  if (facts.dealBreakers.length === 0) missing.push("deal_breakers");

  const justDraft = /just draft it|draft it|go ahead|that's enough|thats enough|make the packet|compile/i.test(last);
  const essentials = !!facts.title && !!facts.locationText && facts.compensationMin !== undefined;
  const ready = justDraft || (essentials && missing.filter((m) => ["reason_for_hire", "interviewers", "decision_maker"].includes(m)).length === 0);

  const pb = playbookRoleFrom(c.req);
  const fromAd = !!c.ad && facts.compensationMin !== undefined && !c.ownerMessages.slice(firstTurn ? 1 : 0).some((m) => /\$\s?\d/.test(m));
  const questions: IntakeQuestion[] = [];
  const ask = (q: Omit<IntakeQuestion, "id">) => { if (questions.length < 3) questions.push({ id: `fake_${questions.length + 1}`, ...q }); };
  if (fromAd) ask({ field: "compensation", prompt: `Your ad says ${money(facts.compensationMin!)}–${money(facts.compensationMax ?? facts.compensationMin!)} ${per(facts.compensationBasis ?? "hourly")}. Is that still right?`, mode: "pay", options: [], allowOwn: true, why: "Pay is always shown on the job ad, so it has to be current." });
  else if (facts.compensationMin === undefined) ask({ field: "compensation", prompt: "What will you pay?", mode: "pay", options: [], allowOwn: true, why: "Pay is always shown on the job ad, and checked against the market." });
  if (!facts.reason) ask({ field: "reason_for_hire", prompt: "Why are you hiring?", mode: "single", options: [{ label: "A new position", value: "new_position", origin: "assistant" }, { label: "Replacing someone who left", value: "replacement", origin: "assistant" }, { label: "The team is growing", value: "growth", origin: "assistant" }, { label: "Seasonal help", value: "seasonal", origin: "assistant" }], allowOwn: true, why: "A replacement and a new position call for different questions." });
  if (!facts.responsibilities?.length) {
    const options = pb.competencies.length
      ? pb.competencies.slice(0, 4).map((x) => ({ label: x.name, value: x.definition, origin: "playbook" as const }))
      : [{ label: "The day-to-day work of the job", value: `The day-to-day ${facts.title ?? "work"}`, origin: "assistant" as const }, { label: "A project that is waiting", value: "A project that is waiting for someone to own it", origin: "assistant" as const }];
    ask({ field: "responsibilities", prompt: "What is the first thing they would own?", mode: "single", options, allowOwn: true, why: "It shapes the job ad and the questions candidates are asked." });
  }
  if (!facts.mustHaves.length && pb.qualifications.length) ask({ field: "must_haves", prompt: "Which of these are genuinely must-haves?", mode: "multi", options: pb.qualifications.slice(0, 5).map((q) => ({ label: q, value: q, origin: "playbook" as const })), allowOwn: true, why: "Must-haves decide who reads as a match; keep it to the few you would not hire without." });
  if (facts.screeningQuestions === undefined && pb.questions.length >= 3) ask({ field: "screening_questions", prompt: "Add three screening questions?", mode: "multi", options: pb.questions.slice(0, 3).map((q) => ({ label: q, value: q, origin: "playbook" as const })), allowOwn: true, why: "Candidates answer these in a short conversation marked as AI, with a person available." });
  if (!facts.interviewers.length) ask({ field: "interviewers", prompt: "Who will interview?", mode: "team", options: [], allowOwn: true, why: "They get the interview plan and the questions to ask." });
  if (!facts.decisionMaker) ask({ field: "decision_maker", prompt: "Who has the final say?", mode: "team", options: [], allowOwn: true, why: "Their approval opens the role." });
  if (!facts.targetStartDate) ask({ field: "timeline", prompt: "When do you need them to start?", mode: "single", options: [{ label: "As soon as possible", value: "asap", origin: "assistant" }, { label: "Within a month", value: "within_30_days", origin: "assistant" }, { label: "Within three months", value: "within_90_days", origin: "assistant" }], allowOwn: true, why: "It sets how fast the search moves." });

  const takenFromAd: string[] = [];
  if (firstTurn && c.ad) {
    if (facts.title) takenFromAd.push(`Job title: ${facts.title}`);
    if (facts.locationText) takenFromAd.push(`Where: ${facts.locationText}`);
    if (facts.employmentType) takenFromAd.push(`Type: ${facts.employmentType.replace(/_/g, " ")}`);
    if (facts.schedule) takenFromAd.push(`Schedule: ${facts.schedule}`);
    if (facts.compensationMin !== undefined) takenFromAd.push(`Pay in the ad: ${money(facts.compensationMin)}–${money(facts.compensationMax ?? facts.compensationMin)} ${per(facts.compensationBasis ?? "hourly")} (to confirm)`);
  }

  const benchmarkMentioned = c.ownerMessages.length > 1; // the benchmark is stated once, on the first turn that has a range
  const lines: string[] = [];
  if (declinedNow.length) for (const d of declinedNow) lines.push(`I can't build "${d.requested}" into the requirements. ${d.reason} ${d.alternative}`);
  if (c.fromRole && c.ownerMessages.length === 1) lines.push(`I've started from your last ${c.fromRole} role. What has changed since then? Please confirm the pay again too.`);
  if (takenFromAd.length) lines.push(`I took these from your ad: ${takenFromAd.join("; ")}. I'll only ask about what's missing.`);
  if (c.playbookRoleTitle && c.ownerMessages.length === 1) lines.push(`Got it. I'm using our ${c.vertical} playbook for a ${c.playbookRoleTitle}${facts.locationText ? ` in ${facts.locationText}` : ""}.`);
  if (c.benchmark && facts.compensationMin !== undefined && !benchmarkMentioned) {
    // intake.turn v3: money as the pay card writes it, the place with capitals, and a figure for a broader group of jobs
    // told as a rough guide, with a range below its middle mentioned gently (polish list).
    const b = c.benchmark;
    const below = facts.compensationMax !== undefined && facts.compensationMax < b.p50;
    const where = marketPlace(b.metro);
    const whose = b.origin === "its_estimate" ? `ITS's estimate of the market for ${where}` : `the market for ${where}`;
    const rough = b.approximate ? ` There is no government pay figure for this exact job, so this one is for a broader group${b.occupation ? ` (${b.occupation.toLowerCase()})` : ""}: take it as a rough guide.` : "";
    const belowWords = !below ? "" : b.approximate ? " Your range is below its middle, which is worth knowing but not a worry on its own." : " Your range is below the middle, which may slow the search.";
    lines.push(`For reference, ${whose} runs about ${money(b.p25)}–${money(b.p75)} ${per(b.basis)} (middle ${money(b.p50)}; source: ${b.source}).${rough}${belowWords}`);
  } else if (c.benchmarkGap === "basis_unknown" && !benchmarkMentioned) lines.push("Is this job paid by the hour or a yearly salary? I'll check market pay once I know.");
  else if (c.benchmarkGap === "no_market_figure" && !benchmarkMentioned) lines.push("I have no market pay figure for this job here, so the pay isn't checked against the market.");
  if (ready) lines.push(`I have enough to write a first draft${missing.length ? `, with assumptions noted for: ${missing.map((m) => m.replace(/_/g, " ")).join(", ")}` : ""}. Say "draft it" or answer anything beside this first.`);
  else if (questions.length) lines.push(`I've put ${questions.length === 1 ? "a quick question" : `${questions.length} quick questions`} beside this. Tap an answer, add your own, or just type.`);
  return {
    assistantMessage: lines.join("\n\n") || "Tell me who you need to hire.",
    factsExtracted: facts,
    missingFacts: missing,
    questions,
    readyToCompile: ready,
    confidence: essentials ? "medium" : "low",
    notARole: false,
    takenFromAd,
  };
}

/** intake.extract: what a pasted ad states plainly, read with simple rules. */
function fakeExtract(req: StructuredRequest<unknown>): IntakeExtraction {
  const text = ((req.messages[0]?.content ?? "") as string).match(/<owner_text>\n?([\s\S]*?)\n?<\/owner_text>/)?.[1] ?? "";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const labelled = (label: RegExp) => lines.map((l) => l.match(new RegExp(`^(?:${label.source})\\s*[:\\-–]\\s*(.+)$`, "i"))?.[1]?.trim()).find(Boolean);
  const heading = lines[0] && lines[0].length <= 60 && !/[.!?]$/.test(lines[0]) && !/^(?:about|we are|join)/i.test(lines[0]) ? lines[0].replace(/^(?:now hiring|hiring)\s*[:\-–]?\s*/i, "") : undefined;
  const title = labelled(/job title|title|position|role/) ?? heading ?? text.match(/\bhiring (?:a|an) ([A-Za-z][A-Za-z /-]{3,40}?)(?=[.,\n]| to | in )/i)?.[1];
  const locationText = labelled(/location|where/) ?? text.match(/\bin ([A-Z][a-z]+(?: [A-Z][a-z]+)?, [A-Z]{2})\b/)?.[1];
  const employmentType = /full[\s-]?time/i.test(text) ? "full_time" : /part[\s-]?time/i.test(text) ? "part_time" : undefined;
  const schedule = labelled(/schedule|hours/);
  const pay = text.replace(/(\d),(\d{3})/g, "$1$2").match(/\$\s?(\d+(?:\.\d+)?)\s*(k)?\s*(?:-|–|to)\s*\$?\s?(\d+(?:\.\d+)?)\s*(k)?\s*(per hour|an hour|\/hr|hourly|per year|a year|\/yr|annually|salary)?/i);
  let basis: "hourly" | "salary" | undefined;
  let min: number | undefined;
  let max: number | undefined;
  if (pay) {
    min = Number(pay[1]) * (pay[2] || pay[4] ? 1000 : 1);
    max = Number(pay[3]) * (pay[4] ? 1000 : 1);
    basis = pay[5] ? (/hour|hr/i.test(pay[5]) ? "hourly" : "salary") : max >= 1000 ? "salary" : "hourly";
  }
  const isJobDescription = !!title || /\b(?:responsibilities|requirements|qualifications|we are hiring|join our team|apply)\b/i.test(text);
  return { isJobDescription, ...(title ? { title } : {}), ...(locationText ? { locationText } : {}), ...(employmentType ? { employmentType } : {}), ...(schedule ? { schedule } : {}), ...(basis ? { compensationBasis: basis, compensationMin: min, compensationMax: max } : {}) };
}

/**
 * intake.compile v4: the draft, with pay only when a person set or confirmed it (and never in the description), the
 * owner's own choices first, and a screening conversation of five or six questions and about ten minutes (more only for
 * the owner's own questions), since candidates answer it straight after the form (plan E8).
 */
function fakeCompile(c: FakeIntakeContext): DraftRolePacket {
  const f = c.facts;
  const title = f.title ?? c.playbookRoleTitle ?? "New hire";
  const pay = c.confirmedPay;
  const [locCity, locRegion] = (f.locationText ?? c.locationsText.split(";")[0] ?? "").split(",").map((s) => s.trim());
  const assumptions: string[] = [];
  const pbRole = playbookRoleFrom(c.req);
  const fromPlaybook = pbRole.qualifications.slice(0, 3);
  const mustHaves = (f.mustHaves.length ? f.mustHaves : fromPlaybook.length ? fromPlaybook : [`${title} experience relevant to a ${c.vertical} setting`, "Reliable availability for the posted schedule"]).slice(0, 6);
  if (!f.mustHaves.length) assumptions.push("Must-haves were not chosen; drafted from the playbook and should be reviewed.");
  if (!f.reason) assumptions.push("Reason for the hire was not stated; assumed growth.");
  if (!f.interviewers.length) assumptions.push("Interviewers were not named; assumed the owner interviews.");
  if (pay && f.compensationCeiling === undefined && pay.ceiling === undefined) assumptions.push(`Ceiling assumed equal to the top of the range (${pay.max}).`);
  const isDental = c.vertical === "dental";
  const rdh = /hygien/i.test(title);
  const eligibility: DraftRolePacket["requirements"]["eligibility"] = [];
  if (isDental && rdh) eligibility.push({ key: "rdh_license", type: "license", question: `Do you hold an active dental hygiene (RDH) license in ${locRegion || "the state of this office"}?`, expectation: { license: "RDH", jurisdiction: locRegion || "" }, rationale: "Required by law to practice dental hygiene.", knockout: true });
  if (isDental) eligibility.push({ key: "bls", type: "certification", question: "Do you hold current CPR/BLS certification (or can you obtain it before your start date)?", expectation: { certification: "BLS" }, rationale: "Required for clinical staff.", knockout: false });
  if (!isDental) {
    const wa = pbRole.eligibility.find((e) => e.type === "work_authorization");
    eligibility.push({ key: "work_authorization", type: "work_authorization", question: wa?.question ?? "Are you legally authorized to work in the United States for any employer?", expectation: { authorized: true }, rationale: "Required for employment; asked of every candidate.", knockout: true });
  }
  eligibility.push({ key: "schedule", type: "schedule_availability", question: isDental ? "Are you available for the posted schedule?" : "Are you available for the posted schedule and work model?", expectation: {}, rationale: isDental ? "Coverage is the reason for the hire." : "The owner stated the work model in the packet.", knockout: true });
  if (f.targetStartDate) {
    const days = Math.max(7, Math.round((Date.parse(f.targetStartDate) - Date.now()) / 86_400_000));
    eligibility.push({ key: "start", type: "start_date", question: `Can you start within ${days} days?`, expectation: { withinDays: days }, rationale: "The owner needs coverage by the target date.", knockout: true });
  }
  const competencies: DraftRolePacket["competencies"] = rdh
    ? [
        { key: "clinical_quality", name: "Clinical quality", definition: "Thorough, gentle, standards-based care.", weight: 5, evaluatedIn: "both", indicators: ["Complete perio assessment", "Infection control"] },
        { key: "patient_communication", name: "Patient communication", definition: "Explains findings plainly and builds trust.", weight: 5, evaluatedIn: "both", indicators: ["Educating a resistant patient"] },
        { key: "efficiency", name: "Efficiency", definition: "Keeps to the schedule without cutting corners.", weight: 4, evaluatedIn: "screen", indicators: ["Appointment lengths"] },
        { key: "reliability", name: "Reliability", definition: "Shows up consistently; communicates early.", weight: 4, evaluatedIn: "both", indicators: ["Attendance history"] },
      ]
    : pbRole.competencies.length >= 3
      ? pbRole.competencies.slice(0, 8).map((x, i) => ({ key: x.key, name: x.name, definition: x.definition, weight: i < 2 ? 5 : 4, evaluatedIn: "both" as const, indicators: [x.definition] }))
      : [
        { key: "role_skill", name: `${title} skill`, definition: `Does the core work of a ${title} well.`, weight: 5, evaluatedIn: "both", indicators: ["Concrete examples from recent work"] },
        { key: "communication", name: "Communication", definition: "Clear with customers and the team.", weight: 4, evaluatedIn: "both", indicators: ["Example of a hard conversation"] },
        { key: "reliability", name: "Reliability", definition: "Shows up consistently.", weight: 4, evaluatedIn: "screen", indicators: ["Attendance history"] },
      ];
  const kindOf = (q: string): DraftRolePacket["screening"]["questions"][number]["kind"] => /salary|pay |earn|range are you|compensation/i.test(q) ? "compensation" : /available|start|schedule|work model/i.test(q) ? "availability" : /looking for in your next/i.test(q) ? "motivation" : /tell me about|describe|walk me through|give an example/i.test(q) ? "behavioral" : "skills";
  const asQuestion = (q: string, i: number) => ({ key: slug(q.split(/[,:?]/)[0].split(" ").slice(0, 4).join(" ")) || `q${i + 1}`, question: q, kind: kindOf(q), competencyKey: competencies[i % competencies.length]?.key });
  const ownQuestions = (f.screeningQuestions ?? []).map(asQuestion);
  const playbookQuestions: DraftRolePacket["screening"]["questions"] = !rdh && pbRole.questions.length >= 3 ? pbRole.questions.slice(0, 10).map(asQuestion) : [];
  const defaults: DraftRolePacket["screening"]["questions"] = [
    ...(rdh ? [{ key: "license_confirm", question: "Can you confirm your RDH license state and whether it is currently active?", kind: "eligibility" as const }] : []),
    { key: "experience", question: `Tell me about your most recent ${title} work and what a typical day looked like.`, kind: "skills" as const, competencyKey: competencies[0].key },
    { key: "hard_moment", question: "Tell me about a difficult moment with a customer or patient and what you did.", kind: "behavioral" as const, competencyKey: competencies[1].key },
    { key: "availability", question: "Which days and hours are you available, and when could you start?", kind: "availability" as const },
    { key: "pay", question: `What ${pay?.basis === "salary" ? "salary" : "hourly"} range are you looking for?`, kind: "compensation" as const },
    { key: "why", question: "What are you looking for in your next role?", kind: "motivation" as const },
  ];
  const pooled = [...ownQuestions, ...(playbookQuestions.length >= 3 ? playbookQuestions : defaults)];
  const questions = pooled.filter((q, i, arr) => arr.findIndex((x) => x.key === q.key) === i).slice(0, Math.min(12, Math.max(6, ownQuestions.length)));
  const first = f.responsibilities?.[0];
  // intake.compile v3 and v4: no pay in the description (the job page shows the range a person set beside it).
  const benefitsLine = f.benefits ? ` Benefits include ${f.benefits.replace(/\.$/, "")}.` : "";
  const description = `${c.companyName} is hiring a ${title}${locCity ? ` in ${locCity}${locRegion ? `, ${locRegion}` : ""}` : ""}. ${f.reason === "replacement" ? "We are filling an open chair on a team that values consistency and kindness." : "Our team is growing and we need someone who takes pride in careful, friendly work."} You will ${rdh ? "provide preventive care, periodontal therapy, and patient education for a loyal patient base, working alongside a dentist who respects your judgment" : `own ${title.toLowerCase()} outcomes end to end, work directly with the founder and a small team that moves quickly, and see the results of your decisions in the numbers`}.${first ? ` The first thing you will own: ${first.replace(/\.$/, "")}.` : ""} The schedule is ${f.employmentType === "part_time" ? "part time" : "full time"}${f.schedule ? ` (${f.schedule})` : ""}.${benefitsLine} We respond to every applicant within a day, keep the process short, and tell you where you stand at each step.`;
  const notSet = f.whatFailureLooksLike ? `What failure looks like: ${f.whatFailureLooksLike}` : undefined;
  return {
    schemaVersion: 1,
    identity: { title, department: undefined, locations: [{ city: locCity || undefined, region: locRegion || undefined, country: "US" }], employmentType: (["full_time", "part_time", "contract", "temporary", "per_diem", "internship"].includes(f.employmentType ?? "") ? f.employmentType : "full_time") as DraftRolePacket["identity"]["employmentType"], schedule: f.schedule, remotePolicy: f.remotePolicy === "hybrid" || f.remotePolicy === "remote" ? f.remotePolicy : "onsite" },
    business: { reason: (["new_position", "replacement", "growth", "seasonal", "other"].includes(f.reason ?? "") ? f.reason : "growth") as DraftRolePacket["business"]["reason"], reasonDetail: f.reasonDetail, timeline: { targetStartDate: f.targetStartDate, urgency: f.targetStartDate ? "high" : "normal", inactivityDays: 10 } },
    ...(pay ? { compensation: { basis: pay.basis, currency: "USD", min: pay.min, mid: Math.round((pay.min + pay.max) / 2), max: pay.max, ceiling: f.compensationCeiling ?? pay.ceiling ?? pay.max, bonus: undefined, benefitsSummary: f.benefits, discloseRange: true, sources: [...(c.benchmark ? [{ name: c.benchmark.source, detail: `${c.benchmark.metro}: p25 ${c.benchmark.p25}, p50 ${c.benchmark.p50}, p75 ${c.benchmark.p75}` }] : []), { name: "owner-stated", detail: `${pay.min}–${pay.max} ${pay.basis}` }], ownerStated: true } } : {}),
    description: { publicJobDescription: description, internalNotes: notSet },
    requirements: {
      mustHaves: mustHaves.map((m, i) => ({ key: `mh_${i + 1}_${slug(m)}`, text: m, rationale: f.mustHaves.length ? "Chosen by the owner as a must-have" : "Common for this role in our playbook", evidencedBy: ["resume", "screen"] })),
      niceToHaves: f.niceToHaves.map((m, i) => ({ key: `nh_${i + 1}_${slug(m)}`, text: m, rationale: "Nice to have per the owner", evidencedBy: ["resume", "screen"] })),
      eligibility,
    },
    competencies,
    evaluation: { criteria: ["Evidence for each must-have", "Competency indicators observed in screen and interviews", "Availability matches the schedule"], redFlags: ["Cannot confirm required license", "Availability does not match the schedule"] },
    screening: { questions: questions.length >= 3 ? questions : defaults, maxMinutes: 10 },
    interviews: {
      plan: !rdh && pbRole.interviews.length >= 1
        ? pbRole.interviews.slice(0, 5).map((r, i, arr) => ({ key: slug(r.title) || `round_${i + 1}`, title: r.title, purpose: i === 0 ? "Fit, results, and the candidate's questions." : "See how they think about our real problems.", durationMinutes: Math.min(240, Math.max(15, r.minutes)), format: (["video", "phone", "onsite", "working_session"].includes(r.format) ? r.format : "video") as DraftRolePacket["interviews"]["plan"][number]["format"], interviewerUserIds: [], interviewerRoles: f.interviewers.length ? f.interviewers : ["owner"], competencyKeys: competencies.filter((_, ci) => ci % arr.length === i).map((x) => x.key).concat(i === 0 ? [competencies[0].key] : []).filter((k, ki, ks) => ks.indexOf(k) === ki), suggestedQuestions: [] }))
        : [
        { key: "owner", title: `Conversation with ${f.interviewers[0] ?? "the owner"}`, purpose: "Fit, expectations, and the candidate's questions.", durationMinutes: 30, format: "video", interviewerUserIds: [], interviewerRoles: f.interviewers.length ? f.interviewers : ["owner"], competencyKeys: competencies.slice(1).map((x) => x.key), suggestedQuestions: ["What does a great day look like for you?", "What would make you leave a job?"] },
        { key: "working", title: rdh ? "Working interview" : "Skills conversation on site", purpose: "See the work in practice and meet the team.", durationMinutes: rdh ? 90 : 60, format: "onsite", interviewerUserIds: [], interviewerRoles: f.interviewers.length ? f.interviewers : ["owner"], competencyKeys: [competencies[0].key], suggestedQuestions: [] },
      ],
      scorecard: { scale: { min: 1, max: 4, labels: { "1": "Concern", "2": "Mixed", "3": "Meets", "4": "Strong" } }, requireEvidence: true, overallRecommendationOptions: ["strong_yes", "yes", "no", "strong_no"] },
    },
    communication: { tone: "warm", companyBlurb: `${c.companyName} is a ${c.vertical} business that treats its team and its customers with respect.`, candidateMayBeTold: ["The posted pay range", "The schedule", "The interview steps and typical timeline"], signature: `The hiring team at ${c.companyName}`, disclosureText: `This message was sent by the hiring team at ${c.companyName} with help from an AI recruiting assistant. Reply HUMAN at any time to reach a person.`, humanAlternativeText: "Reply HUMAN at any time and a person from our team will follow up." },
    approvals: { packetApproverRoles: ["owner", "admin", "hiring_manager"], interviewApproverRoles: ["owner", "hiring_manager", "recruiter"], offerApproverRoles: ["owner", "admin"] },
    compliance: { jurisdictions: [], notices: ["ai_use", "privacy"], retentionClass: "decision_data_4y", recordingPolicy: "consent_required", smsRequiresConsent: true },
    sourcing: { summary: "Careers page and Google for Jobs immediately; Indeed from the owner's account with applications forwarded to the intake address; referrals from the team.", channels: ["careers_page", "google_jobs", "indeed", "referrals", "rediscovery"], targetSources: isDental ? ["Local dental hygiene programs", "State dental hygienists' association job board"] : [], sponsoredDailyBudget: 0, referralPrompt: `Know a great ${title}? Send them our link.`, rediscovery: true },
    preferences: { decisionMakerUserId: undefined, decisionMakerName: f.decisionMaker, dealBreakersInTheirWords: f.dealBreakers, whatFailureLooksLike: f.whatFailureLooksLike, schedulingWindows: [], interviewStyle: undefined },
    provenance: { playbookId: undefined, playbookVersion: undefined, intakeSessionId: undefined, aiRunIds: [], assumptions, sources: ["fake provider (deterministic draft)"] },
  };
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
  return { questions, company: company?.[1]?.trim() ?? "the company", role: company?.[2]?.trim() ?? "the role", pay: pay ? { basis: pay[1], min: Number(pay[2]), max: Number(pay[3]) } : null, progress, name, channel, minutes, competencies };
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
    // local run shows what the model does (polish list). Never on anything personal, never on the open questions.
    const noFollowUpYet = Object.values(s.progress.followUps).every((n) => !n);
    const claim = ["skills", "behavioral"].includes(currentQ.kind) && complete && trimmed.length >= 40 && /^I\b/.test(trimmed) && !/\d/.test(trimmed) && !/\b(?:for example|for instance|e\.g\.|once|one time)\b/i.test(trimmed) && redactProtected(trimmed) === trimmed;
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
  const moveOn = (reading: "concrete" | "vague" | "not_done"): ScreenTurn => {
    // Their words about this item since it was asked, verbatim and in order.
    const at = user.lastIndexOf(item.question);
    // a keyword command is not an answer
    const replies = [...(at >= 0 ? user.slice(at) : user).matchAll(/^candidate: (.*)$/gm)].map((m) => m[1].trim()).filter((x) => x && !/^(?:human|person|a person|a human|agent|representative|withdraw(?: my application)?|confirm)[.!]?$/i.test(x)).join(" ");
    const recorded = reading === "not_done" && item.kind === "gap" ? null : { questionKey: item.key, answer: redactProtected(replies || said), complete: reading === "concrete" };
    return { ...base, reading, questionKey: next?.key ?? null, done: !next, answerRecorded: recorded, messageToCandidate: reading === "not_done" ? "Understood, thanks for saying so." : `You said "${quoteOf(said)}".` };
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
 * The scorecard's must-have findings (screen.assess v7), the way the model is asked to write them: for each must-have the
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
 * packet.revise v1 (C10): the few kinds of change tests and local development ask for, answered the way the model is
 * told to: only the sections that change, each written out whole; wording that stands in for a protected trait refused
 * in notChanged; pay only where pay may change; a question back when the request is not one of these.
 */
function fakeRevise(req: StructuredRequest<unknown>): PacketRevision {
  const text = req.messages.map((m) => m.content).join("\n");
  const allowed = (text.match(/^Sections you may change: ([a-z, ]+) \(/m)?.[1] ?? "").split(", ").filter(Boolean);
  const request = text.match(/<request>\n([\s\S]*?)\n<\/request>/)?.[1]?.trim() ?? "";
  let packet: Partial<DraftRolePacket> = {};
  try { packet = JSON.parse(text.match(/Current packet \(JSON\): (\{[\s\S]*\})\n\n<request>/)?.[1] ?? "{}") as Partial<DraftRolePacket>; } catch { /* keep empty */ }
  const changes: PacketRevision["changes"] = {};
  const notChanged: PacketRevision["notChanged"] = [];
  const done: string[] = [];
  const clean = (s: string) => s.trim().replace(/^["']|["'.]+$/g, "").trim();
  const refuse = (words: string) => {
    const hit = screenCriterion(words);
    if (hit) notChanged.push({ request: words, reason: `${hit.reason} ${hit.alternative}` });
    return !!hit;
  };
  const unusedKey = (prefix: string, words: string, taken: string[]) => {
    let key = `${prefix}_${slug(words).slice(0, 30)}`;
    for (let n = 2; taken.includes(key); n += 1) key = `${prefix}_${slug(words).slice(0, 30)}_${n}`;
    return key;
  };
  const addMust = request.match(/\badd (?:a |another )?must[\s-]have:?\s*(.+)$/i) ?? request.match(/\bmake (.+?) a must[\s-]have\b/i);
  const takeOut = request.match(/\b(?:take out|remove|drop|delete)\s+(?:the\s+)?(?:must[\s-]have\s+|line\s+|sentence\s+|part\s+)?(?:about\s+|on\s+|saying\s+)?(.+)$/i);
  const rename = request.match(/\b(?:rename (?:the job|the role|it)|call (?:the job|the role|it)|change the (?:job )?title) to\s+(.+)$/i);
  const schedule = request.match(/\b(?:change|set|make) the schedule to\s+(.+)$/i);
  const tone = request.match(/\b(warmer|friendlier|more formal|more direct)\b/i);
  const question = request.match(/\badd (?:a |another )?(?:screening )?question:?\s*(.+)$/i);
  const pay = /\bpay\b|\bwage\b|\bsalary\b|\brate\b/i.test(request) ? request.match(/\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|to)\s*\$?\s?(\d[\d,]*(?:\.\d+)?)/i) : null;
  if (/\bdecision maker\b|\bwho decides\b|\bfinal say\b/i.test(request)) notChanged.push({ request, reason: "Who makes the final decision is chosen from your team in the editor." });
  else if (pay) {
    const min = Number(pay[1].replace(/,/g, ""));
    const max = Number(pay[2].replace(/,/g, ""));
    if (!allowed.includes("compensation") || !packet.compensation) notChanged.push({ request, reason: "Pay is set on the pay card." });
    else {
      changes.compensation = { ...packet.compensation, min: Math.min(min, max), max: Math.max(min, max), mid: Math.round((min + max) / 2), ceiling: Math.max(packet.compensation.ceiling, min, max) };
      done.push(`I changed the pay to ${money(Math.min(min, max))}–${money(Math.max(min, max))} ${per(packet.compensation.basis)}.`);
    }
  } else if (addMust && packet.requirements) {
    const words = clean(addMust[1]);
    if (!refuse(words)) {
      if (packet.requirements.mustHaves.length >= 6) notChanged.push({ request: words, reason: "There are six must-haves already, the most a role can have. Take one out first." });
      else {
        changes.requirements = { ...packet.requirements, mustHaves: [...packet.requirements.mustHaves, { key: unusedKey("mh", words, packet.requirements.mustHaves.map((m) => m.key)), text: words, rationale: "Added by the owner in the conversation", evidencedBy: ["resume", "screen"] }] };
        done.push(`I added a must-have: ${words}.`);
      }
    }
  } else if (question && packet.screening) {
    const words = clean(question[1]);
    if (!refuse(words)) {
      if (packet.screening.questions.length >= 12) notChanged.push({ request: words, reason: "There are twelve screening questions already, the most a role can have." });
      else {
        changes.screening = { ...packet.screening, questions: [...packet.screening.questions, { key: unusedKey("q", words, packet.screening.questions.map((q) => q.key)), question: /\?$/.test(words) ? words : `${words}?`, kind: "skills" }] };
        done.push(`I added a screening question: ${words}`);
      }
    }
  } else if (takeOut && packet.requirements && packet.description) {
    const target = normalizeCriterion(clean(takeOut[1]));
    const matches = (s: string) => { const t = normalizeCriterion(s); return !!target && (t.includes(target) || target.includes(t)); };
    const must = packet.requirements.mustHaves.filter((m) => !matches(m.text));
    const nice = packet.requirements.niceToHaves.filter((m) => !matches(m.text));
    const sentences = packet.description.publicJobDescription.match(/[^.!?]+[.!?]+\s*/g) ?? [packet.description.publicJobDescription];
    const kept = sentences.filter((s) => !matches(s)).join("").trim();
    if ((must.length > 0 && must.length < packet.requirements.mustHaves.length) || nice.length < packet.requirements.niceToHaves.length) {
      changes.requirements = { ...packet.requirements, mustHaves: must.length ? must : packet.requirements.mustHaves, niceToHaves: nice };
      done.push(`I took out "${clean(takeOut[1])}".`);
    } else if (kept.length >= 50 && kept !== packet.description.publicJobDescription.trim()) {
      changes.description = { ...packet.description, publicJobDescription: kept };
      done.push(`I took the line about "${clean(takeOut[1])}" out of the job description.`);
    }
  } else if (rename && packet.identity) {
    const words = clean(rename[1]);
    if (!refuse(words)) {
      changes.identity = { ...packet.identity, title: words };
      done.push(`I renamed the job to ${words}.`);
    }
  } else if (schedule && packet.identity) {
    const words = clean(schedule[1]);
    changes.identity = { ...packet.identity, schedule: words };
    done.push(`I changed the schedule to ${words}.`);
  } else if (tone && packet.communication) {
    const to = /formal/i.test(tone[1]) ? "formal" : /direct/i.test(tone[1]) ? "direct" : "warm";
    changes.communication = { ...packet.communication, tone: to };
    done.push(`I made the messages to candidates ${to === "warm" ? "warmer" : `more ${to}`}.`);
  } else if (/\bshort(?:er|en)\b/i.test(request) && packet.description) {
    const sentences = packet.description.publicJobDescription.match(/[^.!?]+[.!?]+\s*/g) ?? [];
    const shorter = sentences.slice(0, Math.max(3, Math.ceil(sentences.length / 2))).join("").trim();
    if (shorter.length >= 50 && shorter !== packet.description.publicJobDescription.trim()) {
      changes.description = { ...packet.description, publicJobDescription: shorter };
      done.push("I made the job description shorter.");
    }
  } else if (!refuse(request)) {
    return { summary: "I have not changed anything yet.", changes: {}, notChanged: [], question: "What would you like to change? For example: add a must-have, change the schedule, or rename the job." };
  }
  return { summary: done.length ? done.join(" ") : "I have not changed anything.", changes, notChanged };
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
