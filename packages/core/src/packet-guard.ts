import { IMPORTANCE_WEIGHT, mustHaveOf, restatementsOf, type Actor, type CompanyQuestions, type DeclinedCriterion, type DraftRolePacket, type Location, type PacketFlag } from "@ros/contracts";
import { DEFAULT_NOTICES, disclosureLine, resolveJurisdictions } from "./compliance";

/**
 * The packet guard (plan item C1). The deterministic guarantees every saved Role Packet gets, whoever or whatever wrote
 * it: the intake draft, a person's edit, a revision by chat, an approval. It never trusts the model and never edits the
 * owner's words on its own; what it cannot fix by rule it flags, and a role cannot be approved while a flag is open
 * (a person edits the words out, or keeps them and says why).
 *
 * Fixed by rule: jurisdictions and the notices that follow from them; pay shown on every job ad (founder decision Q9);
 * the private ceiling never below the top of the range, and a reversed range put the right way round; the AI disclosure
 * and "a person is available" lines; at most six must-haves; anything the owner was told could not be used taken out of
 * the lists it appears in. Flagged: wording that stands in for a protected trait, anywhere a candidate or a reader of
 * applications would meet it (the phrase list below), what the owner was told could not be used, reworded or not, and a
 * pay figure in the job description that nobody set or that is not the advertised range.
 *
 * Wave S7: the questions every applicant answers (`companyQuestions`) are read like every other words, and for the
 * protected-question list too (`PROTECTED_QUESTION_RULES`); a question that asks about a protected characteristic is
 * refused where it is set (`companyQuestionProblems`, `questionCheck`), never kept with a reason.
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
 * A criminal record as a requirement or a question names it: a felony or a felon, a conviction, an arrest, a misdemeanor,
 * criminals, a criminal record, history, background, conviction, charge, offense or past, and a police, arrest,
 * conviction, prison or jail record, in any number. Never a driving record: "Clean driving record", "No DUI
 * convictions" and "No moving violations" pass, as a driving job may ask for one. Pending charges alone are a bill's
 * ("End each day with no pending charges"); pending criminal charges are a record.
 */
const RECORD_WORDS = String.raw`felon(?:y|ies|s)?|convictions?|arrests?|misdemeanou?rs?|criminals|criminal[\s-]+(?:records?|history|histories|backgrounds?|convictions?|charges?|offen[cs]es?|past)|(?:police|arrest|conviction|prison|jail)[\s-]+records?`;
const RECORD = `(?:${RECORD_WORDS})`;
/**
 * In a ban, the people a record names, offenses and time served too ("No ex-cons", "No sex offenders", "No violent
 * offenses", "No jail time").
 */
const EX_PEOPLE = String.raw`ex[\s-]?(?:felons?|cons?|convicts?|offenders?)`;
const BAN_WORDS = String.raw`${RECORD_WORDS}|${EX_PEOPLE}|offenders?|offen[cs]es|(?:jail|prison)[\s-]+(?:time|sentences?)|incarcerations?`;
const BAN_RECORD = `(?:${BAN_WORDS})`;
/** A driving offense, which is the driving record ("No DUI convictions", "No reckless driving convictions"). */
const DRIVING = String.raw`(?:dui|dwi|owi|ovi|traffic|moving|driving|motoring|speeding|parking|vehicular)s?`;
/**
 * Words that never say what kind of record it is: joining words, a ban on asking or a check, and the work itself ("No
 * experience with offenders needed", "No blanket ban on convictions", "No questions about convictions"). A word ending
 * in "-ing" is the work too ("researching criminal records"), unless it names a crime or says the record is pending.
 */
const NOT_A_KIND = String.raw`(?:a|an|the|any|some|on|for|about|of|in|into|over|regarding|because|due|to|from|with|by|before|after|until|than|that|which|who|or|and|nor|not|no|never|is|are|was|were|be|been|will|would|ban|bans|bar|bars|blanket|questions?|inquir\w*|penalt\w*|discriminat\w*|checks?|screenings?|experience\w*|knowledge|work|works|jobs?|roles?|skills?|training|history|records?|background)`;
const CRIME_ING = String.raw`(?:shoplift|traffick|kidnapp|stalk|gambl|launder|smuggl|poach|carjack|hack|trespass|loiter|racketeer|counterfeit|deal|pend|outstand)ing`;
/** One word saying what kind of record it is ("prior", "violent", "drug-related", "domestic violence"). */
const KIND = String.raw`(?:(?!${DRIVING}\b)(?!${NOT_A_KIND}\b)(?!(?!${CRIME_ING}\b)[a-z'’]*ing\b)[a-z'’]+[\s-]+)`;
/**
 * What a ban may put before it, as few words as will do: "any", "a history of", a list ("No DUIs or felonies") and up to
 * three words saying the kind ("prior", "violent crime", "drug-related", "domestic violence"). Matching as little as it
 * can keeps the words of a flag found before, and so its keep.
 */
const RECORD_LEAD_IN = String.raw`(?:(?:a|an|any)\s+)?(?:(?:history|record)\s+of\s+(?:(?:a|an|any)\s+)?)?(?:[\w'’-]+(?:\s+[\w'’-]+)??(?:\s+or|\s+and|\s*,|\s*/)\s+){0,2}?${KIND}{0,3}?`;
/**
 * A check, a search, questions or a requirement about it come next, which is no ban ("No criminal background check until
 * after an offer", "We do not have a criminal record requirement").
 */
