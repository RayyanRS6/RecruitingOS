import type { LegalCheck, LegalCheckItem, Location } from "@ros/contracts";
import { closingDayWords } from "./closing-date";

/**
 * Regulation as configuration. Notice texts are versioned defaults; a rewording stored in a
 * company's settings takes a default's place; every display is recorded with the version shown. Items
 * marked [counsel] must be reviewed by an attorney before use with paying customers.
 */

export type NoticeKey = "ai_use" | "privacy" | "pay_transparency" | "adverse_decision_explanation";

export type Notice = { key: NoticeKey; version: string; jurisdictions: string[]; text: string };

export const DEFAULT_NOTICES: Notice[] = [
  {
    key: "ai_use",
    // Nothing reads a reply for a keyword, so the notice names the two ways to a person that work: the contact on the job page, and the links in our messages.
    version: "2026-11-18",
    jurisdictions: ["*"],
    text:
      "This employer uses software that includes artificial intelligence to help organize applications, ask screening questions, and summarize information for the hiring team. " +
      "People make the hiring decisions. You can ask to talk to a person at any point: before you apply, use the contact on the job page; after you apply, write to that contact or use the link in any of our messages.",
  },
  {
    key: "privacy",
    version: "2026-09-01",
    jurisdictions: ["*"],
    text:
      "We collect the information you provide to consider you for employment. It is kept no longer than the law requires; during this pilot a person carries out deletion on request or on schedule, and you can ask at any time. " +
      "You may request access to, correction of, or deletion of your information using the privacy link on any page.",
  },
  {
    key: "pay_transparency",
    version: "2026-09-01",
    jurisdictions: ["US-CA", "US-CO", "US-NY", "US-WA", "US-HI", "US-IL", "US-MD", "US-MN", "US-NJ", "US-VT", "US-MA"],
    text: "The pay range for this position is shown above as required by law.",
  },
  {
    key: "adverse_decision_explanation",
    version: "2026-09-01",
    jurisdictions: ["US-CO"],
    text: "If you are not selected, you may request the reasons for the decision and a review by a person.",
  },
];

/** Jurisdictions applicable to a candidate touch: company + role locations + candidate location. */
export function resolveJurisdictions(locations: Array<Location | null | undefined>, candidateRegion?: string | null): string[] {
  const set = new Set<string>();
  for (const l of locations) {
    if (l?.region) set.add(`${l.country ?? "US"}-${l.region.toUpperCase()}`);
  }
  if (candidateRegion) set.add(`US-${candidateRegion.toUpperCase()}`);
  return [...set];
}

export function noticesFor(jurisdictions: string[], overrides?: Record<string, { version: string; text: string; jurisdictions: string[] }>): Notice[] {
  const out: Notice[] = [];
  for (const n of DEFAULT_NOTICES) {
    const o = overrides?.[n.key];
    const notice: Notice = o ? { key: n.key, version: o.version, text: o.text, jurisdictions: o.jurisdictions } : n;
    if (notice.jurisdictions.includes("*") || notice.jurisdictions.some((j) => jurisdictions.includes(j))) out.push(notice);
  }
  return out;
}

/** The notices a job's public pages carry: from the job's and the company's locations, in the company's own wording. */
export function jobNoticesFor(input: { jobLocations: Array<Location | null | undefined>; companyLocations?: Array<Location | null | undefined>; overrides?: Record<string, { version: string; text: string; jurisdictions: string[] }> }): Notice[] {
  return noticesFor(resolveJurisdictions([...input.jobLocations, ...(input.companyLocations ?? [])]), input.overrides);
}

/** Whether a pay transparency law covers the job: its notice is among the job's notices. */
export function payTransparencyApplies(notices: Notice[]): boolean {
  return notices.some((n) => n.key === "pay_transparency");
}

/**
 * Whether candidates see the pay range (Wave 0 item 0.8): when the owner chose to show it, and always where a pay
 * transparency law covers the job, since that notice tells the candidate the range is "shown above". The job page, the
 * apply form, the screening assistant and the owner's role page all ask this one question.
 */
