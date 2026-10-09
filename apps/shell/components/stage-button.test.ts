import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Drawer, StageButton, Tabs } from "@ros/ui";

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

  it("takes the page's closer word for the stage when it has one (Wave A)", () => {
    const out = renderToStaticMarkup(createElement(StageButton, { stage: "not_moving_forward", label: "Not a fit for now", onMove: () => undefined }));
    expect(out).toContain('aria-label="Stage: Not a fit for now. Move to another stage"');
    expect(out).toContain('<span class="dot" aria-hidden="true"></span>Not a fit for now');
  });
});

describe("the candidate panel's pieces (Wave A)", () => {
  it("marks a tab with something new with a dot a screen reader hears as new", () => {
    const out = renderToStaticMarkup(createElement(Tabs, { label: "Candidate sections", value: "overview", items: [{ id: "overview", label: "Overview" }, { id: "messages", label: "Messages", marker: true }] }));
    expect(out).toContain('<span>Messages</span><span class="tab-dot" aria-hidden="true"></span><span class="sr-only"> (new)</span>');
    expect(out.match(/tab-dot/g)).toHaveLength(1);
  });

  it("puts a drawer's banner in the sticky header, under the title row", () => {
    // biome-ignore lint/correctness/noChildrenProp: createElement's types want a required children prop among the props
    const out = renderToStaticMarkup(createElement(Drawer, { open: true, onClose: () => undefined, title: "Maria Reyes", banner: "You have text here that is not sent or saved.", children: "body" }));
    expect(out).toMatch(/<div class="drawer-head">.*<div class="drawer-banner">You have text here that is not sent or saved\.<\/div>.*<\/div><div class="drawer-body">body<\/div>/);
    // biome-ignore lint/correctness/noChildrenProp: createElement's types want a required children prop among the props
    expect(renderToStaticMarkup(createElement(Drawer, { open: true, onClose: () => undefined, title: "Maria Reyes", children: "body" }))).not.toContain("drawer-banner");
  });
});
