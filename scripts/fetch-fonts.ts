import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_FONTS, APP_FONT_CSS_FILE, FONT_LOCK_FILE, type FontLock, appFontCss, fontLicenceFile } from "../apps/api/src/pages/fonts";

/**
 * Puts the font files of the candidate pages and the signed-in application where the deployment serves them from its
 * own origin (apps/shell/public/fonts, served at /fonts/; apps/api/src/pages/fonts.ts names the files), and writes the
 * application's @font-face stylesheet (apps/shell/app/fonts.css). IBM Plex Sans, IBM Plex Mono and Bricolage Grotesque
 * are published under the SIL Open Font License 1.1; the files come from their Fontsource packages and each package's
 * licence is saved beside its files. Run once, review, and commit the files together with the lock:
 *   node_modules\.bin\tsx.cmd scripts/fetch-fonts.ts
 *
 * Nothing floats. The first run picks the newest release of each package's major version, then writes the exact
 * version and the SHA-256 of every file it saved to apps/api/src/pages/fonts.lock.json. Every later run downloads only
 * that exact version and refuses a file whose hash differs from the lock, so a republished package or a swapped file on
 * the CDN cannot slip in. A file already present is kept and checked against the lock. `--check` changes nothing: it
 * fails when a file is missing, is not a woff2 file, or does not match the lock, or when fonts.css does not match the
 * list (apps/api/src/candidate-look.test.ts checks the same once the files are committed).
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "apps", "shell", "public", "fonts");
const LOCK = join(ROOT, FONT_LOCK_FILE);
const APP_CSS = join(ROOT, APP_FONT_CSS_FILE);
const FONTSOURCE = "https://cdn.jsdelivr.net/npm/@fontsource";
const RESOLVE = "https://data.jsdelivr.com/v1/packages/npm/@fontsource";
const MAJOR = "5";
const EXACT = /^\d+\.\d+\.\d+$/;

const isWoff2 = (bytes: Uint8Array) => bytes.length > 4 && String.fromCharCode(...bytes.slice(0, 4)) === "wOF2";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The exact version of the newest release in the major line, asked once and then kept in the lock. */
async function newestRelease(slug: string): Promise<string> {
  const res = await fetch(`${RESOLVE}/${slug}/resolved?specifier=${MAJOR}`);
  if (!res.ok) throw new Error(`could not look up @fontsource/${slug}@${MAJOR}: ${res.status}`);
  const version = ((await res.json()) as { version?: unknown }).version;
  if (typeof version !== "string" || !EXACT.test(version)) throw new Error(`@fontsource/${slug}@${MAJOR} did not resolve to an exact version`);
  return version;
}

async function main() {
  const check = process.argv.includes("--check");
  const problems: string[] = [];
  const lock: FontLock = existsSync(LOCK) ? (JSON.parse(readFileSync(LOCK, "utf8")) as FontLock) : { packages: {}, files: {} };
  if (!check) mkdirSync(OUT, { recursive: true });

  const slugs = [...new Set(APP_FONTS.map((f) => f.slug))];
  for (const slug of slugs) {
    const pinned = lock.packages[slug];
    if (pinned && !EXACT.test(pinned)) problems.push(`${slug} is pinned to "${pinned}", which is not an exact version`);
    else if (!pinned && check) problems.push(`${slug} has no pinned version in ${FONT_LOCK_FILE}`);
    else if (!pinned) lock.packages[slug] = await newestRelease(slug);
  }

  const wanted = [...APP_FONTS.map((f) => ({ slug: f.slug, file: f.file, url: `files/${f.file}`, woff2: true })), ...slugs.map((slug) => ({ slug, file: fontLicenceFile(slug), url: "LICENSE", woff2: false }))];
  for (const w of wanted) {
    const path = join(OUT, w.file);
    const expected = lock.files[w.file];
    const version = lock.packages[w.slug];
    let bytes: Uint8Array;
    if (existsSync(path)) bytes = new Uint8Array(readFileSync(path));
    else if (check || !version || !EXACT.test(version)) {
      problems.push(`${w.file} is missing`);
      continue;
    } else {
      bytes = await download(`${FONTSOURCE}/${w.slug}@${version}/${w.url}`);
      if (w.woff2 && !isWoff2(bytes)) throw new Error(`${w.file}: the download is not a woff2 file`);
      if (expected && sha256(bytes) !== expected) throw new Error(`${w.file}: the download does not match the hash in ${FONT_LOCK_FILE}; nothing was saved`);
      writeFileSync(path, bytes);
      console.log(`saved ${w.file} from @fontsource/${w.slug}@${version} (${bytes.length} bytes)`);
    }
    if (w.woff2 && !isWoff2(bytes)) problems.push(`${w.file} is not a woff2 file`);
    const actual = sha256(bytes);
    if (expected && actual !== expected) problems.push(`${w.file} does not match the hash in ${FONT_LOCK_FILE}`);
    else if (!expected && check) problems.push(`${w.file} has no hash in ${FONT_LOCK_FILE}`);
    else if (!expected) lock.files[w.file] = actual;
  }

  // The application's stylesheet of faces follows the list; --check only compares it (a checkout may turn its line ends).
  const css = appFontCss();
  if (check && (!existsSync(APP_CSS) || readFileSync(APP_CSS, "utf8").replace(/\r\n/g, "\n") !== css)) problems.push(`${APP_FONT_CSS_FILE} does not match the font list; run the script without --check`);

  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  if (!check) {
    const sorted: FontLock = { packages: Object.fromEntries(Object.entries(lock.packages).sort()), files: Object.fromEntries(Object.entries(lock.files).sort()) };
    writeFileSync(LOCK, `${JSON.stringify(sorted, null, 2)}\n`);
    writeFileSync(APP_CSS, css);
  }
  console.log(check ? "every font file is in place and matches the lock" : `fonts are in ${OUT}; versions and hashes are in ${FONT_LOCK_FILE}. Review both, then commit them together.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
