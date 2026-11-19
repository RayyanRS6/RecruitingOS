import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

/**
 * The design system's Table, its sorting headings and tab labels as the server draws them (docs/07).
 */
(globalThis as { React?: typeof React }).React = React;
const { Table, Tabs, numHead } = await import("@ros/ui");
// cells passed as separate children, so React needs no keys
const row = (...cells: Array<[string, string?]>) => createElement("tr", null, ...cells.map(([text, className]) => createElement("td", { className }, text)));
const noop = () => undefined;

describe("Table", () => {
  it("stays as it was for a plain table: no class on its headings, no live region", () => {
    const html = renderToStaticMarkup(createElement(Table, { head: ["What we checked", "Maria Reyes"] }, row(["Match score"], ["91"])));
    expect(html).toMatch(/<section class="table-wrap" tabindex="0" aria-label="Table: What we checked, Maria Reyes">/i);
    expect(html).toContain('<th scope="col">Maria Reyes</th>');
    expect(html).not.toContain('role="status"');
    // byte for byte what a plain table drew before sorting, figures and empty rows were added
    const plain = renderToStaticMarkup(createElement(Table, { head: ["Workflow", "Status", ""] }, row(["triage"], ["done"], [""])));
    expect(plain.replace(/tabIndex/, "tabindex")).toBe('<section class="table-wrap" tabindex="0" aria-label="Table: Workflow, Status"><table class="table"><thead><tr><th scope="col">Workflow</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody><tr><td>triage</td><td>done</td><td></td></tr></tbody></table></section>');
  });

  it("right-aligns a column of figures, heading and cells, and adds the long-list and first-column classes", () => {
    const html = renderToStaticMarkup(createElement(Table, { head: ["Source", numHead("Applicants")], scroll: true, pinFirst: true }, row(["Careers page"], ["12", "num"])));
    expect(html).toContain('<th scope="col" class="num">Applicants</th>');
    expect(html).toContain('<td class="num">12</td>');
    expect(html).toMatch(/<section class="table-wrap scroll pin-first"/);
    expect(html).not.toContain('role="status"');
  });

  it("makes a sorting heading a button, sets aria-sort on the sorted column only, hides the arrows and says the order once", () => {
    const html = renderToStaticMarkup(createElement(Table, { head: [{ label: "Company", sort: null, onSort: noop }, { label: "AI cost", num: true, sort: "descending", onSort: noop }, "Plan"], announce: "Sorted by AI cost, highest first." }, row(["Bright Dental"], ["$0.0400", "num"], ["starter"])));
    expect(html).toMatch(/<th scope="col"><button type="button" class="th-sort">Company<svg class="icon"[^>]*aria-hidden="true"/);
    expect(html).toMatch(/<th scope="col" class="num" aria-sort="descending"><button type="button" class="th-sort">AI cost<svg/);
    expect(html.match(/aria-sort=/g)).toHaveLength(1);
    // the button never carries aria-sort itself, and its name is the column's words alone
    expect(html).not.toMatch(/<button[^>]*aria-sort/);
    expect(html).toContain('<th scope="col">Plan</th>');
    expect(html).toContain('<span class="sr-only" role="status">Sorted by AI cost, highest first.</span>');
    // a faint pair of arrows on a heading that could sort, one arrow on the heading that does
    expect(html).toMatch(/Company<svg[^>]*>(<path d="[^"]*"><\/path>){4}<\/svg>/);
    expect(html).toContain('AI cost<svg class="icon" width="14" height="14"');
    expect(html).toContain('<path d="m6 9 6 6 6-6"></path></svg></button></th>');
  });

  it("mounts the live region with a sortable table, empty until a person sorts, and draws the up arrow for A to Z", () => {
    const html = renderToStaticMarkup(createElement(Table, { head: [{ label: "Company", sort: "ascending", onSort: noop }] }, row(["Bright Dental"])));
    expect(html).toContain('<span class="sr-only" role="status"></span>');
    expect(html).toContain('<th scope="col" aria-sort="ascending">');
    expect(html).toContain('<path d="m6 15 6-6 6 6"></path>');
  });

  it("keeps the headings when nothing matches, with one row that says so", () => {
    const html = renderToStaticMarkup(createElement(Table, { head: ["Workflow", "Status", ""], empty: "No runs with this status." }, []));
    expect(html).toMatch(/<tbody><tr><td colspan="3" class="table-empty">No runs with this status\.<\/td><\/tr><\/tbody>/i);
    expect(html).toContain('<span class="sr-only" role="status">No runs with this status.</span>');
    // with rows, the empty row never shows, and the live region is there, quiet, for when a filter empties the list
    const full = renderToStaticMarkup(createElement(Table, { head: ["Workflow"], empty: "None." }, row(["triage"])));
    expect(full).not.toContain("table-empty");
    expect(full).toContain('<span class="sr-only" role="status"></span>');
    // nothing at all (null or false children) counts as no rows too
    expect(renderToStaticMarkup(createElement(Table, { head: ["Workflow"], empty: "None." }, null, false))).toContain('class="table-empty">None.</td>');
  });

  it("keeps the headings while rows are on their way, hides the quiet rows from screen readers and says Loading once", () => {
    const html = renderToStaticMarkup(createElement(Table, { head: ["When", numHead("Cost")], loading: 2 }));
    expect(html).toContain('<tbody aria-busy="true">');
    expect(html.match(/<tr aria-hidden="true"><td><span class="skeleton"><\/span><\/td><td class="num"><span class="skeleton"><\/span><\/td><\/tr>/g)).toHaveLength(2);
    expect(html).toContain('<span class="sr-only" role="status">Loading…</span>');
    // while loading, neither the rows given nor the empty row show
    const both = renderToStaticMarkup(createElement(Table, { head: ["When"], loading: 1, empty: "None." }, row(["old row"])));
    expect(both).not.toContain("old row");
    expect(both).not.toContain("table-empty");
    // no loading rows asked for: the table is as it was
    expect(renderToStaticMarkup(createElement(Table, { head: ["When"], loading: 0 }, row(["Tue"])))).toBe(renderToStaticMarkup(createElement(Table, { head: ["When"] }, row(["Tue"]))));
  });
});

describe("tab labels", () => {
  it("gives each tab label its own words for the width of its bold self", () => {
    const html = renderToStaticMarkup(createElement(Tabs, { label: "Stages", items: [{ id: "new", label: "New", count: 3 }, { id: "hired", label: "Hired", count: 0 }] }));
    expect(html).toContain('<span class="tab-label" data-label="New">New</span> <span class="count">3</span>');
    expect(html).toContain('<span class="tab-label" data-label="Hired">Hired</span> <span class="count">0</span>');
    // the label's words are written once: the bold copy is drawn by CSS from data-label, out of the accessible name
    expect(html.match(/>New</g)).toHaveLength(1);
  });
});