export function payShown(compensation: { discloseRange: boolean }, notices: Notice[]): boolean {
  return compensation.discloseRange || payTransparencyApplies(notices);
}

/**
 * The line a decision message carries for a candidate covered by Colorado's rules on adverse decisions: the job is in
 * Colorado, or the candidate is. DRAFT WORDING PENDING COUNSEL (docs/legal-drafts/counsel-register.md item 24): the
 * text, its version and the 30-day window are placeholders until counsel answers; nothing goes to real candidates first.
 * A reply to a decision message lands with the company's own hiring contact when it set one, otherwise in the reply
 * mailbox a person at ITS reads (packages/agents/src/coordinator.ts, `replyToFor`), and never with the assistant. With a
 * contact of its own, who answers, and so the line's "someone who was not part of the decision", is the company's to keep.
 */
export const ADVERSE_DECISION_LINE = {
  key: "adverse_decision_explanation" as const,
  version: "2026-11-18-draft",
  counselStatus: "draft" as const,
  jurisdictions: ["US-CO"],
  text: "Colorado: you may ask us to explain the main reasons for this decision and to have a person review it. Reply to this email within 30 days, and someone who was not part of the decision will answer you.",
};

const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC", "washington dc": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const STATE_CODE_SET = new Set(Object.values(STATE_CODES));
/** The states' names, the longest first: "West Virginia" before "Virginia", "Washington DC" before "Washington". */
const STATE_NAMES = Object.keys(STATE_CODES).sort((a, b) => b.length - a.length);

/** What may follow a state code at the end of a place: a full stop, a ZIP code, the country. */
const AFTER_STATE_CODE = String.raw`\.?(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,\s*(?:US|USA|United States))?\s*$`;
/** A state code after a comma, in any case: "Denver, CO", "Irvine, CA 92618, USA". */
const CODE_AFTER_COMMA = new RegExp(String.raw`,\s*([A-Za-z]{2})${AFTER_STATE_CODE}`);
/** A state code in capitals as the last word, after another word and no comma: "Austin TX", "Boulder CO 80302". */
const CODE_AS_LAST_WORD = new RegExp(String.raw`[^\s,]\s+([A-Z]{2})${AFTER_STATE_CODE}`);
const stateCodeOf = (found: RegExpMatchArray | null): string | null => {
  const code = found?.[1]?.toUpperCase();
  return code && STATE_CODE_SET.has(code) ? code : null;
};

/**
 * The US state a candidate wrote as their location ("Denver, CO", "Boulder, Colorado 80302", "Colorado"), or null when
 * it cannot be told. Free text: only a state code after a comma or a state's full name counts, never a guess. A state's
 * name counts wherever it stands ("Colorado Springs" is Colorado): this reading decides whether a candidate gets a
 * state's line on a decision message, where reading one state too many only adds a line and missing one drops it. A
 * job's own place is read by `stateOfPlace`, which is stricter.
 */
export function regionFromLocationText(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const code = stateCodeOf(t.match(CODE_AFTER_COMMA));
  if (code) return code;
  const lower = t.toLowerCase();
  // "West Virginia" contains "virginia", "Washington DC" contains "washington": the longest name that matches wins.
  const named = STATE_NAMES.find((name) => new RegExp(`(^|[^a-z])${name}($|[^a-z])`).test(lower));
  return named ? STATE_CODES[named]! : null;
}

/**
 * The US state of a job's place as its owner wrote it ("Tustin, CA", "Reno, Nevada", "Austin TX"), or null when the
 * words do not say one. A job's state is on its page and decides its notices, and the job builder asks again when this
 * finds none, so it never guesses: a state's name inside a longer place name is not the state. "Kansas City" is as
 * often in Missouri as in Kansas, "Nevada City" is in California, and "Oklahoma City", "Virginia Beach" and "New York
 * City" say a city, not a state. What counts:
 * - the two-letter code after a comma, in any case, or in capitals as the last word after another word ("Austin TX");
 *   a ZIP code and the country may follow it;
 * - the full name where it ends one of the parts that commas separate ("New York", "Reno Nevada", "Boulder, Colorado
 *   80302"), or begins a part after the first ("Reno, Nevada area").
 * The last part that names a state is the one ("Indiana, Pennsylvania" is Pennsylvania), and within a part the longest
 * name ("West Virginia" is not Virginia).
 */
