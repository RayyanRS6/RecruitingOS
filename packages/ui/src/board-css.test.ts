import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The pool board's stylesheet (board.css) is built only from the design tokens in tokens.css: no colour of its own, so
 * the light and dark themes and their checked contrast carry over unchanged, and every token it names exists.
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const board = strip(readFileSync(new URL("./board.css", import.meta.url), "utf8"));
const tokens = strip(readFileSync(new URL("./tokens.css", import.meta.url), "utf8"));

describe("board.css", () => {
  it("names no colour of its own", () => {
    expect(board).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(board).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/i);
  });

  it("uses only tokens that tokens.css defines", () => {
    const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
    const used = new Set([...board.matchAll(/var\((--[a-z0-9-]+)\)/gi)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(10);
    for (const t of used) expect(defined.has(t), `${t} is not defined in tokens.css`).toBe(true);
  });

  it("keeps red for the missing must-have warning only", () => {
    const red = [...board.matchAll(/([^{}]+)\{[^}]*var\(--critical[^)]*\)[^}]*\}/g)].map((m) => m[1].trim());
    expect(red).toEqual([".review-warn.critical"]);
  });
});