const NOT_A_CHECK = String.raw`(?!(?:[\s-]+(?:felon\w*|convictions?|criminal|arrests?|history|histories|records?|backgrounds?)){0,2}[\s-]+(?:checks?|checking|screenings?|search(?:es)?|reports?|questions?|inquir\w*|box(?:es)?|requirements?|polic(?:y|ies))\b)`;
/**
 * Words after a record, or after the rest of a list of them, that say it counts against nobody ("No conviction
 * automatically disqualifies you", "No felony or misdemeanor conviction will disqualify you", "No one with a record is
 * turned away", "No arrest is held against you", "No degree, convictions considered case by case").
 */
const NOT_A_BAN_TAIL = String.raw`(?:(?:\s+(?:or|and)|\s*,)?(?:\s+[\w'’-]+){1,3}?)?[\s,]+(?:(?:will|would|shall|does|do|is|are|can|may|gets?)\s+(?:(?:not|never|ever)\s+)?)?(?:be\s+)?(?:automatically\s+)?(?:disqualif\w*|bars?\b|barring|(?:held|counted|used)\s+against|turned\s+away|excluded|rejected|considered\s+(?:case[\s-]+by[\s-]+case|individually|on\s+(?:a|an)\s+(?:case|individual)))`;
const NOT_A_BAN_AFTER = `(?!${NOT_A_BAN_TAIL})`;
const NOT = String.raw`(?:\s+not|n['’]?t)`;
const SOMEONE = String.raw`(?:anyone|anybody|someone|people|persons?|applicants?|candidates?|individuals?|those|workers?|employees?)`;
const IF_YOU_HAVE = String.raw`(?:please\s+)?do${NOT}\s+apply\s+if\s+you(?:\s+(?:have|had)|['’]ve)(?:\s+(?:got|gotten))?`;
const DONE_TO = String.raw`(?:arrested|convicted|charged\s+with|incarcerated|imprisoned|jailed|found\s+guilty|in\s+(?:jail|prison)|to\s+(?:jail|prison))`;
/**
 * What was done to someone for a record, with what it was for ("convicted of a felony", "charged with a crime",
 * "arrested"), unless it then counts against nobody ("No one convicted of a felony will be automatically disqualified").
 */
const DONE_FOR_WHAT = String.raw`\s+(?:(?:of|for)\s+)?(?:(?:a|an|any)\s+)?${KIND}{0,3}?(?:${BAN_WORDS}|crimes?)\b`;
const DONE_FOR = String.raw`${DONE_TO}(?!(?:${DONE_FOR_WHAT})?${NOT_A_BAN_TAIL})(?:${DONE_FOR_WHAT})?\b`;
/**
 * Nobody, or nobody hired, of whom a record comes next: "No one with a record", "Won't hire felons" (a bare "record"
 * only after "with" or "who have", so "No candidate record is linked" and "nobody records a decision" are no ban).
 */
const RULED_OUT = String.raw`(?:no(?:body|\s+one|\s+${SOMEONE})|(?:won['’]?t|will\s+not|do${NOT}|does${NOT}|cannot|can\s+not|can['’]?t|never|not|refuse\s+to)\s+(?:hire|hiring|accept|accepting|employ|employing|take|taking)(?:\s+${SOMEONE})?)`;
/** Someone who was convicted, arrested or jailed ("anyone convicted of a felony", "people who have been arrested"). */
const DONE_TO_SOMEONE = String.raw`(?:who\s+(?:have|has|had)\s+(?:ever\s+)?been\s+|(?:ever\s+)?)${DONE_FOR}`;
/** Someone ruled out who is named for a record ("Felons will not be considered", "Applicants with a felony conviction…"). */
const RECORD_PEOPLE = String.raw`(?:${EX_PEOPLE}|felons|offenders|criminals|${SOMEONE}\s+(?:(?:with|who\s+(?:have|has|had))\s+${RECORD_LEAD_IN}(?:${BAN_WORDS}|records?(?![\s-]+of\b))\b${NOT_A_CHECK}|${DONE_TO_SOMEONE}))`;

/**
 * A blanket ban on a criminal record, in any common wording (review of the live-test fixes, 17 Nov 2026: "No felony
 * convictions" and "Felony-free" were stored, and of that fix: "No fraud convictions", "No ex-felons" and "Felons will
 * not be considered" still were): what names one after no, without, never, must not have, cannot have, free of, must not
 * carry or cannot hold ("No felony", "Without a criminal record", "Must not have any convictions", "No domestic violence
 * convictions"); "never convicted" and the like; a non-felon; its "-free" forms; someone ruled out for one ("No one with a
 * criminal record", "Won't hire felons", "We will not consider anyone with a criminal record", "Do not apply if you have
 * a felony", "Felons need not apply", "Felons will not be considered", "A felony disqualifies you"); and a "clean
 * record". Never what holds a record against nobody ("We do not hold a criminal record against anyone"), a background
 * check after an offer, or "Must pass a background check", which waits for counsel.
 */