export function stateOfPlace(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const code = stateCodeOf(t.match(CODE_AFTER_COMMA)) ?? stateCodeOf(t.match(CODE_AS_LAST_WORD));
  if (code) return code;
  const letter = (ch: string) => /[a-z]/.test(ch);
  const parts = t.toLowerCase().split(",").map((part) => part.trim().replace(/\s+\d{5}(?:-\d{4})?$/, "").replace(/\.$/, ""));
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i]!;
    const named = STATE_NAMES.find((name) => (part.endsWith(name) && !letter(part.charAt(part.length - name.length - 1))) || (i > 0 && part.startsWith(name) && !letter(part.charAt(name.length))));
    if (named) return STATE_CODES[named]!;
  }
  return null;
}

/** The state a text is, when it is a state and nothing else: its code in any case, or its full name ("CO", "co.", "Colorado"). */
export function stateAlone(text: string | null | undefined): string | null {
  const t = (text ?? "").trim().replace(/\.$/, "");
  return STATE_CODES[t.toLowerCase()] ?? (STATE_CODE_SET.has(t.toUpperCase()) ? t.toUpperCase() : null);
}

/**
 * Whether words begin with this state, as its code in any case or its full name: what follows a city in a person's own
 * words when they wrote the state with it ("Denver, CO", "denver co", "Denver, Colorado").
 */
