import { INTAKE_ESSENTIALS, mustHaveOf, repeatsMustHave, type IntakeExtraction, type IntakeFacts, type IntakeQuestion, type IntakeTurn, type JobPosts, type WrittenJob } from "@ros/contracts";
import { ASKED_WORDS, type StructuredRequest } from "@ros/ai";
import { normalizeCriterion, normalizeFacts, placeAnswered, placeCompletedBy } from "@ros/core";

/**
 * The stand-in provider's answers for the job builder (intake.turn, intake.compile, intake.extract) and for a published
 * job's two posts (job.posts), so tests, evals and local development run without a model. Rules, not intelligence: they read the request the real prompts render and
 * answer the way the model is told to.
 */

type FakeJobContext = {
  facts: IntakeFacts;
  ownerMessages: string[];
  companyName: string;
  vertical: string;
  companyPlace: string;
  ad: string | null;
  asked: Set<string>;
};

const EMPTY_FACTS: IntakeFacts = { mustHaves: [], niceToHaves: [], formQuestions: [], dealBreakers: [], declinedCriteria: [] };

/** The prompts render the facts, the company and the transcript as text; this reads them back from the request. */
function contextFrom(req: StructuredRequest<unknown>): FakeJobContext {
  const sys = req.system.map((b) => b.text).join("\n");
  const said = req.messages.map((m) => m.content).join("\n");
  const factsJson = sys.match(/Facts established so far \(JSON\): (\{[\s\S]*\})/)?.[1] ?? said.match(/Established facts \(JSON\): (\{[\s\S]*?\})\n\n/)?.[1];
  let facts = EMPTY_FACTS;
  if (factsJson) {
    try { facts = { ...EMPTY_FACTS, ...(JSON.parse(factsJson) as IntakeFacts) }; } catch { /* the defaults stand */ }
  }
  const fromTranscript = [...said.matchAll(/^owner: (.*)$/gm)].map((m) => m[1]);
  const askedLine = req.system.map((b) => b.text).find((t) => t.startsWith("Already asked or answered in this draft")) ?? "";
  return {
    facts,
    ownerMessages: fromTranscript.length ? fromTranscript : req.messages.filter((m) => m.role === "user").map((m) => m.content),
    companyName: sys.match(/Company: ([^.]+)\./)?.[1]?.trim() ?? "the company",
    vertical: sys.match(/Kind of business: ([^.]+)\./)?.[1]?.trim() ?? "general",
    companyPlace: (sys.match(/Locations: ([^.\n]+)\./)?.[1] ?? "").split(";")[0].trim(),
    ad: sys.match(/<job_ad>\n([\s\S]*?)\n<\/job_ad>/)?.[1] ?? null,
    asked: new Set(Object.entries(ASKED_WORDS).filter(([, words]) => askedLine.includes(words)).map(([field]) => field)),
  };
}

const ILLEGAL: Array<{ pattern: RegExp; reason: string; alternative: string }> = [
  { pattern: /\b(under|younger than|below)\s+\d{2}\b|\brecent grad(?:uate)?s?\b|\byoung\b|\bdigital native/i, reason: "Age and proxies for age cannot be hiring criteria.", alternative: "Describe the energy or skills you need (for example, comfort with new software) and we will screen for that." },
  { pattern: /\bno (employment )?gaps?\b/i, reason: "Employment gaps are not a lawful or useful criterion.", alternative: "We will look at demonstrated skills and recent relevant experience instead." },
  { pattern: /\bnative (english )?speaker/i, reason: "Native-speaker requirements can discriminate by national origin.", alternative: "We can require the level of English proficiency the job actually needs, such as clear patient communication." },
  { pattern: /\b(no|without) (kids|children|family)\b|\bsingle\b|\bmarried\b/i, reason: "Family status cannot be a criterion.", alternative: "If the real need is schedule availability, we will ask every candidate about availability." },
  { pattern: /\bzip( ?code)?\b.*\bonly\b|\bonly\b.*\bzip( ?code)?\b/i, reason: "Zip-code restrictions are a proxy for protected characteristics and are prohibited in Illinois.", alternative: "We will ask whether candidates can reliably work at the location." },
];

