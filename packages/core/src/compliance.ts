import type { LegalCheck, LegalCheckItem, Location } from "@ros/contracts";
import { closingDayWords } from "./closing-date";

/**
 * Regulation as configuration (docs/08). Notice texts are versioned defaults; companies can
 * override them in settings; every display is recorded with the version shown. Items marked
 * [counsel] in docs/00 must be reviewed by an attorney before use with paying customers.
 */

export type NoticeKey = "ai_use" | "sms_consent" | "recording" | "privacy" | "pay_transparency" | "adverse_decision_explanation";

export type Notice = { key: NoticeKey; version: string; jurisdictions: string[]; text: string };

export const DEFAULT_NOTICES: Notice[] = [
  {
    key: "ai_use",
    // 2026-10-08 (plan D10): before applying there is no message to reply to, so the notice says how to reach a person then too.
    version: "2026-10-08",
    jurisdictions: ["*"],
    text:
      "This employer uses software that includes artificial intelligence to help organize applications, ask screening questions, and summarize information for the hiring team. " +
      "People make the hiring decisions. You can ask to talk to a person at any point: before you apply, use the contact on the job page; after you apply, reply HUMAN to any of our messages or use the link in it.",
  },
  {
    key: "sms_consent",
    version: "2026-09-01",
    jurisdictions: ["*"],
    text:
      "Yes, you may send me text messages about this application (scheduling, questions, updates). Message and data rates may apply. Reply STOP to opt out at any time. Consent is not a condition of applying.",
  },
  {
    key: "recording",
    version: "2026-09-01",
    jurisdictions: ["*"],
    text: "This conversation may be recorded and transcribed for the hiring team, with your consent. Say or type \"I agree\" to continue, or tell us you prefer not to be recorded.",
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
 * apply form, the feeds, the board packages, the screening assistant and the owner's role page all ask this one question.
 */
export function payShown(compensation: { discloseRange: boolean }, notices: Notice[]): boolean {
  return compensation.discloseRange || payTransparencyApplies(notices);
}

/**
 * The notices a candidate page renders as text. Two keys stay defined but are never shown as notices: `recording` is
 * for a feature release 1 does not have (docs/readiness/20 section F), and `sms_consent` is a consent checkbox, not a
 * notice, rendered by the apply form only while texting is on. Neither belongs in the versions recorded as shown.
 */
export const NOTICES_NOT_RENDERED: readonly NoticeKey[] = ["recording", "sms_consent"];

export function candidateNotices(notices: Notice[]): Notice[] {
  return notices.filter((n) => !NOTICES_NOT_RENDERED.includes(n.key));
}

export type NoticeOverrides = Record<string, { version: string; text: string; jurisdictions: string[] }>;

/** A notice version is the date of the change (docs/08): what the candidate saw is recorded as `key@version`. */
export function noticeVersionFor(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Applies a company's rewording of its notices (audit finding A8). A new text gets today's version and keeps the
 * default's jurisdictions; null puts the standard text back; an unchanged text changes nothing (the version stays).
 * Returns the new override map and what changed, so the caller can audit each key with its versions.
 */
export function applyNoticeOverrides(
  existing: NoticeOverrides | undefined,
  changes: Partial<Record<NoticeKey, { text: string } | null>>,
  now: Date,
): { notices: NoticeOverrides; changed: Array<{ key: NoticeKey; version: string | null; previousVersion: string | null }> } {
  const notices: NoticeOverrides = { ...(existing ?? {}) };
  const changed: Array<{ key: NoticeKey; version: string | null; previousVersion: string | null }> = [];
  for (const [k, change] of Object.entries(changes)) {
    const key = k as NoticeKey;
    const base = DEFAULT_NOTICES.find((n) => n.key === key);
    if (!base) continue;
    const before = notices[key];
    if (change === null) {
      if (!before) continue;
      delete notices[key];
      changed.push({ key, version: null, previousVersion: before.version });
      continue;
    }
    if (!change) continue;
    const text = change.text.trim();
    if (before?.text === text) continue;
    const version = noticeVersionFor(now);
    // several rewordings on one day share the version: the version names the day the text became current
    notices[key] = { version, text, jurisdictions: before?.jurisdictions ?? base.jurisdictions };
    changed.push({ key, version, previousVersion: before?.version ?? null });
  }
  return { notices, changed };
}

/**
 * The line a decision message carries for a candidate covered by Colorado's rules on adverse decisions (plan G5): the
 * job is in Colorado, or the candidate is. DRAFT WORDING PENDING COUNSEL (docs/spec/11-counsel-register.md item 24): the
 * text, its version and the 30-day window are placeholders until counsel answers; nothing goes to real candidates first.
 * A reply asking for the explanation reaches the ITS compliance queue (a human-review request), never the assistant.
 */
export const ADVERSE_DECISION_LINE = {
  key: "adverse_decision_explanation" as const,
  version: "2026-10-09-draft",
  counselStatus: "draft" as const,
  jurisdictions: ["US-CO"],
  text: "Colorado: you may ask us to explain the main reasons for this decision and to have a person review it. Reply to this email with the word EXPLAIN within 30 days, and someone who was not part of the decision will answer you.",
};

const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC", "washington dc": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const STATE_CODE_SET = new Set(Object.values(STATE_CODES));

/**
 * The US state a candidate wrote as their location ("Denver, CO", "Boulder, Colorado 80302", "Colorado"), or null when
 * it cannot be told. Free text: only a state code after a comma or a state's full name counts, never a guess.
 */
export function regionFromLocationText(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const code = t.match(/,\s*([A-Za-z]{2})\.?(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,\s*(?:US|USA|United States))?\s*$/)?.[1]?.toUpperCase();
  if (code && STATE_CODE_SET.has(code)) return code;
  const lower = t.toLowerCase();
  const named = Object.keys(STATE_CODES).filter((name) => new RegExp(`(^|[^a-z])${name}($|[^a-z])`).test(lower)).sort((a, b) => b.length - a.length)[0];
  // "West Virginia" contains "virginia", "Washington DC" contains "washington": the longest name that matches wins.
  return named ? STATE_CODES[named] : null;
}

/** Whether a decision message carries Colorado's line: the job is in Colorado, or the candidate wrote a Colorado location. */
export function adverseDecisionLineApplies(input: { jobLocations: Array<Location | null | undefined>; candidateLocationText?: string | null }): boolean {
  const places = resolveJurisdictions(input.jobLocations, regionFromLocationText(input.candidateLocationText));
  return places.some((p) => ADVERSE_DECISION_LINE.jurisdictions.includes(p));
}

/** The disclosure line every automated candidate message carries. */
export function disclosureLine(companyName: string): string {
  return `This message was sent by the hiring team at ${companyName} with help from an AI recruiting assistant. Reply HUMAN at any time to reach a person.`;
}

export const RETENTION_DAYS_DEFAULT: Record<string, number> = {
  decision_data: 4 * 365,
  communications: 4 * 365,
  documents: 4 * 365,
  screens: 4 * 365,
};

/* ------------------------------------------------------------------------------------------------------------ */
/* What the law asks of a job ad before it goes public (plan D5; Track L: counsel confirms the lists first).      */
/* ------------------------------------------------------------------------------------------------------------ */

/** The places with a pay transparency law for job ads: the pay_transparency notice's own list. [counsel] */
export const PAY_TRANSPARENCY_JURISDICTIONS: readonly string[] = DEFAULT_NOTICES.find((n) => n.key === "pay_transparency")?.jurisdictions ?? [];

/**
 * Candidates for that list, PENDING COUNSEL: Washington DC (pay range on job ads and health benefits before the first
 * interview) and Rhode Island (pay range on request and before discussing pay). Until our lawyer confirms them they are
 * named on the approval card as advisory, never block approval, and are not added to the candidate notice.
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
 * The legal check before a role is approved (plan D5): for the job's places, the pay range, a short benefits
 * description and Colorado's closing date. A missing legal requirement blocks approval (POST /roles/:id/approve answers
 * 409 `legal_check` with the missing items); places pending counsel only add a note. A closing date the law needs and
 * nobody set is not missing: the role gets `defaultClosesOn` when it opens, and the item says so.
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
      fix: met ? null : "Describe the benefits in Setup (used for every job), or in this role's pay section.",
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
