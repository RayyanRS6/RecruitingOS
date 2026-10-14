/**
 * What the AI sees when it scores (founder decision D-04 = C, built in Wave S2). The résumé reading (`triage.assess`) and
 * the screening scorecard (`screen.assess`) read the candidate's words with their name, email addresses, phone numbers,
 * street address and web links replaced by neutral placeholders, so none of these can colour a score. City and state,
 * employers, dates, schools, licences and skills stay: they are what the job is judged on. The résumé extraction
 * (`resume.extract`) still reads the original text, to fill in the candidate's record.
 *
 * Quotes shown to the team are always the candidate's ORIGINAL words: a quote the model wrote around a placeholder is
 * mapped back to the original text it stands for (`restore`), and is then checked against the original like any other.
 * A placeholder never reaches the team inside a quote: one that cannot be mapped back fails the quote check.
 *
 * Pure code, no model and no database: tested in scoring-view.test.ts.
 */

/** The kinds of detail the scoring view hides, each with its placeholder. A zip code counts as part of the street address. */
export type HiddenKind = "name" | "email" | "phone" | "street" | "link";

export const PLACEHOLDER = {
  name: "[name]",
  email: "[email]",
  phone: "[phone]",
  street: "[street address]",
  zip: "[zip code]",
  link: "[link]",
} as const;

/** The version of the rules, recorded with each reading (`ai_runs.input_ref.scoringView`) with the counts, never the values. */
// v2 (Wave S2 review): a single name that is also a place, a language or one of the job's own words is not hidden
// where it is that word, so a candidate whose name is "Austin" or "English" keeps the same evidence as a twin.
export const SCORING_VIEW_VERSION = "redacted-v2";

/**
 * Who the text is about: the candidate's record, and the name the résumé extraction found. Any field may be missing.
 * `keep`: words the job is judged on (the job's title, must-haves, competencies and places; the résumé's job titles,
 * employers and skills), which are never hidden as a single name (see `namePatterns`).
 */
export type ScoringIdentity = {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  keep?: readonly string[] | null;
};

/**
 * Words that are also places, languages or the like, never hidden as a single name: a candidate called Austin keeps
 * "Austin, TX" in their résumé, and one called Grace English keeps "Languages: English" (a twin with another name would
 * keep both). The full name is always hidden; a single one of these is hidden only where it is plainly the person (after
 * "Hi", "I'm", "Thanks," and the like).
 */
const US_STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming", "District of Columbia"];
const US_CITIES = ["Austin", "Dallas", "Houston", "Jackson", "Phoenix", "Madison", "Charlotte", "Denver", "Lincoln", "Orlando", "Savannah", "Raleigh", "Tyler", "Aurora", "Eugene", "Florence", "Logan", "Hamilton", "Columbus", "Jordan", "Paris", "Sydney", "Victoria", "Chelsea", "Brooklyn", "Cleveland", "Irvine", "Lafayette", "Chester", "Clinton", "Franklin", "Marion", "Salem", "Springfield", "Warren", "Troy", "Riverside", "Fresno", "Reno", "Boston", "Memphis", "Nashville", "Tampa", "Miami", "Atlanta", "Seattle", "Portland", "Oakland", "Sacramento", "Pasadena", "Glendale", "Anaheim", "Tucson", "Mesa", "Plano", "Laredo", "Irving", "Garland", "Durham", "Chandler", "Gilbert", "Scottsdale", "Boise", "Spokane", "Tacoma", "Fremont", "Kent", "Bristol", "Camden", "Dayton", "Everett", "Fargo", "Laramie", "Lansing", "Sherman", "Vernon", "Wayne", "Willis", "Abilene", "Amarillo", "Beverly", "Shelby", "Brandon", "Carson", "Douglas", "Elgin", "Grant", "Harrison", "Hudson", "Kingston", "Lowell", "Milton", "Newton", "Orange", "Quincy", "Stanley", "Sterling", "Taylor", "Trenton"];
const LANGUAGES = ["English", "Spanish", "French", "German", "Italian", "Portuguese", "Mandarin", "Cantonese", "Chinese", "Japanese", "Korean", "Vietnamese", "Tagalog", "Arabic", "Hindi", "Urdu", "Russian", "Polish", "Dutch", "Greek", "Hebrew", "Turkish", "Persian", "Farsi", "Punjabi", "Bengali", "Swahili", "Somali", "Amharic", "Creole", "Haitian", "Armenian", "Ukrainian", "Thai", "Lao", "Hmong", "Khmer", "Navajo", "Sign"];
const ALWAYS_KEEP = new Set([...US_STATES, ...US_CITIES, ...LANGUAGES].flatMap((w) => w.toLowerCase().split(/\s+/)));