const CRIMINAL_RECORD_BAN = new RegExp(
  [
    String.raw`\b(?:no|zero|without|free\s+(?:of|from)|never\s+(?:had|having|been|committed|received)|(?:must|may|should|shall|will|do|does|did)${NOT}\s+have|won['’]?t\s+have|(?:cannot|can\s+not|can['’]?t)\s+have)\s+${RECORD_LEAD_IN}${BAN_RECORD}\b${NOT_A_CHECK}${NOT_A_BAN_AFTER}`,
    String.raw`\b(?:(?:must|may|should|shall|will|do|does|did)${NOT}|won['’]?t|cannot|can\s+not|can['’]?t)\s+(?:hold|carry)\s+${RECORD_LEAD_IN}${BAN_RECORD}\b${NOT_A_CHECK}(?![^.?!;]*\bagainst\b)`,
    String.raw`\b(?:${RULED_OUT}\s+(?:with|who\s+(?:have|has|had))|${IF_YOU_HAVE})\s+${RECORD_LEAD_IN}(?:${BAN_WORDS}|records?(?![\s-]+of\b))\b${NOT_A_CHECK}${NOT_A_BAN_AFTER}(?![^.?!;]*\binto\s+(?:account|consideration)\b)`,
    String.raw`\b${RULED_OUT}\s+${RECORD_LEAD_IN}${BAN_RECORD}\b${NOT_A_CHECK}${NOT_A_BAN_AFTER}(?![^.?!;]*\binto\s+(?:account|consideration)\b)`,
    String.raw`\b${RULED_OUT}\s+${DONE_TO_SOMEONE}`,
    String.raw`\b(?:won['’]?t|will\s+not|do${NOT}|does${NOT}|cannot|can\s+not|can['’]?t|never|not|refuse\s+to)\s+consider(?:ing)?\s+${RECORD_PEOPLE}`,
    String.raw`\b${RECORD_PEOPLE}\s+(?:(?:will|would|shall|are|is|may)\s+(?:not|never)|won['’]?t|cannot|can\s+not|can['’]?t|aren['’]?t|isn['’]?t)\s+(?:be\s+)?(?:considered|hired|accepted|employed|eligible)\b`,
    String.raw`\b(?:never|(?:has|have|had)${NOT}|(?:must|may|should|shall|will|do|does|did)${NOT}\s+have|won['’]?t\s+have|(?:cannot|can\s+not|can['’]?t)\s+have|${IF_YOU_HAVE})\s+(?:(?:ever|once)\s+)?(?:been\s+)?${DONE_TO}\b`,
    String.raw`\b(?:not|never|cannot|can\s+not|can['’]?t)\s+(?:be\s+|been\s+)?(?:an?\s+(?:convicted\s+)?(?:felon|criminal)|(?:convicted\s+)?felons?)\b`,
    String.raw`\bnon[\s-]?felons?\b`,
    String.raw`\b(?:felon(?:y|ies|s)?|convictions?|arrests?|misdemeanou?rs?|criminal[\s-]+records?)[\s-]+free\b(?!\s+(?:is|are)\s+not\s+(?:required|needed|necessary)\b)`,
    String.raw`\b(?:${BAN_WORDS}|records?)\s+(?:need\s+not|needn['’]?t|should\s+not|shouldn['’]?t|(?:please\s+)?(?:do\s+not|don['’]?t))\s+apply\b`,
    String.raw`\b${BAN_RECORD}\s+(?:will|would|shall|is|are)\s+(?:be\s+)?(?:an?\s+)?(?:automatic(?:ally)?\s+)?disqualif\w*`,
    String.raw`(?:^|[.;:!?]\s+|\b(?:a|an|any)\s+)${RECORD_LEAD_IN}${BAN_RECORD}\s+(?:automatically\s+)?disqualif(?:y|ies)\b`,
    String.raw`\b(?:clean|spotless|unblemished)\s+(?:criminal\s+(?:records?|history|backgrounds?)|record|background)\b(?![\s-]+of\b)`,
  ].join("|"),
  "gi",
);

/**
 * A crime someone is charged with ("Were you ever charged with a crime?", "…with theft?"), never the work ("Were you
 * charged with opening the office?", "…with fraud prevention?").
 */
const CRIME = String.raw`(?:crimes?|felon(?:y|ies)|misdemeanou?rs?|(?:criminal\s+)?offen[cs]es?|theft|fraud|assault|battery|burglary|robbery|larceny|embezzlement|possession|vandalism|trespass\w*|arson|forgery|murder|manslaughter|homicide|rape|abuse|harassment|stalking|kidnapping|trafficking|shoplifting|violence)\b(?![\s-]+(?:prevention|reporting|training|cases?|claims?|investigations?|programs?|polic(?:y|ies)|compliance|awareness|files?|records?|reports?)\b)`;
/** "Charged" with a crime, or with nothing after it ("Were you charged?"), or "charged or convicted". */
const CHARGED = String.raw`charged(?:\s+with\s+(?:(?:a|an|any)\s+)?${KIND}{0,2}?${CRIME}|\s+or\s+convicted\b|(?=\s*(?:[?.!;,]|$)))`;
const DONE_TO_THEM = String.raw`(?:arrested|convicted|${CHARGED}|incarcerated|imprisoned|jailed|found\s+guilty|in\s+(?:jail|prison)|to\s+(?:jail|prison))`;

