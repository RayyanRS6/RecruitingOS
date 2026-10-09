import { DECLINE_REASON_LABEL, PERSONAL_LINE_MAX, RejectReason } from "@ros/contracts";
import { redactProtected } from "./screening";

/**
 * The personal line a person may add to a decision message, an interview invitation or an update (founder decision Q28,
 * plan G6), and the line the assistant suggests for an invitation or an update. Checked before anything is sent: a line
 * never carries a score or rating, how the assistant placed or read the person, the reason recorded for the decision, or
 * anything about a personal characteristic. A refusal says exactly what to take out. The wording of the decision itself
 * stays the approved wording; the line only adds a human touch.
 */
export type PersonalLineCheck = { ok: true; text: string } | { ok: false; problems: string[]; message: string };

// The recorded reasons as codes and as the team reads them; "other", "position filled" and "role closed" are everyday words.
const PLAIN = new Set<string>(["other", "position_filled", "role_closed"]);
const REASON_WORDS = [
  ...RejectReason.options.filter((r) => r !== "other"),
  ...RejectReason.options.filter((r) => !PLAIN.has(r)).map((r) => r.replace(/_/g, " ")),
  ...RejectReason.options.filter((r) => !PLAIN.has(r)).map((r) => DECLINE_REASON_LABEL[r]),
];

const BLOCKED: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: "a score or rating", pattern: /\b(?:scor(?:e|es|ed|ing)|ratings?|rated|rank(?:s|ed|ing)?|percentile|percent)\b|\d+\s*%|\b\d+\s*\/\s*\d+\b|\b\d+\s+out\s+of\s+\d+\b|\b\d+\s+points?\b/i },
  { what: "how the assistant placed or read them", pattern: /\b(?:(?:strong|good|possible|weak)\s+match|match\s+score|short-?list(?:ed)?|long-?list(?:ed)?|assess(?:ment|ments|ed)?|evaluat(?:ion|ions|ed)|evidence|must-?haves?|criteria|criterion|disqualif\w*|(?:un|over|under-?)qualified|not\s+qualified|red\s+flags?|the\s+(?:ai|assistant|algorithm|software|system)|artificial\s+intelligence|automated)\b/i },
  { what: "the reason recorded for the decision", pattern: new RegExp(`\\b(?:reason\\s+codes?|eligibility|${REASON_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i") },
  { what: "a personal characteristic", pattern: /\b(?:age|aged|years\s+old|older|younger|young|elderly|retire\w*|race|racial|ethnic\w*|skin\s+colou?r|religio\w*|church|mosque|synagogue|faith|gender|sex|sexual|orientation|transgender|pregnan\w*|maternity|paternity|disab\w*|handicap\w*|wheelchair|medical|illness|diagnos\w*|health\s+condition|accent|national\s+origin|nationality|immigra\w*|citizen\w*|visa|green\s+card|married|marital|divorc\w*|spouse|husband|wife|children|kids|childcare|family\s+(?:status|situation|plans)|veteran|military\s+status|genetic\w*)\b/i },
];

/** Checks a personal line; the text comes back tidied (one paragraph, trimmed) when it may be sent. */
export function checkPersonalLine(line: string): PersonalLineCheck {
  const text = line.replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, problems: ["empty"], message: "Write the personal line first, or leave it out." };
  if (text.length > PERSONAL_LINE_MAX) return { ok: false, problems: ["too long"], message: `Keep the personal line to ${PERSONAL_LINE_MAX} characters, one or two sentences.` };
  const problems: string[] = [];
  const found: string[] = [];
  for (const b of BLOCKED) {
    const m = text.match(b.pattern);
    if (m) { problems.push(b.what); found.push(m[0]); }
  }
  // The screening rule for protected details volunteered in an answer catches what the list above does not ("I'm 52").
  if (!problems.includes("a personal characteristic") && redactProtected(text) !== text) problems.push("a personal characteristic");
  if (!problems.length) return { ok: true, text };
  const words = found.length ? ` Take out ${found.map((f) => `"${f}"`).join(", ")} and try again.` : " Reword it and try again.";
  return { ok: false, problems, message: `A personal line can't mention ${problems.join(", ")}. It must not hint at scores, how anyone was assessed, why the decision was made, or anything personal such as age, family, health, religion or background.${words}` };
}
