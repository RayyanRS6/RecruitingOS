/**
 * The light or dark theme picked with the switch at the foot of the rail (docs/07). The choice is kept in a cookie rather
 * than in browser storage, so the server draws `<html data-theme>` with the page itself: no flash of the other theme on a
 * full page load, and no inline script for the content-security policy to allow. With no choice made, no data-theme is
 * set and tokens.css follows the device setting.
 */
export type Theme = "light" | "dark";

export const THEME_COOKIE = "ros_theme";

/** A remembered choice, or undefined for anything else (no cookie, or a value this version does not know). */
export function themeFrom(value: string | null | undefined): Theme | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}

/** The theme on screen: the one chosen on this browser, else the device's. */
export function shownTheme(chosen: string | null | undefined, deviceDark: boolean): Theme {
  return themeFrom(chosen) ?? (deviceDark ? "dark" : "light");
}

/** The cookie that remembers the choice for a year on this browser. It holds no personal data and is sent only to this site. */
export function themeCookie(theme: Theme, secure: boolean): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}
