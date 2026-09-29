import type { Location } from "@ros/contracts";

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
    version: "2026-09-01",
    jurisdictions: ["*"],
    text:
      "This employer uses software that includes artificial intelligence to help organize applications, ask screening questions, and summarize information for the hiring team. " +
      "People make the hiring decisions. You can ask to speak with a person at any point by replying HUMAN or using the link in any message.",
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

/**
 * The notices a candidate page renders as text. Two keys stay defined but are never shown as notices: `recording` is
 * for a feature release 1 does not have (docs/readiness/20 section F), and `sms_consent` is a consent checkbox, not a
 * notice, rendered by the apply form only while texting is on. Neither belongs in the versions recorded as shown.
 */
export const NOTICES_NOT_RENDERED: readonly NoticeKey[] = ["recording", "sms_consent"];

export function candidateNotices(notices: Notice[]): Notice[] {
  return notices.filter((n) => !NOTICES_NOT_RENDERED.includes(n.key));
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
