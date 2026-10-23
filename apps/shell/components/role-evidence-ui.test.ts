import * as React from "react";
import { createElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Where a must-have is checked, in one set of words (23 Oct 2026): the job's Scoring tab says "Evidenced in: résumé /
 * AI interview" in the same words as the editor's ticks, both from apps/web/src/pages/role/evidence.ts, and the
 * screening conversation is the "AI interview", as in the skill rows (skills-form.ts checkedInLabel). The folded "Where
 * each one is checked" text no longer explains the old "screen" word.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/roles/r1",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({ id: "r1" }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { RequirementList } = await import("@ros/web/src/pages/RolePlan");
const { EVIDENCE_CHOICES, EVIDENCE_LABEL, evidencedInWords } = await import("@ros/web/src/pages/role/evidence");
const { checkedInLabel } = await import("@ros/web/src/skills-form");
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("where a must-have is checked", () => {
  it("says AI interview on the job's Scoring tab, never screen", () => {
    const items = [
      { key: "mh_rdh", text: "Active RDH license", rationale: "Required by law to practice", evidencedBy: ["resume", "screen"] },
      { key: "mh_sat", text: "Saturday shifts", rationale: "We open on Saturdays", evidencedBy: [] },
    ];
    const html = renderToStaticMarkup(createElement(RequirementList, { items: items as never, empty: "None listed." })).replace(/<!-- -->/g, "");
    expect(html).toContain("Evidenced in: résumé / AI interview");
    expect(html).toContain("Evidenced in: not set");
    expect(html).not.toMatch(/Evidenced in:[^<]*screen/);
  });

  it("gives the role page and the editor's ticks one set of words", () => {
    expect(EVIDENCE_LABEL.screen).toBe(checkedInLabel("screen"));
    expect(EVIDENCE_CHOICES).toEqual([
      { value: "resume", label: "résumé" },
      { value: "application", label: "application" },
      { value: "screen", label: "AI interview" },
      { value: "interview", label: "interview" },
    ]);
    expect(evidencedInWords(undefined)).toBe("not set");
    expect(evidencedInWords(["application", "interview"])).toBe("application / interview");
    // both screens read the shared words; neither keeps a word map of its own
    const editor = read("../../web/src/pages/RoleEditor.tsx");
    const plan = read("../../web/src/pages/RolePlan.tsx");
    expect(editor).toContain("EVIDENCE_CHOICES.map(");
    expect(plan).toContain("Evidenced in: {evidencedInWords(m.evidencedBy)}");
    for (const source of [editor, plan]) expect(source).not.toMatch(/screen: "/);
  });

  it("no longer explains the old 'screen' word under the must-haves", () => {
    const detail = read("../../web/src/pages/RoleDetail.tsx");
    expect(detail).toContain("<summary>Where each one is checked</summary>");
    expect(detail).not.toContain('a must-have marked "screen"');
  });
});
