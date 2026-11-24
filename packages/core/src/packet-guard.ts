import { mustHaveOf, restatementsOf, type Actor, type DeclinedCriterion, type DraftRolePacket, type FormQuestionRefusal, type Location, type PacketFlag } from "@ros/contracts";
import { DEFAULT_NOTICES, REACH_A_PERSON_LINE, disclosureLine, hiringTeamSignature, resolveJurisdictions } from "./compliance";

/**
 * The fairness guard on a job's wording. The deterministic guarantees every saved job record gets, whoever or whatever
 * wrote it: the builder's AI or a person's edit. It never trusts the model and never edits the owner's words on its own;
 * what it cannot fix by rule it flags, and a job cannot be published, nor an edit of an open job saved, while a flag is
 * open (a person edits the words out, or keeps them and says why).
 *
 * Fixed by rule: jurisdictions and the notices that follow from them; pay shown on every job ad; a reversed range put the
 * right way round; the AI disclosure, how to reach a person and the signature, each written from the code's own wording
 * whatever was there (a model writes these three when it writes a job, and no page shows them to anyone before a
 * candidate would read them); at most six must-haves; anything the owner was told could not be used taken out of the
 * lists it appears in. Flagged: wording that stands in for a protected trait, anywhere a candidate or a reader of
 * applications would meet it (the phrase list below), what the owner was told could not be used, reworded or not, and a
 * pay figure in the job description that nobody set or that is not the advertised range.
 *
 * The application form's questions (`formQuestions`) are read like every other words, and for the protected-question
 * list too (`PROTECTED_QUESTION_RULES`); a question that asks about a protected characteristic is refused where it is
 * set (`formQuestionProblems`, `questionCheck`), never kept with a reason.
 */

export type ProxyRule = { rule: string; reason: string; alternative: string; find: (text: string) => string | null };

const first = (pattern: RegExp) => (text: string) => text.match(pattern)?.[0] ?? null;

/** What may follow a number without it being an age ("under 30 minutes", "over 50 patients a day"). */
const NOT_AN_AGE = /^\s*(?:%|percent|minutes?|mins?|hours?|hrs?|miles?|mi\b|km|lbs?|pounds|kg|feet|ft|patients|people|employees|clients|customers|accounts|calls|tables|guests|units|stores?|locations?|staff|days?|weeks?|months?|years? of|dollars|k\b|,\d|\.\d|\/|per\b|an?\s|a day|each)/i;

function findAge(text: string): string | null {
  const range = text.match(/\b(?:ages?|aged)\s+(?:between\s+)?\d{2}\s*(?:-|–|to|and)\s*\d{2}\b|\b(?:between\s+)?\d{2}\s*(?:-|–|to|and)\s*\d{2}\s*(?:years?|yrs?)(?:[\s-]+old|\s+of\s+age)\b/i);
  if (range) return range[0];
  const words = text.match(/\b(?:maximum age|age limit|upper age)\b|\b(?:young|youthful)\s+(?:and\s+\w+\s+)?(?:team(?:\s+members?)?|person|people|candidates?|professionals?|talent|blood|energy|hires?|workers?|staff|individuals?|applicants?)\b|\bdigital natives?\b|\bnot too old\b|\boverqualified\b/i);
  if (words) return words[0];
  for (const m of text.matchAll(/\b(under|below|younger than|no older than|not older than|less than|over|older than)\s+(?:the\s+age\s+of\s+)?(\d{2})\b((?:\s*(?:years?|yrs?))?(?:[\s-]+old|\s+of\s+age|\s*y\/?o\b))?/gi)) {
    const n = Number(m[2]);
    // 18 and 21 are lawful minimum ages (serving alcohol, driving); a number with a unit after it is not an age at all.
    if (n < 22) continue;
    const saysAge = !!m[3] || /age/i.test(m[0]);
    const upperLimit = /under|below|younger|no older|not older|less/i.test(m[1]);
    if (saysAge || (upperLimit && !NOT_AN_AGE.test(text.slice((m.index ?? 0) + m[0].length)))) return m[0];
  }
  return null;
}

function findExperienceFloor(text: string): string | null {
  for (const m of text.matchAll(/\b(?:at least|a minimum of|minimum of|min\.?|over|more than)?\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)(?:\s+of)?(?:\s+[\w-]+){0,3}?\s+experience\b/gi)) {
    if (Number(m[1]) >= 10) return m[0].trim();
  }
  return null;
}

/**
 * A criminal record (LT-31, rebuilt from the final check, 17 Nov 2026). Production's two rules are kept as they were, so
 * what production refused or flagged still is. Each gets a short list of fixed phrases added, and a short list of fixed
 * exceptions, the same in every field, is taken out of both. A wording holds one of these phrases or it does not: no gap
 * of any words, and no list of the people or of the work around it.
 */

/** Production's ban, as it was: "No felons", "No criminal record", "No convictions", "Clean record", "Never been convicted". */
const PRODUCTION_BAN = /\bno (?:felons?|felonies|criminal (?:records?|history|backgrounds?)|convictions?|arrests?)\b|\bclean (?:criminal )?(?:record|background)\b|\bnever (?:been )?(?:arrested|convicted)\b/gi;
/** Production's question, as it was: "Have you ever been convicted?", "Any felony convictions?", "Do you have a criminal record?". */
const PRODUCTION_QUESTION = /\bhave you (?:ever )?been (?:arrested|convicted|charged|in (?:jail|prison))\b|\b(?:your|any)\s+(?:criminal (?:record|history|background|convictions?)|arrests?|convictions?|felon(?:y|ies))\b|\bcriminal (?:record|history|background)\b|\bare you a felon\b/gi;

/** The records an added ban names: a felony or a felon, a conviction, a misdemeanor, an arrest, and "criminal" with record, history, background, conviction, charge or offense. */
const RECORD_WORDS = String.raw`felon(?:y|ies|s)?|convictions?|misdemeanou?rs?|arrests?|criminal\s+(?:records?|history|backgrounds?|convictions?|charges?|offen[cs]es?)`;
/**
 * A driving offense right after an added phrase is the driving record, which no addition refuses ("Without convictions
 * for DUI", "A conviction-free driving record"). Production's own words stay as they were ("No convictions for DUI").
 */
const NOT_DRIVING = String.raw`(?![\s-]+(?:(?:for|of|involving|on|in)\s+)?(?:(?:a|an|any|your|their|the)\s+)?(?:dui|dwi|owi|ovi|(?:drunk|reckless|impaired)[\s-]+driving|driving|traffic|moving[\s-]+violations?|speeding|mvr|motor[\s-]+vehicles?)s?\b)`;

