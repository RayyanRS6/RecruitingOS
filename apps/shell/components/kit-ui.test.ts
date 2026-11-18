import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dialog, Drawer, Tabs } from "@ros/ui";

/**
 * The design system's client components as the shell first draws them: a tab's "new" mark, a side sheet's banner and
 * the confirmation dialog. (packages/ui has no DOM renderer of its own, so their markup is checked here.)
 */
describe("tabs", () => {
  it("marks a tab with something new with a dot a screen reader hears as new", () => {
    const out = renderToStaticMarkup(createElement(Tabs, { label: "Candidate sections", value: "overview", items: [{ id: "overview", label: "Overview" }, { id: "messages", label: "Messages", marker: true }] }));
    expect(out).toContain('<span class="tab-label" data-label="Messages">Messages</span><span class="tab-dot" aria-hidden="true"></span><span class="sr-only"> (new)</span>');
    expect(out.match(/tab-dot/g)).toHaveLength(1);
  });
});

describe("the side sheet", () => {
  it("puts a banner in the sticky header, under the title row", () => {
    // biome-ignore lint/correctness/noChildrenProp: createElement's types want a required children prop among the props
    const out = renderToStaticMarkup(createElement(Drawer, { open: true, onClose: () => undefined, title: "A candidate", banner: "You have text here that is not sent or saved.", children: "body" }));
    expect(out).toMatch(/<div class="drawer-head">.*<div class="drawer-banner">You have text here that is not sent or saved\.<\/div>.*<\/div><div class="drawer-body">body<\/div>/);
    // biome-ignore lint/correctness/noChildrenProp: createElement's types want a required children prop among the props
    expect(renderToStaticMarkup(createElement(Drawer, { open: true, onClose: () => undefined, title: "A candidate", children: "body" }))).not.toContain("drawer-banner");
  });
});

describe("the confirmation dialog", () => {
  it("is a named modal dialog with a decorative tick, the title, the line under it, the body and the buttons at the foot", () => {
    // biome-ignore lint/correctness/noChildrenProp: createElement's types want a required children prop among the props
    const out = renderToStaticMarkup(createElement(Dialog, { open: true, onClose: () => undefined, title: "Your job is published", sub: "Getting it ready.", mark: "check", markTone: "good", footer: createElement("button", { type: "button" }, "Go to your job"), children: "body" }));
    expect(out).toContain('role="dialog" aria-modal="true" aria-label="Your job is published" tabindex="-1"');
    expect(out).toContain('<span class="dialog-mark good" aria-hidden="true">');
    expect(out).toContain("<h2>Your job is published</h2>");
    expect(out).toContain('<p class="dialog-sub">Getting it ready.</p>');
    expect(out).toMatch(/<div class="dialog-body">body<\/div><div class="dialog-foot"><button type="button">Go to your job<\/button><\/div>/);
    // a Close button a screen reader names, and the backdrop closes it too
    expect(out.match(/aria-label="Close"/g)).toHaveLength(2);
  });

  it("draws nothing while closed, and no foot without buttons", () => {
    // biome-ignore lint/correctness/noChildrenProp: createElement's types want a required children prop among the props
    expect(renderToStaticMarkup(createElement(Dialog, { open: false, onClose: () => undefined, title: "x", children: "body" }))).toBe("");
    // biome-ignore lint/correctness/noChildrenProp: createElement's types want a required children prop among the props
    expect(renderToStaticMarkup(createElement(Dialog, { open: true, onClose: () => undefined, title: "x", children: "body" }))).not.toContain("dialog-foot");
  });
});