/** The words of the keep list, lower case, letters only. */
function keepWords(keep: readonly string[] | null | undefined): Set<string> {
  const out = new Set(ALWAYS_KEEP);
  for (const phrase of keep ?? []) for (const w of phrase.toLowerCase().split(/[^\p{L}\p{N}'’-]+/u)) if (w.replace(/[^\p{L}]/gu, "").length >= 2) out.add(w);
  return out;
}

/** Where a single name is plainly the person: after a greeting, a sign-off or a self-introduction. */
const PERSON_CONTEXT = String.raw`(?:\b(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear|[Tt]hanks|[Tt]hank you|[Rr]egards|[Cc]heers|[Bb]est|[Ss]incerely|I'?m|I’m|I am|[Mm]y name is|[Tt]his is|[Nn]ame)[,:.!]?[ \t]*\n?[ \t]*)`;
/** A single name that is part of a place is a place: "San Antonio", "Fort Worth", "Austin, TX", "Jackson County". */
const STATE_CODES = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
const NOT_A_PLACE_BEFORE = String.raw`(?<!\b(?:San|Santa|Saint|St\.?|Los|Las|El|New|Fort|Ft\.?|Port|Lake|Mount|Mt\.?|East|West|North|South|Glen|Palm|Grand|Little|Big|Cape|Point)[ \t])`;
const NOT_A_PLACE_AFTER = String.raw`(?!,?[ \t]+(?:(?:${STATE_CODES})\b|City\b|County\b|Beach\b|Springs\b|Heights\b|Park\b|Falls\b|Valley\b|Hills\b|Bay\b|Harbor\b|Island\b|Lake\b))`;

export type ScoringView = {
  /** The text as the scoring reading sees it. */
  text(original: string): string;
  /** Every string inside a value (answers, an extraction) as the scoring reading sees it; keys and other values unchanged. */
  deep<T>(value: T): T;
  /** How many details of each kind were replaced so far, for the record. Counts only, never the values. */
  counts(): Record<HiddenKind, number>;
  /**
   * A quote the model wrote from the hidden text, as the candidate wrote it: each placeholder mapped back to what it
   * replaced, found in one of `originals` (tried in order). A quote without placeholders is returned as it is; one that
   * cannot be mapped back is returned unchanged, so the quote check against the original fails it.
   */
  restore(quote: string, originals: readonly string[]): string;
};

const LETTER = "\\p{L}\\p{N}";
const NOT_BEFORE = `(?<![${LETTER}])`;
const NOT_AFTER = `(?![${LETTER}])`;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A literal piece of text as a pattern: any run of whitespace matches any other. */
const loose = (s: string) => s.trim().split(/\s+/).filter(Boolean).map(escapeRegExp).join("\\s+");

const EMAIL = /(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const TLD = "com|net|org|io|dev|me|co|app|ai|us|ca|uk|info|biz|site|online|tech|page|xyz|ly|gg|edu|gov|so|blog|portfolio";
const PROFILE_HOSTS = "linkedin|github|gitlab|bitbucket|behance|dribbble|twitter|x|facebook|instagram|medium|youtube|tiktok|substack|wordpress|wixsite|squarespace|about";
const LINK = new RegExp(
  [
    // an address with a scheme or www.
    String.raw`\b(?:https?:\/\/|www\.)[^\s<>()"'\]\[]+`,
    // a bare domain with a path (linkedin.com/in/someone, myportfolio.dev/work)
    String.raw`(?<![\w@.-])(?:[a-z0-9-]+\.)+(?:${TLD})\/[^\s<>()"'\]\[]*`,
    // a profile site named without a path (github.com, linkedin.com)
    String.raw`(?<![\w@.-])(?:[a-z0-9-]+\.)*(?:${PROFILE_HOSTS})\.com\b`,
  ].join("|"),
  "gi",
);
/** Digits with the separators phone numbers use, on one line; kept only with 10 to 15 digits (`isPhone`). */
const PHONE = /(?<![\w+(])(?:\+\s?)?\(?\d(?:[ \t().\-]{0,2}\d){6,16}(?![\w])/g;
const STREET_SUFFIXES = ["Street", "St", "Avenue", "Ave", "Road", "Rd", "Boulevard", "Blvd", "Lane", "Ln", "Drive", "Dr", "Court", "Ct", "Way", "Place", "Pl", "Terrace", "Ter", "Parkway", "Pkwy", "Highway", "Hwy", "Circle", "Cir", "Square", "Sq", "Trail", "Trl", "Crescent", "Cres", "Close", "Alley", "Plaza", "Loop", "Row"];
const STREET = new RegExp(
  // one line only: a number, one to four capitalised words, a street word, then any flat or suite number
  String.raw`(?<![\p{L}\p{N}])\d{1,6}[A-Za-z]?[ \t]+(?:[NSEW]\.?[ \t]+)?(?:[A-Z0-9][\p{L}\p{N}.'’-]*[ \t]+){1,4}(?:${STREET_SUFFIXES.flatMap((s) => [s, s.toUpperCase()]).join("|")})\b\.?(?:,?[ \t]*(?:Apt|APT|Apartment|Suite|STE|Ste|Unit|UNIT|#)\.?[ \t]*#?[\w-]+)?` + String.raw`|\bP\.?[ \t]?O\.?[ \t]+Box[ \t]+\d+\b`,
  "gu",
);
/** A five-digit zip code just after a two-letter state code ("CA 94110"); the state stays. */
const ZIP = /(?<=\b[A-Z]{2}\.?,?[ \t]{1,2})\d{5}(?:-\d{4})?(?!\d)/g;
/** Name particles that are never hidden on their own ("de" in "de la Cruz" is hidden only as part of the full name). */
const PARTICLES = new Set(["de", "la", "le", "da", "di", "do", "du", "del", "della", "der", "den", "van", "von", "bin", "al", "el", "y", "e", "st", "mc"]);

function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

/** Ten to fifteen digits, and not a run of years ("2015 2016 2017"). */
function isPhone(s: string): boolean {
  const n = digitsOf(s).length;
  if (n < 10 || n > 15) return false;
  const groups = s.split(/[^\d]+/).filter(Boolean);
  return !groups.every((g) => g.length === 4 && /^(19|20)\d\d$/.test(g));
}

/** Trailing punctuation a sentence put after a link is not part of it. */
function splitTrailing(s: string): [string, string] {
  const m = s.match(/[.,;:!?]+$/);
  return m ? [s.slice(0, -m[0].length), m[0]] : [s, ""];
}

/**
 * The names to hide, longest first: full names in any case, everywhere; then each single name only as a name is written
 * (Capitalised or CAPITALS), never where it is part of a place ("San Antonio", "Austin, TX"). A single name that is also
 * a word the job is judged on (the keep list: the job's and the résumé's own words, US places, languages) is hidden only
 * where it is plainly the person ("Hi Austin", "I'm Grace"), so "Line Cook" and "Languages: English" stay for a candidate
 * called Austin Cook or Grace English, as they would for a twin with another name.
 */
function namePatterns(identity: ScoringIdentity): RegExp[] {
  const clean = (s?: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
  const first = clean(identity.firstName);
  const last = clean(identity.lastName);
  const fulls = new Set<string>();
  if (first && last) {
    fulls.add(`${first} ${last}`);
    fulls.add(`${last}, ${first}`);
    fulls.add(`${last} ${first}`);
  }
  const extracted = clean(identity.fullName);
  if (extracted.includes(" ")) fulls.add(extracted);
  const tokens = new Set<string>();
  for (const part of [first, last, extracted]) for (const t of part.split(/[\s,]+/)) if (t.replace(/[^\p{L}]/gu, "").length >= 2 && !PARTICLES.has(t.toLowerCase())) tokens.add(t);
  const out: RegExp[] = [];
  const fullList = [...fulls].sort((a, b) => b.length - a.length);
  if (fullList.length) out.push(new RegExp(`${NOT_BEFORE}(?:${fullList.map(loose).join("|")})${NOT_AFTER}`, "giu"));
  const keep = keepWords(identity.keep);
  const forms = new Set<string>();
  const keptForms = new Set<string>();
  for (const t of tokens) {
    const lower = t.toLowerCase();
    const into = keep.has(lower) ? keptForms : forms;
    into.add(t);
    into.add(lower.charAt(0).toUpperCase() + lower.slice(1));
    into.add(t.toUpperCase());
  }
  const single = (list: Set<string>) => [...list].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  if (forms.size) out.push(new RegExp(`${NOT_BEFORE}${NOT_A_PLACE_BEFORE}(?:${single(forms)})${NOT_AFTER}${NOT_A_PLACE_AFTER}`, "gu"));
  if (keptForms.size) out.push(new RegExp(`(?<=${PERSON_CONTEXT})(?:${single(keptForms)})${NOT_AFTER}${NOT_A_PLACE_AFTER}`, "gu"));
  return out;
}

/** The candidate's own phone number as written anywhere, whatever the separators, when it has at least seven digits. */
function ownPhonePattern(phone?: string | null): RegExp | null {
  const d = digitsOf(phone ?? "");
  if (d.length < 7) return null;
  const tail = d.length > 10 ? d.slice(-10) : d;
  return new RegExp(`(?<![\\d(+])(?:\\+?\\d{1,3}[ \\t().-]{0,2})?\\(?${tail.split("").join("[ \\t().-]{0,2}")}(?!\\d)`, "g");
}

/**
 * A scoring view for one candidate. Hide in this order: email addresses, links, phone numbers, street lines and zip
 * codes, then names, so an email or a profile link that contains the name is hidden whole.
 */
export function scoringView(identity: ScoringIdentity): ScoringView {
  const counts: Record<HiddenKind, number> = { name: 0, email: 0, phone: 0, street: 0, link: 0 };
  const seen: Record<HiddenKind | "zip", Set<string>> = { name: new Set(), email: new Set(), phone: new Set(), street: new Set(), zip: new Set(), link: new Set() };
  const names = namePatterns(identity);
  const ownEmail = (identity.email ?? "").trim();
  const ownPhone = ownPhonePattern(identity.phone);

  const hide = (kind: HiddenKind | "zip", value: string): string => {
    seen[kind].add(value);
    counts[kind === "zip" ? "street" : kind] += 1;
    return PLACEHOLDER[kind];
  };

  const text = (original: string): string => {
    let s = original;
    if (ownEmail) s = s.replace(new RegExp(escapeRegExp(ownEmail), "gi"), (m) => hide("email", m));
    s = s.replace(EMAIL, (m) => hide("email", m));
    s = s.replace(LINK, (m) => {
      const [link, trailing] = splitTrailing(m);
      return link ? hide("link", link) + trailing : m;
    });
    if (ownPhone) s = s.replace(ownPhone, (m) => hide("phone", m));
    s = s.replace(PHONE, (m) => (isPhone(m) ? hide("phone", m) : m));
    s = s.replace(STREET, (m) => hide("street", m));
    s = s.replace(ZIP, (m) => hide("zip", m));
    for (const p of names) s = s.replace(p, (m) => hide("name", m));
    return s;
  };

  const deep = <T>(value: T): T => {
    if (typeof value === "string") return text(value) as T;
    if (Array.isArray(value)) return value.map((v) => deep(v)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, deep(v)])) as T;
    return value;
  };

  const restore = (quote: string, originals: readonly string[]): string => {
    const parts = quote.split(PLACEHOLDER_SPLIT);
    if (parts.length === 1) return quote;
    let pattern = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      if (i % 2 === 0) {
        // the text between placeholders, its own spacing at either end kept loose
        pattern += `${/^\s/.test(part) ? "\\s*" : ""}${loose(part)}${/\s$/.test(part) && part.trim() ? "\\s*" : ""}`;
        continue;
      }
      const kind = KIND_OF[part]!;
      const values = [...seen[kind]].sort((a, b) => b.length - a.length);
      if (!values.length) return quote;
      pattern += `(?:${values.map(loose).join("|")})`;
    }
    const re = new RegExp(pattern, "iu");
    for (const original of originals) {
      const m = original.match(re);
      if (m) return m[0];
    }
    return quote;
  };

  return { text, deep, counts: () => ({ ...counts }), restore };
}

const KIND_OF: Record<string, HiddenKind | "zip"> = Object.fromEntries(Object.entries(PLACEHOLDER).map(([k, v]) => [v, k as HiddenKind | "zip"]));
const PLACEHOLDER_SPLIT = new RegExp(`(${Object.values(PLACEHOLDER).map(escapeRegExp).join("|")})`);

/** Whether a text still holds a placeholder: a quote that does must never reach the team. */
export function hasPlaceholder(text: string): boolean {
  return PLACEHOLDER_SPLIT.test(text);
}

/**
 * The model's own words in a reading that owners read (summary, rationale, claims, unknowns, confidence reasons: every
 * string except a `quote`) with no placeholder left in them: "[name]" reads "the candidate", any other "a detail that was
 * hidden". Quotes are left alone: `restoreQuotes` maps them back to the original, and the quote check fails any it cannot.
 */
export function withoutPlaceholders<T>(value: T): T {
  const words = (s: string) => s.replace(PLACEHOLDER_SPLIT_ALL, (m) => (m === PLACEHOLDER.name ? "the candidate" : "a detail that was hidden"));
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === "string") return key === "quote" ? v : words(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
  };
  return walk(value, null) as T;
}
const PLACEHOLDER_SPLIT_ALL = new RegExp(Object.values(PLACEHOLDER).map(escapeRegExp).join("|"), "g");

/**
 * Every quote in a reading (any object with a string `quote`, at any depth) mapped back to the candidate's original
 * words (`ScoringView.restore`). `originalsFor(source)` lists the original texts to look in for a quote citing that
 * source, the cited one first.
 */
export function restoreQuotes<T>(value: T, view: Pick<ScoringView, "restore">, originalsFor: (source: string | undefined) => readonly string[]): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = k === "quote" && typeof x === "string" ? view.restore(x, originalsFor(typeof o.source === "string" ? o.source : undefined)) : walk(x);
    return out;
  };
  return walk(value) as T;
}
