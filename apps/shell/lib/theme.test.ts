import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shownTheme, THEME_COOKIE, themeCookie, themeFrom } from "./theme";

describe("the light/dark theme choice", () => {
  it("knows only light and dark; anything else means no choice, so the device decides", () => {
    expect(themeFrom("light")).toBe("light");
    expect(themeFrom("dark")).toBe("dark");
    for (const other of [undefined, null, "", "Dark", "system", "blue"]) expect(themeFrom(other), String(other)).toBeUndefined();
    expect(shownTheme(undefined, true)).toBe("dark");
    expect(shownTheme(undefined, false)).toBe("light");
    // a choice wins over the device
    expect(shownTheme("light", true)).toBe("light");
    expect(shownTheme("dark", false)).toBe("dark");
  });

  it("remembers the choice for a year, for the whole site, Secure on https", () => {
    expect(themeCookie("dark", true)).toBe(`${THEME_COOKIE}=dark; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
    expect(themeCookie("light", false)).toBe(`${THEME_COOKIE}=light; Path=/; Max-Age=31536000; SameSite=Lax`);
  });

  it("is drawn by the server on <html>, the attribute the application's stylesheet (styles.css) switches on", () => {
    const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
    expect(layout).toContain("cookies()).get(THEME_COOKIE)");
    expect(layout).toContain('<html lang="en" data-theme={theme}>');
    const styles = readFileSync(new URL("../../../packages/ui/src/styles.css", import.meta.url), "utf8");
    // dark when the switch says so; with no choice, dark when the device prefers it and light was not picked
    expect(styles).toContain(':root[data-theme="dark"] {');
    expect(styles).toContain(':root:not([data-theme="light"]) {');
    // the dark: classes follow the same switch
    expect(styles).toMatch(/@custom-variant dark[\s\S]*?\[data-theme="dark"\]/);
  });
});