/** The phrases added to the ban, read wherever the ban is (requirements, deal-breakers, the description, About text, a question's help line and answers). */
const BAN_PHRASES = [
  // a record after "no", "without", "never", "must not have", "cannot have", "may not have" or "free of", with "a", "an" or
  // "any" where English needs one: "No felony convictions", "Without a criminal record", "Must not have any convictions";
  // after "never" it always does ("Never a felony"), so "Officers never arrest anyone" is the verb
  String.raw`\b(?:(?:no|without|must\s+not\s+have|cannot\s+have|can['’]t\s+have|can\s+not\s+have|may\s+not\s+have|free\s+of)\s+(?:(?:a|an|any)\s+)?|never\s+(?:a|an|any)\s+)(?:${RECORD_WORDS})\b${NOT_DRIVING}`,
  // the "-free" forms: "Felony-free", "Conviction-free"
  String.raw`\b(?:felony|felon|conviction|arrest)[\s-]+free\b${NOT_DRIVING}`,
  // and these whole bans
  String.raw`\bno\s+(?:ex[\s-]?felons?|ex[\s-]?offenders?|parolees?)\b`,
  String.raw`\bfelons\s+(?:need\s+not|needn['’]t|may\s+not)\s+apply\b`,
  String.raw`\bnot\s+(?:be\s+)?a\s+convicted\s+felon\b`,
  String.raw`\bmust\s+not\s+be\s+on\s+(?:probation\s+or\s+)?parole\b`,
  String.raw`\bnever\s+have\s+been\s+convicted\b${NOT_DRIVING}`,
  String.raw`\bhas(?:\s+not|n['’]t)\s+been\s+convicted\s+of\s+a\s+felony\b`,
  String.raw`\b(?:a|any)\s+felony\s+conviction\s+will\s+disqualify\b`,
  String.raw`\bfelony\s+conviction\s+will\s+result\s+in\s+disqualification\b`,
  String.raw`\b(?:will\s+not|won['’]t|do\s+not|don['’]t)\s+hire\s+felons\b`,
];

/** The phrases added to the question ("Are you a convicted felon?", "Are you on probation or parole?", "Have you ever spent time in jail?"). */
const QUESTION_PHRASES = [
  String.raw`\bare\s+you\s+a\s+convicted\s+felon\b`,
  String.raw`\bare\s+you\s+(?:currently\s+)?on\s+parole\b`,
  String.raw`\b(?:are\s+you|have\s+you\s+(?:ever\s+)?been)\s+(?:currently\s+)?on\s+probation\s+or\s+parole\b`,
  String.raw`\b(?:spent|served)\s+time\s+in\s+(?:jail|prison)\b`,
  String.raw`\btrouble\s+with\s+the\s+law\b`,
  String.raw`\bany\s+criminal\s+records\b`,
];

/** A record in a few fixed words, as an exception or a deal-breaker names it ("a criminal record", "felony convictions", "probation or parole"). */
const A_RECORD = String.raw`(?:(?:a|an|any)\s+)?(?:felony\s+(?:convictions?|records?|charges?)|misdemeanou?r\s+(?:convictions?|charges?)|criminal\s+(?:records?|histor(?:y|ies)|backgrounds?|convictions?|charges?|offen[cs]es?)|(?:arrest|conviction)\s+records?|convicted\s+felons?|felon(?:y|ies|s)?|convictions?|misdemeanou?rs?|arrests?|probation\s+or\s+parole|parole(?:\s+or\s+probation)?)`;

/**
 * The exceptions, the same in every field: a match inside one of these is no ban and asks about nothing. Fair-chance
 * statements ("With or without a criminal record", "A criminal record does not disqualify you", "No conviction
 * automatically disqualifies you", also for a list of records ending in "or", "…will not be considered ineligible", "We
 * never refuse to hire people with criminal records", and three that an added phrase would refuse: "Arrests without a
 * conviction are never considered", "You don't have to be felony-free to apply", "No felony restrictions"), and a record
 * that is the work's own ("Keep a clean record of patient charts").
 */
const EXCEPTIONS = [
  String.raw`\bwith\s+or\s+without\s+${A_RECORD}`,
  String.raw`\b${A_RECORD}\s+(?:does\s+not|doesn['’]t|do\s+not|don['’]t|will\s+not|won['’]t)\s+(?:automatically\s+)?disqualify\b`,
  String.raw`\bno\s+${A_RECORD}(?:(?:\s*,\s*${A_RECORD})*,?\s+(?:or|and|nor)\s+${A_RECORD})?\s+(?:(?:will|shall)\s+)?(?:be\s+(?:considered\s+)?)?(?:automatically\s+)?disqualif(?:y|ies|ying)\b`,
  String.raw`\b${A_RECORD}\s+(?:will\s+not|won['’]t)\s+be\s+considered\s+ineligible\b`,
  String.raw`\bnever\s+refuse\s+to\s+hire\s+people\s+with\s+${A_RECORD}`,
  String.raw`\barrests?\s+without\s+(?:a\s+)?convictions?\b`,
  String.raw`\b(?:do\s+not|don['’]t|does\s+not|doesn['’]t|need\s+not|needn['’]t)\s+(?:have\s+to\s+|need\s+to\s+)?be\s+(?:felony|felon|conviction|arrest)[\s-]+free\b`,
  String.raw`\b(?:felony|felon|conviction|arrest)[\s-]+free\s+(?:is\s+not|isn['’]t)\s+(?:a\s+requirement|required|needed|necessary)\b`,
  String.raw`\bno\s+felony\s+(?:bans?|restrictions?|exclusions?)\b`,
  String.raw`\bclean\s+records?\s+of\s+patient\s+charts\b`,
];

// Global, so read with `matchAll` only (never `.test` or `.exec`, which would move `lastIndex`).
const ADDED_BAN = new RegExp(BAN_PHRASES.join("|"), "gi");
const ADDED_QUESTION = new RegExp(QUESTION_PHRASES.join("|"), "gi");
const NOT_A_BAN = EXCEPTIONS.map((p) => new RegExp(p, "gi"));

