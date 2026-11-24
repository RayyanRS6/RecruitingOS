/**
 * The typefaces of the candidate pages and the signed-in application (docs/07): IBM Plex Sans for text, Instrument Sans for
 * headings and IBM Plex Mono for code. The files are served from this deployment's own origin (`/fonts/`,
 * the files in apps/shell/public/fonts), so both policies keep `font-src 'self'` and no font host learns who opened a
 * page. A face already installed on the device is used first; a missing file falls back to the system font, never to an
 * outside host. `scripts/fetch-fonts.ts` puts the files in place from the open-licensed (SIL OFL 1.1) releases, pinned
 * to exact versions with a SHA-256 for every file in FONT_LOCK_FILE. The headings' face is one variable file with a
 * width axis, so a heading can be set narrow (`font-stretch`) without a second family.
 */
export const FONT_DIR = "/fonts";

/** Where the exact package versions and every file's SHA-256 are kept, relative to the repository root. */
export const FONT_LOCK_FILE = "apps/api/src/pages/fonts.lock.json";

/** The signed-in application's @font-face rules, written by scripts/fetch-fonts.ts from APP_FONTS; relative to the repository root. */
export const APP_FONT_CSS_FILE = "apps/shell/app/fonts.css";

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

/** The weights and widths the one variable file of the headings' face covers (its `wght` and `wdth` axes). */
export const DISPLAY_FAMILY = "Instrument Sans";
export const DISPLAY_WEIGHTS = "400 700";
export const DISPLAY_WIDTHS = "75% 100%";

/**
 * One face: the family and weight a stylesheet asks for, the names it may already be installed under, its npm package
 * and its file. A variable face has a range for its weight and a `stretch` range (its widths), and one file for all of
 * them; it is never taken from the device, where an installed copy may be a single fixed cut.
 */
export type SelfHostedFont = { family: string; slug: string; pkg: string; weight: 400 | 500 | 600 | typeof DISPLAY_WEIGHTS; stretch?: typeof DISPLAY_WIDTHS; local: readonly string[]; subset: FontSubset; file: string };

/**
 * Every face either surface uses. `candidate` marks the three the candidate stylesheet uses (body text at 400, labels and
 * buttons at 600, headings in the display face); the application also sets menu and tab labels at 500 and code in Plex
 * Mono. The display face is Instrument Sans (SIL OFL), one variable file (weights 400 to 700, widths 75% to 100%):
 * the big headings are set narrow and bold, the small ones at the normal width, from the same file. The owner asked for
 * Klarna Title and Helvetica Now Display Condensed Bold (24 November 2026); neither can be used without a licence, and
 * of the open faces compared side by side (Mona Sans, Archivo, Bricolage Grotesque) its narrow bold cut is the nearest to both: the same two-storey a and one-storey g.
 */
const FACES = [
  { family: "IBM Plex Sans", slug: "ibm-plex-sans", weight: 400, local: ["IBM Plex Sans", "IBMPlexSans"], candidate: true },
  { family: "IBM Plex Sans", slug: "ibm-plex-sans", weight: 500, local: ["IBM Plex Sans Medium", "IBMPlexSans-Medium"], candidate: false },
  { family: "IBM Plex Sans", slug: "ibm-plex-sans", weight: 600, local: ["IBM Plex Sans SemiBold", "IBMPlexSans-SemiBold"], candidate: true },
  { family: DISPLAY_FAMILY, slug: "instrument-sans", weight: DISPLAY_WEIGHTS, stretch: DISPLAY_WIDTHS, local: [], candidate: true },
  { family: "IBM Plex Mono", slug: "ibm-plex-mono", weight: 400, local: ["IBM Plex Mono", "IBMPlexMono"], candidate: false },
] as const;

/**
 * Every file, named the way the Fontsource packages name theirs, so the fetch script can copy them one for one: a fixed
 * weight from `@fontsource/<slug>` ("<slug>-<subset>-<weight>-normal.woff2"), the variable face from
 * `@fontsource-variable/<slug>`, whose file with the width axis is "<slug>-<subset>-wdth-normal.woff2".
 */
const filesOf = (faces: ReadonlyArray<(typeof FACES)[number]>): SelfHostedFont[] =>
  faces.flatMap(({ candidate: _candidate, ...f }) => {
    const variable = "stretch" in f;
    return (Object.keys(UNICODE_RANGE) as FontSubset[]).map((subset) => ({ ...f, pkg: `${variable ? "@fontsource-variable" : "@fontsource"}/${f.slug}`, subset, file: `${f.slug}-${subset}-${variable ? "wdth" : f.weight}-normal.woff2` }));
  });

/** The candidate pages' faces (apps/api/src/pages/layout.tsx). */
export const CANDIDATE_FONTS: readonly SelfHostedFont[] = filesOf(FACES.filter((f) => f.candidate));

/** Every self-hosted face: the signed-in application uses them all, and the fetch script downloads them all. */
export const APP_FONTS: readonly SelfHostedFont[] = filesOf(FACES);

/** The @font-face rules for a set of faces: the top of the candidate stylesheet, or the application's fonts.css. */
export function fontFaceCss(fonts: readonly SelfHostedFont[] = CANDIDATE_FONTS): string {
  return fonts.map((f) => `@font-face { font-family: "${f.family}"; font-style: normal; font-weight: ${f.weight}; ${f.stretch ? `font-stretch: ${f.stretch}; ` : ""}font-display: swap; src: ${[...f.local.map((n) => `local("${n}")`), `url("${FONT_DIR}/${f.file}") format("woff2")`].join(", ")}; unicode-range: ${UNICODE_RANGE[f.subset]}; }`).join("\n");
}

/** The application's stylesheet of faces, exactly as scripts/fetch-fonts.ts writes it (a test keeps the two equal). */
export function appFontCss(): string {
  return `/* Written by scripts/fetch-fonts.ts from APP_FONTS in apps/api/src/pages/fonts.ts; do not edit by hand. The files are in public/fonts. */\n${fontFaceCss(APP_FONTS)}\n`;
}
