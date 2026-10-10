import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SortDir } from "@ros/ui";

/**
 * The design system's Table, its sorting, Stat and tab labels as the server draws them (docs/07; the Obsidian-look
 * decisions of 10 October 2026).
 */
(globalThis as { React?: typeof React }).React = React;
const { Stat, Table, Tabs, numHead, useTableSort } = await import("@ros/ui");
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

type Key = "name" | "cost" | "due";
const KEYS: Key[] = ["name", "cost", "due"];
const ROWS = [
  { name: "Role 10", cost: 3, due: "2026-10-14T18:00:00.000Z" },
  { name: "role 2", cost: null, due: null },
  { name: "Bright Dental", cost: 12, due: "2026-10-09T10:00:00.000Z" },
];

/**
 * A page that lets people sort its table, pressed `presses` times in a row. Each press happens while the page draws
 * (a render-phase update, which React allows for a component's own state), so React draws it again with the new
 * order before anything is written out: the markup is the table after the last press.
 */
function SortedTable(props: { presses: Key[]; done: { n: number }; initial?: { key: Key; dir: SortDir } | null }) {
  const t = useTableSort<Key>(props.initial ?? null);
  const head = [t.col("name", "Name", "text"), t.col("cost", "Cost", "number", { num: true }), t.col("due", "Due", "date", { first: "ascending" })];
  const at = props.done.n;
  if (at < props.presses.length) {
    props.done.n = at + 1;
    head[KEYS.indexOf(props.presses[at])].onSort?.();
  }
  const rows = t.apply(ROWS, { name: (r) => r.name, cost: (r) => r.cost, due: (r) => (r.due ? Date.parse(r.due) : null) });
  return createElement(Table, { head, announce: t.announce }, ...rows.map((r) => createElement("tr", { key: r.name }, createElement("td", null, r.name))));
}
const sorted = (presses: Key[], initial: { key: Key; dir: SortDir } | null = null) => renderToStaticMarkup(createElement(SortedTable, { presses, done: { n: 0 }, initial }));
const names = (html: string) => [...html.matchAll(/<tr><td>([^<]*)<\/td><\/tr>/g)].map((m) => m[1]);
const sortedOn = (html: string) => [...html.matchAll(/aria-sort="(\w+)"><button type="button" class="th-sort">(\w+)/g)].map((m) => `${m[2]} ${m[1]}`);

describe("useTableSort", () => {
  it("opens in the order the rows came, every heading a button, nothing sorted and nothing said", () => {
    const html = sorted([]);
    expect(names(html)).toEqual(["Role 10", "role 2", "Bright Dental"]);
    expect(html).not.toContain("aria-sort");
    expect(html.match(/class="th-sort"/g)).toHaveLength(3);
    expect(html).toContain('<th scope="col" class="num"><button type="button" class="th-sort">Cost');
    expect(html).toContain('<span class="sr-only" role="status"></span>');
  });

  it("opens in the order the page asks for", () => {
    const html = sorted([], { key: "cost", dir: "ascending" });
    expect(names(html)).toEqual(["Role 10", "Bright Dental", "role 2"]);
    expect(sortedOn(html)).toEqual(["Cost ascending"]);
    // nobody has sorted yet, so nothing is said
    expect(html).toContain('<span class="sr-only" role="status"></span>');
    // a press on the column it opened on flips it
    expect(names(sorted(["cost"], { key: "cost", dir: "ascending" }))).toEqual(["Bright Dental", "Role 10", "role 2"]);
  });

  it("sorts words A to Z on the first press, then Z to A, and says so each time", () => {
    const first = sorted(["name"]);
    expect(names(first)).toEqual(["Bright Dental", "role 2", "Role 10"]);
    expect(sortedOn(first)).toEqual(["Name ascending"]);
    expect(first).toContain('<span class="sr-only" role="status">Sorted by Name, A to Z.</span>');
    const again = sorted(["name", "name"]);
    expect(names(again)).toEqual(["Role 10", "role 2", "Bright Dental"]);
    expect(sortedOn(again)).toEqual(["Name descending"]);
    expect(again).toContain('<span class="sr-only" role="status">Sorted by Name, Z to A.</span>');
    // a third press flips back: there is no hidden "unsorted" state
    expect(sortedOn(sorted(["name", "name", "name"]))).toEqual(["Name ascending"]);
  });

  it("sorts figures highest first, with an empty one last whichever way round", () => {
    const html = sorted(["cost"]);
    expect(names(html)).toEqual(["Bright Dental", "Role 10", "role 2"]);
    expect(html).toContain('<th scope="col" class="num" aria-sort="descending"><button type="button" class="th-sort">Cost');
    expect(html).toContain("Sorted by Cost, highest first.");
    expect(names(sorted(["cost", "cost"]))).toEqual(["Role 10", "Bright Dental", "role 2"]);
  });

  it("starts a deadline earliest first when the page says so, moving the sort from another column", () => {
    const html = sorted(["name", "due"]);
    expect(names(html)).toEqual(["Bright Dental", "Role 10", "role 2"]);
    expect(sortedOn(html)).toEqual(["Due ascending"]);
    expect(html).toContain("Sorted by Due, earliest first.");
    expect(names(sorted(["due", "due"]))).toEqual(["Role 10", "Bright Dental", "role 2"]);
  });
});

describe("Stat and tab labels", () => {
  it("draws a figure with what it counts", () => {
    expect(renderToStaticMarkup(createElement(Stat, { n: 12, label: "applicants in total" }))).toBe('<div class="stat"><span class="stat-n">12</span><span class="stat-label">applicants in total</span></div>');
    expect(renderToStaticMarkup(createElement(Stat, { n: "$1.20", label: "spent on AI this month" }))).toBe('<div class="stat"><span class="stat-n">$1.20</span><span class="stat-label">spent on AI this month</span></div>');
  });

  it("gives each tab label its own words for the width of its bold self", () => {
    const html = renderToStaticMarkup(createElement(Tabs, { label: "Stages", items: [{ id: "new", label: "New", count: 3 }, { id: "hired", label: "Hired", count: 0 }] }));
    expect(html).toContain('<span class="tab-label" data-label="New">New</span> <span class="count">3</span>');
    expect(html).toContain('<span class="tab-label" data-label="Hired">Hired</span> <span class="count">0</span>');
    // the label's words are written once: the bold copy is drawn by CSS from data-label, out of the accessible name
    expect(html.match(/>New</g)).toHaveLength(1);
  });
});
