import type { EvidenceAssessment, IntakeFacts, IntakeTurn, ResumeExtraction, RolePacket, ScreenAssessment, ScreenProgress, ScreenTurn } from "@ros/contracts";
import type { FakeProvider, IntakeContext, StructuredRequest } from "@ros/ai";
import { redactProtected } from "./screening";

/**
 * Deterministic handlers for the fake AI provider. They exist so tests, evals, and local development run
 * without a model. They are heuristics, not intelligence, and the UI labels the provider as "fake".
 * Never used in production (the runtime refuses to boot with AI_PROVIDER=fake there).
 */
export function registerFakeHandlers(fake: FakeProvider): void {
  fake.register("intake.turn", (req) => fakeIntakeTurn(contextFrom(req)));
  fake.register("intake.compile", (req) => fakeCompile(contextFrom(req)));
  fake.register("resume.extract", (req) => fakeResumeExtract(req));
  fake.register("triage.assess", (req) => fakeTriageAssess(req));
  fake.register("screen.turn", (req) => fakeScreenTurn(req));
  fake.register("screen.assess", (req) => fakeScreenAssess(req));
}

/** The prompt renders `Facts established so far (JSON): ...` and the transcript; recover them from the request. */
function contextFrom(req: StructuredRequest<unknown>): { req: StructuredRequest<unknown>; facts: IntakeFacts; ownerMessages: string[]; playbookRoleTitle: string | null; companyName: string; benchmark: IntakeContext["benchmark"]; locationsText: string; vertical: string } {
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
    benchmark: benchMatch ? { metro: benchMatch[1].trim(), basis: benchMatch[2], p25: Number(benchMatch[3]), p50: Number(benchMatch[4]), p75: Number(benchMatch[5]), source: benchMatch[6].trim() } : null,
    locationsText: locMatch?.[1]?.trim() ?? "",
  };
}

const ILLEGAL: Array<{ pattern: RegExp; reason: string; alternative: string }> = [
  { pattern: /\b(under|younger than|below)\s+\d{2}\b|\brecent grads?\b|\byoung\b|\bdigital native/i, reason: "Age and proxies for age cannot be hiring criteria.", alternative: "Describe the energy or skills you need (for example, comfort with new software) and we will screen for that." },
  { pattern: /\bno (employment )?gaps?\b/i, reason: "Employment gaps are not a lawful or useful criterion.", alternative: "We will look at demonstrated skills and recent relevant experience instead." },
  { pattern: /\bnative (english )?speaker/i, reason: "Native-speaker requirements can discriminate by national origin.", alternative: "We can require the level of English proficiency the job actually needs, such as clear patient communication." },
  { pattern: /\b(no|without) (kids|children|family)\b|\bsingle\b|\bmarried\b/i, reason: "Family status cannot be a criterion.", alternative: "If the real need is schedule availability, we will ask every candidate about availability." },
  { pattern: /\bzip( ?code)?\b.*\bonly\b|\bonly\b.*\bzip( ?code)?\b/i, reason: "Zip-code restrictions are a proxy for protected characteristics and are prohibited in Illinois.", alternative: "We will ask whether candidates can reliably work at the location." },
];