export function beginsWithState(words: string, state: string): boolean {
  const t = words.replace(/^[\s,.(]+/, "").toLowerCase();
  return [state.toLowerCase(), ...STATE_NAMES.filter((name) => STATE_CODES[name] === state)].some((s) => t.startsWith(s) && !/[a-z]/.test(t.charAt(s.length)));
}

/** Whether a decision message carries Colorado's line: the job is in Colorado, or the candidate wrote a Colorado location. */
export function adverseDecisionLineApplies(input: { jobLocations: Array<Location | null | undefined>; candidateLocationText?: string | null }): boolean {
  const places = resolveJurisdictions(input.jobLocations, regionFromLocationText(input.candidateLocationText));
  return places.some((p) => ADVERSE_DECISION_LINE.jurisdictions.includes(p));
}

/**
 * The three lines under an automated candidate email, in the code's own words and the same for every job: the AI
 * disclosure (`disclosureLine`), how to reach a person (`REACH_A_PERSON_LINE`) and who it is from
 * (`hiringTeamSignature`). The emails about an application take all three from here (packages/agents/src/coordinator.ts),
 * and the AI interview's first page takes the line about a person (packages/agents/src/screening.ts, `screenIntro`):
 * neither reads a job record for them. The record still holds a copy of each (`communication`), which the fairness
 * guard writes from here on every save (`guardPacket`), whatever a model wrote there: a notice a candidate reads is
 * never words of a model's that nobody read first.
 */

/** The AI disclosure under every automated candidate email. */
export function disclosureLine(companyName: string): string {
  return `This message was sent by the hiring team at ${companyName} with help from an AI recruiting assistant.`;
}

/**
 * How to reach a person. It is true wherever it is shown: under an email, where a reply lands with a person
 * (packages/agents/src/coordinator.ts, `replyToFor`), and on the AI interview's first page, since every job page prints a
 * contact. Nothing reads a reply for a keyword, so it names none.
 */
export const REACH_A_PERSON_LINE = "To reach a person at any time, reply to any of our emails or use the contact on the job page.";

/** Who an automated candidate email is from: the company's hiring team, never a sign-off a model wrote. */
export function hiringTeamSignature(companyName: string): string {
  return `The hiring team at ${companyName}`;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* What the law asks of a job ad before it goes public (plan D5; Track L: counsel confirms the lists first).      */
/* ------------------------------------------------------------------------------------------------------------ */

/** The places with a pay transparency law for job ads: the pay_transparency notice's own list. [counsel] */
export const PAY_TRANSPARENCY_JURISDICTIONS: readonly string[] = DEFAULT_NOTICES.find((n) => n.key === "pay_transparency")?.jurisdictions ?? [];

/**
 * Candidates for that list, PENDING COUNSEL: Washington DC (pay range on job ads and health benefits before the first
 * interview) and Rhode Island (pay range on request and before discussing pay). Until our lawyer confirms them they are
 * named in the legal check as advisory, never block publishing, and are not added to the candidate notice.
 */
export const PAY_TRANSPARENCY_CANDIDATES: ReadonlyArray<{ jurisdiction: string; note: string; pendingCounsel: true }> = [
  { jurisdiction: "US-DC", note: "Washington DC asks for the pay range on job ads and for health benefits to be described before the first interview.", pendingCounsel: true },
  { jurisdiction: "US-RI", note: "Rhode Island asks for the pay range when a candidate asks, and before pay is discussed.", pendingCounsel: true },
];

/** Places whose law asks for a short description of the benefits on the job ad, besides the pay range. [counsel] */
export const BENEFITS_DESCRIPTION_JURISDICTIONS: readonly string[] = ["US-CO", "US-WA", "US-IL", "US-MN", "US-NJ", "US-MD"];

/** Places whose law asks the job ad to say when applications are expected to close (Colorado). [counsel] */
export const CLOSING_DATE_JURISDICTIONS: readonly string[] = ["US-CO"];

const PLACE_NAME: Record<string, string> = {
  "US-CA": "California", "US-CO": "Colorado", "US-NY": "New York", "US-WA": "Washington", "US-HI": "Hawaii", "US-IL": "Illinois", "US-MD": "Maryland",
  "US-MN": "Minnesota", "US-NJ": "New Jersey", "US-VT": "Vermont", "US-MA": "Massachusetts", "US-DC": "Washington DC", "US-RI": "Rhode Island",
};

/** "Colorado and Washington", "California, Colorado and New York". */
export function placeNames(jurisdictions: readonly string[]): string {
  const names = jurisdictions.map((j) => PLACE_NAME[j] ?? j.replace(/^US-/, ""));
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The places a job ad answers to: where the job is, and for a remote job every place with a pay transparency law (and
 * the candidates pending counsel), since someone there could do it (plan D5).
 */
export function jobJurisdictions(input: { jobLocations: Array<Location | null | undefined>; remotePolicy?: string | null }): string[] {
  const set = new Set(resolveJurisdictions(input.jobLocations));
  if (input.remotePolicy === "remote") for (const j of [...PAY_TRANSPARENCY_JURISDICTIONS, ...PAY_TRANSPARENCY_CANDIDATES.map((c) => c.jurisdiction)]) set.add(j);
  return [...set].sort();
}

/** The benefits description the job page shows: the role's own, else the company's (Setup). Null when neither is written. */
export function benefitsDescriptionFor(compensation: { benefitsSummary?: string | null } | null | undefined, settings: { benefitsSummary?: string | null } | null | undefined): string | null {
  const own = compensation?.benefitsSummary?.trim();
  if (own) return own;
  const company = settings?.benefitsSummary?.trim();
  return company || null;
}

/** Whether the job ad must carry a closing date (Colorado, or a remote job someone in Colorado could do). */
export function closingDateRequired(input: { jobLocations: Array<Location | null | undefined>; remotePolicy?: string | null }): boolean {
  return jobJurisdictions(input).some((j) => CLOSING_DATE_JURISDICTIONS.includes(j));
}

/**
 * The legal check before a job is published (plan D5): for the job's places, the pay range, a short benefits
 * description and Colorado's closing date. A missing legal requirement blocks publishing (409 `not_ready`, one blocker
 * for each missing item); places pending counsel only add a note. A closing date the law needs and nobody set is not
 * missing: the role gets `defaultClosesOn` when it opens, and the item says so.
 */
export function postingLegalCheck(input: {
  packet: { identity: { locations: Location[]; remotePolicy?: string | null }; compensation?: { min: number; max: number; benefitsSummary?: string | null } | null };
  companySettings?: { benefitsSummary?: string | null } | null;
  closesOn?: string | null;
  defaultClosesOn?: string | null;
  today: string;
}): LegalCheck {
  const remote = input.packet.identity.remotePolicy === "remote";
  const jurisdictions = jobJurisdictions({ jobLocations: input.packet.identity.locations, remotePolicy: input.packet.identity.remotePolicy });
  const pending = PAY_TRANSPARENCY_CANDIDATES.map((c) => c.jurisdiction).filter((j) => jurisdictions.includes(j));
  const items: LegalCheckItem[] = [];

  const payPlaces = jurisdictions.filter((j) => PAY_TRANSPARENCY_JURISDICTIONS.includes(j));
  if (payPlaces.length || pending.length) {
    const c = input.packet.compensation;
    const met = !!c && c.min > 0 && c.max >= c.min;
    const counsel = pending.length ? ` The rules in ${placeNames(pending)} are still being checked by our lawyer.` : "";
    items.push({
      key: "pay_range", label: "Pay range on the job ad", met, blocking: payPlaces.length > 0, jurisdictions: payPlaces, pendingCounsel: pending,
      detail: met ? `The pay range is on the job ad.${counsel}` : `The law in ${placeNames(payPlaces.length ? payPlaces : pending)} asks for the pay range on the job ad, and this version has no usable range.${payPlaces.length ? counsel : ""}`,
      fix: met ? null : "Set the lowest and highest pay in the role's pay section.",
    });
  }

  const benefitPlaces = jurisdictions.filter((j) => BENEFITS_DESCRIPTION_JURISDICTIONS.includes(j));
  if (benefitPlaces.length) {
    const met = !!benefitsDescriptionFor(input.packet.compensation, input.companySettings);
    items.push({
      key: "benefits", label: "A short description of the benefits", met, blocking: true, jurisdictions: benefitPlaces, pendingCounsel: [],
      detail: met ? "The job ad describes the benefits." : `The law in ${placeNames(benefitPlaces)} asks for a short description of the benefits on the job ad${remote ? ", and this remote job could be done there" : ""}.`,
      fix: met ? null : "Describe the benefits in the job's pay section, or in Settings (used for every job).",
    });
  }

  const datePlaces = jurisdictions.filter((j) => CLOSING_DATE_JURISDICTIONS.includes(j));
  if (datePlaces.length) {
    const closesOn = input.closesOn ? input.closesOn.slice(0, 10) : null;
    const inPast = !!closesOn && closesOn < input.today;
    const defaulted = !closesOn && !!input.defaultClosesOn;
    items.push({
      key: "closing_date", label: "When applications close", met: !inPast && (!!closesOn || defaulted), blocking: true, jurisdictions: datePlaces, pendingCounsel: [],
      detail: inPast ? `The closing date, ${closingDayWords(closesOn)}, has passed. The law in ${placeNames(datePlaces)} asks the job ad to say when applications close.`
        : closesOn ? `Applications close at the end of ${closingDayWords(closesOn)}.`
        : defaulted ? `The law in ${placeNames(datePlaces)} asks the job ad to say when applications close, so the role gets ${closingDayWords(input.defaultClosesOn!)} as its closing date when it opens. You can change it at any time.`
        : `The law in ${placeNames(datePlaces)} asks the job ad to say when applications close.`,
      fix: inPast || (!closesOn && !defaulted) ? "Choose a closing date today or later." : null,
    });
  }

  return { jurisdictions, remote, items, missing: items.filter((i) => i.blocking && !i.met) };
}
