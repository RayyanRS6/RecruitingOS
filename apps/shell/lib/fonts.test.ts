import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_FONTS, CANDIDATE_FONTS, FONT_LOCK_FILE, type FontLock, appFontCss, fontLicenceFile } from "../../api/src/pages/fonts";

/**
 * The signed-in application's typefaces come from this deployment's own /fonts/ folder, like the candidate pages': the
 * root layout loads app/fonts.css and nothing from Google Fonts, every face the application's styles ask for has a file,
 * and every file matches the pinned lock.
 */
const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("the application's self-hosted fonts", () => {
  it("loads app/fonts.css, which is exactly the list in fonts.ts, and no outside font host", () => {
    const layout = read("apps/shell/app/layout.tsx");
    expect(layout).toContain('import "./fonts.css";');
    // the pool board's styles load with the tokens they are built from
    expect(layout.indexOf('import "@ros/ui/board.css";')).toBeGreaterThan(layout.indexOf('import "@ros/ui/tokens.css";'));
    expect(layout).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    const css = read("apps/shell/app/fonts.css");
    expect(css).toBe(appFontCss());
    expect(css).not.toMatch(/https?:/);
    // the candidate pages' faces are a part of the application's, so one set of files serves both
    for (const f of CANDIDATE_FONTS) expect(APP_FONTS.map((a) => a.file)).toContain(f.file);
  });

  it("has a face for every family and weight the application's styles use", () => {
    const styles = stripComments(`${read("packages/ui/src/tokens.css")}\n${read("packages/ui/src/board.css")}\n${read("apps/shell/components/app-shell.css")}`);
    const weights = new Set([...styles.matchAll(/font-weight: (\d+)|font: (\d+) /g)].map((m) => Number(m[1] ?? m[2])));
    const faces = (family: string) => new Set(APP_FONTS.filter((f) => f.family === family).map((f) => f.weight));
    // text and labels in Plex Sans (700 renders as 600, the heaviest Plex weight loaded, as it did with Google Fonts)
    for (const w of weights) if (w !== 700 && w !== 800) expect(faces("IBM Plex Sans"), `IBM Plex Sans ${w}`).toContain(w);
    // headings in Bricolage at 600 and 700, the menu's brand at 800; code in Plex Mono
    for (const w of [600, 700, 800]) expect(faces("Bricolage Grotesque")).toContain(w);
    expect(faces("IBM Plex Mono")).toContain(400);
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
