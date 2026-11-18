import { PROTECTED_QUESTION_RULES, PROXY_RULES } from "@ros/core";

/**
 * Questions about a protected characteristic, or one that stands for it, in the words a question would use: age and
 * birth, family, pregnancy, religion, health and disability, origin and citizenship, marriage, sex and orientation,
 * graduation year, criminal history, workers' compensation claims. Health, medication and medical history count only as
 * "your" (the candidate's): in a dental chat "their medical history" is the patients'.
 */
const PROTECTED_QUESTION = new RegExp(
  [
    String.raw`\bhow old\b`,
    String.raw`\b(?:your|their) (?:age|birthday|date of birth|religion|faith|church|nationality|ethnicity|race|accent|native language|first language|mother tongue|husband|wife|spouse|boyfriend|girlfriend|kids|children|family plans|pregnan\w*|disabilit\w*|citizenship|immigration status|visa status|maiden name|sexual\w*|gender|marital status)\b`,
    String.raw`\byour (?:health|diagnos\w*|medications?|medical (?:history|conditions?|records?))\b`,
    String.raw`\b(?:ever been|have you been) (?:arrested|convicted|charged)\b`,
    String.raw`\bcriminal (?:record|history|background)\b`,
    String.raw`\bconvictions?\b`,
    String.raw`\b(?:do|did) you (?:have|suffer from) (?:any|a) (?:health|medical|mental health) (?:issues?|problems?|conditions?)\b`,
    String.raw`\bwhen did you graduate\b`,
    String.raw`\bwhat year did you (?:finish|complete)\b`,
    String.raw`\bhow many (?:kids|children) (?:do you have|have you got)\b`,
    String.raw`\bchild ?care\b`,
    String.raw`\bworkers['’]? comp(?:ensation)?\b`,
    String.raw`\bdate of birth\b`,
    String.raw`\bwhen were you born\b`,
    String.raw`\bwhere (?:were you born|are you (?:originally )?from)\b`,
    String.raw`\bare you (?:married|single|divorced|pregnant|a (?:citizen|veteran|mother|father|parent)|planning (?:a family|to have))\b`,
    String.raw`\b(?:do|will) you (?:have|plan to have|want) (?:any )?(?:kids|children)\b`,
    String.raw`\b(?:childcare|child care) (?:arrangements?|situation|plans?)\b`,
    String.raw`\b(?:maternity|paternity) leave\b`,
    String.raw`\b(?:do|did) you (?:attend|go to) (?:a )?(?:church|mosque|synagogue|temple)\b`,
    String.raw`\b(?:religio\w*|disabilit\w*|pregnan\w*|marital status|nationality|ethnicity|citizenship status|immigration status|sexual orientation)\b`,
    String.raw`\bwhat year did you graduate\b`,
    String.raw`\bgraduation year\b`,
  ].join("|"),
  "i",
);

/**
 * The code's fairness check for words the AI wrote that a candidate will read as a question (a follow-up in the AI
 * interview): the phrase list every job is checked against (`PROXY_RULES`), the questions a company may never set
 * (`PROTECTED_QUESTION_RULES`: "Are you over 40?", "Are you a green card holder?") and the protected-question words
 * above. The rule broken, in plain words, or null.
 */
export function unfairQuestion(text: string): string | null {
  for (const rule of [...PROXY_RULES, ...PROTECTED_QUESTION_RULES]) {
    // a long minimum of years is a rule for job ads: a question may repeat the candidate's own "12 years of experience"
    if (rule.rule === "experience_floor") continue;
    const hit = rule.find(text);
    if (!hit) continue;
    // pay history is asked of the candidate ("your current pay", "how much do you make"); "the current pay range for this
    // role" is the job's own
    if ((rule.rule === "pay_history" || rule.rule === "asks_pay_history") && !aboutTheCandidate(text, hit)) continue;
    return rule.reason;
  }
  return PROTECTED_QUESTION.test(text) ? "It asks about a protected characteristic, which is never part of hiring." : null;
}

/** Whether the words `hit` in `text` are about the candidate: "you" or "your" in them or just before them. */
function aboutTheCandidate(text: string, hit: string): boolean {
  const at = text.toLowerCase().indexOf(hit.toLowerCase());
  const around = at < 0 ? text : text.slice(Math.max(0, at - 20), at + hit.length);
  return /\byou(?:r)?\b/i.test(around);
}