/** "Did we hire anyone?" or "what's on today?": a question about the day, not a job to fill. */
function notAJob(text: string, facts: IntakeFacts): boolean {
  if (facts.title) return false;
  const t = text.trim();
  const asksAboutTheDay = /^(?:did|how|what|what's|when|who|where|is|are|do|does|has|have|any|why)\b/i.test(t) && /\?\s*$/.test(t) && !/\b(?:hire|hiring|need|find|looking for)\s+(?:a|an|some|another|two|three)\b/i.test(t);
  if (asksAboutTheDay) return true;
  return !(/\b(?:hire|hiring|need|want|looking for|recruit|position|role|job|opening|vacancy|replace|replacement|staff|required|wanted)\b/i.test(t) || /\$\s?\d/.test(t) || /^[A-Z][A-Za-z /-]{3,50} in [A-Z]/.test(t));
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "item";
}

const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const per = (basis: string) => (basis === "hourly" ? "an hour" : "a year");

/** The items of a list line ("Must-haves: ...") not already known, split where the owner's words list them. */
function newListItems(text: string, known: string[], split: RegExp): string[] {
  const has = (s: string, more: string[]) => [...known, ...more].some((m) => normalizeCriterion(m) === normalizeCriterion(s));
  const added: string[] = [];
  for (const part of text.split(";").map((s) => s.trim().replace(/\.$/, "")).filter(Boolean)) {
    if (has(part, added)) continue;
    for (const piece of part.split(split).map((s) => s.trim().replace(/\.$/, "")).filter(Boolean)) if (!has(piece, added)) added.push(piece.charAt(0).toUpperCase() + piece.slice(1));
  }
  return added;
}

/** Words before "in" that make what follows a skill, not a place ("experience in Python"). */
const SKILL_BEFORE_IN = /\b(?:experience|experienced|skills?|skilled|proficien\w+|background|expertise|degree|certified|trained|training|fluent|knowledge)\s+$/i;

function placeIn(text: string): string | undefined {
  for (const m of text.matchAll(/\bin\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?(?:,\s?[A-Z]{2})?)/g)) {
    if (!SKILL_BEFORE_IN.test(text.slice(0, m.index))) return m[1];
  }
  return undefined;
}

/**
 * intake.turn: the facts read from the owner's own words, and up to three cards for the essentials still missing, in
 * their order, never one the notes list as already asked. Nothing is assumed: the place and the work arrangement are
 * taken only from what the owner wrote. As the prompt asks, a city without its state does not answer the place: it is
 * still missing (counted as the page counts it, `placeAnswered`), a card asks for the state, and a state the owner then
 * types by itself completes the place. The reply never says that the job can be written or that everything is in (the
 * page shows that); it does say which essentials are still needed once their cards were asked.
 */