/** The first match of `pattern` that is not inside an exception, or null. Matches come left to right, so the exceptions are read once, in order. */
function firstOutsideExceptions(pattern: RegExp, text: string): string | null {
  let spans: Array<[number, number]> | null = null;
  let next = 0;
  // how far the exceptions that start at or before this match reach
  let reach = -1;
  for (const m of text.matchAll(pattern)) {
    const from = m.index ?? 0;
    if (!spans) spans = NOT_A_BAN.flatMap((x) => Array.from(text.matchAll(x), (e): [number, number] => [e.index ?? 0, (e.index ?? 0) + e[0].length])).sort((a, b) => a[0] - b[0]);
    while (next < spans.length && spans[next][0] <= from) reach = Math.max(reach, spans[next++][1]);
    if (from + m[0].length > reach) return m[0];
  }
  return null;
}

/** A ban: in production's words first, so a flag kept in production keeps its words and so its keep, then in an added phrase. */
const findBan = (text: string): string | null => firstOutsideExceptions(PRODUCTION_BAN, text) ?? firstOutsideExceptions(ADDED_BAN, text);
/** A question about the record, the same way; one in a ban's own words asks about it too ("Do you have a clean record?"). */
const findRecordQuestion = (text: string): string | null => firstOutsideExceptions(PRODUCTION_QUESTION, text) ?? firstOutsideExceptions(ADDED_QUESTION, text) ?? findBan(text);

/** The deterministic phrase list. Each rule says why in plain words and offers the lawful way to get at the real need. */
export const PROXY_RULES: readonly ProxyRule[] = [
  { rule: "age", reason: "Age, and wording that stands in for age, cannot be a hiring requirement.", alternative: "Describe the skill or the availability the job needs; every candidate is asked about that.", find: findAge },
  {
    rule: "recent_graduate",
    reason: "Asking for recent or new graduates stands in for age.",
    alternative: "Say what the job needs, such as comfort learning new software, and welcome every level of experience.",
    find: first(/\b(?:recent|new|fresh)\s+(?:college\s+|university\s+|high\s+school\s+)?grad(?:uate)?s?\b|\bfresh out of (?:school|college|university)\b|\bclass of (?:19|20)\d{2}\b|\bgraduat(?:ed|ion(?:\s+year)?)\s+(?:after|before|since|in|no earlier than|no later than)\s+(?:19|20)\d{2}\b/i),
  },
  {
    rule: "language_origin",
    reason: "Native-speaker and accent wording can discriminate by national origin.",
    alternative: "Ask for the level of English, or another language, the job actually needs, such as explaining a treatment plan clearly.",
    find: first(/\bnative[\s-]+(?:english|spanish|language)?\s*speakers?\b|\bnative[\s-]+(?:level\s+)?english\b|\benglish as (?:a|your|their|the) (?:first|native|mother) (?:language|tongue)\b|\bmother tongue\b|\bno (?:foreign\s+)?accents?\b|\baccent[\s-]free\b|\bwithout an accent\b|\bamerican[\s-]born\b|\bborn in the (?:u\.?s\.?|united states)\b/i),
  },
  {
    rule: "citizenship",
    reason: "Limiting a job to citizens is unlawful unless a law requires it.",
    alternative: "Ask every candidate whether they are authorized to work in the United States.",
    find: first(/\b(?:u\.?s\.?|united states|american)\s+citizens?\s+only\b|\b(?:must be|only)\s+(?:an?\s+)?(?:u\.?s\.?|united states|american)\s+citizens?\b|\bcitizens?\s+only\b|\bgreen card holders? only\b|\bno (?:visas?|green cards?|immigrants|foreigners)\b/i),
  },
  {
    rule: "employment_gaps",
    reason: "Gaps in work history are not a fair or useful requirement; they often follow caregiving or illness.",
    alternative: "Look at recent, relevant skills instead.",
    find: first(/\bno (?:employment |work |job |resume |résumé )?gaps?\b|\bgaps? in (?:employment|work history|(?:your |the )?(?:resume|résumé|cv))\b|\bcontinuous(?:ly)? employ(?:ed|ment)\b|\bcurrently employed (?:only|candidates)\b|\bunemployed\b/i),
  },
  {
    rule: "family_status",
    reason: "Family status and pregnancy cannot be hiring criteria.",
    alternative: "If the real need is schedule availability, ask every candidate about the schedule.",
    find: first(/\bno (?:kids|children|family (?:obligations|commitments|responsibilities))\b|\bwithout (?:kids|children)\b|\bchildless\b|\b(?:single|unmarried|married)\s+(?:only|candidates?|applicants?|people|persons?|men|women)\b|\bnot pregnant\b|\bno pregnan\w*\b|\b(?:plans?|planning) to (?:have|start) (?:kids|children|a family)\b/i),
  },
  {
    rule: "sex",
    reason: "A job cannot be limited to one sex.",
    alternative: "Describe the work itself; anyone who can do it may apply.",
    find: first(/\b(?:male|female|men|women|man|woman|guys?|girls?|ladies|lady|gentlemen)\s+(?:only|preferred|candidates?\s+only|applicants?\s+only)\b|\bmust be (?:a\s+)?(?:male|female|man|woman|guy|girl)\b/i),
  },
  {
    rule: "health_disability",
    reason: "Health and disability cannot be general requirements.",
    alternative: "Name the physical tasks the job truly needs, such as lifting 25 pounds, as an eligibility question with a reason.",
    find: first(/\bno (?:disabilities|disabled (?:people|persons|applicants)|health (?:issues|problems|conditions)|medical conditions)\b|\bable[\s-]bodied\b|\bperfect (?:health|vision|eyesight|hearing)\b|\bin (?:good|excellent|perfect) health\b|\bnot disabled\b/i),
  },
  {
    rule: "religion",
    reason: "Religion cannot be a hiring criterion.",
    alternative: "Describe the values as how people treat customers and colleagues.",
    find: first(/\b(?:christian|muslim|jewish|catholic|hindu|buddhist|mormon|church[\s-]going|religious)\s+(?:only|candidates?|applicants?|preferred|values|background)\b/i),
  },
  {
    rule: "location_proxy",
    reason: "Zip codes and \"locals only\" stand in for race and national origin, and Illinois prohibits them.",
    alternative: "Ask whether candidates can reliably get to the location for the schedule.",
    find: first(/\bzip[\s-]?codes?\b|\bpostal codes?\b|\blocals?\s+only\b|\blocal (?:candidates|applicants|people|residents) only\b|\bonly (?:people|candidates|applicants|residents) (?:from|in|who live in)\b|\bmust live in\b/i),
  },
  {
    rule: "criminal_record",
    reason: "A blanket ban on criminal records breaks fair-chance hiring laws in many places.",
    alternative: "Leave any background check to the end of the process, after an offer, where the law allows it.",
    find: findBan,
  },
  {
    rule: "experience_cap",
    reason: "A cap on years of experience shuts out older people.",
    alternative: "Say what the person will do and let anyone with the skills apply.",
    find: first(/\b(?:no more than|not more than|at most|a maximum of|maximum of|max(?:imum)?\.?|less than|fewer than|under|up to)\s+\d{1,2}\s*\+?\s*(?:years?|yrs?)(?:\s+of)?(?:\s+[\w-]+){0,3}?\s+experience\b|\b\d{1,2}\s*(?:years?|yrs?)(?:\s+of)?\s+experience\s*(?:max(?:imum)?|at most|or less|or fewer)\b/i),
  },
  { rule: "experience_floor", reason: "A long minimum of years can stand in for age; keep it only if the job truly needs it.", alternative: "Describe the level of skill needed instead of a number of years.", find: findExperienceFloor },
  {
    rule: "pay_history",
    reason: "Asking about pay history is banned in many states.",
    alternative: "Ask what pay they are looking for instead.",
    find: first(/\b(?:salary|pay|wage|compensation|earnings)\s+history\b|\b(?:current|previous|prior|last|present)\s+(?:salary|pay|wages?|compensation|hourly rate|rate of pay|earnings)\b|\b(?:how much|what) (?:do|did) you (?:currently )?(?:make|earn|get paid)\b/i),
  },
];

