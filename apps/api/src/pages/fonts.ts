/**
 * The typefaces of the candidate pages (docs/07): IBM Plex Sans for text and Bricolage Grotesque for headings, the same
 * families the application uses. The files are served from this deployment's own origin (`/fonts/`, the files in
 * apps/shell/public/fonts), so the pages' policy keeps `font-src 'self'` and no font host learns who opened a job page.
 * A face already installed on the device is used first; a missing file falls back to the system sans-serif, never to an
 * outside host. `scripts/fetch-fonts.ts` puts the files in place from the open-licensed (SIL OFL 1.1) releases, pinned
 * to exact versions with a SHA-256 for every file in FONT_LOCK_FILE.
 */
export const FONT_DIR = "/fonts";

/** Where the exact package versions and every file's SHA-256 are kept, relative to the repository root. */
export const FONT_LOCK_FILE = "apps/api/src/pages/fonts.lock.json";

/** The lock: `packages` maps a Fontsource package to its exact version, `files` maps each saved file to its SHA-256 (hex). */
export type FontLock = { packages: Record<string, string>; files: Record<string, string> };

/** The licence saved beside a package's files. */
export function fontLicenceFile(slug: string): string {
  return `${slug}-LICENSE.txt`;
}

/** Google Fonts' and Fontsource's split of the alphabet: a browser fetches the second file only for a name that needs it. */
const UNICODE_RANGE = {
  latin: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  "latin-ext": "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
} as const;

export type FontSubset = keyof typeof UNICODE_RANGE;

/** One face: the family and weight the stylesheet asks for, the names it may already be installed under, and its file. */
export type CandidateFont = { family: string; slug: string; weight: 400 | 600 | 700; local: readonly string[]; subset: FontSubset; file: string };

/** Body text at 400, labels and buttons at 600, headings at 700: the only weights the candidate stylesheet uses. */
const FACES = [
  { family: "IBM Plex Sans", slug: "ibm-plex-sans", weight: 400, local: ["IBM Plex Sans", "IBMPlexSans"] },
  { family: "IBM Plex Sans", slug: "ibm-plex-sans", weight: 600, local: ["IBM Plex Sans SemiBold", "IBMPlexSans-SemiBold"] },
  { family: "Bricolage Grotesque", slug: "bricolage-grotesque", weight: 700, local: ["Bricolage Grotesque Bold", "BricolageGrotesque-Bold"] },
] as const;

/** Every file, named the way the Fontsource packages name theirs, so the fetch script can copy them one for one. */
export const CANDIDATE_FONTS: readonly CandidateFont[] = FACES.flatMap((f) =>
  (Object.keys(UNICODE_RANGE) as FontSubset[]).map((subset) => ({ ...f, subset, file: `${f.slug}-${subset}-${f.weight}-normal.woff2` })),
);

/** The @font-face rules at the top of the candidate stylesheet. */
export function fontFaceCss(): string {
  return CANDIDATE_FONTS.map((f) => `@font-face { font-family: "${f.family}"; font-style: normal; font-weight: ${f.weight}; font-display: swap; src: ${f.local.map((n) => `local("${n}")`).join(", ")}, url("${FONT_DIR}/${f.file}") format("woff2"); unicode-range: ${UNICODE_RANGE[f.subset]}; }`).join("\n");
}