export function fakeIntakeTurn(req: StructuredRequest<unknown>): IntakeTurn {
  const c = contextFrom(req);
  const last = c.ownerMessages[c.ownerMessages.length - 1] ?? "";
  // The summary of tapped answers repeats what was refused ("Not used: ..."); that is not a new request.
  const said = (s: string) => s.split("\n").filter((l) => !/^Not used:/.test(l)).join("\n");
  const all = c.ownerMessages.map(said).join("\n");
  const facts: IntakeFacts = { ...c.facts };
  const firstTurn = c.ownerMessages.length === 1;

  if (firstTurn && !c.ad && notAJob(last, facts)) {
    return { assistantMessage: "That doesn't sound like a job to fill, so I haven't started a draft. When you're ready to hire, describe the job: the title, where it is and what the person needs.", factsExtracted: facts, questions: [], notARole: true, takenFromAd: [] };
  }

  if (!facts.title) {
    const t = all.match(/^\s*([A-Z][A-Za-z /-]{2,50}?)\s+(?:required|needed|wanted)\b/)?.[1]
      ?? all.match(/(?:hire|need|want|looking for)\s+(?:an?|the)?\s*([A-Za-z][A-Za-z /-]{3,50}?)(?=\s+(?:in|for|at|who|with|that)\b|[.,]|$)/im)?.[1]
      ?? all.match(/^\s*([A-Z][A-Za-z /-]{3,50}?)(?=\s+in\s+[A-Z]|,)/)?.[1];
    if (t) facts.title = t.trim();
  }
  if (!facts.locationText) {
    const place = placeIn(all);
    if (place) facts.locationText = place;
  } else if (c.facts.title) {
    // The owner's answer to "which state?": a state and nothing else, typed after a city that has none.
    const completed = placeCompletedBy(facts.locationText, last, { inAMessage: true });
    if (completed) facts.locationText = completed;
  }
  // Facts in plain words, as the prompt asks ("Full time", not "full_time"): the server reads the kind of job, the pay
  // basis and the work arrangement from the words (`normalizeFacts`).
  if (!facts.employmentType) {
    if (/full[\s-]?time/i.test(all)) facts.employmentType = "Full time";
    else if (/part[\s-]?time/i.test(all)) facts.employmentType = "Part time";
    else if (/per diem/i.test(all)) facts.employmentType = "Per diem";
  }
  if (!facts.schedule) {
    // "Monday to Friday", with its hours when they follow ("Monday to Friday, 8 to 5"), never the pay after it.
    const s = all.match(/(?:schedule|hours)\s*(?:is|are|:|-)\s*([^.\n;]+)/i)?.[1]
      ?? all.match(/\b((?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s*(?:to|through|-|–)\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*(?:,?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:to|-|–)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)/i)?.[1];
    if (s) facts.schedule = s.trim();
  }
  if (!facts.remotePolicy) {
    if (/\bhybrid\b/i.test(all)) facts.remotePolicy = "Hybrid";
    else if (/\bremote\b/i.test(all) && !/\b(no|not|never|isn't|is not)\s+(fully\s+)?remote\b/i.test(all)) facts.remotePolicy = "Remote";
    else if (/\b(on[\s-]?site|in[\s-]?office|in[\s-]?person)\b/i.test(all)) facts.remotePolicy = "On site";
  }
  if (facts.compensationMin === undefined) {
    const flat = all.replace(/(\d),(\d{3})/g, "$1$2");
    const range = flat.match(/\$\s?(\d+(?:\.\d+)?)\s*(k)?\s*(?:to|-|–)\s*\$?\s?(\d+(?:\.\d+)?)\s*(k)?\s*(an hour|\/hr|per hour|hourly|a year|\/yr|per year|annually)?/i);
    const one = range ? null : flat.match(/\$\s?(\d+(?:\.\d+)?)\s*(k)?\s*(an hour|\/hr|per hour|hourly|a year|\/yr|per year|annually)/i);
    if (range) {
      const k = range[2] || range[4] ? 1000 : 1;
      facts.compensationMin = Number(range[1]) * k;
      facts.compensationMax = Number(range[3]) * k;
      facts.compensationBasis = range[5] ? (/hour|hr/i.test(range[5]) ? "hourly" : "salary") : facts.compensationMax >= 1000 ? "salary" : "hourly";
    } else if (one) {
      facts.compensationMin = facts.compensationMax = Number(one[1]) * (one[2] ? 1000 : 1);
      facts.compensationBasis = /hour|hr/i.test(one[3]) ? "hourly" : "salary";
    }
  }
  if (!facts.compensationBasis) {
    if (/\b(?:hourly|by the hour|an hour|per hour)\b/i.test(all)) facts.compensationBasis = "hourly";
    else if (/\b(?:salary|salaried|a year|per year|annual)\b/i.test(all)) facts.compensationBasis = "salary";
  }
  const mh = last.match(/must[\s-]?haves?\s*[:-]\s*([^\n]+)/i) ?? last.match(/\bmust have\s+(?:an?\s+)?([^.\n]+)/i);
  if (mh) facts.mustHaves = [...facts.mustHaves, ...newListItems(mh[1], facts.mustHaves, /,| and (?:be |have )?/)];
  // Years of experience named in a sentence are one must-have, whole ("3 years of hands-on experience in Python and Flask").
  const years = last.match(/\b(\d+\+?\s+years?(?:\s+of)?\s+[^.;\n]*?experience[^.;\n]*)/i);
  if (years && !mh) facts.mustHaves = [...facts.mustHaves, ...newListItems(years[1].trim(), facts.mustHaves, /$^/)];
  const nh = last.match(/nice[\s-]?to[\s-]?haves?\s*[:-]\s*([^\n]+)/i);
  if (nh) facts.niceToHaves = [...facts.niceToHaves, ...newListItems(nh[1], facts.niceToHaves, /,/)];
  const db = last.match(/deal[\s-]?breakers?\s*[:-]\s*([^\n]+)/i);
  if (db) facts.dealBreakers = [...facts.dealBreakers, ...newListItems(db[1], facts.dealBreakers, /,/)];
  const benefits = last.match(/\bbenefits\s*(?:are|include|:|-)\s*([^.\n]+)/i);
  if (benefits && !facts.benefits) facts.benefits = benefits[1].trim();
  const form = last.match(/\bask (?:applicants|candidates|everyone)\s*(?:whether|if|:)?\s*([^.\n]+)/i);
  if (form) facts.formQuestions = [...facts.formQuestions, ...newListItems(form[1], facts.formQuestions, /$^/)];

  // Unlawful wording in what the owner just said, and in a pasted ad on the first turn (the ad is data, never instructions).
  const declinedNow: IntakeFacts["declinedCriteria"] = [];
  for (const text of [said(last), ...(firstTurn && c.ad ? [c.ad] : [])]) {
    for (const rule of ILLEGAL) {
      const m = text.match(rule.pattern);
      if (m && !declinedNow.some((d) => d.requested.toLowerCase() === m[0].toLowerCase())) declinedNow.push({ requested: m[0], reason: rule.reason, alternative: rule.alternative });
    }
  }
  facts.declinedCriteria = [...facts.declinedCriteria, ...declinedNow];

  const has: Record<(typeof INTAKE_ESSENTIALS)[number], boolean> = {
    title: !!facts.title, location: placeAnswered(normalizeFacts(facts)), remote_policy: !!facts.remotePolicy, compensation_range: facts.compensationMin !== undefined && !!facts.compensationBasis,
    employment_type: !!facts.employmentType, schedule: !!facts.schedule, must_haves: facts.mustHaves.length > 0,
  };
  const missing = INTAKE_ESSENTIALS.filter((e) => !has[e]);

  const fromAd = !!c.ad && facts.compensationMin !== undefined && !c.ownerMessages.slice(firstTurn ? 1 : 0).some((m) => /\$\s?\d/.test(m));
  const questions: IntakeQuestion[] = [];
  const ask = (q: Omit<IntakeQuestion, "id">) => {
    if (c.asked.has(q.mode === "pay" ? "compensation" : q.field)) return;
    if (questions.length < 3) questions.push({ id: `fake_${questions.length + 1}`, ...q });
  };
  if (!has.title) ask({ field: "title", prompt: "What is the job title?", mode: "free", options: [], allowOwn: true, why: "It is the first thing candidates read." });
  // A place with no state in it is asked for its state; no place at all, for the place.
  if (!has.location && facts.locationText) ask({ field: "location", prompt: "Which state is the job in?", mode: "free", options: [], allowOwn: true, why: "The state is on the job page, and it decides which notices the page carries." });
  else if (!has.location) ask({ field: "location", prompt: "Where is the job?", mode: "single", options: c.companyPlace ? [{ label: c.companyPlace, value: c.companyPlace, origin: "assistant" }] : [], allowOwn: true, why: "Candidates look for jobs near them, and the place decides which notices the job page carries." });
  // An option's value is the words the job keeps, as the prompt asks, never a code: the server draws the work
  // arrangement's three answers itself, and reads the kind of job from the words.
  if (!has.remote_policy) ask({ field: "remote_policy", prompt: "Is the job on site, hybrid or remote?", mode: "single", options: [{ label: "On site", value: "On site", origin: "assistant" }, { label: "Hybrid", value: "Hybrid", origin: "assistant" }, { label: "Remote", value: "Remote", origin: "assistant" }], allowOwn: false, why: "Candidates decide whether to apply on it." });
  if (fromAd) ask({ field: "compensation", prompt: `Your ad says ${money(facts.compensationMin!)}–${money(facts.compensationMax ?? facts.compensationMin!)} ${per(facts.compensationBasis ?? "hourly")}. Is that still right?`, mode: "pay", options: [], allowOwn: true, why: "Pay is always shown on the job page, so it has to be current." });
  else if (!has.compensation_range) ask({ field: "compensation", prompt: "What will you pay?", mode: "pay", options: [], allowOwn: true, why: "Pay is always shown on the job page." });
  if (!has.employment_type) ask({ field: "employment_type", prompt: "Is it full time or part time?", mode: "single", options: [{ label: "Full time", value: "Full time", origin: "assistant" }, { label: "Part time", value: "Part time", origin: "assistant" }], allowOwn: true, why: "It is on the job page beside the schedule." });
  if (!has.schedule) ask({ field: "schedule", prompt: "What are the days and hours?", mode: "single", options: [{ label: "Monday to Friday, daytime", value: "Monday to Friday, daytime", origin: "assistant" }], allowOwn: true, why: "Candidates need to know when they would work." });
  if (!has.must_haves) ask({ field: "must_haves", prompt: "What must the person have?", mode: "multi", options: [], allowOwn: true, why: "Applications are read against the must-haves; keep it to the few you would not hire without." });

  const takenFromAd: string[] = [];
  if (firstTurn && c.ad) {
    if (facts.title) takenFromAd.push(`Job title: ${facts.title}`);
    if (facts.locationText) takenFromAd.push(`Where: ${facts.locationText}`);
    if (facts.employmentType) takenFromAd.push(`Type: ${facts.employmentType.replace(/_/g, " ").toLowerCase()}`);
    if (facts.schedule) takenFromAd.push(`Schedule: ${facts.schedule}`);
    if (facts.compensationMin !== undefined) takenFromAd.push(`Pay in the ad: ${money(facts.compensationMin)}–${money(facts.compensationMax ?? facts.compensationMin)} ${per(facts.compensationBasis ?? "hourly")} (to confirm)`);
  }

  const lines: string[] = [];
  for (const d of declinedNow) lines.push(`I can't build "${d.requested}" into the requirements. ${d.reason} ${d.alternative}`);
  if (takenFromAd.length) lines.push(`I took these from your ad: ${takenFromAd.join("; ")}. I'll only ask about what's missing.`);
  else if (firstTurn && facts.title) lines.push(`Got it: ${facts.title}${facts.locationText ? ` in ${facts.locationText}` : ""}.`);
  if (questions.length) lines.push("I've put what's still missing beside this. Tap an answer, add your own, or just type.");
  else if (missing.length) lines.push(`Still needed before the job can be written: ${missing.map((m) => m.replace(/_/g, " ")).join(", ")}. You can type them here.`);
  // Nothing to ask: only what it understood, never that the job can be written (the page says that).
  else if (!lines.length) lines.push("Noted.");
  return { assistantMessage: lines.join("\n\n"), factsExtracted: facts, questions, notARole: false, takenFromAd };
}

/** intake.extract: what a pasted ad states plainly, read with simple rules. */
export function fakeIntakeExtract(req: StructuredRequest<unknown>): IntakeExtraction {
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

const A_CREDENTIAL = /\blicen[cs]\w*|\bcertif\w*|\bpermit\b|\bregistration\b/i;

/**
 * intake.compile: the job as the model is told to write it (`WrittenJob`). The owner's must-haves, each worded as what
 * the person needs; no pay in the description; three skills, none named the same as a must-have; the owner's AI
 * interview questions first, six in all; one yes/no form question for each line the owner asked for and then for each
 * must-have that is a credential, five at most; the city by its name alone. Nothing the server sets is written: no
 * work arrangement, no state, no pay, no notices and none of the three lines under a candidate email.
 */
export function fakeIntakeCompile(req: StructuredRequest<unknown>): WrittenJob {
  const c = contextFrom(req);
  const f = c.facts;
  const title = f.title ?? "New hire";
  const [city, region] = (f.locationText ?? "").split(",").map((s) => s.trim());
  const assumptions: string[] = [];
  const owners = f.mustHaves.map(mustHaveOf).filter((m, i, all) => m && all.findIndex((x) => normalizeCriterion(x) === normalizeCriterion(m)) === i);
  const mustHaves = (owners.length ? owners : [`Recent ${title} experience`]).slice(0, 6);
  if (!owners.length) assumptions.push("You did not name any must-haves, so one was drafted from the job title and should be reviewed.");
  if (!f.niceToHaves.length) assumptions.push("You did not name any nice-to-haves, so none are listed.");
  if (!f.screeningQuestions?.length) assumptions.push("You did not give questions for the AI interview, so they were drafted from the job.");
  const named = mustHaves.map((text) => ({ text }));
  const skills: WrittenJob["competencies"] = [
    { key: "role_skill", name: `${title} skill`, definition: `Does the core work of a ${title} well.`, importance: "essential", indicators: ["Concrete examples from recent work"] },
    { key: "communication", name: "Communication", definition: "Clear with customers and the team.", importance: "important", indicators: ["Example of a hard conversation"] },
    { key: "reliability", name: "Reliability", definition: "Shows up consistently and says early when something slips.", importance: "important", indicators: ["Attendance history"] },
    { key: "teamwork", name: "Teamwork", definition: "Works well with the team and asks for help early.", importance: "helpful", indicators: ["Example of helping a colleague"] },
  ];
  const competencies = skills.filter((s) => !repeatsMustHave(s, named)).slice(0, 3);
  const kindOf = (q: string): WrittenJob["screening"]["questions"][number]["kind"] => /salary|pay |earn|range are you|compensation/i.test(q) ? "compensation" : /available|start|schedule/i.test(q) ? "availability" : /looking for in your next/i.test(q) ? "motivation" : /tell me about|describe|walk me through|give an example/i.test(q) ? "behavioral" : "skills";
  const own: WrittenJob["screening"]["questions"] = (f.screeningQuestions ?? []).map((q, i) => ({ key: slug(q.split(/[,:?]/)[0].split(" ").slice(0, 4).join(" ")) || `q${i + 1}`, question: q, kind: kindOf(q), modelAnswer: "A specific example from their own work." }));
  const drafted: WrittenJob["screening"]["questions"] = [
    { key: "experience", question: `Tell me about your most recent ${title} work and what a typical day looked like.`, kind: "skills", modelAnswer: "Names the work this job describes, with specifics." },
    { key: "must_have", question: `This job needs: ${mustHaves[0].replace(/[\s.]+$/, "")}. Tell me about your experience with that.`, kind: "skills", modelAnswer: "A concrete example that shows the requirement is met." },
    { key: "hard_moment", question: "Tell me about a difficult moment at work and what you did.", kind: "behavioral", modelAnswer: "Stays calm, takes responsibility, and describes what changed afterwards." },
    { key: "availability", question: "Which days and hours are you available, and when could you start?", kind: "availability", modelAnswer: "Matches the posted schedule." },
    { key: "pay", question: `What ${f.compensationBasis === "salary" ? "salary" : "hourly"} range are you looking for?`, kind: "compensation", modelAnswer: "Within or near the posted range." },
    { key: "why", question: "What are you looking for in your next job?", kind: "motivation", modelAnswer: "Reasons that fit this job and this team." },
  ];
  const questions = [...own, ...drafted].filter((q, i, all) => all.findIndex((x) => x.key === q.key) === i).slice(0, Math.min(12, Math.max(6, own.length)));
  const asked = [...f.formQuestions, ...mustHaves.filter((m) => A_CREDENTIAL.test(m)).map((m) => `Do you hold this: ${m.replace(/[\s.?!]+$/, "")}?`)];
  const formQuestions: WrittenJob["formQuestions"] = asked
    .filter((q, i, all) => all.findIndex((x) => normalizeCriterion(x) === normalizeCriterion(q)) === i)
    .slice(0, 5)
    .map((q, i) => ({ kind: "yes_no", key: slug(q.split(" ").slice(0, 6).join(" ")) || `fq${i + 1}`, question: /\?\s*$/.test(q) ? q : `${q.replace(/[\s.]+$/, "")}?`, required: true }));
  const arrangement = f.remotePolicy === "hybrid" ? "a hybrid job" : f.remotePolicy === "remote" ? "a remote job" : "an on-site job";
  const duties = f.responsibilities?.length ? ` You will ${f.responsibilities.map((r) => r.replace(/\.$/, "").replace(/^./, (ch) => ch.toLowerCase())).join(", and ")}.` : "";
  const description = `${c.companyName} is hiring a ${title}${city ? ` in ${city}${region ? `, ${region}` : ""}` : ""}. This is ${arrangement}, ${f.employmentType === "part_time" ? "part time" : "full time"}${f.schedule ? `, ${f.schedule}` : ""}. We are looking for someone who takes pride in careful, friendly work, on a team that values consistency and kindness.${duties} You will own the day-to-day work of the job from the first week, work directly with a small team that moves quickly, and see the results of your decisions. What the job needs: ${mustHaves.map((m) => m.replace(/[\s.]+$/, "")).join("; ")}. We read every application, keep the process short, and tell you where you stand at each step. If you are shortlisted, a short AI interview by email asks about the work, and a person on our team makes every decision.`;
  return {
    identity: { title, cities: city ? [city] : [], employmentType: (["full_time", "part_time", "contract", "temporary", "per_diem", "internship"].includes(f.employmentType ?? "") ? f.employmentType : "full_time") as WrittenJob["identity"]["employmentType"], schedule: f.schedule },
    description: { publicJobDescription: description },
    requirements: {
      mustHaves: mustHaves.map((m, i) => ({ key: `mh_${i + 1}_${slug(m)}`, text: m, rationale: owners.length ? "Chosen by the owner as a must-have" : "Drafted from the job title" })),
      niceToHaves: f.niceToHaves.map((m, i) => ({ key: `nh_${i + 1}_${slug(m)}`, text: m, rationale: "Nice to have per the owner" })),
    },
    competencies,
    screening: { questions, maxMinutes: 10 },
    formQuestions,
    communication: { tone: "warm", companyBlurb: `${c.companyName} is a ${c.vertical} business that treats its team and its customers with respect.`, candidateMayBeTold: ["The posted pay range", "The schedule", "The steps of the process"] },
    assumptions,
  };
}

/**
 * job.posts: the two posts as the model is told to write them, from the job's facts in the request and nothing else. A
 * LinkedIn post (an opening line, short points, the pay with the schedule, its link) and an Indeed listing under its five
 * headings, each with its own Apply link.
 */
export function fakeJobPosts(req: StructuredRequest<unknown>): JobPosts {
  const said = req.messages.map((m) => m.content).join("\n");
  let job: { companyName?: string; title?: string; places?: string[]; workArrangement?: string; employmentType?: string; schedule?: string | null; pay?: string | null; benefits?: string | null; description?: string; mustHaves?: string[] } = {};
  try { job = JSON.parse(said.match(/<job>\n([\s\S]*?)\n<\/job>/)?.[1] ?? "{}") as typeof job; } catch { /* a job with no facts gets the plainest posts */ }
  const link = (post: string) => said.match(new RegExp(`^Apply link for the ${post} post: (\\S+)$`, "m"))?.[1] ?? "";
  const title = job.title ?? "Open job";
  const company = job.companyName ?? "our company";
  const where = /remote/i.test(job.workArrangement ?? "") || !job.places?.length ? "" : ` in ${job.places.join("; ")}`;
  const terms = [job.employmentType, job.schedule, job.workArrangement].filter(Boolean).join(", ");
  const needs = (job.mustHaves ?? []).map((m) => m.replace(/[\s.]+$/, ""));
  const sentences = (job.description ?? "").match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()) ?? [];
  const duties = sentences.filter((s) => /^You will\b/.test(s)).map((s) => s.replace(/[.]+$/, ""));
  const linkedin = [
    `We are hiring: ${title} at ${company}${where}.`,
    ...[...duties.slice(0, 1), ...needs.slice(0, 4).map((n) => `You bring: ${n}`)].map((point) => `- ${point}`),
    [job.pay, terms].filter(Boolean).join(". "),
    `Apply here: ${link("LinkedIn")}`,
  ];
  const indeed = [
    "About the job",
    sentences.slice(0, 2).join(" ") || `${company} is hiring: ${title}${where}.`,
    "",
    "What you will do",
    ...(duties.length ? duties : sentences.slice(2, 5)).map((duty) => `- ${duty}`),
    "",
    "What you need",
    ...needs.map((n) => `- ${n}`),
    "",
    "Pay and schedule",
    ...(job.pay ? [`Pay: ${job.pay}`] : []),
    ...(terms ? [terms] : []),
    ...(job.benefits ? [`Benefits: ${job.benefits}`] : []),
    "",
    "How to apply",
    `Apply on our job page: ${link("Indeed")}`,
  ];
  return { linkedin: linkedin.filter(Boolean).join("\n"), indeed: indeed.join("\n") };
}
