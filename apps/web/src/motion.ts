/**
 * Scrolling started from code, for anyone who asked their system for reduced motion: an instant jump instead of a
 * smooth scroll. The CSS rule in packages/ui/src/tokens.css turns off transitions and animations only; it does not reach
 * a scroll a page starts itself. Safe where there is no window or no matchMedia (the server, tests).
 */
export function scrollBehavior(win: { matchMedia?: (query: string) => { matches: boolean } } | undefined = typeof window === "undefined" ? undefined : window): ScrollBehavior {
  if (!win || typeof win.matchMedia !== "function") return "auto";
  return win.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