function fakeIntakeTurn(c: ReturnType<typeof contextFrom>): IntakeTurn {
  const last = c.ownerMessages[c.ownerMessages.length - 1] ?? "";
  const all = c.ownerMessages.join("\n");
  const facts: IntakeFacts = { ...c.facts };

  if (!facts.title) {
    const t = c.playbookRoleTitle ?? all.match(/(?:hire|need|looking for)\s+(?:an?|the)?\s*([A-Za-z][A-Za-z /-]{3,50}?)(?=\s+(?:in|for|at|who|with|that|\.|,|$))/i)?.[1]?.trim();
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
  if (mh) facts.mustHaves = [...facts.mustHaves, ...mh[1].split(/;|,| and (?:be |have )?/).map((s) => s.trim()).filter(Boolean)];
  const nh = last.match(/nice[\s-]?to[\s-]?haves?\s*[:-]\s*([^\n]+)/i);
  if (nh) facts.niceToHaves = [...facts.niceToHaves, ...nh[1].split(/;|,/).map((s) => s.trim()).filter(Boolean)];
  const db = last.match(/deal[\s-]?breakers?\s*[:-]\s*([^\n]+)/i);
  if (db) facts.dealBreakers = [...facts.dealBreakers, ...db[1].split(/;|,/).map((s) => s.trim()).filter(Boolean)];

  const declinedNow: IntakeFacts["declinedCriteria"] = [];
  for (const rule of ILLEGAL) {
    const m = last.match(rule.pattern);
    if (m) declinedNow.push({ requested: m[0], reason: rule.reason, alternative: rule.alternative });
  }
  facts.declinedCriteria = [...facts.declinedCriteria, ...declinedNow];

  const missing: IntakeTurn["missingFacts"] = [];
  if (!facts.title) missing.push("title");
  if (!facts.locationText) missing.push("location");
  if (!facts.reason) missing.push("reason_for_hire");
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

  const questionFor: Record<string, string> = {
    title: "What is the job title, in your words?",
    location: "Which location is this for?",
    reason_for_hire: "Is this a new position, a replacement, or growth? If someone left, what did you learn from that?",
    compensation_range: "What pay range are you offering, and is that hourly or salary?",
    compensation_ceiling: "What is the absolute most you would pay for the right person? I will never propose above it.",
    must_haves: "What are the true must-haves, the things you would not hire without? I will keep it to six.",
    interviewers: "Who will interview, and who makes the final decision?",
    decision_maker: "Who makes the final hiring decision?",
    timeline: "When do you need them to start?",
    what_failure_looks_like: "A year from now, what would make you say this hire did not work out?",
    deal_breakers: "Anything that is a deal-breaker for you, in your own words?",
  };
  const priority = ["reason_for_hire", "compensation_range", "compensation_ceiling", "must_haves", "interviewers", "decision_maker", "timeline", "location", "title", "what_failure_looks_like", "deal_breakers"];
  // "Who will interview, and who decides?" already covers the decision maker; do not ask it twice.
  const askKeys = priority.filter((k) => missing.includes(k as IntakeTurn["missingFacts"][number])).filter((k, _i, arr) => !(k === "decision_maker" && arr.includes("interviewers")));
  const nextQuestions = askKeys.slice(0, 3).map((k) => questionFor[k]);
  const benchmarkMentioned = c.ownerMessages.length > 1; // the benchmark is stated once, on the first turn that has a range

  const lines: string[] = [];
  if (declinedNow.length) for (const d of declinedNow) lines.push(`I can't build "${d.requested}" into the requirements. ${d.reason} ${d.alternative}`);
  if (c.playbookRoleTitle && c.ownerMessages.length === 1) lines.push(`Got it. I'm using our ${c.vertical} playbook for a ${c.playbookRoleTitle}${facts.locationText ? ` in ${facts.locationText}` : ""}.`);
  if (c.benchmark && facts.compensationMin !== undefined && !benchmarkMentioned) {
    const below = facts.compensationMax !== undefined && facts.compensationMax < c.benchmark.p50;
    lines.push(`For reference, the market for ${c.benchmark.metro} runs about ${c.benchmark.p25}–${c.benchmark.p75} ${c.benchmark.basis === "hourly" ? "an hour" : "a year"} (midpoint ${c.benchmark.p50}; source: ${c.benchmark.source}).${below ? " Your range is below the midpoint, which may slow the search." : ""}`);
  }
  if (ready) lines.push(`I have enough to draft the role packet${missing.length ? `, with assumptions noted for: ${missing.map((m) => m.replace(/_/g, " ")).join(", ")}` : ""}. Say "draft it" or answer anything above first.`);
  else if (nextQuestions.length) lines.push(nextQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n"));
  return {
    assistantMessage: lines.join("\n\n") || "Tell me who you need to hire.",
    factsExtracted: facts,
    missingFacts: missing,
    nextQuestions: ready ? [] : nextQuestions,
    readyToCompile: ready,
    confidence: essentials ? "medium" : "low",
  };
}

/** The playbook block the prompt renders: "Matched playbook role: T. Summary: ... Typical eligibility: type: q | ... Common qualifications: ... Competencies: Name (def); ... Screening questions: q | q. Interview plan: title (30 min, video); ... Red flags..." */
function playbookRoleFrom(req: StructuredRequest<unknown>): { competencies: Array<{ key: string; name: string; definition: string }>; eligibility: Array<{ type: string; question: string }>; questions: string[]; interviews: Array<{ title: string; minutes: number; format: string }> } {
  const sys = req.system.map((b) => b.text).join("\n");
  const block = sys.match(/Matched playbook role: ([\s\S]*?)(?:\n|$)/)?.[1] ?? "";
  const seg = (start: string, end: string) => { const i = block.indexOf(start); if (i < 0) return ""; const rest = block.slice(i + start.length); const j = rest.indexOf(end); return (j < 0 ? rest : rest.slice(0, j)).trim(); };
  const competencies = seg("Competencies: ", ". Screening questions:").split("; ").map((c) => c.match(/^(.*?) \((.*)\)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => ({ key: slug(m[1]), name: m[1].trim(), definition: m[2].trim() }));
  const eligibility = seg("Typical eligibility: ", ". Common qualifications:").split(" | ").map((e) => e.match(/^([a-z_]+): (.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => ({ type: m[1], question: m[2].trim() }));
  const questions = seg("Screening questions: ", ". Interview plan:").split(" | ").map((q) => q.trim()).filter(Boolean);
  const interviews = seg("Interview plan: ", ". Red flags").split("; ").map((r) => r.match(/^(.*?) \((\d+) min, ([a-z_]+)\)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => ({ title: m[1].trim(), minutes: Number(m[2]), format: m[3] }));
  return { competencies, eligibility, questions, interviews };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "item";
}

function fakeCompile(c: ReturnType<typeof contextFrom>): RolePacket {
  const f = c.facts;
  const title = f.title ?? c.playbookRoleTitle ?? "New hire";
  const basis = (f.compensationBasis as "hourly" | "salary" | undefined) ?? (c.benchmark?.basis as "hourly" | "salary" | undefined) ?? "hourly";
  const min = f.compensationMin ?? c.benchmark?.p25 ?? (basis === "hourly" ? 20 : 50000);
  const max = f.compensationMax ?? c.benchmark?.p75 ?? (basis === "hourly" ? 30 : 70000);
  const [locCity, locRegion] = (f.locationText ?? c.locationsText.split(";")[0] ?? "").split(",").map((s) => s.trim());
  const assumptions: string[] = [];
  const mustHaves = (f.mustHaves.length ? f.mustHaves : [`${title} experience relevant to a ${c.vertical} setting`, "Reliable availability for the posted schedule"]).slice(0, 6);
  if (!f.mustHaves.length) assumptions.push("Must-haves were not stated; drafted from the playbook and should be reviewed.");
  if (!f.reason) assumptions.push("Reason for the hire was not stated; assumed growth.");
  if (!f.interviewers.length) assumptions.push("Interviewers were not named; assumed the owner interviews.");
  if (f.compensationCeiling === undefined) assumptions.push(`Ceiling assumed equal to the top of the range (${max}).`);
  const isDental = c.vertical === "dental";
  const rdh = /hygien/i.test(title);
  const pbRole = playbookRoleFrom(c.req);
  const eligibility: RolePacket["requirements"]["eligibility"] = [];
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
  const competencies: RolePacket["competencies"] = rdh
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
  const kindOf = (q: string): RolePacket["screening"]["questions"][number]["kind"] => /salary|pay |earn|range are you|compensation/i.test(q) ? "compensation" : /available|start|schedule|work model/i.test(q) ? "availability" : /looking for in your next/i.test(q) ? "motivation" : /tell me about|describe|walk me through|give an example/i.test(q) ? "behavioral" : "skills";
  const playbookQuestions: RolePacket["screening"]["questions"] = !rdh && pbRole.questions.length >= 3
    ? pbRole.questions.slice(0, 10).map((q, i) => ({ key: slug(q.split(/[,:?]/)[0].split(" ").slice(0, 4).join(" ")) || `q${i + 1}`, question: q, kind: kindOf(q), competencyKey: competencies[i % competencies.length]?.key }))
    : [];
  const dedupedQuestions = playbookQuestions.filter((q, i, arr) => arr.findIndex((x) => x.key === q.key) === i);
  const description = `${c.companyName} is hiring a ${title}${locCity ? ` in ${locCity}${locRegion ? `, ${locRegion}` : ""}` : ""}. ${f.reason === "replacement" ? "We are filling an open chair on a team that values consistency and kindness." : "Our team is growing and we need someone who takes pride in careful, friendly work."} You will ${rdh ? "provide preventive care, periodontal therapy, and patient education for a loyal patient base, working alongside a dentist who respects your judgment" : `own ${title.toLowerCase()} outcomes end to end, work directly with the founder and a small team that moves quickly, and see the results of your decisions in the numbers`}. The schedule is ${f.employmentType === "part_time" ? "part time" : "full time"}${f.schedule ? ` (${f.schedule})` : ""}. Pay is ${basis === "hourly" ? `$${min}–$${max} an hour` : `$${min.toLocaleString()}–$${max.toLocaleString()} a year`} depending on experience${f.benefits ? `, plus ${f.benefits}` : ""}. We respond to every applicant within a day, keep the process short, and tell you where you stand at each step.`;
  return {
    schemaVersion: 1,
    identity: { title, department: undefined, locations: [{ city: locCity || undefined, region: locRegion || undefined, country: "US" }], employmentType: (f.employmentType as RolePacket["identity"]["employmentType"]) ?? "full_time", schedule: f.schedule, remotePolicy: f.remotePolicy === "hybrid" || f.remotePolicy === "remote" ? f.remotePolicy : "onsite" },
    business: { reason: (f.reason as RolePacket["business"]["reason"]) ?? "growth", reasonDetail: f.reasonDetail, timeline: { targetStartDate: f.targetStartDate, urgency: f.targetStartDate ? "high" : "normal", inactivityDays: 10 } },
    compensation: { basis, currency: "USD", min, mid: Math.round((min + max) / 2), max, ceiling: f.compensationCeiling ?? max, bonus: undefined, benefitsSummary: f.benefits, discloseRange: true, sources: [...(c.benchmark ? [{ name: c.benchmark.source, detail: `${c.benchmark.metro}: p25 ${c.benchmark.p25}, p50 ${c.benchmark.p50}, p75 ${c.benchmark.p75}` }] : []), { name: "owner-stated", detail: `${min}–${max} ${basis}` }], ownerStated: f.compensationMin !== undefined },
    description: { publicJobDescription: description, internalNotes: f.whatFailureLooksLike ? `What failure looks like: ${f.whatFailureLooksLike}` : undefined },
    requirements: {
      mustHaves: mustHaves.map((m, i) => ({ key: `mh_${i + 1}_${slug(m)}`, text: m, rationale: "Stated by the owner as a must-have", evidencedBy: ["resume", "screen"] })),
      niceToHaves: f.niceToHaves.map((m, i) => ({ key: `nh_${i + 1}_${slug(m)}`, text: m, rationale: "Nice to have per the owner", evidencedBy: ["resume", "screen"] })),
      eligibility,
    },
    competencies,
    evaluation: { criteria: ["Evidence for each must-have", "Competency indicators observed in screen and interviews", "Availability matches the schedule"], redFlags: ["Cannot confirm required license", "Availability does not match the schedule"] },
    screening: {
      questions: dedupedQuestions.length >= 3 ? dedupedQuestions : [
        ...(rdh ? [{ key: "license_confirm", question: "Can you confirm your RDH license state and whether it is currently active?", kind: "eligibility" as const }] : []),
        { key: "experience", question: `Tell me about your most recent ${title} work and what a typical day looked like.`, kind: "skills" as const, competencyKey: competencies[0].key },
        { key: "hard_moment", question: "Tell me about a difficult moment with a customer or patient and what you did.", kind: "behavioral" as const, competencyKey: competencies[1].key },
        { key: "availability", question: "Which days and hours are you available, and when could you start?", kind: "availability" as const },
        { key: "pay", question: `What ${basis === "hourly" ? "hourly" : "salary"} range are you looking for?`, kind: "compensation" as const },
        { key: "why", question: "What are you looking for in your next role?", kind: "motivation" as const },
      ],
      maxMinutes: 15,
    },
    interviews: {
      plan: !rdh && pbRole.interviews.length >= 1
        ? pbRole.interviews.slice(0, 5).map((r, i, arr) => ({ key: slug(r.title) || `round_${i + 1}`, title: r.title, purpose: i === 0 ? "Fit, results, and the candidate's questions." : "See how they think about our real problems.", durationMinutes: Math.min(240, Math.max(15, r.minutes)), format: (["video", "phone", "onsite", "working_session"].includes(r.format) ? r.format : "video") as RolePacket["interviews"]["plan"][number]["format"], interviewerUserIds: [], interviewerRoles: f.interviewers.length ? f.interviewers : ["owner"], competencyKeys: competencies.filter((_, ci) => ci % arr.length === i).map((x) => x.key).concat(i === 0 ? [competencies[0].key] : []).filter((k, ki, ks) => ks.indexOf(k) === ki), suggestedQuestions: [] }))
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

  const lineFor = (tks: string[]) => lines.find((l) => tks.some((t) => l.toLowerCase().includes(t)));
  const strengths: EvidenceAssessment["strengths"] = [];
  const unknowns: EvidenceAssessment["unknowns"] = [];
  const requirementFindings: EvidenceAssessment["requirementFindings"] = mustHaves.map((m) => {
    const tks = tokens(m.text.replace(/\(.*\)$/, ""));
    const hits = tks.filter((t) => lower.includes(t));
    const license = /licen/i.test(m.text) && (extraction.licenses?.length || /\b(rdh|rda|license|licensed)\b/i.test(text));
    const met = hits.length >= 2 || license ? "yes" : hits.length === 1 ? "partially" : "unknown";
    const quote = lineFor(hits.length ? hits : tks);
    if (met === "yes" && quote) strengths.push({ claim: `Shows ${m.text.replace(/\(.*\)$/, "").trim()}`, evidence: { source, quote } });
    if (met === "unknown") unknowns.push({ question: `Can you tell me about your experience with ${m.text.replace(/\(.*\)$/, "").trim().toLowerCase()}?`, whyItMatters: "It is a must-have for this role and the application does not show it." });
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
  const noText = !text.trim();
  const overall: EvidenceAssessment["overall"] = noText ? "unknown" : mustHaves.length && yes === mustHaves.length ? "strong" : yes + partial > 0 ? "potential" : "unknown";
  const recommendation: EvidenceAssessment["recommendation"] = noText ? "review_manually" : eligibilityFailed ? "review_manually" : "screen";
  const concerns: EvidenceAssessment["concerns"] = [];
  if (!noText && yes + partial === 0 && lines[0]) concerns.push({ claim: "No must-have is evidenced in the resume or application text", evidence: { source, quote: lines[0] } });
  const summary = noText
    ? "No resume text or description was available, so nothing can be said yet; a person should open the file or ask the candidate."
    : `${yes} of ${mustHaves.length} must-haves evidenced${partial ? `, ${partial} partially` : ""}; ${competencyFindings.filter((c) => c.finding === "evidenced").length} of ${competencies.length} competencies evidenced. ${extraction.positions?.length ? `Most recent work: ${extraction.positions[0].title}.` : ""}`.trim();
  return {
    overall,
    confidence: noText ? "low" : yes >= 1 ? "medium" : "low",
    summary,
    strengths,
    concerns,
    unknowns,
    competencyFindings,
    requirementFindings,
    anomalies,
    secondaryScore: mustHaves.length ? Math.round(((yes + partial * 0.5) / mustHaves.length) * 100) : undefined,
    recommendation,
    rationale: recommendation === "screen" ? "Eligible, with relevant evidence for the must-haves; a screen will settle the unknowns." : noText ? "There is nothing to assess against; a human should look." : "Eligibility was not met; the owner reviews before anything else happens.",
  };
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

function fakeScreenTurn(req: StructuredRequest<unknown>): ScreenTurn {
  const s = parseScreenSystem(req);
  const user = req.messages[0]?.content ?? "";
  const latestRaw = user.match(/Candidate's latest message: ([\s\S]*?)\n\nProduce the next turn\./)?.[1]?.trim() ?? "(none)";
  const latest = latestRaw === "(none)" ? null : latestRaw;
  const asked = new Set(s.progress.askedKeys);
  const current = s.progress.currentQuestionKey;
  const remaining = s.questions.filter((q) => !asked.has(q.key));
  const base: ScreenTurn = { messageToCandidate: "", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };
  const disclosure = `Hi ${s.name}, this is the hiring team at ${s.company}, using an AI assistant for a short screening for the ${s.role} role (about ${s.minutes} minutes, one question at a time). Reply HUMAN at any time to reach a person.`;
  if (latest === null) {
    const first = remaining[0];
    return { ...base, messageToCandidate: first ? `${disclosure}\n\nFirst question: ${first.question}` : `${disclosure}\n\nThere is nothing more to ask; the team will be in touch.`, questionKey: first?.key ?? null, done: !first };
  }
  if (/\b(human|person|someone real)\b/i.test(latest) && !/\bnot\b/i.test(latest)) {
    return { ...base, messageToCandidate: `Understood. A person from ${s.company} will follow up with you.`, humanRequested: true };
  }
  const currentQ = s.questions.find((q) => q.key === current) ?? null;
  const asksAboutPay = /\?/.test(latest) && /\b(pay|salary|rate|per hour|an hour|hourly|wage|\$)\b/i.test(latest) && currentQ?.kind !== "compensation";
  if (asksAboutPay) {
    const answer = s.pay ? `The posted range is $${s.pay.min} to $${s.pay.max} ${s.pay.basis === "hourly" ? "an hour" : "a year"}, depending on experience.` : "A person can discuss pay with you; I can only share what is posted.";
    return { ...base, messageToCandidate: `${answer} ${currentQ ? `Back to my question: ${currentQ.question}` : ""}`.trim(), candidateAskedAbout: "pay", questionKey: null };
  }
  const confused = /\?{2,}|confus|what do you mean|huh\b|don't understand|dont understand/i.test(latest);
  let answerRecorded: ScreenTurn["answerRecorded"] = null;
  let followUpReason: string | null = null;
  if (currentQ) {
    const complete = latest.trim().length >= 8 || /^(yes|no)\b/i.test(latest.trim());
    const followUpsSoFar = s.progress.followUps[currentQ.key] ?? 0;
    if (!complete && followUpsSoFar < 1 && !confused) {
      followUpReason = "answer too short to establish anything";
      return { ...base, messageToCandidate: "Could you say a bit more about that? A sentence or two is plenty.", followUpReason, answerRecorded: null, sentiment: "fine" };
    }
    answerRecorded = { questionKey: currentQ.key, answer: redactProtected(latest), complete };
  }
  if (confused) {
    const msg = currentQ ? `No problem. In plain terms: ${currentQ.question} If you would rather talk to a person, reply HUMAN.` : "No problem. If you would rather talk to a person, reply HUMAN.";
    return { ...base, messageToCandidate: msg, sentiment: "confused", answerRecorded: null, questionKey: null, followUpReason: "candidate seemed confused" };
  }
  const next = remaining.find((q) => q.key !== current);
  if (!next) {
    return { ...base, answerRecorded, done: true, messageToCandidate: `Thanks ${s.name}, that is everything I needed. The hiring team at ${s.company} will review and you will hear back within a few days. Reply HUMAN at any time to reach a person.` };
  }
  return { ...base, answerRecorded, questionKey: next.key, messageToCandidate: `Thanks. ${next.question}` };
}

const trimDot = (t: string) => t.trim().replace(/[.!]+$/, "");

function fakeScreenAssess(req: StructuredRequest<unknown>): ScreenAssessment {
  const s = parseScreenSystem(req);
  const user = req.messages[0]?.content ?? "";
  let answers: Record<string, string> = {};
  try { answers = JSON.parse(user.match(/Recorded answers \(JSON\): (\{[\s\S]*?\})\nProgress/)?.[1] ?? "{}"); } catch { /* keep */ }
  const questionFindings: ScreenAssessment["questionFindings"] = s.questions.map((q) => {
    const a = answers[q.key];
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
  const answered = questionFindings.filter((f) => f.answered).length;
  const strengths: ScreenAssessment["strengths"] = questionFindings.filter((f) => f.answered && f.evidence && (s.questions.find((q) => q.key === f.questionKey)?.kind === "skills" || s.questions.find((q) => q.key === f.questionKey)?.kind === "behavioral")).slice(0, 3).map((f) => { const q = s.questions.find((x) => x.key === f.questionKey); return { claim: `Gave a concrete answer ${q?.kind === "behavioral" ? "about a difficult moment" : "about recent work"}`, evidence: f.evidence! }; });
  const concerns: ScreenAssessment["concerns"] = [];
  if (withinRange === "above" && payAnswer) concerns.push({ claim: `Pay expectation (${payAnswer.slice(0, 40)}) is above the posted range`, evidence: { source: "screen", quote: payAnswer } });
  const noElig = eligibilityConfirmations.find((e) => e.confirmed === "no");
  if (noElig?.quote) concerns.push({ claim: "Did not confirm a required eligibility item", evidence: { source: "screen", quote: noElig.quote } });
  const unknowns = questionFindings.filter((f) => !f.answered).map((f) => ({ question: s.questions.find((q) => q.key === f.questionKey)?.question ?? f.questionKey, whyItMatters: "Not covered in the screen." }));
  const recommendation: ScreenAssessment["recommendation"] = noElig ? "decline_recommended" : withinRange === "above" ? "hold" : answered >= Math.max(1, s.questions.length - 1) ? (strengths.length >= 2 ? "strong_interview" : "interview") : answered > 0 ? "interview" : "hold";
  const overall: ScreenAssessment["overall"] = recommendation === "strong_interview" ? "strong" : recommendation === "interview" ? "potential" : recommendation === "hold" ? "unknown" : "weak";
  return {
    overall,
    confidence: answered >= s.questions.length - 1 ? "medium" : "low",
    summary: `${answered} of ${s.questions.length} questions answered.${payAnswer ? ` Pay expectation: ${trimDot(payAnswer.slice(0, 40))} (${withinRange === "yes" ? "within range" : withinRange}).` : ""}${availAnswer ? ` Availability: ${trimDot(availAnswer.slice(0, 60))}.` : ""}`,
    strengths,
    concerns,
    unknowns,
    competencyFindings,
    requirementFindings: [],
    anomalies: [],
    questionFindings,
    compensationExpectation: { stated: payAnswer, withinRange },
    availability: { stated: availAnswer, matchesSchedule: availAnswer ? (/\b(yes|any|flexible|weekdays|full)\b/i.test(availAnswer) ? "yes" : "partially") : "unknown" },
    eligibilityConfirmations,
    recommendation,
    rationale: recommendation === "decline_recommended" ? "The candidate's own answer did not confirm a required eligibility item; a person decides." : recommendation === "hold" ? (withinRange === "above" ? "Pay expectations are above the posted range; worth a conversation before an interview." : "Too few answers to recommend an interview.") : `Answered the screen with ${strengths.length} concrete example${strengths.length === 1 ? "" : "s"}; logistics look workable.`,
  };
}
