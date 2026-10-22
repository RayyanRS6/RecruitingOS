import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_FONTS, CANDIDATE_FONTS, FONT_LOCK_FILE, type FontLock, appFontCss, fontLicenceFile } from "../../api/src/pages/fonts";

/**
 * The signed-in application's typefaces come from this deployment's own /fonts/ folder, like the candidate pages': the
 * root layout loads app/fonts.css and the one stylesheet (app/globals.css: Tailwind, then packages/ui/src/styles.css),
 * nothing from Google Fonts, every face the application's styles ask for has a file, and every file matches the lock.
 */
const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const FONT_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com/;

/** Every .ts and .tsx source file under a folder of the repository (no node_modules, build output or tests), as repository paths. */
function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(fileURLToPath(root), rel), { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(`${rel}/${e.name}`);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(`${rel}/${e.name}`);
    }
  };
  walk(dir);
  return out;
}

/**
 * The class strings (one quoted string each) that ask for bold or extra-bold type in a face that has none: everything
 * but Bricolage (font-display) and a bare h1-h4 (styles.css draws those in Bricolage). Plex Sans and Plex Mono have no
 * 700 or 800 file, so the browser would smear a faux bold.
 */
function fauxBold(file: string, text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\bfont-(?:bold|extrabold)\b/g)) {
    const i = m.index ?? 0;
    const start = text.lastIndexOf("\n", i) + 1;
    const end = text.indexOf("\n", i) === -1 ? text.length : text.indexOf("\n", i);
    const line = text.slice(start, end);
    const at = i - start;
    const open = Math.max(line.lastIndexOf('"', at), line.lastIndexOf("'", at), line.lastIndexOf("`", at));
    if (open === -1) continue; // not inside a string (a comment)
    const close = line.indexOf(line[open] as string, at);
    const classes = line.slice(open + 1, close === -1 ? undefined : close);
    if (/\bfont-display\b/.test(classes)) continue;
    if (/<h[1-4]\b[^<>]*className=\{?\s*$/.test(line.slice(0, open))) continue;
    found.push(`${file}: "${classes}"`);
  }
  return found;
}

describe("the application's self-hosted fonts", () => {
  it("loads app/fonts.css, which is exactly the list in fonts.ts, beside the one stylesheet, and no outside font host", () => {
    const layout = read("apps/shell/app/layout.tsx");
    expect(layout).toContain('import "./fonts.css";');
    expect(layout).toContain('import "./globals.css";');
    // the old stylesheets are gone: the look lives in styles.css, through globals.css
    expect(layout).not.toMatch(/@ros\/ui\/(tokens|board)\.css/);
    expect(layout).not.toMatch(FONT_HOSTS);
    const globals = read("apps/shell/app/globals.css");
    expect(globals).toContain('@import "tailwindcss";');
    expect(globals).toContain('@import "@ros/ui/styles.css";');
    for (const sheet of [globals, read("packages/ui/src/styles.css")]) {
      expect(sheet).not.toMatch(FONT_HOSTS);
      expect(sheet).not.toMatch(/@import\s+(url\()?["']?https?:/);
    }
    const css = read("apps/shell/app/fonts.css");
    expect(css).toBe(appFontCss());
    expect(css).not.toMatch(/https?:/);
    // the candidate pages' faces are a part of the application's, so one set of files serves both
    for (const f of CANDIDATE_FONTS) expect(APP_FONTS.map((a) => a.file)).toContain(f.file);
  });

  it("has a face for every family and weight the application's styles use", () => {
    const styles = stripComments(read("packages/ui/src/styles.css"));
    const weights = new Set([...styles.matchAll(/font-weight: (\d+)|font: (\d+) /g)].map((m) => Number(m[1] ?? m[2])));
    const faces = (family: string) => new Set(APP_FONTS.filter((f) => f.family === family).map((f) => f.weight));
    // text and labels in Plex Sans 400/500/600 (700 and 800 are the headings' Bricolage weights)
    for (const w of weights) if (w !== 700 && w !== 800) expect(faces("IBM Plex Sans"), `IBM Plex Sans ${w}`).toContain(w);
    // Tailwind's weights without a face anywhere never appear in the stylesheet or the frame (they would render faux-bold or faux-light)
    const frame = ["apps/shell/components/AppShell.tsx", "apps/shell/components/BrandMark.tsx", "apps/shell/app/not-found.tsx", "apps/shell/app/(app)/loading.tsx"].map(read).join("\n");
    expect(`${styles}\n${frame}`).not.toMatch(/\bfont-(thin|extralight|light|black)\b/);
    // headings in Bricolage at 600, 700 and 800; labels in Plex Mono 400
    for (const w of [600, 700, 800]) expect(faces("Bricolage Grotesque")).toContain(w);
    expect(faces("IBM Plex Mono")).toContain(400);
  });

  it("never asks for bold or extra-bold text outside the display face (spec 3: sans text uses font-semibold)", () => {
    const fauxBoldFaces = new Set(APP_FONTS.filter((f) => f.family !== "Bricolage Grotesque" && f.weight >= 700).map((f) => `${f.family} ${f.weight}`));
    // the rule holds only while Plex has no bold file; if one is added, this check can be relaxed
    expect([...fauxBoldFaces]).toEqual([]);
    const found = ["apps/web/src", "apps/shell/app", "apps/shell/components", "apps/shell/lib"].flatMap((dir) => sources(dir).flatMap((file) => fauxBold(file, read(file))));
    expect(found, "use font-semibold, or font-display for a heading or a big number").toEqual([]);
    // the check itself: a sans class string is caught, a display one, a bare heading and a comment are not
    expect(fauxBold("x.tsx", '<p className="text-sm font-bold">')).toHaveLength(1);
    expect(fauxBold("x.tsx", 'const C = "[&.active]:font-extrabold text-ink";')).toHaveLength(1);
    expect(fauxBold("x.tsx", '<span className="font-display text-[19px] font-bold">')).toEqual([]);
    expect(fauxBold("x.tsx", '<h2 className="text-[20px] font-bold">')).toEqual([]);
    expect(fauxBold("x.tsx", "// never font-bold here")).toEqual([]);
  });

  const fontsDir = new URL("apps/shell/public/fonts/", root);
  it.skipIf(!existsSync(fontsDir))("every file is in apps/shell/public/fonts, is a woff2 file, and matches the pinned lock", () => {
    const lock = JSON.parse(read(FONT_LOCK_FILE)) as FontLock;
    for (const slug of new Set(APP_FONTS.map((f) => f.slug))) {
      expect(lock.packages[slug], `${slug} version`).toMatch(/^\d+\.\d+\.\d+$/);
      const licence = new URL(fontLicenceFile(slug), fontsDir);
      expect(existsSync(licence), `${fontLicenceFile(slug)} is missing`).toBe(true);
      expect(createHash("sha256").update(readFileSync(licence)).digest("hex"), fontLicenceFile(slug)).toBe(lock.files[fontLicenceFile(slug)]);
    }
    for (const f of APP_FONTS) {
      const file = new URL(f.file, fontsDir);
      expect(existsSync(file), `${f.file} is missing`).toBe(true);
      const bytes = readFileSync(file);
      expect(bytes.subarray(0, 4).toString("latin1"), f.file).toBe("wOF2");
      expect(createHash("sha256").update(bytes).digest("hex"), `${f.file} does not match the lock`).toBe(lock.files[f.file]);
    }
  });
});