/**
 * A question about the candidate's own record, in the same words ("Are you a convicted felon?", "Any felony
 * convictions?", "Have you ever been convicted of a crime?", "Are you on probation or parole?", "Do you have any fraud
 * convictions?", "Are you an ex-felon?", "Do you have any pending charges?", "Is your record clean?"); a question in a
 * ban's own words is one too (`asks_record`). A background check after an offer is not asked about this way, and a
 * question about the people the work is with, or about the work ("Do you have experience researching criminal
 * records?", "In your last job, were you charged with opening the office?", "Do you have probation and parole
 * experience?"), passes (`firstOwnRecord`).
 */
const ASKS_ABOUT_RECORD = new RegExp(
  [
    String.raw`\b(?:have\s+you\s+(?:ever\s+)?|ever\s+)been\s+${DONE_TO_THEM}\b`,
    String.raw`\bwere\s+you\s+(?:ever\s+)?(?:arrested|convicted|${CHARGED}|incarcerated|imprisoned|jailed|found\s+guilty)\b`,
    String.raw`\b(?:have|had)\s+you\s+(?:ever\s+)?(?:committed|had|got|gotten|received)\s+(?:(?:a|an|any)\s+)?${KIND}{0,3}?(?:crimes?|offen[cs]es|${RECORD_WORDS})\b`,
    String.raw`\bdo\s+you\s+have\s+(?:(?:a|an|any)\s+)?${KIND}{0,3}?(?:offen[cs]es|${RECORD_WORDS})\b`,
    String.raw`\b(?:your|any)\s+${KIND}{0,3}?${RECORD}\b`,
    String.raw`\bcriminal[\s-]+(?:records?|history|histories|backgrounds?|convictions?|charges?|offen[cs]es?|past)\b`,
    String.raw`\bare\s+you\s+(?:an?\s+)?(?:(?:registered|convicted)\s+)?(?:(?:ex|non)[\s-]?(?:felon|offender|con|convict)|(?:sex\s+)?offender|felon|criminal|convict)\b`,
    String.raw`\bare\s+you\s+(?:currently\s+|now\s+)?on\s+(?:probation|parole)\b(?![\s-]+(?:at|in|with|from|during|for)\b)`,
    String.raw`\bon\s+(?:probation\s+(?:or|and|/)\s+parole|parole(?:\s+(?:or|and|/)\s+probation)?)\b`,
    String.raw`\bconvicted\s+(?:of|for)\s+(?:(?:a|an|any)\s+)?${KIND}{0,2}?${CRIME}`,
    String.raw`\b(?:felon(?:y|ies|s)?|convictions?|arrests?|misdemeanou?rs?|criminal[\s-]+records?)[\s-]+free\b`,
    String.raw`\b(?:pleaded|pled)\s+(?:guilty|no\s+contest|nolo\s+contendere)\b`,
    String.raw`\b(?:do|did)\s+you\s+have\s+(?:any\s+)?(?:pending|open|outstanding)\s+(?:criminal\s+)?charges?\b(?!\s+(?:on|to|for|in|at|from|with)\b)|\bcharges?\s+pending\s+against\s+you\b`,
    String.raw`\b(?:are|were)\s+you\s+(?:currently\s+|now\s+)?(?:awaiting|facing)\s+(?:trial|sentencing|charges)\b|\b(?:have|had)\s+you\s+(?:ever\s+)?served\s+(?:time|a\s+(?:jail|prison)\s+sentence)\b`,
    String.raw`\bis\s+your\s+(?:criminal\s+)?record\s+(?:clean|spotless|clear)\b`,
  ].join("|"),
  "gi",
);

/**
 * Words just before a match that make it no ban and no question about the candidate's record: a record welcomed either
 * way ("With or without a criminal record"), an arrest that is not one ("Arrests without a conviction are never
 * considered"), a "-free" said not to be needed ("You don't have to be felony-free to apply"), and nobody with one ("No
 * one with a criminal record will be automatically disqualified", where "No one with a criminal record" alone is a ban).
 */
