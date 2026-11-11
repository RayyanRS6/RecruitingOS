import type { SignupRequest } from "@ros/contracts";

/**
 * The sign-up form's choices, kept out of the page so they can be tested: the business types, which of them have a
 * hiring guide behind the drafting, and the time zone the owner's own computer reports, snapped to the list we offer.
 * Also what the screens around a request for access need (SIGNUP_MODE=approval): the look the waiting screen takes every
 * 30 seconds, and how a company's typed kind of business and website may be shown.
 */

/** The launch wedge first (docs/FOUNDER-CONTEXT.md §06): consumer, beauty, e-commerce, creative and marketing, tech-enabled services. */
export const VERTICALS: ReadonlyArray<readonly [string, string]> = [
  ["consumer", "Consumer brand or beauty"],
  ["ecommerce", "Retail or e-commerce"],
  ["marketing", "Marketing, advertising or creative agency"],
  ["saas", "Software or tech-enabled services"],
  ["professional_services", "Professional services"],
  ["dental", "Dental practice or group"],
  ["veterinary", "Veterinary"],
  ["trades", "HVAC, plumbing, electrical"],
  ["home_care", "Home care"],
  ["restaurant", "Restaurant group"],
  ["dealership", "Dealership"],
  ["other", "Something else"],
];

/** A kind of business in the form's own words; one the form does not offer (a hand-made request) reads as it was sent. */
export function verticalWords(vertical: string): string {
  return VERTICALS.find(([value]) => value === vertical)?.[1] ?? vertical;
}

/**
 * The address a typed website may link to, or null: what a stranger typed becomes a link only as a plain http or https
 * address, and never one that hides its real host behind a name and password. Anything else stays plain text. The link is
 * the parsed address, not the typed words, so what the browser follows is what was checked.
 */
export function websiteHref(typed: string | null | undefined): string | null {
  if (!typed) return null;
  try {
    const url = new URL(typed.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** How often the waiting screen looks again. */
export const ACCESS_LOOK_MS = 30_000;

/** What one look found: this person's company is open now (`home`), or where their own request stands. */
export type AccessStanding = { home: true } | { home: false; request: SignupRequest; contact: string | null };

/**
 * One look from the waiting screen: GET /auth/me says as soon as there is an active company, and GET /auth/config, which
 * /auth/me knows nothing about, where the request stands. It never rejects: an expired sign-in, no network or a page that
 * is not JSON is a look that found nothing (null), and the screen stays as it is until a later one finds something.
 */
export async function lookAtAccess(get: (path: string) => Promise<unknown>): Promise<AccessStanding | null> {
  try {
    const me = (await get("/api/v1/auth/me")) as { activeCompanyId?: string | null } | null;
    if (me?.activeCompanyId) return { home: true };
    const config = (await get("/api/v1/auth/config")) as { signup?: { request?: SignupRequest; contact?: string | null } } | null;
    const request = config?.signup?.request;
    return request ? { home: false, request, contact: config?.signup?.contact ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * The business types whose roles are drafted from one of our hiring guides (VERTICAL_TO_PLAYBOOK in packages/playbooks;
 * tests/web/first-screen.test.ts keeps the two in step). Every other type is drafted from what the owner says.
 */
export const GUIDED_VERTICALS: ReadonlySet<string> = new Set(["consumer", "ecommerce", "marketing", "saas", "professional_services", "dental"]);

/** What the chosen business type means for drafting, said honestly. */
export function verticalHint(vertical: string): string {
  if (!vertical) return "This shapes how your jobs are drafted.";
  return GUIDED_VERTICALS.has(vertical)
    ? "Your jobs are drafted from our hiring guide for this kind of business: typical jobs, screening questions and pay ranges."
    : "We do not have a hiring guide for this kind of business yet. Your jobs are drafted from what you tell the assistant and public pay data.";
}

/** The time zones we offer. Interview times and the hours candidates may be texted are worked out in the one chosen. */
export const ZONE_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "America/New_York", label: "Eastern time (New York)" },
  { value: "America/Chicago", label: "Central time (Chicago)" },
  { value: "America/Denver", label: "Mountain time (Denver)" },
  { value: "America/Phoenix", label: "Arizona (no daylight saving)" },
  { value: "America/Los_Angeles", label: "Pacific time (Los Angeles)" },
  { value: "America/Anchorage", label: "Alaska time (Anchorage)" },
  { value: "Pacific/Honolulu", label: "Hawaii time (Honolulu)" },
];

/** Minutes ahead of UTC in a zone at a moment; NaN for a name the browser does not know. */
function offsetMinutes(zone: string, at: Date): number {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at).map((p) => [p.type, p.value]));
    const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    return Math.round((local - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
  } catch {
    return Number.NaN;
  }
}

/**
 * The offered zone that keeps the same clock as the owner's own: their zone when we list it, else one with the same
 * offset now and half a year from now (so daylight saving agrees, as Detroit does with New York). Empty when nothing
 * matches; the owner then picks.
 */
export function snapTimeZone(zone: string | null | undefined, at: Date = new Date()): string {
  if (!zone) return "";
  if (ZONE_CHOICES.some((z) => z.value === zone)) return zone;
  const later = new Date(at.getTime() + 182 * 86_400_000);
  const now = offsetMinutes(zone, at);
  const then = offsetMinutes(zone, later);
  if (Number.isNaN(now)) return "";
  return ZONE_CHOICES.find((z) => offsetMinutes(z.value, at) === now && offsetMinutes(z.value, later) === then)?.value ?? "";
}

/** The browser's own zone, as the operating system reports it. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
