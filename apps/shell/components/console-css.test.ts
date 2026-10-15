import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/**
 * The ITS console's stylesheet (console.css, Wave S6) is built only from the design tokens in tokens.css, so the light
 * and dark themes and their checked contrast carry over; it follows the motion rules the rest of the application keeps
 * (packages/ui/src/weight-guard.test.ts, which does not read this file); and it stays small. The admin layout imports it,
 * so only the console's pages load it.
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const raw = readFileSync(new URL("./console.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = strip(raw);
const tokens = strip(readFileSync(new URL("../../../packages/ui/src/tokens.css", import.meta.url), "utf8"));
const layout = readFileSync(new URL("../app/(app)/admin/layout.tsx", import.meta.url), "utf8");

describe("console.css", () => {
  it("names no colour of its own", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("uses only tokens that tokens.css defines", () => {
    const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/gi)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(5);
    for (const t of used) expect(defined.has(t), `${t} is not defined in tokens.css`).toBe(true);
  });

  it("moves nothing it does not hand back to reduced motion, and fills on hover only where there is a mouse", () => {
    // no motion of its own today; if some is added it must be short, on transform or opacity, and stop under reduced motion
    for (const m of css.matchAll(/transition(?:-duration)?:\s*([^;}]+)/g)) {
      expect(m[1]).not.toMatch(/\b(width|height|box-shadow|top|left|margin|padding)\b/);
      for (const d of m[1].matchAll(/(\d*\.?\d+)(ms|s)\b/g)) expect(d[2] === "s" ? Number(d[1]) * 1000 : Number(d[1])).toBeLessThanOrEqual(200);
    }
    expect(css).not.toMatch(/@keyframes|animation:/);
    for (const m of css.matchAll(/([^{}]*:hover[^{}]*)\{([^{}]*)\}/g)) expect(/background/.test(m[2]), m[1].trim()).toBe(false);
    expect(css).not.toMatch(/:active[^{}]*\{[^}]*transform:/);
  });

  it("stays within its 1,200-byte budget (gzip level 9, without comments, as the build ships it)", () => {
    expect(gzipSync(Buffer.from(css), { level: 9 }).length).toBeLessThanOrEqual(1_200);
  });

  it("is loaded by the console's layout only, which still sends anyone but a platform administrator away", () => {
    expect(layout).toContain('import "../../../components/console.css";');
    expect(layout).toContain("if (!isAdmin(me)) redirect(");
  });
});