const UNCONFIRMED_PAY = { rule: "unconfirmed_pay", reason: "This mentions a pay figure nobody has confirmed.", alternative: "Set or confirm the pay on the pay card, or take the figure out." };
const PAY_MISMATCH = { rule: "pay_mismatch", reason: "This states a pay figure that is not the range set for this job.", alternative: "Take the figure out: the job page shows the pay range from the pay card beside the description." };

export type CriterionCheck = { rule: string; text: string; reason: string; alternative: string };

/** The fairness check for one line of text (an owner's own answer, an offered answer, a deal-breaker): the first rule it breaks, or null. */
export function screenCriterion(text: string): CriterionCheck | null {
  for (const r of PROXY_RULES) {
    const hit = r.find(text);
    if (hit) return { rule: r.rule, text: hit, reason: r.reason, alternative: r.alternative };
  }
  return null;
}

/** At most one of these before a record named as a deal-breaker ("Anyone with a felony", "Having a criminal record"). */
const NAMED_AFTER = String.raw`(?:having|anyone\s+with|people\s+with|those\s+with|applicants\s+with|anyone\s+convicted\s+of|on)\s+`;
/** And at most a time window after it ("Felony convictions in the last 7 years", "Arrests within 10 years"). */
const NUMBER = String.raw`(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)`;
const TIME_WINDOW = String.raw`(?:(?:in|within|during|over)\s+)?(?:the\s+)?(?:last|past|previous)\s+(?:${NUMBER}\s+)?(?:years?|yrs?|months?)|within\s+${NUMBER}\s+(?:years?|yrs?|months?)`;
/**
 * A deal-breaker whose whole words are a record ("Felony convictions", "A criminal record", "Criminal history", "Anyone
 * with a felony", "People with criminal records", "Anyone convicted of a felony", "On probation or parole", "Felony
 * convictions in the last 7 years"), read on its trimmed words: as the answer to "What rules someone out?", the ban
 * itself (review of the criminal-record fix, 17 Nov 2026: it was stored and offered back as the must-have "Felony
 * convictions"). Never a driving record ("DUI convictions", "Convictions for DUI in the last 5 years"), a check
 * ("Criminal background check after a conditional offer", "Cannot pass a background check") or the work.
 */
const RECORD_NAMED = new RegExp(String.raw`^(?:${NAMED_AFTER})?${A_RECORD}(?:\s+(?:${TIME_WINDOW}))?[.!]?$`, "i");

/** The phrase list as it reads a deal-breaker: a record named on its own is the ban too, in all its words (`RECORD_NAMED`). */
const DEAL_BREAKER_RULES: readonly ProxyRule[] = PROXY_RULES.map((r) => (r.rule === "criminal_record" ? { ...r, find: (text: string) => r.find(text) ?? (RECORD_NAMED.test(text.trim()) ? text.trim() : null) } : r));

/**
 * The fairness check for one deal-breaker (answered on a card, or read by the job builder from the chat):
 * `screenCriterion`, and a record named on its own is refused too.
 */
export function screenDealBreaker(text: string): CriterionCheck | null {
  for (const r of DEAL_BREAKER_RULES) {
    const hit = r.find(text);
    if (hit) return { rule: r.rule, text: hit, reason: r.reason, alternative: r.alternative };
  }
  return null;
}

/**
 * Questions put to candidates that ask about a protected characteristic itself: a question on the application form or
 * in the AI interview. The phrase list above reads
 * requirements ("male only", "no kids"); these read questions ("What is your gender?", "Do you have children?"). A
 * question that breaks one is refused when it is set, never kept with a reason: there is no lawful reason to ask it on an
 * application. Each says why in plain words and offers the lawful way to the real need. The patterns ask about the
 * candidate ("your age", "are you married"), so "Experience caring for patients with disabilities", "Have you worked with
 * someone on parole?" or "Are you at least 18?" (a legal minimum age) pass. A bare "criminal record" in a question is
 * refused, as in production, even about the people the work is with.
 */
