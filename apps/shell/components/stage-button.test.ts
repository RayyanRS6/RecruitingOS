import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StageButton } from "@ros/ui";

/**
 * The design system's stage button (plan adjustments §2 and §5) as the shell first draws it: a pill in the stage's
 * colour with its dot and word, a menu button a screen reader names with the stage, and nothing open until it is
 * pressed. What each choice does belongs to the page (Wave A), so here only the button's shape is checked.
 */
const html = (stage: string, disabled = false) => renderToStaticMarkup(createElement(StageButton, { stage, onMove: () => undefined, disabled }));

describe("the stage button", () => {
  it("shows the stage as a pill with its dot and word, and opens a menu", () => {
    const out = html("on_hold");
    expect(out).toMatch(/<button type="button" class="pill-button caution" aria-haspopup="menu" aria-expanded="false" aria-label="Stage: On hold. Move to another stage"/);
    expect(out).toContain('<span class="dot" aria-hidden="true"></span>On hold');
    expect(out).not.toContain('role="menu"');
  });

  it("uses the stage's own colour, and grey for a stage it does not know", () => {
    expect(html("shortlist")).toContain('class="pill-button good"');
    expect(html("not_moving_forward")).toContain('class="pill-button neutral"');
    expect(html("whatever")).toContain('aria-label="Stage: New. Move to another stage"');
  });

  it("can be shown switched off while a move is under way", () => {
    expect(html("new", true)).toMatch(/<button[^>]*disabled=""/);
  });
});