const HELD_EITHER_WAY = /\bwith\s+or\s+(?:without\s+(?:(?:an?|any)\s+)?)?$|\b(?:arrests?|charges?)\s+$|\b(?:(?:do|does|need)\s+not|don['’]?t|doesn['’]?t|needn['’]?t)\s+(?:(?:have|need)\s+to\s+)?be\s+$|\bnot\s+(?:required|necessary|needed)\s+to\s+be\s+$|\bno(?:body|\s+one)\s+(?:with|who\s+(?:have|has|had)|(?:who\s+(?:have|has|had)\s+(?:ever\s+)?been\s+)?(?:arrested|convicted|charged)(?:\s+(?:of|for|with))?)\s+(?:(?:an?|any|prior|past|previous)\s+)*$/i;
/**
 * The people the work is with, just before words that would be a ban ("Experience supporting clients with no stable
 * housing or criminal records"): never "people", "individuals", "those" or "members", whom a ban names ("We only hire
 * people with a clean record").
 */
const SERVED = String.raw`(?:clients?|patients?|residents?|youths?|teens?|juveniles?|students?|families|participants?|customers?|populations?|inmates?|parolees?|probationers?)\s+`;
const SERVED_WITH = new RegExp(String.raw`\b${SERVED}(?:with|who\s+(?:have|has|had))\s+(?:(?:an?|any|prior|past|previous)\s+)*$`, "i");
/** Anyone else a question can be about ("Have you worked with people who have a criminal record?", "clients on parole"). */
const PEOPLE = String.raw`(?:clients?|patients?|people|persons?|individuals?|residents?|youths?|teens?|juveniles?|adults?|students?|families|members?|participants?|customers?|those|others|populations?|inmates?|parolees?|tenants?|defendants?|employees?|workers?|staff|applicants?|candidates?|offenders?|victims?)\s+`;
const PEOPLE_WITH = new RegExp(String.raw`\b${PEOPLE}(?:(?:with|who\s+(?:have|has|had))\s+(?:(?:an?|any|prior|past|previous)\s+)*|(?:who\s+(?:are|were)\s+)?(?:currently\s+)?(?:on|under)\s+)$`, "i");
/** The same people just before what was done to them ("clients on parole", "clients convicted of a felony"). */
const PEOPLE_JUST_BEFORE = new RegExp(String.raw`\b${PEOPLE}(?:who\s+(?:are|were|have\s+been|has\s+been|had\s+been)\s+)?(?:currently\s+|recently\s+|ever\s+|once\s+)?$`, "i");
const DONE_TO_START = /^(?:on|convicted|arrested|charged|incarcerated|imprisoned|jailed)\b/i;
/** …unless those people are the candidate ("Are you a person with a criminal record?", "Are you one of those with a felony?"). */
const THE_CANDIDATE = new RegExp(String.raw`\b(?:are|were)\s+you\s+(?:(?:a|an|one\s+of(?:\s+(?:the|those|these))?|among(?:\s+(?:the|those|these))?)\s+)?(?:${PEOPLE})+(?:(?:with|who|that)\b[^?.!;]*)?$`, "i");
/** The work done with records just before a match ("Have you handled criminal charges?", "experience researching criminal records"). */
const WORK_ON_RECORDS = /\b(?:research\w*|handl\w*|process\w*|review\w*|retriev\w*|search\w*|pull\w*|expung\w*|seal\w*|defend\w*|prosecut\w*|investigat\w*|fil(?:e|es|ed|ing)|track\w*|manag\w*|verif\w*|order\w*|obtain\w*|request\w*|interpret\w*|run|ran|running|conduct\w*|perform\w*|(?:work(?:s|ed|ing)?|familiar|experience[ds]?|knowledge|trained|skilled))(?:\s+(?:on|with|in|of|for))?\s+(?:(?:the|a|an|any|their)\s+)?$/i;
/**
 * A check right after a match, put after an offer in the same sentence ("…a criminal background check after a
 * conditional offer?", "Offer contingent on a criminal background check"): in a question, no asking about the record.
 */
const A_CHECK = /^(?:[\s-]+(?:felon\w*|convictions?|criminal|arrests?|history|histories|records?|backgrounds?)){0,2}[\s-]+(?:checks?|screenings?)\b/i;
/** After a list, a record said to be welcome starts words of its own ("No experience needed, felons welcome"). */
const WELCOME_AFTER = /^[\s,]*(?:(?:are|is)\s+)?(?:welcome\w*|accepted|considered|ok|okay|fine|encouraged|friendly|allowed|eligible)\b/i;
/** "No" before a record that disqualifies: none does ("No felony or misdemeanor conviction will disqualify you"). */
const NONE_BEFORE = /\b(?:no|nor|not\s+(?:every|all|any|a|one)|never\s+(?:a|an|any))\s+(?:[\w'’]+(?:\s*,\s*|\s+|-)){0,4}$/i;
const OFFER_AFTER = /^[^.?!;]*\b(?:after|following|once|upon|until)\b[^.?!;]*\boffers?\b/i;
const OFFER_BEFORE = /\b(?:(?:after|following|once|upon)\b[^.?!;]*\boffers?|offers?\b[^.?!;]*\b(?:contingent|conditional|subject|dependent))\b[^.?!;]*$/i;

/**
 * The first match of `pattern` (a global regex) about the candidate's own record, or null. In a requirement (`ban`)
 * each match is a ban in its own words, so only the people the work is with come before one that is not (`SERVED_WITH`;
 * review of the criminal-record fix, 17 Nov 2026: "We only hire people with a clean record" passed). In a question, the
 * words may be about anyone the question names but the candidate, or about the work done with records, and a check may
 * be put after an offer.
 */
function firstOwnRecord(pattern: RegExp, reading: "ban" | "question"): (text: string) => string | null {
  return (text) => {
    for (const m of text.matchAll(pattern)) {
      const at = m.index ?? 0;
      // the words just before it are what count: the sentence it is in, at most
      const before = text.slice(Math.max(0, at - 400), at);
      if (HELD_EITHER_WAY.test(before) || (m[0].includes(",") && WELCOME_AFTER.test(text.slice(at + m[0].length))) || (/disqualif/i.test(m[0]) && NONE_BEFORE.test(before))) continue;
      if (reading === "ban") {
        if (SERVED_WITH.test(before)) continue;
      } else {
        const theirs = !THE_CANDIDATE.test(before) && (PEOPLE_WITH.test(before) || (DONE_TO_START.test(m[0]) && PEOPLE_JUST_BEFORE.test(before)));
        if (theirs || (!/^(?:you|your)\b/i.test(m[0]) && WORK_ON_RECORDS.test(before))) continue;
        const after = text.slice(at + m[0].length);
        const check = after.match(A_CHECK);
        if (check && (OFFER_AFTER.test(after.slice(check[0].length)) || OFFER_BEFORE.test(before))) continue;
      }
      return m[0].replace(/^[.;:!?]\s+/, "");
    }
    return null;
  };
}

const asksAboutRecord = firstOwnRecord(ASKS_ABOUT_RECORD, "question");
const asksInBanWords = firstOwnRecord(CRIMINAL_RECORD_BAN, "question");

/** The deterministic phrase list (C1). Each rule says why in plain words and offers the lawful way to get at the real need. */
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
    find: firstOwnRecord(CRIMINAL_RECORD_BAN, "ban"),
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

/**
 * A record named on its own at the start of the words ("Felony convictions", "A criminal record", "Felons", "Has a
 * felony", "Convicted of a felony", "Arrest record", "Pending charges"): as a deal-breaker, what rules someone out, so
 * the ban itself (review of the criminal-record fix, 17 Nov 2026: it was stored and offered back as the must-have
 * "Felony convictions"). A check is no record ("Criminal background check after a conditional offer", "Cannot pass a
 * background check"), nor is the work ("Experience supporting clients with a criminal record") or a driving record ("DUI
 * convictions", "Moving violations").
 */
const RECORD_NAMED = new RegExp(String.raw`^\s*(?:(?:has|have|had|got|gotten|received|committed)\s+(?:(?:ever\s+)?been\s+)?)?(?:${RECORD_LEAD_IN}(?:${BAN_WORDS}|crimes?|(?:pending|open|outstanding)[\s-]+charges?)\b${NOT_A_CHECK}|(?:ever\s+)?(?:been\s+)?${DONE_TO}\b)`, "i");

/** The phrase list as it reads a deal-breaker: a record named on its own is the ban too, in all its words (`RECORD_NAMED`). */
const DEAL_BREAKER_RULES: readonly ProxyRule[] = PROXY_RULES.map((r) => (r.rule === "criminal_record" ? { ...r, find: (text: string) => r.find(text) ?? (RECORD_NAMED.test(text) ? text.trim() : null) } : r));

/**
 * The fairness check for one deal-breaker (the quick start's "What rules someone out?", the panel, a card, one the job
 * builder read from the chat): `screenCriterion`, and a record named on its own is refused too.
 */
export function screenDealBreaker(text: string): CriterionCheck | null {
  for (const r of DEAL_BREAKER_RULES) {
    const hit = r.find(text);
    if (hit) return { rule: r.rule, text: hit, reason: r.reason, alternative: r.alternative };
  }
  return null;
}

/**
 * Questions put to candidates that ask about a protected characteristic itself (Wave S7, "Questions every applicant
 * answers"): a company's quick or written question, or a question typed in the quick start. The phrase list above reads
 * requirements ("male only", "no kids"); these read questions ("What is your gender?", "Do you have children?"). A
 * question that breaks one is refused when it is set, never kept with a reason: there is no lawful reason to ask it on an
 * application. Each says why in plain words and offers the lawful way to the real need. The patterns ask about the
 * candidate ("your age", "are you married"), so "Experience caring for patients with disabilities", "Experience
 * supporting clients with a criminal record" or "Are you at least 18?" (a legal minimum age) pass.
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
    find: (text) => asksAboutRecord(text) ?? asksInBanWords(text),
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

/**
 * One reason a company's question cannot be saved: which list ("quick" on the form, "written" in the chat), its place in
 * that list, which part of it (the question, its help line, an option, or the private "what a good answer shows"), and
 * the rule with its plain reason and the lawful alternative.
 */
export type CompanyQuestionProblem = { list: "quick" | "written"; index: number; key: string | null; part: "question" | "help" | "option" | "lookFor"; rule: string; text: string; reason: string; alternative: string };

type QuestionWords = { key?: string | null; question: string; help?: string | null; options?: readonly string[]; lookFor?: string | null };

/**
 * The questions every applicant answers (Wave S7), checked before they are saved: any part that asks about a protected
 * characteristic is refused (never kept with a reason, unlike a flagged phrase). Wording the phrase list flags elsewhere
 * ("10+ years of experience") is not refused here; the packet guard flags it as everywhere else, and approval waits for
 * a person to decide. Reads the shape the editor sends as well as the saved one.
 */
export function companyQuestionProblems(cq: { quick?: readonly QuestionWords[]; written?: readonly QuestionWords[] } | null | undefined): CompanyQuestionProblem[] {
  const out: CompanyQuestionProblem[] = [];
  const check = (list: "quick" | "written", index: number, key: string | null, part: CompanyQuestionProblem["part"], text: string | null | undefined, question = "") => {
    if (!text?.trim()) return;
    for (const r of PROTECTED_QUESTION_RULES) {
      const hit = r.find(text);
      if (hit) {
        out.push({ list, index, key, part, rule: r.rule, text: hit, reason: r.reason, alternative: r.alternative });
        return;
      }
    }
    // the phrase list's protected-characteristic rules ("under 30", "male only", "native English") and a ban on a criminal
    // record are refused here too
    const phrase = screenCriterion(text);
    if (phrase && REFUSED_PHRASE_RULES.has(phrase.rule)) {
      out.push({ list, index, key, part, rule: phrase.rule, text: phrase.text, reason: phrase.reason, alternative: phrase.alternative });
      return;
    }
    if (part === "option" && (TRAIT_OPTION.test(text) || (AGE_BRACKET.test(text) && !COUNTS_SOMETHING.test(question)))) out.push({ list, index, key, part, rule: TRAIT_OPTION_RULE.rule, text: text.trim(), reason: TRAIT_OPTION_RULE.reason, alternative: TRAIT_OPTION_RULE.alternative });
  };
  for (const [list, items] of [["quick", cq?.quick ?? []], ["written", cq?.written ?? []]] as const) {
    for (const [i, q] of items.entries()) {
      const key = q.key ?? null;
      check(list, i, key, "question", q.question);
      check(list, i, key, "help", q.help);
      for (const o of q.options ?? []) check(list, i, key, "option", o, q.question);
      check(list, i, key, "lookFor", q.lookFor);
    }
  }
  return out;
}

/** What a person reads when a company question is refused: the question's place, the reason and the lawful alternative. */
export function companyQuestionProblemWords(p: CompanyQuestionProblem): string {
  const where = `${p.list === "quick" ? "Quick question" : "Written question"} ${p.index + 1}`;
  const part = p.part === "option" ? `, the answer "${p.text}"` : p.part === "help" ? ", its help line" : p.part === "lookFor" ? ", what a good answer shows" : "";
  return `${where}${part}: ${p.reason} ${p.alternative}`;
}

/** The packet's own questions every applicant answers, whatever kind of packet it is (a draft has none). */
function companyQuestionsIn(p: DraftRolePacket): CompanyQuestions | null {
  return (p as DraftRolePacket & { companyQuestions?: CompanyQuestions | null }).companyQuestions ?? null;
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
function readableText(p: DraftRolePacket): Array<{ path: string; at: string; text: string; asked?: true; dealBreaker?: true; requirement?: true }> {
  const out: Array<{ path: string; at: string; text: string; asked?: true; dealBreaker?: true; requirement?: true }> = [];
  const add = (path: string, at: string, text: string | undefined, kind?: { dealBreaker: true } | { requirement: true }) => {
    if (text?.trim()) out.push({ path, at, text, ...kind });
  };
  // The questions every applicant answers (Wave S7) are read for the protected-question list too (`asked`).
  const ask = (path: string, at: string, text: string | undefined) => {
    if (text?.trim()) out.push({ path, at, text, asked: true });
  };
  const one = (path: string, text: string | undefined) => add(path, path, text);
  one("identity.title", p.identity.title);
  one("description.publicJobDescription", p.description.publicJobDescription);
  one("description.internalNotes", p.description.internalNotes);
  for (const [i, m] of p.requirements.mustHaves.entries()) add(`requirements.mustHaves[${i}].text`, `requirements.mustHaves[${m.key}].text`, m.text, { requirement: true });
  for (const [i, m] of p.requirements.niceToHaves.entries()) add(`requirements.niceToHaves[${i}].text`, `requirements.niceToHaves[${m.key}].text`, m.text, { requirement: true });
  for (const [i, e] of p.requirements.eligibility.entries()) add(`requirements.eligibility[${i}].question`, `requirements.eligibility[${e.key}].question`, e.question);
  for (const [i, q] of p.screening.questions.entries()) add(`screening.questions[${i}].question`, `screening.questions[${q.key}].question`, q.question);
  for (const [i, c] of p.competencies.entries()) add(`competencies[${i}].definition`, `competencies[${c.key}].definition`, c.definition);
  for (const [i, c] of p.evaluation.criteria.entries()) add(`evaluation.criteria[${i}]`, `evaluation.criteria[${slug(c)}]`, c);
  for (const [i, c] of p.evaluation.redFlags.entries()) add(`evaluation.redFlags[${i}]`, `evaluation.redFlags[${slug(c)}]`, c);
  for (const [i, r] of p.interviews.plan.entries()) {
    for (const [j, q] of r.suggestedQuestions.entries()) add(`interviews.plan[${i}].suggestedQuestions[${j}]`, `interviews.plan[${r.key}].suggestedQuestions[${slug(q)}]`, q);
  }
  for (const [i, d] of p.preferences.dealBreakersInTheirWords.entries()) add(`preferences.dealBreakersInTheirWords[${i}]`, `preferences.dealBreakersInTheirWords[${slug(d)}]`, d, { dealBreaker: true });
  one("communication.companyBlurb", p.communication.companyBlurb);
  const cq = companyQuestionsIn(p);
  for (const [i, q] of (cq?.quick ?? []).entries()) {
    ask(`companyQuestions.quick[${i}].question`, `companyQuestions.quick[${q.key}].question`, q.question);
    ask(`companyQuestions.quick[${i}].help`, `companyQuestions.quick[${q.key}].help`, q.help);
    if (q.kind === "choice") for (const [j, o] of q.options.entries()) ask(`companyQuestions.quick[${i}].options[${j}]`, `companyQuestions.quick[${q.key}].options[${slug(o)}]`, o);
  }
  for (const [i, q] of (cq?.written ?? []).entries()) {
    ask(`companyQuestions.written[${i}].question`, `companyQuestions.written[${q.key}].question`, q.question);
    ask(`companyQuestions.written[${i}].lookFor`, `companyQuestions.written[${q.key}].lookFor`, q.lookFor);
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
    // Founder decision Q9: the pay range is on every job ad, whatever the state's law says.
    if (!comp.discloseRange) {
      comp.discloseRange = true;
      changes.push("The pay range is shown on the job ad.");
    }
    if (comp.min > comp.max) {
      [comp.min, comp.max] = [comp.max, comp.min];
      changes.push("The pay range was the wrong way round and was swapped.");
    }
    if (comp.ceiling < comp.max) {
      comp.ceiling = comp.max;
      changes.push("The private ceiling was raised to the top of the range.");
    }
  }
  if (!packet.communication.disclosureText || !/\bAI\b|artificial intelligence/i.test(packet.communication.disclosureText)) packet.communication.disclosureText = disclosureLine(ctx.companyName);
  if (!packet.communication.humanAlternativeText?.trim()) packet.communication.humanAlternativeText = "Reply HUMAN at any time and a person from our team will follow up.";
  if (packet.requirements.mustHaves.length > 6) {
    packet.requirements.mustHaves = packet.requirements.mustHaves.slice(0, 6);
    changes.push("Must-haves were cut to six.");
  }
  // A skill's importance as a person picked it (plan F3) is what counts; the 1-5 weight is kept in step with it.
  for (const c of packet.competencies) if (c.importance && c.weight !== IMPORTANCE_WEIGHT[c.importance]) c.weight = IMPORTANCE_WEIGHT[c.importance];

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
  const count = () => packet.requirements.mustHaves.length + packet.requirements.niceToHaves.length + packet.preferences.dealBreakersInTheirWords.length + packet.evaluation.redFlags.length;
  const before = count();
  const keptMust = packet.requirements.mustHaves.filter((m) => !mentionsDeclined(m.text));
  // A list never loses its last must-have here (the schema needs one); that one is flagged below instead.
  if (keptMust.length) packet.requirements.mustHaves = keptMust;
  packet.requirements.niceToHaves = packet.requirements.niceToHaves.filter((m) => !mentionsDeclined(m.text));
  packet.preferences.dealBreakersInTheirWords = packet.preferences.dealBreakersInTheirWords.filter((d) => !mentionsDeclined(d));
  packet.evaluation.redFlags = packet.evaluation.redFlags.filter((r) => !mentionsDeclined(r));
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
  // A deal-breaker is read as one (`DEAL_BREAKER_RULES`: a record named on its own is the ban), and a must-have or a
  // nice-to-have in the words of a deal-breaker refused for a record ("Felony convictions" under the deal-breaker "Felony
  // convictions", "Felonies" under "No felonies") is flagged with it, as the quick start refuses both (review of the
  // criminal-record fix, 17 Nov 2026).
  const record = DEAL_BREAKER_RULES.find((r) => r.rule === "criminal_record");
  const restatesRecordBan = new Set(packet.preferences.dealBreakersInTheirWords.filter((d) => record?.find(d)).flatMap((d) => restatementsOf(d).map(normalizeCriterion)));
  for (const target of readableText(packet)) {
    for (const r of target.asked ? [...PROTECTED_QUESTION_RULES, ...PROXY_RULES] : target.dealBreaker ? DEAL_BREAKER_RULES : PROXY_RULES) {
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
  // A draft with no confirmed pay must not quote a figure anywhere (C7): nobody set it. With pay set, the description may
  // quote only the advertised range: a figure from before the pay changed, or the private ceiling, is flagged, since the
  // pay set by a person is brought up to date on its own but the description's words are not.
  const description = packet.description.publicJobDescription;
  if (!packet.compensation) {
    const money = description.match(/\$\s?\d[\d,.]*(?:\s*(?:k|an hour|per hour|\/hr|a year|per year))?/i);
    if (money) push("description.publicJobDescription", { path: "description.publicJobDescription", rule: UNCONFIRMED_PAY.rule, text: money[0], reason: UNCONFIRMED_PAY.reason, alternative: UNCONFIRMED_PAY.alternative });
  } else {
    const range = new Set([packet.compensation.min, packet.compensation.max]);
    for (const m of description.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi)) {
      const amount = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
      if (!range.has(amount)) push("description.publicJobDescription", { path: "description.publicJobDescription", rule: PAY_MISMATCH.rule, text: m[0].trim(), reason: PAY_MISMATCH.reason, alternative: PAY_MISMATCH.alternative });
    }
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

/** The flags nobody has dealt with yet; approval waits for none to be left. */
export function unresolvedFlags(packet: { provenance: { flags?: PacketFlag[] } } | null | undefined): PacketFlag[] {
  return (packet?.provenance.flags ?? []).filter((f) => !f.kept);
}

/** What a person reads when approval is refused for open flags. */
export function openFlagsMessage(count: number): string {
  return `${count === 1 ? "One phrase in this role needs" : `${count} phrases in this role need`} a decision first: edit ${count === 1 ? "it" : "them"} out, or keep ${count === 1 ? "it" : "them"} and say why.`;
}