export const PROTECTED_QUESTION_RULES: readonly ProxyRule[] = [
  {
    rule: "asks_sex",
    reason: "Questions about sex, gender or sexual orientation cannot be asked of applicants.",
    alternative: "Ask only about the work: the skills, the schedule, the certifications the job needs.",
    find: first(/\byour\s+(?:gender(?:\s+identity)?|sex|pronouns|sexual orientation)\b|\bgender\b|\bsexual orientation\b|\bare you (?:a\s+)?(?:male|female|man|woman|gay|lesbian|straight|bisexual|transgender|trans)\b|\b(?:ideally|preferably|must be|should be)\s+(?:a\s+)?(?:male|female|man|woman)\b/i),
  },
  {
    rule: "asks_age",
    reason: "Asking an applicant's age, birth date or graduation year can discriminate by age.",
    alternative: "Where a law sets a minimum age, ask an eligibility question such as \"Are you at least 18?\".",
    find: first(/\bhow old are you\b|\byour\s+(?:age|date of birth|birth\s?date|birthday|year of birth)\b|\bdate of birth\b|\bwhat year (?:were you born|did you (?:graduate|finish (?:high )?school))\b|\bwhen (?:were you born|did you graduate)\b|\bgraduation (?:year|date)\b|\bage (?:range|group|bracket)\b|\bare you (?:over|under|older than|younger than|above|below) (?!18\b|21\b)\d{2}\b/i),
  },
  {
    rule: "asks_veteran",
    reason: "Questions about military service or veteran status cannot be asked on an application.",
    alternative: "Ask about the skills and experience the job needs, from any setting.",
    find: first(/\bveterans?\b|\bveteran status\b|\bmilitary (?:service|background|history|record)\b|\b(?:have you |did you )?(?:ever )?serve[d]? in the (?:military|armed forces|army|navy|air force|marines|marine corps|coast guard|national guard)\b|\b(?:honorable|dishonorable|general|military) discharge\b|\bdischarged from the (?:military|armed forces|army|navy|air force|marines)\b/i),
  },
  {
    rule: "asks_race",
    reason: "Questions about race, colour or ethnicity cannot be asked of applicants.",
    alternative: "Ask only about the work the job needs.",
    find: first(/\byour\s+(?:race|ethnicity|ethnic (?:group|background|origin)|skin colou?r|heritage)\b|\bethnicity\b|\bracial\b|\bethnic (?:group|background|origin)\b/i),
  },
  {
    rule: "asks_origin",
    reason: "Questions about citizenship, nationality, birthplace or first language can discriminate by national origin.",
    alternative: "Ask every applicant whether they are authorized to work in the United States, and for the level of a language the job needs.",
    find: first(/\bnationality\b|\bcitizenship\b|\bare you (?:a\s+|an\s+)?(?:u\.?s\.?\s+|us\s+|american\s+)?citizen\b|\bcountry of (?:birth|origin)\b|\bwhere (?:were you|was your family) born\b|\bwhere are you (?:originally )?from\b|\bimmigration status\b|\byour\s+(?:native|first|mother) (?:language|tongue)\b|\bmother tongue\b|\byour\s+accent\b|\bgreen card\b|\bpermanent resident\b|\bwhere did you grow up\b|\bwhere (?:did|do) your (?:parents|family) (?:come|live)\b|\bspeak\s+(?:\w+\s+)?natively\b|\bnative speaker\b|\bwhat (?:is|was) your (?:first|native) (?:language|tongue)\b/i),
  },
  {
    rule: "asks_religion",
    reason: "Questions about religion cannot be asked of applicants.",
    alternative: "If the real need is the schedule, ask every applicant whether they can work the posted days.",
    find: first(/\byour\s+(?:religion|faith|church|religious (?:beliefs?|affiliation|holidays?))\b|\bwhat religion\b|\bare you religious\b|\bdo you (?:attend|go to) (?:church|mosque|synagogue|temple)\b|\bwhich (?:religious )?holidays do you (?:observe|celebrate)\b|\bobserve the sabbath\b/i),
  },
  {
    rule: "asks_family",
    reason: "Questions about marriage, children, pregnancy or family plans cannot be asked of applicants.",
    alternative: "If the real need is availability, ask every applicant whether they can work the posted schedule.",
    find: first(/\bare you (?:married|single|divorced|engaged|pregnant|expecting)(?![-\w])|\bmarital status\b|\byour\s+(?:spouse|husband|wife|marital|maiden name|pregnancy)\b|\bmaiden name\b|\b(?:do you have|have you got) (?:any\s+)?(?:kids|children|dependents)(?![-'’\w])(?!\s+(?:in (?:your|our|the) (?:care|class|classroom|program)|to (?:look after|care for|teach))\b)|\bhow many (?:kids|children|dependents) do you have\b|\b(?:get|getting|become|becoming) pregnant\b|\bplan(?:s|ning)? (?:to|on) (?:have|having|start|starting) (?:a family|kids|children)\b|\bwho (?:will )?looks? after your (?:kids|children)\b|\b(?:ideally|preferably|must be|should be)\s+(?:married|single|unmarried|childless|without (?:kids|children))\b|\bare you a (?:parent|mother|father|mom|mum|dad|single (?:parent|mother|father|mom|mum|dad))\b|\bchild ?care (?:arrangements?|plans?|cover|needs?|responsibilities)\b|\byour (?:kids|children|childcare|child care)\b/i),
  },
  {
    rule: "asks_health",
    reason: "Questions about health, disability, medication or medical history cannot be asked before an offer.",
    alternative: "Ask whether they can do the job's tasks, with or without a reasonable accommodation, such as lifting 25 pounds.",
    find: first(/\b(?:do|have) you (?:have|had|ever had|suffer from|live with)\s+(?:a\s+|any\s+)?(?:disabilit\w*|medical (?:conditions?|problems?|issues?)|health (?:conditions?|problems?|issues?)|chronic \w+|illness\w*|impairments?|mental health)\b|\bare you (?:disabled|handicapped|healthy|in good health)\b|\byour\s+(?:health(?!\s+(?:and|&)\s+safety)|disabilit\w*|medical (?:history|conditions?)|medications?|mental health|genetic \w+|height|weight)\b|\bdo you take (?:any\s+)?(?:medications?|medicine|prescriptions?)\b|\bhow many (?:sick days|days off sick)\b|\bworkers'? comp(?:ensation)? claims?\b|\bfamily (?:medical|health) history\b|\bhow (?:tall are you|much do you weigh)\b|\bphysical (?:limitations?|restrictions?|impairments?|conditions?)\b/i),
  },
  {
    rule: "asks_record",
    reason: "Asking about arrests or convictions on an application breaks fair-chance hiring laws in many places.",
    alternative: "Leave any background check to the end of the process, after an offer, where the law allows it.",
    // a question in a ban's own words asks about the record too ("Do you have a clean record?", "Can you confirm you have
    // no felony convictions?"): refused where it is set, never kept with a reason (review of the criminal-record fix)
    find: findRecordQuestion,
  },
  {
    rule: "asks_pay_history",
    reason: "Asking about pay history is banned in many states.",
    alternative: "Ask what pay they are looking for instead.",
    find: first(/\b(?:salary|pay|wage|compensation|earnings)\s+history\b|\b(?:your\s+)?(?:current|previous|prior|last|present)\s+(?:salary|pay|wages?|compensation|hourly rate|rate of pay|earnings)\b|\b(?:how much|what) (?:do|did) you (?:currently )?(?:make|earn|get paid)\b|\bwhat (?:were|was) you(?:r)? (?:paid|pay|salary|wages?|hourly rate)\b|\bhow much (?:were|was) you(?:r)? (?:paid|pay|salary)\b/i),
  },
];

/**
 * A choice offered as an answer that is itself a protected trait ("Male", "Married", "Christian", "Green card holder",
 * "Mrs", "Mother", "Veteran").
 */
const TRAIT_OPTION = /^\s*(?:male|female|man|woman|men|women|non[\s-]?binary|transgender|married|divorced|widowed|christian|muslim|jewish|catholic|hindu|buddhist|sikh|atheist|pregnant|(?:u\.?s\.?\s+|us\s+|american\s+)?citizen|(?:not\s+a\s+)?(?:u\.?s\.?\s+)?citizen|green\s+card(?:\s+holder)?|permanent\s+resident|(?:on\s+a\s+)?work\s+visa|immigrant|mr|mrs|ms|miss|mx|mother|father|mom|mum|dad|parent|single\s+parent|(?:not\s+a\s+)?veteran)\s*\.?\s*$/i;
/** An answer to choose from that is an age bracket ("Under 30", "30-49", "50 or over"), read with the question it belongs to. */
const AGE_BRACKET = /^\s*(?:(?:under|over|below|above)\s+\d{2}|\d{2}\s*(?:[-–]|to)\s*\d{2}|\d{2}\s*(?:\+|or (?:over|older|above|more)))\s*\.?\s*$/i;
/** Words in a question that say its numbers are not ages ("How many patients a day?", "Years of experience?"). */
const COUNTS_SOMETHING = /\b(?:patients?|people|hours?|minutes?|miles?|days?|weeks?|months?|years? of|clients?|customers?|students?|employees?|staff|team|calls?|appointments?|chairs?|beds?|rooms?|lbs?|pounds|words?|wpm|dollars|\$)/i;
/**
 * The phrase-list rules that are about a protected characteristic itself, or a ban on a criminal record: refused in any
 * part of a question (its help line or what a good answer shows too), never kept with a reason.
 */
const REFUSED_PHRASE_RULES = new Set(["age", "sex", "language_origin", "citizenship", "family_status", "religion", "health_disability", "criminal_record"]);
const TRAIT_OPTION_RULE = { rule: "asks_trait_option", reason: "An answer to choose from names a protected characteristic, so the question asks about it.", alternative: "Ask only about the work the job needs." };

/** The fairness check for one question put to candidates: the protected-question list first, then the phrase list. */
export function questionCheck(text: string): CriterionCheck | null {
  for (const r of PROTECTED_QUESTION_RULES) {
    const hit = r.find(text);
    if (hit) return { rule: r.rule, text: hit, reason: r.reason, alternative: r.alternative };
  }
  return screenCriterion(text);
}

type QuestionWords = { key?: string | null; question: string; help?: string | null; options?: readonly string[] };

/**
 * The application form's questions, checked before they are saved: any part (the question, its help line, an answer to
 * choose from) that asks about a protected characteristic is refused, never kept with a reason, unlike a flagged phrase.
 * Wording the phrase list flags elsewhere ("10+ years of experience") is not refused here; the guard flags it as
 * everywhere else. Each refusal carries its place in the list and the sentence a person reads (`words`). Reads the shape
 * the editor sends as well as the saved one.
 */
export function formQuestionProblems(questions: readonly QuestionWords[] | null | undefined): FormQuestionRefusal[] {
  const out: FormQuestionRefusal[] = [];
  const refuse = (index: number, key: string | null, part: FormQuestionRefusal["part"], hit: { rule: string; text: string; reason: string; alternative: string }) => {
    const where = `Screening question ${index + 1}${part === "option" ? `, the answer "${hit.text}"` : part === "help" ? ", its help line" : ""}`;
    out.push({ index, key, part, ...hit, words: `${where}: ${hit.reason} ${hit.alternative}` });
  };
  const check = (index: number, key: string | null, part: FormQuestionRefusal["part"], text: string | null | undefined, question = "") => {
    if (!text?.trim()) return;
    for (const r of PROTECTED_QUESTION_RULES) {
      const hit = r.find(text);
      if (hit) return refuse(index, key, part, { rule: r.rule, text: hit, reason: r.reason, alternative: r.alternative });
    }
    // the phrase list's protected-characteristic rules ("under 30", "male only", "native English") and a ban on a criminal
    // record are refused here too
    const phrase = screenCriterion(text);
    if (phrase && REFUSED_PHRASE_RULES.has(phrase.rule)) return refuse(index, key, part, phrase);
    if (part === "option" && (TRAIT_OPTION.test(text) || (AGE_BRACKET.test(text) && !COUNTS_SOMETHING.test(question)))) refuse(index, key, part, { rule: TRAIT_OPTION_RULE.rule, text: text.trim(), reason: TRAIT_OPTION_RULE.reason, alternative: TRAIT_OPTION_RULE.alternative });
  };
  for (const [i, q] of (questions ?? []).entries()) {
    const key = q.key ?? null;
    check(i, key, "question", q.question);
    check(i, key, "help", q.help);
    for (const o of q.options ?? []) check(i, key, "option", o, q.question);
  }
  return out;
}

/** Lower case, punctuation as spaces, single spaces: "Recent grads!" and "recent  grads" read the same. */
export function normalizeCriterion(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

const slug = (s: string) => normalizeCriterion(s).replace(/ /g, "_").slice(0, 40);

/**
 * Whether `text` mentions a declined request, as whole words: "Age" is not in "Manage the front desk". A one-word request
 * shorter than five letters is too likely to sit inside ordinary words, so it is left to the phrase list above (which
 * reads age wording as such) rather than matched on its own.
 */
export function mentionsPhrase(text: string, requested: string): boolean {
  const key = normalizeCriterion(requested);
  if (!key || (!key.includes(" ") && key.length < 5)) return false;
  return ` ${normalizeCriterion(text)} `.includes(` ${key} `);
}

/**
 * The places in a packet a person or a candidate reads. `path` says where, by position, for the page; `at` names the same
 * place by something that does not move when items before it are taken out or reordered (the item's key, or its own
 * words), so a flag a person kept stays kept.
 */
function readableText(p: DraftRolePacket): Array<{ path: string; at: string; text: string; asked?: true; requirement?: true }> {
  const out: Array<{ path: string; at: string; text: string; asked?: true; requirement?: true }> = [];
  const add = (path: string, at: string, text: string | undefined, kind?: { requirement: true }) => {
    if (text?.trim()) out.push({ path, at, text, ...kind });
  };
  // The application form's questions are read for the protected-question list too (`asked`).
  const ask = (path: string, at: string, text: string | undefined) => {
    if (text?.trim()) out.push({ path, at, text, asked: true });
  };
  const one = (path: string, text: string | undefined) => add(path, path, text);
  one("identity.title", p.identity.title);
  one("description.publicJobDescription", p.description.publicJobDescription);
  for (const [i, m] of p.requirements.mustHaves.entries()) add(`requirements.mustHaves[${i}].text`, `requirements.mustHaves[${m.key}].text`, m.text, { requirement: true });
  for (const [i, m] of p.requirements.niceToHaves.entries()) add(`requirements.niceToHaves[${i}].text`, `requirements.niceToHaves[${m.key}].text`, m.text, { requirement: true });
  for (const [i, q] of p.screening.questions.entries()) add(`screening.questions[${i}].question`, `screening.questions[${q.key}].question`, q.question);
  for (const [i, c] of p.competencies.entries()) add(`competencies[${i}].definition`, `competencies[${c.key}].definition`, c.definition);
  one("communication.companyBlurb", p.communication.companyBlurb);
  for (const [i, q] of p.formQuestions.entries()) {
    ask(`formQuestions[${i}].question`, `formQuestions[${q.key}].question`, q.question);
    ask(`formQuestions[${i}].help`, `formQuestions[${q.key}].help`, q.help);
    if (q.kind === "choice") for (const [j, o] of q.options.entries()) ask(`formQuestions[${i}].options[${j}]`, `formQuestions[${q.key}].options[${slug(o)}]`, o);
  }
  return out;
}

/** The states whose pay transparency notice applies (the notice's own list in compliance.ts). */
const PAY_TRANSPARENCY_JURISDICTIONS = DEFAULT_NOTICES.find((n) => n.key === "pay_transparency")?.jurisdictions ?? [];

export type GuardContext = {
  companyName: string;
  companyLocations: Location[];
  /** What the owner was told could not be used, from the conversation; merged with what the packet already records. */
  declined?: DeclinedCriterion[];
  /** The flags of the version (or draft) being replaced: who kept what, and why, carries over. */
  previousFlags?: PacketFlag[];
  /** Who is saving: stamped on a flag kept now. Without one, a request to keep a flag is ignored. */
  actor?: Actor;
  now?: string;
};

export type GuardResult<T> = { packet: T; flags: PacketFlag[]; changes: string[] };

/** Runs every guarantee above; returns the packet as it must be saved, its flags (also on `provenance.flags`) and what was changed. */
export function guardPacket<T extends DraftRolePacket>(input: T, ctx: GuardContext): GuardResult<T> {
  const packet = structuredClone(input) as T;
  const changes: string[] = [];
  const now = ctx.now ?? new Date().toISOString();

  const jurisdictions = resolveJurisdictions([...packet.identity.locations, ...ctx.companyLocations]);
  packet.compliance.jurisdictions = jurisdictions;
  const notices = new Set([...packet.compliance.notices, "ai_use", "privacy"]);
  if (jurisdictions.some((j) => PAY_TRANSPARENCY_JURISDICTIONS.includes(j))) notices.add("pay_transparency");
  packet.compliance.notices = [...notices];

  const comp = packet.compensation;
  if (comp) {
    // The pay range is on every job ad, whatever the state's law says.
    if (!comp.discloseRange) {
      comp.discloseRange = true;
      changes.push("The pay range is shown on the job ad.");
    }
    if (comp.min > comp.max) {
      [comp.min, comp.max] = [comp.max, comp.min];
      changes.push("The pay range was the wrong way round and was swapped.");
    }
  }
  // The three lines under an automatic message to a candidate are the code's own, the same for every job
  // (compliance.ts). The emails about an application take them from the code, and the AI interview's first page its
  // line about a person (coordinator.ts and screening.ts in packages/agents); the record holds a copy, written here on
  // every save, so that nothing which still reads the copy finds the words a model or an earlier version wrote there.
  packet.communication.disclosureText = disclosureLine(ctx.companyName);
  packet.communication.humanAlternativeText = REACH_A_PERSON_LINE;
  packet.communication.signature = hiringTeamSignature(ctx.companyName);
  if (packet.requirements.mustHaves.length > 6) {
    packet.requirements.mustHaves = packet.requirements.mustHaves.slice(0, 6);
    changes.push("Must-haves were cut to six.");
  }

  // What the owner was told could not be used: recorded on the packet so no later version can bring it back.
  const declined: DeclinedCriterion[] = [];
  for (const d of [...(packet.provenance.declinedCriteria ?? []), ...(ctx.declined ?? [])]) {
    const key = normalizeCriterion(d.requested);
    if (!key || declined.some((x) => normalizeCriterion(x.requested) === key)) continue;
    declined.push({ ...d, rule: d.rule ?? screenCriterion(d.requested)?.rule });
  }
  packet.provenance.declinedCriteria = declined;
  // A request is found in its own words, and restated as the must-have it reads as (`mustHaveOf`: "No visa permit" as
  // "Visa permit"), so a model that restates it is caught too (review of the live test, 12 Nov 2026).
  const mentions = (text: string, d: DeclinedCriterion) => mentionsPhrase(text, d.requested) || mentionsPhrase(text, mustHaveOf(d.requested));
  const mentionsDeclined = (text: string) => declined.some((d) => mentions(text, d));
  const count = () => packet.requirements.mustHaves.length + packet.requirements.niceToHaves.length;
  const before = count();
  const keptMust = packet.requirements.mustHaves.filter((m) => !mentionsDeclined(m.text));
  // A list never loses its last must-have here (the schema needs one); that one is flagged below instead.
  if (keptMust.length) packet.requirements.mustHaves = keptMust;
  packet.requirements.niceToHaves = packet.requirements.niceToHaves.filter((m) => !mentionsDeclined(m.text));
  const removed = before - count();
  if (removed > 0) changes.push(`${removed} ${removed === 1 ? "item the owner was told could not be used was" : "items the owner was told could not be used were"} taken out.`);

  const declinedRules = new Set(declined.map((d) => d.rule).filter((r): r is string => !!r));
  const flags: PacketFlag[] = [];
  // The id names the place by `at` (an item's key or its words, not its position), so a keep survives a reorder.
  const push = (at: string, f: Omit<PacketFlag, "id">) => {
    const id = `${f.rule}:${at}:${slug(f.text)}`;
    if (flags.some((x) => x.id === id || (x.path === f.path && normalizeCriterion(x.text) === normalizeCriterion(f.text)))) return;
    flags.push({ id, ...f });
  };
  // A deal-breaker the owner was refused for a record ("Felony convictions", "No felonies") is read as one
  // (`DEAL_BREAKER_RULES`: a record named on its own is the ban), and a must-have or a nice-to-have in its words
  // ("Felony convictions", "Felonies") is flagged with it.
  const record = DEAL_BREAKER_RULES.find((r) => r.rule === "criminal_record");
  const restatesRecordBan = new Set(declined.filter((d) => record?.find(d.requested)).flatMap((d) => restatementsOf(d.requested).map(normalizeCriterion)));
  for (const target of readableText(packet)) {
    for (const r of target.asked ? [...PROTECTED_QUESTION_RULES, ...PROXY_RULES] : PROXY_RULES) {
      const hit = r.find(target.text);
      if (hit) push(target.at, { path: target.path, rule: r.rule, text: hit, reason: r.reason, alternative: r.alternative, ...(declinedRules.has(r.rule) ? { declined: true } : {}) });
    }
    if (record && target.requirement && restatesRecordBan.has(normalizeCriterion(target.text)) && !flags.some((f) => f.path === target.path && f.rule === record.rule)) {
      push(target.at, { path: target.path, rule: record.rule, text: target.text, reason: record.reason, alternative: record.alternative, ...(declinedRules.has(record.rule) ? { declined: true } : {}) });
    }
    for (const d of declined) {
      if (mentions(target.text, d)) push(target.at, { path: target.path, rule: "declined", text: d.requested, reason: `You were told this could not be used. ${d.reason}`, ...(d.alternative ? { alternative: d.alternative } : {}), declined: true });
    }
  }
  // A draft with no confirmed pay must not quote a figure anywhere: nobody set it. With pay set, the description may
  // quote only the advertised range: a figure from before the pay changed is flagged, since the pay set by a person is
  // brought up to date on its own but the description's words are not.
  const description = packet.description.publicJobDescription;
  if (!packet.compensation) {
    const money = description.match(/\$\s?\d[\d,.]*(?:\s*(?:k|an hour|per hour|\/hr|a year|per year))?/i);
    if (money) push("description.publicJobDescription", { path: "description.publicJobDescription", rule: UNCONFIRMED_PAY.rule, text: money[0], reason: UNCONFIRMED_PAY.reason, alternative: UNCONFIRMED_PAY.alternative });
  } else {
    for (const figure of otherPayFigures(description, [packet.compensation.min, packet.compensation.max])) push("description.publicJobDescription", { path: "description.publicJobDescription", rule: PAY_MISMATCH.rule, text: figure, reason: PAY_MISMATCH.reason, alternative: PAY_MISMATCH.alternative });
  }

  // Who kept what: a fresh request to keep is stamped with whoever is saving; an earlier keep carries over unchanged.
  const incoming = new Map((input.provenance.flags ?? []).map((f) => [f.id, f]));
  const previous = new Map((ctx.previousFlags ?? []).map((f) => [f.id, f]));
  for (const f of flags) {
    const asked = incoming.get(f.id);
    const before = previous.get(f.id);
    if (asked?.keepReason?.trim() && ctx.actor) f.kept = { reason: asked.keepReason.trim(), by: ctx.actor, at: now };
    else if (before?.kept && (!asked?.kept || asked.kept.reason === before.kept.reason)) f.kept = before.kept;
  }
  packet.provenance.flags = flags;
  return { packet, flags, changes };
}

const DOLLAR_FIGURE = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi;

/** The dollar amounts written in `text` ("$60", "$70k", "$1,200.50"). */
function dollarAmounts(text: string): Array<{ words: string; amount: number }> {
  return [...text.matchAll(DOLLAR_FIGURE)].map((m) => ({ words: m[0].trim(), amount: Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1) }));
}

/** The dollar figures in `text`, as written, that are none of the `allowed` amounts. */
function otherPayFigures(text: string, allowed: readonly number[]): string[] {
  return dollarAmounts(text).filter((f) => !allowed.includes(f.amount)).map((f) => f.words);
}

/**
 * The guard's wording check for a text written from a saved job (its LinkedIn post, its Indeed listing): what each rule
 * would flag in the job's own description, what the owner was told could not be used, and a dollar figure that is
 * neither the job's pay nor in its benefits line. Wording a person kept in the job with a reason passes here too.
 */
export function wordingProblems(text: string, job: { compensation?: { min: number; max: number } | null; benefits?: string | null; provenance: { flags?: PacketFlag[]; declinedCriteria?: DeclinedCriterion[] } }): CriterionCheck[] {
  const kept = (job.provenance.flags ?? []).filter((f) => f.kept);
  const isKept = (rule: string, words: string) => kept.some((f) => f.rule === rule && normalizeCriterion(f.text) === normalizeCriterion(words));
  const found: CriterionCheck[] = [];
  for (const r of PROXY_RULES) {
    const hit = r.find(text);
    if (hit && !isKept(r.rule, hit)) found.push({ rule: r.rule, text: hit, reason: r.reason, alternative: r.alternative });
  }
  for (const d of job.provenance.declinedCriteria ?? []) {
    if ((mentionsPhrase(text, d.requested) || mentionsPhrase(text, mustHaveOf(d.requested))) && !isKept("declined", d.requested)) found.push({ rule: "declined", text: d.requested, reason: d.reason, alternative: d.alternative ?? "" });
  }
  const stated = [...(job.compensation ? [job.compensation.min, job.compensation.max] : []), ...dollarAmounts(job.benefits ?? "").map((f) => f.amount)];
  for (const figure of otherPayFigures(text, stated)) if (!isKept(PAY_MISMATCH.rule, figure)) found.push({ rule: PAY_MISMATCH.rule, text: figure, reason: PAY_MISMATCH.reason, alternative: PAY_MISMATCH.alternative });
  return found;
}

/** The flags nobody has dealt with yet; publishing waits for none to be left. */
export function unresolvedFlags(packet: { provenance: { flags?: PacketFlag[] } } | null | undefined): PacketFlag[] {
  return (packet?.provenance.flags ?? []).filter((f) => !f.kept);
}

/** What a person reads when publishing or saving is refused for open flags. */
export function openFlagsMessage(count: number): string {
  return `${count === 1 ? "One phrase in this job needs" : `${count} phrases in this job need`} a decision first: edit ${count === 1 ? "it" : "them"} out, or keep ${count === 1 ? "it" : "them"} and say why.`;
}
