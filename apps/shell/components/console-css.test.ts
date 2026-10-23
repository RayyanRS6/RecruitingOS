import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The ITS console (Wave S6) is styled like every other page since the October 2026 redesign: Tailwind classes and the kit's
 * components on its own markup, from the one stylesheet. Its old stylesheet (console.css) and the frame's
 * (app-shell.css) are gone, so the console's layout loads nothing of its own; it still lets only platform
 * administrators in.
 */
const layout = readFileSync(new URL("../app/(app)/admin/layout.tsx", import.meta.url), "utf8");

describe("the console's layout", () => {
  it("sends anyone but a platform administrator away", () => {
    expect(layout).toContain("if (!me) redirect(\"/login\");");
    expect(layout).toContain("if (!isAdmin(me)) redirect(");
  });

  it("loads no stylesheet of its own: console.css and app-shell.css are gone", () => {
    expect(layout).not.toMatch(/import\s+"[^"]*\.css";/);
    expect(existsSync(new URL("./console.css", import.meta.url))).toBe(false);
    expect(existsSync(new URL("./app-shell.css", import.meta.url))).toBe(false);
    const shell = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
    expect(shell).not.toMatch(/import\s+"[^"]*\.css";/);
  });
});
